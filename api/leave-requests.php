<?php
/**
 * Leave Requests API
 * Handles CRUD operations for leave requests
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureLeaveTypeStorage($conn);
ensureLeaveBalanceStorageCapacity($conn);
ensureLeaveRequestCommentsTable($conn);
ensurePhaseOneTables($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('leave_requests', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('leave_requests', ['admin', 'manager', 'staff'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('leave_requests', ['admin', 'manager', 'staff'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('leave_requests', ['admin', 'manager', 'staff'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getCurrentSessionRole() {
    return strtolower((string)($_SESSION['role'] ?? ''));
}

function getCurrentSessionEmployeeId($conn) {
    $sessionEmployeeId = intval($_SESSION['employee_id'] ?? 0);
    if ($sessionEmployeeId > 0) return $sessionEmployeeId;

    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) return 0;

    $stmt = $conn->prepare("SELECT id, employee_id, first_name, last_name, email, role, status, branch_id FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) return 0;
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$user) return 0;

    $employeeId = intval($user['employee_id'] ?? 0);
    if ($employeeId > 0) {
        $_SESSION['employee_id'] = $employeeId;
        return $employeeId;
    }

    $email = trim((string)($user['email'] ?? ''));
    if ($email !== '') {
        $byEmail = $conn->prepare("SELECT employee_id FROM employees WHERE email = ? LIMIT 1");
        if ($byEmail) {
            $byEmail->bind_param('s', $email);
            $byEmail->execute();
            $row = $byEmail->get_result()->fetch_assoc();
            $byEmail->close();
            $employeeId = intval($row['employee_id'] ?? 0);
        }
    }

    if ($employeeId <= 0) {
        $firstName = trim((string)($user['first_name'] ?? ''));
        $lastName = trim((string)($user['last_name'] ?? ''));
        if ($firstName !== '' && $lastName !== '') {
            $byName = $conn->prepare(
                "SELECT employee_id
                 FROM employees
                 WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
                   AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
                 LIMIT 2"
            );
            if ($byName) {
                $byName->bind_param('ss', $firstName, $lastName);
                $byName->execute();
                $result = $byName->get_result();
                if ($result && $result->num_rows === 1) {
                    $row = $result->fetch_assoc();
                    $employeeId = intval($row['employee_id'] ?? 0);
                }
                $byName->close();
            }
        }
    }

    if ($employeeId <= 0) {
        $role = strtolower((string)($user['role'] ?? ''));
        $status = strtolower((string)($user['status'] ?? ''));
        $firstName = trim((string)($user['first_name'] ?? ''));
        $lastName = trim((string)($user['last_name'] ?? ''));
        $branchId = intval($user['branch_id'] ?? 0);

        if (
            in_array($role, ['staff', 'manager'], true) &&
            $status === 'active' &&
            $firstName !== '' &&
            $lastName !== ''
        ) {
            $position = $role === 'manager' ? 'Manager' : 'Staff';
            $emailValue = $email !== '' ? $email : null;

            if ($branchId > 0) {
                $insertEmp = $conn->prepare(
                    "INSERT INTO employees (first_name, last_name, email, position, hire_date, status, branch_id)
                     VALUES (?, ?, ?, ?, CURDATE(), 'active', ?)"
                );
                if ($insertEmp) {
                    $insertEmp->bind_param('ssssi', $firstName, $lastName, $emailValue, $position, $branchId);
                }
            } else {
                $insertEmp = $conn->prepare(
                    "INSERT INTO employees (first_name, last_name, email, position, hire_date, status)
                     VALUES (?, ?, ?, ?, CURDATE(), 'active')"
                );
                if ($insertEmp) {
                    $insertEmp->bind_param('ssss', $firstName, $lastName, $emailValue, $position);
                }
            }

            if (!empty($insertEmp)) {
                if ($insertEmp->execute()) {
                    $employeeId = intval($conn->insert_id);
                } elseif ($insertEmp->errno === 1062 && $email !== '') {
                    // Race-safe fallback for unique email collisions.
                    $retry = $conn->prepare("SELECT employee_id FROM employees WHERE email = ? LIMIT 1");
                    if ($retry) {
                        $retry->bind_param('s', $email);
                        $retry->execute();
                        $row = $retry->get_result()->fetch_assoc();
                        $retry->close();
                        $employeeId = intval($row['employee_id'] ?? 0);
                    }
                }
                $insertEmp->close();
            }
        }
    }

    if ($employeeId > 0) {
        $link = $conn->prepare("UPDATE users SET employee_id = ? WHERE id = ? LIMIT 1");
        if ($link) {
            $link->bind_param('ii', $employeeId, $userId);
            $link->execute();
            $link->close();
        }
        $_SESSION['employee_id'] = $employeeId;
    }

    return $employeeId;
}

function requireCurrentEmployeeId($conn) {
    $employeeId = getCurrentSessionEmployeeId($conn);
    if ($employeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }
    return $employeeId;
}

function ensureLeaveRequestCommentsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS leave_request_comment (
                comment_id INT AUTO_INCREMENT PRIMARY KEY,
                leave_request_id INT NOT NULL,
                user_id INT NOT NULL,
                parent_comment_id INT NULL,
                comment_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_leave_comment_request FOREIGN KEY (leave_request_id) REFERENCES leave_request(leave_request_id) ON DELETE CASCADE,
                CONSTRAINT fk_leave_comment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_leave_comment_parent FOREIGN KEY (parent_comment_id) REFERENCES leave_request_comment(comment_id) ON DELETE SET NULL,
                INDEX idx_leave_comment_request (leave_request_id),
                INDEX idx_leave_comment_parent (parent_comment_id),
                INDEX idx_leave_comment_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize leave request comments storage.', 500);
    }
}

function getDefaultLeaveTypeSeeds() {
    return [
        ['type_key' => 'annual', 'type_name' => 'Annual Leave', 'default_days' => 12.0, 'is_paid' => 1, 'description' => 'Company policy — 12 days earned yearly by regular employees, with unlimited carryover.'],
        ['type_key' => 'sick', 'type_name' => 'Sick Leave', 'default_days' => 10.0, 'is_paid' => 1, 'description' => 'Company policy — paid sick leave.'],
        ['type_key' => 'personal', 'type_name' => 'Personal Leave', 'default_days' => 5.0, 'is_paid' => 1, 'description' => 'Company policy — personal leave.'],
        ['type_key' => 'maternity', 'type_name' => 'Maternity Leave', 'default_days' => 105.0, 'is_paid' => 1, 'description' => 'RA 11210 — 105 days live birth (60 miscarriage, +15 solo parent). SSS-funded.'],
        ['type_key' => 'remote', 'type_name' => 'Work From Home Leave', 'default_days' => 10.0, 'is_paid' => 1, 'description' => 'Company policy — approved work-from-home days earned yearly, with unlimited carryover.'],
        ['type_key' => 'vacation', 'type_name' => 'Vacation', 'default_days' => 12.0, 'is_paid' => 1, 'description' => 'Company policy — 12 days earned yearly by regular employees, with unlimited carryover.'],
        ['type_key' => 'emergency', 'type_name' => 'Emergency', 'default_days' => 5.0, 'is_paid' => 1, 'description' => 'Company policy — emergency leave.'],
        ['type_key' => 'paternity', 'type_name' => 'Paternity', 'default_days' => 7.0, 'is_paid' => 1, 'description' => 'RA 8187 — 7 paid days for the first 4 deliveries of lawful spouse.'],
        ['type_key' => 'unpaid', 'type_name' => 'Unpaid', 'default_days' => 0.0, 'is_paid' => 0, 'description' => 'Unpaid time off — no pay and no fixed day allocation.'],
        ['type_key' => 'service_incentive', 'type_name' => 'Service Incentive Leave (SIL)', 'default_days' => 5.0, 'is_paid' => 1, 'description' => 'Art. 95, Labor Code — 5 paid days/year after 1 year of service. Unused days commutable to cash.'],
        ['type_key' => 'solo_parent', 'type_name' => 'Solo Parent Leave', 'default_days' => 7.0, 'is_paid' => 1, 'description' => 'RA 8972 / RA 11861 — 7 paid days/year with a valid Solo Parent ID.'],
        ['type_key' => 'vawc', 'type_name' => 'VAWC Leave', 'default_days' => 10.0, 'is_paid' => 1, 'description' => 'RA 9262 — 10 paid days for women employees who are victims of violence.'],
        ['type_key' => 'special_leave_women', 'type_name' => 'Special Leave for Women', 'default_days' => 60.0, 'is_paid' => 1, 'description' => 'RA 9710 Magna Carta of Women — up to 60 paid days for gynecological surgery.'],
    ];
}

/**
 * Single source of truth for a leave type's configured figures.
 * Returns ['default_days' => ?float, 'is_paid' => bool].
 */
function getLeaveTypeFigure($conn, $leaveType) {
    $key = strtolower(trim((string)$leaveType));
    $figure = ['default_days' => null, 'is_paid' => true];
    if ($conn && $key !== '') {
        $stmt = $conn->prepare("SELECT default_days, is_paid FROM leave_type WHERE LOWER(TRIM(type_key)) = ? LIMIT 1");
        if ($stmt) {
            $stmt->bind_param('s', $key);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();
            if ($row) {
                $figure['default_days'] = $row['default_days'] === null ? null : (float)$row['default_days'];
                $figure['is_paid'] = !empty($row['is_paid']);
            }
        }
    }
    return $figure;
}

function isLeaveTypePaid($conn, $leaveType) {
    $figure = getLeaveTypeFigure($conn, $leaveType);
    return $figure['is_paid'];
}

function getDefaultLeaveAllocationDays($leaveType, $conn = null) {
    $key = strtolower(trim((string)$leaveType));
    // Editable figures win: read the admin-configured default_days first.
    $figure = getLeaveTypeFigure($conn, $leaveType);
    if ($figure['default_days'] !== null) {
        return (float)$figure['default_days'];
    }
    $map = [
        'annual' => 12.0,
        'vacation' => 12.0,
        'sick' => 10.0,
        'personal' => 5.0,
        'emergency' => 5.0,
        'maternity' => 105.0,
        'paternity' => 7.0,
        'remote' => 10.0,
        'unpaid' => 0.0,
    ];
    return array_key_exists($key, $map) ? $map[$key] : 10.0;
}

function ensureLeaveBalanceStorageCapacity($conn) {
    $columns = ['total_days', 'used_days', 'remaining_days'];
    foreach ($columns as $column) {
        $stmt = $conn->prepare(
            "SELECT NUMERIC_PRECISION FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'leave_balance' AND COLUMN_NAME = ? LIMIT 1"
        );
        if (!$stmt) continue;
        $dbName = DB_NAME;
        $stmt->bind_param('ss', $dbName, $column);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ($row && intval($row['NUMERIC_PRECISION'] ?? 0) < 10) {
            if (!$conn->query("ALTER TABLE leave_balance MODIFY COLUMN `$column` DECIMAL(10,2) NOT NULL DEFAULT 0.00")) {
                error_log($conn->error);
                sendError('Failed to expand leave balance storage for unlimited carryover.', 500);
            }
        }
    }
}

function countLeaveWorkingDays($startDate, $endDate) {
    try {
        $start = new DateTime((string)$startDate);
        $end = new DateTime((string)$endDate);
    } catch (Exception $e) {
        return 0;
    }
    if ($end < $start) return 0;

    $days = 0;
    $cursor = clone $start;
    while ($cursor <= $end) {
        $weekday = intval($cursor->format('N'));
        if ($weekday >= 1 && $weekday <= 5) $days++;
        $cursor->modify('+1 day');
    }
    return $days;
}

function isLeaveWeekendDate($dateValue) {
    try {
        $date = new DateTimeImmutable((string)$dateValue);
    } catch (Exception $e) {
        return false;
    }
    return intval($date->format('N')) >= 6;
}

function getMinimumLeaveStartDate($baseDate = 'today') {
    try {
        $cursor = new DateTimeImmutable((string)$baseDate);
    } catch (Exception $e) {
        $cursor = new DateTimeImmutable('today');
    }
    $workingDays = 0;
    while ($workingDays < 5) {
        $cursor = $cursor->modify('+1 day');
        $weekday = intval($cursor->format('N'));
        if ($weekday >= 1 && $weekday <= 5) $workingDays++;
    }
    return $cursor->format('Y-m-d');
}

function validateLeaveFilingDates($startDate, $endDate) {
    if (isLeaveWeekendDate($startDate) || isLeaveWeekendDate($endDate)) {
        sendError('Start Date and End Date must be Monday through Friday. Saturday and Sunday are skipped from leave days.', 400, [
            'code' => 'weekend_leave_date',
            'fields' => ['start_date', 'end_date'],
        ]);
    }

    $minimumStart = getMinimumLeaveStartDate();
    if ((string)$startDate < $minimumStart) {
        sendError('Leave must be filed at least 5 working days in advance. Earliest available date: ' . $minimumStart . '.', 400, [
            'code' => 'leave_notice_period',
            'field' => 'start_date',
            'fields' => ['start_date'],
            'minimum_start_date' => $minimumStart,
        ]);
    }
}

function ensureEmployeeLeaveBalance($conn, $employeeId, $leaveType, $year = null) {
    $employeeId = intval($employeeId);
    $leaveType = trim((string)$leaveType);
    $year = $year === null ? intval(date('Y')) : intval($year);
    if ($employeeId <= 0 || $leaveType === '' || $year < 2000) {
        return false;
    }

    $check = $conn->prepare(
        "SELECT leave_balance_id, total_days, used_days, remaining_days
         FROM leave_balance
         WHERE employee_id = ? AND leave_type = ? AND year = ?
         LIMIT 1"
    );
    if (!$check) return false;
    $check->bind_param('isi', $employeeId, $leaveType, $year);
    $check->execute();
    $row = $check->get_result()->fetch_assoc();
    $check->close();
    $allocation = getDefaultLeaveAllocationDays($leaveType, $conn);
    $previous = $conn->prepare(
        "SELECT year, remaining_days FROM leave_balance
         WHERE employee_id = ? AND leave_type = ? AND year < ?
         ORDER BY year DESC LIMIT 1"
    );
    $carryover = 0.0;
    $previousYear = $year - 1;
    if ($previous) {
        $previous->bind_param('isi', $employeeId, $leaveType, $year);
        $previous->execute();
        $previousRow = $previous->get_result()->fetch_assoc();
        $previous->close();
        if ($previousRow) {
            $carryover = max(0.0, (float)$previousRow['remaining_days']);
            $previousYear = intval($previousRow['year']);
        }
    }
    $yearsEarned = max(1, $year - $previousYear);
    $total = $carryover + ($allocation * $yearsEarned);

    if ($row) {
        $used = max(0.0, (float)$row['used_days']);
        $remaining = max(0.0, $total - $used);
        $update = $conn->prepare(
            "UPDATE leave_balance SET total_days = ?, remaining_days = ? WHERE leave_balance_id = ?"
        );
        if (!$update) return false;
        $balanceId = intval($row['leave_balance_id']);
        $update->bind_param('ddi', $total, $remaining, $balanceId);
        $ok = $update->execute();
        $update->close();
        return (bool)$ok;
    }

    $used = 0.0;
    $remaining = $total;
    $insert = $conn->prepare(
        "INSERT INTO leave_balance (employee_id, leave_type, total_days, used_days, remaining_days, year)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    if (!$insert) return false;
    $insert->bind_param('isdddi', $employeeId, $leaveType, $total, $used, $remaining, $year);
    $ok = $insert->execute();
    $insert->close();
    return (bool)$ok;
}


function ensureLeaveTypeColumnIsVarchar($conn, $table, $column) {
    $dbName = DB_NAME;
    $checkSql = "SELECT DATA_TYPE, COLUMN_TYPE
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
                 LIMIT 1";
    $checkStmt = $conn->prepare($checkSql);
    if (!$checkStmt) {
        sendError('Failed to validate leave type schema.', 500);
    }
    $checkStmt->bind_param('sss', $dbName, $table, $column);
    $checkStmt->execute();
    $col = $checkStmt->get_result()->fetch_assoc();
    $checkStmt->close();

    if (!$col) return;

    $dataType = strtolower((string)($col['DATA_TYPE'] ?? ''));
    $columnType = strtolower((string)($col['COLUMN_TYPE'] ?? ''));
    if ($dataType === 'enum' || strpos($columnType, 'enum(') === 0) {
        $alterSql = "ALTER TABLE `$table` MODIFY COLUMN `$column` VARCHAR(100) NOT NULL";
        if (!$conn->query($alterSql)) {
            error_log($conn->error);
            sendError('Failed to upgrade leave type schema on ' . $table . '.', 500);
        }
    }
}

function ensureLeaveTypeStorage($conn) {
    $createSql = "CREATE TABLE IF NOT EXISTS leave_type (
                    leave_type_id INT AUTO_INCREMENT PRIMARY KEY,
                    type_key VARCHAR(100) NOT NULL UNIQUE,
                    type_name VARCHAR(120) NOT NULL UNIQUE,
                    description TEXT NULL,
                    default_days DECIMAL(6,1) NULL DEFAULT NULL,
                    is_paid TINYINT(1) NOT NULL DEFAULT 1,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_leave_type_active (is_active)
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($createSql)) {
        error_log($conn->error);
        sendError('Failed to initialize leave type storage.', 500);
    }

    ensureLeaveTypeFigureColumn($conn, 'default_days', 'DECIMAL(6,1) NULL DEFAULT NULL');
    ensureLeaveTypeFigureColumn($conn, 'is_paid', 'TINYINT(1) NOT NULL DEFAULT 1');

    ensureLeaveTypeColumnIsVarchar($conn, 'leave_request', 'leave_type');
    ensureLeaveTypeColumnIsVarchar($conn, 'leave_balance', 'leave_type');

    $insertSql = "INSERT INTO leave_type (type_key, type_name, description, default_days, is_paid, is_active)
                  VALUES (?, ?, ?, ?, ?, 1)
                  ON DUPLICATE KEY UPDATE type_name = VALUES(type_name)";
    $stmt = $conn->prepare($insertSql);
    if (!$stmt) {
        sendError('Failed to initialize default leave types.', 500);
    }
    foreach (getDefaultLeaveTypeSeeds() as $seed) {
        $key = (string)$seed['type_key'];
        $name = (string)$seed['type_name'];
        $desc = (string)($seed['description'] ?? '');
        $days = array_key_exists('default_days', $seed) && $seed['default_days'] !== null ? (float)$seed['default_days'] : null;
        $paid = !empty($seed['is_paid']) ? 1 : 0;
        $stmt->bind_param('sssdi', $key, $name, $desc, $days, $paid);
        $stmt->execute();
    }
    $stmt->close();

    // One-time bootstrap for rows that predate the figures columns (see
    // leave-types.php): fill defaults only where admin set nothing yet.
    $backfill = $conn->prepare(
        "UPDATE leave_type SET default_days = ?, is_paid = ? WHERE type_key = ? AND default_days IS NULL"
    );
    if ($backfill) {
        foreach (getDefaultLeaveTypeSeeds() as $seed) {
            if (!array_key_exists('default_days', $seed) || $seed['default_days'] === null) continue;
            $days = (float)$seed['default_days'];
            $paid = !empty($seed['is_paid']) ? 1 : 0;
            $key = (string)$seed['type_key'];
            $backfill->bind_param('dis', $days, $paid, $key);
            $backfill->execute();
        }
        $backfill->close();
    }

    // One-time policy migration from the former built-in 18-day default.
    $migrationKey = 'leave_policy_annual_12_migrated';
    $migrationCheck = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1");
    if ($migrationCheck) {
        $migrationCheck->bind_param('s', $migrationKey);
        $migrationCheck->execute();
        $migrationDone = $migrationCheck->get_result()->fetch_assoc();
        $migrationCheck->close();
        if (!$migrationDone) {
            $conn->query("UPDATE leave_type SET default_days = 12.0 WHERE type_key IN ('annual', 'vacation') AND default_days = 18.0");
            $migrationValue = '1';
            $migrationInsert = $conn->prepare("INSERT INTO settings (setting_key, setting_value, setting_type) VALUES (?, ?, 'boolean')");
            if ($migrationInsert) {
                $migrationInsert->bind_param('ss', $migrationKey, $migrationValue);
                $migrationInsert->execute();
                $migrationInsert->close();
            }
        }
    }
}

function ensureLeaveTypeFigureColumn($conn, $column, $definition) {
    $dbName = DB_NAME;
    $table = 'leave_type';
    $check = $conn->prepare(
        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1"
    );
    if (!$check) {
        sendError('Failed to validate leave type schema.', 500);
    }
    $check->bind_param('sss', $dbName, $table, $column);
    $check->execute();
    $exists = $check->get_result()->num_rows > 0;
    $check->close();
    if (!$exists) {
        if (!$conn->query("ALTER TABLE `leave_type` ADD COLUMN `$column` $definition")) {
            error_log($conn->error);
            sendError('Failed to upgrade leave type schema.', 500);
        }
    }
}

function getAllowedLeaveTypes($conn) {
    $sql = "SELECT type_key
            FROM leave_type
            WHERE is_active = 1
            ORDER BY type_name ASC";
    $result = $conn->query($sql);
    if (!$result) {
        $fallback = [];
        foreach (getDefaultLeaveTypeSeeds() as $seed) {
            $fallback[] = (string)$seed['type_key'];
        }
        return $fallback;
    }

    $types = [];
    while ($row = $result->fetch_assoc()) {
        $key = trim((string)($row['type_key'] ?? ''));
        if ($key !== '') $types[] = $key;
    }
    return $types;
}

function normalizeEmployeeRoleForLeaveSubmission($value) {
    $role = strtolower(trim((string)$value));
    if ($role === '') return '';
    if ($role === 'manager' || strpos($role, 'manager') !== false) return 'manager';
    if ($role === 'staff' || strpos($role, 'staff') !== false) return 'staff';
    if ($role === 'admin' || strpos($role, 'administrator') !== false) return 'admin';
    return $role;
}

function getEmployeeRoleForLeaveSubmission($conn, $employeeId) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return null;

    $stmt = $conn->prepare(
        "SELECT e.position,
                (SELECT LOWER(TRIM(u.role))
                 FROM users u
                 WHERE u.employee_id = e.employee_id
                 ORDER BY u.id DESC
                 LIMIT 1) AS linked_role
         FROM employees e
         WHERE e.employee_id = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to validate target employee role.', 500);
    $stmt->bind_param('i', $employeeId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) return null;

    $linkedRole = normalizeEmployeeRoleForLeaveSubmission($row['linked_role'] ?? '');
    if ($linkedRole !== '') return $linkedRole;
    return normalizeEmployeeRoleForLeaveSubmission($row['position'] ?? '');
}

function getLeaveRequestRecord($conn, $leaveId) {
    $stmt = $conn->prepare(
        "SELECT leave_request_id, employee_id, leave_type, start_date, end_date, status
         FROM leave_request
         WHERE leave_request_id = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to prepare leave request lookup', 500);
    $stmt->bind_param('i', $leaveId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Find an active (pending/approved) leave request for the same employee that
 * overlaps the given date range. Applies to ALL roles (staff/manager/admin).
 * Returns the conflicting row or null.
 *
 * $forUpdate adds FOR UPDATE so a surrounding transaction gap-locks the
 * employee's rows: two concurrent same-employee inserts serialize instead of
 * both slipping past the check.
 */
function findOverlappingLeaveRequest($conn, $employeeId, $startDate, $endDate, $excludeId = 0, $forUpdate = false) {
    $employeeId = intval($employeeId);
    $excludeId = intval($excludeId);
    if ($employeeId <= 0 || $startDate === '' || $endDate === '') return null;

    $sql = "SELECT leave_request_id, leave_type, start_date, end_date, status
            FROM leave_request
            WHERE employee_id = ?
              AND status IN ('pending', 'approved')
              AND start_date <= ?
              AND end_date >= ?";
    $params = [$employeeId, $endDate, $startDate];
    $types = 'iss';
    if ($excludeId > 0) {
        $sql .= " AND leave_request_id <> ?";
        $params[] = $excludeId;
        $types .= 'i';
    }
    $sql .= " ORDER BY start_date ASC LIMIT 1";
    if ($forUpdate) {
        $sql .= " FOR UPDATE";
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to validate duplicate leave request', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Find an active (submitted/approved, non-archived) overtime request for the
 * same employee that falls inside the given leave date range (cross-type guard).
 * Returns the conflicting row or null.
 */
function findOvertimeInLeaveRange($conn, $employeeId, $startDate, $endDate, $excludeOvertimeId = 0, $forUpdate = false) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0 || $startDate === '' || $endDate === '') return null;
    // Overtime table may not exist on very old installs; fail open.
    $check = $conn->query("SHOW TABLES LIKE 'overtime_request'");
    if (!$check || $check->num_rows === 0) return null;

    $sql = "SELECT overtime_request_id, work_date, status
            FROM overtime_request
            WHERE employee_id = ?
              AND status IN ('submitted', 'approved')
              AND COALESCE(is_archived, 0) = 0
              AND work_date >= ?
              AND work_date <= ?";
    $params = [$employeeId, $startDate, $endDate];
    $types = 'iss';
    if (intval($excludeOvertimeId) > 0) {
        $sql .= " AND overtime_request_id <> ?";
        $params[] = intval($excludeOvertimeId);
        $types .= 'i';
    }
    $sql .= " ORDER BY work_date ASC LIMIT 1";
    if ($forUpdate) {
        $sql .= " FOR UPDATE";
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

function ensureLeaveRequestAccess($conn, $leaveId, $role, $selfEmployeeId) {
    $record = getLeaveRequestRecord($conn, $leaveId);
    if (!$record) {
        sendError('Leave request not found', 404);
    }

    if ($role === 'staff' && intval($record['employee_id'] ?? 0) !== intval($selfEmployeeId)) {
        sendError('Forbidden', 403);
    }

    return $record;
}

function handleGetComments($conn, $leaveId, $role, $selfEmployeeId) {
    ensureLeaveRequestAccess($conn, $leaveId, $role, $selfEmployeeId);

    $sql = "SELECT c.comment_id,
                   c.leave_request_id,
                   c.user_id,
                   c.parent_comment_id,
                   c.comment_text,
                   c.created_at,
                   c.updated_at,
                   u.first_name,
                   u.last_name,
                   u.username,
                   LOWER(COALESCE(u.role, '')) AS commenter_role
            FROM leave_request_comment c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.leave_request_id = ?
            ORDER BY c.created_at ASC, c.comment_id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare comments query', 500);
    $stmt->bind_param('i', $leaveId);
    $stmt->execute();
    $result = $stmt->get_result();

    $comments = [];
    while ($row = $result->fetch_assoc()) {
        $fullName = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
        $comments[] = [
            'comment_id' => intval($row['comment_id']),
            'leave_request_id' => intval($row['leave_request_id']),
            'user_id' => intval($row['user_id']),
            'parent_comment_id' => $row['parent_comment_id'] !== null ? intval($row['parent_comment_id']) : null,
            'comment_text' => (string)($row['comment_text'] ?? ''),
            'created_at' => (string)($row['created_at'] ?? ''),
            'updated_at' => (string)($row['updated_at'] ?? ''),
            'commenter_name' => $fullName !== '' ? $fullName : ((string)($row['username'] ?? 'Unknown User')),
            'commenter_role' => (string)($row['commenter_role'] ?? ''),
        ];
    }
    $stmt->close();

    sendResponse(true, $comments, 'Leave request comments retrieved successfully');
}

function handleCreateComment($conn, $data, $role, $selfEmployeeId) {
    $leaveId = intval($data['leave_request_id'] ?? 0);
    if ($leaveId <= 0) {
        sendError('Leave request ID is required', 400);
    }

    $commentTextRaw = trim((string)($data['comment'] ?? $data['comment_text'] ?? ''));
    if ($commentTextRaw === '') {
        sendError('Comment is required', 400);
    }
    if (strlen($commentTextRaw) > 2000) {
        sendError('Comment is too long (max 2000 characters)', 400);
    }

    $leaveRecord = ensureLeaveRequestAccess($conn, $leaveId, $role, $selfEmployeeId);
    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) {
        sendError('Authentication required', 401);
    }

    $parentCommentId = null;
    if (isset($data['parent_comment_id']) && $data['parent_comment_id'] !== null && $data['parent_comment_id'] !== '') {
        $parentCommentId = intval($data['parent_comment_id']);
        if ($parentCommentId <= 0) {
            sendError('Invalid parent comment ID', 400);
        }

        $parentStmt = $conn->prepare(
            "SELECT comment_id
             FROM leave_request_comment
             WHERE comment_id = ? AND leave_request_id = ?
             LIMIT 1"
        );
        if (!$parentStmt) sendError('Failed to prepare parent comment lookup', 500);
        $parentStmt->bind_param('ii', $parentCommentId, $leaveId);
        $parentStmt->execute();
        $parent = $parentStmt->get_result()->fetch_assoc();
        $parentStmt->close();

        if (!$parent) {
            sendError('Parent comment not found for this leave request', 404);
        }
    }

    $commentText = sanitizeInput($commentTextRaw);
    if ($parentCommentId !== null) {
        $insert = $conn->prepare(
            "INSERT INTO leave_request_comment (leave_request_id, user_id, parent_comment_id, comment_text)
             VALUES (?, ?, ?, ?)"
        );
        if (!$insert) sendError('Failed to prepare comment insert', 500);
        $insert->bind_param('iiis', $leaveId, $currentUserId, $parentCommentId, $commentText);
    } else {
        $insert = $conn->prepare(
            "INSERT INTO leave_request_comment (leave_request_id, user_id, comment_text)
             VALUES (?, ?, ?)"
        );
        if (!$insert) sendError('Failed to prepare comment insert', 500);
        $insert->bind_param('iis', $leaveId, $currentUserId, $commentText);
    }

    if (!$insert->execute()) {
        $insert->close();
        error_log($conn->error);
        sendError('Failed to save comment.', 500);
    }

    $newCommentId = intval($conn->insert_id);
    $insert->close();

    logActivity(
        $conn,
        $currentUserId,
        'leave_comment',
        'Added a comment to leave request ID: ' . $leaveId . ' (employee ID: ' . intval($leaveRecord['employee_id'] ?? 0) . ')',
        'leave_management'
    );

    sendResponse(true, ['comment_id' => $newCommentId], 'Comment posted successfully', 201);
}

function handleGet($conn) {
    $leave_id = $_GET['id'] ?? null;
    $role = getCurrentSessionRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireCurrentEmployeeId($conn) : 0;
    $commentsOnly = isset($_GET['comments']) && (string)($_GET['comments']) !== '0';
    $requestRole = strtolower(trim((string)($_GET['role'] ?? '')));
    if ($requestRole !== '' && !in_array($requestRole, ['admin', 'manager', 'staff'], true)) {
        sendError('Invalid role filter', 400);
    }

    if ($commentsOnly) {
        $commentsLeaveId = intval($_GET['leave_request_id'] ?? $_GET['id'] ?? 0);
        if ($commentsLeaveId <= 0) {
            sendError('Leave request ID is required', 400);
        }
        handleGetComments($conn, $commentsLeaveId, $role, $selfEmployeeId);
        return;
    }

    // Leave balances overview for dashboard
    if (isset($_GET['balances']) && (string)$_GET['balances'] !== '0') {
        $year = isset($_GET['year']) ? intval($_GET['year']) : intval(date('Y'));
        if ($year < 2000 || $year > 2100) {
            $year = intval(date('Y'));
        }

        // Make the overview complete: every in-scope employee gets a row for
        // every active leave type, so nobody is invisible just because they
        // never filed that type of request yet.
        ensureLeaveTypeStorage($conn);
        $balanceTypes = getAllowedLeaveTypes($conn);
        $filterEmployeeId = isset($_GET['employee_id']) ? intval($_GET['employee_id']) : 0;

        if ($isStaff) {
            foreach ($balanceTypes as $balanceType) {
                ensureEmployeeLeaveBalance($conn, $selfEmployeeId, $balanceType, $year);
            }
        } elseif ($filterEmployeeId > 0) {
            foreach ($balanceTypes as $balanceType) {
                ensureEmployeeLeaveBalance($conn, $filterEmployeeId, $balanceType, $year);
            }
        } else {
            $empRes = $conn->query("SELECT employee_id FROM employees WHERE status = 'active'");
            if ($empRes) {
                while ($empRow = $empRes->fetch_assoc()) {
                    $empId = intval($empRow['employee_id'] ?? 0);
                    if ($empId <= 0) continue;
                    foreach ($balanceTypes as $balanceType) {
                        ensureEmployeeLeaveBalance($conn, $empId, $balanceType, $year);
                    }
                }
                $empRes->close();
            }
        }

        $sql = "SELECT lb.leave_balance_id, lb.employee_id, lb.leave_type, lb.total_days, lb.used_days, lb.remaining_days, lb.year,
                       CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                       e.position,
                       lt.type_name AS leave_type_name,
                       lt.default_days AS leave_type_default_days,
                       lt.is_paid AS leave_type_is_paid
                FROM leave_balance lb
                LEFT JOIN employees e ON lb.employee_id = e.employee_id
                LEFT JOIN leave_type lt ON LOWER(TRIM(lt.type_key)) = LOWER(TRIM(lb.leave_type))
                WHERE lb.year = ?";
        $params = [$year];
        $types = 'i';

        if ($isStaff) {
            $sql .= " AND lb.employee_id = ?";
            $params[] = $selfEmployeeId;
            $types .= 'i';
        } elseif ($filterEmployeeId > 0) {
            $sql .= " AND lb.employee_id = ?";
            $params[] = $filterEmployeeId;
            $types .= 'i';
        }

        $sql .= " ORDER BY e.first_name ASC, e.last_name ASC, lb.leave_type ASC";

        $stmt = $conn->prepare($sql);
        if (!$stmt) {
            sendError('Failed to prepare leave balances query', 500);
        }
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
        $balances = [];
        while ($row = $result->fetch_assoc()) {
            $row['total_days'] = floatval($row['total_days'] ?? 0);
            $row['used_days'] = floatval($row['used_days'] ?? 0);
            $row['remaining_days'] = floatval($row['remaining_days'] ?? 0);
            $row['leave_type_default_days'] = $row['leave_type_default_days'] === null ? null : floatval($row['leave_type_default_days']);
            $row['leave_type_is_paid'] = isset($row['leave_type_is_paid']) ? intval($row['leave_type_is_paid']) : 1;
            $balances[] = $row;
        }
        $stmt->close();
        sendResponse(true, $balances, 'Leave balances retrieved successfully');
        return;
    }
    
    if ($leave_id) {
        $sql = "SELECT lr.*, 
                       CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                       e.position,
                       COALESCE(
                           (SELECT LOWER(u.role) FROM users u WHERE u.employee_id = lr.employee_id ORDER BY u.id DESC LIMIT 1),
                           LOWER(TRIM(e.position))
                       ) as employee_role,
                       (SELECT COUNT(*) FROM leave_request_comment c WHERE c.leave_request_id = lr.leave_request_id) as comment_count,
                       CONCAT(a.first_name, ' ', a.last_name) as approved_by_name
                FROM leave_request lr
                LEFT JOIN employees e ON lr.employee_id = e.employee_id
                LEFT JOIN employees a ON lr.approved_by = a.employee_id
                WHERE lr.leave_request_id = ?";

        if ($isStaff) {
            $sql .= " AND lr.employee_id = ?";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('ii', $leave_id, $selfEmployeeId);
        } else {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $leave_id);
        }

        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($row = $result->fetch_assoc()) {
            sendResponse(true, $row, 'Leave request retrieved successfully');
        } else {
            sendError('Leave request not found', 404);
        }
    } else {
        $employee_id = $_GET['employee_id'] ?? null;
        $status = isset($_GET['status']) ? strtolower(trim((string)$_GET['status'])) : null;

        if ($isStaff) {
            $employee_id = $selfEmployeeId;
        }
        
        $sql = "SELECT lr.*, 
                       CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                       e.position,
                       COALESCE(
                           (SELECT LOWER(u.role) FROM users u WHERE u.employee_id = lr.employee_id ORDER BY u.id DESC LIMIT 1),
                           LOWER(TRIM(e.position))
                       ) as employee_role,
                       (SELECT COUNT(*) FROM leave_request_comment c WHERE c.leave_request_id = lr.leave_request_id) as comment_count
                FROM leave_request lr
                LEFT JOIN employees e ON lr.employee_id = e.employee_id
                WHERE 1=1";
        
        $params = [];
        $types = '';
        
        if ($employee_id) {
            $sql .= " AND lr.employee_id = ?";
            $params[] = $employee_id;
            $types .= 'i';
        }
        
        if ($status !== null && $status !== '') {
            if ($status === 'archived') {
                $sql .= " AND lr.status IN ('approved', 'rejected', 'archived', 'cancelled')";
            } else {
                $sql .= " AND lr.status = ?";
                $params[] = $status;
                $types .= 's';
            }
        }

        if ($requestRole !== '') {
            $sql .= " AND (
                EXISTS (
                    SELECT 1 FROM users ur
                    WHERE ur.employee_id = lr.employee_id
                      AND LOWER(ur.role) = ?
                ) OR (
                    NOT EXISTS (
                        SELECT 1 FROM users ur2
                        WHERE ur2.employee_id = lr.employee_id
                    )
                    AND LOWER(TRIM(e.position)) = ?
                )
            )";
            $params[] = $requestRole;
            $params[] = $requestRole;
            $types .= 'ss';
        }
        
        $sql .= " ORDER BY lr.created_at DESC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
        }
        
        $leave_requests = [];
        while ($row = $result->fetch_assoc()) {
            $leave_requests[] = $row;
        }
        
        sendResponse(true, $leave_requests, 'Leave requests retrieved successfully');
    }
}

function handlePost($conn) {
    $data = getJSONInput();
    $role = getCurrentSessionRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireCurrentEmployeeId($conn) : 0;
    $actorEmployeeId = $isStaff ? $selfEmployeeId : getCurrentSessionEmployeeId($conn);

    if (($data['action'] ?? '') === 'comment') {
        handleCreateComment($conn, $data, $role, $selfEmployeeId);
        return;
    }

    if (!in_array($role, ['staff', 'manager', 'admin'], true)) {
        sendError('Only admin, manager, or staff can submit leave requests.', 403);
    }
    
    $required = ['leave_type', 'start_date', 'end_date'];
    if (!$isStaff) {
        $required[] = 'employee_id';
    }
    $missing = validateRequiredFields($data, $required);
    
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }
    
    $employee_id = $isStaff
        ? $selfEmployeeId
        : intval($data['employee_id']);
    if ($employee_id <= 0) {
        sendError('Employee ID is required', 400);
    }
    if (!$isStaff) {
        $targetRole = getEmployeeRoleForLeaveSubmission($conn, $employee_id);
        if ($targetRole === null) {
            sendError('Employee not found', 404);
        }
        if ($role === 'admin' && !in_array($targetRole, ['manager', 'staff'], true)) {
            if ($actorEmployeeId <= 0 || $employee_id !== $actorEmployeeId) {
                sendError('Admin can only create leave requests for manager or staff employees.', 403);
            }
        }
    }
    $leave_type = sanitizeInput($data['leave_type']);
    $start_date = sanitizeInput($data['start_date']);
    $end_date = sanitizeInput($data['end_date']);
    $reason = sanitizeInput($data['reason'] ?? '');
    $status = 'pending';

    $allowedLeaveTypes = getAllowedLeaveTypes($conn);
    if (empty($allowedLeaveTypes)) {
        sendError('No active leave types are configured. Please contact an admin.', 400);
    }
    if (!in_array($leave_type, $allowedLeaveTypes, true)) {
        sendError('Invalid leave type', 400);
    }

    if (!validateDate($start_date) || !validateDate($end_date)) {
        sendError('Invalid date format. Expected YYYY-MM-DD.', 400);
    }
    if (strtotime($end_date) < strtotime($start_date)) {
        sendError('End date cannot be earlier than start date.', 400);
    }
    validateLeaveFilingDates($start_date, $end_date);
    
    // Leave credits are charged for Monday-Friday only.
    $days = countLeaveWorkingDays($start_date, $end_date);
    if ($days < 1) {
        sendError('The selected range contains no working days. Saturday and Sunday are not counted as leave.', 400);
    }
    
    // Ensure and check leave balance
    $year = intval(substr($start_date, 0, 4));
    ensureEmployeeLeaveBalance($conn, $employee_id, $leave_type, $year);
    $balance_sql = "SELECT remaining_days FROM leave_balance 
                    WHERE employee_id = ? AND leave_type = ? AND year = ?";
    $balance_stmt = $conn->prepare($balance_sql);
    $balance_stmt->bind_param('isi', $employee_id, $leave_type, $year);
    $balance_stmt->execute();
    $balance_result = $balance_stmt->get_result();
    
    if ($balance_result->num_rows > 0) {
        $balance = $balance_result->fetch_assoc();
        // Unpaid leave has 0 allocation by default; skip hard block.
        if (strtolower($leave_type) !== 'unpaid' && floatval($balance['remaining_days']) < $days) {
            sendError('Insufficient leave balance', 400);
        }
    }
    $balance_stmt->close();

    // ── Duplicate guard (all user types): same employee + overlapping dates ──
    // Wrapped with the INSERT in one transaction and read FOR UPDATE: two
    // concurrent same-employee submits serialize, so the second one sees the
    // first one's row and gets the 409 instead of double-inserting.
    // (Any sendError exit rolls the transaction back on connection close.)
    $conn->begin_transaction();
    $duplicateLeave = findOverlappingLeaveRequest($conn, $employee_id, $start_date, $end_date, 0, true);
    if ($duplicateLeave) {
        $dupStatus = strtolower((string)($duplicateLeave['status'] ?? 'pending'));
        $dupStart = substr((string)($duplicateLeave['start_date'] ?? ''), 0, 10);
        $dupEnd = substr((string)($duplicateLeave['end_date'] ?? ''), 0, 10);
        sendError(
            'Duplicate leave request: this employee already has a ' . $dupStatus .
            ' leave request (' . $dupStart . ' to ' . $dupEnd . ') that overlaps these dates.',
            409,
            [
                'code' => 'duplicate_leave',
                'field' => 'start_date',
                'fields' => ['start_date', 'end_date'],
                'conflicting_status' => $dupStatus,
                'conflicting_start_date' => $dupStart,
                'conflicting_end_date' => $dupEnd,
                'conflicting_request_id' => intval($duplicateLeave['leave_request_id'] ?? 0),
            ]
        );
    }
    // ── Cross-type guard: overtime already filed inside this leave range ──
    $overtimeConflict = findOvertimeInLeaveRange($conn, $employee_id, $start_date, $end_date, 0, true);
    if ($overtimeConflict) {
        $otDate = substr((string)($overtimeConflict['work_date'] ?? ''), 0, 10);
        sendError(
            'Duplicate date: this employee already has an overtime request on ' .
            $otDate . ' which falls inside these leave dates.',
            409,
            [
                'code' => 'duplicate_overtime_date',
                'field' => 'start_date',
                'fields' => ['start_date', 'end_date'],
                'conflicting_status' => strtolower((string)($overtimeConflict['status'] ?? 'submitted')),
                'conflicting_work_date' => $otDate,
                'conflicting_request_id' => intval($overtimeConflict['overtime_request_id'] ?? 0),
            ]
        );
    }

    $sql = "INSERT INTO leave_request (employee_id, leave_type, start_date, end_date, reason, status) 
            VALUES (?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('isssss', $employee_id, $leave_type, $start_date, $end_date, $reason, $status);
    
    if ($stmt->execute()) {
        $leave_id = $conn->insert_id;
        $conn->commit();
        $afterLeave = getLeaveRequestRecord($conn, $leave_id);
        
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'create_leave_request', "Created leave request for employee ID: $employee_id", 'leave_management');
            logAuditTrail($conn, $user_id, 'leave_request', $leave_id, 'create', null, $afterLeave, basename(__FILE__));
        }

        upsertExceptionQueue(
            $conn,
            'leave_request',
            (string)$leave_id,
            'Leave request pending approval',
            'Leave request #' . $leave_id . ' is waiting for review.',
            'medium',
            'admin',
            [
                'leave_request_id' => $leave_id,
                'employee_id' => $employee_id,
                'status' => 'pending',
            ],
            intval($_SESSION['user_id'] ?? 0) > 0 ? intval($_SESSION['user_id'] ?? 0) : null
        );
        
        sendResponse(true, ['leave_request_id' => $leave_id], 'Leave request created successfully', 201);
    } else {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to create leave request.', 500);
    }
}

function handlePut($conn) {
    $data = getJSONInput();
    $role = getCurrentSessionRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireCurrentEmployeeId($conn) : 0;
    
    if (!isset($data['leave_request_id'])) {
        sendError('Leave request ID is required', 400);
    }
    
    $leave_id = intval($data['leave_request_id']);
    
    // Handle approval/rejection/archive/restore
    if (isset($data['action']) && in_array($data['action'], ['approve', 'reject', 'archive', 'restore'], true)) {
        // Only admin and manager can review or restore leave requests
        requireMinRole('manager');
        $action = strtolower((string)$data['action']);
        $actor_employee_id = getCurrentSessionEmployeeId($conn);

        if ($actor_employee_id <= 0) {
            sendError('Your account is not linked to an employee record.', 403);
        }

        $beforeAction = getLeaveRequestRecord($conn, $leave_id);
        $leave_sql = "SELECT employee_id, leave_type, start_date, end_date, status FROM leave_request WHERE leave_request_id = ? LIMIT 1";
        $leave_stmt = $conn->prepare($leave_sql);
        $leave_stmt->bind_param('i', $leave_id);
        $leave_stmt->execute();
        $leave_data = $leave_stmt->get_result()->fetch_assoc();
        $leave_stmt->close();

        if (!$leave_data) {
            sendError('Leave request not found', 404);
        }

        $targetRole = getEmployeeRoleForLeaveSubmission($conn, intval($leave_data['employee_id'] ?? 0));
        if ($role === 'manager' && $targetRole !== 'staff') {
            if (intval($leave_data['employee_id'] ?? 0) === intval($actor_employee_id)) {
                sendError('Managers cannot approve their own leave requests. Please have an admin review it.', 403);
            }
            sendError('Managers can only approve staff leave requests. Please have an admin review this request.', 403);
        }

        $current_status = strtolower((string)($leave_data['status'] ?? ''));

        if ($action === 'restore') {
            if (!in_array($current_status, ['approved', 'rejected', 'archived', 'cancelled'], true)) {
                sendError('Only archived leave requests can be restored', 400);
            }

            // ── Duplicate guard on restore: another active leave may now overlap ──
            $restoreDup = findOverlappingLeaveRequest(
                $conn,
                intval($leave_data['employee_id'] ?? 0),
                (string)($leave_data['start_date'] ?? ''),
                (string)($leave_data['end_date'] ?? ''),
                $leave_id
            );
            if ($restoreDup) {
                $restoreDupStatus = strtolower((string)($restoreDup['status'] ?? 'pending'));
                $restoreDupStart = substr((string)($restoreDup['start_date'] ?? ''), 0, 10);
                $restoreDupEnd = substr((string)($restoreDup['end_date'] ?? ''), 0, 10);
                sendError(
                    'Cannot restore: this employee already has a ' . $restoreDupStatus .
                    ' leave request (' . $restoreDupStart . ' to ' . $restoreDupEnd . ') that overlaps these dates.',
                    409,
                    [
                        'code' => 'duplicate_leave',
                        'field' => 'start_date',
                        'fields' => ['start_date', 'end_date'],
                        'conflicting_status' => $restoreDupStatus,
                        'conflicting_start_date' => $restoreDupStart,
                        'conflicting_end_date' => $restoreDupEnd,
                        'conflicting_request_id' => intval($restoreDup['leave_request_id'] ?? 0),
                    ]
                );
            }
            $restoreOt = findOvertimeInLeaveRange(
                $conn,
                intval($leave_data['employee_id'] ?? 0),
                (string)($leave_data['start_date'] ?? ''),
                (string)($leave_data['end_date'] ?? '')
            );
            if ($restoreOt) {
                $restoreOtDate = substr((string)($restoreOt['work_date'] ?? ''), 0, 10);
                sendError(
                    'Cannot restore: this employee already has an overtime request on ' .
                    $restoreOtDate . ' inside these leave dates.',
                    409,
                    [
                        'code' => 'duplicate_overtime_date',
                        'field' => 'start_date',
                        'fields' => ['start_date', 'end_date'],
                        'conflicting_status' => strtolower((string)($restoreOt['status'] ?? 'submitted')),
                        'conflicting_work_date' => $restoreOtDate,
                        'conflicting_request_id' => intval($restoreOt['overtime_request_id'] ?? 0),
                    ]
                );
            }

            $sql = "UPDATE leave_request
                    SET status = 'pending', approved_by = NULL, approved_at = NULL
                    WHERE leave_request_id = ? AND status IN ('approved', 'rejected', 'archived', 'cancelled')";
            $stmt = $conn->prepare($sql);
            if (!$stmt) {
                sendError('Failed to prepare restore update', 500);
            }
            $stmt->bind_param('i', $leave_id);

            if (!$stmt->execute()) {
                error_log($conn->error);
                sendError('Failed to restore leave request.', 500);
            }

            if ($stmt->affected_rows <= 0) {
                sendError('Leave request is no longer archived', 409);
            }

            // Reverse previous leave balance deduction when restoring an approved request.
            if ($current_status === 'approved') {
                $days = countLeaveWorkingDays($leave_data['start_date'], $leave_data['end_date']);

                $year = intval(substr((string)$leave_data['start_date'], 0, 4));
                $restore_balance = "UPDATE leave_balance
                                    SET used_days = GREATEST(used_days - ?, 0),
                                        remaining_days = remaining_days + ?
                                    WHERE employee_id = ? AND leave_type = ? AND year = ?";
                $balance_stmt = $conn->prepare($restore_balance);
                if ($balance_stmt) {
                    $balance_stmt->bind_param('ddisi', $days, $days, $leave_data['employee_id'], $leave_data['leave_type'], $year);
                    $balance_stmt->execute();
                    $balance_stmt->close();
                }
            }

            logActivity($conn, $actor_employee_id, 'restore_leave', "Restored leave request to pending: $leave_id", 'leave_management');
            $afterAction = getLeaveRequestRecord($conn, $leave_id);
            logAuditTrail($conn, intval($_SESSION['user_id'] ?? 0), 'leave_request', $leave_id, 'restore', $beforeAction, $afterAction, basename(__FILE__));
            upsertExceptionQueue(
                $conn,
                'leave_request',
                (string)$leave_id,
                'Leave request pending approval',
                'Leave request #' . $leave_id . ' was restored to pending status.',
                'medium',
                'admin',
                [
                    'leave_request_id' => $leave_id,
                    'status' => 'pending',
                ],
                intval($_SESSION['user_id'] ?? 0) > 0 ? intval($_SESSION['user_id'] ?? 0) : null
            );
            sendResponse(true, null, 'Leave request restored successfully');
        }

        $status = $action === 'approve' ? 'approved' : 'rejected';
        if ($current_status !== 'pending') {
            sendError('Only pending leave requests can be approved or archived', 400);
        }

        if ($status === 'approved') {
            $workingDays = countLeaveWorkingDays($leave_data['start_date'], $leave_data['end_date']);
            if ($workingDays < 1) {
                sendError('This request contains no working days. Saturday and Sunday are excluded.', 400);
            }
            $balanceYear = intval(substr((string)$leave_data['start_date'], 0, 4));
            ensureEmployeeLeaveBalance($conn, intval($leave_data['employee_id']), (string)$leave_data['leave_type'], $balanceYear);
            if (strtolower((string)$leave_data['leave_type']) !== 'unpaid') {
                $balanceCheck = $conn->prepare(
                    "SELECT remaining_days FROM leave_balance WHERE employee_id = ? AND leave_type = ? AND year = ? LIMIT 1"
                );
                if ($balanceCheck) {
                    $balanceCheck->bind_param('isi', $leave_data['employee_id'], $leave_data['leave_type'], $balanceYear);
                    $balanceCheck->execute();
                    $balanceRow = $balanceCheck->get_result()->fetch_assoc();
                    $balanceCheck->close();
                    if (!$balanceRow || (float)$balanceRow['remaining_days'] < $workingDays) {
                        sendError('Insufficient leave balance for the working days in this request.', 400);
                    }
                }
            }
        }

        $sql = "UPDATE leave_request SET status = ?, approved_by = ?, approved_at = NOW() WHERE leave_request_id = ? AND status = 'pending'";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('sii', $status, $actor_employee_id, $leave_id);

        if ($stmt->execute()) {
            if ($stmt->affected_rows <= 0) {
                sendError('Leave request is no longer pending', 409);
            }
            // Update leave balance if approved
            if ($status === 'approved') {
                $days = countLeaveWorkingDays($leave_data['start_date'], $leave_data['end_date']);

                $year = intval(substr((string)$leave_data['start_date'], 0, 4));
                ensureEmployeeLeaveBalance(
                    $conn,
                    intval($leave_data['employee_id'] ?? 0),
                    (string)($leave_data['leave_type'] ?? ''),
                    $year
                );
                $update_balance = "UPDATE leave_balance 
                                  SET used_days = used_days + ?, 
                                      remaining_days = remaining_days - ?
                                  WHERE employee_id = ? AND leave_type = ? AND year = ?";
                $balance_stmt = $conn->prepare($update_balance);
                if ($balance_stmt) {
                    $balance_stmt->bind_param('ddisi', $days, $days, $leave_data['employee_id'], $leave_data['leave_type'], $year);
                    $balance_stmt->execute();
                    $balance_stmt->close();
                }
            }


            $label = $status === 'approved' ? 'approved' : 'archived';
            logActivity($conn, $actor_employee_id, 'approve_leave', "Leave request $label: $leave_id", 'leave_management');
            $afterAction = getLeaveRequestRecord($conn, $leave_id);
            logAuditTrail($conn, intval($_SESSION['user_id'] ?? 0), 'leave_request', $leave_id, 'update_status', $beforeAction, $afterAction, basename(__FILE__));

            $resolveSql = "UPDATE exception_queue
                           SET status = 'resolved',
                               resolved_by = ?,
                               resolved_at = NOW()
                           WHERE source_type = 'leave_request'
                             AND source_record_id = ?";
            $resolveStmt = $conn->prepare($resolveSql);
            if ($resolveStmt) {
                $sourceId = (string)$leave_id;
                $resolveBy = intval($_SESSION['user_id'] ?? 0);
                $resolveStmt->bind_param('is', $resolveBy, $sourceId);
                $resolveStmt->execute();
                $resolveStmt->close();
            }

            sendResponse(true, null, "Leave request $label successfully");
        } else {
            error_log($conn->error);
            sendError('Failed to update leave request.', 500);
        }
    } else {
        // Regular update
        $updates = [];
        $params = [];
        $types = '';
        $currentRecord = getLeaveRequestRecord($conn, $leave_id);
        if (!$currentRecord) {
            sendError('Leave request not found', 404);
        }
        
        if ($isStaff) {
            $ownCheck = $conn->prepare("SELECT leave_request_id, status, employee_id FROM leave_request WHERE leave_request_id = ? LIMIT 1");
            $ownCheck->bind_param('i', $leave_id);
            $ownCheck->execute();
            $ownRecord = $ownCheck->get_result()->fetch_assoc();
            $ownCheck->close();

            if (!$ownRecord) sendError('Leave request not found', 404);
            if (intval($ownRecord['employee_id']) !== $selfEmployeeId) sendError('Forbidden', 403);
            if (($ownRecord['status'] ?? '') !== 'pending') sendError('Only pending leave requests can be updated', 400);
        } else {
            if (strtolower((string)($currentRecord['status'] ?? '')) !== 'pending') {
                sendError('Only pending leave requests can be updated', 400);
            }
        }

        $allowed_fields = ['start_date', 'end_date', 'reason'];

        $nextStartDate = isset($data['start_date']) ? sanitizeInput($data['start_date']) : (string)($currentRecord['start_date'] ?? '');
        $nextEndDate = isset($data['end_date']) ? sanitizeInput($data['end_date']) : (string)($currentRecord['end_date'] ?? '');
        if ($nextStartDate !== '' && $nextEndDate !== '') {
            if (!validateDate($nextStartDate) || !validateDate($nextEndDate)) {
                sendError('Invalid date format. Expected YYYY-MM-DD.', 400);
            }
            if (strtotime($nextEndDate) < strtotime($nextStartDate)) {
                sendError('End date cannot be earlier than start date.', 400);
            }
            if (countLeaveWorkingDays($nextStartDate, $nextEndDate) < 1) {
                sendError('The selected range contains no working days. Saturday and Sunday are not counted as leave.', 400);
            }
            if (isset($data['start_date']) || isset($data['end_date'])) {
                validateLeaveFilingDates($nextStartDate, $nextEndDate);
            }
            // ── Duplicate guard on date edit (all user types) ──
            if (isset($data['start_date']) || isset($data['end_date'])) {
                $editDup = findOverlappingLeaveRequest(
                    $conn,
                    intval($currentRecord['employee_id'] ?? 0),
                    $nextStartDate,
                    $nextEndDate,
                    $leave_id
                );
                if ($editDup) {
                    $editDupStatus = strtolower((string)($editDup['status'] ?? 'pending'));
                    $editDupStart = substr((string)($editDup['start_date'] ?? ''), 0, 10);
                    $editDupEnd = substr((string)($editDup['end_date'] ?? ''), 0, 10);
                    sendError(
                        'Duplicate leave request: this employee already has a ' . $editDupStatus .
                        ' leave request (' . $editDupStart . ' to ' . $editDupEnd . ') that overlaps these dates.',
                        409,
                        [
                            'code' => 'duplicate_leave',
                            'field' => 'start_date',
                            'fields' => ['start_date', 'end_date'],
                            'conflicting_status' => $editDupStatus,
                            'conflicting_start_date' => $editDupStart,
                            'conflicting_end_date' => $editDupEnd,
                            'conflicting_request_id' => intval($editDup['leave_request_id'] ?? 0),
                        ]
                    );
                }
                $editOt = findOvertimeInLeaveRange(
                    $conn,
                    intval($currentRecord['employee_id'] ?? 0),
                    $nextStartDate,
                    $nextEndDate
                );
                if ($editOt) {
                    $editOtDate = substr((string)($editOt['work_date'] ?? ''), 0, 10);
                    sendError(
                        'Duplicate date: this employee already has an overtime request on ' .
                        $editOtDate . ' which falls inside these leave dates.',
                        409,
                        [
                            'code' => 'duplicate_overtime_date',
                            'field' => 'start_date',
                            'fields' => ['start_date', 'end_date'],
                            'conflicting_status' => strtolower((string)($editOt['status'] ?? 'submitted')),
                            'conflicting_work_date' => $editOtDate,
                            'conflicting_request_id' => intval($editOt['overtime_request_id'] ?? 0),
                        ]
                    );
                }
            }
        }
        
        foreach ($allowed_fields as $field) {
            if (isset($data[$field])) {
                $updates[] = "$field = ?";
                $params[] = sanitizeInput($data[$field]);
                $types .= 's';
            }
        }
        
        if (empty($updates)) {
            sendError('No fields to update', 400);
        }
        
        $params[] = $leave_id;
        $types .= 'i';
        
        $sql = "UPDATE leave_request SET " . implode(', ', $updates) . " WHERE leave_request_id = ?";
        
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        
        if ($stmt->execute()) {
            $afterRegular = getLeaveRequestRecord($conn, $leave_id);
            logAuditTrail($conn, intval($_SESSION['user_id'] ?? 0), 'leave_request', $leave_id, 'update', $currentRecord, $afterRegular, basename(__FILE__));
            sendResponse(true, null, 'Leave request updated successfully');
        } else {
            error_log($conn->error);
            sendError('Failed to update leave request.', 500);
        }
    }
}

function handleDelete($conn) {
    $leave_id = $_GET['id'] ?? null;
    $role = getCurrentSessionRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireCurrentEmployeeId($conn) : 0;
    
    if (!$leave_id) {
        sendError('Leave request ID is required', 400);
    }
    
    $leave_id = intval($leave_id);
    
    // Only allow cancellation of pending requests or deletion of archived requests
    $check_sql = "SELECT leave_request_id, status, employee_id, leave_type, start_date, end_date FROM leave_request WHERE leave_request_id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $leave_id);
    $check_stmt->execute();
    $result = $check_stmt->get_result();
    
    if ($result->num_rows === 0) {
        sendError('Leave request not found', 404);
    }
    
    $record = $result->fetch_assoc();
    if ($isStaff && intval($record['employee_id'] ?? 0) !== $selfEmployeeId) {
        sendError('Forbidden', 403);
    }
    $current_status = strtolower((string)($record['status'] ?? ''));
    if ($current_status !== 'pending') {
        if (!in_array($current_status, ['approved', 'rejected', 'archived', 'cancelled'], true)) {
            sendError('Only archived leave requests can be deleted', 400);
        }

        requireMinRole('manager');
        $actor_employee_id = getCurrentSessionEmployeeId($conn);
        if ($actor_employee_id <= 0) {
            sendError('Your account is not linked to an employee record.', 403);
        }

        $targetRole = getEmployeeRoleForLeaveSubmission($conn, intval($record['employee_id'] ?? 0));
        if ($role === 'manager' && $targetRole !== 'staff') {
            sendError('Managers can only delete staff leave requests.', 403);
        }

        $beforeDelete = getLeaveRequestRecord($conn, $leave_id);
        $delete_stmt = $conn->prepare("DELETE FROM leave_request WHERE leave_request_id = ? LIMIT 1");
        if (!$delete_stmt) {
            sendError('Failed to prepare delete leave request', 500);
        }
        $delete_stmt->bind_param('i', $leave_id);

        if (!$delete_stmt->execute()) {
            error_log($conn->error);
            sendError('Failed to delete leave request.', 500);
        }
        $delete_stmt->close();

        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'delete_leave', "Deleted archived leave request ID: $leave_id", 'leave_management');
            logAuditTrail($conn, $user_id, 'leave_request', $leave_id, 'delete', $beforeDelete, null, basename(__FILE__));
        }

        sendResponse(true, null, 'Leave request deleted successfully');
    }

    $sql = "UPDATE leave_request SET status = 'cancelled' WHERE leave_request_id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $leave_id);
    
    if ($stmt->execute()) {
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'cancel_leave', "Cancelled leave request ID: $leave_id", 'leave_management');
            logAuditTrail($conn, $user_id, 'leave_request', $leave_id, 'cancel', $record, ['status' => 'cancelled'], basename(__FILE__));
        }

        $resolveSql = "UPDATE exception_queue
                       SET status = 'resolved',
                           resolved_by = ?,
                           resolved_at = NOW()
                       WHERE source_type = 'leave_request'
                         AND source_record_id = ?";
        $resolveStmt = $conn->prepare($resolveSql);
        if ($resolveStmt) {
            $sourceId = (string)$leave_id;
            $resolveBy = intval($_SESSION['user_id'] ?? 0);
            $resolveStmt->bind_param('is', $resolveBy, $sourceId);
            $resolveStmt->execute();
            $resolveStmt->close();
        }
        
        sendResponse(true, null, 'Leave request cancelled successfully');
    } else {
        error_log($conn->error);
        sendError('Failed to cancel leave request.', 500);
    }
}

closeDBConnection($conn);
?>
