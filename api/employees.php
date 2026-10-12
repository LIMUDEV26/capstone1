<?php
/**
 * Employees API
 * Handles CRUD operations for employees and keeps linked user records in sync.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';
require_once 'edit_request_utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
runRuntimeSchemaUpgradeOnce('employees_schema_v20261012_storage', function () use ($conn) {
    ensureEmployeeSchema($conn);
    ensureTableIndex(
        $conn,
        'users',
        'idx_users_email',
        "ALTER TABLE users ADD INDEX idx_users_email (email)"
    );
}, 86400);

switch ($method) {
    case 'GET':
        requireFeatureAccess('employees', ['admin', 'manager'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireRole(['admin']);
        handlePost($conn);
        break;
    case 'PUT':
        requireRole(['admin']);
        handlePut($conn);
        break;
    case 'DELETE':
        requireRole(['admin']);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function employeesEnsureColumn($conn, $table, $column, $definition) {
    $dbName = DB_NAME;
    $checkSql = "SELECT 1
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
                 LIMIT 1";
    $checkStmt = $conn->prepare($checkSql);
    if (!$checkStmt) return;

    $checkStmt->bind_param('sss', $dbName, $table, $column);
    $checkStmt->execute();
    $exists = $checkStmt->get_result()->num_rows > 0;
    $checkStmt->close();

    if (!$exists) {
        $conn->query("ALTER TABLE `$table` ADD COLUMN $definition");
    }
}

function ensureEmployeeSchema($conn) {
    employeesEnsureColumn($conn, 'employees', 'storage_deleted_at', '`storage_deleted_at` DATETIME NULL');
    employeesEnsureColumn($conn, 'employees', 'department', '`department` VARCHAR(100) NULL');
    employeesEnsureColumn($conn, 'employees', 'employment_type', "`employment_type` VARCHAR(50) NOT NULL DEFAULT 'Full-Time'");
    employeesEnsureColumn($conn, 'employees', 'salary', '`salary` DECIMAL(12,2) NOT NULL DEFAULT 0.00');
    employeesEnsureColumn($conn, 'employees', 'sss_number', '`sss_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'employees', 'pagibig_number', '`pagibig_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'employees', 'philhealth_number', '`philhealth_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'employees', 'tin_number', '`tin_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'employees', 'document_resume', '`document_resume` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_nbi_clearance', '`document_nbi_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_police_clearance', '`document_police_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_barangay_clearance', '`document_barangay_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_birth_certificate', '`document_birth_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_medical_certificate', '`document_medical_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_diploma_tor', '`document_diploma_tor` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'employees', 'document_employment_contract', '`document_employment_contract` TINYINT(1) NOT NULL DEFAULT 0');

    employeesEnsureColumn($conn, 'users', 'date_of_birth', '`date_of_birth` DATE NULL');
    employeesEnsureColumn($conn, 'users', 'sss_number', '`sss_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'users', 'pagibig_number', '`pagibig_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'users', 'philhealth_number', '`philhealth_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'users', 'tin_number', '`tin_number` VARCHAR(30) NULL');
    employeesEnsureColumn($conn, 'users', 'document_resume', '`document_resume` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_nbi_clearance', '`document_nbi_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_police_clearance', '`document_police_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_barangay_clearance', '`document_barangay_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_birth_certificate', '`document_birth_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_medical_certificate', '`document_medical_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_diploma_tor', '`document_diploma_tor` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'document_employment_contract', '`document_employment_contract` TINYINT(1) NOT NULL DEFAULT 0');
    employeesEnsureColumn($conn, 'users', 'reset_token_hash', '`reset_token_hash` VARCHAR(64) NULL');
    employeesEnsureColumn($conn, 'users', 'reset_token_expires', '`reset_token_expires` DATETIME NULL');
    employeesEnsureColumn($conn, 'users', 'must_reset_password', '`must_reset_password` TINYINT(1) NOT NULL DEFAULT 0');
}

function normalizeNullableString($value, $maxLen = 255) {
    if (!isset($value)) return null;
    $str = trim((string)$value);
    if ($str === '') return null;
    $str = sanitizeInput($str);
    if (strlen($str) > $maxLen) $str = substr($str, 0, $maxLen);
    return $str;
}

function normalizeGovernmentNumber($value, $maxLen = 30) {
    $v = normalizeNullableString($value, $maxLen);
    if ($v === null) return null;
    $v = preg_replace('/[^A-Za-z0-9\-]/', '', $v);
    if ($v === '') return null;
    if (strlen($v) > $maxLen) $v = substr($v, 0, $maxLen);
    return $v;
}

function assertDistinctGovernmentNumbers($sssNumber, $pagibigNumber, $philhealthNumber, $tinNumber) {
    $labels = [
        'sss_number' => 'SSS Number',
        'pagibig_number' => 'Pag-IBIG Number',
        'philhealth_number' => 'PhilHealth Number',
        'tin_number' => 'TIN Number',
    ];
    $values = [
        'sss_number' => normalizeGovernmentNumber($sssNumber, 30),
        'pagibig_number' => normalizeGovernmentNumber($pagibigNumber, 30),
        'philhealth_number' => normalizeGovernmentNumber($philhealthNumber, 30),
        'tin_number' => normalizeGovernmentNumber($tinNumber, 30),
    ];

    $seen = [];
    foreach ($values as $field => $value) {
        if ($value === null) continue;

        if (isset($seen[$value])) {
            $otherField = $seen[$value];
            sendError($labels[$field] . ' must not be the same as ' . $labels[$otherField] . '.', 400);
        }

        $seen[$value] = $field;
    }
}

function canonicalizeGovernmentNumber($value, $maxLen = 30) {
    $normalized = normalizeGovernmentNumber($value, $maxLen);
    if ($normalized === null) return null;

    $canonical = preg_replace('/[^A-Za-z0-9]/', '', strtoupper($normalized));
    if ($canonical === '') return null;

    return $canonical;
}

function assertGovernmentNumberUniqueInTable($conn, $table, $idColumn, $field, $value, $excludeId = null, $recordLabel = 'record') {
    static $allowedTables   = ['employees' => true, 'users' => true];
    static $allowedIdCols   = ['employee_id' => true, 'id' => true];
    static $allowedFields   = ['sss_number' => true, 'pagibig_number' => true, 'philhealth_number' => true, 'tin_number' => true];

    if (!isset($allowedTables[$table]) || !isset($allowedIdCols[$idColumn]) || !isset($allowedFields[$field])) {
        error_log("assertGovernmentNumberUniqueInTable: rejected unsafe identifier ($table/$idColumn/$field)");
        return;
    }

    $canonical = canonicalizeGovernmentNumber($value, 30);
    if ($canonical === null) return;

    $sql = "SELECT `{$idColumn}`
            FROM `{$table}`
            WHERE `{$field}` IS NOT NULL
              AND REPLACE(UPPER(TRIM(`{$field}`)), '-', '') = ?";

    if ($excludeId !== null && intval($excludeId) > 0) {
        $sql .= " AND `{$idColumn}` <> ?";
        $stmt = $conn->prepare($sql . " LIMIT 1");
        if (!$stmt) sendError('Failed to validate ' . $field . ' uniqueness.', 500);
        $exclude = intval($excludeId);
        $stmt->bind_param('si', $canonical, $exclude);
    } else {
        $stmt = $conn->prepare($sql . " LIMIT 1");
        if (!$stmt) sendError('Failed to validate ' . $field . ' uniqueness.', 500);
        $stmt->bind_param('s', $canonical);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        $labels = [
            'sss_number' => 'SSS Number',
            'pagibig_number' => 'Pag-IBIG Number',
            'philhealth_number' => 'PhilHealth Number',
            'tin_number' => 'TIN Number',
        ];
        $label = $labels[$field] ?? $field;
        sendError($label . ' is already assigned to another ' . $recordLabel . '.', 409);
    }
}

function assertGovernmentNumbersUniqueForEmployees($conn, $numbers, $excludeEmployeeId = null) {
    foreach (['sss_number', 'pagibig_number', 'philhealth_number', 'tin_number'] as $field) {
        assertGovernmentNumberUniqueInTable(
            $conn,
            'employees',
            'employee_id',
            $field,
            $numbers[$field] ?? null,
            $excludeEmployeeId,
            'employee record'
        );
    }
}

function assertGovernmentNumbersUniqueForUsers($conn, $numbers, $excludeUserId = null) {
    foreach (['sss_number', 'pagibig_number', 'philhealth_number', 'tin_number'] as $field) {
        assertGovernmentNumberUniqueInTable(
            $conn,
            'users',
            'id',
            $field,
            $numbers[$field] ?? null,
            $excludeUserId,
            'user account'
        );
    }
}

function toTinyInt($value) {
    if (is_bool($value)) return $value ? 1 : 0;
    if (is_numeric($value)) return intval($value) > 0 ? 1 : 0;
    if (is_string($value)) {
        $v = strtolower(trim($value));
        return in_array($v, ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
    }
    return 0;
}

function normalizeEmployeeName($value, $maxLen = 50) {
    $str = trim((string)$value);
    if ($str === '') return '';
    $str = preg_replace('/\s+/', ' ', $str);
    $str = sanitizeInput($str);
    if (strlen($str) > $maxLen) $str = substr($str, 0, $maxLen);
    return $str;
}

function parseNullableInt($value) {
    if (!isset($value) || $value === '') return null;
    if (!is_numeric($value)) return null;
    $n = intval($value);
    return $n > 0 ? $n : null;
}

function parseEmployeeSalary($value, $default = 0.00) {
    if (!isset($value) || $value === '') return round((float)$default, 2);
    if (!is_numeric($value)) sendError('Salary must be a valid number.', 400);
    $salary = round((float)$value, 2);
    if ($salary < 0) sendError('Salary cannot be negative.', 400);
    return $salary;
}

function normalizeEmployeeStatus($value, $default = 'active') {
    $allowed = ['active', 'inactive', 'on_leave', 'terminated'];
    $normalized = strtolower(trim((string)$value));
    if ($normalized === '') $normalized = strtolower($default);
    if (!in_array($normalized, $allowed, true)) {
        sendError('Invalid employee status.', 400);
    }
    return $normalized;
}

function normalizeEmploymentType($value, $default = 'Full-Time') {
    $normalized = normalizeNullableString($value, 50);
    if ($normalized === null) return $default;
    return $normalized;
}

function normalizeDateValue($value, $fieldName) {
    $normalized = normalizeNullableString($value, 10);
    if ($normalized === null) return null;
    if (!validateDate($normalized)) {
        sendError("Invalid $fieldName format. Expected YYYY-MM-DD.", 400);
    }
    return $normalized;
}

function isEmployeeAtLeastMinimumAge($dateOfBirth, $minimumAge = 18) {
    if (!validateDate($dateOfBirth)) return false;
    $birthDate = DateTime::createFromFormat('Y-m-d', $dateOfBirth);
    if (!$birthDate) return false;
    $birthDate->setTime(0, 0, 0);
    $cutoff = new DateTime('today');
    $cutoff->modify('-' . intval($minimumAge) . ' years');
    return $birthDate <= $cutoff;
}

function normalizeEmployeeEmailIdentifier($value) {
    $email = strtolower(trim((string)$value));
    if ($email === '') return '';
    return sanitizeInput($email);
}

function buildEmployeeUsernameBaseFromEmail($email) {
    $normalized = normalizeEmployeeEmailIdentifier($email);
    if ($normalized === '') return 'user';

    $localPart = $normalized;
    $atPos = strpos($normalized, '@');
    if ($atPos !== false) {
        $localPart = substr($normalized, 0, $atPos);
    }

    $base = preg_replace('/[^a-z0-9._-]/', '', strtolower($localPart));
    $base = trim((string)$base, '._-');
    if ($base === '') $base = 'user';
    if (strlen($base) > 42) $base = substr($base, 0, 42);
    return $base;
}

function generateEmployeeUniqueUsernameFromEmail($conn, $email) {
    $base = buildEmployeeUsernameBaseFromEmail($email);

    for ($attempt = 0; $attempt < 1000; $attempt++) {
        $candidate = $attempt === 0
            ? $base
            : substr($base, 0, max(1, 50 - strlen('_' . $attempt))) . '_' . $attempt;

        $check = $conn->prepare("SELECT id FROM users WHERE username = ? LIMIT 1");
        if (!$check) return 'user_' . substr(bin2hex(random_bytes(8)), 0, 12);
        $check->bind_param('s', $candidate);
        $check->execute();
        $exists = $check->get_result()->num_rows > 0;
        $check->close();

        if (!$exists) {
            return $candidate;
        }
    }

    return 'user_' . substr(bin2hex(random_bytes(8)), 0, 12);
}

function generateEmployeeTemporaryPassword($length = 12) {
    $len = max(10, min(32, intval($length)));
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $lower = 'abcdefghijkmnopqrstuvwxyz';
    $digits = '23456789';
    $symbols = '!@#$%*+-_';
    $all = $upper . $lower . $digits . $symbols;

    $chars = [
        $upper[random_int(0, strlen($upper) - 1)],
        $lower[random_int(0, strlen($lower) - 1)],
        $digits[random_int(0, strlen($digits) - 1)],
        $symbols[random_int(0, strlen($symbols) - 1)],
    ];

    while (count($chars) < $len) {
        $chars[] = $all[random_int(0, strlen($all) - 1)];
    }

    for ($i = count($chars) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        $tmp = $chars[$i];
        $chars[$i] = $chars[$j];
        $chars[$j] = $tmp;
    }

    return implode('', $chars);
}

function buildEmployeesFrontendBaseUrl() {
    $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
    if ($frontendBase !== '') {
        return rtrim($frontendBase, '/');
    }

    $scheme = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    return rtrim($scheme . '://' . $host, '/');
}

function sendEmployeeOnboardingEmail($email, $fullName, $temporaryPassword, $role = 'staff') {
    if (!function_exists('sendMail')) {
        return false;
    }

    $displayName = trim((string)$fullName) !== '' ? trim((string)$fullName) : trim((string)$email);
    $safeName = htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8');
    $safePassword = htmlspecialchars($temporaryPassword, ENT_QUOTES, 'UTF-8');
    $safeRole = htmlspecialchars(ucfirst(trim((string)$role ?: 'staff')), ENT_QUOTES, 'UTF-8');
    $loginLink = buildEmployeesFrontendBaseUrl() . '/';
    $safeLink = htmlspecialchars($loginLink, ENT_QUOTES, 'UTF-8');

    $content = ''
        . '<h2 style="margin:0 0 12px 0;font-size:18px;line-height:1.4;color:#0f172a;">Your account has been created</h2>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">Hello <strong>' . $safeName . '</strong>,</p>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">A user account was automatically created from your employee record.</p>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;"><strong>Role:</strong> ' . $safeRole . '</p>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;"><strong>Temporary password:</strong></p>'
        . '<div style="margin:0 0 18px 0;padding:14px 16px;background:#111827;border-radius:12px;color:#ffffff;font-family:Consolas,Monaco,monospace;font-size:18px;line-height:1.4;font-weight:700;letter-spacing:0.08em;text-align:center;">' . $safePassword . '</div>'
        . '<p style="margin:0 0 18px 0;"><a href="' . $safeLink . '" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#0f2d74;color:#ffffff;text-decoration:none;font-weight:700;">Open Login</a></p>'
        . '<p style="margin:0;font-size:12px;line-height:1.7;color:#64748b;">You will be asked to change this password on your first sign-in.</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, 'Your account has been created and is ready for first sign-in.')
        : $content;

    $alt = "Hello {$displayName},\n\nA user account was automatically created from your employee record.\nRole: {$role}\nTemporary password: {$temporaryPassword}\nLogin: {$loginLink}\n";

    return sendMail($email, $displayName, 'Your account has been created', $html, $alt);
}

function resolveEmployeeAutoUserRole($position) {
    $normalized = strtolower(trim((string)$position));
    if ($normalized === 'manager') return 'manager';
    if ($normalized === 'admin' || $normalized === 'administrator' || strpos($normalized, 'admin') !== false) {
        return '';
    }
    return 'staff';
}

function createLinkedUserFromEmployee($conn, $employeeId, $employee) {
    $email = normalizeNullableString($employee['email'] ?? null, 100);
    if ($email === null || !validateGmailComEmail($email)) {
        return ['user_id' => 0, 'email_sent' => null];
    }

    $role = resolveEmployeeAutoUserRole($employee['position'] ?? '');
    if ($role === '') {
        return ['user_id' => 0, 'email_sent' => null];
    }

    $existingUser = getLinkedUserForEmployee($conn, $employeeId);
    if ($existingUser) {
        return ['user_id' => intval($existingUser['id'] ?? 0), 'email_sent' => null];
    }

    $matchByEmail = findUserIdByEmail($conn, $email);
    if ($matchByEmail > 0) {
        $link = $conn->prepare("UPDATE users SET employee_id = ? WHERE id = ? LIMIT 1");
        if ($link) {
            $link->bind_param('ii', $employeeId, $matchByEmail);
            $link->execute();
            $link->close();
        }
        return ['user_id' => $matchByEmail, 'email_sent' => null];
    }

    $username = generateEmployeeUniqueUsernameFromEmail($conn, $email);
    $temporaryPassword = generateEmployeeTemporaryPassword(12);
    $hashedPassword = hashPassword($temporaryPassword);
    $firstName = normalizeEmployeeName($employee['first_name'] ?? '', 50);
    $lastName = normalizeEmployeeName($employee['last_name'] ?? '', 50);
    $dateOfBirth = normalizeStoredDateOrNull($employee['date_of_birth'] ?? null);
    $branchId = parseNullableInt($employee['branch_id'] ?? null);
    $status = mapEmployeeStatusToUserStatus($employee['status'] ?? 'active', 'active');
    $sss = normalizeGovernmentNumber($employee['sss_number'] ?? null, 30);
    $pagibig = normalizeGovernmentNumber($employee['pagibig_number'] ?? null, 30);
    $philhealth = normalizeGovernmentNumber($employee['philhealth_number'] ?? null, 30);
    $tin = normalizeGovernmentNumber($employee['tin_number'] ?? null, 30);
    $docResume = toTinyInt($employee['document_resume'] ?? 0);
    $docNbi = toTinyInt($employee['document_nbi_clearance'] ?? 0);
    $docPolice = toTinyInt($employee['document_police_clearance'] ?? 0);
    $docBarangay = toTinyInt($employee['document_barangay_clearance'] ?? 0);
    $docBirth = toTinyInt($employee['document_birth_certificate'] ?? 0);
    $docMedical = toTinyInt($employee['document_medical_certificate'] ?? 0);
    $docDiploma = toTinyInt($employee['document_diploma_tor'] ?? 0);
    $docContract = toTinyInt($employee['document_employment_contract'] ?? 0);

    $sql = "INSERT INTO users (
                username, password, email, first_name, last_name, date_of_birth, role, status,
                branch_id, employee_id, sss_number, pagibig_number, philhealth_number, tin_number,
                document_resume, document_nbi_clearance, document_police_clearance, document_barangay_clearance,
                document_birth_certificate, document_medical_certificate, document_diploma_tor, document_employment_contract,
                must_reset_password, created_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                NULLIF(?, 0), ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                1, NOW()
            )";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return ['user_id' => 0, 'email_sent' => false];
    }

    $branchBind = $branchId ?? 0;
    $stmt->bind_param(
        'ssssssssiissssiiiiiiii',
        $username,
        $hashedPassword,
        $email,
        $firstName,
        $lastName,
        $dateOfBirth,
        $role,
        $status,
        $branchBind,
        $employeeId,
        $sss,
        $pagibig,
        $philhealth,
        $tin,
        $docResume,
        $docNbi,
        $docPolice,
        $docBarangay,
        $docBirth,
        $docMedical,
        $docDiploma,
        $docContract
    );

    $executed = $stmt->execute();
    $newUserId = intval($conn->insert_id);
    $stmt->close();

    if (!$executed || $newUserId <= 0) {
        return ['user_id' => 0, 'email_sent' => false];
    }

    return [
        'user_id' => $newUserId,
        'email_sent' => 'queued',
        'email_payload' => [
            'email' => $email,
            'full_name' => trim($firstName . ' ' . $lastName),
            'temporary_password' => $temporaryPassword,
            'role' => $role,
            'employee_id' => $employeeId,
        ],
    ];
}

function normalizeStoredDateOrNull($value) {
    $str = trim((string)$value);
    if ($str === '' || $str === '0000-00-00') return null;
    return validateDate($str) ? $str : null;
}

function assertBranchExists($conn, $branchId) {
    if ($branchId === null) return;

    $stmt = $conn->prepare("SELECT branch_id FROM branches WHERE branch_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to validate branch.', 500);
    $stmt->bind_param('i', $branchId);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        sendError('Selected branch does not exist.', 400);
    }
}

function findDuplicateEmployeeByNameAndBirthdate($conn, $firstName, $lastName, $dateOfBirth, $excludeEmployeeId = null) {
    if ($dateOfBirth === null || $firstName === '' || $lastName === '') return 0;

    $sql = "SELECT employee_id
            FROM employees
            WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
              AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
              AND date_of_birth = ?";
    $types = 'sss';
    $params = [$firstName, $lastName, $dateOfBirth];

    if ($excludeEmployeeId !== null) {
        $excludeId = intval($excludeEmployeeId);
        if ($excludeId > 0) {
            $sql .= " AND employee_id <> ?";
            $types .= 'i';
            $params[] = $excludeId;
        }
    }

    $sql .= " LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to validate duplicate employee.', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return intval($row['employee_id'] ?? 0);
}

function findDuplicateEmployeeByFullName($conn, $firstName, $lastName, $excludeEmployeeId = null) {
    if ($firstName === '' || $lastName === '') return 0;

    $sql = "SELECT employee_id
            FROM employees
            WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
              AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))";
    $types = 'ss';
    $params = [$firstName, $lastName];

    if ($excludeEmployeeId !== null) {
        $excludeId = intval($excludeEmployeeId);
        if ($excludeId > 0) {
            $sql .= " AND employee_id <> ?";
            $types .= 'i';
            $params[] = $excludeId;
        }
    }

    $sql .= " LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to validate duplicate employee name.', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return intval($row['employee_id'] ?? 0);
}

function assertEmployeeIdentityNotDuplicate($conn, $firstName, $lastName, $dateOfBirth, $excludeEmployeeId = null) {
    $firstName = normalizeEmployeeName($firstName, 50);
    $lastName = normalizeEmployeeName($lastName, 50);
    $dateOfBirth = normalizeStoredDateOrNull($dateOfBirth);

    $nameDuplicateId = findDuplicateEmployeeByFullName(
        $conn,
        $firstName,
        $lastName,
        $excludeEmployeeId
    );

    if ($nameDuplicateId > 0) {
        sendError('Employee with the same first name and last name already exists.', 409);
    }

    $duplicateId = findDuplicateEmployeeByNameAndBirthdate(
        $conn,
        $firstName,
        $lastName,
        $dateOfBirth,
        $excludeEmployeeId
    );

    if ($duplicateId > 0) {
        sendError('Employee with the same name and birthdate already exists.', 409);
    }
}

function parseRoleIds($value) {
    if (!is_array($value)) return [];
    $ids = [];
    foreach ($value as $raw) {
        $id = intval($raw);
        if ($id > 0) $ids[$id] = $id;
    }
    return array_values($ids);
}

function syncEmployeeRoles($conn, $employeeId, $roleIds) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return;

    $deleteStmt = $conn->prepare("DELETE FROM employee_role WHERE employee_id = ?");
    if ($deleteStmt) {
        $deleteStmt->bind_param('i', $employeeId);
        $deleteStmt->execute();
        $deleteStmt->close();
    }

    if (empty($roleIds)) return;

    $insertStmt = $conn->prepare("INSERT IGNORE INTO employee_role (employee_id, role_id) VALUES (?, ?)");
    if (!$insertStmt) return;

    foreach ($roleIds as $roleId) {
        $roleId = intval($roleId);
        if ($roleId <= 0) continue;
        $insertStmt->bind_param('ii', $employeeId, $roleId);
        $insertStmt->execute();
    }

    $insertStmt->close();
}

function getLinkedUserForEmployee($conn, $employeeId) {
    $stmt = $conn->prepare(
        "SELECT id, email, status
         FROM users
         WHERE employee_id = ?
         ORDER BY id DESC
         LIMIT 1"
    );
    if (!$stmt) return null;

    $stmt->bind_param('i', $employeeId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function findUserIdByEmail($conn, $email) {
    $normalizedEmail = normalizeNullableString($email, 100);
    if ($normalizedEmail === null) return 0;

    $lookup = $conn->prepare(
        "SELECT id
         FROM users
         WHERE email = ?
         ORDER BY id DESC
         LIMIT 1"
    );
    if (!$lookup) return 0;

    $lookup->bind_param('s', $normalizedEmail);
    $lookup->execute();
    $row = $lookup->get_result()->fetch_assoc();
    $lookup->close();

    return intval($row['id'] ?? 0);
}

function linkUserByEmployeeEmail($conn, $employeeId, $email) {
    $normalizedEmail = normalizeNullableString($email, 100);
    if ($normalizedEmail === null) return 0;

    $lookup = $conn->prepare(
        "SELECT id, employee_id
         FROM users
         WHERE email = ?
         ORDER BY id DESC
         LIMIT 1"
    );
    if (!$lookup) return 0;

    $lookup->bind_param('s', $normalizedEmail);
    $lookup->execute();
    $candidate = $lookup->get_result()->fetch_assoc();
    $lookup->close();

    if (!$candidate) return 0;

    $userId = intval($candidate['id'] ?? 0);
    $currentLinkedEmployeeId = intval($candidate['employee_id'] ?? 0);
    if ($userId <= 0) return 0;

    if ($currentLinkedEmployeeId <= 0 || $currentLinkedEmployeeId === intval($employeeId)) {
        $link = $conn->prepare("UPDATE users SET employee_id = ? WHERE id = ? LIMIT 1");
        if ($link) {
            $link->bind_param('ii', $employeeId, $userId);
            $link->execute();
            $link->close();
        }
    }

    return $userId;
}

function setManualLinkedUserForEmployee($conn, $employeeId, $linkedUserId) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return;

    if ($linkedUserId === null) {
        $unlinkAll = $conn->prepare("UPDATE users SET employee_id = NULL WHERE employee_id = ?");
        if ($unlinkAll) {
            $unlinkAll->bind_param('i', $employeeId);
            $unlinkAll->execute();
            $unlinkAll->close();
        }
        return;
    }

    $linkedUserId = intval($linkedUserId);
    if ($linkedUserId <= 0) {
        sendError('Invalid linked user ID.', 400);
    }

    $userCheck = $conn->prepare("SELECT id, employee_id FROM users WHERE id = ? LIMIT 1");
    if (!$userCheck) sendError('Failed to validate linked user.', 500);
    $userCheck->bind_param('i', $linkedUserId);
    $userCheck->execute();
    $linkedUser = $userCheck->get_result()->fetch_assoc();
    $userCheck->close();
    if (!$linkedUser) sendError('Linked user not found.', 404);

    $userCurrentEmployeeId = intval($linkedUser['employee_id'] ?? 0);
    if ($userCurrentEmployeeId > 0 && $userCurrentEmployeeId !== $employeeId) {
        sendError('Selected user is already linked to another employee. Unlink it first.', 409);
    }
    if ($userCurrentEmployeeId === $employeeId) {
        return;
    }

    $employeeLinkCheck = $conn->prepare(
        "SELECT id
         FROM users
         WHERE employee_id = ?
           AND id <> ?
         LIMIT 1"
    );
    if (!$employeeLinkCheck) sendError('Failed to validate employee link.', 500);
    $employeeLinkCheck->bind_param('ii', $employeeId, $linkedUserId);
    $employeeLinkCheck->execute();
    $employeeAlreadyLinked = $employeeLinkCheck->get_result()->num_rows > 0;
    $employeeLinkCheck->close();

    if ($employeeAlreadyLinked) {
        sendError('This employee is already linked to another user. Unlink it first.', 409);
    }

    $linkUser = $conn->prepare("UPDATE users SET employee_id = ? WHERE id = ? LIMIT 1");
    if (!$linkUser) sendError('Failed to link selected user.', 500);
    $linkUser->bind_param('ii', $employeeId, $linkedUserId);
    $linkUser->execute();
    $linkUser->close();
}

function mapEmployeeStatusToUserStatus($employeeStatus, $currentUserStatus) {
    $employeeStatus = strtolower(trim((string)$employeeStatus));
    $currentUserStatus = strtolower(trim((string)$currentUserStatus));

    if ($employeeStatus === 'active') {
        if (in_array($currentUserStatus, ['locked', 'suspended'], true)) {
            return $currentUserStatus;
        }
        return 'active';
    }

    return 'inactive';
}

function syncLinkedUserFromEmployee($conn, $employeeId, $allowAutoEmailLink = true) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return 0;

    $employeeStmt = $conn->prepare(
        "SELECT first_name, last_name, date_of_birth, email, branch_id, status,
                sss_number, pagibig_number, philhealth_number, tin_number,
                document_resume, document_nbi_clearance, document_police_clearance, document_barangay_clearance,
                document_birth_certificate, document_medical_certificate, document_diploma_tor, document_employment_contract
         FROM employees
         WHERE employee_id = ?
         LIMIT 1"
    );
    if (!$employeeStmt) return 0;

    $employeeStmt->bind_param('i', $employeeId);
    $employeeStmt->execute();
    $employee = $employeeStmt->get_result()->fetch_assoc();
    $employeeStmt->close();

    if (!$employee) return 0;

    $linkedUser = getLinkedUserForEmployee($conn, $employeeId);
    if (!$linkedUser && $allowAutoEmailLink) {
        $linkedUserId = linkUserByEmployeeEmail($conn, $employeeId, $employee['email'] ?? null);
        if ($linkedUserId > 0) {
            $linkedUser = getLinkedUserForEmployee($conn, $employeeId);
        }
    }
    if (!$linkedUser) return 0;

    $userId = intval($linkedUser['id'] ?? 0);
    if ($userId <= 0) return 0;

    $firstName = normalizeEmployeeName($employee['first_name'] ?? '', 50);
    $lastName = normalizeEmployeeName($employee['last_name'] ?? '', 50);
    if ($firstName === '') $firstName = 'Employee';
    if ($lastName === '') $lastName = 'User';

    $dateOfBirth = normalizeStoredDateOrNull($employee['date_of_birth'] ?? null);
    $email = normalizeNullableString($employee['email'] ?? null, 100);
    $branchId = parseNullableInt($employee['branch_id'] ?? null);
    $nextUserStatus = mapEmployeeStatusToUserStatus($employee['status'] ?? '', $linkedUser['status'] ?? '');
    $sss = normalizeGovernmentNumber($employee['sss_number'] ?? null, 30);
    $pagibig = normalizeGovernmentNumber($employee['pagibig_number'] ?? null, 30);
    $philhealth = normalizeGovernmentNumber($employee['philhealth_number'] ?? null, 30);
    $tin = normalizeGovernmentNumber($employee['tin_number'] ?? null, 30);
    assertGovernmentNumbersUniqueForUsers($conn, [
        'sss_number' => $sss,
        'pagibig_number' => $pagibig,
        'philhealth_number' => $philhealth,
        'tin_number' => $tin,
    ], $userId);
    $docResume = toTinyInt($employee['document_resume'] ?? 0);
    $docNbi = toTinyInt($employee['document_nbi_clearance'] ?? 0);
    $docPolice = toTinyInt($employee['document_police_clearance'] ?? 0);
    $docBarangay = toTinyInt($employee['document_barangay_clearance'] ?? 0);
    $docBirth = toTinyInt($employee['document_birth_certificate'] ?? 0);
    $docMedical = toTinyInt($employee['document_medical_certificate'] ?? 0);
    $docDiploma = toTinyInt($employee['document_diploma_tor'] ?? 0);
    $docContract = toTinyInt($employee['document_employment_contract'] ?? 0);

    $updates = [
        'first_name = ?',
        'last_name = ?',
        'status = ?',
        'branch_id = NULLIF(?, 0)',
        'sss_number = ?',
        'pagibig_number = ?',
        'philhealth_number = ?',
        'tin_number = ?',
        'document_resume = ?',
        'document_nbi_clearance = ?',
        'document_police_clearance = ?',
        'document_barangay_clearance = ?',
        'document_birth_certificate = ?',
        'document_medical_certificate = ?',
        'document_diploma_tor = ?',
        'document_employment_contract = ?',
    ];
    $types = 'sssissssiiiiiiii';
    $params = [
        $firstName,
        $lastName,
        $nextUserStatus,
        $branchId ?? 0,
        $sss,
        $pagibig,
        $philhealth,
        $tin,
        $docResume,
        $docNbi,
        $docPolice,
        $docBarangay,
        $docBirth,
        $docMedical,
        $docDiploma,
        $docContract,
    ];

    if ($dateOfBirth === null) {
        $updates[] = 'date_of_birth = NULL';
    } else {
        $updates[] = 'date_of_birth = ?';
        $types .= 's';
        $params[] = $dateOfBirth;
    }

    if ($email !== null) {
        $updates[] = 'email = ?';
        $types .= 's';
        $params[] = $email;
    }

    $types .= 'i';
    $params[] = $userId;

    $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return $userId;

    $stmt->bind_param($types, ...$params);
    $ok = $stmt->execute();
    $errno = intval($stmt->errno);
    $stmt->close();

    // If email is already used by another user, retry sync without modifying email.
    if (!$ok && $errno === 1062 && $email !== null) {
        $fallbackUpdates = [
            'first_name = ?',
            'last_name = ?',
            'status = ?',
            'branch_id = NULLIF(?, 0)',
            'sss_number = ?',
            'pagibig_number = ?',
            'philhealth_number = ?',
            'tin_number = ?',
            'document_resume = ?',
            'document_nbi_clearance = ?',
            'document_police_clearance = ?',
            'document_barangay_clearance = ?',
            'document_birth_certificate = ?',
            'document_medical_certificate = ?',
            'document_diploma_tor = ?',
            'document_employment_contract = ?',
        ];
        $fallbackTypes = 'sssissssiiiiiiii';
        $fallbackParams = [
            $firstName,
            $lastName,
            $nextUserStatus,
            $branchId ?? 0,
            $sss,
            $pagibig,
            $philhealth,
            $tin,
            $docResume,
            $docNbi,
            $docPolice,
            $docBarangay,
            $docBirth,
            $docMedical,
            $docDiploma,
            $docContract,
        ];

        if ($dateOfBirth === null) {
            $fallbackUpdates[] = 'date_of_birth = NULL';
        } else {
            $fallbackUpdates[] = 'date_of_birth = ?';
            $fallbackTypes .= 's';
            $fallbackParams[] = $dateOfBirth;
        }

        $fallbackTypes .= 'i';
        $fallbackParams[] = $userId;
        $fallbackSql = "UPDATE users SET " . implode(', ', $fallbackUpdates) . " WHERE id = ?";
        $fallbackStmt = $conn->prepare($fallbackSql);
        if ($fallbackStmt) {
            $fallbackStmt->bind_param($fallbackTypes, ...$fallbackParams);
            $fallbackStmt->execute();
            $fallbackStmt->close();
        }
    }

    return $userId;
}

function getEmployeeSelectSql() {
    return "SELECT e.*,
                   b.branch_name,
                   GROUP_CONCAT(DISTINCT r.role_name ORDER BY r.role_name SEPARATOR ', ') AS roles,
                   GROUP_CONCAT(DISTINCT er.role_id ORDER BY er.role_id SEPARATOR ',') AS role_ids_csv,
                   (SELECT u.id FROM users u WHERE u.employee_id = e.employee_id ORDER BY u.id DESC LIMIT 1) AS linked_user_id,
                   (SELECT u.username FROM users u WHERE u.employee_id = e.employee_id ORDER BY u.id DESC LIMIT 1) AS linked_username,
                   (SELECT u.role FROM users u WHERE u.employee_id = e.employee_id ORDER BY u.id DESC LIMIT 1) AS linked_user_role,
                   (SELECT u.status FROM users u WHERE u.employee_id = e.employee_id ORDER BY u.id DESC LIMIT 1) AS linked_user_status
            FROM employees e
            LEFT JOIN branches b ON e.branch_id = b.branch_id
            LEFT JOIN employee_role er ON e.employee_id = er.employee_id
            LEFT JOIN roles r ON er.role_id = r.role_id";
}

function normalizeEmployeeRow($row) {
    $row['linked_user_id'] = isset($row['linked_user_id']) && $row['linked_user_id'] !== null
        ? intval($row['linked_user_id'])
        : null;
    $row['salary'] = isset($row['salary']) ? (float)$row['salary'] : 0.0;
    $row['roles'] = $row['roles'] ?? '';

    $documentFields = [
        'document_resume',
        'document_nbi_clearance',
        'document_police_clearance',
        'document_barangay_clearance',
        'document_birth_certificate',
        'document_medical_certificate',
        'document_diploma_tor',
        'document_employment_contract',
    ];
    foreach ($documentFields as $field) {
        $row[$field] = isset($row[$field]) ? intval($row[$field]) : 0;
    }

    $roleIds = [];
    $csv = trim((string)($row['role_ids_csv'] ?? ''));
    if ($csv !== '') {
        $parts = explode(',', $csv);
        foreach ($parts as $part) {
            $id = intval($part);
            if ($id > 0) $roleIds[$id] = $id;
        }
    }
    $row['role_ids'] = array_values($roleIds);
    unset($row['role_ids_csv']);

    return $row;
}

function fetchEmployeeRecordById($conn, $employeeId) {
    $stmt = $conn->prepare("SELECT * FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$stmt) return null;
    $id = intval($employeeId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * GET - Retrieve employees
 */
function handleGet($conn) {
    $employee_id = isset($_GET['id']) ? intval($_GET['id']) : null;
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $currentUserId = intval($_SESSION['user_id'] ?? 0);

    $resolveEmployeeIdForStaff = function() use ($conn, $currentUserId) {
        $sessionEmployeeId = intval($_SESSION['employee_id'] ?? 0);
        if ($sessionEmployeeId > 0) return $sessionEmployeeId;

        if ($currentUserId <= 0) return 0;
        $stmt = $conn->prepare("SELECT employee_id FROM users WHERE id = ? LIMIT 1");
        if (!$stmt) return 0;
        $stmt->bind_param('i', $currentUserId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        $employeeId = intval($row['employee_id'] ?? 0);
        if ($employeeId > 0) {
            $_SESSION['employee_id'] = $employeeId;
        }
        return $employeeId;
    };

    $selfEmployeeId = ($role === 'staff') ? $resolveEmployeeIdForStaff() : 0;
    if ($role === 'staff' && $selfEmployeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }

    if ($role === 'staff') {
        if ($employee_id !== null && $employee_id !== $selfEmployeeId) {
            sendError('Staff can only view their own employee record.', 403);
        }
        $employee_id = $selfEmployeeId;
    }

    $storageDeleted = !empty($_GET['storage_deleted']);
    if ($storageDeleted && $role !== 'admin') {
        sendError('Only administrators can view employee records in Data Storage.', 403);
    }

    if ($employee_id !== null && $employee_id <= 0) {
        sendError('Invalid employee ID.', 400);
    }

    $sql = getEmployeeSelectSql() . ($storageDeleted
        ? " WHERE e.storage_deleted_at IS NOT NULL"
        : " WHERE e.storage_deleted_at IS NULL");
    $params = [];
    $types = '';

    if ($employee_id !== null) {
        $sql .= " AND e.employee_id = ?";
        $params[] = $employee_id;
        $types .= 'i';
    }

    if (!empty($_GET['status'])) {
        $status = normalizeEmployeeStatus($_GET['status'], 'active');
        $sql .= " AND e.status = ?";
        $params[] = $status;
        $types .= 's';
    }

    if (!empty($_GET['branch_id'])) {
        $branchId = intval($_GET['branch_id']);
        if ($branchId <= 0) sendError('Invalid branch_id filter.', 400);
        $sql .= " AND e.branch_id = ?";
        $params[] = $branchId;
        $types .= 'i';
    }

    if (!empty($_GET['search'])) {
        $search = '%' . sanitizeInput($_GET['search']) . '%';
        $sql .= " AND (
                    e.employee_date_id LIKE ?
                    OR e.first_name LIKE ?
                    OR e.last_name LIKE ?
                    OR e.email LIKE ?
                    OR e.position LIKE ?
                    OR e.department LIKE ?
                )";
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $types .= 'ssssss';
    }

    if ($role === 'staff') {
        $sql .= " AND e.employee_id = ?";
        $params[] = $selfEmployeeId;
        $types .= 'i';
    }

    $sql .= " GROUP BY e.employee_id
              ORDER BY
                LOWER(TRIM(COALESCE(e.first_name, ''))) ASC,
                LOWER(TRIM(COALESCE(e.last_name, ''))) ASC,
                e.employee_id ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare employee query.', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    if (!$result) sendError('Failed to retrieve employees.', 500);

    $employees = [];
    while ($row = $result->fetch_assoc()) {
        $employees[] = normalizeEmployeeRow($row);
    }

    if ($employee_id !== null) {
        if (!empty($employees)) {
            sendResponse(true, $employees[0], 'Employee retrieved successfully');
        }
        sendError('Employee not found', 404);
    }

    sendResponse(true, $employees, 'Employees retrieved successfully');
}

/**
 * POST - Create new employee
 */
function handlePost($conn) {
    $data = getJSONInput();

    $required = ['first_name', 'last_name'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $first_name = normalizeEmployeeName($data['first_name'], 50);
    $last_name = normalizeEmployeeName($data['last_name'], 50);
    if ($first_name === '' || $last_name === '') {
        sendError('First name and last name are required.', 400);
    }

    $date_of_birth = normalizeDateValue($data['date_of_birth'] ?? null, 'date_of_birth');
    if ($date_of_birth !== null && !isEmployeeAtLeastMinimumAge($date_of_birth, 18)) {
        sendError('Employee must be at least 18 years old.', 422);
    }
    $email = normalizeNullableString($data['email'] ?? null, 100);
    if ($email !== null && !validateEmail($email)) {
        sendError('Invalid email format', 400);
    }

    if ($email !== null) {
        $duplicateStmt = $conn->prepare("SELECT employee_id FROM employees WHERE email = ? LIMIT 1");
        if ($duplicateStmt) {
            $duplicateStmt->bind_param('s', $email);
            $duplicateStmt->execute();
            if ($duplicateStmt->get_result()->num_rows > 0) {
                sendError('Email is already used by another employee.', 409);
            }
            $duplicateStmt->close();
        }
    }

    $hasManualUserLink = array_key_exists('linked_user_id', $data);
    $manualLinkedUserId = null;
    if ($hasManualUserLink) {
        $rawLinkedUserId = $data['linked_user_id'];
        $manualLinkedUserId = parseNullableInt($rawLinkedUserId);
        if ($rawLinkedUserId !== null && $rawLinkedUserId !== '' && $manualLinkedUserId === null) {
            sendError('Invalid linked user ID.', 400);
        }
    }

    $phone_number = normalizeInternationalPhoneNumber($data['phone_number'] ?? null, '+63');
    if ($phone_number === false) {
        sendError('Phone number must be a valid international number with a country code, like +639123456789.', 400);
    }
    $address = normalizeNullableString($data['address'] ?? null, 255);
    $position = normalizeNullableString($data['position'] ?? null, 100);
    $department = normalizeNullableString($data['department'] ?? null, 100);
    $employment_type = normalizeEmploymentType($data['employment_type'] ?? null, 'Full-Time');
    $sss_number = normalizeGovernmentNumber($data['sss_number'] ?? null, 30);
    $pagibig_number = normalizeGovernmentNumber($data['pagibig_number'] ?? null, 30);
    $philhealth_number = normalizeGovernmentNumber($data['philhealth_number'] ?? null, 30);
    $tin_number = normalizeGovernmentNumber($data['tin_number'] ?? null, 30);
    assertDistinctGovernmentNumbers($sss_number, $pagibig_number, $philhealth_number, $tin_number);
    $matchedUserIdByEmail = !$hasManualUserLink ? findUserIdByEmail($conn, $email) : 0;
    $userGovernmentExcludeId = $manualLinkedUserId ?? ($matchedUserIdByEmail > 0 ? $matchedUserIdByEmail : null);
    assertGovernmentNumbersUniqueForEmployees($conn, [
        'sss_number' => $sss_number,
        'pagibig_number' => $pagibig_number,
        'philhealth_number' => $philhealth_number,
        'tin_number' => $tin_number,
    ]);
    assertGovernmentNumbersUniqueForUsers($conn, [
        'sss_number' => $sss_number,
        'pagibig_number' => $pagibig_number,
        'philhealth_number' => $philhealth_number,
        'tin_number' => $tin_number,
    ], $userGovernmentExcludeId);
    $docResume = toTinyInt($data['document_resume'] ?? 0);
    $docNbi = toTinyInt($data['document_nbi_clearance'] ?? 0);
    $docPolice = toTinyInt($data['document_police_clearance'] ?? 0);
    $docBarangay = toTinyInt($data['document_barangay_clearance'] ?? 0);
    $docBirth = toTinyInt($data['document_birth_certificate'] ?? 0);
    $docMedical = toTinyInt($data['document_medical_certificate'] ?? 0);
    $docDiploma = toTinyInt($data['document_diploma_tor'] ?? 0);
    $docContract = toTinyInt($data['document_employment_contract'] ?? 0);
    $hire_date = normalizeDateValue($data['hire_date'] ?? date('Y-m-d'), 'hire_date');
    $salary = parseEmployeeSalary($data['salary'] ?? 0.00, 0.00);
    $status = normalizeEmployeeStatus($data['status'] ?? 'active', 'active');
    $branch_id = parseNullableInt($data['branch_id'] ?? null);
    assertBranchExists($conn, $branch_id);
    assertEmployeeIdentityNotDuplicate($conn, $first_name, $last_name, $date_of_birth);

    // Attendance IDs belong to the biometric/time-clock setup. Leave this
    // field blank unless a real device ID is supplied by an administrator.
    $employee_date_id = null;

    $sql = "INSERT INTO employees (
                employee_date_id, first_name, last_name, date_of_birth, email,
                phone_number, address, position, department, employment_type,
                sss_number, pagibig_number, philhealth_number, tin_number,
                document_resume, document_nbi_clearance, document_police_clearance, document_barangay_clearance,
                document_birth_certificate, document_medical_certificate, document_diploma_tor, document_employment_contract,
                hire_date, salary, status, branch_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, 0))";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare employee insert.', 500);

    $branchBind = $branch_id ?? 0;
    $stmt->bind_param(
        'ssssssssssssssiiiiiiiisdsi',
        $employee_date_id,
        $first_name,
        $last_name,
        $date_of_birth,
        $email,
        $phone_number,
        $address,
        $position,
        $department,
        $employment_type,
        $sss_number,
        $pagibig_number,
        $philhealth_number,
        $tin_number,
        $docResume,
        $docNbi,
        $docPolice,
        $docBarangay,
        $docBirth,
        $docMedical,
        $docDiploma,
        $docContract,
        $hire_date,
        $salary,
        $status,
        $branchBind
    );

    if ($stmt->execute()) {
        $employee_id = $conn->insert_id;
        $roleIds = parseRoleIds($data['role_ids'] ?? []);
        syncEmployeeRoles($conn, $employee_id, $roleIds);

        if ($hasManualUserLink) {
            setManualLinkedUserForEmployee($conn, $employee_id, $manualLinkedUserId);
        }

        $autoCreatedUser = ['user_id' => 0, 'email_sent' => null];
        if (!$hasManualUserLink) {
            $createdEmployee = fetchEmployeeRecordById($conn, $employee_id);
            if ($createdEmployee) {
                $autoCreatedUser = createLinkedUserFromEmployee($conn, $employee_id, $createdEmployee);
            }
        }

        $linkedUserId = syncLinkedUserFromEmployee($conn, $employee_id, !$hasManualUserLink);

        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'create_employee', "Created employee: $first_name $last_name", 'employee_management');
        }

        $responseData = [
            'employee_id' => $employee_id,
            'employee_date_id' => null,
            'linked_user_id' => $linkedUserId > 0 ? $linkedUserId : null,
            'auto_created_user_id' => intval($autoCreatedUser['user_id'] ?? 0) > 0 ? intval($autoCreatedUser['user_id']) : null,
            'auto_created_user_email_sent' => $autoCreatedUser['email_sent'],
        ];

        if (!empty($autoCreatedUser['email_payload']) && is_array($autoCreatedUser['email_payload'])) {
            $emailPayload = $autoCreatedUser['email_payload'];
            sendResponseAndContinue(true, $responseData, 'Employee created successfully', 201, function () use ($emailPayload) {
                $sent = sendEmployeeOnboardingEmail(
                    $emailPayload['email'],
                    $emailPayload['full_name'],
                    $emailPayload['temporary_password'],
                    $emailPayload['role']
                );

                if (!$sent) {
                    error_log('Employee onboarding email failed for employee_id=' . $emailPayload['employee_id'] . ', email=' . $emailPayload['email']);
                }
            });
        }

        sendResponse(
            true,
            $responseData,
            'Employee created successfully',
            201
        );
    } else {
        if ($stmt->errno === 1062) {
            sendError('Employee email already exists.', 409);
        }
        error_log($conn->error);
        sendError('Failed to create employee.', 500);
    }
}

/**
 * PUT - Update employee
 */
function handlePut($conn) {
    $data = getJSONInput();

    if (!empty($data['remove_to_storage']) || !empty($data['restore_from_storage'])) {
        $employeeId = intval($data['employee_id'] ?? 0);
        if ($employeeId <= 0) sendError('Valid employee ID is required.', 400);

        $isRestore = !empty($data['restore_from_storage']);
        $condition = $isRestore
            ? 'storage_deleted_at IS NOT NULL'
            : "storage_deleted_at IS NULL AND (status = 'inactive' OR EXISTS (SELECT 1 FROM users u WHERE u.employee_id = employees.employee_id AND u.status = 'inactive'))";
        $stmt = $conn->prepare("UPDATE employees SET storage_deleted_at = " . ($isRestore ? 'NULL' : 'NOW()') . " WHERE employee_id = ? AND $condition");
        if (!$stmt) sendError('Failed to prepare employee storage action.', 500);
        $stmt->bind_param('i', $employeeId);
        $stmt->execute();
        $changed = $stmt->affected_rows;
        $stmt->close();

        if ($changed < 1) {
            sendError($isRestore
                ? 'Employee was not found in Data Storage.'
                : 'Only an archived employee can be moved to Data Storage.', 409);
        }

        sendResponse(true, ['employee_id' => $employeeId], $isRestore
            ? 'Employee restored to Archived Employees.'
            : 'Employee moved to Data Storage and can be restored later.');
    }

    if (!isset($data['employee_id'])) {
        sendError('Employee ID is required', 400);
    }

    $employee_id = intval($data['employee_id']);
    if ($employee_id <= 0) sendError('Invalid employee ID.', 400);

    $check_sql = "SELECT * FROM employees WHERE employee_id = ? LIMIT 1";
    $check_stmt = $conn->prepare($check_sql);
    if (!$check_stmt) sendError('Failed to validate employee.', 500);
    $check_stmt->bind_param('i', $employee_id);
    $check_stmt->execute();
    $existingEmployee = $check_stmt->get_result()->fetch_assoc();
    $check_stmt->close();

    if (!$existingEmployee) {
        sendError('Employee not found', 404);
    }

    $currentLinkedUser = getLinkedUserForEmployee($conn, $employee_id);
    $currentLinkedUserId = parseNullableInt($currentLinkedUser['id'] ?? null);
    $hasManualUserLink = array_key_exists('linked_user_id', $data);
    $manualLinkedUserId = null;
    if ($hasManualUserLink) {
        $rawLinkedUserId = $data['linked_user_id'];
        $manualLinkedUserId = parseNullableInt($rawLinkedUserId);
        if ($rawLinkedUserId !== null && $rawLinkedUserId !== '' && $manualLinkedUserId === null) {
            sendError('Invalid linked user ID.', 400);
        }
    }

    $nextFirstName = normalizeEmployeeName($existingEmployee['first_name'] ?? '', 50);
    $nextLastName = normalizeEmployeeName($existingEmployee['last_name'] ?? '', 50);
    $nextDateOfBirth = normalizeStoredDateOrNull($existingEmployee['date_of_birth'] ?? null);
    $nextEmail = array_key_exists('email', $data)
        ? normalizeNullableString($data['email'], 100)
        : normalizeNullableString($existingEmployee['email'] ?? null, 100);
    $nextSssNumber = array_key_exists('sss_number', $data)
        ? normalizeGovernmentNumber($data['sss_number'], 30)
        : normalizeGovernmentNumber($existingEmployee['sss_number'] ?? null, 30);
    $nextPagibigNumber = array_key_exists('pagibig_number', $data)
        ? normalizeGovernmentNumber($data['pagibig_number'], 30)
        : normalizeGovernmentNumber($existingEmployee['pagibig_number'] ?? null, 30);
    $nextPhilhealthNumber = array_key_exists('philhealth_number', $data)
        ? normalizeGovernmentNumber($data['philhealth_number'], 30)
        : normalizeGovernmentNumber($existingEmployee['philhealth_number'] ?? null, 30);
    $nextTinNumber = array_key_exists('tin_number', $data)
        ? normalizeGovernmentNumber($data['tin_number'], 30)
        : normalizeGovernmentNumber($existingEmployee['tin_number'] ?? null, 30);
    assertDistinctGovernmentNumbers($nextSssNumber, $nextPagibigNumber, $nextPhilhealthNumber, $nextTinNumber);
    $matchedUserIdByEmail = (!$hasManualUserLink && $nextEmail !== null) ? findUserIdByEmail($conn, $nextEmail) : 0;
    $userGovernmentExcludeId = $hasManualUserLink
        ? $manualLinkedUserId
        : ($currentLinkedUserId ?? ($matchedUserIdByEmail > 0 ? $matchedUserIdByEmail : null));
    assertGovernmentNumbersUniqueForEmployees($conn, [
        'sss_number' => $nextSssNumber,
        'pagibig_number' => $nextPagibigNumber,
        'philhealth_number' => $nextPhilhealthNumber,
        'tin_number' => $nextTinNumber,
    ], $employee_id);
    assertGovernmentNumbersUniqueForUsers($conn, [
        'sss_number' => $nextSssNumber,
        'pagibig_number' => $nextPagibigNumber,
        'philhealth_number' => $nextPhilhealthNumber,
        'tin_number' => $nextTinNumber,
    ], $userGovernmentExcludeId);

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('first_name', $data)) {
        $firstName = normalizeEmployeeName($data['first_name'], 50);
        if ($firstName === '') sendError('First name cannot be empty.', 400);
        $updates[] = "first_name = ?";
        $params[] = $firstName;
        $types .= 's';
        $nextFirstName = $firstName;
    }

    if (array_key_exists('last_name', $data)) {
        $lastName = normalizeEmployeeName($data['last_name'], 50);
        $updates[] = "last_name = ?";
        $params[] = $lastName;
        $types .= 's';
        $nextLastName = $lastName;
    }

    if (array_key_exists('date_of_birth', $data)) {
        $dateOfBirth = normalizeDateValue($data['date_of_birth'], 'date_of_birth');
        if ($dateOfBirth === null) {
            $updates[] = "date_of_birth = NULL";
            $nextDateOfBirth = null;
        } else {
            if (!isEmployeeAtLeastMinimumAge($dateOfBirth, 18)) {
                sendError('Employee must be at least 18 years old.', 422);
            }
            $updates[] = "date_of_birth = ?";
            $params[] = $dateOfBirth;
            $types .= 's';
            $nextDateOfBirth = $dateOfBirth;
        }
    }

    if (array_key_exists('email', $data)) {
        $email = normalizeNullableString($data['email'], 100);
        if ($email !== null && !validateEmail($email)) {
            sendError('Invalid email format', 400);
        }

        if ($email !== null) {
            $dup = $conn->prepare("SELECT employee_id FROM employees WHERE email = ? AND employee_id <> ? LIMIT 1");
            if ($dup) {
                $dup->bind_param('si', $email, $employee_id);
                $dup->execute();
                if ($dup->get_result()->num_rows > 0) {
                    sendError('Email is already used by another employee.', 409);
                }
                $dup->close();
            }
            $updates[] = "email = ?";
            $params[] = $email;
            $types .= 's';
        } else {
            $updates[] = "email = NULL";
        }
    }

    if (array_key_exists('phone_number', $data)) {
        $phone = normalizeInternationalPhoneNumber($data['phone_number'], '+63');
        if ($phone === false) {
            sendError('Phone number must be a valid international number with a country code, like +639123456789.', 400);
        }
        if ($phone === null) {
            $updates[] = "phone_number = NULL";
        } else {
            $updates[] = "phone_number = ?";
            $params[] = $phone;
            $types .= 's';
        }
    }

    if (array_key_exists('address', $data)) {
        $address = normalizeNullableString($data['address'], 255);
        if ($address === null) {
            $updates[] = "address = NULL";
        } else {
            $updates[] = "address = ?";
            $params[] = $address;
            $types .= 's';
        }
    }

    if (array_key_exists('position', $data)) {
        $position = normalizeNullableString($data['position'], 100);
        if ($position === null) {
            $updates[] = "position = NULL";
        } else {
            $updates[] = "position = ?";
            $params[] = $position;
            $types .= 's';
        }
    }

    if (array_key_exists('department', $data)) {
        $department = normalizeNullableString($data['department'], 100);
        if ($department === null) {
            $updates[] = "department = NULL";
        } else {
            $updates[] = "department = ?";
            $params[] = $department;
            $types .= 's';
        }
    }

    if (array_key_exists('employment_type', $data)) {
        $employmentType = normalizeEmploymentType($data['employment_type'], 'Full-Time');
        $updates[] = "employment_type = ?";
        $params[] = $employmentType;
        $types .= 's';
    }

    if (array_key_exists('sss_number', $data)) {
        if ($nextSssNumber === null) {
            $updates[] = "sss_number = NULL";
        } else {
            $updates[] = "sss_number = ?";
            $params[] = $nextSssNumber;
            $types .= 's';
        }
    }

    if (array_key_exists('pagibig_number', $data)) {
        if ($nextPagibigNumber === null) {
            $updates[] = "pagibig_number = NULL";
        } else {
            $updates[] = "pagibig_number = ?";
            $params[] = $nextPagibigNumber;
            $types .= 's';
        }
    }

    if (array_key_exists('philhealth_number', $data)) {
        if ($nextPhilhealthNumber === null) {
            $updates[] = "philhealth_number = NULL";
        } else {
            $updates[] = "philhealth_number = ?";
            $params[] = $nextPhilhealthNumber;
            $types .= 's';
        }
    }

    if (array_key_exists('tin_number', $data)) {
        if ($nextTinNumber === null) {
            $updates[] = "tin_number = NULL";
        } else {
            $updates[] = "tin_number = ?";
            $params[] = $nextTinNumber;
            $types .= 's';
        }
    }

    if (array_key_exists('document_resume', $data)) {
        $updates[] = "document_resume = ?";
        $params[] = toTinyInt($data['document_resume']);
        $types .= 'i';
    }

    if (array_key_exists('document_nbi_clearance', $data)) {
        $updates[] = "document_nbi_clearance = ?";
        $params[] = toTinyInt($data['document_nbi_clearance']);
        $types .= 'i';
    }

    if (array_key_exists('document_police_clearance', $data)) {
        $updates[] = "document_police_clearance = ?";
        $params[] = toTinyInt($data['document_police_clearance']);
        $types .= 'i';
    }

    if (array_key_exists('document_barangay_clearance', $data)) {
        $updates[] = "document_barangay_clearance = ?";
        $params[] = toTinyInt($data['document_barangay_clearance']);
        $types .= 'i';
    }

    if (array_key_exists('document_birth_certificate', $data)) {
        $updates[] = "document_birth_certificate = ?";
        $params[] = toTinyInt($data['document_birth_certificate']);
        $types .= 'i';
    }

    if (array_key_exists('document_medical_certificate', $data)) {
        $updates[] = "document_medical_certificate = ?";
        $params[] = toTinyInt($data['document_medical_certificate']);
        $types .= 'i';
    }

    if (array_key_exists('document_diploma_tor', $data)) {
        $updates[] = "document_diploma_tor = ?";
        $params[] = toTinyInt($data['document_diploma_tor']);
        $types .= 'i';
    }

    if (array_key_exists('document_employment_contract', $data)) {
        $updates[] = "document_employment_contract = ?";
        $params[] = toTinyInt($data['document_employment_contract']);
        $types .= 'i';
    }

    if (array_key_exists('hire_date', $data)) {
        $hireDate = normalizeDateValue($data['hire_date'], 'hire_date');
        if ($hireDate === null) {
            $updates[] = "hire_date = NULL";
        } else {
            $updates[] = "hire_date = ?";
            $params[] = $hireDate;
            $types .= 's';
        }
    }

    if (array_key_exists('salary', $data)) {
        $salary = parseEmployeeSalary($data['salary'], 0.00);
        $updates[] = "salary = ?";
        $params[] = $salary;
        $types .= 'd';
    }

    if (array_key_exists('status', $data)) {
        $status = normalizeEmployeeStatus($data['status'], 'active');
        $updates[] = "status = ?";
        $params[] = $status;
        $types .= 's';
    }

    if (array_key_exists('branch_id', $data)) {
        $branchId = parseNullableInt($data['branch_id']);
        assertBranchExists($conn, $branchId);
        if ($branchId === null) {
            $updates[] = "branch_id = NULL";
        } else {
            $updates[] = "branch_id = ?";
            $params[] = $branchId;
            $types .= 'i';
        }
    }

    $hasRoleUpdate = array_key_exists('role_ids', $data);
    if (empty($updates) && !$hasRoleUpdate) {
        sendError('No fields to update', 400);
    }

    $identityTouched =
        array_key_exists('first_name', $data) ||
        array_key_exists('last_name', $data) ||
        array_key_exists('date_of_birth', $data);

    if ($identityTouched) {
        assertEmployeeIdentityNotDuplicate($conn, $nextFirstName, $nextLastName, $nextDateOfBirth, $employee_id);
    }

    if (!empty($updates)) {
        $params[] = $employee_id;
        $types .= 'i';

        $sql = "UPDATE employees SET " . implode(', ', $updates) . " WHERE employee_id = ?";
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare employee update.', 500);
        $stmt->bind_param($types, ...$params);

        if (!$stmt->execute()) {
            if ($stmt->errno === 1062) {
                sendError('Employee email already exists.', 409);
            }
            error_log($conn->error);
            sendError('Failed to update employee.', 500);
        }
    }

    if ($hasRoleUpdate) {
        $roleIds = parseRoleIds($data['role_ids']);
        syncEmployeeRoles($conn, $employee_id, $roleIds);
    }

    if ($hasManualUserLink) {
        setManualLinkedUserForEmployee($conn, $employee_id, $manualLinkedUserId);
    }

    $autoCreatedUser = ['user_id' => 0, 'email_sent' => null];
    if (!$hasManualUserLink) {
        $employeeForUserSync = fetchEmployeeRecordById($conn, $employee_id);
        if ($employeeForUserSync) {
            $autoCreatedUser = createLinkedUserFromEmployee($conn, $employee_id, $employeeForUserSync);
        }
    }

    $linkedUserId = syncLinkedUserFromEmployee($conn, $employee_id, !$hasManualUserLink);

    $updatedEmployeeStmt = $conn->prepare("SELECT * FROM employees WHERE employee_id = ? LIMIT 1");
    $updatedEmployee = null;
    if ($updatedEmployeeStmt) {
        $updatedEmployeeStmt->bind_param('i', $employee_id);
        $updatedEmployeeStmt->execute();
        $updatedEmployee = $updatedEmployeeStmt->get_result()->fetch_assoc();
        $updatedEmployeeStmt->close();
    }

    $changedLabels = $updatedEmployee
        ? profileEditCollectChangedLabels($existingEmployee, $updatedEmployee, array_keys($data))
        : [];

    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $user_id, 'update_employee', "Updated employee ID: $employee_id", 'employee_management');
    }

    $actorRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
    $supervisorUpdateEmailPayload = null;
    if (in_array($actorRole, ['admin', 'manager'], true)) {
        $linkedUserStmt = $conn->prepare(
            "SELECT id, username, first_name, last_name, email, role
             FROM users
             WHERE employee_id = ?
             LIMIT 1"
        );
        if ($linkedUserStmt) {
            $linkedUserStmt->bind_param('i', $employee_id);
            $linkedUserStmt->execute();
            $linkedUser = $linkedUserStmt->get_result()->fetch_assoc();
            $linkedUserStmt->close();

            if (
                $linkedUser
                && in_array(strtolower(trim((string)($linkedUser['role'] ?? ''))), ['manager', 'staff'], true)
            ) {
                $actor = profileEditResolveActorSummary($conn, intval($_SESSION['user_id'] ?? 0));
                $supervisorUpdateEmailPayload = [
                    'email' => $linkedUser['email'] ?? '',
                    'name' => profileEditFormatDisplayName($linkedUser['first_name'] ?? '', $linkedUser['last_name'] ?? '', $linkedUser['username'] ?? ''),
                    'actor_name' => $actor['name'] ?? 'Administrator',
                    'actor_role' => $actor['role'] ?? $actorRole,
                    'changed_labels' => $changedLabels,
                    'employee_id' => $employee_id,
                ];
            }
        }
    }

    $responseData = [
        'linked_user_id' => $linkedUserId > 0 ? $linkedUserId : null,
        'auto_created_user_id' => intval($autoCreatedUser['user_id'] ?? 0) > 0 ? intval($autoCreatedUser['user_id']) : null,
        'auto_created_user_email_sent' => $autoCreatedUser['email_sent'],
    ];

    if (
        $supervisorUpdateEmailPayload !== null
        || (!empty($autoCreatedUser['email_payload']) && is_array($autoCreatedUser['email_payload']))
    ) {
        $onboardingEmailPayload = (!empty($autoCreatedUser['email_payload']) && is_array($autoCreatedUser['email_payload']))
            ? $autoCreatedUser['email_payload']
            : null;

        sendResponseAndContinue(true, $responseData, 'Employee updated successfully', 200, function () use ($supervisorUpdateEmailPayload, $onboardingEmailPayload) {
            if ($onboardingEmailPayload !== null) {
                $sent = sendEmployeeOnboardingEmail(
                    $onboardingEmailPayload['email'],
                    $onboardingEmailPayload['full_name'],
                    $onboardingEmailPayload['temporary_password'],
                    $onboardingEmailPayload['role']
                );

                if (!$sent) {
                    error_log('Employee onboarding email failed for employee_id=' . $onboardingEmailPayload['employee_id'] . ', email=' . $onboardingEmailPayload['email']);
                }
            }

            if ($supervisorUpdateEmailPayload !== null) {
                $emailSent = profileEditSendSupervisorUpdateEmail(
                    $supervisorUpdateEmailPayload['email'],
                    $supervisorUpdateEmailPayload['name'],
                    $supervisorUpdateEmailPayload['actor_name'],
                    $supervisorUpdateEmailPayload['actor_role'],
                    $supervisorUpdateEmailPayload['changed_labels']
                );

                if (!$emailSent) {
                    error_log('Failed to send employee update email for employee_id=' . $supervisorUpdateEmailPayload['employee_id']);
                }
            }
        });
    }

    sendResponse(true, $responseData, 'Employee updated successfully');
}

/**
 * DELETE - Delete employee (soft delete)
 */
function handleDelete($conn) {
    $employee_id = $_GET['id'] ?? null;

    if (!$employee_id) {
        sendError('Employee ID is required', 400);
    }

    $employee_id = intval($employee_id);
    if ($employee_id <= 0) sendError('Invalid employee ID.', 400);

    $sql = "UPDATE employees SET status = 'terminated' WHERE employee_id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare employee termination.', 500);
    $stmt->bind_param('i', $employee_id);

    if ($stmt->execute()) {
        $linkedUserId = syncLinkedUserFromEmployee($conn, $employee_id);

        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'delete_employee', "Terminated employee ID: $employee_id", 'employee_management');
        }

        sendResponse(
            true,
            ['linked_user_id' => $linkedUserId > 0 ? $linkedUserId : null],
            'Employee terminated successfully'
        );
    } else {
        error_log($conn->error);
        sendError('Failed to terminate employee.', 500);
    }
}

closeDBConnection($conn);
?>
