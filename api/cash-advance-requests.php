<?php
/**
 * Cash Advance Requests API
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('cash_advance', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('cash_advance', ['admin', 'manager', 'staff'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('cash_advance', ['admin', 'manager', 'staff'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('cash_advance', ['admin', 'manager'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getSessionRoleForCashAdvance() {
    return strtolower(trim((string)($_SESSION['role'] ?? '')));
}

function getSessionEmployeeForCashAdvance($conn) {
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

function getSessionBranchForCashAdvance($conn) {
    $sessionBranchId = intval($_SESSION['branch_id'] ?? 0);
    if ($sessionBranchId > 0) return $sessionBranchId;

    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) return 0;

    $stmt = $conn->prepare("SELECT branch_id FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) return 0;
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $branchId = intval($row['branch_id'] ?? 0);
    if ($branchId > 0) {
        $_SESSION['branch_id'] = $branchId;
    }

    return $branchId;
}

function requireSessionEmployeeForCashAdvance($conn) {
    $employeeId = getSessionEmployeeForCashAdvance($conn);
    if ($employeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }
    return $employeeId;
}

function requireSessionBranchForCashAdvance($conn) {
    $branchId = getSessionBranchForCashAdvance($conn);
    if ($branchId <= 0) {
        sendError('Your account is not linked to a branch.', 403);
    }
    return $branchId;
}

function assertCashAdvanceEmployeeExists($conn, $employeeId) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) {
        sendError('Invalid employee ID', 400);
    }

    $stmt = $conn->prepare("SELECT employee_id FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to validate employee record.', 500);
    $stmt->bind_param('i', $employeeId);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        sendError('Employee not found', 404);
    }
}

function getCashAdvanceRow($conn, $id) {
    $stmt = $conn->prepare("SELECT * FROM cash_advance_request WHERE cash_advance_request_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to load cash advance request', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

function getCashAdvanceListRow($conn, $id) {
    $stmt = $conn->prepare(
        "SELECT car.*,
                CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                COALESCE(
                    (SELECT LOWER(TRIM(u.role)) FROM users u WHERE u.employee_id = car.employee_id ORDER BY u.id DESC LIMIT 1),
                    'staff'
                ) AS employee_role,
                creator.username AS created_by_username,
                approver.username AS approved_by_username,
                p.status AS deducted_payroll_status,
                p.pay_period_start AS deducted_pay_period_start,
                p.pay_period_end AS deducted_pay_period_end
         FROM cash_advance_request car
         INNER JOIN employees e ON e.employee_id = car.employee_id
         LEFT JOIN users creator ON creator.id = car.created_by
         LEFT JOIN users approver ON approver.id = car.approved_by
         LEFT JOIN payroll p ON p.id = car.deducted_payroll_id
         WHERE car.cash_advance_request_id = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to load cash advance request', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Find an active (submitted/approved, non-archived) cash advance request for the
 * same employee on the same request date. Applies to ALL roles.
 * Returns the conflicting row or null.
 */
function findDuplicateCashAdvanceRequest($conn, $employeeId, $requestDate, $excludeId = 0) {
    $employeeId = intval($employeeId);
    $excludeId = intval($excludeId);
    if ($employeeId <= 0 || $requestDate === '') return null;

    $sql = "SELECT cash_advance_request_id, request_date, status
            FROM cash_advance_request
            WHERE employee_id = ?
              AND request_date = ?
              AND status IN ('submitted', 'approved')
              AND COALESCE(is_archived, 0) = 0";
    $params = [$employeeId, $requestDate];
    $types = 'is';
    if ($excludeId > 0) {
        $sql .= " AND cash_advance_request_id <> ?";
        $params[] = $excludeId;
        $types .= 'i';
    }
    $sql .= " LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to validate duplicate cash advance request', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

function canViewCashAdvanceRequest($role, $selfEmployeeId, $record) {
    if (!$record) return false;
    if ($role === 'admin' || $role === 'manager') return true;
    if ($role === 'staff') return intval($record['employee_id'] ?? 0) === intval($selfEmployeeId);
    return false;
}

function getCashAdvanceEmployeeRole($conn, $employeeId) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return 'staff';

    $stmt = $conn->prepare(
        "SELECT LOWER(TRIM(role)) AS role
         FROM users
         WHERE employee_id = ?
         ORDER BY id DESC
         LIMIT 1"
    );
    if (!$stmt) return 'staff';
    $stmt->bind_param('i', $employeeId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $role = strtolower(trim((string)($row['role'] ?? 'staff')));
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        return 'staff';
    }

    return $role;
}

function getCashAdvanceEmployeeBranch($conn, $employeeId) {
    $employeeId = intval($employeeId);
    if ($employeeId <= 0) return 0;

    $stmt = $conn->prepare("SELECT branch_id FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$stmt) return 0;
    $stmt->bind_param('i', $employeeId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return intval($row['branch_id'] ?? 0);
}

function assertManagerCanCreateCashAdvanceForEmployee($conn, $managerEmployeeId, $managerBranchId, $employeeId, $isOwnRequest = false) {
    $employeeId = intval($employeeId);
    $managerEmployeeId = intval($managerEmployeeId);
    $managerBranchId = intval($managerBranchId);

    // Allow managers to request their own cash advance
    if ($isOwnRequest && $employeeId === $managerEmployeeId) {
        assertCashAdvanceEmployeeExists($conn, $employeeId);
        return;
    }

    if ($managerBranchId <= 0) {
        sendError('Your account is not linked to a branch.', 403);
    }

    if ($managerEmployeeId > 0 && $employeeId === $managerEmployeeId) {
        sendError('Managers can only create cash advance requests for staff in their own branch.', 403);
    }

    assertCashAdvanceEmployeeExists($conn, $employeeId);

    $targetRole = getCashAdvanceEmployeeRole($conn, $employeeId);
    if ($targetRole !== 'staff') {
        sendError('Managers can only create cash advance requests for staff in their own branch.', 403);
    }

    $targetBranchId = getCashAdvanceEmployeeBranch($conn, $employeeId);
    if ($targetBranchId <= 0 || $targetBranchId !== $managerBranchId) {
        sendError('Managers can only create cash advance requests for staff in their own branch.', 403);
    }
}

function canManageCashAdvanceDecision($actorRole, $actorEmployeeId, $record, $employeeRole) {
    if (!is_array($record)) return false;

    if ($actorRole === 'admin') return true;
    if ($actorRole !== 'manager') return false;

    $targetEmployeeId = intval($record['employee_id'] ?? 0);
    if ($targetEmployeeId > 0 && $targetEmployeeId === intval($actorEmployeeId)) {
        return false;
    }

    $targetRole = strtolower(trim((string)$employeeRole));
    if (!in_array($targetRole, ['admin', 'manager', 'staff'], true)) {
        $targetRole = 'staff';
    }

    return $targetRole === 'staff';
}

function handleGet($conn) {
    $role = getSessionRoleForCashAdvance();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $selfEmployeeId = $role === 'staff' ? requireSessionEmployeeForCashAdvance($conn) : getSessionEmployeeForCashAdvance($conn);
    $id = intval($_GET['id'] ?? 0);
    $archivedOnly = isset($_GET['archived']) ? intval($_GET['archived']) === 1 : false;

    $sql = "SELECT car.*,
                   CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                   COALESCE(
                       (SELECT LOWER(TRIM(u.role)) FROM users u WHERE u.employee_id = car.employee_id ORDER BY u.id DESC LIMIT 1),
                       'staff'
                   ) AS employee_role,
                   creator.username AS created_by_username,
                   approver.username AS approved_by_username,
                   p.status AS deducted_payroll_status,
                   p.pay_period_start AS deducted_pay_period_start,
                   p.pay_period_end AS deducted_pay_period_end
            FROM cash_advance_request car
            INNER JOIN employees e ON e.employee_id = car.employee_id
            LEFT JOIN users creator ON creator.id = car.created_by
            LEFT JOIN users approver ON approver.id = car.approved_by
            LEFT JOIN payroll p ON p.id = car.deducted_payroll_id
            WHERE COALESCE(car.is_archived, 0) = ?";
    $params = [];
    $types = 'i';
    $params[] = $archivedOnly ? 1 : 0;

    if ($id > 0) {
        $sql .= " AND car.cash_advance_request_id = ?";
        $params[] = $id;
        $types .= 'i';
    }

    if ($role === 'staff') {
        $sql .= " AND car.employee_id = ?";
        $params[] = $selfEmployeeId;
        $types .= 'i';
    } elseif (!empty($_GET['employee_id'])) {
        $sql .= " AND car.employee_id = ?";
        $params[] = intval($_GET['employee_id']);
        $types .= 'i';
    }

    if (!empty($_GET['status'])) {
        $sql .= " AND car.status = ?";
        $params[] = strtolower(trim((string)$_GET['status']));
        $types .= 's';
    }

    if (!empty($_GET['date_from'])) {
        $sql .= " AND car.request_date >= ?";
        $params[] = sanitizeInput($_GET['date_from']);
        $types .= 's';
    }

    if (!empty($_GET['date_to'])) {
        $sql .= " AND car.request_date <= ?";
        $params[] = sanitizeInput($_GET['date_to']);
        $types .= 's';
    }

    if ($archivedOnly) {
        $sql .= " ORDER BY
                    COALESCE(car.archived_at, car.updated_at, car.created_at) DESC,
                    car.cash_advance_request_id DESC";
    } else {
        $sql .= " ORDER BY
                    CASE
                        WHEN car.status = 'submitted' THEN 0
                        WHEN car.status = 'approved' AND car.deducted_payroll_id IS NULL THEN 1
                        WHEN car.status = 'approved' AND car.deducted_payroll_id IS NOT NULL THEN 2
                        ELSE 3
                    END ASC,
                    car.created_at DESC,
                    car.cash_advance_request_id DESC";
    }

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to prepare cash advance query', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }
    if (!$result) sendError('Failed to retrieve cash advance requests', 500);

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }

    if ($id > 0) {
        if (empty($rows)) sendError('Cash advance request not found', 404);
        sendResponse(true, $rows[0], 'Cash advance request retrieved successfully');
    }

    sendResponse(true, $rows, 'Cash advance requests retrieved successfully');
}

function handlePost($conn) {
    $role = getSessionRoleForCashAdvance();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);

    $data = getJSONInput();
    $sessionEmployeeId = getSessionEmployeeForCashAdvance($conn);
    $required = ['request_date', 'amount', 'reason'];
    if ($role === 'manager') {
        $required[] = 'employee_id';
    }
    if ($role === 'admin' && $sessionEmployeeId <= 0) {
        $required[] = 'employee_id';
    }
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $requestOwn = !empty($data['request_own']) && $data['request_own'] === true;

    if ($role === 'admin') {
        $employeeId = intval($data['employee_id'] ?? $sessionEmployeeId);
        assertCashAdvanceEmployeeExists($conn, $employeeId);
    } elseif ($role === 'manager') {
        $employeeId = intval($data['employee_id'] ?? 0);
        if ($employeeId <= 0) sendError('Employee ID is required.', 400);
        $managerBranchId = requireSessionBranchForCashAdvance($conn);
        assertManagerCanCreateCashAdvanceForEmployee($conn, $sessionEmployeeId, $managerBranchId, $employeeId, $requestOwn);
    } else {
        $employeeId = requireSessionEmployeeForCashAdvance($conn);
    }

    $requestDate = sanitizeInput($data['request_date']);
    if (!validateDate($requestDate)) sendError('Invalid request date format. Expected YYYY-MM-DD.', 400);
    if ($requestDate > date('Y-m-d')) sendError('Request date cannot be in the future.', 400);

    $amount = round(floatval($data['amount']), 2);
    if ($amount <= 0) sendError('Cash advance amount must be greater than 0.', 400);
    if ($amount > 1000000) sendError('Cash advance amount is too large.', 400);

    $reason = trim((string)$data['reason']);
    if ($reason === '') sendError('Reason is required', 400);
    if (strlen($reason) > 3000) sendError('Reason is too long (max 3000 characters)', 400);

    $safeReason = sanitizeInput($reason);
    $status = 'submitted';

    // ── Duplicate guard (all user types): same employee + same request date ──
    $duplicateCash = findDuplicateCashAdvanceRequest($conn, $employeeId, $requestDate);
    if ($duplicateCash) {
        $dupCashStatus = strtolower((string)($duplicateCash['status'] ?? 'submitted'));
        $dupCashDate = substr((string)($duplicateCash['request_date'] ?? $requestDate), 0, 10);
        sendError(
            'Duplicate cash advance request: this employee already has a ' . $dupCashStatus .
            ' cash advance request on ' . $dupCashDate . '.',
            409,
            [
                'code' => 'duplicate_cash_advance',
                'field' => 'request_date',
                'fields' => ['request_date'],
                'conflicting_status' => $dupCashStatus,
                'conflicting_request_date' => $dupCashDate,
                'conflicting_request_id' => intval($duplicateCash['cash_advance_request_id'] ?? 0),
            ]
        );
    }

    $stmt = $conn->prepare(
        "INSERT INTO cash_advance_request
            (employee_id, request_date, amount, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    if (!$stmt) sendError('Failed to prepare cash advance insert', 500);
    $stmt->bind_param('isdssi', $employeeId, $requestDate, $amount, $safeReason, $status, $currentUserId);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to submit cash advance request.', 500);
    }
    $requestId = intval($conn->insert_id);
    $stmt->close();

    $after = getCashAdvanceRow($conn, $requestId);
    logActivity($conn, $currentUserId, 'create_cash_advance_request', 'Submitted cash advance request #' . $requestId, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'cash_advance_request', $requestId, 'create', null, $after, basename(__FILE__));

    $createdRow = getCashAdvanceListRow($conn, $requestId);
    sendResponse(true, $createdRow ?: ['cash_advance_request_id' => $requestId], 'Cash advance request submitted successfully', 201);
}

function handlePut($conn) {
    $role = getSessionRoleForCashAdvance();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);
    $selfEmployeeId = $role === 'staff' ? requireSessionEmployeeForCashAdvance($conn) : getSessionEmployeeForCashAdvance($conn);

    $data = getJSONInput();
    $id = intval($data['cash_advance_request_id'] ?? 0);
    if ($id <= 0) sendError('Cash advance request ID is required', 400);

    $before = getCashAdvanceRow($conn, $id);
    if (!$before) sendError('Cash advance request not found', 404);
    if (!canViewCashAdvanceRequest($role, $selfEmployeeId, $before)) sendError('Forbidden', 403);

    $currentStatus = strtolower(trim((string)($before['status'] ?? 'submitted')));
    $deductedPayrollId = intval($before['deducted_payroll_id'] ?? 0);
    $targetEmployeeRole = getCashAdvanceEmployeeRole($conn, intval($before['employee_id'] ?? 0));
    $action = strtolower(trim((string)($data['action'] ?? '')));
    $isArchived = intval($before['is_archived'] ?? 0) === 1;

    $updates = [];
    $params = [];
    $types = '';

    $isOwnRequest = intval($before['employee_id'] ?? 0) === intval($selfEmployeeId) && $selfEmployeeId > 0;
    if ($action === 'archive') {
        if (!in_array($currentStatus, ['approved', 'rejected', 'cancelled'], true)) {
            sendError('Only completed cash advance requests can be archived.', 400);
        }
        if ($isArchived) sendError('Cash advance request is already archived.', 409);

        if ($role === 'staff' && !$isOwnRequest) {
            sendError('Staff can only archive their own cash advance request.', 403);
        }
        if ($role === 'manager' && !canManageCashAdvanceDecision($role, $selfEmployeeId, $before, $targetEmployeeRole) && !$isOwnRequest) {
            sendError('Managers can only archive their own or staff cash advance requests.', 403);
        }

        $updates[] = "is_archived = 1";
        $updates[] = "archived_at = NOW()";
        $updates[] = "archived_by = ?";
        $params[] = $currentUserId;
        $types .= 'i';
    } elseif ($action === 'restore') {
        if (!$isArchived) sendError('Cash advance request is not archived.', 409);

        if ($role === 'staff' && !$isOwnRequest) {
            sendError('Staff can only restore their own cash advance request.', 403);
        }
        if ($role === 'manager' && !canManageCashAdvanceDecision($role, $selfEmployeeId, $before, $targetEmployeeRole) && !$isOwnRequest) {
            sendError('Managers can only restore their own or staff cash advance requests.', 403);
        }

        // ── Duplicate guard on restore: another active request may now use the date ──
        if (in_array($currentStatus, ['submitted', 'approved'], true)) {
            $restoreDup = findDuplicateCashAdvanceRequest(
                $conn,
                intval($before['employee_id'] ?? 0),
                substr((string)($before['request_date'] ?? ''), 0, 10),
                $id
            );
            if ($restoreDup) {
                $restoreCashStatus = strtolower((string)($restoreDup['status'] ?? 'submitted'));
                $restoreCashDate = substr((string)($restoreDup['request_date'] ?? ''), 0, 10);
                sendError(
                    'Cannot restore: this employee already has a ' . $restoreCashStatus .
                    ' cash advance request on ' . $restoreCashDate . '.',
                    409,
                    [
                        'code' => 'duplicate_cash_advance',
                        'field' => 'request_date',
                        'fields' => ['request_date'],
                        'conflicting_status' => $restoreCashStatus,
                        'conflicting_request_date' => $restoreCashDate,
                        'conflicting_request_id' => intval($restoreDup['cash_advance_request_id'] ?? 0),
                    ]
                );
            }
        }

        $updates[] = "is_archived = 0";
        $updates[] = "archived_at = NULL";
        $updates[] = "archived_by = NULL";
    } elseif ($action === 'cancel' && $isOwnRequest) {
        if ($currentStatus !== 'submitted') sendError('Only submitted cash advance requests can be cancelled.', 400);
        if ($deductedPayrollId > 0) sendError('Deducted cash advance requests can no longer be cancelled.', 400);
        $updates[] = "status = 'cancelled'";
        $updates[] = "is_archived = 0";
        $updates[] = "archived_at = NULL";
        $updates[] = "archived_by = NULL";
    } elseif ($role === 'staff') {
        sendError('Staff can only cancel their own cash advance request.', 403);
    } else {
        if (empty($data['status'])) sendError('Status is required', 400);
        $nextStatus = strtolower(trim((string)$data['status']));
        if (!in_array($nextStatus, ['approved', 'rejected', 'cancelled'], true)) {
            sendError('Invalid cash advance request status', 400);
        }
        if (!canManageCashAdvanceDecision($role, $selfEmployeeId, $before, $targetEmployeeRole)) {
            if ($role === 'manager') {
                if ($isOwnRequest) {
                    sendError('Managers cannot approve their own cash advance requests. Please have an admin review it.', 403);
                }
                sendError('Managers can only approve or reject staff cash advance requests. Please have an admin review this request.', 403);
            }
            sendError('You are not allowed to approve or reject this cash advance request.', 403);
        }
        if ($currentStatus !== 'submitted' && $nextStatus !== $currentStatus) {
            sendError('Only submitted cash advance requests can be approved, rejected, or cancelled.', 400);
        }
        if ($isArchived) {
            sendError('Restore the archived cash advance request before changing its status.', 400);
        }
        if ($deductedPayrollId > 0 && $nextStatus !== 'approved') {
            sendError('Cash advance request is already deducted in payroll and cannot be changed.', 400);
        }

        $updates[] = "status = ?";
        $params[] = $nextStatus;
        $types .= 's';

        if ($nextStatus === 'approved') {
            $updates[] = "approved_by = ?";
            $updates[] = "approved_at = NOW()";
            $params[] = $currentUserId;
            $types .= 'i';
        } else {
            $updates[] = "approved_by = NULL";
            $updates[] = "approved_at = NULL";
            if ($deductedPayrollId <= 0) {
                $updates[] = "deducted_payroll_id = NULL";
                $updates[] = "deducted_at = NULL";
            }
        }

        if (array_key_exists('manager_notes', $data)) {
            $updates[] = "manager_notes = ?";
            $params[] = sanitizeInput((string)$data['manager_notes']);
            $types .= 's';
        }

        $updates[] = "is_archived = 0";
        $updates[] = "archived_at = NULL";
        $updates[] = "archived_by = NULL";
    }

    if (empty($updates)) sendError('No fields to update', 400);

    $sql = "UPDATE cash_advance_request SET " . implode(', ', $updates) . " WHERE cash_advance_request_id = ?";
    $params[] = $id;
    $types .= 'i';

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare cash advance update', 500);
    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to update cash advance request.', 500);
    }
    if ($stmt->affected_rows <= 0) {
        $stmt->close();
        sendError('No changes were applied', 409);
    }
    $stmt->close();

    $after = getCashAdvanceRow($conn, $id);
    if (strtolower((string)($after['status'] ?? '')) === 'approved') {
        syncNextDraftPayrollCashAdvanceRequests($conn, intval($after['employee_id'] ?? 0), (string)($after['request_date'] ?? ''));
        $after = getCashAdvanceRow($conn, $id);
    }

    logActivity($conn, $currentUserId, 'update_cash_advance_request', 'Updated cash advance request #' . $id, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'cash_advance_request', $id, 'update', $before, $after, basename(__FILE__));
    sendResponse(true, $after, 'Cash advance request updated successfully');
}

function handleDelete($conn) {
    $role = getSessionRoleForCashAdvance();
    if (!in_array($role, ['admin', 'manager'], true)) {
        sendError('Only admins or managers can delete archived cash advance requests.', 403);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) sendError('Authentication required', 401);

    $selfEmployeeId = getSessionEmployeeForCashAdvance($conn);
    $id = intval($_GET['id'] ?? $_GET['cash_advance_request_id'] ?? 0);
    if ($id <= 0) sendError('Cash advance request ID is required', 400);

    $before = getCashAdvanceRow($conn, $id);
    if (!$before) sendError('Cash advance request not found', 404);
    if (!canViewCashAdvanceRequest($role, $selfEmployeeId, $before)) sendError('Forbidden', 403);
    if (intval($before['is_archived'] ?? 0) !== 1) {
        sendError('Only archived cash advance requests can be deleted.', 400);
    }

    $stmt = $conn->prepare(
        "DELETE FROM cash_advance_request
         WHERE cash_advance_request_id = ?
           AND COALESCE(is_archived, 0) = 1"
    );
    if (!$stmt) sendError('Failed to prepare cash advance delete', 500);
    $stmt->bind_param('i', $id);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to delete cash advance request.', 500);
    }
    if ($stmt->affected_rows <= 0) {
        $stmt->close();
        sendError('Cash advance request is no longer archived.', 409);
    }
    $stmt->close();

    logActivity($conn, $currentUserId, 'delete_cash_advance_request', 'Deleted archived cash advance request #' . $id, 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'cash_advance_request', $id, 'delete', $before, null, basename(__FILE__));
    sendResponse(true, null, 'Cash advance request deleted successfully');
}

closeDBConnection($conn);
?>
