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
require_once 'attendance_identity.php';

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
            $getAction = $_GET['action'] ?? '';
            if ($getAction === 'template') handleGetTemplate();
            elseif ($getAction === 'batch') handleGetReviewBatch($conn);
            else sendError('Invalid action.', 400);
            break;
        case 'POST':
            requireMinRole('manager');
            $importAction = $_GET['action'] ?? 'import';
            if ($importAction === 'import_init') handleImportInit($conn);
            elseif ($importAction === 'import_chunk') handleImportChunk($conn);
            elseif ($importAction === 'import_complete') handleImportComplete($conn);
            elseif ($importAction === 'import_abort') handleImportAbort($conn);
            elseif ($importAction === 'resolve_row') {
                requireMinRole('admin');
                handleResolveReviewRow($conn);
            }
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

/** Normalize spreadsheet header labels so spaces, underscores, and punctuation do not affect matching. */
function normalizeAttendanceHeader($value) {
    $header = strtolower(trim((string)$value));
    $header = preg_replace('/^\xEF\xBB\xBF/', '', $header) ?? $header;
    return preg_replace('/[^a-z0-9]/', '', $header) ?? $header;
}

/** Convert a ZKTeco Statistical Report table into the attendance template shape. */
function convertZktecoStatisticalReportRows($rows) {
    if (!is_array($rows) || count($rows) < 5) return null;

    $headerIndex = null;
    $headers = [];
    foreach ($rows as $rowIndex => $row) {
        $normalized = array_map('normalizeAttendanceHeader', $row);
        $hasAttDays = false;
        foreach ($normalized as $label) {
            if (str_starts_with($label, 'attdays')) {
                $hasAttDays = true;
                break;
            }
        }
        if (in_array('id', $normalized, true)
            && in_array('name', $normalized, true)
            && in_array('late', $normalized, true)
            && in_array('overtimehour', $normalized, true)
            && in_array('absentday', $normalized, true)
            && $hasAttDays) {
            $headerIndex = $rowIndex;
            $headers = $normalized;
            break;
        }
    }
    if ($headerIndex === null) return null;

    $subHeaders = array_map('normalizeAttendanceHeader', $rows[$headerIndex + 1] ?? []);
    $idColumn = array_search('id', $headers, true);
    $nameColumn = array_search('name', $headers, true);
    $attDaysColumn = null;
    $absentDaysColumn = array_search('absentday', $headers, true);
    $lateMinutesColumn = null;
    $overtimeColumns = [];

    foreach ($headers as $columnIndex => $label) {
        if (str_starts_with($label, 'attdays')) $attDaysColumn = $columnIndex;
        if ($label === 'late' && ($subHeaders[$columnIndex + 1] ?? '') === 'min') {
            $lateMinutesColumn = $columnIndex + 1;
        }
        if ($label === 'overtimehour') {
            $subLabel = $subHeaders[$columnIndex] ?? '';
            if (in_array($subLabel, ['workday', 'holiday'], true)) {
                $overtimeColumns[] = $columnIndex;
            }
            if (($subHeaders[$columnIndex + 1] ?? '') === 'holiday') {
                $overtimeColumns[] = $columnIndex + 1;
            }
        }
    }

    if ($idColumn === false || $nameColumn === false || $attDaysColumn === null
        || $absentDaysColumn === false || $lateMinutesColumn === null) {
        return null;
    }

    $converted = [ATTENDANCE_IMPORT_TEMPLATE_HEADERS];
    for ($rowIndex = $headerIndex + 2; $rowIndex < count($rows); $rowIndex++) {
        $row = $rows[$rowIndex];
        $employeeId = trim((string)($row[$idColumn] ?? ''));
        $employeeName = trim((string)($row[$nameColumn] ?? ''));
        if ($employeeId === '' || $employeeName === '') continue;

        // Att. Days is reported as scheduled/actual (for example, 10/9).
        // Payroll should use the actual days worked, the value after the slash.
        $attendanceDays = trim((string)($row[$attDaysColumn] ?? '0'));
        if (preg_match('/^\s*\d+(?:\.\d+)?\s*\/\s*(\d+(?:\.\d+)?)/', $attendanceDays, $matches)) {
            $daysWorked = $matches[1];
        } else {
            $daysWorked = $attendanceDays;
        }

        $overtimeHours = 0.0;
        foreach ($overtimeColumns as $columnIndex) {
            $value = trim((string)($row[$columnIndex] ?? '0'));
            if (preg_match('/^(\d+(?:\.\d+)?)\s*:\s*(\d{1,2})$/', $value, $matches)) {
                $overtimeHours += (float)$matches[1] + ((float)$matches[2] / 60);
            } elseif (is_numeric($value)) {
                $overtimeHours += (float)$value;
            }
        }

        $converted[] = [
            $employeeId,
            $employeeName,
            '',
            '',
            $daysWorked,
            (string)$overtimeHours,
            trim((string)($row[$lateMinutesColumn] ?? '0')),
            trim((string)($row[$absentDaysColumn] ?? '0')),
            '0',
        ];
    }

    return count($converted) > 1 ? $converted : null;
}

/** Convert ZKTeco Card Report's multi-row, side-by-side employee totals into the attendance template shape. */
function convertZktecoCardReportRows($rows) {
    if (!is_array($rows) || count($rows) < 4) return null;

    $headerIndex = null;
    $employeeBlocks = [];
    foreach ($rows as $rowIndex => $row) {
        $normalized = array_map('normalizeAttendanceHeader', $row);
        $absentColumns = [];
        foreach ($normalized as $columnIndex => $label) {
            if ($label === 'absentday') $absentColumns[] = $columnIndex;
        }
        if ($absentColumns && in_array('ondutyday', $normalized, true)
            && in_array('overtimeh', $normalized, true) && in_array('late', $normalized, true)) {
            $headerIndex = $rowIndex;
            $employeeBlocks = $absentColumns;
            break;
        }
    }
    if ($headerIndex === null || $headerIndex < 1) return null;

    // In this report the line after the attendance labels contains units, and
    // the following line contains each employee's period total.
    $summaryRow = $rows[$headerIndex + 2] ?? null;
    if (!is_array($summaryRow)) return null;

    $nameRowIndex = null;
    $idHeaderIndex = null;
    for ($rowIndex = $headerIndex - 1; $rowIndex >= 0; $rowIndex--) {
        $labels = array_map('normalizeAttendanceHeader', $rows[$rowIndex]);
        if ($nameRowIndex === null && in_array('name', $labels, true)) $nameRowIndex = $rowIndex;
        if ($idHeaderIndex === null && in_array('id', $labels, true)) $idHeaderIndex = $rowIndex;
        if ($nameRowIndex !== null && $idHeaderIndex !== null) break;
    }
    if ($nameRowIndex === null || $idHeaderIndex === null) return null;

    $nameRow = $rows[$nameRowIndex];
    $idHeaderRow = $rows[$idHeaderIndex];
    $normalizedIds = array_map('normalizeAttendanceHeader', $idHeaderRow);
    $converted = [ATTENDANCE_IMPORT_TEMPLATE_HEADERS];

    foreach ($employeeBlocks as $blockIndex => $blockStart) {
        $blockEnd = $employeeBlocks[$blockIndex + 1] ?? count($summaryRow);
        $idColumn = null;
        for ($columnIndex = $blockStart; $columnIndex < $blockEnd; $columnIndex++) {
            if (($normalizedIds[$columnIndex] ?? '') === 'id') {
                $idColumn = $columnIndex;
                break;
            }
        }

        $nameColumn = null;
        for ($columnIndex = $blockStart; $columnIndex < $blockEnd; $columnIndex++) {
            if ((normalizeAttendanceHeader($nameRow[$columnIndex] ?? '') === 'name')
                && trim((string)($nameRow[$columnIndex + 1] ?? '')) !== '') {
                $nameColumn = $columnIndex + 1;
                break;
            }
        }

        if ($idColumn === null) continue;
        // Card Reports place the employee ID beside the "ID" label in the
        // identity row; the summary row only contains attendance totals.
        $employeeId = trim((string)($idHeaderRow[$idColumn + 1] ?? ''));
        if ($employeeId === '') continue;

        // Card Report columns are: Absent, AFL, Out, blank, On-duty,
        // OT Workday, blank, OT Holiday, Late Times, Late Minutes, ...
        // The blank spacer columns are part of the export and must be counted.
        $daysWorked = trim((string)($summaryRow[$blockStart + 4] ?? '0'));
        $overtimeValues = [
            $summaryRow[$blockStart + 5] ?? '0',
            $summaryRow[$blockStart + 7] ?? '0',
        ];
        $overtimeHours = 0.0;
        foreach ($overtimeValues as $overtimeValue) {
            $overtimeValue = trim((string)$overtimeValue);
            if (preg_match('/^(\d+(?:\.\d+)?)\s*:\s*(\d{1,2})$/', $overtimeValue, $timeParts)) {
                $overtimeHours += (float)$timeParts[1] + ((float)$timeParts[2] / 60);
            } elseif (is_numeric($overtimeValue)) {
                $overtimeHours += (float)$overtimeValue;
            }
        }
        $lateMinutes = trim((string)($summaryRow[$blockStart + 9] ?? '0'));

        $converted[] = [
            $employeeId,
            $nameColumn === null ? '' : trim((string)($nameRow[$nameColumn] ?? '')),
            '',
            '',
            $daysWorked,
            (string)$overtimeHours,
            $lateMinutes,
            trim((string)($summaryRow[$blockStart] ?? '0')),
            '0',
        ];
    }

    return count($converted) > 1 ? $converted : null;
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
            if (!isset($byDateId[$dateIdKey])) $byDateId[$dateIdKey] = [];
            $byDateId[$dateIdKey][] = $employee;
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
    $externalCodeKey = normalizeIdentityKey($externalEmployeeCode);
    $externalNameKey = normalizeIdentityKey($externalEmployeeName);

    if ($externalCodeKey === '' || $externalNameKey === '') {
        return [
            'ok' => false,
            'message' => 'This attendance row needs both an EmployeeID and EmployeeName to match an existing employee.',
        ];
    }

    // The exact, unique employee name is authoritative when device IDs differ
    // from the IDs stored in the employee profile. This supports changed IDs
    // while still ensuring that the row maps only to an existing employee.
    $uniqueNameMatches = $employeeDirectory['by_name'][$externalNameKey] ?? [];
    $idMatches = $employeeDirectory['by_date_id'][$externalCodeKey] ?? [];
    if (count($uniqueNameMatches) === 1) {
        $employee = $uniqueNameMatches[0];
        $idMatchesSameEmployee = count($idMatches) === 1
            && intval($idMatches[0]['employee_id'] ?? 0) === intval($employee['employee_id'] ?? 0);
        return buildResolvedEmployeeMatch(
            $employee,
            $idMatchesSameEmployee ? 'employee_date_id_match' : 'smart_name_match',
            $idMatchesSameEmployee ? 'Biometric ID and employee name matched' : 'Exact employee name matched; attendance ID differs',
            $idMatchesSameEmployee ? 1.0 : 0.96,
            $idMatchesSameEmployee
                ? ['EmployeeID and EmployeeName matched the same employee record']
                : ['File EmployeeName uniquely matched an existing employee; file EmployeeID ' . $externalEmployeeCode . ' was not used as the employee identity']
        );
    }

    if (count($idMatches) > 1) {
        return ['ok' => false, 'message' => 'The EmployeeID is assigned to multiple employees, and the name does not uniquely match an existing employee. This row was skipped.'];
    }

    return [
        'ok' => false,
        'message' => 'The uploaded EmployeeName does not uniquely match an existing employee. This row was skipped, even though its EmployeeID is present.',
    ];
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

function fetchAttendanceSourceMappings($conn, $sourceSystem) {
    $byCode = [];
    $stmt = $conn->prepare(
        "SELECT external_code_key, external_employee_code, external_employee_name, employee_id, match_method
         FROM attendance_employee_source_map WHERE source_system = ?"
    );
    if (!$stmt) throw new RuntimeException('Failed to load saved attendance source-ID mappings.');
    $stmt->bind_param('s', $sourceSystem);
    $stmt->execute();
    $result = $stmt->get_result();
    while ($result && ($row = $result->fetch_assoc())) {
        $key = attendanceNormalizeSourceEmployeeCode($row['external_code_key'] ?? '');
        if ($key !== '') $byCode[$key][] = $row;
    }
    $stmt->close();
    return $byCode;
}

/** Save an automatic match without ever replacing a conflicting confirmed mapping. */
function saveAttendanceSourceMapping($conn, $sourceSystem, $externalCode, $externalName, $employeeId, $matchMethod, $confirmedBy = null) {
    $externalCode = normalizeIdentityValue($externalCode);
    $codeKey = attendanceNormalizeSourceEmployeeCode($externalCode);
    if ($codeKey === '') return true;

    $insert = $conn->prepare(
        "INSERT IGNORE INTO attendance_employee_source_map
            (source_system, external_code_key, external_employee_code, external_employee_name, employee_id, match_method, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    if (!$insert) return false;
    $insert->bind_param('ssssisi', $sourceSystem, $codeKey, $externalCode, $externalName, $employeeId, $matchMethod, $confirmedBy);
    $insert->execute();
    $insert->close();

    $check = $conn->prepare(
        "SELECT employee_id FROM attendance_employee_source_map WHERE source_system = ? AND external_code_key = ? LIMIT 1"
    );
    if (!$check) return false;
    $check->bind_param('ss', $sourceSystem, $codeKey);
    $check->execute();
    $result = $check->get_result();
    $row = $result ? $result->fetch_assoc() : null;
    $check->close();
    return $row && intval($row['employee_id'] ?? 0) === intval($employeeId);
}

function storeAttendanceReviewItem($conn, $batchId, $rowNumber, $sourceSystem, $fileName, $payPeriodStart, $payPeriodEnd, $code, $name, $role, $branch, $daysWorked, $overtimeHours, $lateMinutes, $absentDays, $leaveDays, $errorMessage) {
    $stmt = $conn->prepare(
        "INSERT INTO attendance_import_review_items
            (batch_id, row_number, source_system, original_filename, pay_period_start, pay_period_end,
             external_employee_code, external_employee_name, external_role, external_branch,
             days_worked, overtime_hours, late_minutes, absent_days, leave_days, status, error_message, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)"
    );
    if (!$stmt) throw new RuntimeException('Failed to save the unmatched attendance row for review.');
    $userId = attendanceImportUserId();
    $stmt->bind_param(
        'sissssssssddiddsi',
        $batchId, $rowNumber, $sourceSystem, $fileName, $payPeriodStart, $payPeriodEnd,
        $code, $name, $role, $branch, $daysWorked, $overtimeHours, $lateMinutes,
        $absentDays, $leaveDays, $errorMessage, $userId
    );
    if (!$stmt->execute()) {
        $stmt->close();
        throw new RuntimeException('Failed to save the unmatched attendance row for review.');
    }
    $id = intval($stmt->insert_id);
    $stmt->close();
    return $id;
}

function handleGetReviewBatch($conn) {
    $batchId = trim((string)($_GET['id'] ?? ''));
    if ($batchId === '') sendError('An attendance import batch ID is required.', 400);
    $stmt = $conn->prepare(
        "SELECT i.*, CONCAT(e.first_name, ' ', e.last_name) AS matched_employee_name
         FROM attendance_import_review_items i
         LEFT JOIN employees e ON e.employee_id = i.matched_employee_id
         WHERE i.batch_id = ? ORDER BY i.row_number ASC, i.item_id ASC"
    );
    if (!$stmt) sendError('Failed to load attendance review rows.', 500);
    $stmt->bind_param('s', $batchId);
    $stmt->execute();
    $result = $stmt->get_result();
    $items = [];
    while ($result && ($row = $result->fetch_assoc())) $items[] = $row;
    $stmt->close();
    if (!$items) sendError('No attendance rows are awaiting review for this batch.', 404);

    $pending = count(array_filter($items, static fn($item) => ($item['status'] ?? '') === 'pending_review'));
    $processed = count(array_filter($items, static fn($item) => ($item['status'] ?? '') === 'processed'));
    $employees = [];
    $employeeResult = $conn->query(
        "SELECT employee_id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name"
    );
    while ($employeeResult && ($employee = $employeeResult->fetch_assoc())) {
        $employees[] = [
            'employee_id' => intval($employee['employee_id']),
            'name' => trim((string)$employee['first_name'] . ' ' . (string)$employee['last_name']),
        ];
    }
    if ($employeeResult) $employeeResult->close();

    $first = $items[0];
    sendResponse(true, [
        'batch' => [
            'batch_id' => $batchId,
            'source_system' => $first['source_system'],
            'original_filename' => $first['original_filename'],
            'pay_period_start' => $first['pay_period_start'],
            'pay_period_end' => $first['pay_period_end'],
            'status' => $pending > 0 ? 'pending_review' : 'processed',
            'records_parsed' => count($items),
            'records_ready' => $pending,
            'records_skipped' => count($items) - $pending - $processed,
            'records_processed' => $processed,
            'records_failed' => count(array_filter($items, static fn($item) => ($item['status'] ?? '') === 'failed')),
            'created_at' => $first['created_at'],
        ],
        'items' => $items,
        'employees' => $employees,
    ]);
}

function handleResolveReviewRow($conn) {
    $payload = json_decode((string)file_get_contents('php://input'), true);
    $itemId = intval($payload['item_id'] ?? 0);
    $employeeId = intval($payload['employee_id'] ?? 0);
    if ($itemId <= 0 || $employeeId <= 0) sendError('Select an existing employee to resolve this row.', 400);

    $stmt = $conn->prepare(
        "SELECT * FROM attendance_import_review_items WHERE item_id = ? LIMIT 1"
    );
    if (!$stmt) sendError('Failed to load the attendance review row.', 500);
    $stmt->bind_param('i', $itemId);
    $stmt->execute();
    $result = $stmt->get_result();
    $item = $result ? $result->fetch_assoc() : null;
    $stmt->close();
    if (!$item) sendError('Attendance review row not found.', 404);
    if (($item['status'] ?? '') !== 'pending_review') sendError('This row has already been resolved or processed.', 409);

    $employeeStmt = $conn->prepare(
        "SELECT employee_id, first_name, last_name FROM employees WHERE employee_id = ? AND status = 'active' LIMIT 1"
    );
    if (!$employeeStmt) sendError('Failed to validate the selected employee.', 500);
    $employeeStmt->bind_param('i', $employeeId);
    $employeeStmt->execute();
    $employeeResult = $employeeStmt->get_result();
    $employee = $employeeResult ? $employeeResult->fetch_assoc() : null;
    $employeeStmt->close();
    if (!$employee) sendError('Choose an active registered employee. No employee account was created.', 400);

    $sourceSystem = normalizeImportSourceSystem($item['source_system'] ?? '');
    $externalCode = normalizeIdentityValue($item['external_employee_code'] ?? '');
    $employeeName = trim((string)$employee['first_name'] . ' ' . (string)$employee['last_name']);
    if (!saveAttendanceSourceMapping($conn, $sourceSystem, $externalCode, (string)($item['external_employee_name'] ?? ''), $employeeId, 'manual_review', attendanceImportUserId())) {
        // An explicit admin selection may correct a previous source mapping.
        $mapStmt = $conn->prepare(
            "INSERT INTO attendance_employee_source_map
                (source_system, external_code_key, external_employee_code, external_employee_name, employee_id, match_method, confirmed_by)
             VALUES (?, ?, ?, ?, ?, 'manual_review', ?)
             ON DUPLICATE KEY UPDATE external_employee_code = VALUES(external_employee_code),
                 external_employee_name = VALUES(external_employee_name), employee_id = VALUES(employee_id),
                 match_method = 'manual_review', confirmed_by = VALUES(confirmed_by)"
        );
        if (!$mapStmt) sendError('Failed to save the confirmed source-ID mapping.', 500);
        $codeKey = attendanceNormalizeSourceEmployeeCode($externalCode);
        $reviewerId = attendanceImportUserId();
        $mapStmt->bind_param('ssssii', $sourceSystem, $codeKey, $externalCode, $item['external_employee_name'], $employeeId, $reviewerId);
        $mapStmt->execute();
        $mapStmt->close();
    }

    $tempPath = tempnam(sys_get_temp_dir(), 'attendance_review_');
    if ($tempPath === false) sendError('Could not prepare the reviewed attendance row.', 500);
    $csv = fopen($tempPath, 'wb');
    if (!$csv) {
        @unlink($tempPath);
        sendError('Could not prepare the reviewed attendance row.', 500);
    }
    fputcsv($csv, ATTENDANCE_IMPORT_TEMPLATE_HEADERS);
    fputcsv($csv, [
        $externalCode,
        $employeeName,
        (string)($item['external_role'] ?? ''),
        (string)($item['external_branch'] ?? ''),
        (string)$item['days_worked'],
        (string)$item['overtime_hours'],
        (string)$item['late_minutes'],
        (string)$item['absent_days'],
        (string)$item['leave_days'],
    ]);
    fclose($csv);
    register_shutdown_function(static function () use ($tempPath) { @unlink($tempPath); });

    $GLOBALS['attendanceImportReviewContext'] = [
        'batch_id' => (string)$item['batch_id'],
        'item_id' => $itemId,
        'employee_id' => $employeeId,
    ];
    $_FILES['file'] = [
        'name' => 'reviewed_attendance.csv',
        'type' => 'text/csv',
        'tmp_name' => $tempPath,
        'error' => UPLOAD_ERR_OK,
        'size' => filesize($tempPath),
    ];
    $_POST['pay_period_start'] = (string)$item['pay_period_start'];
    $_POST['pay_period_end'] = (string)$item['pay_period_end'];
    $_POST['source_system'] = $sourceSystem;
    handleImport($conn);
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
    if (in_array($ext, ['csv', 'xls', 'xlsx'], true)) {
        $statisticalReportRows = convertZktecoStatisticalReportRows($rows);
        if ($statisticalReportRows !== null) {
            $rows = $statisticalReportRows;
            $sourceSystem = 'zkteco';
        } else {
            $cardReportRows = convertZktecoCardReportRows($rows);
            if ($cardReportRows !== null) {
                $rows = $cardReportRows;
                $sourceSystem = 'zkteco';
            }
        }
    }
    if (empty($rows)) {
        sendError('The uploaded file contains no data rows', 400);
    }

    $headers = array_map('normalizeAttendanceHeader', $rows[0]);
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
    $reviewContext = $GLOBALS['attendanceImportReviewContext'] ?? null;
    $batchId = is_array($reviewContext) && !empty($reviewContext['batch_id'])
        ? (string)$reviewContext['batch_id']
        : 'ATT-' . date('Ymd-His') . '-' . substr(uniqid(), -5);
    $created = 0;
    $updated = 0;
    $skipped = 0;
    $reviewPending = 0;
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
    $updatedDetails = [];
    $skippedDetails = [];
    $identityDetails = [
        'matched_via_biometric_id' => [],
        'matched_via_saved_source_id' => [],
        'matched_via_base44' => [],
        'matched_via_smart_name' => [],
        'unresolved' => [],
    ];
    $identitySummary = [
        'source_system' => $sourceSystem,
        'matched_via_biometric_id' => 0,
        'matched_via_saved_source_id' => 0,
        'matched_via_base44' => 0,
        'matched_via_smart_name' => 0,
        'unresolved' => 0,
    ];

    $employeeDirectory = fetchAttendanceImportEmployeeDirectory($conn);
    $base44Mappings = fetchBase44IdentityMappings($sourceSystem);
    $sourceMappings = fetchAttendanceSourceMappings($conn, $sourceSystem);
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
            $message = 'This row has no employee ID or name to identify an existing employee.';
            $errorsList[] = "Row $rowNum: $message";
            $reviewItemId = storeAttendanceReviewItem($conn, $batchId, $rowNum, $sourceSystem, (string)$file['name'], $payPeriodStart, $payPeriodEnd, '', '', $externalRole, $externalBranch, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $message);
            $reviewPending++;
            $missingEntry = importDetailEntry($rowNum, '', '', 'pending_review', $message);
            $missingEntry['review_item_id'] = $reviewItemId;
            $skippedDetails[] = $missingEntry;
            $identityDetails['unresolved'][] = $missingEntry;
            continue;
        }

        $resolution = attendanceResolveImportedEmployee(
            $employeeDirectory,
            $base44Mappings,
            $sourceMappings,
            $externalEmployeeCode,
            $externalEmployeeName
        );

        if (empty($resolution['ok'])) {
            $skipped++;
            $identitySummary['unresolved']++;
            $errorMessage = trim((string)($resolution['message'] ?? 'Failed to resolve employee identity.'));
            // Recorded per row (the console list below stays de-duplicated).
            $unresolvedEntry = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName, 'unresolved', $errorMessage);
            $reviewItemId = storeAttendanceReviewItem($conn, $batchId, $rowNum, $sourceSystem, (string)$file['name'], $payPeriodStart, $payPeriodEnd, $externalEmployeeCode, $externalEmployeeName, $externalRole, $externalBranch, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $errorMessage);
            $unresolvedEntry['review_item_id'] = $reviewItemId;
            $reviewPending++;
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
            $message = 'Resolved employee identity was invalid';
            $reviewItemId = storeAttendanceReviewItem($conn, $batchId, $rowNum, $sourceSystem, (string)$file['name'], $payPeriodStart, $payPeriodEnd, $externalEmployeeCode, $externalEmployeeName, $externalRole, $externalBranch, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $message);
            $reviewPending++;
            $invalidEntry = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName, 'pending_review', $message);
            $invalidEntry['review_item_id'] = $reviewItemId;
            $skippedDetails[] = $invalidEntry;
            $identityDetails['unresolved'][] = $invalidEntry;
            continue;
        }

        if (!saveAttendanceSourceMapping($conn, $sourceSystem, $externalEmployeeCode, $externalEmployeeName, $employeeId, (string)($resolution['method'] ?? 'name_match'))) {
            $skipped++;
            $identitySummary['unresolved']++;
            $message = 'This source ID is already saved for a different employee. Review the mapping before importing.';
            $reviewItemId = storeAttendanceReviewItem($conn, $batchId, $rowNum, $sourceSystem, (string)$file['name'], $payPeriodStart, $payPeriodEnd, $externalEmployeeCode, $externalEmployeeName, $externalRole, $externalBranch, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $message);
            $reviewPending++;
            $entry = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName, 'pending_review', $message);
            $entry['review_item_id'] = $reviewItemId;
            $skippedDetails[] = $entry;
            $identityDetails['unresolved'][] = $entry;
            $errorsList[] = 'Row ' . $rowNum . ': ' . $message;
            continue;
        }
        $sourceCodeKey = attendanceNormalizeSourceEmployeeCode($externalEmployeeCode);
        if ($sourceCodeKey !== '') {
            $sourceMappings[$sourceCodeKey] = [[
                'employee_id' => $employeeId,
                'match_method' => (string)($resolution['method'] ?? 'name_match'),
            ]];
        }

        // Keep the import non-blocking while the company completes legacy
        // employee files. The import result tells the payroll administrator
        // exactly who needs attention before the payslip is released.
        $missingPayrollRequirements = getPayrollEligibilityMissingItems($employee);
        if (!empty($missingPayrollRequirements)) {
            $incompletePayrollEmployees[$employeeId] = $employee['name'];
        }

        $sourceNameForDetails = $externalEmployeeName !== '' ? $externalEmployeeName : $employee['name'];
        if (($resolution['method'] ?? '') === 'employee_date_id_match') {
            $identitySummary['matched_via_biometric_id']++;
            $identityDetails['matched_via_biometric_id'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $sourceNameForDetails,
                'matched_via_biometric_id',
                'File name: ' . ($externalEmployeeName !== '' ? $externalEmployeeName : '(not provided)') . '; matched registered employee "' . $employee['name'] . '" (#' . $employeeId . ') by exact ZKTeco Employee ID.',
                $employeeId
            );
        } elseif (($resolution['method'] ?? '') === 'source_id_mapping') {
            $identitySummary['matched_via_saved_source_id']++;
            $identityDetails['matched_via_saved_source_id'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $sourceNameForDetails,
                'matched_via_saved_source_id',
                'Saved source ID ' . $externalEmployeeCode . ' matched registered employee "' . $employee['name'] . '" (#' . $employeeId . ').',
                $employeeId
            );
        } elseif (($resolution['method'] ?? '') === 'smart_name_match') {
            $identitySummary['matched_via_smart_name']++;
            $identityDetails['matched_via_smart_name'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $sourceNameForDetails,
                'matched_via_smart_name',
                'File EmployeeID "' . $externalEmployeeCode . '" was matched by the exact unique file name to existing employee "' . $employee['name'] . '" (#' . $employeeId . ').',
                $employeeId
            );
        } else {
            $identitySummary['matched_via_base44']++;
            $identityDetails['matched_via_base44'][] = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $sourceNameForDetails,
                'matched_via_base44',
                'File name: ' . ($externalEmployeeName !== '' ? $externalEmployeeName : '(not provided)') . '; matched registered employee "' . $employee['name'] . '" (#' . $employeeId . ') from the confirmed identity map.',
                $employeeId
            );
        }

        $duplicateStmt = $conn->prepare(
            "SELECT *
             FROM payroll
             WHERE employee_id = ? AND pay_period_start = ? AND pay_period_end = ?
             ORDER BY CASE WHEN LOWER(status) = 'draft' THEN 1 ELSE 0 END, id DESC
             LIMIT 1"
        );
        if (!$duplicateStmt) {
            throw new RuntimeException('Failed to validate duplicate payroll records.');
        }
        $duplicateStmt->bind_param('iss', $employeeId, $payPeriodStart, $payPeriodEnd);
        $duplicateStmt->execute();
        $duplicateResult = $duplicateStmt->get_result();
        $existingPayroll = $duplicateResult ? $duplicateResult->fetch_assoc() : null;
        $duplicateStmt->close();

        // A one-day difference in the selected period must not create a
        // second draft for the same employee over the same dates. Exact
        // period matches win; otherwise reuse a single overlapping record.
        // If several records overlap, stop and ask for review instead of
        // guessing which draft should be changed.
        if (!$existingPayroll) {
            $overlapStmt = $conn->prepare(
                "SELECT *
                 FROM payroll
                 WHERE employee_id = ? AND pay_period_start <= ? AND pay_period_end >= ?
                 ORDER BY CASE WHEN LOWER(status) = 'draft' THEN 1 ELSE 0 END, id DESC"
            );
            if (!$overlapStmt) {
                throw new RuntimeException('Failed to check overlapping payroll records.');
            }
            $overlapStmt->bind_param('iss', $employeeId, $payPeriodEnd, $payPeriodStart);
            $overlapStmt->execute();
            $overlapResult = $overlapStmt->get_result();
            $overlappingPayrolls = [];
            if ($overlapResult) {
                while ($overlapRow = $overlapResult->fetch_assoc()) {
                    $overlappingPayrolls[] = $overlapRow;
                }
            }
            $overlapStmt->close();

            if (count($overlappingPayrolls) === 1) {
                $existingPayroll = $overlappingPayrolls[0];
            } elseif (count($overlappingPayrolls) > 1) {
                $skipped++;
                $message = 'More than one payroll record overlaps this period. No record was changed; review the existing drafts to avoid duplicate pay.';
                $errorsList[] = 'Row ' . $rowNum . ': ' . $message;
                $skippedDetails[] = importDetailEntry(
                    $rowNum,
                    $externalEmployeeCode,
                    $externalEmployeeName !== '' ? $externalEmployeeName : $employee['name'],
                    'overlapping_payroll',
                    $message,
                    $employeeId
                );
                continue;
            }
        }

        $existingPayrollId = intval($existingPayroll['id'] ?? 0);
        if ($existingPayrollId > 0 && strtolower(trim((string)($existingPayroll['status'] ?? ''))) !== 'draft') {
            $skipped++;
            $duplicatePayrollEmployees[$employeeId] = true;
            $existingStatus = trim((string)($existingPayroll['status'] ?? 'finalized'));
            $existingStart = trim((string)($existingPayroll['pay_period_start'] ?? $payPeriodStart));
            $existingEnd = trim((string)($existingPayroll['pay_period_end'] ?? $payPeriodEnd));
            $skippedDetails[] = importDetailEntry($rowNum, $externalEmployeeCode, $externalEmployeeName !== '' ? $externalEmployeeName : $employee['name'], 'duplicate', 'Payroll #' . $existingPayrollId . ' already exists for ' . $existingStart . ' to ' . $existingEnd . ' with status "' . $existingStatus . '". It was left unchanged.', $employeeId, $existingPayrollId);
            continue;
        }

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

        $tax = floatval($existingPayroll['tax'] ?? 0);
        $sss = floatval($existingPayroll['sss_contribution'] ?? 0);
        $pagibig = floatval($existingPayroll['pagibig_contribution'] ?? 0);
        $philhealth = floatval($existingPayroll['philhealth_contribution'] ?? 0);
        $cashAdvance = floatval($existingPayroll['cash_advance_deduction'] ?? 0);
        $laptopLoan = floatval($existingPayroll['laptop_loan_deduction'] ?? 0);
        $otherDeductions = floatval($existingPayroll['other_deductions'] ?? 0);
        $bonus = floatval($existingPayroll['bonus'] ?? 0);
        $clothingAllowance = floatval($existingPayroll['clothing_allowance'] ?? 0);
        $travelAllowance = floatval($existingPayroll['travel_allowance'] ?? 0);
        $salaryAdjustment = floatval($existingPayroll['salary_adjustment'] ?? 0);

        // Auto-calculate government deductions from settings when available.
        // Deduction-type tables (SSS MSC, tax brackets) are MONTHLY bases,
        // so they always use the monthly salary — not the semi-monthly basic.
        $govEligibility = buildGovEligibilityFromEmployee($employee);
        $governmentMonthlyBase = $usesCompanyDailyRate ? ($companyDailyRate * 22) : $monthlySalary;
        if (!$existingPayroll) {
            $govDefaults = computeGovernmentDeductionsFromTypes($conn, floatval($governmentMonthlyBase), $govEligibility);
            if (isset($govDefaults['tax'])) $tax = $govDefaults['tax'];
            if (isset($govDefaults['sss_contribution'])) $sss = $govDefaults['sss_contribution'];
            if (isset($govDefaults['pagibig_contribution'])) $pagibig = $govDefaults['pagibig_contribution'];
            if (isset($govDefaults['philhealth_contribution'])) $philhealth = $govDefaults['philhealth_contribution'];
        }

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

        $attendanceOldStart = trim((string)($existingPayroll['pay_period_start'] ?? $payPeriodStart));
        $attendanceOldEnd = trim((string)($existingPayroll['pay_period_end'] ?? $payPeriodEnd));
        $attendanceLookup = $conn->prepare(
            "SELECT id FROM attendance_records
             WHERE employee_id = ? AND pay_period_start = ? AND pay_period_end = ?
             ORDER BY id DESC LIMIT 1"
        );
        if (!$attendanceLookup) throw new RuntimeException('Failed to check existing attendance records.');
        $attendanceLookup->bind_param('iss', $employeeId, $attendanceOldStart, $attendanceOldEnd);
        $attendanceLookup->execute();
        $attendanceLookupResult = $attendanceLookup->get_result();
        $existingAttendance = $attendanceLookupResult ? $attendanceLookupResult->fetch_assoc() : null;
        $attendanceLookup->close();
        $attendanceId = intval($existingAttendance['id'] ?? 0);
        $attendanceStmt = $attendanceId > 0
            ? $conn->prepare(
                "UPDATE attendance_records
                 SET pay_period_start = ?, pay_period_end = ?, days_worked = ?, overtime_hours = ?, late_minutes = ?, absent_days = ?, leave_days = ?, import_batch_id = ?
                 WHERE id = ?"
            )
            : $conn->prepare(
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
            if ($attendanceId > 0) {
                $attendanceStmt->bind_param('ssddiddsi', $payPeriodStart, $payPeriodEnd, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $batchId, $attendanceId);
            } else {
                $attendanceStmt->bind_param('issddidds', $employeeId, $payPeriodStart, $payPeriodEnd, $daysWorked, $otHours, $lateMinutes, $absentDays, $leaveDays, $batchId);
            }
            $attendanceStmt->execute();

            if ($existingPayrollId > 0) {
                $payrollUpdateStmt = $conn->prepare(
                    "UPDATE payroll SET employee_name = ?, pay_period_start = ?, pay_period_end = ?, basic_salary = ?, overtime_hours = ?, overtime_rate = ?, overtime_pay = ?,
                     late_deduction = ?, absence_deduction = ?, unpaid_leave_days = ?, unpaid_leave_amount = ?, total_deductions = ?,
                     gross_pay = ?, net_pay = ?, notes = ? WHERE id = ? AND LOWER(status) = 'draft'"
                );
                if (!$payrollUpdateStmt) throw new RuntimeException('Failed to prepare draft payroll update.');
                $payrollUpdateStmt->bind_param(
                    'sss' . str_repeat('d', 11) . 'si',
                    $employee['name'], $payPeriodStart, $payPeriodEnd, $basicSalary, $otHours, $otRate, $otPay, $lateDeduction, $absenceDeduction,
                    $leaveImpactDays, $leaveImpactAmount, $totalDeductions, $grossPay, $netPay, $importNote, $existingPayrollId
                );
                $payrollUpdateStmt->execute();
                $payrollUpdateStmt->close();
                $payrollId = $existingPayrollId;
            } else {
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
            }
            if ($payrollId > 0) {
                syncPayrollCashAdvanceRequests($conn, $payrollId);
            }

            $conn->commit();
            if ($existingPayrollId > 0) {
                $updated++;
                $duplicatePayrollEmployees[$employeeId] = true;
            } else {
                $created++;
            }
            if (is_array($reviewContext) && intval($reviewContext['item_id'] ?? 0) > 0) {
                $reviewUpdate = $conn->prepare(
                    "UPDATE attendance_import_review_items
                     SET status = 'processed', matched_employee_id = ?, created_payroll_id = ?, error_message = NULL,
                         reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
                     WHERE item_id = ? AND status = 'pending_review'"
                );
                if ($reviewUpdate) {
                    $reviewItemId = intval($reviewContext['item_id']);
                    $reviewerId = attendanceImportUserId();
                    $reviewUpdate->bind_param('iiii', $employeeId, $payrollId, $reviewerId, $reviewItemId);
                    $reviewUpdate->execute();
                    $reviewUpdate->close();
                }
            }
            $successDetail = importDetailEntry(
                $rowNum,
                $externalEmployeeCode,
                $externalEmployeeName !== '' ? $externalEmployeeName : $employee['name'],
                $existingPayrollId > 0 ? 'updated' : 'created',
                'Draft payroll #' . $payrollId . ' — net ' . number_format($netPay, 2) . ' for ' . $payPeriodStart . ' to ' . $payPeriodEnd,
                $employeeId,
                $payrollId
            );
            if ($existingPayrollId > 0) $updatedDetails[] = $successDetail;
            else $createdDetails[] = $successDetail;
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
            if ($updated > 0) {
                $warningsList[] = "$updated existing draft payroll record(s) were updated from the uploaded attendance. Finalized payroll records were left unchanged.";
            } elseif ($created === 0) {
                $warningsList[] = 'This attendance file was already imported for the selected pay period. No duplicate payroll records were created.';
            } else {
                $warningsList[] = "$duplicateCount existing payroll record(s) were skipped to prevent duplicate payments.";
            }
        }

    $pendingReviewStmt = $conn->prepare(
        "SELECT COUNT(*) AS pending_count
         FROM attendance_import_review_items
         WHERE batch_id = ? AND status = 'pending_review'"
    );
    if ($pendingReviewStmt) {
        $pendingReviewStmt->bind_param('s', $batchId);
        $pendingReviewStmt->execute();
        $pendingReviewResult = $pendingReviewStmt->get_result();
        $pendingReviewRow = $pendingReviewResult ? $pendingReviewResult->fetch_assoc() : null;
        $reviewPending = intval($pendingReviewRow['pending_count'] ?? $reviewPending);
        $pendingReviewStmt->close();
    }

        $userId = checkAuthentication();
        releaseSessionLock();
    if ($userId) {
        $payrollRecordLabel = $created === 1 ? 'draft payroll record' : 'draft payroll records';
        $activityDescription = "Attendance file imported; {$created} {$payrollRecordLabel} created and {$updated} draft payroll record(s) updated.";
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
                'records_updated' => $updated,
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
            'records_updated' => $updated,
            'records_skipped' => $skipped,
            'review_pending_count' => $reviewPending,
            'review_url' => $reviewPending > 0 ? '/payroll-import-review?batch_id=' . rawurlencode($batchId) : null,
            'errors' => $errorsList,
            'warnings' => $warningsList,
            'identity_summary' => $identitySummary,
            // Per-row evidence behind each result card ("which is which").
            'details' => [
                'created' => $createdDetails,
                'updated' => $updatedDetails,
                'skipped' => $skippedDetails,
                'matched_via_biometric_id' => $identityDetails['matched_via_biometric_id'],
                'matched_via_saved_source_id' => $identityDetails['matched_via_saved_source_id'],
                'matched_via_base44' => $identityDetails['matched_via_base44'],
                'matched_via_smart_name' => $identityDetails['matched_via_smart_name'],
                'unresolved' => $identityDetails['unresolved'],
            ],
        ],
        ($created + $updated) > 0 ? "$created payroll record(s) created and $updated draft record(s) updated" : 'No payroll records were created or updated'
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

    $workbookXml = readSpreadsheetEntry($filepath, 'xl/workbook.xml');
    $relationshipsXml = readSpreadsheetEntry($filepath, 'xl/_rels/workbook.xml.rels');
    if ($workbookXml === false || $relationshipsXml === false) {
        sendError('Failed to open the Excel file. Make sure it is a valid .xlsx file.', 400);
    }

    // Use the workbook relationships instead of assuming the attendance data
    // lives on sheet1. ZKTeco Standard Reports put the employee roster first
    // and attendance totals on a later tab (usually "Att. Stat.").
    $workbook = new SimpleXMLElement($workbookXml);
    $relationships = new SimpleXMLElement($relationshipsXml);
    $workbook->registerXPathNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main');
    $relationships->registerXPathNamespace('p', 'http://schemas.openxmlformats.org/package/2006/relationships');
    $sheetDefinitions = $workbook->xpath('/x:workbook/x:sheets/x:sheet') ?: [];
    $relationshipDefinitions = $relationships->xpath('/p:Relationships/p:Relationship') ?: [];
    $targetsByRelationshipId = [];
    foreach ($relationshipDefinitions as $relationship) {
        if ((string)$relationship['Type'] !== 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet') {
            continue;
        }
        $targetsByRelationshipId[(string)$relationship['Id']] = (string)$relationship['Target'];
    }

    $sheetEntries = [];
    foreach ($sheetDefinitions as $sheetDefinition) {
        $relationshipAttributes = $sheetDefinition->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships');
        $relationshipId = (string)($relationshipAttributes['id'] ?? '');
        $target = $targetsByRelationshipId[$relationshipId] ?? '';
        if ($target === '') continue;

        $target = str_replace('\\', '/', $target);
        $entryPath = str_starts_with($target, '/') ? ltrim($target, '/') : 'xl/' . $target;
        $parts = [];
        foreach (explode('/', $entryPath) as $part) {
            if ($part === '' || $part === '.') continue;
            if ($part === '..') {
                array_pop($parts);
                continue;
            }
            $parts[] = $part;
        }
        $sheetEntries[] = implode('/', $parts);
    }
    if (empty($sheetEntries)) {
        sendError('The Excel workbook does not contain any readable worksheets.', 400);
    }

    $firstSheetRows = null;
    foreach ($sheetEntries as $sheetEntry) {
        $sheetXml = readSpreadsheetEntry($filepath, $sheetEntry);
        if ($sheetXml === false) continue;
        $rows = parseXlsxWorksheetRows($sheetXml, $sharedStrings);
        if (empty($rows)) continue;
        if ($firstSheetRows === null) $firstSheetRows = $rows;

        // Prefer a ZKTeco attendance report or a regular totals template over
        // the roster, schedule, or exception tabs that appear earlier.
        if (convertZktecoStatisticalReportRows($rows) !== null
            || convertZktecoCardReportRows($rows) !== null) {
            return $rows;
        }

        $headers = array_map('normalizeAttendanceHeader', $rows[0]);
        if (in_array('daysworked', $headers, true)
            && in_array('overtimehours', $headers, true)
            && in_array('lateminutes', $headers, true)
            && in_array('absentdays', $headers, true)) {
            return $rows;
        }
    }

    return $firstSheetRows ?? [];
}

function parseXlsxWorksheetRows($sheetXml, $sharedStrings) {
    $rows = [];
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
