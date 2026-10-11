<?php
/**
 * Archived role records used by the Data Storage settings page.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();
$method = getRequestMethod();
$role = requireRole(['admin']);
$conn = getDBConnection();
ensureRoleFeatureAccessStorage($conn);

if ($method === 'GET') {
    $status = strtolower(trim((string)($_GET['status'] ?? 'active')));
    if (!in_array($status, ['active', 'archived'], true)) {
        sendError('Invalid role status.', 400);
    }

    $stmt = $conn->prepare(
        "SELECT r.role_id, r.role_name, r.description,
                (SELECT COUNT(*) FROM users u WHERE LOWER(TRIM(u.role)) = LOWER(TRIM(r.role_name))) AS employee_count
         FROM roles r
         WHERE r.status = ?
         ORDER BY r.role_name"
    );
    if (!$stmt) sendError('Failed to prepare roles query.', 500);
    $stmt->bind_param('s', $status);
    if (!$stmt->execute()) sendError('Failed to load roles.', 500);
    $result = $stmt->get_result();
    $roles = [];
    while ($row = $result->fetch_assoc()) $roles[] = $row;
    $stmt->close();
    closeDBConnection($conn);
    sendResponse(true, $roles, 'Roles loaded.');
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0 || (string)($_GET['permanent'] ?? '') !== '1') {
        sendError('An archived role ID is required.', 400);
    }

    $stmt = $conn->prepare("SELECT role_name, status FROM roles WHERE role_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to prepare role lookup.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $record = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$record || strtolower((string)$record['status']) !== 'archived') {
        sendError('Archived role not found.', 404);
    }

    $roleName = trim((string)$record['role_name']);
    if (in_array(strtolower($roleName), ['admin', 'manager', 'staff'], true)) {
        sendError('Built-in roles cannot be permanently deleted.', 403);
    }

    $users = $conn->prepare("SELECT COUNT(*) AS total FROM users WHERE LOWER(TRIM(role)) = LOWER(TRIM(?))");
    if (!$users) sendError('Failed to check role assignments.', 500);
    $users->bind_param('s', $roleName);
    $users->execute();
    $assignedCount = (int)($users->get_result()->fetch_assoc()['total'] ?? 0);
    $users->close();
    if ($assignedCount > 0) sendError('This role is still assigned to users and cannot be deleted.', 409);

    $delete = $conn->prepare("DELETE FROM roles WHERE role_id = ? AND status = 'archived'");
    if (!$delete) sendError('Failed to prepare role deletion.', 500);
    $delete->bind_param('i', $id);
    if (!$delete->execute()) sendError('Failed to delete archived role.', 500);
    $delete->close();

    $userId = (int)($_SESSION['user_id'] ?? 0);
    releaseSessionLock();
    logActivity($conn, $userId, 'delete_archived_role', "Permanently deleted archived role: {$roleName}", 'settings');
    closeDBConnection($conn);
    sendResponse(true, ['deleted' => 1], 'Archived role deleted.');
}

closeDBConnection($conn);
sendError('Method not allowed.', 405);
