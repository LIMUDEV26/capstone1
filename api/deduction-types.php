<?php
/**
 * Deduction Types API
 * Handles CRUD operations for deduction_type master file.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);

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

function normalizeThresholdMode($value) {
    $mode = strtolower(trim((string)$value));
    return in_array($mode, ['above', 'below'], true) ? $mode : 'none';
}

function normalizeThresholdRules($value) {
    if (is_string($value)) {
        $decoded = json_decode($value, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            $value = $decoded;
        }
    }

    if (!is_array($value)) {
        return [];
    }

    $rules = [];
    foreach ($value as $rule) {
        if (!is_array($rule)) continue;
        $mode = normalizeThresholdMode($rule['mode'] ?? ($rule['threshold_mode'] ?? 'none'));
        $amount = floatval($rule['amount'] ?? ($rule['threshold_amount'] ?? 0));
        if ($mode === 'none' || $amount <= 0) continue;
        $hasRate = array_key_exists('rate', $rule) || array_key_exists('threshold_rate', $rule);
        $rate = $hasRate ? floatval($rule['rate'] ?? ($rule['threshold_rate'] ?? 0)) : null;
        $entry = [
            'mode' => $mode,
            'amount' => round($amount, 2),
        ];
        if ($hasRate) {
            $entry['rate'] = round($rate, 4);
        }
        $rules[] = $entry;
    }

    return $rules;
}

function handleGet($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;

    $sql = "SELECT deduction_type_id, type_name, description, default_amount, is_percentage, is_active,
                   threshold_amount, threshold_mode, threshold_rules, base_floor, base_cap, created_at, updated_at
            FROM deduction_type
            WHERE 1=1";
    $params = [];
    $types = '';

    if ($id > 0) {
        $sql .= " AND deduction_type_id = ?";
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
        $sql .= " AND (type_name LIKE ? OR description LIKE ?)";
        $params[] = $search;
        $params[] = $search;
        $types .= 'ss';
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

    if (!$result) sendError('Failed to retrieve deduction types', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $row['is_percentage'] = intval($row['is_percentage']);
        $row['is_active'] = intval($row['is_active']);
        $rows[] = $row;
    }

    if ($id > 0) {
        if (!empty($rows)) sendResponse(true, $rows[0], 'Deduction type retrieved successfully');
        sendError('Deduction type not found', 404);
    }

    sendResponse(true, $rows, 'Deduction types retrieved successfully');
}

function fetchDeductionTypeById($conn, $id) {
    $stmt = $conn->prepare("SELECT deduction_type_id, type_name, description, default_amount, is_percentage, is_active,
                                   threshold_amount, threshold_mode, threshold_rules, base_floor, base_cap, created_at, updated_at
                            FROM deduction_type
                            WHERE deduction_type_id = ?
                            LIMIT 1");
    if (!$stmt) return null;
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if ($row) {
        $row['is_percentage'] = intval($row['is_percentage']);
        $row['is_active'] = intval($row['is_active']);
    }
    return $row ?: null;
}

function handlePost($conn) {
    $data = getJSONInput();

    $required = ['type_name'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $type_name = sanitizeInput($data['type_name']);
    $description = sanitizeInput($data['description'] ?? '');
    $default_amount = isset($data['default_amount']) ? floatval($data['default_amount']) : 0.00;
    $is_percentage = !empty($data['is_percentage']) ? 1 : 0;
    $is_active = array_key_exists('is_active', $data) ? (!empty($data['is_active']) ? 1 : 0) : 1;
    $base_floor = isset($data['base_floor']) ? floatval($data['base_floor']) : 0.00;
    $base_cap = isset($data['base_cap']) ? floatval($data['base_cap']) : 0.00;
    if ($base_floor < 0) $base_floor = 0.00;
    if ($base_cap < 0) $base_cap = 0.00;
    if ($base_cap > 0 && $base_floor > $base_cap) {
        sendError('Base floor cannot exceed base cap', 400);
    }
    $threshold_rules = normalizeThresholdRules($data['threshold_rules'] ?? []);
    if (empty($threshold_rules)) {
        $threshold_amount = isset($data['threshold_amount']) ? floatval($data['threshold_amount']) : 0.00;
        $threshold_mode = normalizeThresholdMode($data['threshold_mode'] ?? 'none');
        if ($threshold_amount > 0 && $threshold_mode !== 'none') {
            $threshold_rules = [[
                'mode' => $threshold_mode,
                'amount' => round($threshold_amount, 2),
            ]];
        }
    } else {
        $threshold_amount = $threshold_rules[0]['amount'];
        $threshold_mode = $threshold_rules[0]['mode'];
    }
    $threshold_rules_json = !empty($threshold_rules) ? json_encode($threshold_rules) : null;

    $sql = "INSERT INTO deduction_type (type_name, description, default_amount, is_percentage, is_active, threshold_amount, threshold_mode, threshold_rules, base_floor, base_cap)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare insert', 500);
    $stmt->bind_param('ssdiidssdd', $type_name, $description, $default_amount, $is_percentage, $is_active, $threshold_amount, $threshold_mode, $threshold_rules_json, $base_floor, $base_cap);

    if ($stmt->execute()) {
        sendResponse(true, fetchDeductionTypeById($conn, (int)$conn->insert_id), 'Deduction type created successfully', 201);
    }

    if ($conn->errno === 1062) sendError('Deduction type name already exists', 409);
    error_log($conn->error);
    sendError('Failed to create deduction type.', 500);
}

function handlePut($conn) {
    $data = getJSONInput();
    if (!isset($data['deduction_type_id'])) sendError('Deduction type ID is required', 400);

    $id = intval($data['deduction_type_id']);
    if ($id <= 0) sendError('Invalid deduction type ID', 400);

    $check = $conn->prepare("SELECT deduction_type_id, base_floor, base_cap FROM deduction_type WHERE deduction_type_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    $checkResult = $check->get_result();
    if ($checkResult->num_rows === 0) sendError('Deduction type not found', 404);
    $existing = $checkResult->fetch_assoc();
    $existingBaseFloor = floatval($existing['base_floor'] ?? 0);
    $existingBaseCap = floatval($existing['base_cap'] ?? 0);

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('type_name', $data)) {
        $updates[] = "type_name = ?";
        $params[] = sanitizeInput($data['type_name']);
        $types .= 's';
    }
    if (array_key_exists('description', $data)) {
        $updates[] = "description = ?";
        $params[] = sanitizeInput($data['description']);
        $types .= 's';
    }
    if (array_key_exists('default_amount', $data)) {
        $updates[] = "default_amount = ?";
        $params[] = floatval($data['default_amount']);
        $types .= 'd';
    }
    $baseFloorProvided = array_key_exists('base_floor', $data);
    $baseCapProvided = array_key_exists('base_cap', $data);
    if ($baseFloorProvided || $baseCapProvided) {
        $base_floor = $baseFloorProvided ? floatval($data['base_floor']) : $existingBaseFloor;
        $base_cap = $baseCapProvided ? floatval($data['base_cap']) : $existingBaseCap;
        if ($base_floor < 0) $base_floor = 0.00;
        if ($base_cap < 0) $base_cap = 0.00;
        if ($base_cap > 0 && $base_floor > $base_cap) {
            sendError('Base floor cannot exceed base cap', 400);
        }
        if ($baseFloorProvided) {
            $updates[] = "base_floor = ?";
            $params[] = $base_floor;
            $types .= 'd';
        }
        if ($baseCapProvided) {
            $updates[] = "base_cap = ?";
            $params[] = $base_cap;
            $types .= 'd';
        }
    }
    $thresholdRulesProvided = array_key_exists('threshold_rules', $data);
    $thresholdAmountProvided = array_key_exists('threshold_amount', $data);
    $thresholdModeProvided = array_key_exists('threshold_mode', $data);

    if ($thresholdRulesProvided) {
        $threshold_rules = normalizeThresholdRules($data['threshold_rules']);
        $primary = $threshold_rules[0] ?? null;
        $threshold_amount = $primary ? $primary['amount'] : 0.00;
        $threshold_mode = $primary ? $primary['mode'] : 'none';
        $threshold_rules_json = !empty($threshold_rules) ? json_encode($threshold_rules) : null;

        $updates[] = "threshold_amount = ?";
        $params[] = $threshold_amount;
        $types .= 'd';

        $updates[] = "threshold_mode = ?";
        $params[] = $threshold_mode;
        $types .= 's';

        $updates[] = "threshold_rules = ?";
        $params[] = $threshold_rules_json;
        $types .= 's';
    } elseif ($thresholdAmountProvided || $thresholdModeProvided) {
        $threshold_amount = $thresholdAmountProvided ? floatval($data['threshold_amount']) : 0.00;
        $threshold_mode = $thresholdModeProvided ? normalizeThresholdMode($data['threshold_mode']) : 'none';

        if ($thresholdAmountProvided) {
            $updates[] = "threshold_amount = ?";
            $params[] = $threshold_amount;
            $types .= 'd';
        }
        if ($thresholdModeProvided) {
            $updates[] = "threshold_mode = ?";
            $params[] = $threshold_mode;
            $types .= 's';
        }

        $legacyRules = [];
        if ($threshold_amount > 0 && $threshold_mode !== 'none') {
            $legacyRules[] = [
                'mode' => $threshold_mode,
                'amount' => round($threshold_amount, 2),
            ];
        }
        $updates[] = "threshold_rules = ?";
        $params[] = !empty($legacyRules) ? json_encode($legacyRules) : null;
        $types .= 's';
    }
    if (array_key_exists('is_percentage', $data)) {
        $updates[] = "is_percentage = ?";
        $params[] = !empty($data['is_percentage']) ? 1 : 0;
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
    $sql = "UPDATE deduction_type SET " . implode(', ', $updates) . " WHERE deduction_type_id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare update', 500);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        sendResponse(true, fetchDeductionTypeById($conn, $id), 'Deduction type updated successfully');
    }

    if ($conn->errno === 1062) sendError('Deduction type name already exists', 409);
    error_log($conn->error);
    sendError('Failed to update deduction type.', 500);
}

function handleDelete($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if ($id <= 0) sendError('Deduction type ID is required', 400);

    $permanent = isset($_GET['permanent']) && intval($_GET['permanent']) === 1;

    $check = $conn->prepare("SELECT deduction_type_id FROM deduction_type WHERE deduction_type_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    if ($check->get_result()->num_rows === 0) sendError('Deduction type not found', 404);

    if ($permanent) {
        $stmt = $conn->prepare("DELETE FROM deduction_type WHERE deduction_type_id = ?");
        if (!$stmt) sendError('Failed to prepare delete', 500);
        $stmt->bind_param('i', $id);
        if ($stmt->execute()) sendResponse(true, null, 'Deduction type deleted permanently');
        error_log($conn->error);
        sendError('Failed to delete deduction type.', 500);
    }

    $stmt = $conn->prepare("UPDATE deduction_type SET is_active = 0 WHERE deduction_type_id = ?");
    if (!$stmt) sendError('Failed to prepare archive update', 500);
    $stmt->bind_param('i', $id);
    if ($stmt->execute()) sendResponse(true, fetchDeductionTypeById($conn, $id), 'Deduction type archived successfully');
    error_log($conn->error);
    sendError('Failed to archive deduction type.', 500);
}

closeDBConnection($conn);
?>
