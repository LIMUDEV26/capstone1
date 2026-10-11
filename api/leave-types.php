<?php
/**
 * Leave Types API
 * Handles CRUD operations for configurable leave types.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureLeaveTypeStorage($conn);

switch ($method) {
    case 'GET':
        requireAuth();
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

function getDefaultLeaveTypeSeeds() {
    // Figures follow Philippine statutory defaults where applicable
    // (service incentive, maternity, paternity, solo parent, VAWC, Magna
    // Carta special leave); the rest are company-policy defaults. Admins can
    // edit days/paid status per type in Settings → Leave Management.
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


function normalizeLeaveTypeKey($value) {
    $raw = strtolower(trim((string)$value));
    if ($raw === '') return '';
    $raw = preg_replace('/[^a-z0-9]+/', '_', $raw);
    $raw = trim((string)$raw, '_');
    if ($raw === '') return '';
    if (strlen($raw) > 100) {
        $raw = substr($raw, 0, 100);
        $raw = rtrim($raw, '_');
    }
    return $raw;
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

    // One-time bootstrap for rows that predate the figures columns: fill
    // statutory/company defaults only where admin has not set a value yet
    // (default_days IS NULL), so custom edits are never overwritten.
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

    // Run the annual 12-day policy migration once, then preserve later admin edits.
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

function handleGet($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    $sql = "SELECT leave_type_id, type_key, type_name, description, default_days, is_paid, is_active, created_at, updated_at
            FROM leave_type
            WHERE 1=1";
    $params = [];
    $types = '';

    if ($id > 0) {
        $sql .= " AND leave_type_id = ?";
        $params[] = $id;
        $types .= 'i';
    }

    if (isset($_GET['is_active']) && $_GET['is_active'] !== '') {
        $sql .= " AND is_active = ?";
        $params[] = intval($_GET['is_active']) ? 1 : 0;
        $types .= 'i';
    }

    if (!empty($_GET['search'])) {
        $search = '%' . sanitizeInput($_GET['search']) . '%';
        $sql .= " AND (type_name LIKE ? OR type_key LIKE ? OR description LIKE ?)";
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $types .= 'sss';
    }

    $sql .= " ORDER BY type_name ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare query', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    if (!$result) sendError('Failed to retrieve leave types', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $row['is_active'] = intval($row['is_active']);
        $row['is_paid'] = intval($row['is_paid'] ?? 1);
        $row['default_days'] = $row['default_days'] === null ? null : (float)$row['default_days'];
        $rows[] = $row;
    }

    if ($id > 0) {
        if (!empty($rows)) {
            sendResponse(true, $rows[0], 'Leave type retrieved successfully');
        }
        sendError('Leave type not found', 404);
    }

    sendResponse(true, $rows, 'Leave types retrieved successfully');
}

function fetchLeaveTypeById($conn, $id) {
    $stmt = $conn->prepare("SELECT leave_type_id, type_key, type_name, description, default_days, is_paid, is_active, created_at, updated_at FROM leave_type WHERE leave_type_id = ? LIMIT 1");
    if (!$stmt) return null;
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if ($row) {
        $row['is_active'] = intval($row['is_active']);
        $row['is_paid'] = intval($row['is_paid'] ?? 1);
        $row['default_days'] = $row['default_days'] === null ? null : (float)$row['default_days'];
    }
    return $row ?: null;
}

/**
 * Normalize the editable day figure: ''/null stays NULL (falls back to the
 * built-in allocation default), otherwise a number clamped to 0..365.
 */
function normalizeLeaveTypeFigureDays($value, &$isNull) {
    if (!isset($value) || $value === '' || $value === null) {
        $isNull = true;
        return null;
    }
    if (!is_numeric($value)) sendError('Days allowed must be a number.', 400);
    $days = round((float)$value, 1);
    if ($days < 0 || $days > 365) sendError('Days allowed must be between 0 and 365.', 400);
    $isNull = false;
    return $days;
}

function handlePost($conn) {
    $data = getJSONInput();

    $required = ['type_name'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $typeName = trim((string)($data['type_name'] ?? ''));
    $typeName = sanitizeInput($typeName);
    if ($typeName === '') sendError('Type name is required', 400);
    if (strlen($typeName) > 120) sendError('Type name is too long (max 120 characters)', 400);

    $typeKeyRaw = trim((string)($data['type_key'] ?? ''));
    $typeKey = normalizeLeaveTypeKey($typeKeyRaw !== '' ? $typeKeyRaw : $typeName);
    if ($typeKey === '') sendError('Unable to generate a valid leave type key', 400);

    $description = sanitizeInput(trim((string)($data['description'] ?? '')));

    $daysIsNull = true;
    $defaultDays = normalizeLeaveTypeFigureDays($data['default_days'] ?? null, $daysIsNull);
    $isPaid = array_key_exists('is_paid', $data) ? (!empty($data['is_paid']) ? 1 : 0) : 1;

    if ($daysIsNull) {
        $sql = "INSERT INTO leave_type (type_key, type_name, description, default_days, is_paid, is_active)
                VALUES (?, ?, ?, NULL, ?, 1)";
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare insert', 500);
        $stmt->bind_param('sssi', $typeKey, $typeName, $description, $isPaid);
    } else {
        $sql = "INSERT INTO leave_type (type_key, type_name, description, default_days, is_paid, is_active)
                VALUES (?, ?, ?, ?, ?, 1)";
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare insert', 500);
        $stmt->bind_param('sssdi', $typeKey, $typeName, $description, $defaultDays, $isPaid);
    }

    if ($stmt->execute()) {
        sendResponse(true, fetchLeaveTypeById($conn, (int)$conn->insert_id), 'Leave type created successfully', 201);
    }

    if ($conn->errno === 1062) sendError('Leave type name or key already exists', 409);
    error_log($conn->error);
    sendError('Failed to create leave type.', 500);
}

function handlePut($conn) {
    $data = getJSONInput();
    if (!isset($data['leave_type_id'])) sendError('Leave type ID is required', 400);

    $id = intval($data['leave_type_id']);
    if ($id <= 0) sendError('Invalid leave type ID', 400);

    $check = $conn->prepare("SELECT leave_type_id FROM leave_type WHERE leave_type_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    if ($check->get_result()->num_rows === 0) sendError('Leave type not found', 404);

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('type_name', $data)) {
        $typeName = sanitizeInput(trim((string)$data['type_name']));
        if ($typeName === '') sendError('Type name cannot be empty', 400);
        if (strlen($typeName) > 120) sendError('Type name is too long (max 120 characters)', 400);
        $updates[] = "type_name = ?";
        $params[] = $typeName;
        $types .= 's';
    }
    if (array_key_exists('description', $data)) {
        $updates[] = "description = ?";
        $params[] = sanitizeInput(trim((string)$data['description']));
        $types .= 's';
    }
    if (array_key_exists('default_days', $data)) {
        $daysIsNull = true;
        $defaultDays = normalizeLeaveTypeFigureDays($data['default_days'], $daysIsNull);
        if ($daysIsNull) {
            $updates[] = "default_days = NULL";
        } else {
            $updates[] = "default_days = ?";
            $params[] = $defaultDays;
            $types .= 'd';
        }
    }
    if (array_key_exists('is_paid', $data)) {
        $updates[] = "is_paid = ?";
        $params[] = !empty($data['is_paid']) ? 1 : 0;
        $types .= 'i';
    }
    if (array_key_exists('is_active', $data)) {
        $updates[] = "is_active = ?";
        $params[] = !empty($data['is_active']) ? 1 : 0;
        $types .= 'i';
    }

    if (empty($updates)) sendError('No fields to update', 400);

    $params[] = $id;
    $types .= 'i';
    $sql = "UPDATE leave_type SET " . implode(', ', $updates) . " WHERE leave_type_id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare update', 500);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        sendResponse(true, fetchLeaveTypeById($conn, $id), 'Leave type updated successfully');
    }

    if ($conn->errno === 1062) sendError('Leave type name already exists', 409);
    error_log($conn->error);
    sendError('Failed to update leave type.', 500);
}

function handleDelete($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if ($id <= 0) sendError('Leave type ID is required', 400);

    $permanent = isset($_GET['permanent']) && intval($_GET['permanent']) === 1;

    $check = $conn->prepare("SELECT leave_type_id, type_key, type_name FROM leave_type WHERE leave_type_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    $row = $check->get_result()->fetch_assoc();
    if (!$row) sendError('Leave type not found', 404);

    $typeKey = (string)($row['type_key'] ?? '');
    if ($typeKey === '') sendError('Invalid leave type key', 500);

    if ($permanent) {
        $useStmt = $conn->prepare(
            "SELECT (
                (SELECT COUNT(*) FROM leave_request WHERE leave_type = ?)
                +
                (SELECT COUNT(*) FROM leave_balance WHERE leave_type = ?)
            ) AS total_refs"
        );
        if (!$useStmt) sendError('Failed to verify leave type usage', 500);
        $useStmt->bind_param('ss', $typeKey, $typeKey);
        $useStmt->execute();
        $usage = $useStmt->get_result()->fetch_assoc();
        $useStmt->close();
        $totalRefs = intval($usage['total_refs'] ?? 0);
        if ($totalRefs > 0) {
            sendError('Cannot permanently delete a leave type that is already used. Archive it instead.', 409);
        }

        $stmt = $conn->prepare("DELETE FROM leave_type WHERE leave_type_id = ?");
        if (!$stmt) sendError('Failed to prepare delete', 500);
        $stmt->bind_param('i', $id);
        if ($stmt->execute()) sendResponse(true, null, 'Leave type deleted permanently');
        error_log($conn->error);
        sendError('Failed to delete leave type.', 500);
    }

    $stmt = $conn->prepare("UPDATE leave_type SET is_active = 0 WHERE leave_type_id = ?");
    if (!$stmt) sendError('Failed to prepare archive update', 500);
    $stmt->bind_param('i', $id);
    if ($stmt->execute()) sendResponse(true, fetchLeaveTypeById($conn, $id), 'Leave type archived successfully');
    error_log($conn->error);
    sendError('Failed to archive leave type.', 500);
}

closeDBConnection($conn);
?>
