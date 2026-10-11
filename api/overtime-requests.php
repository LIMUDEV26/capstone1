<?php
/**
 * Overtime Requests API (Phase 1 MVP)
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('overtime_requests', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('overtime_requests', ['admin', 'manager', 'staff'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('overtime_requests', ['admin', 'manager', 'staff'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('overtime_requests', ['admin', 'manager', 'staff'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getSessionRoleForOvertime() {
    return strtolower(trim((string)($_SESSION['role'] ?? '')));
}

function getSessionEmployeeForOvertime($conn) {
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

function requireSessionEmployeeForOvertime($conn) {
    $employeeId = getSessionEmployeeForOvertime($conn);
    if ($employeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }
    return $employeeId;
}

function getOvertimeRow($conn, $id) {
    $stmt = $conn->prepare("SELECT * FROM overtime_request WHERE overtime_request_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to load overtime request', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Find an active (submitted/approved, non-archived) overtime request for the
 * same employee on the same work date. Applies to ALL roles.
 * Returns the conflicting row or null.
 */
function findDuplicateOvertimeRequest($conn, $employeeId, $workDate, $excludeId = 0, $forUpdate = false) {
    $employeeId = intval($employeeId);
    $excludeId = intval($excludeId);
    if ($employeeId <= 0 || $workDate === '') return null;

    $sql = "SELECT overtime_request_id, work_date, status
            FROM overtime_request
            WHERE employee_id = ?
              AND work_date = ?
              AND status IN ('submitted', 'approved')
              AND COALESCE(is_archived, 0) = 0";
    $params = [$employeeId, $workDate];
    $types = 'is';
    if ($excludeId > 0) {
        $sql .= " AND overtime_request_id <> ?";
        $params[] = $excludeId;
        $types .= 'i';
    }
    $sql .= " LIMIT 1";
    if ($forUpdate) {
        $sql .= " FOR UPDATE";
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to validate duplicate overtime request', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Find an active (pending/approved) leave request covering the given work date
 * for the same employee (cross-type guard). Returns the conflicting row or null.
 */
function findLeaveCoveringOvertimeDate($conn, $employeeId, $workDate, $forUpdate = false) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0 || $workDate === '') return null;
    $check = $conn->query("SHOW TABLES LIKE 'leave_request'");
    if (!$check || $check->num_rows === 0) return null;

    $stmt = $conn->prepare(
        "SELECT leave_request_id, leave_type, start_date, end_date, status
         FROM leave_request
         WHERE employee_id = ?
           AND status IN ('pending', 'approved')
           AND start_date <= ?
           AND end_date >= ?
         ORDER BY start_date ASC
         LIMIT 1" . ($forUpdate ? " FOR UPDATE" : "")
    );
    if (!$stmt) return null;
    $stmt->bind_param('iss', $employeeId, $workDate, $workDate);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

function canViewOvertimeRequest($role, $selfEmployeeId, $record) {
    if (!$record) return false;
    if ($role === 'admin' || $role === 'manager') return true;
    if ($role === 'staff') return intval($record['employee_id'] ?? 0) === intval($selfEmployeeId);
    return false;
}

function handleGet($conn) {
    $role = getSessionRoleForOvertime();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $selfEmployeeId = $role === 'staff' ? requireSessionEmployeeForOvertime($conn) : getSessionEmployeeForOvertime($conn);
    $id = intval($_GET['id'] ?? 0);

    $sql = "SELECT ot.*,
                   CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                   creator.username AS created_by_username,
                   approver.username AS approved_by_username
            FROM overtime_request ot
            INNER JOIN employees e ON e.employee_id = ot.employee_id
            LEFT JOIN users creator ON creator.id = ot.created_by
            LEFT JOIN users approver ON approver.id = ot.approved_by
            WHERE 1=1";
    $params = [];
    $types = '';
    $archivedFilterProvided = array_key_exists('archived', $_GET);
    $archivedOnly = $archivedFilterProvided ? intval($_GET['archived']) === 1 : false;

    if ($id > 0) {
        $sql .= " AND ot.overtime_request_id = ?";
        $params[] = $id;
        $types .= 'i';
    }

    if ($role === 'staff') {
        $sql .= " AND ot.employee_id = ?";
        $params[] = $selfEmployeeId;
        $types .= 'i';
    } elseif (!empty($_GET['employee_id'])) {
        $sql .= " AND ot.employee_id = ?";
        $params[] = intval($_GET['employee_id']);
        $types .= 'i';
    }

    if (!empty($_GET['status'])) {
        $sql .= " AND ot.status = ?";
        $params[] = strtolower(trim((string)$_GET['status']));
        $types .= 's';
    }

    if (!empty($_GET['date_from'])) {
        $sql .= " AND ot.work_date >= ?";
        $params[] = sanitizeInput($_GET['date_from']);
        $types .= 's';
    }

    if (!empty($_GET['date_to'])) {
        $sql .= " AND ot.work_date <= ?";
        $params[] = sanitizeInput($_GET['date_to']);
        $types .= 's';
    }

    if ($id <= 0 || $archivedFilterProvided) {
        $sql .= $archivedOnly
            ? " AND COALESCE(ot.is_archived, 0) = 1"
            : " AND COALESCE(ot.is_archived, 0) = 0";
    }

    $sql .= " ORDER BY
                CASE WHEN ot.status = 'submitted' THEN 0 ELSE 1 END ASC,
                ot.created_at DESC,
                ot.overtime_request_id DESC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare overtime query', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }
    if (!$result) sendError('Failed to retrieve overtime requests', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }

    if ($id > 0) {
        if (empty($rows)) sendError('Overtime request not found', 404);
        sendResponse(true, $rows[0], 'Overtime request retrieved successfully');
    }

    sendResponse(true, $rows, 'Overtime requests retrieved successfully');
}

/**
 * Storage-level duplicate backstop: a virtual generated column that is only
 * populated for ACTIVE overtime rows (submitted/approved, non-archived), with
 * a UNIQUE key on it. MySQL ignores NULLs in unique indexes, so inactive rows
 * never conflict — but two active rows for the same employee + work date are
 * impossible even under a race the app-level check cannot see.
 */
function ensureOvertimeActiveSlotUnique($conn) {
    $colCheck = $conn->query("SHOW COLUMNS FROM overtime_request LIKE 'is_archived'");
    if (!$colCheck || $colCheck->num_rows === 0) return;

    $slotCheck = $conn->query("SHOW COLUMNS FROM overtime_request LIKE 'active_slot'");
    if ($slotCheck && $slotCheck->num_rows > 0) return;

    $conn->query(
        "ALTER TABLE overtime_request
         ADD COLUMN active_slot VARCHAR(64)
         GENERATED ALWAYS AS (
             IF(status IN ('submitted', 'approved') AND COALESCE(is_archived, 0) = 0,
                CONCAT(employee_id, ':', work_date),
                NULL)
         ) VIRTUAL,
         ADD UNIQUE KEY uq_overtime_active_slot (active_slot)"
    );
    // Best effort: if the ALTER fails (e.g. pre-existing duplicates), the
    // app-level guards above still reject new duplicates.
}

function handlePost($conn) {
    $role = getSessionRoleForOvertime();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);

    $selfEmployeeId = $role === 'staff' ? requireSessionEmployeeForOvertime($conn) : getSessionEmployeeForOvertime($conn);
    $data = getJSONInput();

    $required = ['work_date', 'hours_requested', 'reason'];
    if ($role !== 'staff') {
        $required[] = 'employee_id';
    }
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $employeeId = $role === 'staff' ? $selfEmployeeId : intval($data['employee_id']);
    if ($employeeId <= 0) sendError('Invalid employee ID', 400);

    $workDate = sanitizeInput($data['work_date']);
    if (!validateDate($workDate)) sendError('Invalid work date format. Expected YYYY-MM-DD.', 400);

    $hoursRequested = floatval($data['hours_requested']);
    if ($hoursRequested <= 0 || $hoursRequested > 24) {
        sendError('Hours requested must be greater than 0 and at most 24.', 400);
    }

    $reason = trim((string)$data['reason']);
    if ($reason === '') sendError('Reason is required', 400);
    if (strlen($reason) > 3000) sendError('Reason is too long (max 3000 characters)', 400);

    $safeReason = sanitizeInput($reason);
    $status = 'submitted';

    ensureOvertimeActiveSlotUnique($conn);

    // ── Duplicate guard (all user types): same employee + same work date ──
    // Wrapped with the INSERT in one transaction and read FOR UPDATE: two
    // concurrent same-employee submits serialize, so the second one sees the
    // first one's row and gets the 409 instead of double-inserting.
    // (Any sendError exit rolls the transaction back on connection close.)
    $conn->begin_transaction();
    $duplicateOt = findDuplicateOvertimeRequest($conn, $employeeId, $workDate, 0, true);
    if ($duplicateOt) {
        $dupOtStatus = strtolower((string)($duplicateOt['status'] ?? 'submitted'));
        $dupOtDate = substr((string)($duplicateOt['work_date'] ?? $workDate), 0, 10);
        sendError(
            'Duplicate overtime request: this employee already has a ' . $dupOtStatus .
            ' overtime request on ' . $dupOtDate . '.',
            409,
            [
                'code' => 'duplicate_overtime',
                'field' => 'work_date',
                'fields' => ['work_date'],
                'conflicting_status' => $dupOtStatus,
                'conflicting_work_date' => $dupOtDate,
                'conflicting_request_id' => intval($duplicateOt['overtime_request_id'] ?? 0),
            ]
        );
    }
    // ── Cross-type guard: leave already covers this work date ──
    $leaveConflict = findLeaveCoveringOvertimeDate($conn, $employeeId, $workDate, true);
    if ($leaveConflict) {
        $leaveStatus = strtolower((string)($leaveConflict['status'] ?? 'pending'));
        $leaveStart = substr((string)($leaveConflict['start_date'] ?? ''), 0, 10);
        $leaveEnd = substr((string)($leaveConflict['end_date'] ?? ''), 0, 10);
        sendError(
            'Duplicate date: this employee already has a ' . $leaveStatus .
            ' leave request (' . $leaveStart . ' to ' . $leaveEnd . ') covering ' .
            substr($workDate, 0, 10) . '.',
            409,
            [
                'code' => 'duplicate_leave_date',
                'field' => 'work_date',
                'fields' => ['work_date'],
                'conflicting_status' => $leaveStatus,
                'conflicting_start_date' => $leaveStart,
                'conflicting_end_date' => $leaveEnd,
                'conflicting_request_id' => intval($leaveConflict['leave_request_id'] ?? 0),
            ]
        );
    }

    $stmt = $conn->prepare(
        "INSERT INTO overtime_request (employee_id, work_date, hours_requested, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    if (!$stmt) sendError('Failed to prepare overtime insert', 500);
    $stmt->bind_param('isdssi', $employeeId, $workDate, $hoursRequested, $safeReason, $status, $currentUserId);
    if (!$stmt->execute()) {
        $errno = intval($conn->errno);
        $stmt->close();
        $conn->rollback();
        // Storage backstop fired: another active request owns this slot
        // (race the SELECT above could not see). Report as a duplicate.
        if ($errno === 1062) {
            $conflict = findDuplicateOvertimeRequest($conn, $employeeId, $workDate);
            $conflictStatus = strtolower((string)($conflict['status'] ?? 'submitted'));
            sendError(
                'Duplicate overtime request: this employee already has a ' . $conflictStatus .
                ' overtime request on ' . substr($workDate, 0, 10) . '.',
                409,
                [
                    'code' => 'duplicate_overtime',
                    'field' => 'work_date',
                    'fields' => ['work_date'],
                    'conflicting_status' => $conflictStatus,
                    'conflicting_work_date' => substr($workDate, 0, 10),
                    'conflicting_request_id' => intval($conflict['overtime_request_id'] ?? 0),
                ]
            );
        }
        error_log($conn->error);
        sendError('Failed to submit overtime request.', 500);
    }
    $requestId = intval($conn->insert_id);
    $stmt->close();
    $conn->commit();

    $after = getOvertimeRow($conn, $requestId);
    logActivity($conn, $currentUserId, 'create_overtime_request', 'Submitted overtime request #' . $requestId, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'overtime_request', $requestId, 'create', null, $after, basename(__FILE__));
    upsertExceptionQueue(
        $conn,
        'overtime_request',
        (string)$requestId,
        'Overtime request awaiting approval',
        'Overtime request #' . $requestId . ' needs manager review.',
        $hoursRequested >= 6 ? 'high' : 'medium',
        'admin',
        [
            'overtime_request_id' => $requestId,
            'employee_id' => $employeeId,
            'hours_requested' => $hoursRequested,
            'status' => $status,
        ],
        $currentUserId
    );

    sendResponse(true, ['overtime_request_id' => $requestId], 'Overtime request submitted successfully', 201);
}

function handlePut($conn) {
    $role = getSessionRoleForOvertime();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);
    $selfEmployeeId = $role === 'staff' ? requireSessionEmployeeForOvertime($conn) : getSessionEmployeeForOvertime($conn);

    $data = getJSONInput();
    $id = intval($data['overtime_request_id'] ?? 0);
    if ($id <= 0) sendError('Overtime request ID is required', 400);

    $before = getOvertimeRow($conn, $id);
    if (!$before) sendError('Overtime request not found', 404);
    if (!canViewOvertimeRequest($role, $selfEmployeeId, $before)) sendError('Forbidden', 403);

    $updates = [];
    $params = [];
    $types = '';

    if ($role === 'staff') {
        $action = strtolower(trim((string)($data['action'] ?? '')));
        if ($action !== 'cancel') sendError('Staff can only cancel their own overtime request.', 403);
        if (intval($before['employee_id'] ?? 0) !== intval($selfEmployeeId)) sendError('Forbidden', 403);
        if (strtolower((string)($before['status'] ?? '')) !== 'submitted') sendError('Only submitted overtime requests can be cancelled.', 400);
        $updates[] = "status = 'cancelled'";
        $updates[] = "is_archived = 0";
        $updates[] = "archived_at = NULL";
    } else {
        if (empty($data['status'])) sendError('Status is required', 400);
        $status = strtolower(trim((string)$data['status']));
        if (!in_array($status, ['submitted', 'approved', 'rejected', 'cancelled'], true)) {
            sendError('Invalid overtime request status', 400);
        }

        // ── Duplicate guard on reactivation (all user types) ──
        if (in_array($status, ['submitted', 'approved'], true)) {
            $reactDup = findDuplicateOvertimeRequest(
                $conn,
                intval($before['employee_id'] ?? 0),
                substr((string)($before['work_date'] ?? ''), 0, 10),
                $id
            );
            if ($reactDup) {
                $reactDupStatus = strtolower((string)($reactDup['status'] ?? 'submitted'));
                $reactDupDate = substr((string)($reactDup['work_date'] ?? ''), 0, 10);
                sendError(
                    'Duplicate overtime request: this employee already has a ' . $reactDupStatus .
                    ' overtime request on ' . $reactDupDate . '.',
                    409,
                    [
                        'code' => 'duplicate_overtime',
                        'field' => 'work_date',
                        'fields' => ['work_date'],
                        'conflicting_status' => $reactDupStatus,
                        'conflicting_work_date' => $reactDupDate,
                        'conflicting_request_id' => intval($reactDup['overtime_request_id'] ?? 0),
                    ]
                );
            }
            $reactLeave = findLeaveCoveringOvertimeDate(
                $conn,
                intval($before['employee_id'] ?? 0),
                substr((string)($before['work_date'] ?? ''), 0, 10)
            );
            if ($reactLeave) {
                $reactLeaveStatus = strtolower((string)($reactLeave['status'] ?? 'pending'));
                $reactLeaveStart = substr((string)($reactLeave['start_date'] ?? ''), 0, 10);
                $reactLeaveEnd = substr((string)($reactLeave['end_date'] ?? ''), 0, 10);
                sendError(
                    'Duplicate date: this employee already has a ' . $reactLeaveStatus .
                    ' leave request covering ' . substr((string)($before['work_date'] ?? ''), 0, 10) . '.',
                    409,
                    [
                        'code' => 'duplicate_leave_date',
                        'field' => 'work_date',
                        'fields' => ['work_date'],
                        'conflicting_status' => $reactLeaveStatus,
                        'conflicting_start_date' => $reactLeaveStart,
                        'conflicting_end_date' => $reactLeaveEnd,
                        'conflicting_request_id' => intval($reactLeave['leave_request_id'] ?? 0),
                    ]
                );
            }
        }

        $updates[] = "status = ?";
        $params[] = $status;
        $types .= 's';

        if (in_array($status, ['approved', 'rejected'], true)) {
            $updates[] = "approved_by = ?";
            $updates[] = "approved_at = NOW()";
            $params[] = $currentUserId;
            $types .= 'i';
        } elseif ($status === 'submitted') {
            $updates[] = "approved_by = NULL";
            $updates[] = "approved_at = NULL";
        }

        if (array_key_exists('manager_notes', $data)) {
            $updates[] = "manager_notes = ?";
            $params[] = sanitizeInput((string)$data['manager_notes']);
            $types .= 's';
        }

        if ($status === 'rejected') {
            $updates[] = "is_archived = 1";
            $updates[] = "archived_at = NOW()";
        } else {
            $updates[] = "is_archived = 0";
            $updates[] = "archived_at = NULL";
        }
    }

    if (empty($updates)) sendError('No fields to update', 400);

    $sql = "UPDATE overtime_request SET " . implode(', ', $updates) . " WHERE overtime_request_id = ?";
    $params[] = $id;
    $types .= 'i';

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare overtime update', 500);
    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        $errno = intval($conn->errno);
        $stmt->close();
        if ($errno === 1062) {
            sendError(
                'Duplicate overtime request: this employee already has an active overtime request on this work date.',
                409,
                [
                    'code' => 'duplicate_overtime',
                    'field' => 'work_date',
                    'fields' => ['work_date'],
                ]
            );
        }
        error_log($conn->error);
        sendError('Failed to update overtime request.', 500);
    }
    if ($stmt->affected_rows <= 0) {
        $stmt->close();
        sendError('No changes were applied', 409);
    }
    $stmt->close();

    $after = getOvertimeRow($conn, $id);
    $statusNow = strtolower((string)($after['status'] ?? ''));
    if (in_array($statusNow, ['approved', 'rejected', 'cancelled'], true)) {
        $resolveSql = "UPDATE exception_queue
                       SET status = 'resolved',
                           resolved_by = ?,
                           resolved_at = NOW()
                       WHERE source_type = 'overtime_request'
                         AND source_record_id = ?";
        $resolveStmt = $conn->prepare($resolveSql);
        if ($resolveStmt) {
            $sourceId = (string)$id;
            $resolveStmt->bind_param('is', $currentUserId, $sourceId);
            $resolveStmt->execute();
            $resolveStmt->close();
        }
    } else {
        upsertExceptionQueue(
            $conn,
            'overtime_request',
            (string)$id,
            'Overtime request awaiting approval',
            'Overtime request #' . $id . ' is currently submitted.',
            floatval($after['hours_requested'] ?? 0) >= 6 ? 'high' : 'medium',
            'admin',
            [
                'overtime_request_id' => $id,
                'employee_id' => intval($after['employee_id'] ?? 0),
                'status' => $statusNow,
            ],
            $currentUserId
        );
    }

    logActivity($conn, $currentUserId, 'update_overtime_request', 'Updated overtime request #' . $id, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'overtime_request', $id, 'update', $before, $after, basename(__FILE__));
    sendResponse(true, $after, 'Overtime request updated successfully');
}

function handleDelete($conn) {
    $role = getSessionRoleForOvertime();
    if ($role !== 'admin') {
        sendError('Only admins can delete archived overtime requests.', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);

    $id = intval($_GET['id'] ?? $_GET['overtime_request_id'] ?? 0);
    if ($id <= 0) sendError('Overtime request ID is required', 400);

    $before = getOvertimeRow($conn, $id);
    if (!$before) sendError('Overtime request not found', 404);
    if (intval($before['is_archived'] ?? 0) !== 1) {
        sendError('Only archived overtime requests can be deleted', 400);
    }

    $queueStmt = $conn->prepare(
        "DELETE FROM exception_queue
         WHERE source_type = 'overtime_request'
           AND source_record_id = ?"
    );
    if ($queueStmt) {
        $recordId = (string)$id;
        $queueStmt->bind_param('s', $recordId);
        $queueStmt->execute();
        $queueStmt->close();
    }

    $stmt = $conn->prepare(
        "DELETE FROM overtime_request
         WHERE overtime_request_id = ?
           AND COALESCE(is_archived, 0) = 1"
    );
    if (!$stmt) sendError('Failed to prepare overtime delete', 500);
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to delete overtime request.', 500);
    }
    if ($stmt->affected_rows <= 0) {
        $stmt->close();
        sendError('Overtime request is no longer archived', 409);
    }
    $stmt->close();

    logActivity($conn, $currentUserId, 'delete_overtime_request', 'Deleted archived overtime request #' . $id, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'overtime_request', $id, 'delete', $before, null, basename(__FILE__));
    sendResponse(true, null, 'Overtime request deleted successfully');
}

closeDBConnection($conn);
?>
