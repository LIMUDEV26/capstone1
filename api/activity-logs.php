<?php
/**
 * Activity Logs API
 * GET list activity logs with optional filters:
 *   ?search=
 *   ?date_from=YYYY-MM-DD
 *   ?date_to=YYYY-MM-DD
 *   ?user_id=int
 *   ?activity_type=string
 *   ?limit=int
 *   ?offset=int
 *   ?meta=1
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$httpMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($httpMethod !== 'GET' && $httpMethod !== 'DELETE') {
    sendError('Method not allowed', 405);
}

// Permanent deletion (Data Deletion Control) — admin only.
if ($httpMethod === 'DELETE') {
    requireRole(['admin']);
    $conn = getDBConnection();

    $clearAll = isset($_GET['action']) && $_GET['action'] === 'clear_all';
    $deleted = 0;
    $singleId = 0;

    if ($clearAll) {
        $conn->query("DELETE FROM activity_log");
        $deleted = (int)$conn->affected_rows;
    } else {
        $singleId = intval($_GET['id'] ?? 0);
        if ($singleId <= 0) sendError('Log ID is required', 400);
        $stmt = $conn->prepare("DELETE FROM activity_log WHERE id = ?");
        if (!$stmt) sendError('Failed to prepare delete query', 500);
        $stmt->bind_param('i', $singleId);
        if (!$stmt->execute()) sendError('Failed to delete activity log.', 500);
        if ($stmt->affected_rows === 0) {
            $stmt->close();
            sendError('Activity log not found', 404);
        }
        $deleted = 1;
        $stmt->close();
    }

    // Audit the purge itself (logged after deletion so the trail survives).
    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        logActivity(
            $conn,
            $user_id,
            'delete_activity_log',
            $clearAll
                ? "Permanently cleared {$deleted} activity log(s)"
                : "Permanently deleted activity log ID: {$singleId}",
            'activity_log_management'
        );
    }

    closeDBConnection($conn);
    sendResponse(
        true,
        ['deleted' => $deleted],
        $clearAll
            ? "Cleared {$deleted} activity log(s) permanently."
            : 'Activity log deleted permanently.'
    );
}

$role = requireRole(['admin', 'manager']);

$conn = getDBConnection();

$branchId = null;
if ($role === 'manager') {
    $branchId = $_SESSION['branch_id'] ?? null;
    if (!is_numeric($branchId) || (int)$branchId <= 0) {
        $userId = intval($_SESSION['user_id'] ?? 0);
        if ($userId > 0) {
            $branchStmt = $conn->prepare("SELECT branch_id FROM users WHERE id = ? LIMIT 1");
            if ($branchStmt) {
                $branchStmt->bind_param('i', $userId);
                $branchStmt->execute();
                $branchRow = $branchStmt->get_result()->fetch_assoc();
                $branchStmt->close();
                if (!empty($branchRow['branch_id'])) {
                    $branchId = (int)$branchRow['branch_id'];
                    $_SESSION['branch_id'] = $branchId;
                }
            }
        }
    }
    if (!is_numeric($branchId) || (int)$branchId <= 0) {
        sendError('Manager is not assigned to a branch.', 403);
    }
    $branchId = (int)$branchId;
}

// META endpoint for filter dropdowns
if (isset($_GET['meta'])) {
    $types = [];
    $actions = [];
    $users = [];

    if ($role === 'manager') {
        $typesStmt = $conn->prepare(
            "SELECT DISTINCT al.activity_type
             FROM activity_log al
             JOIN users u ON al.user_id = u.id
             WHERE al.activity_type IS NOT NULL
               AND al.activity_type != ''
               AND u.branch_id = ?
             ORDER BY al.activity_type"
        );
        if ($typesStmt) {
            $typesStmt->bind_param('i', $branchId);
            $typesStmt->execute();
            $typesRes = $typesStmt->get_result();
            while ($row = $typesRes->fetch_assoc()) {
                $types[] = $row['activity_type'];
            }
            $typesStmt->close();
        }

        $actionsStmt = $conn->prepare(
            "SELECT DISTINCT al.action
             FROM activity_log al
             JOIN users u ON al.user_id = u.id
             WHERE al.action IS NOT NULL
               AND al.action != ''
               AND u.branch_id = ?
             ORDER BY al.action"
        );
        if ($actionsStmt) {
            $actionsStmt->bind_param('i', $branchId);
            $actionsStmt->execute();
            $actionsRes = $actionsStmt->get_result();
            while ($row = $actionsRes->fetch_assoc()) {
                $actions[] = $row['action'];
            }
            $actionsStmt->close();
        }

        $usersStmt = $conn->prepare(
            "SELECT DISTINCT u.id, u.first_name, u.last_name, u.username, u.role
             FROM activity_log al
             JOIN users u ON al.user_id = u.id
             WHERE u.branch_id = ?
             ORDER BY u.first_name, u.last_name"
        );
        if ($usersStmt) {
            $usersStmt->bind_param('i', $branchId);
            $usersStmt->execute();
            $usersRes = $usersStmt->get_result();
            while ($row = $usersRes->fetch_assoc()) {
                $users[] = $row;
            }
            $usersStmt->close();
        }
    } else {
        $r = $conn->query("SELECT DISTINCT activity_type FROM activity_log WHERE activity_type IS NOT NULL AND activity_type != '' ORDER BY activity_type");
        if ($r) {
            while ($row = $r->fetch_assoc()) {
                $types[] = $row['activity_type'];
            }
        }

        $rActions = $conn->query("SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL AND action != '' ORDER BY action");
        if ($rActions) {
            while ($row = $rActions->fetch_assoc()) {
                $actions[] = $row['action'];
            }
        }

        $r2 = $conn->query("SELECT DISTINCT u.id, u.first_name, u.last_name, u.username, u.role
                            FROM activity_log al
                            JOIN users u ON al.user_id = u.id
                            ORDER BY u.first_name, u.last_name");
        if ($r2) {
            while ($row = $r2->fetch_assoc()) {
                $users[] = $row;
            }
        }
    }

    echo json_encode([
        'success' => true,
        'types' => $types,
        'actions' => $actions,
        'users' => $users
    ], JSON_UNESCAPED_UNICODE);
    closeDBConnection($conn);
    exit();
}

$where = [];
$params = [];
$param_types = '';

if (!empty($_GET['search'])) {
    $search = '%' . $_GET['search'] . '%';
    $where[] = '(al.action LIKE ? OR al.description LIKE ?)';
    $params[] = $search;
    $params[] = $search;
    $param_types .= 'ss';
}

if (!empty($_GET['date_from'])) {
    $where[] = 'al.created_at >= ?';
    $params[] = $_GET['date_from'] . ' 00:00:00';
    $param_types .= 's';
}

if (!empty($_GET['date_to'])) {
    $where[] = 'al.created_at <= ?';
    $params[] = $_GET['date_to'] . ' 23:59:59';
    $param_types .= 's';
}

if (!empty($_GET['user_id'])) {
    $where[] = 'al.user_id = ?';
    $params[] = (int)$_GET['user_id'];
    $param_types .= 'i';
}

if (!empty($_GET['activity_type'])) {
    $where[] = 'al.activity_type = ?';
    $params[] = $_GET['activity_type'];
    $param_types .= 's';
}

if (!empty($_GET['action'])) {
    $where[] = 'al.action = ?';
    $params[] = $_GET['action'];
    $param_types .= 's';
}

if (!empty($_GET['ip_address'])) {
    $where[] = 'al.ip_address LIKE ?';
    $params[] = '%' . $_GET['ip_address'] . '%';
    $param_types .= 's';
}

$joinSql = "LEFT JOIN users u ON al.user_id = u.id";
if ($role === 'manager') {
    $where[] = 'u.branch_id = ?';
    $params[] = $branchId;
    $param_types .= 'i';
}

$limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 50;
$offset = isset($_GET['offset']) ? max(0, (int)$_GET['offset']) : 0;

$where_clause = !empty($where) ? ('WHERE ' . implode(' AND ', $where)) : '';

// Total rows
$total = 0;
$count_sql = "SELECT COUNT(*) AS total FROM activity_log al $joinSql $where_clause";

if (!empty($params)) {
    $count_stmt = $conn->prepare($count_sql);
    if (!$count_stmt) sendError('Failed to prepare count query', 500);
    $count_stmt->bind_param($param_types, ...$params);
    if (!$count_stmt->execute()) sendError('Failed to execute count query', 500);
    $count_res = $count_stmt->get_result();
    $count_row = $count_res ? $count_res->fetch_assoc() : null;
    $total = (int)($count_row['total'] ?? 0);
    $count_stmt->close();
} else {
    $count_res = $conn->query($count_sql);
    if ($count_res) {
        $count_row = $count_res->fetch_assoc();
        $total = (int)($count_row['total'] ?? 0);
    }
}

// Data rows
$sql = "SELECT al.id, al.user_id, al.action, al.description, al.activity_type,
               al.ip_address, al.created_at,
               u.first_name, u.last_name, u.username, u.role
        FROM activity_log al
        $joinSql
        $where_clause
        ORDER BY al.created_at DESC
        LIMIT ? OFFSET ?";

$row_params = array_merge($params, [$limit, $offset]);
$row_types = $param_types . 'ii';

$stmt = $conn->prepare($sql);
if (!$stmt) sendError('Failed to prepare logs query', 500);
$stmt->bind_param($row_types, ...$row_params);
if (!$stmt->execute()) sendError('Failed to execute logs query', 500);

$result = $stmt->get_result();
$logs = [];
while ($row = $result->fetch_assoc()) {
    if (function_exists('cleanAutoActivityDescription')) {
        $row['description'] = cleanAutoActivityDescription($row['description'] ?? '');
    }
    $logs[] = $row;
}

$stmt->close();
closeDBConnection($conn);

echo json_encode([
    'success' => true,
    'data' => $logs,
    'total' => $total,
    'limit' => $limit,
    'offset' => $offset
], JSON_UNESCAPED_UNICODE);
