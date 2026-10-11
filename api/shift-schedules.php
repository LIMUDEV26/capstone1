<?php
/**
 * Shift Schedules API
 * Handles CRUD operations for shift_schedule.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

switch ($method) {
    case 'GET':
        requireFeatureAccess('shift_schedules', ['admin', 'manager'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('shift_schedules', ['admin', 'manager'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('shift_schedules', ['admin', 'manager'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('shift_schedules', ['admin', 'manager'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function resolveCurrentShiftEmployeeId($conn) {
    $sessionEmployeeId = intval($_SESSION['employee_id'] ?? 0);
    if ($sessionEmployeeId > 0) return $sessionEmployeeId;

    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) return 0;

    $stmt = $conn->prepare("SELECT employee_id FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) return 0;
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $employeeId = intval($row['employee_id'] ?? 0);
    if ($employeeId > 0) {
        $_SESSION['employee_id'] = $employeeId;
    }

    return $employeeId;
}

function handleGet($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $staffEmployeeId = ($role === 'staff') ? resolveCurrentShiftEmployeeId($conn) : 0;

    if ($role === 'staff' && $staffEmployeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }

    $sql = "SELECT s.*,
                   CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                   e.position,
                   b.branch_name
            FROM shift_schedule s
            LEFT JOIN employees e ON s.employee_id = e.employee_id
            LEFT JOIN branches b ON e.branch_id = b.branch_id
            WHERE 1=1";

    $params = [];
    $types = '';

    if ($id > 0) {
        $sql .= " AND s.shift_schedule_id = ?";
        $params[] = $id;
        $types .= 'i';
    }

    if (!empty($_GET['employee_id'])) {
        $sql .= " AND s.employee_id = ?";
        $params[] = intval($_GET['employee_id']);
        $types .= 'i';
    }

    if ($role === 'staff') {
        $sql .= " AND s.employee_id = ?";
        $params[] = $staffEmployeeId;
        $types .= 'i';
    }

    if (!empty($_GET['status'])) {
        $sql .= " AND s.status = ?";
        $params[] = sanitizeInput($_GET['status']);
        $types .= 's';
    }

    if (!empty($_GET['shift_type'])) {
        $sql .= " AND s.shift_type = ?";
        $params[] = sanitizeInput($_GET['shift_type']);
        $types .= 's';
    }

    if (!empty($_GET['date_from'])) {
        $sql .= " AND s.shift_date >= ?";
        $params[] = sanitizeInput($_GET['date_from']);
        $types .= 's';
    }

    if (!empty($_GET['date_to'])) {
        $sql .= " AND s.shift_date <= ?";
        $params[] = sanitizeInput($_GET['date_to']);
        $types .= 's';
    }

    $sql .= " ORDER BY s.shift_date DESC, s.shift_start ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare shift query', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    if (!$result) sendError('Failed to retrieve shift schedules', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }

    if ($id > 0) {
        if (!empty($rows)) sendResponse(true, $rows[0], 'Shift schedule retrieved successfully');
        sendError('Shift schedule not found', 404);
    }

    sendResponse(true, $rows, 'Shift schedules retrieved successfully');
}

function handlePost($conn) {
    $data = getJSONInput();

    $missing = validateRequiredFields($data, ['employee_id', 'shift_date', 'shift_start', 'shift_end']);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $employee_id = intval($data['employee_id']);
    $shift_date = sanitizeInput($data['shift_date']);
    $shift_start = sanitizeInput($data['shift_start']);
    $shift_end = sanitizeInput($data['shift_end']);
    $shift_type = sanitizeInput($data['shift_type'] ?? 'morning');
    $status = sanitizeInput($data['status'] ?? 'scheduled');
    $notes = sanitizeInput($data['notes'] ?? '');

    if (!validateDate($shift_date)) sendError('Invalid shift date format (expected Y-m-d)', 400);
    if (!preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $shift_start)) sendError('Invalid shift start time format', 400);
    if (!preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $shift_end)) sendError('Invalid shift end time format', 400);

    $valid_shift_types = ['morning', 'afternoon', 'night', 'flexible'];
    if (!in_array($shift_type, $valid_shift_types, true)) sendError('Invalid shift type', 400);

    $valid_status = ['scheduled', 'completed', 'cancelled', 'no_show'];
    if (!in_array($status, $valid_status, true)) sendError('Invalid status', 400);

    $emp_check = $conn->prepare("SELECT employee_id FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$emp_check) sendError('Failed to validate employee', 500);
    $emp_check->bind_param('i', $employee_id);
    $emp_check->execute();
    if ($emp_check->get_result()->num_rows === 0) sendError('Employee not found', 404);

    $sql = "INSERT INTO shift_schedule (employee_id, shift_date, shift_start, shift_end, shift_type, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare insert', 500);
    $stmt->bind_param('issssss', $employee_id, $shift_date, $shift_start, $shift_end, $shift_type, $status, $notes);

    if ($stmt->execute()) {
        sendResponse(true, ['shift_schedule_id' => $conn->insert_id], 'Shift schedule created successfully', 201);
    }

    error_log($conn->error);
    sendError('Failed to create shift schedule.', 500);
}

function handlePut($conn) {
    $data = getJSONInput();
    if (!isset($data['shift_schedule_id'])) sendError('Shift schedule ID is required', 400);

    $shift_schedule_id = intval($data['shift_schedule_id']);
    if ($shift_schedule_id <= 0) sendError('Invalid shift schedule ID', 400);
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $isStaff = $role === 'staff';
    $staffEmployeeId = $isStaff ? resolveCurrentShiftEmployeeId($conn) : 0;

    if ($isStaff && $staffEmployeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }

    $check = $conn->prepare("SELECT shift_schedule_id, employee_id, status FROM shift_schedule WHERE shift_schedule_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $shift_schedule_id);
    $check->execute();
    $current = $check->get_result()->fetch_assoc();
    if (!$current) sendError('Shift schedule not found', 404);

    if ($isStaff && intval($current['employee_id']) !== $staffEmployeeId) {
        sendError('Forbidden', 403);
    }

    $updates = [];
    $params = [];
    $types = '';

    if ($isStaff) {
        $staffAllowedFields = ['status', 'notes', 'shift_schedule_id'];
        foreach ($data as $key => $value) {
            if (!in_array($key, $staffAllowedFields, true)) {
                sendError('Staff can only update schedule status/notes.', 403);
            }
        }

        if (!array_key_exists('status', $data)) {
            sendError('Status is required', 400);
        }

        $staffStatus = sanitizeInput($data['status']);
        if (!in_array($staffStatus, ['completed', 'no_show'], true)) {
            sendError('Staff can only set status to completed or no_show.', 400);
        }
    }

    if (array_key_exists('employee_id', $data)) {
        if ($isStaff) sendError('Staff cannot reassign shifts', 403);
        $employee_id = intval($data['employee_id']);
        $emp_check = $conn->prepare("SELECT employee_id FROM employees WHERE employee_id = ? LIMIT 1");
        if (!$emp_check) sendError('Failed to validate employee', 500);
        $emp_check->bind_param('i', $employee_id);
        $emp_check->execute();
        if ($emp_check->get_result()->num_rows === 0) sendError('Employee not found', 404);

        $updates[] = "employee_id = ?";
        $params[] = $employee_id;
        $types .= 'i';
    }

    if (array_key_exists('shift_date', $data)) {
        if ($isStaff) sendError('Staff cannot update shift date', 403);
        $shift_date = sanitizeInput($data['shift_date']);
        if (!validateDate($shift_date)) sendError('Invalid shift date format (expected Y-m-d)', 400);
        $updates[] = "shift_date = ?";
        $params[] = $shift_date;
        $types .= 's';
    }

    if (array_key_exists('shift_start', $data)) {
        if ($isStaff) sendError('Staff cannot update shift time', 403);
        $shift_start = sanitizeInput($data['shift_start']);
        if (!preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $shift_start)) sendError('Invalid shift start time format', 400);
        $updates[] = "shift_start = ?";
        $params[] = $shift_start;
        $types .= 's';
    }

    if (array_key_exists('shift_end', $data)) {
        if ($isStaff) sendError('Staff cannot update shift time', 403);
        $shift_end = sanitizeInput($data['shift_end']);
        if (!preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $shift_end)) sendError('Invalid shift end time format', 400);
        $updates[] = "shift_end = ?";
        $params[] = $shift_end;
        $types .= 's';
    }

    if (array_key_exists('shift_type', $data)) {
        if ($isStaff) sendError('Staff cannot update shift type', 403);
        $shift_type = sanitizeInput($data['shift_type']);
        $valid_shift_types = ['morning', 'afternoon', 'night', 'flexible'];
        if (!in_array($shift_type, $valid_shift_types, true)) sendError('Invalid shift type', 400);
        $updates[] = "shift_type = ?";
        $params[] = $shift_type;
        $types .= 's';
    }

    if (array_key_exists('status', $data)) {
        $status = sanitizeInput($data['status']);
        $valid_status = ['scheduled', 'completed', 'cancelled', 'no_show'];
        if (!in_array($status, $valid_status, true)) sendError('Invalid status', 400);
        $updates[] = "status = ?";
        $params[] = $status;
        $types .= 's';
    }

    if (array_key_exists('notes', $data)) {
        $updates[] = "notes = ?";
        $params[] = sanitizeInput($data['notes']);
        $types .= 's';
    }

    if (empty($updates)) sendError('No fields to update', 400);

    $params[] = $shift_schedule_id;
    $types .= 'i';
    $sql = "UPDATE shift_schedule SET " . implode(', ', $updates) . " WHERE shift_schedule_id = ?";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare update', 500);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        sendResponse(true, null, 'Shift schedule updated successfully');
    }

    error_log($conn->error);
    sendError('Failed to update shift schedule.', 500);
}

function handleDelete($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if ($id <= 0) sendError('Shift schedule ID is required', 400);

    $check = $conn->prepare("SELECT shift_schedule_id FROM shift_schedule WHERE shift_schedule_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    if ($check->get_result()->num_rows === 0) sendError('Shift schedule not found', 404);

    $permanent = isset($_GET['permanent']) && intval($_GET['permanent']) === 1;

    if ($permanent) {
        $stmt = $conn->prepare("DELETE FROM shift_schedule WHERE shift_schedule_id = ?");
        if (!$stmt) sendError('Failed to prepare delete', 500);
        $stmt->bind_param('i', $id);
        if ($stmt->execute()) sendResponse(true, null, 'Shift schedule deleted permanently');
        error_log($conn->error);
        sendError('Failed to delete shift schedule.', 500);
    }

    $stmt = $conn->prepare("UPDATE shift_schedule SET status = 'cancelled' WHERE shift_schedule_id = ?");
    if (!$stmt) sendError('Failed to prepare archive update', 500);
    $stmt->bind_param('i', $id);
    if ($stmt->execute()) sendResponse(true, null, 'Shift schedule cancelled successfully');
    error_log($conn->error);
    sendError('Failed to cancel shift schedule.', 500);
}

closeDBConnection($conn);
?>
