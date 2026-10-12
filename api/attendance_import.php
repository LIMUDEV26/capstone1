<?php
/**
 * Attendance Import API
 *
 * Handles attendance file upload (.dat, .csv, .xls or .xlsx), parsing, and
 * auto-generation of draft payroll records.
 *
 * Accepted formats:
 *   .dat / .csv — plain text. .dat is the ZKTeco USB export (tab-delimited
 *          text in disguise) and .csv the manual aggregate sheet; both are
 *          read by the CSV reader, which sniffs TAB/`,`/`;`/`|`. A file whose
 *          rows are raw punches is rejected with an explicit message.
 *   .xls  — the ZKTeco "Standard Report" workbook. scripts/convert_xls_to_csv.py
 *          maps its columns onto the aggregate headers (needs Python).
 *   .xlsx — the same aggregate sheet saved as OOXML, read directly here.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'chunked_upload_utils.php';

const ATTENDANCE_IMPORT_CHUNK_MAX_BYTES = 100 * 1024 * 1024;
const ATTENDANCE_IMPORT_CHUNK_ALLOWED_EXTS = ['dat', 'csv', 'xls', 'xlsx'];
// Header row the aggregate importer expects (also used by the CSV template).
const ATTENDANCE_IMPORT_TEMPLATE_HEADERS = ['EmployeeID', 'EmployeeName', 'Role', 'Branch', 'DaysWorked', 'OvertimeHours', 'LateMinutes', 'AbsentDays', 'LeaveDays'];

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);
ensurePayrollLeaveColumns($conn);

try {
    switch ($method) {
        case 'GET':
            requireMinRole('manager');
            handleGetTemplate();
            break;
        case 'POST':
            requireMinRole('manager');
            $importAction = $_GET['action'] ?? 'import';
            if ($importAction === 'import_init') handleImportInit($conn);
            elseif ($importAction === 'import_chunk') handleImportChunk($conn);
            elseif ($importAction === 'import_complete') handleImportComplete($conn);
            elseif ($importAction === 'import_abort') handleImportAbort($conn);
            else handleImport($conn);
            break;
        default:
            sendError('Method not allowed', 405);
    }
} catch (Throwable $e) {
    sendError('Attendance import failed: ' . $e->getMessage(), 500);
}

function validateImportPayPeriodDates($payPeriodStart, $payPeriodEnd) {
    $payPeriodStart = trim((string)$payPeriodStart);
    $payPeriodEnd = trim((string)$payPeriodEnd);

    if (!validateDate($payPeriodStart) || !validateDate($payPeriodEnd)) {
        sendError('Pay period dates must use YYYY-MM-DD format.', 400);
    }

    if ($payPeriodStart > $payPeriodEnd) {
        sendError('Pay period start date cannot be after the end date.', 400);
    }

    $today = date('Y-m-d');
    if ($payPeriodStart > $today || $payPeriodEnd > $today) {
        sendError('Pay period cannot go beyond the current date (' . $today . ').', 400);
    }
}

function handleGetTemplate() {
    $action = $_GET['action'] ?? '';

    if ($action !== 'template') {
        sendError('Invalid action. Use ?action=template', 400);
    }

    // The importer now accepts only .dat and .csv, so the blank template must be
    // downloadable in a format the operator can upload straight back.
    $csv = generateCsvTemplate();

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="attendance_template.csv"');
    header('Content-Length: ' . strlen($csv));
    header('Cache-Control: no-cache, no-store, must-revalidate');
    echo $csv;
    exit();
}

function normalizeImportSourceSystem($value) {
    $normalized = strtolower(trim((string)$value));
    if ($normalized === '') return 'payroll_excel';

    $normalized = preg_replace('/[^a-z0-9_-]+/', '_', $normalized);
    $normalized = trim((string)$normalized, '_-');
    return $normalized !== '' ? $normalized : 'payroll_excel';
}

function normalizeIdentityValue($value) {
    $normalized = preg_replace('/\s+/', ' ', trim((string)$value));
    return is_string($normalized) ? $normalized : '';
}

function normalizeIdentityKey($value) {
    $normalized = strtolower(normalizeIdentityValue($value));
    $normalized = preg_replace('/[^a-z0-9]+/', '', $normalized);
    return is_string($normalized) ? $normalized : '';
}

function isSequentialArray($value) {
    if (!is_array($value)) return false;
    return array_keys($value) === range(0, count($value) - 1);
}

function getBase44IdentityConfig() {
    $localConfig = [];
    $localConfigPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'base44.php';
    if (is_file($localConfigPath)) {
        $loaded = require $localConfigPath;
        if (is_array($loaded)) {
            $localConfig = $loaded;
        }
    }

    // Employee identity matching is optional.  This installation uses the
    // local MySQL biometric IDs as the source of truth, so skip the remote
    // Base44 lookup entirely when the feature is disabled.
    $featureFlag = getenv('BASE44_EMPLOYEE_IDENTITY_ENABLED');
    $featureEnabled = $featureFlag === false || $featureFlag === ''
        ? ($localConfig['employee_identity_enabled'] ?? true)
        : !in_array(strtolower(trim((string)$featureFlag)), ['0', 'false', 'off', 'no'], true);
    if (!$featureEnabled) {
        return null;
    }

    $appId = trim((string)(getenv('BASE44_APP_ID') ?: ($localConfig['app_id'] ?? '')));
    $apiKey = trim((string)(getenv('BASE44_API_KEY') ?: ($localConfig['api_key'] ?? '')));
    if ($appId === '' || $apiKey === '') {
        return null;
    }

    $entity = trim((string)(getenv('BASE44_EMPLOYEE_IDENTITY_ENTITY') ?: ($localConfig['entity'] ?? 'EmployeeIdentityMap')));
    if ($entity === '') {
        $entity = 'EmployeeIdentityMap';
    }

    return [
        'app_id' => $appId,
        'api_key' => $apiKey,
        'entity' => $entity,
    ];
}

function parseBase44EntityCollection($payload) {
    if (!is_array($payload)) return [];
    if (isSequentialArray($payload)) return $payload;

    foreach (['data', 'items', 'results', 'entities'] as $key) {
        if (isset($payload[$key]) && is_array($payload[$key])) {
            return $payload[$key];
        }
    }

    return [];
}

function base44EntityRequest($method, $path = '', $body = null) {
    $config = getBase44IdentityConfig();
    if ($config === null) {
        return [false, null, 'Base44 identity configuration is missing.'];
    }

    $baseUrl = 'https://base44.app/api/apps/' . rawurlencode($config['app_id']) . '/entities/' . rawurlencode($config['entity']);
    $path = ltrim((string)$path, '/');
    $url = $path !== '' ? $baseUrl . '/' . $path : $baseUrl;

    $headers = [
        'api_key: ' . $config['api_key'],
        'Content-Type: application/json',
    ];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper((string)$method));
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }
        $raw = curl_exec($ch);
        $curlError = curl_error($ch);
        $statusCode = intval(curl_getinfo($ch, CURLINFO_RESPONSE_CODE));
        curl_close($ch);

        if ($raw === false) {
            return [false, null, $curlError !== '' ? $curlError : 'Base44 request failed.'];
        }

        $decoded = json_decode($raw, true);
        if ($statusCode >= 400) {
            $message = is_array($decoded) ? trim((string)($decoded['message'] ?? $decoded['error'] ?? '')) : '';
            if ($message === '') {
                $message = 'Base44 request failed with status ' . $statusCode . '.';
            }
            return [false, $decoded, $message];
        }

        return [true, $decoded, ''];
    }

    $context = stream_context_create([
        'http' => [
            'method' => strtoupper((string)$method),
            'header' => implode("\r\n", $headers),
            'content' => $body !== null ? json_encode($body) : '',
            'timeout' => 15,
            'ignore_errors' => true,
        ],
    ]);

    $raw = @file_get_contents($url, false, $context);
    if ($raw === false) {
        return [false, null, 'Base44 request failed.'];
    }

    $decoded = json_decode($raw, true);
    return [true, $decoded, ''];
}

function fetchBase44IdentityMappings($sourceSystem) {
    $config = getBase44IdentityConfig();
    if ($config === null) {
        return [
            'enabled' => false,
            'error' => '',
            'items' => [],
            'by_code' => [],
            'by_name' => [],
        ];
    }

    [$ok, $payload, $error] = base44EntityRequest('GET');
    if (!$ok) {
        return [
            'enabled' => true,
            'error' => $error,
            'items' => [],
            'by_code' => [],
            'by_name' => [],
        ];
    }

    $items = parseBase44EntityCollection($payload);
    $byCode = [];
    $byName = [];
    $filtered = [];

    foreach ($items as $item) {
        if (!is_array($item)) continue;

        $employeeId = intval($item['employee_id'] ?? 0);
        if ($employeeId <= 0) continue;

        $itemSourceSystem = normalizeImportSourceSystem($item['source_system'] ?? '');
        if ($itemSourceSystem !== $sourceSystem) continue;

        $status = strtolower(trim((string)($item['match_status'] ?? '')));
        if ($status !== '' && !in_array($status, ['confirmed', 'approved', 'matched'], true)) {
            continue;
        }

        $filtered[] = $item;

        $codeKey = normalizeIdentityKey($item['external_employee_code'] ?? '');
        if ($codeKey !== '') {
            if (!isset($byCode[$codeKey])) $byCode[$codeKey] = [];
            $byCode[$codeKey][] = $item;
        }

        $nameKey = normalizeIdentityKey($item['external_employee_name'] ?? '');
        if ($nameKey !== '') {
            if (!isset($byName[$nameKey])) $byName[$nameKey] = [];
            $byName[$nameKey][] = $item;
        }
    }

    return [
        'enabled' => true,
        'error' => '',
        'items' => $filtered,
        'by_code' => $byCode,
        'by_name' => $byName,
    ];
}

function fetchAttendanceImportEmployeeDirectory($conn) {
        $sql = "SELECT e.employee_id,
                   e.branch_id,
                   e.employee_date_id,
                   e.first_name,
                   e.last_name,
                   e.email,
                   e.address,
                   e.date_of_birth,
                   e.salary,
                   e.status,
                   e.position,
                   e.sss_number,
                   e.pagibig_number,
                   e.philhealth_number,
                   e.tin_number,
                   e.document_resume,
                   e.document_nbi_clearance,
                   e.document_police_clearance,
                   e.document_barangay_clearance,
                   e.document_birth_certificate,
                   e.document_medical_certificate,
                   e.document_diploma_tor,
                   e.document_employment_contract,
                   COALESCE(b.branch_name, '') AS branch_name,
                   COALESCE(
                       (SELECT u.role FROM users u WHERE u.employee_id = e.employee_id ORDER BY u.id DESC LIMIT 1),
                       ''
                   ) AS linked_user_role
            FROM employees e
            LEFT JOIN branches b ON b.branch_id = e.branch_id
            WHERE e.status = 'active'";
    $result = $conn->query($sql);
    if (!$result) {
        throw new RuntimeException('Failed to load the active employee directory.');
    }

    $list = [];
    $byId = [];
    $byName = [];
    $byDateId = [];

    while ($row = $result->fetch_assoc()) {
        $firstName = trim((string)($row['first_name'] ?? ''));
        $lastName = trim((string)($row['last_name'] ?? ''));
        $fullName = trim(preg_replace('/\s+/', ' ', $firstName . ' ' . $lastName));
        $normalizedFullName = normalizeIdentityKey($fullName);

        $employee = [
            'employee_id' => intval($row['employee_id'] ?? 0),
            'branch_id' => intval($row['branch_id'] ?? 0),
            'employee_date_id' => (string)($row['employee_date_id'] ?? ''),
            'first_name' => $firstName,
            'last_name' => $lastName,
            'name' => $fullName !== '' ? $fullName : ('Employee #' . intval($row['employee_id'] ?? 0)),
            'salary' => floatval($row['salary'] ?? 0),
            'status' => (string)($row['status'] ?? 'active'),
            'position' => (string)($row['position'] ?? ''),
            'branch_name' => (string)($row['branch_name'] ?? ''),
            'linked_user_role' => (string)($row['linked_user_role'] ?? ''),
            'email' => (string)($row['email'] ?? ''),
            'address' => (string)($row['address'] ?? ''),
            'date_of_birth' => (string)($row['date_of_birth'] ?? ''),
            'sss_number' => (string)($row['sss_number'] ?? ''),
            'pagibig_number' => (string)($row['pagibig_number'] ?? ''),
            'philhealth_number' => (string)($row['philhealth_number'] ?? ''),
            'tin_number' => (string)($row['tin_number'] ?? ''),
            'document_resume' => intval($row['document_resume'] ?? 0),
            'document_nbi_clearance' => intval($row['document_nbi_clearance'] ?? 0),
            'document_police_clearance' => intval($row['document_police_clearance'] ?? 0),
            'document_barangay_clearance' => intval($row['document_barangay_clearance'] ?? 0),
            'document_birth_certificate' => intval($row['document_birth_certificate'] ?? 0),
            'document_medical_certificate' => intval($row['document_medical_certificate'] ?? 0),
            'document_diploma_tor' => intval($row['document_diploma_tor'] ?? 0),
            'document_employment_contract' => intval($row['document_employment_contract'] ?? 0),
            'normalized_full_name' => $normalizedFullName,
            'normalized_employee_date_id' => normalizeIdentityKey($row['employee_date_id'] ?? ''),
            'normalized_branch' => normalizeIdentityKey($row['branch_name'] ?? ''),
            'normalized_role' => normalizeIdentityKey($row['linked_user_role'] ?? ''),
        ];

        $byId[$employee['employee_id']] = $employee;
        $list[] = $employee;

        if ($normalizedFullName !== '') {
            if (!isset($byName[$normalizedFullName])) $byName[$normalizedFullName] = [];
            $byName[$normalizedFullName][] = $employee;
        }

        $dateIdKey = normalizeIdentityKey($row['employee_date_id'] ?? '');
        if ($dateIdKey !== '') {
            $byDateId[$dateIdKey] = $employee;
        }
    }

    return [
        'list' => $list,
        'by_id' => $byId,
        'by_name' => $byName,
        'by_date_id' => $byDateId,
    ];
}

/**
 * A payroll record is a payslip-ready record. Employees with an incomplete
 * employment file must be reported at import time instead of receiving a
 * draft payslip that is missing statutory or hiring information.
 */
function getPayrollEligibilityMissingItems($employee) {
    if (!is_array($employee)) return ['employee profile'];

    $missing = [];
    $requiredProfileFields = [
        'first_name' => 'first name',
        'last_name' => 'last name',
        'email' => 'email address',
        'address' => 'address',
        'date_of_birth' => 'birthdate',
        'sss_number' => 'SSS number',
        'pagibig_number' => 'Pag-IBIG number',
        'philhealth_number' => 'PhilHealth number',
        'tin_number' => 'TIN number',
    ];
    foreach ($requiredProfileFields as $field => $label) {
        if (trim((string)($employee[$field] ?? '')) === '') {
            $missing[] = $label;
        }
    }

    $requiredDocuments = [
        'document_resume' => 'Resume / CV',
        'document_nbi_clearance' => 'NBI Clearance',
        'document_police_clearance' => 'Police Clearance',
        'document_barangay_clearance' => 'Barangay Clearance',
        'document_birth_certificate' => 'Birth Certificate',
        'document_medical_certificate' => 'Medical Certificate',
        'document_diploma_tor' => 'Diploma / TOR',
        'document_employment_contract' => 'Signed Employment Contract',
    ];
    foreach ($requiredDocuments as $field => $label) {
        if (intval($employee[$field] ?? 0) !== 1) {
            $missing[] = $label;
        }
    }

    return $missing;
}

function describeIdentitySignals($signals) {
    $signals = array_values(array_filter(array_map(
        static fn($signal) => trim((string)$signal),
        is_array($signals) ? $signals : []
    )));
    return implode('; ', $signals);
}

function buildResolvedEmployeeMatch($employee, $method, $label, $confidence, $signals) {
    return [
        'ok' => true,
        'employee' => $employee,
        'method' => $method,
        'label' => $label,
        'confidence' => round(max(0, min(1, floatval($confidence))), 2),
        'signals' => $signals,
        'signal_summary' => describeIdentitySignals($signals),
    ];
}

function resolveBase44MappedEmployee($employeeDirectory, $mappings, $method, $label, $fieldLabel) {
    if (!is_array($mappings) || empty($mappings)) return null;

    $uniqueEmployeeIds = [];
    $bestMapping = null;
    $bestConfidence = -1;

    foreach ($mappings as $mapping) {
        if (!is_array($mapping)) continue;
        $employeeId = intval($mapping['employee_id'] ?? 0);
        if ($employeeId <= 0) continue;
        $uniqueEmployeeIds[$employeeId] = true;

        $confidence = floatval($mapping['confidence_score'] ?? 1);
        if ($bestMapping === null || $confidence > $bestConfidence) {
            $bestMapping = $mapping;
            $bestConfidence = $confidence;
        }
    }

    if ($bestMapping === null || count($uniqueEmployeeIds) !== 1) {
        return null;
    }

    $employeeId = intval($bestMapping['employee_id'] ?? 0);
    if ($employeeId <= 0 || !isset($employeeDirectory['by_id'][$employeeId])) {
        return null;
    }

    $employee = $employeeDirectory['by_id'][$employeeId];
    $signals = [
        'Confirmed Base44 mapping via ' . $fieldLabel,
    ];

    $externalName = normalizeIdentityValue($bestMapping['external_employee_name'] ?? '');
    if ($externalName !== '') {
        $signals[] = 'Mapped external name "' . $externalName . '"';
    }

    $matchedSignals = $bestMapping['matched_signals_json'] ?? null;
    if (is_array($matchedSignals) && !empty($matchedSignals)) {
        $signals[] = 'Base44 signals: ' . describeIdentitySignals($matchedSignals);
    } elseif (is_string($matchedSignals) && trim($matchedSignals) !== '') {
        $signals[] = 'Base44 signals: ' . trim($matchedSignals);
    }

    return buildResolvedEmployeeMatch(
        $employee,
        $method,
        $label,
        max(0.95, min(1, $bestConfidence > 0 ? $bestConfidence : 1)),
        $signals
    );
}

function resolveImportedEmployee($employeeDirectory, $base44Mappings, $sourceSystem, $externalEmployeeCode, $externalEmployeeName, $externalRole, $externalBranch) {
    $externalEmployeeCode = normalizeIdentityValue($externalEmployeeCode);
    $externalEmployeeName = normalizeIdentityValue($externalEmployeeName);
    $externalRole = normalizeIdentityValue($externalRole);
    $externalBranch = normalizeIdentityValue($externalBranch);

    $externalCodeKey = normalizeIdentityKey($externalEmployeeCode);
    $externalNameKey = normalizeIdentityKey($externalEmployeeName);
    $externalRoleKey = normalizeIdentityKey($externalRole);
    $externalBranchKey = normalizeIdentityKey($externalBranch);

    if ($externalCodeKey === '' && $externalNameKey === '') {
        return [
            'ok' => false,
            'message' => 'Missing employee identity. Provide EmployeeID, EmployeeName, or both.',
        ];
    }

    // ── Priority 1: confirmed Base44 code mapping ────────────────────────────
    // A ZKTeco EmployeeID is the authoritative identity signal.  It must be
    // checked before any saved external mapping, otherwise a stale mapping can
    // attach attendance (and payroll) to the wrong person.
    if ($externalCodeKey !== '' && !empty($employeeDirectory['by_date_id'][$externalCodeKey])) {
        $employee = $employeeDirectory['by_date_id'][$externalCodeKey];
        return buildResolvedEmployeeMatch(
            $employee,
            'employee_date_id_match',
            'Biometric ID matched employee record',
            1.0,
            ['ZKTeco Employee ID "' . $externalEmployeeCode . '" matched employee code "' . $employee['employee_date_id'] . '"']
        );
    }

    // Saved external mappings are a fallback only when the source code is not
    // an exact biometric/HR ID in this system.
    if (!empty($base44Mappings['by_code'][$externalCodeKey])) {
        $resolved = resolveBase44MappedEmployee(
            $employeeDirectory,
            $base44Mappings['by_code'][$externalCodeKey],
            'base44_confirmed_code',
            'Base44 confirmed code mapping',
            'external employee code'
        );
        if ($resolved !== null) {
            return $resolved;
        }
    }

    // ── Priority 2: confirmed Base44 name mapping ────────────────────────────
    if ($externalNameKey !== '' && !empty($base44Mappings['by_name'][$externalNameKey])) {
        $resolved = resolveBase44MappedEmployee(
            $employeeDirectory,
            $base44Mappings['by_name'][$externalNameKey],
            'base44_confirmed_name',
            'Base44 confirmed name mapping',
            'external employee name'
        );
        if ($resolved !== null) {
            return $resolved;
        }
    }

    // ── Priority 3: exact employee_date_id match (biometric/HR ID) ──────────
    // ── Code-only path: no name provided ────────────────────────────────────
    // The EmployeeID column contains a short code (e.g. initials like "AGH")
    // that didn't match any employee_date_id and has no confirmed Base44 mapping.
    // Role/branch signals alone are far too weak to identify an employee safely;
    // running fuzzy scoring would produce a wall of identical low-confidence
    // errors all pointing to the same arbitrary employee. Fail early instead.
    if ($externalNameKey === '') {
        $message = 'Unrecognised employee code "' . $externalEmployeeCode . '".';
        $message .= ' The code does not match any employee_date_id in the database.';
        $message .= ' Either add the EmployeeName column to your spreadsheet,'
            . ' update the employee\'s biometric/HR ID in the system to match this code,'
            . ' or create a confirmed identity mapping for source "' . $sourceSystem . '".';
        return ['ok' => false, 'message' => $message];
    }

    // ── Priority 4: fuzzy name matching (name must be present) ──────────────
    // Only name-bearing signals (exact match, high similarity, employee_date_id,
    // numeric ID) are used to score. Role and branch are intentionally excluded:
    // they are shared by many employees and produce misleading low-confidence
    // matches when name similarity is zero.
    $exactNameMatches = $employeeDirectory['by_name'][$externalNameKey] ?? [];
    $candidates = [];

    foreach ($employeeDirectory['list'] as $employee) {
        $score = 0.0;
        $signals = [];

        if ($employee['normalized_full_name'] !== '') {
            if ($employee['normalized_full_name'] === $externalNameKey) {
                $score += 0.82;
                $signals[] = 'Exact employee name match';
                if (count($exactNameMatches) === 1) {
                    $score += 0.14;
                    $signals[] = 'Unique active employee with this exact name';
                }
            } else {
                similar_text($externalNameKey, $employee['normalized_full_name'], $nameSimilarityPercent);
                $nameSimilarity = max(0, min(1, $nameSimilarityPercent / 100));
                if ($nameSimilarity >= 0.85) {
                    $score += min(0.72, $nameSimilarity * 0.72);
                    $signals[] = 'High name similarity ' . number_format($nameSimilarity, 2);
                } elseif ($nameSimilarity >= 0.75) {
                    $score += min(0.58, $nameSimilarity * 0.58);
                    $signals[] = 'Name similarity ' . number_format($nameSimilarity, 2);
                }
            }
        }

        // Code signals only supplement name — never used as sole evidence.
        if ($externalCodeKey !== '') {
            if ($employee['normalized_employee_date_id'] !== '' && $employee['normalized_employee_date_id'] === $externalCodeKey) {
                $score += 0.35;
                $signals[] = 'External code matched employee code';
            }
            if (ctype_digit($externalCodeKey) && intval($externalCodeKey) === intval($employee['employee_id'])) {
                $score += 0.12;
                $signals[] = 'External code matched internal ID (low-trust signal)';
            }
        }

        // Role/branch are intentionally NOT scored here.
        // They are shared across many employees; awarding them when there is no
        // name match causes every unresolved row to accumulate a tiny identical
        // score and produce the same misleading "best match" error repeatedly.

        // Only keep candidates that have at least some name-level evidence.
        if ($score <= 0) continue;

        $candidates[] = [
            'employee' => $employee,
            'score' => min(0.99, $score),
            'signals' => $signals,
        ];
    }

    if (empty($candidates)) {
        return [
            'ok' => false,
            'message' => 'No active employee matched "' . $externalEmployeeName . '" closely enough for safe payroll import.',
        ];
    }

    usort($candidates, static function ($left, $right) {
        $scoreCompare = $right['score'] <=> $left['score'];
        if ($scoreCompare !== 0) return $scoreCompare;
        return $left['employee']['employee_id'] <=> $right['employee']['employee_id'];
    });

    $topCandidate = $candidates[0];
    $secondCandidate = $candidates[1] ?? null;

    if ($topCandidate['score'] < 0.95) {
        return [
            'ok' => false,
            'message' => 'Low-confidence match for "' . $externalEmployeeName . '": best candidate was '
                . $topCandidate['employee']['name']
                . ' (confidence ' . number_format($topCandidate['score'], 2) . ').'
                . ' Provide an exact name, update the biometric ID, or confirm a mapping.',
        ];
    }

    if ($secondCandidate !== null && abs($topCandidate['score'] - $secondCandidate['score']) < 0.05) {
        return [
            'ok' => false,
            'message' => 'Ambiguous identity for "' . $externalEmployeeName . '". Multiple employees scored too closely for safe payroll import.',
        ];
    }

    return buildResolvedEmployeeMatch(
        $topCandidate['employee'],
        'smart_name_match',
        'Smart exact-name match',
        $topCandidate['score'],
        $topCandidate['signals']
    );
}

function attendanceImportUserId() {
    return intval($_SESSION['user_id'] ?? 0);
}

/**
 * POST?action=import_init — start/resume a chunked import upload.
 * Fields: file_name, file_size, pay_period_start, pay_period_end,
 * source_system?, resume_id?.
 */
function handleImportInit($conn) {
    $payPeriodStart = trim((string)($_POST['pay_period_start'] ?? ''));
    $payPeriodEnd = trim((string)($_POST['pay_period_end'] ?? ''));
    $sourceSystem = normalizeImportSourceSystem($_POST['source_system'] ?? 'payroll_excel');
    if (!$payPeriodStart || !$payPeriodEnd) {
        sendError('Pay period start and end dates are required', 400);
    }
    validateImportPayPeriodDates($payPeriodStart, $payPeriodEnd);

    chunkUploadInit(
        attendanceImportUserId(),
        'attendance_import',
        (string)($_POST['file_name'] ?? ''),
        (int)($_POST['file_size'] ?? 0),
        ATTENDANCE_IMPORT_CHUNK_MAX_BYTES,
        ATTENDANCE_IMPORT_CHUNK_ALLOWED_EXTS,
        [
            'pay_period_start' => $payPeriodStart,
            'pay_period_end' => $payPeriodEnd,
            'source_system' => $sourceSystem,
        ]
    );
}

/** POST?action=import_chunk — append one chunk (upload_id, offset, chunk). */
function handleImportChunk($conn) {
    chunkUploadAppend(attendanceImportUserId());
}

/**
 * POST?action=import_complete — run the normal import pipeline against the
 * assembled file. The temp session is dropped first because handleImport
 * exits via its own response.
 */
function handleImportComplete($conn) {
    [$partPath, $meta, $uploadId] = chunkUploadRequireComplete(attendanceImportUserId(), 'attendance_import');

    $stored = (array)($meta['meta'] ?? []);
    $staged = tempnam(sys_get_temp_dir(), 'attendance_complete_');
    if ($staged === false || !@copy($partPath, $staged)) {
        if (is_string($staged)) @unlink($staged);
        sendError('Failed to finalize upload.', 500);
    }
    chunkUploadDeleteSession($uploadId);

    $origName = (string)($meta['file_name'] ?? 'import');
    $_FILES['file'] = [
        'name' => $origName,
        'type' => '',
        'tmp_name' => $staged,
        'error' => UPLOAD_ERR_OK,
        'size' => (int)($meta['file_size'] ?? 0),
    ];
    $_POST['pay_period_start'] = (string)($stored['pay_period_start'] ?? '');
    $_POST['pay_period_end'] = (string)($stored['pay_period_end'] ?? '');
    $_POST['source_system'] = (string)($stored['source_system'] ?? 'payroll_excel');

    handleImport($conn);
}

/** POST?action=import_abort — discard a chunked import session. */
function handleImportAbort($conn) {
    $uploadId = chunkUploadSanitizeId($_POST['upload_id'] ?? '');
    if ($uploadId !== false) {
        $meta = chunkUploadReadMeta($uploadId);
        if (is_array($meta) && (int)($meta['user_id'] ?? 0) === attendanceImportUserId()) {
            chunkUploadDeleteSession($uploadId);
        }
    }
    sendResponse(true, null, 'Upload discarded.');
}

/**
 * One row of import evidence behind a result card (`details` in the response).
 */
function importDetailEntry($rowNum, $code, $name, $status, $detail = '', $employeeId = 0, $payrollId = 0) {
    return [
        'row' => (int)$rowNum,
        'code' => (string)$code,
        'name' => (string)$name,
        'status' => (string)$status,
        'detail' => (string)$detail,
        'employee_id' => (int)$employeeId,
        'payroll_id' => (int)$payrollId,
    ];
}

/**
 * Sniff the leading bytes for a container that is not plain text. Returns a
 * human-readable label, or '' when the file starts like text.
 */
function detectBinaryContainer($filepath) {
    $handle = @fopen($filepath, 'rb');
    if ($handle === false) {
        return '';
    }
    $head = (string)fread($handle, 8);
    fclose($handle);

    if (strncmp($head, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1", 8) === 0) {
        return 'a legacy Microsoft Office workbook (.xls/.doc), not text';
    }
    if (strncmp($head, "PK\x03\x04", 4) === 0) {
        return 'a zipped Office file (.xlsx/.docx), not text';
    }
    if (strncmp($head, '%PDF', 4) === 0) {
        return 'a PDF document';
    }

    return '';
}

function handleImport($conn) {
    if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        $errors = [
            UPLOAD_ERR_INI_SIZE => 'File exceeds server upload limit',
            UPLOAD_ERR_FORM_SIZE => 'File exceeds form upload limit',
            UPLOAD_ERR_PARTIAL => 'File was only partially uploaded',
            UPLOAD_ERR_NO_FILE => 'No file was uploaded',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temp folder on server',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk',
        ];
        $code = $_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE;
        sendError($errors[$code] ?? 'File upload failed', 400);
    }

    $file = $_FILES['file'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    if (!in_array($ext, ATTENDANCE_IMPORT_CHUNK_ALLOWED_EXTS, true)) {
        sendError(
            'Only ' . implode(', ', array_map(static fn($allowed) => '.' . $allowed, ATTENDANCE_IMPORT_CHUNK_ALLOWED_EXTS))
            . ' files are supported. Please use the provided template headers.',
            400
        );
    }

    // A renamed workbook cannot be read as text, so sniff the real container and
    // say so instead of reporting missing columns — renaming
    // 18_StandardReport.xls to .dat was the first thing operators tried.
    if (in_array($ext, ['dat', 'csv'], true)) {
        $realContainer = detectBinaryContainer($file['tmp_name']);
        if ($realContainer !== '') {
            sendError(
                'This .' . $ext . ' file is actually ' . $realContainer . '. Renaming a file does not convert it — '
                . 'upload the workbook as .xls, or save the sheet as .csv with the template headers, then import that.',
                400
            );
        }
    }

    $payPeriodStart = $_POST['pay_period_start'] ?? '';
    $payPeriodEnd = $_POST['pay_period_end'] ?? '';
    $sourceSystem = normalizeImportSourceSystem($_POST['source_system'] ?? 'payroll_excel');
    if (!$payPeriodStart || !$payPeriodEnd) {
        sendError('Pay period start and end dates are required', 400);
    }
    validateImportPayPeriodDates($payPeriodStart, $payPeriodEnd);

    if ($ext === 'csv' || $ext === 'dat') {
        // .dat is the ZKTeco USB export: plain tab-delimited text in disguise,
        // so parseCsv() — whose delimiter sniffing already covers TAB — reads it.
        $rows = parseCsv($file['tmp_name']);
    } elseif ($ext === 'xls') {
        $csvContent = parseXls($file['tmp_name']);
        $tmpCsv = tempnam(sys_get_temp_dir(), 'xls_conv_') . '.csv';
        file_put_contents($tmpCsv, $csvContent);
        $rows = parseCsv($tmpCsv);
        @unlink($tmpCsv);
    } else {
        $rows = parseXlsx($file['tmp_name']);
    }
    if (empty($rows)) {
        sendError('The uploaded file contains no data rows', 400);
    }

    $headers = array_map('strtolower', array_map('trim', $rows[0]));
    $requiredColumns = ['daysworked', 'overtimehours', 'lateminutes', 'absentdays'];
    $missingColumns = [];
    foreach ($requiredColumns as $column) {
        if (!in_array($column, $headers, true)) {
            $missingColumns[] = $column;
        }
    }

    if (!empty($missingColumns)) {
        if ($ext === 'dat') {
            sendError(
                'This .dat file has no aggregate attendance columns. A ZKTeco punch log stores one row per scan, '
                . 'not the period totals the importer needs (DaysWorked, OvertimeHours, LateMinutes, AbsentDays). '
                . 'Export those period totals — the blank template lists the exact headers — then upload the result. '
                . 'Missing required columns: ' . implode(', ', $missingColumns) . '.',
                400
            );
        }
        sendError('Missing required columns: ' . implode(', ', $missingColumns) . '. Please use the provided template.', 400);
    }

    $columnMap = array_flip($headers);
    $batchId = 'ATT-' . date('Ymd-His') . '-' . substr(uniqid(), -5);
    $created = 0;
    $skipped = 0;
    $errorsList = [];
    $warningsList = [];
    $incompletePayrollEmployees = [];
    $duplicatePayrollEmployees = [];
    // Track codes that already produced an unresolved-code error so we only
    // report each unknown code once instead of once per row.
    $unresolvedCodeSeen = [];
    // Per-row evidence behind each result card so the UI can show WHICH
    // employee/row landed in each bucket instead of a bare count.
    $createdDetails = [];
    $skippedDetails = [];
    $identityDetails = [
        'matched_via_biometric_id' => [],
        'matched_via_base44' => [],
        'matched_via_smart_name' => [],
        'unresolved' => [],
    ];
    $identitySummary = [
        'source_system' => $sourceSystem,
        'matched_via_biometric_id' => 0,
        'matched_via_base44' => 0,
        'matched_via_smart_name' => 0,
        'unresolved' => 0,
    ];

    $employeeDirectory = fetchAttendanceImportEmployeeDirectory($conn);
    $base44Mappings = fetchBase44IdentityMappings($sourceSystem);
    if (!empty($base44Mappings['error'])) {
        $warningsList[] = buildBase44ImportWarning($base44Mappings['error']);
    }

    // Unpaid-leave lookup for the informational per-record breakdown (the
    // file's AbsentDays stays the source of truth for the actual deduction —
    // this never alters absenceDeduction, avoiding double-counting).
    $hasLeaveTypeTable = false;
    $ltCheck = $conn->query("SHOW TABLES LIKE 'leave_type'");
    if ($ltCheck) {
        $hasLeaveTypeTable = $ltCheck->num_rows > 0;
        $ltCheck->close();
    }
    // Older installations classify unpaid leave by type_key only. Newer
    // installations may additionally have an is_paid column. Detect it so a
    // missing optional column can never prevent attendance payroll import.
    $hasLeaveTypePaidFlag = false;
    if ($hasLeaveTypeTable) {
        $paidFlagCheck = $conn->query("SHOW COLUMNS FROM leave_type LIKE 'is_paid'");
        if ($paidFlagCheck) {
            $hasLeaveTypePaidFlag = $paidFlagCheck->num_rows > 0;
            $paidFlagCheck->close();
        }
    }
    $liStmt = null;
    if ($hasLeaveTypeTable && $hasLeaveTypePaidFlag) {
        $liStmt = $conn->prepare(
            "SELECT lr.start_date, lr.end_date
             FROM leave_request lr
             LEFT JOIN leave_type lt ON LOWER(TRIM(lt.type_key)) = LOWER(TRIM(lr.leave_type))
             WHERE lr.employee_id = ? AND lr.status = 'approved'
               AND lr.start_date <= ? AND lr.end_date >= ?
               AND COALESCE(lt.is_paid, 1) = 0
             ORDER BY lr.start_date ASC"
        );
    } elseif ($hasLeaveTypeTable) {
        $liStmt = $conn->prepare(
            "SELECT lr.start_date, lr.end_date
             FROM leave_request lr
             LEFT JOIN leave_type lt ON LOWER(TRIM(lt.type_key)) = LOWER(TRIM(lr.leave_type))
             WHERE lr.employee_id = ? AND lr.status = 'approved'
               AND lr.start_date <= ? AND lr.end_date >= ?
               AND LOWER(TRIM(COALESCE(lt.type_key, lr.leave_type))) = 'unpaid'
             ORDER BY lr.start_date ASC"
        );
    } else {
        $liStmt = $conn->prepare(
            "SELECT start_date, end_date
             FROM leave_request
             WHERE employee_id = ? AND status = 'approved'
               AND start_date <= ? AND end_date >= ?
               AND LOWER(TRIM(leave_type)) = 'unpaid'
             ORDER BY start_date ASC"
        );
    }
    if ($liStmt === false) $liStmt = null;

    for ($i = 1; $i < count($rows); $i++) {
        $row = $rows[$i];
        $rowNum = $i + 1;

        $externalEmployeeCode = isset($columnMap['employeeid'])
            ? normalizeIdentityValue($row[$columnMap['employeeid']] ?? '')
            : '';
        $externalEmployeeName = isset($columnMap['employeename'])
            ? normalizeIdentityValue($row[$columnMap['employeename']] ?? '')
            : '';
        $externalRole = isset($columnMap['role'])
            ? normalizeIdentityValue($row[$columnMap['role']] ?? '')
            : '';
        $externalBranch = isset($columnMap['branch'])
            ? normalizeIdentityValue($row[$columnMap['branch']] ?? '')
            : '';
        $daysWorked = floatval($row[$columnMap['daysworked']] ?? 0);
        $otHours = floatval($row[$columnMap['overtimehours']] ?? 0);
        $lateMinutes = intval($row[$columnMap['lateminutes']] ?? 0);
        $absentDays = floatval($row[$columnMap['absentdays']] ?? 0);
        $leaveDays = isset($columnMap['leavedays']) ? floatval($row[$columnMap['leavedays']] ?? 0) : 0;

        if ($externalEmployeeCode === '' && $externalEmployeeName === '') {
            $skipped++;
            $identitySummary['unresolved']++;
            $errorsList[] = "Row $rowNum: Missing EmployeeID and EmployeeName";
            $missingEntry = importDetailEntry($rowNum, '', '', 'missing_identity', 'Missing EmployeeID and EmployeeName');
            $skippedDetails[] = $missingEntry;
            $identityDetails['unresolved'][] = $missingEntry;
            continue;
        }

        $resolution = resolveImportedEmployee(
            $employeeDirectory,
            $base44Mappings,
            $sourceSystem,
            $externalEmployeeCode,
            $externalEmployeeName,
            $externalRole,
            $externalBranch
        );

        if (empty($resolution['ok'])) {
            $skipped++;
            $identitySummary['unresolved']++;
            $errorMessage = trim((string)($resolution['message'] ?? 'Failed to resolve employee identity.'));
            // Recorded per row (the console list below stays de-duplicated).
            $unresolvedEntry = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName, 'unresolved', $errorMessage);
            $skippedDetails[] = $unresolvedEntry;
            $identityDetails['unresolved'][] = $unresolvedEntry;

            // Deduplicate: when many rows share the same unresolvable code and
            // no name, suppress repeating the same message for every row.
            // The first occurrence records the message; subsequent ones are
            // counted silently so the total skipped count stays accurate.
            $dedupeKey = $externalEmployeeCode !== '' && $externalEmployeeName === ''
                ? normalizeIdentityKey($externalEmployeeCode)
                : '';
            if ($dedupeKey !== '') {
                if (isset($unresolvedCodeSeen[$dedupeKey])) {
                    // Already reported — only increment the count in the summary message.
                    $unresolvedCodeSeen[$dedupeKey]++;
                    // Update the existing error entry to show the total row count.
                    $idx = $unresolvedCodeSeen[$dedupeKey . '__idx'];
                    $count = $unresolvedCodeSeen[$dedupeKey];
                    $errorsList[$idx] = preg_replace(
                        '/\s*\(\d+ rows?\)$/',
                        '',
                        $errorsList[$idx]
                    ) . ' (' . $count . ' rows)';
                    continue;
                }
                $unresolvedCodeSeen[$dedupeKey] = 1;
                $unresolvedCodeSeen[$dedupeKey . '__idx'] = count($errorsList);
            }

            $errorsList[] = 'Row ' . $rowNum . ': ' . $errorMessage;
            continue;
        }

        $employee = $resolution['employee'];
        $employeeId = intval($employee['employee_id'] ?? 0);
        if ($employeeId <= 0) {
            $skipped++;
            $identitySummary['unresolved']++;
            $errorsList[] = "Row $rowNum: Resolved employee identity was invalid";
            $invalidEntry = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName, 'invalid_identity', 'Resolved employee identity was invalid');
            $skippedDetails[] = $invalidEntry;
            $identityDetails['unresolved'][] = $invalidEntry;
            continue;
        }

        // Keep the import non-blocking while the company completes legacy
        // employee files. The import result tells the payroll administrator
        // exactly who needs attention before the payslip is released.
        $missingPayrollRequirements = getPayrollEligibilityMissingItems($employee);
        if (!empty($missingPayrollRequirements)) {
            $incompletePayrollEmployees[$employeeId] = $employee['name'];
        }

        if (($resolution['method'] ?? '') === 'employee_date_id_match') {
            $identitySummary['matched_via_biometric_id']++;
            $identityDetails['matched_via_biometric_id'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $employee['name'],
                'matched_via_biometric_id',
                'Matched to employee #' . $employeeId . ' by exact ZKTeco Employee ID',
                $employeeId
            );
        } elseif (($resolution['method'] ?? '') === 'smart_name_match') {
            $identitySummary['matched_via_smart_name']++;
            $identityDetails['matched_via_smart_name'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $employee['name'],
                'matched_via_smart_name',
                'Matched to employee #' . $employeeId . ' by employee name',
                $employeeId
            );
        } else {
            $identitySummary['matched_via_base44']++;
            $identityDetails['matched_via_base44'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $employee['name'],
                'matched_via_base44',
                'Matched to employee #' . $employeeId . ' from the Base44 identity map',
                $employeeId
            );
        }

        $duplicateStmt = $conn->prepare(
            "SELECT id
             FROM payroll
             WHERE employee_id = ? AND pay_period_start = ? AND pay_period_end = ?"
        );
        if (!$duplicateStmt) {
            throw new RuntimeException('Failed to validate duplicate payroll records.');
        }
        $duplicateStmt->bind_param('iss', $employeeId, $payPeriodStart, $payPeriodEnd);
        $duplicateStmt->execute();
        if ($duplicateStmt->get_result()->num_rows > 0) {
            $skipped++;
            $duplicatePayrollEmployees[$employeeId] = true;
            $skippedDetails[] = importDetailEntry($rowNum, $externalEmployeeCode, $employee['name'], 'duplicate', 'Attendance was already imported for this pay period; duplicate payroll was not created.', $employeeId);
            $duplicateStmt->close();
            continue;
        }
        $duplicateStmt->close();

        $monthlySalary = floatval($employee['salary']);
        $companyDailyRate = getCompanyDailyRate($conn, intval($employee['branch_id'] ?? 0));
        $usesCompanyDailyRate = $companyDailyRate > 0;
        // Gross before attendance is the full scheduled-period salary. The
        // attendance file then supplies late and absence deductions exactly
        // once; it must never reduce the basic salary and deduct it again.
        $dailyRate = $usesCompanyDailyRate
            ? $companyDailyRate
            : payrollPeriodDailyRate($monthlySalary, $payPeriodStart, $payPeriodEnd);
        $hourlyRate = $dailyRate / 8;
        $scheduledWorkdays = payrollPeriodScheduledWorkdays($payPeriodStart, $payPeriodEnd);

        $basicSalary = $usesCompanyDailyRate
            ? round($scheduledWorkdays * $dailyRate, 2)
            : $monthlySalary / 2;
        $otRate = round($hourlyRate * 1.25, 2);
        $otPay = round($otHours * $otRate, 2);
        $lateDeduction = round($lateMinutes * ($dailyRate / 480), 2);
        $absenceDeduction = round($absentDays * $dailyRate, 2);
        $grossPay = $basicSalary + $otPay - $lateDeduction - $absenceDeduction;

        // Informational unpaid-leave breakdown (overlapping approved unpaid
        // leaves). Never added to absenceDeduction — the file is authoritative.
        $leaveImpactDays = 0.0;
        $leaveImpactAmount = 0.0;
        if ($liStmt && $dailyRate > 0) {
            $liStmt->bind_param('iss', $employeeId, $payPeriodEnd, $payPeriodStart);
            $liStmt->execute();
            $liRes = $liStmt->get_result();
            $pStartTs = strtotime($payPeriodStart);
            $pEndTs = strtotime($payPeriodEnd);
            while ($liRow = $liRes->fetch_assoc()) {
                $rStartTs = strtotime(substr((string)($liRow['start_date'] ?? ''), 0, 10));
                $rEndTs = strtotime(substr((string)($liRow['end_date'] ?? ''), 0, 10));
                if ($rStartTs === false || $rEndTs === false) continue;
                $overlapStart = max($rStartTs, $pStartTs);
                $overlapEnd = min($rEndTs, $pEndTs);
                if ($overlapEnd < $overlapStart) continue;
                $leaveImpactDays += (float)(floor(($overlapEnd - $overlapStart) / 86400) + 1);
            }
            $leaveImpactDays = round($leaveImpactDays, 2);
            $leaveImpactAmount = round($leaveImpactDays * $dailyRate, 2);
        }

        $tax = 0;
        $sss = 0;
        $pagibig = 0;
        $philhealth = 0;
        $cashAdvance = 0;
        $laptopLoan = 0;
        $otherDeductions = 0;
        $bonus = 0;
        $clothingAllowance = 0;
        $travelAllowance = 0;
        $salaryAdjustment = 0;

        // Auto-calculate government deductions from settings when available.
        // Deduction-type tables (SSS MSC, tax brackets) are MONTHLY bases,
        // so they always use the monthly salary — not the semi-monthly basic.
        $govEligibility = buildGovEligibilityFromEmployee($employee);
        $governmentMonthlyBase = $usesCompanyDailyRate ? ($companyDailyRate * 22) : $monthlySalary;
        $govDefaults = computeGovernmentDeductionsFromTypes($conn, floatval($governmentMonthlyBase), $govEligibility);
        if (isset($govDefaults['tax'])) $tax = $govDefaults['tax'];
        if (isset($govDefaults['sss_contribution'])) $sss = $govDefaults['sss_contribution'];
        if (isset($govDefaults['pagibig_contribution'])) $pagibig = $govDefaults['pagibig_contribution'];
        if (isset($govDefaults['philhealth_contribution'])) $philhealth = $govDefaults['philhealth_contribution'];

        $totalDeductions = $tax + $sss + $pagibig + $philhealth + $cashAdvance + $laptopLoan + $otherDeductions;
        $netPay = max(0, $grossPay - $totalDeductions + $bonus);
        // Payroll Notes are employee-facing. Technical batch and identity
        // information remains in the audit/activity logs, not on a payslip.
        $attendanceNoteParts = [
            number_format($daysWorked, 2) . ' day(s) worked',
            number_format($absentDays, 2) . ' absence day(s)',
            intval($lateMinutes) . ' late minute(s)',
        ];
        if ($otHours > 0) {
            $attendanceNoteParts[] = number_format($otHours, 2) . ' overtime hour(s)';
        }
        if ($leaveDays > 0) {
            $attendanceNoteParts[] = number_format($leaveDays, 2) . ' leave day(s)';
        }
        $importNote = 'Attendance imported: ' . implode(', ', $attendanceNoteParts) . '.';

        $attendanceStmt = $conn->prepare(
            "INSERT INTO attendance_records
                (employee_id, pay_period_start, pay_period_end, days_worked, overtime_hours,
                 late_minutes, absent_days, leave_days, import_batch_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        if (!$attendanceStmt) {
            throw new RuntimeException('Failed to prepare attendance import storage.');
        }

        $payrollStmt = $conn->prepare(
            "INSERT INTO payroll
                (employee_id, employee_name, pay_period_start, pay_period_end,
                 basic_salary, overtime_hours, overtime_rate, overtime_pay, bonus,
                 clothing_allowance, travel_allowance, salary_adjustment,
                 late_deduction, absence_deduction,
                 unpaid_leave_days, unpaid_leave_amount,
                 tax, sss_contribution, pagibig_contribution, philhealth_contribution,
                 cash_advance_deduction, cash_advance_manual_deduction, laptop_loan_deduction, other_deductions,
                 gross_pay, total_deductions, net_pay, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)"
        );
        if (!$payrollStmt) {
            $attendanceStmt->close();
            throw new RuntimeException('Failed to prepare payroll import storage.');
        }

        $conn->begin_transaction();
        try {
            $attendanceStmt->bind_param(
                'issddidds',
                $employeeId,
                $payPeriodStart,
                $payPeriodEnd,
                $daysWorked,
                $otHours,
                $lateMinutes,
                $absentDays,
                $leaveDays,
                $batchId
            );
            $attendanceStmt->execute();

            $payrollBindTypes = 'isss' . str_repeat('d', 23) . 's';
            $payrollStmt->bind_param(
                $payrollBindTypes,
                $employeeId,
                $employee['name'],
                $payPeriodStart,
                $payPeriodEnd,
                $basicSalary,
                $otHours,
                $otRate,
                $otPay,
                $bonus,
                $clothingAllowance,
                $travelAllowance,
                $salaryAdjustment,
                $lateDeduction,
                $absenceDeduction,
                $leaveImpactDays,
                $leaveImpactAmount,
                $tax,
                $sss,
                $pagibig,
                $philhealth,
                $cashAdvance,
                $cashAdvance,
                $laptopLoan,
                $otherDeductions,
                $grossPay,
                $totalDeductions,
                $netPay,
                $importNote
            );
            $payrollStmt->execute();
            $payrollId = intval($conn->insert_id);
            if ($payrollId > 0) {
                syncPayrollCashAdvanceRequests($conn, $payrollId);
            }

            $conn->commit();
            $created++;
            $createdDetails[] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $employee['name'],
                'created',
                'Draft payroll #' . $payrollId . ' — net ' . number_format($netPay, 2) . ' for ' . $payPeriodStart . ' to ' . $payPeriodEnd,
                $employeeId,
                $payrollId
            );
        } catch (Throwable $e) {
            $conn->rollback();
            $skipped++;
            $errorsList[] = "Row $rowNum: Failed to create payroll for {$employee['name']}: " . $e->getMessage();
            $skippedDetails[] = importDetailEntry($rowNum, $externalEmployeeCode, $employee['name'], 'create_failed', $e->getMessage(), $employeeId);
        }

            $attendanceStmt->close();
            $payrollStmt->close();
        }

        if ($liStmt) $liStmt->close();

        if (!empty($incompletePayrollEmployees)) {
            $count = count($incompletePayrollEmployees);
            $label = $count === 1 ? 'employee has' : 'employees have';
            $warningsList[] = "$count $label incomplete payroll requirements. This is informational only and does not block payroll generation or payslip release. Review Employees → Payroll Readiness when convenient.";
        }
        if (!empty($duplicatePayrollEmployees)) {
            $duplicateCount = count($duplicatePayrollEmployees);
            if ($created === 0) {
                $warningsList[] = 'This attendance file was already imported for the selected pay period. No duplicate payroll records were created.';
            } else {
                $warningsList[] = "$duplicateCount existing payroll record(s) were skipped to prevent duplicate payments.";
            }
        }

        $userId = checkAuthentication();
        releaseSessionLock();
    if ($userId) {
        $payrollRecordLabel = $created === 1 ? 'draft payroll record' : 'draft payroll records';
        $activityDescription = "Attendance file imported; {$created} {$payrollRecordLabel} created.";
        if ($skipped > 0) {
            $skippedLabel = $skipped === 1 ? 'row was' : 'rows were';
            $activityDescription .= " {$skipped} {$skippedLabel} not imported.";
        }
        logActivity(
            $conn,
            $userId,
            'import_attendance',
            $activityDescription,
            'payroll_management'
        );
        logAuditTrail(
            $conn,
            $userId,
            'attendance_import',
            $batchId,
            'import',
            null,
            [
                'batch_id' => $batchId,
                'source_system' => $sourceSystem,
                'records_created' => $created,
                'records_skipped' => $skipped,
                'error_count' => count($errorsList),
                'warning_count' => count($warningsList),
                'identity_summary' => $identitySummary,
            ],
            basename(__FILE__)
        );
    }

    if (!empty($errorsList)) {
        $maxQueue = min(120, count($errorsList));
        for ($idx = 0; $idx < $maxQueue; $idx++) {
            $message = (string)$errorsList[$idx];
            $sourceRecordId = $batchId . '-err-' . ($idx + 1);
            upsertExceptionQueue(
                $conn,
                'attendance_import',
                $sourceRecordId,
                'Attendance import row error',
                $message,
                'high',
                'admin',
                [
                    'batch_id' => $batchId,
                    'error_index' => $idx + 1,
                    'message' => $message,
                ],
                intval($_SESSION['user_id'] ?? 0) > 0 ? intval($_SESSION['user_id'] ?? 0) : null
            );
        }
    }

    sendResponse(
        true,
        [
            'batch_id' => $batchId,
            'source_system' => $sourceSystem,
            'records_created' => $created,
            'records_skipped' => $skipped,
            'errors' => $errorsList,
            'warnings' => $warningsList,
            'identity_summary' => $identitySummary,
            // Per-row evidence behind each result card ("which is which").
            'details' => [
                'created' => $createdDetails,
                'skipped' => $skippedDetails,
                'matched_via_biometric_id' => $identityDetails['matched_via_biometric_id'],
                'matched_via_base44' => $identityDetails['matched_via_base44'],
                'matched_via_smart_name' => $identityDetails['matched_via_smart_name'],
                'unresolved' => $identityDetails['unresolved'],
            ],
        ],
        $created > 0 ? "$created payroll record(s) created as draft" : 'No payroll records were created'
    );
}

function parseCsv($filepath) {
    $handle = @fopen($filepath, 'rb');
    if ($handle === false) {
        sendError('Failed to open the CSV file. Make sure it is a valid .csv file.', 400);
    }

    $delimiter = detectCsvDelimiter($handle);
    rewind($handle);

    $rows = [];
    while (($row = fgetcsv($handle, 0, $delimiter)) !== false) {
        if (!is_array($row)) {
            continue;
        }

        $normalizedRow = [];
        foreach ($row as $index => $value) {
            $cellValue = trim((string)$value);
            if ($index === 0) {
                $cellValue = preg_replace('/^\xEF\xBB\xBF/u', '', $cellValue) ?? $cellValue;
            }
            $normalizedRow[] = $cellValue;
        }

        if (!empty(array_filter($normalizedRow, static fn($value) => $value !== ''))) {
            $rows[] = $normalizedRow;
        }
    }

    fclose($handle);
    return $rows;
}

function detectCsvDelimiter($handle) {
    $candidates = [',', ';', "\t", '|'];
    $scores = [
        ',' => 0,
        ';' => 0,
        "\t" => 0,
        '|' => 0,
    ];

    $sampleCount = 0;
    while (($line = fgets($handle)) !== false && $sampleCount < 6) {
        $line = (string)$line;
        if (trim($line) === '') {
            continue;
        }
        $sampleCount++;

        foreach ($candidates as $candidate) {
            $fields = str_getcsv($line, $candidate);
            $fieldCount = is_array($fields) ? count($fields) : 0;
            if ($fieldCount > $scores[$candidate]) {
                $scores[$candidate] = $fieldCount;
            }
        }
    }

    $best = ',';
    $bestScore = 0;
    foreach ($candidates as $candidate) {
        if ($scores[$candidate] > $bestScore) {
            $best = $candidate;
            $bestScore = $scores[$candidate];
        }
    }

    return $best;
}

function buildBase44ImportWarning($baseError) {
    $baseError = trim((string)$baseError);
    if ($baseError === '') {
        return 'Base44 identity lookup was unavailable. The import used local smart matching only.';
    }

    if (strlen($baseError) > 220) {
        $baseError = substr($baseError, 0, 217) . '...';
    }

    return 'Base44 identity lookup was unavailable: ' . $baseError . '. The import used local smart matching only.';
}

function parseXlsx($filepath) {
    $rows = [];
    $sharedStrings = [];

    $sharedStringsXml = readSpreadsheetEntry($filepath, 'xl/sharedStrings.xml');
    if ($sharedStringsXml !== false) {
        $sharedStringsDoc = new SimpleXMLElement($sharedStringsXml);
        foreach ($sharedStringsDoc->si as $si) {
            $text = '';
            if (isset($si->t)) {
                $text = (string)$si->t;
            } elseif (isset($si->r)) {
                foreach ($si->r as $run) {
                    $text .= (string)$run->t;
                }
            }
            $sharedStrings[] = $text;
        }
    }

    $sheetXml = readSpreadsheetEntry($filepath, 'xl/worksheets/sheet1.xml');
    if ($sheetXml === false) {
        sendError('Failed to open the Excel file. Make sure it is a valid .xlsx file.', 400);
    }

    $sheet = new SimpleXMLElement($sheetXml);
    foreach ($sheet->sheetData->row as $row) {
        $rowData = [];
        foreach ($row->c as $cell) {
            $ref = (string)$cell['r'];
            $colLetter = preg_replace('/[0-9]/', '', $ref);
            $colIndex = columnLetterToIndex($colLetter);

            while (count($rowData) < $colIndex) {
                $rowData[] = '';
            }

            $type = (string)($cell['t'] ?? '');
            if ($type === 's') {
                $value = $sharedStrings[intval((string)$cell->v)] ?? '';
            } elseif ($type === 'inlineStr') {
                $value = (string)$cell->is->t;
            } else {
                $value = (string)($cell->v ?? '');
            }

            $rowData[$colIndex] = $value;
        }

        if (!empty(array_filter($rowData, fn($value) => $value !== ''))) {
            $rows[] = $rowData;
        }
    }

    return $rows;
}

function parseXls($filepath) {
    $scriptPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'scripts' . DIRECTORY_SEPARATOR . 'convert_xls_to_csv.py';
    if (!is_file($scriptPath)) {
        sendError('XLS parser script not found at ' . $scriptPath, 500);
    }

    $escapedFilepath = escapeshellarg($filepath);
    $escapedScript = escapeshellarg($scriptPath);

    // `python` is not on PATH everywhere (Windows ships `py`; some hosts only
    // expose `python3`).  Only accept an actual CSV result: Windows' App
    // Execution Alias can print a non-empty "Python was not found" message,
    // which must not stop us trying the next interpreter.
    $output = null;
    $converterError = null;
    $attempted = [];

    // Prefer a specifically configured interpreter, then discover normal
    // Windows Python installations.  This lets XAMPP convert .xls files even
    // when Windows' `python` command is only the Microsoft Store alias.
    $pythonBinaries = [];
    $configuredPython = trim((string)getenv('ATTENDANCE_IMPORT_PYTHON'));
    if ($configuredPython !== '' && is_file($configuredPython)) {
        $pythonBinaries[] = $configuredPython;
    }
    if (PHP_OS_FAMILY === 'Windows') {
        $discoveryPatterns = [
            'C:\\Users\\*\\AppData\\Local\\Programs\\Python\\Python*\\python.exe',
            'C:\\Program Files\\Python*\\python.exe',
            // Some local development installations include a Python runtime.
            'C:\\Program Files\\Unity\\Hub\\Editor\\*\\Editor\\Data\\PlaybackEngines\\WebGLSupport\\BuildTools\\Emscripten\\python\\python.exe',
        ];
        foreach ($discoveryPatterns as $pattern) {
            foreach (glob($pattern) ?: [] as $candidate) {
                if (is_file($candidate) && !in_array($candidate, $pythonBinaries, true)) {
                    $pythonBinaries[] = $candidate;
                }
            }
        }
    }
    foreach (['python', 'py', 'python3'] as $binary) {
        if (!in_array($binary, $pythonBinaries, true)) {
            $pythonBinaries[] = $binary;
        }
    }

    foreach ($pythonBinaries as $binary) {
        $attempted[] = $binary;
        $escapedBinary = escapeshellarg($binary);
        $candidate = @shell_exec("$escapedBinary $escapedScript $escapedFilepath 2>&1");
        if (!is_string($candidate) || trim($candidate) === '') {
            continue;
        }

        $firstCandidateLine = strtok($candidate, "\n");
        if (is_string($firstCandidateLine) && str_starts_with(trim($firstCandidateLine), 'EmployeeID,')) {
            $output = $candidate;
            break;
        }

        $decodedCandidate = is_string($firstCandidateLine) ? json_decode($firstCandidateLine, true) : null;
        if (is_array($decodedCandidate) && isset($decodedCandidate['error'])) {
            $converterError = (string)$decodedCandidate['error'];
        }
    }
    if ($output === null) {
        if ($converterError !== null) {
            sendError('XLS conversion failed: ' . $converterError, 400);
        }
        sendError(
            'Failed to execute the XLS converter. Make sure Python is installed and shell_exec is enabled. Tried: '
            . implode(', ', $attempted) . '.',
            500
        );
    }

    $firstLine = strtok($output, "\n");
    if ($firstLine !== false) {
        $decoded = json_decode($firstLine, true);
        if (is_array($decoded) && isset($decoded['error'])) {
            sendError('XLS conversion failed: ' . $decoded['error'], 400);
        }
    }

    return $output;
}

function readSpreadsheetEntry($filepath, $entryName) {
    if (class_exists('ZipArchive')) {
        $zip = new ZipArchive();
        if ($zip->open($filepath) === true) {
            $content = $zip->getFromName($entryName);
            $zip->close();
            if ($content !== false) {
                return $content;
            }
        }
    }

    $resolvedPath = realpath($filepath) ?: $filepath;
    $resolvedPath = str_replace('\\', '/', $resolvedPath);
    $content = @file_get_contents('phar://' . $resolvedPath . '/' . ltrim($entryName, '/'));
    return $content !== false ? $content : false;
}

function columnLetterToIndex($letters) {
    $index = 0;
    $letters = strtoupper($letters);
    for ($i = 0; $i < strlen($letters); $i++) {
        $index = ($index * 26) + (ord($letters[$i]) - ord('A') + 1);
    }
    return $index - 1;
}

function generateCsvTemplate() {
    $handle = fopen('php://temp', 'r+');
    if ($handle === false) {
        sendError('Failed to build the CSV template.', 500);
    }
    fputcsv($handle, ATTENDANCE_IMPORT_TEMPLATE_HEADERS);
    rewind($handle);
    $csv = stream_get_contents($handle);
    fclose($handle);
    return $csv === false ? '' : (string)$csv;
}

function generateXlsxTemplate($filepath) {
    $headers = ATTENDANCE_IMPORT_TEMPLATE_HEADERS;
    $columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

    $sharedStringsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' . count($headers) . '" uniqueCount="' . count($headers) . '">';
    foreach ($headers as $header) {
        $sharedStringsXml .= '<si><t>' . htmlspecialchars($header, ENT_XML1) . '</t></si>';
    }
    $sharedStringsXml .= '</sst>';

    $sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        . '<cols>'
        . '<col min="1" max="1" width="14" bestFit="1" customWidth="1"/>'
        . '<col min="2" max="4" width="20" bestFit="1" customWidth="1"/>'
        . '<col min="5" max="9" width="16" bestFit="1" customWidth="1"/>'
        . '</cols>'
        . '<sheetData>'
        . '<row r="1">';
    foreach ($columns as $index => $column) {
        $sheetXml .= '<c r="' . $column . '1" t="s" s="1"><v>' . $index . '</v></c>';
    }
    $sheetXml .= '</row></sheetData></worksheet>';

    $entries = [
        '[Content_Types].xml' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            . '<Default Extension="xml" ContentType="application/xml"/>'
            . '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            . '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            . '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            . '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            . '</Types>',
        '_rels/.rels' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            . '</Relationships>',
        'xl/_rels/workbook.xml.rels' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            . '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            . '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            . '</Relationships>',
        'xl/workbook.xml' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            . '<sheets><sheet name="Attendance" sheetId="1" r:id="rId1"/></sheets>'
            . '</workbook>',
        'xl/styles.xml' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            . '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            . '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill></fills>'
            . '<borders count="1"><border/></borders>'
            . '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
            . '<cellXfs count="2"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/></cellXfs>'
            . '</styleSheet>',
        'xl/sharedStrings.xml' => $sharedStringsXml,
        'xl/worksheets/sheet1.xml' => $sheetXml,
    ];

    if (file_put_contents($filepath, buildZipArchive($entries)) === false) {
        sendError('Failed to create template file', 500);
    }
}

function buildZipArchive($entries) {
    $files = '';
    $centralDirectory = '';
    $offset = 0;
    [$dosTime, $dosDate] = getZipDosDateTime();

    foreach ($entries as $name => $content) {
        $name = str_replace('\\', '/', ltrim((string)$name, '/'));
        $content = (string)$content;
        $size = strlen($content);
        $crc = crc32($content);
        if ($crc < 0) {
            $crc += 4294967296;
        }

        $localHeader = pack(
            'VvvvvvVVVvv',
            0x04034b50,
            20,
            0,
            0,
            $dosTime,
            $dosDate,
            $crc,
            $size,
            $size,
            strlen($name),
            0
        ) . $name;

        $fileRecord = $localHeader . $content;
        $files .= $fileRecord;

        $centralDirectory .= pack(
            'VvvvvvvVVVvvvvvVV',
            0x02014b50,
            20,
            20,
            0,
            0,
            $dosTime,
            $dosDate,
            $crc,
            $size,
            $size,
            strlen($name),
            0,
            0,
            0,
            0,
            0,
            $offset
        ) . $name;

        $offset += strlen($fileRecord);
    }

    $endOfCentralDirectory = pack(
        'VvvvvVVv',
        0x06054b50,
        0,
        0,
        count($entries),
        count($entries),
        strlen($centralDirectory),
        strlen($files),
        0
    );

    return $files . $centralDirectory . $endOfCentralDirectory;
}

function getZipDosDateTime() {
    $date = getdate();
    $year = max(1980, intval($date['year']));
    $dosTime = ($date['hours'] << 11) | ($date['minutes'] << 5) | intdiv(intval($date['seconds']), 2);
    $dosDate = (($year - 1980) << 9) | ($date['mon'] << 5) | $date['mday'];
    return [$dosTime, $dosDate];
}

closeDBConnection($conn);
