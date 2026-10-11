<?php
/**
 * Holidays API
 * Handles CRUD operations for holiday calendar entries.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureHolidayStorage($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('calendar', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function ensureHolidayStorage($conn) {
    $createSql = "CREATE TABLE IF NOT EXISTS holidays (
        holiday_id INT AUTO_INCREMENT PRIMARY KEY,
        holiday_name VARCHAR(160) NOT NULL,
        holiday_date DATE NOT NULL,
        holiday_type VARCHAR(60) NOT NULL DEFAULT 'Regular Holiday',
        holiday_scope VARCHAR(60) NOT NULL DEFAULT 'National',
        description TEXT NULL,
        source VARCHAR(140) NULL,
        is_system TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_holiday_date_name (holiday_date, holiday_name),
        INDEX idx_holiday_date (holiday_date),
        CONSTRAINT fk_holiday_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_holiday_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($createSql)) {
        error_log($conn->error);
        sendError('Failed to initialize holiday storage.', 500);
    }

    seedHolidayYearIfMissing($conn, intval(date('Y')));
}

function seedHolidayYearIfMissing($conn, $year) {
    if ($year <= 0) return;

    $start = sprintf('%04d-01-01', $year);
    $end = sprintf('%04d-12-31', $year);

    $checkStmt = $conn->prepare("SELECT COUNT(*) AS total FROM holidays WHERE holiday_date BETWEEN ? AND ?");
    if (!$checkStmt) return;
    $checkStmt->bind_param('ss', $start, $end);
    $checkStmt->execute();
    $row = $checkStmt->get_result()->fetch_assoc();
    $checkStmt->close();

    if (intval($row['total'] ?? 0) > 0) return;

    $seeds = getHolidaySeedsForYear($year);
    if (empty($seeds)) return;

    $insertSql = "INSERT INTO holidays
            (holiday_name, holiday_date, holiday_type, holiday_scope, description, source, is_system, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL)
            ON DUPLICATE KEY UPDATE
                holiday_type = VALUES(holiday_type),
                holiday_scope = VALUES(holiday_scope),
                description = VALUES(description),
                source = VALUES(source),
                is_system = 1";
    $stmt = $conn->prepare($insertSql);
    if (!$stmt) return;

    foreach ($seeds as $seed) {
        $name = sanitizeInput($seed['holiday_name'] ?? '');
        $date = sanitizeInput($seed['holiday_date'] ?? '');
        $type = sanitizeInput($seed['holiday_type'] ?? 'Regular Holiday');
        $scope = sanitizeInput($seed['holiday_scope'] ?? 'National');
        $description = sanitizeInput($seed['description'] ?? '');
        $source = sanitizeInput($seed['source'] ?? '');

        if ($name === '' || $date === '' || !validateDate($date)) continue;

        $stmt->bind_param('ssssss', $name, $date, $type, $scope, $description, $source);
        $stmt->execute();
    }

    $stmt->close();
}

function getHolidaySeedsForYear($year) {
    $source = 'Proclamation No. 1006 (s. 2025)';
    $regular = 'Regular Holiday';
    $special = 'Special Non-Working Day';
    $specialWorking = 'Special Working Day';
    $additionalSpecial = 'Additional Special Non-Working Day';
    $scope = 'National';

    $map = [
        2026 => [
            ['holiday_name' => "New Year's Day", 'holiday_date' => '2026-01-01', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "EDSA People Power Revolution Anniversary", 'holiday_date' => '2026-02-25', 'holiday_type' => $specialWorking, 'holiday_scope' => $scope, 'description' => $specialWorking, 'source' => $source],
            ['holiday_name' => "Chinese New Year", 'holiday_date' => '2026-02-17', 'holiday_type' => $additionalSpecial, 'holiday_scope' => $scope, 'description' => $additionalSpecial, 'source' => $source],
            ['holiday_name' => "Maundy Thursday", 'holiday_date' => '2026-04-02', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Good Friday", 'holiday_date' => '2026-04-03', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Black Saturday", 'holiday_date' => '2026-04-04', 'holiday_type' => $additionalSpecial, 'holiday_scope' => $scope, 'description' => $additionalSpecial, 'source' => $source],
            ['holiday_name' => "Araw ng Kagitingan", 'holiday_date' => '2026-04-09', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Labor Day", 'holiday_date' => '2026-05-01', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Independence Day", 'holiday_date' => '2026-06-12', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Ninoy Aquino Day", 'holiday_date' => '2026-08-21', 'holiday_type' => $special, 'holiday_scope' => $scope, 'description' => $special, 'source' => $source],
            ['holiday_name' => "National Heroes Day", 'holiday_date' => '2026-08-31', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "All Saints' Day", 'holiday_date' => '2026-11-01', 'holiday_type' => $special, 'holiday_scope' => $scope, 'description' => $special, 'source' => $source],
            ['holiday_name' => "All Souls' Day", 'holiday_date' => '2026-11-02', 'holiday_type' => $additionalSpecial, 'holiday_scope' => $scope, 'description' => $additionalSpecial, 'source' => $source],
            ['holiday_name' => "Bonifacio Day", 'holiday_date' => '2026-11-30', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Feast of the Immaculate Conception of Mary", 'holiday_date' => '2026-12-08', 'holiday_type' => $special, 'holiday_scope' => $scope, 'description' => $special, 'source' => $source],
            ['holiday_name' => "Christmas Eve", 'holiday_date' => '2026-12-24', 'holiday_type' => $additionalSpecial, 'holiday_scope' => $scope, 'description' => $additionalSpecial, 'source' => $source],
            ['holiday_name' => "Christmas Day", 'holiday_date' => '2026-12-25', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Rizal Day", 'holiday_date' => '2026-12-30', 'holiday_type' => $regular, 'holiday_scope' => $scope, 'description' => $regular, 'source' => $source],
            ['holiday_name' => "Last Day of the Year", 'holiday_date' => '2026-12-31', 'holiday_type' => $special, 'holiday_scope' => $scope, 'description' => $special, 'source' => $source],
        ],
    ];

    return $map[$year] ?? [];
}

function normalizeHolidayText($value, $limit) {
    $text = trim((string)$value);
    if ($text === '') return '';
    if (strlen($text) > $limit) {
        $text = substr($text, 0, $limit);
    }
    return sanitizeInput($text);
}

function handleGet($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    $requestedYear = !empty($_GET['year']) ? intval($_GET['year']) : 0;

    if ($requestedYear > 0) {
        seedHolidayYearIfMissing($conn, $requestedYear);
    }

    $sql = "SELECT holiday_id, holiday_name, holiday_date, holiday_type, holiday_scope, description, source,
                   is_system, created_at, updated_at
            FROM holidays
            WHERE 1=1";

    $params = [];
    $types = '';

    if ($id > 0) {
        $sql .= " AND holiday_id = ?";
        $params[] = $id;
        $types .= 'i';
    }

    if ($requestedYear > 0) {
        $sql .= " AND holiday_date BETWEEN ? AND ?";
        $params[] = sprintf('%04d-01-01', $requestedYear);
        $params[] = sprintf('%04d-12-31', $requestedYear);
        $types .= 'ss';
    }

    if (!empty($_GET['date_from'])) {
        $sql .= " AND holiday_date >= ?";
        $params[] = sanitizeInput($_GET['date_from']);
        $types .= 's';
    }

    if (!empty($_GET['date_to'])) {
        $sql .= " AND holiday_date <= ?";
        $params[] = sanitizeInput($_GET['date_to']);
        $types .= 's';
    }

    if (!empty($_GET['search'])) {
        $search = '%' . sanitizeInput($_GET['search']) . '%';
        $sql .= " AND (holiday_name LIKE ? OR holiday_type LIKE ? OR holiday_scope LIKE ? OR description LIKE ?)";
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $params[] = $search;
        $types .= 'ssss';
    }

    $sql .= " ORDER BY holiday_date ASC, holiday_name ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare holiday query', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    if (!$result) sendError('Failed to retrieve holidays', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $row['is_system'] = intval($row['is_system']);
        $rows[] = $row;
    }

    if ($id > 0) {
        if (!empty($rows)) sendResponse(true, $rows[0], 'Holiday retrieved successfully');
        sendError('Holiday not found', 404);
    }

    sendResponse(true, $rows, 'Holidays retrieved successfully');
}

function handlePost($conn) {
    $data = getJSONInput();
    $missing = validateRequiredFields($data, ['holiday_name', 'holiday_date']);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $name = normalizeHolidayText($data['holiday_name'] ?? '', 160);
    $date = normalizeHolidayText($data['holiday_date'] ?? '', 10);
    $type = normalizeHolidayText($data['holiday_type'] ?? 'Regular Holiday', 60);
    $scope = normalizeHolidayText($data['holiday_scope'] ?? 'National', 60);
    $description = normalizeHolidayText($data['description'] ?? '', 2000);
    $source = normalizeHolidayText($data['source'] ?? '', 140);

    if ($name === '') sendError('Holiday name is required', 400);
    if ($date === '' || !validateDate($date)) sendError('Invalid holiday date format (expected Y-m-d)', 400);
    if ($type === '') $type = 'Regular Holiday';
    if ($scope === '') $scope = 'National';

    $userId = intval($_SESSION['user_id'] ?? 0);

    $sql = "INSERT INTO holidays
            (holiday_name, holiday_date, holiday_type, holiday_scope, description, source, is_system, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare insert', 500);
    $stmt->bind_param('ssssssii', $name, $date, $type, $scope, $description, $source, $userId, $userId);

    if ($stmt->execute()) {
        sendResponse(true, ['holiday_id' => $conn->insert_id], 'Holiday created successfully', 201);
    }

    if ($conn->errno === 1062) sendError('Holiday already exists for this date', 409);
    error_log($conn->error);
    sendError('Failed to create holiday.', 500);
}

function handlePut($conn) {
    $data = getJSONInput();
    if (!isset($data['holiday_id'])) sendError('Holiday ID is required', 400);

    $holiday_id = intval($data['holiday_id']);
    if ($holiday_id <= 0) sendError('Invalid holiday ID', 400);

    $check = $conn->prepare("SELECT holiday_id FROM holidays WHERE holiday_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $holiday_id);
    $check->execute();
    $current = $check->get_result()->fetch_assoc();
    $check->close();
    if (!$current) sendError('Holiday not found', 404);

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('holiday_name', $data)) {
        $name = normalizeHolidayText($data['holiday_name'] ?? '', 160);
        if ($name === '') sendError('Holiday name is required', 400);
        $updates[] = "holiday_name = ?";
        $params[] = $name;
        $types .= 's';
    }

    if (array_key_exists('holiday_date', $data)) {
        $date = normalizeHolidayText($data['holiday_date'] ?? '', 10);
        if ($date === '' || !validateDate($date)) sendError('Invalid holiday date format (expected Y-m-d)', 400);
        $updates[] = "holiday_date = ?";
        $params[] = $date;
        $types .= 's';
    }

    if (array_key_exists('holiday_type', $data)) {
        $type = normalizeHolidayText($data['holiday_type'] ?? '', 60);
        if ($type === '') $type = 'Regular Holiday';
        $updates[] = "holiday_type = ?";
        $params[] = $type;
        $types .= 's';
    }

    if (array_key_exists('holiday_scope', $data)) {
        $scope = normalizeHolidayText($data['holiday_scope'] ?? '', 60);
        if ($scope === '') $scope = 'National';
        $updates[] = "holiday_scope = ?";
        $params[] = $scope;
        $types .= 's';
    }

    if (array_key_exists('description', $data)) {
        $description = normalizeHolidayText($data['description'] ?? '', 2000);
        $updates[] = "description = ?";
        $params[] = $description;
        $types .= 's';
    }

    if (array_key_exists('source', $data)) {
        $source = normalizeHolidayText($data['source'] ?? '', 140);
        $updates[] = "source = ?";
        $params[] = $source;
        $types .= 's';
    }

    if (empty($updates)) sendError('No fields provided for update', 400);

    $userId = intval($_SESSION['user_id'] ?? 0);
    $updates[] = "updated_by = ?";
    $params[] = $userId;
    $types .= 'i';

    $params[] = $holiday_id;
    $types .= 'i';

    $sql = "UPDATE holidays SET " . implode(', ', $updates) . " WHERE holiday_id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare update', 500);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        sendResponse(true, null, 'Holiday updated successfully');
    }

    if ($conn->errno === 1062) sendError('Holiday already exists for this date', 409);
    error_log($conn->error);
    sendError('Failed to update holiday.', 500);
}

function handleDelete($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if ($id <= 0) {
        $payload = getJSONInput();
        $id = intval($payload['holiday_id'] ?? 0);
    }

    if ($id <= 0) sendError('Holiday ID is required', 400);

    $check = $conn->prepare("SELECT holiday_id FROM holidays WHERE holiday_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    $current = $check->get_result()->fetch_assoc();
    $check->close();
    if (!$current) sendError('Holiday not found', 404);

    $stmt = $conn->prepare("DELETE FROM holidays WHERE holiday_id = ?");
    if (!$stmt) sendError('Failed to prepare delete', 500);
    $stmt->bind_param('i', $id);

    if ($stmt->execute()) {
        sendResponse(true, null, 'Holiday deleted successfully');
    }

    error_log($conn->error);
    sendError('Failed to delete holiday.', 500);
}

?>
