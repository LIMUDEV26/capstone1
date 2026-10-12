<?php
/**
 * Users API
 * Handles CRUD operations for users
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'edit_request_utils.php';
require_once 'password_policy_utils.php';
require_once 'mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

// RBAC: Enforce authentication for all user management operations
requireAuth();
runRuntimeSchemaUpgradeOnce('users_employment_schema_v20261012_storage', function () use ($conn) {
    ensureEmploymentSchema($conn);
    ensurePasswordPolicySchema($conn);
    ensureTableIndex(
        $conn,
        'users',
        'idx_users_email',
        "ALTER TABLE users ADD INDEX idx_users_email (email)"
    );
}, 86400);

ensurePasswordPolicySchema($conn);

switch ($method) {
    case 'GET':
        $getAction = $_GET['action'] ?? '';
        if ($getAction === 'locked') {
            requireRole(['admin']);
            handleGetLocked($conn);
        } else {
            // All authenticated users can view (staff see limited data in handler)
            handleGet($conn);
        }
        break;
    case 'POST':
        $postAction = $_GET['action'] ?? '';
        if ($postAction === 'unlock') {
            requireRole(['admin']);
            handleUnlock($conn);
        } elseif ($postAction === 'restore') {
            requireRole(['admin']);
            handleRestoreUser($conn);
        } else {
            // Only admin can create users
            requireRole(['admin']);
            handlePost($conn);
        }
        break;
    case 'PUT':
        // Admin can update anyone; staff can only update own profile (enforced in handler)
        handlePut($conn);
        break;
    case 'DELETE':
        // Only admin can delete users
        requireRole(['admin']);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

/**
 * Ensure required user/employment-related columns exist.
 */
function ensureEmploymentSchema($conn) {
    // users table fields
    ensureColumn($conn, 'users', 'photo', '`photo` VARCHAR(255) NULL');
    ensureColumn($conn, 'users', 'sss_number', '`sss_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'users', 'pagibig_number', '`pagibig_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'users', 'philhealth_number', '`philhealth_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'users', 'tin_number', '`tin_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'users', 'mobile_number', '`mobile_number` VARCHAR(20) NULL');
    ensureColumn($conn, 'users', 'document_resume', '`document_resume` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_nbi_clearance', '`document_nbi_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_police_clearance', '`document_police_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_barangay_clearance', '`document_barangay_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_birth_certificate', '`document_birth_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_medical_certificate', '`document_medical_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_diploma_tor', '`document_diploma_tor` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'document_employment_contract', '`document_employment_contract` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'reset_token_hash', '`reset_token_hash` VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'reset_token_expires', '`reset_token_expires` DATETIME NULL');
    ensureColumn($conn, 'users', 'must_reset_password', '`must_reset_password` TINYINT(1) NOT NULL DEFAULT 0');

    // employees table fields (for synchronization with linked employee records)
    ensureColumn($conn, 'employees', 'profile_photo', '`profile_photo` VARCHAR(255) NULL');
    ensureColumn($conn, 'employees', 'sss_number', '`sss_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'employees', 'pagibig_number', '`pagibig_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'employees', 'philhealth_number', '`philhealth_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'employees', 'tin_number', '`tin_number` VARCHAR(30) NULL');
    ensureColumn($conn, 'employees', 'document_resume', '`document_resume` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_nbi_clearance', '`document_nbi_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_police_clearance', '`document_police_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_barangay_clearance', '`document_barangay_clearance` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_birth_certificate', '`document_birth_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_medical_certificate', '`document_medical_certificate` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_diploma_tor', '`document_diploma_tor` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'document_employment_contract', '`document_employment_contract` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'employees', 'salary', '`salary` DECIMAL(12,2) NOT NULL DEFAULT 0.00');
    ensureColumn($conn, 'employees', 'storage_deleted_at', '`storage_deleted_at` DATETIME NULL');
    ensureColumn($conn, 'employees', 'department', '`department` VARCHAR(100) NULL');
    ensureColumn($conn, 'employees', 'employment_type', "`employment_type` VARCHAR(50) NOT NULL DEFAULT 'Full-Time'");
    if (function_exists('ensureUserStatusEnum')) {
        ensureUserStatusEnum($conn);
    }
}

/**
 * Add a column only if it does not exist.
 */
function ensureColumn($conn, $table, $column, $definition) {
    $dbName = DB_NAME;
    $checkSql = "SELECT 1
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
                 LIMIT 1";
    $checkStmt = $conn->prepare($checkSql);
    if (!$checkStmt) {
        return;
    }
    $checkStmt->bind_param('sss', $dbName, $table, $column);
    $checkStmt->execute();
    $exists = $checkStmt->get_result()->num_rows > 0;
    $checkStmt->close();

    if (!$exists) {
        $conn->query("ALTER TABLE `$table` ADD COLUMN $definition");
    }
}

function normalizeNullableString($value, $maxLen = 255) {
    if (!isset($value)) return null;
    $str = trim((string)$value);
    if ($str === '') return null;
    $str = sanitizeInput($str);
    if (strlen($str) > $maxLen) $str = substr($str, 0, $maxLen);
    return $str;
}

function normalizePersonName($value, $maxLen = 50) {
    $str = trim((string)$value);
    if ($str === '') return '';
    $str = preg_replace('/\s+/', ' ', $str);
    $str = sanitizeInput($str);
    if (strlen($str) > $maxLen) $str = substr($str, 0, $maxLen);
    return $str;
}

function normalizeEmailIdentifier($value) {
    $email = strtolower(trim((string)$value));
    if ($email === '') return '';
    return sanitizeInput($email);
}

function buildUsernameBaseFromEmail($email) {
    $normalized = normalizeEmailIdentifier($email);
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

function generateUniqueUsernameFromEmail($conn, $email) {
    $base = buildUsernameBaseFromEmail($email);

    for ($attempt = 0; $attempt < 1000; $attempt++) {
        if ($attempt === 0) {
            $candidate = $base;
        } else {
            $suffix = '_' . (string)$attempt;
            $maxBaseLen = 50 - strlen($suffix);
            if ($maxBaseLen < 1) $maxBaseLen = 1;
            $candidate = substr($base, 0, $maxBaseLen) . $suffix;
        }

        $check = $conn->prepare("SELECT id FROM users WHERE username = ? LIMIT 1");
        if (!$check) {
            sendError('Failed to validate generated username', 500);
        }
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

function ensureUniqueFullName($conn, $firstName, $lastName, $excludeUserId = null) {
    $first = normalizePersonName($firstName, 50);
    $last = normalizePersonName($lastName, 50);
    if ($first === '' || $last === '') return;

    if ($excludeUserId !== null) {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
               AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
               AND id <> ?
             LIMIT 1"
        );
        $id = intval($excludeUserId);
        $stmt->bind_param('ssi', $first, $last, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
               AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        $stmt->bind_param('ss', $first, $last);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('A user with the same first name and last name already exists.', 409);
    }
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
    $canonical = canonicalizeGovernmentNumber($value, 30);
    if ($canonical === null) return;

    $sql = "SELECT {$idColumn}
            FROM {$table}
            WHERE {$field} IS NOT NULL
              AND REPLACE(UPPER(TRIM({$field})), '-', '') = ?";

    if ($excludeId !== null && intval($excludeId) > 0) {
        $sql .= " AND {$idColumn} <> ?";
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

function toTinyInt($value) {
    if (is_bool($value)) return $value ? 1 : 0;
    if (is_numeric($value)) return intval($value) > 0 ? 1 : 0;
    if (is_string($value)) {
        $v = strtolower(trim($value));
        return in_array($v, ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
    }
    return 0;
}

function parseNullableInt($value) {
    if (!isset($value) || $value === '') return null;
    if (!is_numeric($value)) return null;
    $n = intval($value);
    return $n > 0 ? $n : null;
}

function parseSalaryAmount($value, $default = 0.00) {
    if (!isset($value) || $value === '') {
        return round((float)$default, 2);
    }
    if (!is_numeric($value)) {
        sendError('Salary must be a valid number.', 400);
    }
    $salary = round((float)$value, 2);
    if ($salary < 0) {
        sendError('Salary cannot be negative.', 400);
    }
    return $salary;
}


function isAtLeastMinimumAge($dateOfBirth, $minimumAge = 18) {
    if (!validateDate($dateOfBirth)) return false;

    $birthDate = DateTime::createFromFormat('Y-m-d', $dateOfBirth);
    if (!$birthDate) return false;
    $birthDate->setTime(0, 0, 0);

    $cutoff = new DateTime('today');
    $cutoff->modify('-' . intval($minimumAge) . ' years');
    $cutoff->setTime(0, 0, 0);

    return $birthDate <= $cutoff;
}

function mapUserStatusToEmployeeStatus($userStatus) {
    $status = strtolower(trim((string)$userStatus));
    return $status === 'active' ? 'active' : 'inactive';
}

function findEmployeeIdByEmail($conn, $email) {
    $normalizedEmail = normalizeNullableString($email, 100);
    if ($normalizedEmail === null) return 0;

    $stmt = $conn->prepare("SELECT employee_id FROM employees WHERE email = ? LIMIT 1");
    if (!$stmt) return 0;
    $stmt->bind_param('s', $normalizedEmail);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return intval($row['employee_id'] ?? 0);
}

function assertEmployeeExists($conn, $employeeId) {
    $id = intval($employeeId);
    if ($id <= 0) sendError('Invalid employee ID.', 400);

    $stmt = $conn->prepare("SELECT employee_id FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to validate employee.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        sendError('Selected employee not found.', 404);
    }
}

function assertBranchExistsForUser($conn, $branchId) {
    $id = intval($branchId);
    if ($id <= 0) sendError('Invalid branch ID.', 400);

    $stmt = $conn->prepare("SELECT branch_id FROM branches WHERE branch_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to validate branch.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        sendError('Selected branch not found.', 404);
    }
}

function assertManagerBranchAvailability($conn, $role, $branchId, $excludeUserId = null) {
    $normalizedRole = strtolower(trim((string)$role));
    $resolvedBranchId = parseNullableInt($branchId);

    if ($normalizedRole !== 'manager' || $resolvedBranchId === null) {
        return;
    }

    assertBranchExistsForUser($conn, $resolvedBranchId);

    if ($excludeUserId !== null && intval($excludeUserId) > 0) {
        $excludeId = intval($excludeUserId);
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(role)) = 'manager'
               AND branch_id = ?
               AND id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate branch manager assignment.', 500);
        $stmt->bind_param('ii', $resolvedBranchId, $excludeId);
    } else {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(role)) = 'manager'
               AND branch_id = ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate branch manager assignment.', 500);
        $stmt->bind_param('i', $resolvedBranchId);
    }

    $stmt->execute();
    $hasExistingManager = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($hasExistingManager) {
        sendError('This branch already has a manager assigned. Only one manager is allowed per branch.', 409);
    }
}

function assertEmployeeLinkAvailableForUser($conn, $employeeId, $excludeUserId = null) {
    $id = intval($employeeId);
    if ($id <= 0) return;

    assertEmployeeExists($conn, $id);

    if ($excludeUserId !== null && intval($excludeUserId) > 0) {
        $excludeId = intval($excludeUserId);
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE employee_id = ?
               AND id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate employee link.', 500);
        $stmt->bind_param('ii', $id, $excludeId);
    } else {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE employee_id = ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate employee link.', 500);
        $stmt->bind_param('i', $id);
    }

    $stmt->execute();
    $alreadyLinked = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($alreadyLinked) {
        sendError('Selected employee is already linked to another user. Unlink it first.', 409);
    }
}

function ensureLinkedEmployeeForUser($conn, $userId, $salary = 0.00) {
    $snapshotStmt = $conn->prepare(
        "SELECT first_name, last_name, date_of_birth, email, role, status, branch_id
         FROM users
         WHERE id = ?
         LIMIT 1"
    );
    if (!$snapshotStmt) return 0;

    $snapshotStmt->bind_param('i', $userId);
    $snapshotStmt->execute();
    $snapshot = $snapshotStmt->get_result()->fetch_assoc();
    $snapshotStmt->close();
    if (!$snapshot) return 0;

    $email = normalizeNullableString($snapshot['email'] ?? null, 100);
    $existingEmployeeId = findEmployeeIdByEmail($conn, $email);
    if ($existingEmployeeId > 0) return $existingEmployeeId;

    $employeeDateId = generateUniqueID('EMP-');
    $firstName = normalizePersonName($snapshot['first_name'] ?? '', 50);
    $lastName = normalizePersonName($snapshot['last_name'] ?? '', 50);
    if ($firstName === '') $firstName = 'Employee';
    if ($lastName === '') $lastName = 'User';

    $dateOfBirth = normalizeNullableString($snapshot['date_of_birth'] ?? null, 10);
    $position = ucfirst(strtolower(trim((string)($snapshot['role'] ?? 'staff'))));
    $hireDate = date('Y-m-d');
    $employeeStatus = mapUserStatusToEmployeeStatus($snapshot['status'] ?? 'active');
    $branchId = parseNullableInt($snapshot['branch_id'] ?? null);
    $safeSalary = max(0, round((float)$salary, 2));

    if ($branchId !== null) {
        $sql = "INSERT INTO employees (employee_date_id, first_name, last_name, date_of_birth, email, position, hire_date, salary, status, branch_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        $stmt = $conn->prepare($sql);
        if (!$stmt) return 0;
        $stmt->bind_param(
            'sssssssdsi',
            $employeeDateId,
            $firstName,
            $lastName,
            $dateOfBirth,
            $email,
            $position,
            $hireDate,
            $safeSalary,
            $employeeStatus,
            $branchId
        );
    } else {
        $sql = "INSERT INTO employees (employee_date_id, first_name, last_name, date_of_birth, email, position, hire_date, salary, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        $stmt = $conn->prepare($sql);
        if (!$stmt) return 0;
        $stmt->bind_param(
            'sssssssds',
            $employeeDateId,
            $firstName,
            $lastName,
            $dateOfBirth,
            $email,
            $position,
            $hireDate,
            $safeSalary,
            $employeeStatus
        );
    }

    $ok = $stmt->execute();
    $newId = intval($conn->insert_id);
    $stmt->close();

    if ($ok && $newId > 0) return $newId;

    $fallbackId = findEmployeeIdByEmail($conn, $email);
    if ($fallbackId > 0) return $fallbackId;
    return 0;
}

function syncEmployeeSalary($conn, $employeeId, $salary) {
    $id = intval($employeeId);
    if ($id <= 0) return;

    $safeSalary = max(0, round((float)$salary, 2));
    $stmt = $conn->prepare("UPDATE employees SET salary = ? WHERE employee_id = ?");
    if (!$stmt) return;
    $stmt->bind_param('di', $safeSalary, $id);
    $stmt->execute();
    $stmt->close();
}

function syncEmployeeAddress($conn, $employeeId, $address) {
    $id = intval($employeeId);
    if ($id <= 0) return;

    $safeAddress = normalizeNullableString($address, 255);
    if ($safeAddress === null) {
        $stmt = $conn->prepare("UPDATE employees SET address = NULL WHERE employee_id = ?");
        if (!$stmt) return;
        $stmt->bind_param('i', $id);
    } else {
        $stmt = $conn->prepare("UPDATE employees SET address = ? WHERE employee_id = ?");
        if (!$stmt) return;
        $stmt->bind_param('si', $safeAddress, $id);
    }
    $stmt->execute();
    $stmt->close();
}

function sanitizeFilenameBase($filename) {
    $base = pathinfo((string)$filename, PATHINFO_FILENAME);
    $base = preg_replace('/[^A-Za-z0-9_-]/', '_', $base);
    $base = trim((string)$base, '_');
    if ($base === '') $base = 'profile';
    return substr($base, 0, 50);
}

/**
 * Save a base64 profile photo and return relative web path.
 */
function saveUserPhotoUpload($uploadPayload) {
    $dataUrl = '';
    $nameHint = '';

    if (is_array($uploadPayload)) {
        $dataUrl = (string)($uploadPayload['data_url'] ?? '');
        $nameHint = (string)($uploadPayload['name'] ?? '');
    } elseif (is_string($uploadPayload)) {
        $dataUrl = trim($uploadPayload);
    }

    if ($dataUrl === '') sendError('Profile picture upload is empty', 400);

    if (!preg_match('/^data:image\/(png|jpe?g|webp);base64,/i', $dataUrl, $m)) {
        sendError('Profile picture must be PNG, JPG, or WEBP', 400);
    }

    $ext = strtolower($m[1]);
    if ($ext === 'jpeg') $ext = 'jpg';

    $base64 = substr($dataUrl, strpos($dataUrl, ',') + 1);
    $binary = base64_decode($base64, true);
    if ($binary === false) sendError('Invalid profile picture encoding', 400);

    $maxBytes = 5 * 1024 * 1024;
    if (strlen($binary) > $maxBytes) sendError('Profile picture must be 5MB or less', 400);

    $projectRoot = realpath(__DIR__ . DIRECTORY_SEPARATOR . '..');
    if ($projectRoot === false) sendError('Failed to resolve upload path', 500);

    $relativeDir = 'uploads/profile-photos';
    $uploadDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) {
        sendError('Failed to create upload directory', 500);
    }

    $safeBase = sanitizeFilenameBase($nameHint);
    try {
        $rand = bin2hex(random_bytes(4));
    } catch (Exception $e) {
        $rand = substr(md5(uniqid((string)mt_rand(), true)), 0, 8);
    }
    $filename = $safeBase . '_' . date('YmdHis') . '_' . $rand . '.' . $ext;
    $fullPath = $uploadDir . DIRECTORY_SEPARATOR . $filename;

    if (file_put_contents($fullPath, $binary) === false) sendError('Failed to save profile picture', 500);

    return '/' . $relativeDir . '/' . $filename;
}

function removeManagedUserPhoto($photoPath) {
    $path = trim((string)$photoPath);
    if ($path === '') return;
    if (preg_match('/^https?:\/\//i', $path) || strpos($path, 'data:') === 0) return;

    $normalized = str_replace('\\', '/', $path);
    $normalized = ltrim($normalized, '/');
    if (strpos($normalized, 'capstone1/') === 0) {
        $normalized = substr($normalized, strlen('capstone1/'));
    }
    if (strpos($normalized, 'uploads/profile-photos/') !== 0) return;

    $projectRoot = realpath(__DIR__ . DIRECTORY_SEPARATOR . '..');
    if ($projectRoot === false) return;

    $fullPath = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $normalized);
    if (is_file($fullPath)) @unlink($fullPath);
}

function getDocumentFieldNames() {
    return [
        'document_resume',
        'document_nbi_clearance',
        'document_police_clearance',
        'document_barangay_clearance',
        'document_birth_certificate',
        'document_medical_certificate',
        'document_diploma_tor',
        'document_employment_contract',
    ];
}

function buildFrontendBaseUrl() {
    $frontendBase = '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    if ($referer) {
        $parsed = parse_url($referer);
        if ($parsed && isset($parsed['host'])) {
            $port = isset($parsed['port']) ? ':' . $parsed['port'] : '';
            $scheme = $parsed['scheme'] ?? 'http';
            $frontendBase = $scheme . '://' . $parsed['host'] . $port;
        }
    }

    if (!$frontendBase) {
        $configuredFrontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
        if ($configuredFrontendBase !== '') {
            $frontendBase = $configuredFrontendBase;
        } else {
            $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
            $scheme = $isHttps ? 'https' : 'http';
            $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
            $frontendBase = $scheme . '://' . $host;
        }
    }

    return rtrim($frontendBase, '/');
}

function generateRandomTemporaryPassword($length = 12) {
    $len = max(10, min(32, (int)$length));
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $lower = 'abcdefghijkmnopqrstuvwxyz';
    $digits = '23456789';
    $symbols = '!@#$%*+-_';
    $all = $upper . $lower . $digits . $symbols;

    $chars = [];
    $chars[] = $upper[random_int(0, strlen($upper) - 1)];
    $chars[] = $lower[random_int(0, strlen($lower) - 1)];
    $chars[] = $digits[random_int(0, strlen($digits) - 1)];
    $chars[] = $symbols[random_int(0, strlen($symbols) - 1)];

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

/**
 * Generate onboarding password: LastName + Birthdate (MMDDYYYY) + 1 symbol.
 * Falls back to a random password when birthdate is missing.
 */
function generateOnboardingPassword($lastName, $dateOfBirth) {
    $symbols = '!@#$%*+-_';
    $symbol  = $symbols[random_int(0, strlen($symbols) - 1)];

    // Strip spaces/hyphens from last name and capitalise first letter only
    $namePart = preg_replace('/\s+/', '', (string)$lastName);
    $namePart = ucfirst(strtolower($namePart));

    // Format birthdate as MMDDYYYY when available (input is YYYY-MM-DD)
    $datePart = '';
    if ($dateOfBirth && preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $dateOfBirth, $m)) {
        $datePart = $m[2] . $m[3] . $m[1]; // MM DD YYYY
    }

    if ($namePart !== '' && $datePart !== '') {
        return $namePart . $datePart . $symbol;
    }

    // Fallback: no birthdate supplied — use random password
    return generateRandomTemporaryPassword(12);
}

function markFirstLoginPasswordChangeRequired($conn, $userId) {
    $stmt = $conn->prepare(
        "UPDATE users
         SET must_reset_password = 1,
             reset_token_hash = NULL,
             reset_token_expires = NULL
         WHERE id = ?"
    );
    $stmt->bind_param('i', $userId);
    if (!$stmt->execute()) {
        sendError('Failed to mark first-login password change requirement', 500);
    }
    $stmt->close();
}

function getEmploymentSelectColumns() {
    return "u.id, u.username, u.email, u.first_name, u.last_name, u.date_of_birth, u.role, u.status, u.created_at,
            u.password_changed_at, u.password_expires_at,
            u.photo, u.sss_number, u.pagibig_number, u.philhealth_number, u.tin_number, u.mobile_number,
            u.document_resume, u.document_nbi_clearance, u.document_police_clearance, u.document_barangay_clearance,
            u.document_birth_certificate, u.document_medical_certificate, u.document_diploma_tor, u.document_employment_contract,
            u.branch_id, u.employee_id,
            b.branch_name,
            CONCAT(e.first_name, ' ', e.last_name) as employee_name,
            e.salary as salary,
            e.address as address,
            e.storage_deleted_at as employee_storage_deleted_at";
}

function getDocumentSelectColumns() {
    return "u.id,
            u.document_resume,
            u.document_nbi_clearance,
            u.document_police_clearance,
            u.document_barangay_clearance,
            u.document_birth_certificate,
            u.document_medical_certificate,
            u.document_diploma_tor,
            u.document_employment_contract";
}

function syncLinkedEmployeeFromUser($conn, $userId, $employeeId) {
    if (!$employeeId) return;

    $snapshotSql = "SELECT first_name, last_name, date_of_birth, email, photo,
                           sss_number, pagibig_number, philhealth_number, tin_number,
                           document_resume, document_nbi_clearance, document_police_clearance, document_barangay_clearance,
                           document_birth_certificate, document_medical_certificate, document_diploma_tor, document_employment_contract
                    FROM users
                    WHERE id = ?
                    LIMIT 1";
    $snapshotStmt = $conn->prepare($snapshotSql);
    if (!$snapshotStmt) return;

    $snapshotStmt->bind_param('i', $userId);
    $snapshotStmt->execute();
    $snapshot = $snapshotStmt->get_result()->fetch_assoc();
    $snapshotStmt->close();

    if (!$snapshot) return;

    $sql = "UPDATE employees
            SET first_name = ?, last_name = ?, date_of_birth = ?, email = ?,
                profile_photo = ?, sss_number = ?, pagibig_number = ?, philhealth_number = ?, tin_number = ?,
                document_resume = ?, document_nbi_clearance = ?, document_police_clearance = ?, document_barangay_clearance = ?,
                document_birth_certificate = ?, document_medical_certificate = ?, document_diploma_tor = ?, document_employment_contract = ?
            WHERE employee_id = ?";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return;

    $first_name = normalizeNullableString($snapshot['first_name'] ?? null, 50);
    // Employees can have no family name; store an empty string so this sync
    // works with schemas where employees.last_name is NOT NULL.
    $last_name = normalizePersonName($snapshot['last_name'] ?? '', 50);
    $date_of_birth = normalizeNullableString($snapshot['date_of_birth'] ?? null, 10);
    $email = normalizeNullableString($snapshot['email'] ?? null, 100);
    $photo = normalizeNullableString($snapshot['photo'] ?? null, 255);
    $sss = normalizeGovernmentNumber($snapshot['sss_number'] ?? null, 30);
    $pagibig = normalizeGovernmentNumber($snapshot['pagibig_number'] ?? null, 30);
    $philhealth = normalizeGovernmentNumber($snapshot['philhealth_number'] ?? null, 30);
    $tin = normalizeGovernmentNumber($snapshot['tin_number'] ?? null, 30);
    assertGovernmentNumbersUniqueForEmployees($conn, [
        'sss_number' => $sss,
        'pagibig_number' => $pagibig,
        'philhealth_number' => $philhealth,
        'tin_number' => $tin,
    ], $employeeId);

    $d1 = toTinyInt($snapshot['document_resume'] ?? 0);
    $d2 = toTinyInt($snapshot['document_nbi_clearance'] ?? 0);
    $d3 = toTinyInt($snapshot['document_police_clearance'] ?? 0);
    $d4 = toTinyInt($snapshot['document_barangay_clearance'] ?? 0);
    $d5 = toTinyInt($snapshot['document_birth_certificate'] ?? 0);
    $d6 = toTinyInt($snapshot['document_medical_certificate'] ?? 0);
    $d7 = toTinyInt($snapshot['document_diploma_tor'] ?? 0);
    $d8 = toTinyInt($snapshot['document_employment_contract'] ?? 0);

    $stmt->bind_param(
        'sssssssssiiiiiiiii',
        $first_name,
        $last_name,
        $date_of_birth,
        $email,
        $photo,
        $sss,
        $pagibig,
        $philhealth,
        $tin,
        $d1,
        $d2,
        $d3,
        $d4,
        $d5,
        $d6,
        $d7,
        $d8,
        $employeeId
    );
    // Best-effort sync; don't fail user operation if employee sync fails.
    $stmt->execute();
    $stmt->close();
}

/**
 * GET - Retrieve users
 */
function handleGet($conn) {
    $selectCols = getEmploymentSelectColumns();
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    $isStaff = $role === 'staff';
    $documentsOnly = filter_var($_GET['documents_only'] ?? false, FILTER_VALIDATE_BOOLEAN);

    if (isset($_GET['id'])) {
        $id = intval($_GET['id']);
        if ($isStaff && $id !== $currentUserId) {
            sendError('Staff can only view their own account.', 403);
        }

        if ($documentsOnly) {
            $documentCols = getDocumentSelectColumns();
            $sql = "SELECT $documentCols
                    FROM users u
                    WHERE u.id = ?";
        } else {
            $sql = "SELECT $selectCols
                    FROM users u
                    LEFT JOIN branches b ON u.branch_id = b.branch_id
                    LEFT JOIN employees e ON u.employee_id = e.employee_id
                    WHERE u.id = ?";
        }
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $id);
        $stmt->execute();
        $result = $stmt->get_result();

        if ($row = $result->fetch_assoc()) sendResponse(true, $row, 'User retrieved successfully');
        sendError('User not found', 404);
    }

    $sql = "SELECT $selectCols
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            LEFT JOIN employees e ON u.employee_id = e.employee_id";

    $params = [];
    $types = '';
    $where = [];

    if (!empty($_GET['role'])) {
        $where[] = "u.role = ?";
        $params[] = sanitizeInput($_GET['role']);
        $types .= 's';
    }
    if (!empty($_GET['status'])) {
        $where[] = "u.status = ?";
        $params[] = sanitizeInput($_GET['status']);
        $types .= 's';
    }
    if ($isStaff) {
        $where[] = "u.id = ?";
        $params[] = $currentUserId;
        $types .= 'i';
    }

    if (!empty($where)) $sql .= " WHERE " . implode(' AND ', $where);
    $sql .= " ORDER BY
                LOWER(TRIM(COALESCE(u.first_name, ''))) ASC,
                LOWER(TRIM(COALESCE(u.last_name, ''))) ASC,
                LOWER(TRIM(COALESCE(u.username, ''))) ASC,
                u.id ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    $users = [];
    while ($row = $result->fetch_assoc()) $users[] = $row;

    sendResponse(true, $users, 'Users retrieved successfully');
}

/**
 * POST - Create new user
 */
function handlePost($conn) {
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot create users', 403);
    }

    $data = getJSONInput();
    $required = ['email', 'first_name', 'last_name', 'role'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $email = normalizeEmailIdentifier($data['email']);
    $role = strtolower(trim((string)sanitizeInput($data['role'])));
    $isOnboardedRole = in_array($role, ['manager', 'staff'], true);
    $mustResetPassword = $isOnboardedRole ? 1 : 0;
    $passwordPolicy = getPasswordPolicy($conn);
    $passwordChangedAt = date('Y-m-d H:i:s');
    $passwordExpiresAt = date('Y-m-d H:i:s', time() + ($passwordPolicy['max_age_days'] * 86400));

    if (!validateGmailComEmail($email)) sendError('Email must be a valid @gmail.com or @phinmaed.com address', 400);

    $check_sql = "SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('s', $email);
    $check_stmt->execute();
    if ($check_stmt->get_result()->num_rows > 0) sendError('Email already exists', 409);

    $username = generateUniqueUsernameFromEmail($conn, $email);

    $first_name = normalizePersonName($data['first_name'], 50);
    $last_name = normalizePersonName($data['last_name'], 50);
    if ($first_name === '' || $last_name === '') {
        sendError('First name and last name are required.', 400);
    }
    ensureUniqueFullName($conn, $first_name, $last_name, null);
    $date_of_birth = normalizeNullableString($data['date_of_birth'] ?? null, 10);
    if ($date_of_birth !== null) {
        if (!validateDate($date_of_birth)) {
            sendError('Invalid date_of_birth format. Expected YYYY-MM-DD', 400);
        }
        if (!isAtLeastMinimumAge($date_of_birth, 18)) {
            sendError('User must be at least 18 years old.', 400);
        }
    }

    $plainPasswordInput = trim((string)($data['password'] ?? ''));
    $temporaryPassword = null;
    if ($isOnboardedRole) {
        $temporaryPassword = generateOnboardingPassword($last_name, $date_of_birth);
        $password = hashPassword($temporaryPassword);
    } else {
        if ($plainPasswordInput === '') {
            sendError('Password is required for this role.', 400);
        }
        if (strlen($plainPasswordInput) < 8) {
            sendError('Password must be at least 8 characters', 400);
        }
        if (!preg_match('/[A-Z]/', $plainPasswordInput)) {
            sendError('Password must contain at least one uppercase letter', 400);
        }
        if (!preg_match('/[0-9]/', $plainPasswordInput)) {
            sendError('Password must contain at least one number', 400);
        }
        if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $plainPasswordInput)) {
            sendError('Password must contain at least one special character', 400);
        }
        $password = hashPassword($plainPasswordInput);
    }
    $status = $data['status'] ?? 'active';
    $branch_id = parseNullableInt($data['branch_id'] ?? null);
    if ($branch_id !== null) {
        assertBranchExistsForUser($conn, $branch_id);
    }
    assertManagerBranchAvailability($conn, $role, $branch_id);
    $hasEmployeeField = array_key_exists('employee_id', $data);
    $employee_id = parseNullableInt($data['employee_id'] ?? null);
    if ($employee_id !== null) {
        assertEmployeeLinkAvailableForUser($conn, $employee_id);
    }
    $salaryProvided = array_key_exists('salary', $data);
    $salary = parseSalaryAmount($data['salary'] ?? 0.00, 0.00);
    $address = normalizeNullableString($data['address'] ?? null, 255);

    $photo = normalizeNullableString($data['photo'] ?? null, 255);
    if (!empty($data['photo_upload'])) $photo = saveUserPhotoUpload($data['photo_upload']);

    $sss_number = normalizeGovernmentNumber($data['sss_number'] ?? null, 30);
    $pagibig_number = normalizeGovernmentNumber($data['pagibig_number'] ?? null, 30);
    $philhealth_number = normalizeGovernmentNumber($data['philhealth_number'] ?? null, 30);
    $tin_number = normalizeGovernmentNumber($data['tin_number'] ?? null, 30);
    assertDistinctGovernmentNumbers($sss_number, $pagibig_number, $philhealth_number, $tin_number);
    assertGovernmentNumbersUniqueForUsers($conn, [
        'sss_number' => $sss_number,
        'pagibig_number' => $pagibig_number,
        'philhealth_number' => $philhealth_number,
        'tin_number' => $tin_number,
    ]);
    $matchedEmployeeIdByEmail = findEmployeeIdByEmail($conn, $email);
    $employeeGovernmentExcludeId = $employee_id ?? ($matchedEmployeeIdByEmail > 0 ? $matchedEmployeeIdByEmail : null);
    assertGovernmentNumbersUniqueForEmployees($conn, [
        'sss_number' => $sss_number,
        'pagibig_number' => $pagibig_number,
        'philhealth_number' => $philhealth_number,
        'tin_number' => $tin_number,
    ], $employeeGovernmentExcludeId);

    $docResume = toTinyInt($data['document_resume'] ?? 0);
    $docNbi = toTinyInt($data['document_nbi_clearance'] ?? 0);
    $docPolice = toTinyInt($data['document_police_clearance'] ?? 0);
    $docBarangay = toTinyInt($data['document_barangay_clearance'] ?? 0);
    $docBirth = toTinyInt($data['document_birth_certificate'] ?? 0);
    $docMedical = toTinyInt($data['document_medical_certificate'] ?? 0);
    $docDiploma = toTinyInt($data['document_diploma_tor'] ?? 0);
    $docContract = toTinyInt($data['document_employment_contract'] ?? 0);

    $columns = [
        'username', 'password', 'email', 'first_name', 'last_name', 'date_of_birth', 'role', 'status',
        'must_reset_password', 'password_changed_at', 'password_expires_at',
        'photo', 'sss_number', 'pagibig_number', 'philhealth_number', 'tin_number',
        'document_resume', 'document_nbi_clearance', 'document_police_clearance', 'document_barangay_clearance',
        'document_birth_certificate', 'document_medical_certificate', 'document_diploma_tor', 'document_employment_contract',
        'created_at'
    ];
    $placeholders = [
        '?', '?', '?', '?', '?', '?', '?', '?',
        '?', '?', '?',
        '?', '?', '?', '?', '?',
        '?', '?', '?', '?',
        '?', '?', '?', '?',
        'NOW()'
    ];
    // Match the insert parameters: 8 leading strings, the reset flag integer,
    // 7 profile/date strings, then the 8 document checklist integers.
    $types = 'ssssssssisssssssiiiiiiii';
    $params = [
        $username, $password, $email, $first_name, $last_name, $date_of_birth, $role, $status,
        $mustResetPassword, $passwordChangedAt, $passwordExpiresAt,
        $photo, $sss_number, $pagibig_number, $philhealth_number, $tin_number,
        $docResume, $docNbi, $docPolice, $docBarangay, $docBirth, $docMedical, $docDiploma, $docContract
    ];

    if ($branch_id !== null) {
        $columns[] = 'branch_id';
        $placeholders[] = '?';
        $types .= 'i';
        $params[] = $branch_id;
    }
    if ($employee_id !== null) {
        $columns[] = 'employee_id';
        $placeholders[] = '?';
        $types .= 'i';
        $params[] = $employee_id;
    }

    $sql = "INSERT INTO users (" . implode(', ', $columns) . ") VALUES (" . implode(', ', $placeholders) . ")";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        $newUserId = intval($conn->insert_id);
        $linkedEmployeeId = intval($employee_id ?? 0);

        if ($linkedEmployeeId <= 0 && $isOnboardedRole && !$hasEmployeeField) {
            $linkedEmployeeId = ensureLinkedEmployeeForUser($conn, $newUserId, $salary);
            if ($linkedEmployeeId > 0) {
                $linkStmt = $conn->prepare("UPDATE users SET employee_id = ? WHERE id = ? LIMIT 1");
                if ($linkStmt) {
                    $linkStmt->bind_param('ii', $linkedEmployeeId, $newUserId);
                    $linkStmt->execute();
                    $linkStmt->close();
                }
            }
        }

        if ($linkedEmployeeId > 0) {
            syncLinkedEmployeeFromUser($conn, $newUserId, $linkedEmployeeId);
            syncEmployeeAddress($conn, $linkedEmployeeId, $address);
            if ($salaryProvided || $employee_id === null) {
                syncEmployeeSalary($conn, $linkedEmployeeId, $salary);
            }
        }

        $onboardingMessage = 'User created successfully';

        $responseData = [
            'id' => $newUserId,
        ];

        if ($isOnboardedRole) {
            markFirstLoginPasswordChangeRequired($conn, $newUserId);
            $fullName = trim($first_name . ' ' . $last_name);
            $onboardingMessage = 'User created successfully. Please save the credentials shown.';
            $responseData['onboarding_credentials'] = [
                'email'              => $email,
                'temporary_password' => (string)$temporaryPassword,
                'full_name'          => $fullName,
                'role'               => $role,
            ];

            // Send the welcome email with credentials in the background AFTER
            // responding. SMTP can take 30s+ (or fail); it must never block
            // account creation nor fail the request.
            $mailCallback = function () use ($conn, $email, $fullName, $temporaryPassword, $role, $newUserId) {
                if (!function_exists('sendUserOnboardingEmail')) {
                    return;
                }
                $loginUrl = buildFrontendBaseUrl() . '/';
                $sent = sendUserOnboardingEmail($email, $fullName, (string)$temporaryPassword, $role, $loginUrl);
                if (!$sent) {
                    error_log("sendUserOnboardingEmail: failed to send onboarding email to {$email} (user_id={$newUserId})");
                }
                logActivity($conn, $newUserId, 'onboarding_email', $sent ? 'Onboarding email sent' : 'Onboarding email failed', 'authentication');
            };

            sendResponseAndContinue(true, $responseData, $onboardingMessage, 201, $mailCallback);
        }

        sendResponse(true, $responseData, $onboardingMessage, 201);
    } else {
        if ($photo) removeManagedUserPhoto($photo);
        error_log($conn->error);
        sendError('Failed to create user.', 500);
    }
}

/**
 * PUT - Update user
 */
function handlePut($conn) {
    $data = getJSONInput();
    $currentRole = strtolower((string)($_SESSION['role'] ?? ''));
    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    $isAdmin = $currentRole === 'admin';
    $isStaff = $currentRole === 'staff';

    if (!isset($data['id'])) sendError('User ID is required', 400);
    $id = intval($data['id']);

    if ($isStaff && $id !== $currentUserId) sendError('Staff cannot update other users', 403);
    if (!$isAdmin && $id !== $currentUserId) sendError('Only admins can update other users', 403);

    if (!$isAdmin) {
        $restrictedFields = array_merge(
            ['role', 'status', 'branch_id', 'employee_id', 'photo', 'salary', 'address'],
            getDocumentFieldNames()
        );
        foreach ($restrictedFields as $field) {
            if (array_key_exists($field, $data)) {
                sendError('Only admins can update ' . $field . '.', 403);
            }
        }
    }

    $currentUser = profileEditFetchUserSnapshot($conn, $id);
    if (!$currentUser) sendError('User not found', 404);
    $currentPasswordHash = (string)($currentUser['password'] ?? '');
    $passwordBeingChanged = isset($data['password']) && !empty($data['password']);
    $currentEmployeeId = parseNullableInt($currentUser['employee_id'] ?? null);
    $currentTargetRole = strtolower(trim((string)($currentUser['role'] ?? 'staff')));
    $currentBranchId = parseNullableInt($currentUser['branch_id'] ?? null);
    $isSelfUpdate = $id === $currentUserId;
    $requiresApprovedEditAccess = $isSelfUpdate && in_array($currentRole, ['manager', 'staff'], true);
    $activeEditAccess = null;

    if ($requiresApprovedEditAccess) {
        $activeEditAccess = profileEditActiveAccessRow($conn, $currentUserId);
        if (!$activeEditAccess) {
            sendError('You need approved edit access first before editing your profile details.', 403);
        }

        $submittedProfileFields = [];
        foreach (array_keys(profileEditGetRequestableFieldLabelMap()) as $field) {
            if ($field === 'photo') {
                if (array_key_exists('photo', $data) || !empty($data['photo_upload']) || !empty($data['photo_remove'])) {
                    $submittedProfileFields[] = 'photo';
                }
                continue;
            }
            if ($field === 'password') {
                if (!empty($data['password'])) $submittedProfileFields[] = 'password';
                continue;
            }
            if (array_key_exists($field, $data)) $submittedProfileFields[] = $field;
        }

        $approvedProfileFields = profileEditNormalizeRequestedFields($activeEditAccess['requested_fields'] ?? []);
        $unapprovedFields = array_values(array_diff(array_unique($submittedProfileFields), $approvedProfileFields));
        if (!empty($unapprovedFields)) {
            $fieldLabels = profileEditGetFieldLabelMap();
            $unapprovedLabels = array_map(function ($field) use ($fieldLabels) {
                return $fieldLabels[$field] ?? $field;
            }, $unapprovedFields);
            sendError('Your approved request does not allow editing: ' . implode(', ', $unapprovedLabels) . '.', 403);
        }
    }

    $nextRole = array_key_exists('role', $data)
        ? strtolower(trim((string)$data['role']))
        : $currentTargetRole;
    if ($isSelfUpdate && $currentTargetRole === 'admin' && $nextRole !== 'admin') {
        sendError('You cannot change your own administrator role.', 403);
    }
    $nextBranchId = array_key_exists('branch_id', $data)
        ? parseNullableInt($data['branch_id'])
        : $currentBranchId;
    if (array_key_exists('branch_id', $data) && $nextBranchId !== null) {
        assertBranchExistsForUser($conn, $nextBranchId);
    }
    assertManagerBranchAvailability($conn, $nextRole, $nextBranchId, $id);

    $oldPhoto = $currentUser['photo'] ?? null;
    $newUploadedPhoto = null;
    $photoUpdated = false;

    if (!empty($data['photo_upload'])) {
        $newUploadedPhoto = saveUserPhotoUpload($data['photo_upload']);
        $data['photo'] = $newUploadedPhoto;
        $photoUpdated = true;
    }
    if (!empty($data['photo_remove'])) {
        $data['photo'] = null;
        $photoUpdated = true;
    }

    $nextFirstName = array_key_exists('first_name', $data)
        ? normalizePersonName($data['first_name'], 50)
        : normalizePersonName($currentUser['first_name'] ?? '', 50);
    $nextLastName = array_key_exists('last_name', $data)
        ? normalizePersonName($data['last_name'], 50)
        : normalizePersonName($currentUser['last_name'] ?? '', 50);
    $nextEmail = array_key_exists('email', $data)
        ? normalizeNullableString($data['email'], 100)
        : normalizeNullableString($currentUser['email'] ?? null, 100);
    $nextSssNumber = array_key_exists('sss_number', $data)
        ? normalizeGovernmentNumber($data['sss_number'], 30)
        : normalizeGovernmentNumber($currentUser['sss_number'] ?? null, 30);
    $nextPagibigNumber = array_key_exists('pagibig_number', $data)
        ? normalizeGovernmentNumber($data['pagibig_number'], 30)
        : normalizeGovernmentNumber($currentUser['pagibig_number'] ?? null, 30);
    $nextPhilhealthNumber = array_key_exists('philhealth_number', $data)
        ? normalizeGovernmentNumber($data['philhealth_number'], 30)
        : normalizeGovernmentNumber($currentUser['philhealth_number'] ?? null, 30);
    $nextTinNumber = array_key_exists('tin_number', $data)
        ? normalizeGovernmentNumber($data['tin_number'], 30)
        : normalizeGovernmentNumber($currentUser['tin_number'] ?? null, 30);
    ensureUniqueFullName($conn, $nextFirstName, $nextLastName, $id);
    assertDistinctGovernmentNumbers($nextSssNumber, $nextPagibigNumber, $nextPhilhealthNumber, $nextTinNumber);
    $nextEmployeeId = $currentEmployeeId;
    if (array_key_exists('employee_id', $data)) {
        $nextEmployeeId = parseNullableInt($data['employee_id']);
    }
    $matchedEmployeeIdByEmail = findEmployeeIdByEmail($conn, $nextEmail);
    $employeeGovernmentExcludeId = $nextEmployeeId ?? ($matchedEmployeeIdByEmail > 0 ? $matchedEmployeeIdByEmail : null);
    assertGovernmentNumbersUniqueForUsers($conn, [
        'sss_number' => $nextSssNumber,
        'pagibig_number' => $nextPagibigNumber,
        'philhealth_number' => $nextPhilhealthNumber,
        'tin_number' => $nextTinNumber,
    ], $id);
    assertGovernmentNumbersUniqueForEmployees($conn, [
        'sss_number' => $nextSssNumber,
        'pagibig_number' => $nextPagibigNumber,
        'philhealth_number' => $nextPhilhealthNumber,
        'tin_number' => $nextTinNumber,
    ], $employeeGovernmentExcludeId);

    $salaryProvided = array_key_exists('salary', $data);
    $salary = null;
    if ($salaryProvided) {
        $salary = parseSalaryAmount($data['salary'], 0.00);
    }
    $addressProvided = array_key_exists('address', $data);
    $address = $addressProvided ? normalizeNullableString($data['address'], 255) : null;

    $updates = [];
    $types = '';
    $params = [];

    if (isset($data['first_name'])) {
        $updates[] = "first_name = ?";
        $types .= 's';
        $params[] = $nextFirstName;
    }
    if (isset($data['last_name'])) {
        $updates[] = "last_name = ?";
        $types .= 's';
        $params[] = $nextLastName;
    }
    if (array_key_exists('date_of_birth', $data)) {
        $dob = normalizeNullableString($data['date_of_birth'], 10);
        if ($dob === null) {
            $updates[] = "date_of_birth = NULL";
        } else {
            if (!validateDate($dob)) sendError('Invalid date_of_birth format. Expected YYYY-MM-DD', 400);
            if (!isAtLeastMinimumAge($dob, 18)) sendError('User must be at least 18 years old.', 400);
            $updates[] = "date_of_birth = ?";
            $types .= 's';
            $params[] = $dob;
        }
    }
    if (isset($data['email'])) {
        $email = sanitizeInput($data['email']);
        if (!validateGmailComEmail($email)) sendError('Email must be a valid @gmail.com or @phinmaed.com address', 400);
        $checkEmail = $conn->prepare("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1");
        $checkEmail->bind_param('si', $email, $id);
        $checkEmail->execute();
        if ($checkEmail->get_result()->num_rows > 0) sendError('Email already in use', 409);
        $updates[] = "email = ?";
        $types .= 's';
        $params[] = $email;
    }
    if (isset($data['role'])) {
        $role = strtolower(trim((string)sanitizeInput($data['role'])));
        if (!in_array($role, ['admin', 'manager', 'staff'], true)) sendError('Invalid role', 400);
        $updates[] = "role = ?";
        $types .= 's';
        $params[] = $role;
    }
    if (isset($data['status'])) {
        $status = sanitizeInput($data['status']);
        if (!in_array($status, ['active', 'inactive', 'suspended', 'locked'], true)) sendError('Invalid status', 400);
        $updates[] = "status = ?";
        $types .= 's';
        $params[] = $status;
    }

    if (array_key_exists('photo', $data)) {
        $photo = normalizeNullableString($data['photo'], 255);
        if ($photo === null) {
            $updates[] = "photo = NULL";
        } else {
            $updates[] = "photo = ?";
            $types .= 's';
            $params[] = $photo;
        }
    }

    if (array_key_exists('sss_number', $data)) {
        if ($nextSssNumber === null) {
            $updates[] = "sss_number = NULL";
        } else {
            $updates[] = "sss_number = ?";
            $types .= 's';
            $params[] = $nextSssNumber;
        }
    }
    if (array_key_exists('pagibig_number', $data)) {
        if ($nextPagibigNumber === null) {
            $updates[] = "pagibig_number = NULL";
        } else {
            $updates[] = "pagibig_number = ?";
            $types .= 's';
            $params[] = $nextPagibigNumber;
        }
    }
    if (array_key_exists('philhealth_number', $data)) {
        if ($nextPhilhealthNumber === null) {
            $updates[] = "philhealth_number = NULL";
        } else {
            $updates[] = "philhealth_number = ?";
            $types .= 's';
            $params[] = $nextPhilhealthNumber;
        }
    }
    if (array_key_exists('tin_number', $data)) {
        if ($nextTinNumber === null) {
            $updates[] = "tin_number = NULL";
        } else {
            $updates[] = "tin_number = ?";
            $types .= 's';
            $params[] = $nextTinNumber;
        }
    }

    if (array_key_exists('mobile_number', $data)) {
        $mobileNumber = normalizeNullableString($data['mobile_number'], 20);
        if ($mobileNumber === null) {
            $updates[] = "mobile_number = NULL";
        } else {
            $updates[] = "mobile_number = ?";
            $types .= 's';
            $params[] = $mobileNumber;
        }
    }

    foreach (getDocumentFieldNames() as $docField) {
        if (array_key_exists($docField, $data)) {
            $updates[] = "$docField = ?";
            $types .= 'i';
            $params[] = toTinyInt($data[$docField]);
        }
    }

    if (array_key_exists('branch_id', $data)) {
        $branchId = parseNullableInt($data['branch_id']);
        if ($branchId === null) {
            $updates[] = "branch_id = NULL";
        } else {
            $updates[] = "branch_id = ?";
            $types .= 'i';
            $params[] = $branchId;
        }
    }
    if (array_key_exists('employee_id', $data)) {
        $employeeId = parseNullableInt($data['employee_id']);
        if ($employeeId === null) {
            $updates[] = "employee_id = NULL";
        } else {
            if ($currentEmployeeId !== null && $currentEmployeeId !== $employeeId) {
                sendError('This user is already linked to an employee. Unlink first before linking another.', 409);
            }
            if ($currentEmployeeId === null) {
                assertEmployeeLinkAvailableForUser($conn, $employeeId, $id);
            }
            $updates[] = "employee_id = ?";
            $types .= 'i';
            $params[] = $employeeId;
        }
    }
    if ($passwordBeingChanged) {
        // Self-service password change must prove the current password first.
        // Admin resets of OTHER users are unaffected (they don't know it).
        if ($isSelfUpdate) {
            $currentPasswordInput = (string)($data['current_password'] ?? '');
            if ($currentPasswordInput === '') {
                sendError('Enter your current password first.', 400);
            }
            if (!verifyPassword($currentPasswordInput, $currentPasswordHash)) {
                sendError('Current password is incorrect.', 401);
            }
        }
        $policy = getPasswordPolicy($conn);
        $newHash = validateAndHashPasswordForChange($conn, $id, $data['password'], $currentPasswordHash, $policy['history_count']);
        $expiresAt = date('Y-m-d H:i:s', time() + ($policy['max_age_days'] * 86400));
        $updates[] = "password = ?";
        $types .= 's';
        $params[] = $newHash;
        $updates[] = "password_changed_at = NOW()";
        $updates[] = "password_expires_at = ?";
        $types .= 's';
        $params[] = $expiresAt;
        $updates[] = "must_reset_password = 0";
    }

    if (empty($updates)) {
        if ($newUploadedPhoto) removeManagedUserPhoto($newUploadedPhoto);
        sendError('No fields to update', 400);
    }

    $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
    $types .= 'i';
    $params[] = $id;

    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        $updatedUser = profileEditFetchUserSnapshot($conn, $id);
        if (!$updatedUser) {
            if ($newUploadedPhoto) removeManagedUserPhoto($newUploadedPhoto);
            sendError('Failed to reload updated user.', 500);
        }

        $finalPhoto = $updatedUser['photo'] ?? null;
        if ($photoUpdated && $oldPhoto && $oldPhoto !== $finalPhoto) {
            removeManagedUserPhoto($oldPhoto);
        }

        $linkedEmployeeId = intval($updatedUser['employee_id'] ?? 0);
        if ($linkedEmployeeId > 0) {
            syncLinkedEmployeeFromUser($conn, $id, $linkedEmployeeId);
            if ($addressProvided) {
                syncEmployeeAddress($conn, $linkedEmployeeId, $address);
            }
            if ($salaryProvided && $salary !== null) {
                syncEmployeeSalary($conn, $linkedEmployeeId, $salary);
            }
        }

        $changedFieldCandidates = array_keys($data);
        if ($photoUpdated || array_key_exists('photo', $data)) {
            $changedFieldCandidates[] = 'photo';
        }
        if (isset($data['password']) && !empty($data['password'])) {
            $changedFieldCandidates[] = 'password';
        }

        $changedLabels = profileEditCollectChangedLabels($currentUser, $updatedUser, $changedFieldCandidates);
        if (isset($data['password']) && !empty($data['password']) && !in_array('Password', $changedLabels, true)) {
            $changedLabels[] = 'Password';
        }
        $changedLabels = array_values(array_unique($changedLabels));

        if ($requiresApprovedEditAccess) {
            profileEditConsumeApprovedAccess($conn, $id, $currentUserId, $changedLabels);
        }

        $supervisorUpdateEmailPayload = null;
        if (
            !$isSelfUpdate
            && in_array($currentRole, ['admin', 'manager'], true)
            && in_array(strtolower(trim((string)($updatedUser['role'] ?? $currentTargetRole))), ['manager', 'staff'], true)
        ) {
            $actor = profileEditResolveActorSummary($conn, $currentUserId);
            $supervisorUpdateEmailPayload = [
                'email' => $updatedUser['email'] ?? '',
                'name' => $updatedUser['display_name'] ?? profileEditFormatDisplayName($updatedUser['first_name'] ?? '', $updatedUser['last_name'] ?? '', $updatedUser['username'] ?? ''),
                'actor_name' => $actor['name'] ?? 'Administrator',
                'actor_role' => $actor['role'] ?? $currentRole,
                'changed_labels' => $changedLabels,
                'user_id' => $id,
            ];
        }

        if ($supervisorUpdateEmailPayload !== null) {
            sendResponseAndContinue(true, null, 'User updated successfully', 200, function () use ($supervisorUpdateEmailPayload) {
                $emailSent = profileEditSendSupervisorUpdateEmail(
                    $supervisorUpdateEmailPayload['email'],
                    $supervisorUpdateEmailPayload['name'],
                    $supervisorUpdateEmailPayload['actor_name'],
                    $supervisorUpdateEmailPayload['actor_role'],
                    $supervisorUpdateEmailPayload['changed_labels']
                );

                if (!$emailSent) {
                    error_log('Failed to send supervisor profile update email for user_id=' . $supervisorUpdateEmailPayload['user_id']);
                }
            });
        }

        sendResponse(true, null, 'User updated successfully');
    }

    if ($newUploadedPhoto) removeManagedUserPhoto($newUploadedPhoto);
    error_log($conn->error);
    sendError('Failed to update user.', 500);
}

/**
 * DELETE - Delete/Archive user
 */
function handleDelete($conn) {
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot delete users', 403);
    }

    $id = $_GET['id'] ?? null;
    $permanent = $_GET['permanent'] ?? null;

    if (!$id) sendError('User ID is required', 400);

    $id = intval($id);

    if ($id === $_SESSION['user_id']) sendError('Cannot delete your own account', 400);

    if ($permanent == '1') {
        $photo = null;
        $fetch = $conn->prepare("SELECT photo FROM users WHERE id = ? LIMIT 1");
        if ($fetch) {
            $fetch->bind_param('i', $id);
            $fetch->execute();
            $row = $fetch->get_result()->fetch_assoc();
            $photo = $row['photo'] ?? null;
            $fetch->close();
        }

        $sql = "DELETE FROM users WHERE id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $id);

        if ($stmt->execute()) {
            if ($photo) removeManagedUserPhoto($photo);
            sendResponse(true, null, 'User deleted permanently');
        }
        error_log($conn->error);
        sendError('Failed to delete user.', 500);
    }

    $sql = "UPDATE users SET status = 'inactive' WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $id);

    if ($stmt->execute()) sendResponse(true, null, 'User archived successfully');
    error_log($conn->error);
    sendError('Failed to archive user.', 500);
}

/**
 * POST ?action=unlock&id=X — Admin unlocks a locked account
 */
function handleUnlock($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if (!$id) sendError('User ID is required', 400);

    $stmt = $conn->prepare("SELECT id, username, role, status FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$user) sendError('User not found', 404);
    if ($user['status'] !== 'locked') sendError('User is not locked', 400);

    ensureColumn($conn, 'users', 'lockout_cooldown_until', 'lockout_cooldown_until DATETIME NULL');
    $up = $conn->prepare("UPDATE users SET status = 'active', reset_request_count = 0, reset_request_window_start = NULL, lockout_cooldown_until = NULL WHERE id = ?");
    $up->bind_param('i', $id);
    if (!$up->execute()) sendError('Failed to unlock user', 500);
    $up->close();

    $admin_id = (int)$_SESSION['user_id'];
    logActivity($conn, $admin_id, 'account_unlocked',
        'Admin unlocked account for user: ' . $user['username'] . ' (id=' . $id . ')',
        'security');

    sendResponse(true, null, 'User account unlocked successfully');
}

/**
 * POST ?action=restore — restore one archived user without running profile edits.
 */
function handleRestoreUser($conn) {
    $data = getJSONInput();
    $id = intval($data['id'] ?? 0);
    if ($id <= 0) sendError('User ID is required', 400);

    $stmt = $conn->prepare("SELECT role, branch_id, status FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to find archived user.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $target = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$target) sendError('User not found.', 404);
    if (strtolower((string)$target['status']) === 'active') {
        sendResponse(true, null, 'User is already active.');
    }
    if (strtolower((string)$target['status']) !== 'inactive') {
        sendError('Only archived users can be restored.', 409);
    }

    assertManagerBranchAvailability($conn, $target['role'] ?? '', $target['branch_id'] ?? null, $id);

    $restore = $conn->prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'inactive'");
    if (!$restore) sendError('Failed to prepare user restore.', 500);
    $restore->bind_param('i', $id);
    if (!$restore->execute()) {
        $restore->close();
        error_log('Failed to restore user id=' . $id . ': ' . $conn->error);
        sendError('Failed to restore user.', 500);
    }
    $restore->close();

    logActivity($conn, intval($_SESSION['user_id'] ?? 0), 'restore_user', 'Restored user ID ' . $id, 'user_management');
    sendResponse(true, null, 'User restored successfully.');
}

/**
 * GET ?action=locked — List all currently locked users
 */
function handleGetLocked($conn) {
    $sql = "SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.status,
                   u.reset_request_count, u.reset_request_window_start, u.created_at,
                   u.lockout_cooldown_until,
                   b.branch_name
            FROM users u
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.status = 'locked'
               OR (u.lockout_cooldown_until IS NOT NULL AND u.lockout_cooldown_until > NOW())
            ORDER BY
                LOWER(TRIM(COALESCE(u.first_name, ''))) ASC,
                LOWER(TRIM(COALESCE(u.last_name, ''))) ASC,
                LOWER(TRIM(COALESCE(u.username, ''))) ASC,
                u.id ASC";
    $result = $conn->query($sql);
    $users = [];
    while ($row = $result->fetch_assoc()) $users[] = $row;
    sendResponse(true, $users, 'Locked users retrieved');
}

closeDBConnection($conn);
?>
