<?php
/**
 * Payroll API
 * Handles CRUD operations for payroll
 */

require_once 'config.php';
require_once 'utils.php';
require_once __DIR__ . '/mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);
ensurePayrollLeaveColumns($conn);
$action = strtolower(trim((string)($_GET['action'] ?? '')));

switch ($method) {
    case 'GET':
        requireAnyFeatureAccess(['payroll', 'my_payslips'], ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('payroll', ['admin', 'manager'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        if ($action === 'my_payslip_archive') {
            requireFeatureAccess('my_payslips', ['admin', 'manager', 'staff'], $conn);
            handleMyPayslipArchivePut($conn);
        } else {
            requireFeatureAccess('payroll', ['admin', 'manager'], $conn);
            handlePut($conn);
        }
        break;
    case 'DELETE':
        if ($action === 'my_payslip_archive') {
            requireFeatureAccess('my_payslips', ['admin', 'manager', 'staff'], $conn);
            handleMyPayslipArchiveDelete($conn);
        } else {
            requireFeatureAccess('payroll', ['admin', 'manager'], $conn);
            handleDelete($conn);
        }
        break;
    default:
        sendError('Method not allowed', 405);
}

function validatePayrollPeriodDates($payPeriodStart, $payPeriodEnd) {
    $payPeriodStart = trim((string)$payPeriodStart);
    $payPeriodEnd = trim((string)$payPeriodEnd);

    if (!validateDate($payPeriodStart) || !validateDate($payPeriodEnd)) {
        sendError('Pay period dates must use YYYY-MM-DD format.', 400);
    }

    if ($payPeriodStart > $payPeriodEnd) {
        sendError('Pay period start date cannot be after the end date.', 400);
    }

    $today = date('Y-m-d');
    if ($payPeriodStart > $today || $payPeriodEnd > $today) {
        sendError('Pay period cannot go beyond the current date (' . $today . ').', 400);
    }
}

function getCurrentSessionEmployeeId($conn) {
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

function getCurrentSessionUserId() {
    return intval($_SESSION['user_id'] ?? 0);
}

function getMyPayslipScopeValue() {
    $scope = strtolower(trim((string)($_GET['my_payslip_scope'] ?? '')));
    if ($scope === '') {
        return '';
    }

    if (!in_array($scope, ['active', 'archived'], true)) {
        sendError('Invalid payslip archive scope.', 400);
    }

    return $scope;
}

function getSelfServicePayslipArchiveContext($conn) {
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $userId = getCurrentSessionUserId();
    if ($userId <= 0) {
        sendError('Authentication required', 401);
    }

    $employeeId = getCurrentSessionEmployeeId($conn);
    if ($employeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }

    return [$role, $userId, $employeeId];
}

function getSelfServicePayslipArchiveRow($conn, $payrollId, $userId, $employeeId) {
    $sql = "SELECT p.*,
                   COALESCE(pua.is_archived, 0) AS user_is_archived,
                   pua.archived_at AS user_archived_at,
                   pua.deleted_at AS user_deleted_at
            FROM payroll p
            LEFT JOIN payroll_user_archive pua
              ON pua.payroll_id = p.id
             AND pua.user_id = ?
            WHERE p.id = ?
              AND p.employee_id = ?
              AND p.status IN ('approved', 'paid', 'archived')
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare payslip archive lookup.', 500);
    }

    $stmt->bind_param('iii', $userId, $payrollId, $employeeId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function saveSelfServicePayslipArchiveState($conn, $payrollId, $userId, $mode) {
    if ($mode === 'archive') {
        $sql = "INSERT INTO payroll_user_archive
                    (payroll_id, user_id, is_archived, archived_at, deleted_at)
                VALUES (?, ?, 1, NOW(), NULL)
                ON DUPLICATE KEY UPDATE
                    is_archived = 1,
                    archived_at = NOW(),
                    deleted_at = NULL";
    } elseif ($mode === 'restore') {
        $sql = "INSERT INTO payroll_user_archive
                    (payroll_id, user_id, is_archived, archived_at, deleted_at)
                VALUES (?, ?, 0, NULL, NULL)
                ON DUPLICATE KEY UPDATE
                    is_archived = 0,
                    archived_at = NULL,
                    deleted_at = NULL";
    } elseif ($mode === 'delete') {
        $sql = "INSERT INTO payroll_user_archive
                    (payroll_id, user_id, is_archived, archived_at, deleted_at)
                VALUES (?, ?, 0, NULL, NOW())
                ON DUPLICATE KEY UPDATE
                    is_archived = 0,
                    archived_at = NULL,
                    deleted_at = NOW()";
    } else {
        sendError('Invalid payslip archive action.', 400);
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare payslip archive update.', 500);
    }

    $stmt->bind_param('ii', $payrollId, $userId);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to update payslip archive storage.', 500);
    }
    $stmt->close();
}

function normalizePayrollStatus($value, $default = 'draft', $allowArchived = true) {
    $allowed = ['draft', 'pending', 'approved', 'paid'];
    if ($allowArchived) {
        $allowed[] = 'archived';
    }

    $status = strtolower(trim((string)$value));
    if ($status === '') {
        $status = strtolower((string)$default);
    }

    if (!in_array($status, $allowed, true)) {
        sendError('Invalid payroll status.', 400);
    }

    return $status;
}

function normalizePayrollIds($value) {
    if (!is_array($value) || empty($value)) {
        sendError('At least one payroll ID is required.', 400);
    }

    $ids = [];
    foreach ($value as $rawId) {
        if (!is_numeric($rawId)) continue;
        $id = intval($rawId);
        if ($id > 0) {
            $ids[$id] = $id;
        }
    }

    $normalized = array_values($ids);
    if (empty($normalized)) {
        sendError('At least one valid payroll ID is required.', 400);
    }

    return $normalized;
}

function bindDynamicParams($stmt, $types, $params) {
    if (!$stmt || $types === '' || empty($params)) return;
    $stmt->bind_param($types, ...$params);
}

function buildInClause($count) {
    return implode(',', array_fill(0, max(0, intval($count)), '?'));
}

function sortPayrollIdsForCashAdvanceSync($payrollIds, $payrollRows) {
    $sortedIds = array_values(array_map('intval', $payrollIds));
    usort($sortedIds, function ($leftId, $rightId) use ($payrollRows) {
        $leftEnd = trim((string)($payrollRows[$leftId]['pay_period_end'] ?? ''));
        $rightEnd = trim((string)($payrollRows[$rightId]['pay_period_end'] ?? ''));

        $leftTs = $leftEnd !== '' ? (strtotime($leftEnd) ?: PHP_INT_MAX) : PHP_INT_MAX;
        $rightTs = $rightEnd !== '' ? (strtotime($rightEnd) ?: PHP_INT_MAX) : PHP_INT_MAX;

        if ($leftTs === $rightTs) {
            return $leftId <=> $rightId;
        }

        return $leftTs <=> $rightTs;
    });

    return $sortedIds;
}

function sendPayslipReleaseEmails($conn, $payrollIds) {
    if (empty($payrollIds)) return;

    try {
        // Determine base URL for email links
        $baseUrl = '';
        if (!empty($_SERVER['HTTP_ORIGIN'])) {
            $baseUrl = rtrim($_SERVER['HTTP_ORIGIN'], '/');
        } elseif (!empty($_SERVER['HTTP_REFERER'])) {
            $parsed = parse_url($_SERVER['HTTP_REFERER']);
            $baseUrl = ($parsed['scheme'] ?? 'http') . '://' . ($parsed['host'] ?? 'localhost') . (isset($parsed['port']) ? ':' . $parsed['port'] : '');
        } else {
            $baseUrl = 'http://localhost:3000';
        }

        // Fetch payroll + employee details for released records
        $placeholders = implode(',', array_fill(0, count($payrollIds), '?'));
        $types = str_repeat('i', count($payrollIds));

        $stmt = $conn->prepare("
            SELECT p.id AS payroll_id, e.email, e.first_name, e.last_name,
                   p.pay_period_start, p.pay_period_end, p.net_pay, p.gross_pay,
                   p.total_deductions
            FROM payroll p
            JOIN employees e ON e.employee_id = p.employee_id
            WHERE p.id IN ($placeholders)
        ");
        $stmt->bind_param($types, ...$payrollIds);
        $stmt->execute();
        $result = $stmt->get_result();
        $records = $result->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        // Send employee emails
        foreach ($records as $rec) {
            if (empty($rec['email'])) continue;

            $fullName = trim($rec['first_name'] . ' ' . $rec['last_name']);
            $grossPay = floatval($rec['gross_pay'] ?? 0);
            $deductions = floatval($rec['total_deductions'] ?? 0);
            $netPay = floatval($rec['net_pay'] ?? 0);

            $html = buildPayslipReleaseEmail(
                $fullName,
                $rec['pay_period_start'],
                $rec['pay_period_end'],
                $grossPay,
                $deductions,
                $netPay,
                $baseUrl
            );

            $periodLabel = date('M j', strtotime($rec['pay_period_start'])) . ' - ' . date('M j, Y', strtotime($rec['pay_period_end']));
            $subject = "Your Payslip for {$periodLabel} Has Been Released";
            $altBody = "Dear {$fullName}, your payslip for {$periodLabel} has been released. Net Pay: PHP " . number_format($netPay, 2) . ". Visit {$baseUrl}/my-payslips to view.";

            sendMail($rec['email'], $fullName, $subject, $html, $altBody);
        }

        // Send admin/manager summary notifications
        $adminStmt = $conn->prepare("
            SELECT email, first_name, last_name FROM users
            WHERE role IN ('admin','manager') AND status = 'active' AND email IS NOT NULL AND email != ''
        ");
        $adminStmt->execute();
        $adminResult = $adminStmt->get_result();
        $admins = $adminResult->fetch_all(MYSQLI_ASSOC);
        $adminStmt->close();

        if (!empty($admins) && !empty($records)) {
            foreach ($records as $rec) {
                $empName = trim($rec['first_name'] . ' ' . $rec['last_name']);
                $adminHtml = buildPayslipReleaseAdminEmail(
                    $empName,
                    $rec['pay_period_start'],
                    $rec['pay_period_end'],
                    $baseUrl
                );

                $periodLabel = date('M j', strtotime($rec['pay_period_start'])) . ' - ' . date('M j, Y', strtotime($rec['pay_period_end']));
                $adminSubject = "Payslip Released: {$empName} ({$periodLabel})";
                $adminAlt = "Payslip for {$empName} for period {$periodLabel} has been released.";

                foreach ($admins as $admin) {
                    // Don't send admin notification to the employee themselves
                    if (strcasecmp($admin['email'], $rec['email'] ?? '') === 0) continue;

                    $adminName = trim($admin['first_name'] . ' ' . $admin['last_name']);
                    sendMail($admin['email'], $adminName, $adminSubject, $adminHtml, $adminAlt);
                }
            }
        }

    } catch (\Throwable $e) {
        error_log('Payslip release email error: ' . $e->getMessage());
    }
}

function handleBulkStatusUpdate($conn, $data) {
    $status = normalizePayrollStatus($data['status'] ?? '', 'draft', true);
    $ids = normalizePayrollIds($data['ids'] ?? []);
    $placeholders = buildInClause(count($ids));

    $selectSql = "SELECT * FROM payroll WHERE id IN ($placeholders)";
    $selectStmt = $conn->prepare($selectSql);
    if (!$selectStmt) {
        sendError('Failed to prepare payroll lookup.', 500);
    }

    bindDynamicParams($selectStmt, str_repeat('i', count($ids)), $ids);
    $selectStmt->execute();
    $result = $selectStmt->get_result();

    $beforeRows = [];
    while ($row = $result->fetch_assoc()) {
        $beforeRows[intval($row['id'])] = $row;
    }
    $selectStmt->close();

    if (empty($beforeRows)) {
        sendError('Payroll records not found.', 404);
    }

    $eligibleIds = [];
    $skippedCount = 0;

    foreach ($beforeRows as $rowId => $row) {
        $currentStatus = strtolower((string)($row['status'] ?? ''));
        if ($currentStatus === $status) {
            $skippedCount++;
            continue;
        }
        if ($status === 'archived' && $currentStatus !== 'paid') {
            $skippedCount++;
            continue;
        }
        if ($currentStatus === 'archived' && !in_array($status, ['paid', 'archived'], true)) {
            $skippedCount++;
            continue;
        }
        $eligibleIds[] = intval($rowId);
    }

    if (empty($eligibleIds)) {
        sendResponse(true, [
            'updated_count' => 0,
            'skipped_count' => $skippedCount,
            'status' => $status,
        ], 'No payroll records were eligible for update.');
    }

    $updatePlaceholders = buildInClause(count($eligibleIds));
    $updateSql = $status === 'archived'
        ? "UPDATE payroll SET status = ?, archived_at = NOW() WHERE id IN ($updatePlaceholders)"
        : ($status === 'paid'
            ? "UPDATE payroll SET status = ?, archived_at = CASE WHEN status = 'archived' THEN NULL ELSE archived_at END WHERE id IN ($updatePlaceholders)"
            : "UPDATE payroll SET status = ?, archived_at = NULL WHERE id IN ($updatePlaceholders)");
    $updateStmt = $conn->prepare($updateSql);
    if (!$updateStmt) {
        sendError('Failed to prepare payroll status update.', 500);
    }

    $updateParams = array_merge([$status], $eligibleIds);
    bindDynamicParams($updateStmt, 's' . str_repeat('i', count($eligibleIds)), $updateParams);

    if (!$updateStmt->execute()) {
        error_log($conn->error);
        sendError('Failed to update payroll records.', 500);
    }
    $updateStmt->close();

    if (in_array($status, ['approved', 'paid'], true)) {
        // A transition from Paid back to Approved is a correction, not a new
        // payroll release. Avoid recalculating cash advances for that reversal.
        $syncCandidates = array_values(array_filter($eligibleIds, static function ($payrollId) use ($beforeRows, $status) {
            $beforeStatus = strtolower((string)($beforeRows[$payrollId]['status'] ?? ''));
            if ($status === 'approved' && $beforeStatus === 'paid') return false;
            if ($status === 'paid' && $beforeStatus === 'archived') return false;
            return true;
        }));
        $syncIds = sortPayrollIdsForCashAdvanceSync($syncCandidates, $beforeRows);
        foreach ($syncIds as $payrollId) {
            syncPayrollCashAdvanceRequests($conn, $payrollId);
        }
    }

    $afterStmt = $conn->prepare($selectSql);
    if (!$afterStmt) {
        sendError('Payroll records updated, but failed to load the updated state.', 500);
    }
    bindDynamicParams($afterStmt, str_repeat('i', count($ids)), $ids);
    $afterStmt->execute();
    $afterResult = $afterStmt->get_result();

    $afterRows = [];
    while ($row = $afterResult->fetch_assoc()) {
        $afterRows[intval($row['id'])] = $row;
    }
    $afterStmt->close();

    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        $eligibleArchivedCount = 0;
        foreach ($eligibleIds as $payrollId) {
            $beforeStatus = strtolower((string)($beforeRows[$payrollId]['status'] ?? ''));
            if ($beforeStatus === 'archived') {
                $eligibleArchivedCount++;
            }
        }
        $isRestore = $status === 'paid' && $eligibleArchivedCount === count($eligibleIds) && $eligibleArchivedCount > 0;
        $verb = $status === 'archived' ? 'archive' : ($isRestore ? 'restore' : 'update');
        logActivity(
            $conn,
            $user_id,
            $verb . '_payroll_bulk',
            ucfirst($status) . ' payroll records: ' . implode(', ', $eligibleIds),
            'payroll_management'
        );

        foreach ($eligibleIds as $payrollId) {
            if (!isset($beforeRows[$payrollId]) || !isset($afterRows[$payrollId])) continue;
            logAuditTrail($conn, $user_id, 'payroll', $payrollId, 'update', $beforeRows[$payrollId], $afterRows[$payrollId], basename(__FILE__));
        }
    }

    $updatedCount = count($eligibleIds);
    $message = $updatedCount === 1
        ? 'Payroll record updated successfully.'
        : 'Payroll records updated successfully.';
    if ($skippedCount > 0) {
        $message .= ' ' . $skippedCount . ' record(s) were skipped.';
    }

    $responseData = [
        'updated_count' => $updatedCount,
        'skipped_count' => $skippedCount,
        'status' => $status,
    ];

    $releasedIds = array_values(array_filter($eligibleIds, static function ($payrollId) use ($beforeRows) {
        return strtolower((string)($beforeRows[$payrollId]['status'] ?? '')) !== 'archived';
    }));
    if ($status === 'approved' || ($status === 'paid' && !empty($releasedIds))) {
        if ($status === 'paid') {
            $message = 'Payslip released and payroll marked as paid.';
        }
        sendResponseAndContinue(true, $responseData, $message, 200, function () use ($conn, $releasedIds) {
            sendPayslipReleaseEmails($conn, $releasedIds);
        });
    }

    sendResponse(true, $responseData, $message);
}

/**
 * GET - Retrieve payroll records
 */
function handleGet($conn) {
    purgeExpiredArchivedPayroll($conn);
    $getAction = strtolower(trim((string)($_GET['action'] ?? '')));
    if ($getAction === 'leave_impact') {
        handleLeaveImpact($conn);
        return;
    }
    $payroll_id = $_GET['id'] ?? null;
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $selfEmployeeId = ($role === 'staff') ? getCurrentSessionEmployeeId($conn) : 0;
    $currentUserId = getCurrentSessionUserId();
    $myPayslipScope = getMyPayslipScopeValue();
    $useMyPayslipScope = $myPayslipScope !== '';
    if ($useMyPayslipScope) {
        $selfEmployeeId = getCurrentSessionEmployeeId($conn);
    }
    $releasedOnly = intval($_GET['released_only'] ?? 0) === 1;
    $include_archived = intval($_GET['include_archived'] ?? 0) === 1;
    $restrictToReleased = $releasedOnly || $role === 'staff' || $useMyPayslipScope;
    $releasedStatusesSql = ($restrictToReleased && $include_archived)
        ? "('approved', 'paid', 'archived')"
        : "('approved', 'paid')";
    $cashAdvanceSelectSql = ",
                       COALESCE(ca_summary.cash_advance_request_count, 0) AS cash_advance_request_count,
                       COALESCE(ca_summary.cash_advance_request_total, 0) AS cash_advance_request_total";
    $cashAdvanceJoinSql = "
                LEFT JOIN (
                    SELECT deducted_payroll_id,
                           COUNT(*) AS cash_advance_request_count,
                           COALESCE(SUM(amount), 0) AS cash_advance_request_total
                    FROM cash_advance_request
                    WHERE status = 'approved'
                      AND deducted_payroll_id IS NOT NULL
                    GROUP BY deducted_payroll_id
                ) ca_summary ON ca_summary.deducted_payroll_id = p.id";
    $personalArchiveSelectSql = '';
    $personalArchiveJoinSql = '';

    if ($useMyPayslipScope) {
        if ($currentUserId <= 0) {
            sendError('Authentication required', 401);
        }

        $personalArchiveSelectSql = ",
                       COALESCE(pua.is_archived, 0) AS user_is_archived,
                       pua.archived_at AS user_archived_at,
                       CASE WHEN pua.deleted_at IS NULL THEN 0 ELSE 1 END AS user_is_deleted";
        $personalArchiveJoinSql = "
                LEFT JOIN payroll_user_archive pua
                  ON pua.payroll_id = p.id
                 AND pua.user_id = " . intval($currentUserId);
    }

    if (($role === 'staff' || $useMyPayslipScope) && $selfEmployeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }
    
    if ($payroll_id) {
        // Get single payroll record
        $sql = "SELECT p.*,
                       CONCAT(e.first_name, ' ', e.last_name) as full_employee_name,
                       e.employee_date_id,
                       b.branch_name,
                       ar.days_worked AS attendance_days_worked,
                       ar.overtime_hours AS attendance_overtime_hours,
                       ar.late_minutes AS attendance_late_minutes,
                       ar.absent_days AS attendance_absent_days,
                       ar.leave_days AS attendance_leave_days" . $cashAdvanceSelectSql . $personalArchiveSelectSql . "
                FROM payroll p
                LEFT JOIN employees e ON p.employee_id = e.employee_id
                LEFT JOIN branches b ON e.branch_id = b.branch_id
                LEFT JOIN attendance_records ar ON ar.id = (
                    SELECT MAX(ar2.id) FROM attendance_records ar2
                    WHERE ar2.employee_id = p.employee_id
                      AND ar2.pay_period_start = p.pay_period_start
                      AND ar2.pay_period_end = p.pay_period_end
                )" . $cashAdvanceJoinSql . $personalArchiveJoinSql . "
                WHERE p.id = ?";

        if ($restrictToReleased) {
            $sql .= " AND p.status IN $releasedStatusesSql";
        }

        if ($useMyPayslipScope) {
            if ($myPayslipScope === 'archived') {
                $sql .= " AND COALESCE(pua.is_archived, 0) = 1 AND pua.deleted_at IS NULL";
            } else {
                $sql .= " AND COALESCE(pua.is_archived, 0) = 0 AND pua.deleted_at IS NULL";
            }
        }

        if ($role === 'staff' || $useMyPayslipScope) {
            $sql .= " AND p.employee_id = ?";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('ii', $payroll_id, $selfEmployeeId);
        } else {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $payroll_id);
        }

        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($row = $result->fetch_assoc()) {
            sendResponse(true, $row, 'Payroll record retrieved successfully');
        } else {
            sendError('Payroll record not found', 404);
        }
    } else {
        // Get all payroll records
        $employee_id = $_GET['employee_id'] ?? null;
        $status = $_GET['status'] ?? null;
        $period_start = $_GET['period_start'] ?? null;
        $period_end = $_GET['period_end'] ?? null;
        if ($role === 'staff' || $useMyPayslipScope) {
            $employee_id = $selfEmployeeId;
        }
        
        $sql = "SELECT p.*,
                       CONCAT(e.first_name, ' ', e.last_name) as full_employee_name,
                       e.employee_date_id,
                       b.branch_name,
                       ar.days_worked AS attendance_days_worked,
                       ar.overtime_hours AS attendance_overtime_hours,
                       ar.late_minutes AS attendance_late_minutes,
                       ar.absent_days AS attendance_absent_days,
                       ar.leave_days AS attendance_leave_days" . $cashAdvanceSelectSql . $personalArchiveSelectSql . "
                FROM payroll p
                LEFT JOIN employees e ON p.employee_id = e.employee_id
                LEFT JOIN branches b ON e.branch_id = b.branch_id
                LEFT JOIN attendance_records ar ON ar.id = (
                    SELECT MAX(ar2.id) FROM attendance_records ar2
                    WHERE ar2.employee_id = p.employee_id
                      AND ar2.pay_period_start = p.pay_period_start
                      AND ar2.pay_period_end = p.pay_period_end
                )" . $cashAdvanceJoinSql . $personalArchiveJoinSql . "
                WHERE 1=1";
        
        $params = [];
        $types = '';
        
        if ($employee_id) {
            $sql .= " AND p.employee_id = ?";
            $params[] = $employee_id;
            $types .= 'i';
        }
        
        if ($status && $status !== 'all') {
            $status = normalizePayrollStatus($status, 'draft', true);
            $allowedReleasedStatuses = $include_archived
                ? ['approved', 'paid', 'archived']
                : ['approved', 'paid'];
            if ($restrictToReleased && !in_array($status, $allowedReleasedStatuses, true)) {
                sendError('Payslip is not yet released.', 403);
            }
            $sql .= " AND p.status = ?";
            $params[] = $status;
            $types .= 's';
        } elseif ($restrictToReleased) {
            $sql .= " AND p.status IN $releasedStatusesSql";
        } elseif (!$include_archived) {
            $sql .= " AND (p.status IS NULL OR p.status <> 'archived')";
        }

        if ($useMyPayslipScope) {
            if ($myPayslipScope === 'archived') {
                $sql .= " AND COALESCE(pua.is_archived, 0) = 1 AND pua.deleted_at IS NULL";
            } else {
                $sql .= " AND COALESCE(pua.is_archived, 0) = 0 AND pua.deleted_at IS NULL";
            }
        }
        
        if ($period_start) {
            $sql .= " AND p.pay_period_start >= ?";
            $params[] = $period_start;
            $types .= 's';
        }
        
        if ($period_end) {
            $sql .= " AND p.pay_period_end <= ?";
            $params[] = $period_end;
            $types .= 's';
        }
        
        $sql .= " ORDER BY p.pay_period_start DESC, p.created_at DESC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
        }
        
        $payroll_records = [];
        while ($row = $result->fetch_assoc()) {
            $payroll_records[] = $row;
        }
        
        sendResponse(true, $payroll_records, 'Payroll records retrieved successfully');
    }
}

/** Permanently remove employee payroll records five years after archival. */
function purgeExpiredArchivedPayroll($conn) {
    $stmt = $conn->prepare("DELETE FROM payroll WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < DATE_SUB(NOW(), INTERVAL 1825 DAY)");
    if (!$stmt) return 0;
    if (!$stmt->execute()) {
        error_log('Expired payroll archive cleanup failed: ' . $conn->error);
        $stmt->close();
        return 0;
    }
    $deleted = (int)$stmt->affected_rows;
    $stmt->close();
    if ($deleted > 0) {
        logActivity($conn, null, 'expire_archived_payroll', "Automatically permanently removed {$deleted} payroll record(s) archived for more than 1825 days", 'payroll_management');
    }
    return $deleted;
}

function handleMyPayslipArchivePut($conn) {
    [, $currentUserId, $selfEmployeeId] = getSelfServicePayslipArchiveContext($conn);
    $data = getJSONInput();
    $payrollId = intval($data['payroll_id'] ?? $data['id'] ?? 0);
    if ($payrollId <= 0) {
        sendError('Payroll ID is required.', 400);
    }

    $action = strtolower(trim((string)($data['action'] ?? 'archive')));
    if (!in_array($action, ['archive', 'restore'], true)) {
        sendError('Invalid payslip archive action.', 400);
    }

    $before = getSelfServicePayslipArchiveRow($conn, $payrollId, $currentUserId, $selfEmployeeId);
    if (!$before) {
        sendError('Payslip not found.', 404);
    }

    $isArchived = intval($before['user_is_archived'] ?? 0) === 1;
    $isDeleted = !empty($before['user_deleted_at']);

    if ($action === 'archive') {
        if ($isDeleted) {
            sendError('This payslip was already removed from your archive storage.', 409);
        }
        if ($isArchived) {
            sendError('Payslip is already in your archive storage.', 409);
        }
    } else {
        if ($isDeleted) {
            sendError('Deleted archived payslips cannot be restored.', 409);
        }
        if (!$isArchived) {
            sendError('Payslip is not in your archive storage.', 409);
        }
    }

    saveSelfServicePayslipArchiveState($conn, $payrollId, $currentUserId, $action);
    $after = getSelfServicePayslipArchiveRow($conn, $payrollId, $currentUserId, $selfEmployeeId);
    $entityId = $payrollId . ':' . $currentUserId;

    if ($action === 'archive') {
        logActivity($conn, $currentUserId, 'archive_my_payslip', 'Archived payslip #' . $payrollId . ' in personal storage', 'payroll_management');
        logAuditTrail($conn, $currentUserId, 'payroll_user_archive', $entityId, 'archive', $before, $after, basename(__FILE__));
        sendResponse(true, $after, 'Payslip archived successfully.');
    }

    logActivity($conn, $currentUserId, 'restore_my_payslip', 'Restored payslip #' . $payrollId . ' from personal storage', 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'payroll_user_archive', $entityId, 'restore', $before, $after, basename(__FILE__));
    sendResponse(true, $after, 'Payslip restored successfully.');
}

function handleMyPayslipArchiveDelete($conn) {
    [, $currentUserId, $selfEmployeeId] = getSelfServicePayslipArchiveContext($conn);
    $payrollId = intval($_GET['id'] ?? $_GET['payroll_id'] ?? 0);
    if ($payrollId <= 0) {
        sendError('Payroll ID is required.', 400);
    }

    $before = getSelfServicePayslipArchiveRow($conn, $payrollId, $currentUserId, $selfEmployeeId);
    if (!$before) {
        sendError('Payslip not found.', 404);
    }

    $isArchived = intval($before['user_is_archived'] ?? 0) === 1;
    $isDeleted = !empty($before['user_deleted_at']);
    if ($isDeleted) {
        sendError('Payslip was already removed from your archive storage.', 409);
    }
    if (!$isArchived) {
        sendError('Only archived payslips can be deleted from archive storage.', 400);
    }

    saveSelfServicePayslipArchiveState($conn, $payrollId, $currentUserId, 'delete');
    $after = getSelfServicePayslipArchiveRow($conn, $payrollId, $currentUserId, $selfEmployeeId);
    $entityId = $payrollId . ':' . $currentUserId;

    logActivity($conn, $currentUserId, 'delete_my_payslip_archive', 'Deleted archived payslip #' . $payrollId . ' from personal storage', 'payroll_management');
    logAuditTrail($conn, $currentUserId, 'payroll_user_archive', $entityId, 'delete', $before, $after, basename(__FILE__));
    sendResponse(true, null, 'Payslip deleted from archive storage successfully.');
}

/**
 * POST - Create new payroll record
 */
function handlePost($conn) {
    $data = getJSONInput();
    
    // Validate required fields
    $required = ['employee_id', 'pay_period_start', 'pay_period_end'];
    $missing = validateRequiredFields($data, $required);
    
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    if (!array_key_exists('cash_advance_manual_deduction', $data) && array_key_exists('cash_advance_deduction', $data)) {
        $data['cash_advance_manual_deduction'] = $data['cash_advance_deduction'];
    }
    
    $employee_id = intval($data['employee_id']);
    
    // Get employee details
    $emp_sql = "SELECT CONCAT(first_name, ' ', last_name) as name, salary,
                       sss_number, pagibig_number, philhealth_number, tin_number
                FROM employees WHERE employee_id = ?";
    $emp_stmt = $conn->prepare($emp_sql);
    $emp_stmt->bind_param('i', $employee_id);
    $emp_stmt->execute();
    $emp_result = $emp_stmt->get_result();
    
    if ($emp_result->num_rows === 0) {
        sendError('Employee not found', 404);
    }
    
    $employee = $emp_result->fetch_assoc();
    $employee_name = $employee['name'];
    // employees.salary is MONTHLY; pay periods are semi-monthly, so the
    // period basic is half the monthly salary (matches import + seeds).
    $monthly_salary = max(0.0, floatval($employee['salary'] ?? 0));
    $basic_salary = round($monthly_salary / 2, 2);
    
    $pay_period_start = $data['pay_period_start'];
    $pay_period_end = $data['pay_period_end'];
    validatePayrollPeriodDates($pay_period_start, $pay_period_end);
    $overtime_hours = $data['overtime_hours'] ?? 0;
    $overtime_rate = $data['overtime_rate'] ?? 0;
    $overtime_pay = $overtime_hours * $overtime_rate;
    $bonus = $data['bonus'] ?? 0;
    
    // Allowances
    $clothing_allowance = $data['clothing_allowance'] ?? 0;
    $travel_allowance = $data['travel_allowance'] ?? 0;
    $salary_adjustment = $data['salary_adjustment'] ?? 0;
    
    // Attendance deductions
    $late_deduction = $data['late_deduction'] ?? 0;
    $absence_deduction = $data['absence_deduction'] ?? 0;

    // Auto-fill absence deduction from approved unpaid leaves overlapping the
    // period when no explicit value is given (same convention as government
    // auto-deductions below). Explicit manual values are always respected.
    $leaveImpact = computeUnpaidLeaveImpact($conn, $employee_id, $pay_period_start, $pay_period_end, $monthly_salary);
    if (floatval($absence_deduction) <= 0 && $leaveImpact['amount'] > 0) {
        $absence_deduction = $leaveImpact['amount'];
    }
    
    // Government contributions
    $tax = $data['tax'] ?? 0;
    $sss_contribution = $data['sss_contribution'] ?? 0;
    $pagibig_contribution = $data['pagibig_contribution'] ?? 0;
    $philhealth_contribution = $data['philhealth_contribution'] ?? 0;

    // Auto-calculate government deductions from settings when values are empty/zero.
    // Deduction-type tables (SSS MSC, tax brackets, PhilHealth floors) are
    // MONTHLY bases, so they always use the monthly salary — never the
    // semi-monthly period basic.
    $govEligibility = buildGovEligibilityFromEmployee($employee);
    $govDefaults = computeGovernmentDeductionsFromTypes($conn, $monthly_salary, $govEligibility);
    if (isset($govDefaults['tax']) && floatval($tax) <= 0) {
        $tax = $govDefaults['tax'];
    }
    if (isset($govDefaults['sss_contribution']) && floatval($sss_contribution) <= 0) {
        $sss_contribution = $govDefaults['sss_contribution'];
    }
    if (isset($govDefaults['pagibig_contribution']) && floatval($pagibig_contribution) <= 0) {
        $pagibig_contribution = $govDefaults['pagibig_contribution'];
    }
    if (isset($govDefaults['philhealth_contribution']) && floatval($philhealth_contribution) <= 0) {
        $philhealth_contribution = $govDefaults['philhealth_contribution'];
    }
    
    // Loan deductions
    $cash_advance_manual_deduction = $data['cash_advance_manual_deduction'] ?? 0;
    $cash_advance_deduction = $cash_advance_manual_deduction;
    $laptop_loan_deduction = $data['laptop_loan_deduction'] ?? 0;
    $other_deductions = $data['other_deductions'] ?? 0;
    
    // Calculate totals — bonus excluded from gross per client requirement
    $gross_pay = $basic_salary + $overtime_pay + $clothing_allowance + $travel_allowance + $salary_adjustment - $late_deduction - $absence_deduction;
    $total_deductions = $tax + $sss_contribution + $pagibig_contribution + $philhealth_contribution + $cash_advance_deduction + $laptop_loan_deduction + $other_deductions;
    $net_pay = max(0, $gross_pay - $total_deductions + $bonus);
    
    $status = normalizePayrollStatus($data['status'] ?? 'draft', 'draft', false);
    $notes = sanitizeInput($data['notes'] ?? '');
    
    $sql = "INSERT INTO payroll (employee_id, employee_name, pay_period_start, pay_period_end, 
                                 basic_salary, overtime_hours, overtime_rate, overtime_pay, bonus, 
                                 clothing_allowance, travel_allowance, salary_adjustment,
                                 late_deduction, absence_deduction,
                                 unpaid_leave_days, unpaid_leave_amount,
                                 tax, sss_contribution, pagibig_contribution, philhealth_contribution, 
                                 cash_advance_deduction, cash_advance_manual_deduction, laptop_loan_deduction, other_deductions,
                                 gross_pay, total_deductions, net_pay, status, notes) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $types = 'isss' . str_repeat('d', 23) . 'ss';
    $stmt->bind_param($types, 
        $employee_id, $employee_name, $pay_period_start, $pay_period_end,
        $basic_salary, $overtime_hours, $overtime_rate, $overtime_pay, $bonus,
        $clothing_allowance, $travel_allowance, $salary_adjustment,
        $late_deduction, $absence_deduction,
        $leaveImpact['days'], $leaveImpact['amount'],
        $tax, $sss_contribution, $pagibig_contribution, $philhealth_contribution,
        $cash_advance_deduction, $cash_advance_manual_deduction, $laptop_loan_deduction, $other_deductions,
        $gross_pay, $total_deductions, $net_pay, $status, $notes
    );
    
    if ($stmt->execute()) {
        $payroll_id = $conn->insert_id;
        syncPayrollCashAdvanceRequests($conn, $payroll_id);
        $afterRow = null;
        $afterStmt = $conn->prepare("SELECT * FROM payroll WHERE id = ? LIMIT 1");
        if ($afterStmt) {
            $afterStmt->bind_param('i', $payroll_id);
            $afterStmt->execute();
            $afterRow = $afterStmt->get_result()->fetch_assoc();
            $afterStmt->close();
        }
        
        // Log activity
        if ($user_id = checkAuthentication()) {
        releaseSessionLock();
            logActivity($conn, $user_id, 'create_payroll', "Created payroll for: $employee_name", 'payroll_management');
            logAuditTrail($conn, $user_id, 'payroll', $payroll_id, 'create', null, $afterRow, basename(__FILE__));
        }
        
        sendResponse(true, [
            'payroll_id' => $payroll_id,
            'gross_pay' => floatval($afterRow['gross_pay'] ?? $gross_pay),
            'total_deductions' => floatval($afterRow['total_deductions'] ?? $total_deductions),
            'net_pay' => floatval($afterRow['net_pay'] ?? $net_pay),
            'unpaid_leave' => [
                'days' => $leaveImpact['days'],
                'amount' => $leaveImpact['amount'],
                'daily_rate' => $leaveImpact['daily_rate'],
                'items' => $leaveImpact['items'],
            ],
        ], 'Payroll record created successfully', 201);
    } else {
        error_log($conn->error);
        sendError('Failed to create payroll record.', 500);
    }
}

/**
 * PUT - Update payroll record
 */
function handlePut($conn) {
    $data = getJSONInput();

    if (!array_key_exists('cash_advance_manual_deduction', $data) && array_key_exists('cash_advance_deduction', $data)) {
        $data['cash_advance_manual_deduction'] = $data['cash_advance_deduction'];
    }
    unset($data['cash_advance_deduction']);

    if (isset($data['ids']) && is_array($data['ids'])) {
        handleBulkStatusUpdate($conn, $data);
    }
    
    if (!isset($data['id'])) {
        sendError('Payroll ID is required', 400);
    }
    
    $payroll_id = intval($data['id']);
    
    // Check if payroll exists
    $check_sql = "SELECT id FROM payroll WHERE id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $payroll_id);
    $check_stmt->execute();
    
    if ($check_stmt->get_result()->num_rows === 0) {
        sendError('Payroll record not found', 404);
    }
    $check_stmt->close();
    
    // Get current values
    $current_sql = "SELECT * FROM payroll WHERE id = ?";
    $current_stmt = $conn->prepare($current_sql);
    $current_stmt->bind_param('i', $payroll_id);
    $current_stmt->execute();
    $current = $current_stmt->get_result()->fetch_assoc();
    $current_stmt->close();

    // Archive and restore are status-only operations. Handle them before the
    // normal payroll recalculation path, which can add computed fields to $data
    // and accidentally make an archive request look like a payroll edit.
    $statusOnlyRequest = isset($data['status'])
        && count(array_diff(array_keys($data), ['id', 'status'])) === 0;
    $currentStatus = strtolower((string)($current['status'] ?? 'draft'));
    $requestedStatus = isset($data['status'])
        ? normalizePayrollStatus($data['status'], $currentStatus, true)
        : $currentStatus;
    $isArchiveTransition = $statusOnlyRequest && $requestedStatus === 'archived' && $currentStatus !== 'archived';
    $isRestoreTransition = $statusOnlyRequest && $currentStatus === 'archived' && $requestedStatus === 'paid';
    $isMarkPaidTransition = $statusOnlyRequest && $currentStatus !== 'paid' && $currentStatus !== 'archived' && $requestedStatus === 'paid';
    $isRevertPaidTransition = $statusOnlyRequest && $currentStatus === 'paid' && $requestedStatus === 'approved';

    if ($statusOnlyRequest && $currentStatus === 'archived' && $requestedStatus === 'archived') {
        sendResponse(true, ['status' => 'archived'], 'Payroll record is already archived.');
    }
    if ($statusOnlyRequest && $currentStatus === 'archived' && !$isRestoreTransition) {
        sendError('Archived payroll records can only be restored to paid status.', 400);
    }
    if ($isArchiveTransition && $currentStatus !== 'paid') {
        sendError('Only paid payroll records can be archived.', 400);
    }

    if ($isArchiveTransition || $isRestoreTransition || $isMarkPaidTransition || $isRevertPaidTransition) {
        $statusStmt = $conn->prepare("UPDATE payroll SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN NOW() WHEN ? = 'paid' AND status = 'archived' THEN NULL ELSE archived_at END WHERE id = ?");
        if (!$statusStmt) sendError('Failed to prepare payroll archive update.', 500);
        $statusStmt->bind_param('sssi', $requestedStatus, $requestedStatus, $requestedStatus, $payroll_id);
        if (!$statusStmt->execute()) {
            error_log($conn->error);
            sendError('Failed to update payroll archive status.', 500);
        }
        $statusStmt->close();

        $afterStmt = $conn->prepare('SELECT * FROM payroll WHERE id = ? LIMIT 1');
        $after = null;
        if ($afterStmt) {
            $afterStmt->bind_param('i', $payroll_id);
            $afterStmt->execute();
            $after = $afterStmt->get_result()->fetch_assoc();
            $afterStmt->close();
        }

        if ($isMarkPaidTransition) {
            syncPayrollCashAdvanceRequests($conn, $payroll_id);
        }

        if ($userId = checkAuthentication()) {
            releaseSessionLock();
            $action = $isArchiveTransition ? 'archive_payroll' : ($isRestoreTransition ? 'restore_payroll' : ($isRevertPaidTransition ? 'revert_paid_payroll' : 'release_payroll'));
            $description = $isArchiveTransition
                ? "Archived payroll ID: {$payroll_id}"
                : ($isRestoreTransition
                    ? "Restored payroll ID: {$payroll_id} as paid"
                    : ($isRevertPaidTransition
                        ? "Reverted payroll ID: {$payroll_id} from paid to approved"
                        : "Released payslip and marked payroll ID: {$payroll_id} as paid"));
            logActivity($conn, $userId, $action, $description, 'payroll_management');
            logAuditTrail($conn, $userId, 'payroll', $payroll_id, 'update', $current, $after, basename(__FILE__));
        }

        $responseData = ['status' => $requestedStatus];
        $responseMessage = $isArchiveTransition
            ? 'Payroll record archived successfully.'
            : ($isRestoreTransition
                ? 'Payroll record restored as paid successfully.'
                : ($isRevertPaidTransition
                    ? 'Payroll status reverted to approved successfully.'
                    : 'Payslip released and payroll record marked as paid successfully.'));
        if ($isMarkPaidTransition) {
            sendResponseAndContinue(true, $responseData, $responseMessage, 200, function () use ($conn, $payroll_id) {
                sendPayslipReleaseEmails($conn, [$payroll_id]);
            });
        }
        sendResponse(true, $responseData, $responseMessage);
    }

    // Auto-calculate government deductions from settings when values are empty/zero.
    // Tables are monthly bases: resolve the employee's monthly salary even
    // though the stored period basic is semi-monthly.
    $govEligibility = null;
    $govMonthlyBase = floatval($current['basic_salary'] ?? 0);
    if (!empty($current['employee_id'])) {
        $empStmt = $conn->prepare("SELECT salary, sss_number, pagibig_number, philhealth_number, tin_number FROM employees WHERE employee_id = ? LIMIT 1");
        if ($empStmt) {
            $empStmt->bind_param('i', $current['employee_id']);
            $empStmt->execute();
            $empRow = $empStmt->get_result()->fetch_assoc();
            $empStmt->close();
            $govEligibility = buildGovEligibilityFromEmployee($empRow);
            if ($empRow && floatval($empRow['salary'] ?? 0) > 0) {
                $govMonthlyBase = floatval($empRow['salary']);
            }
        }
    }

    $govDefaults = computeGovernmentDeductionsFromTypes($conn, $govMonthlyBase, $govEligibility);
    foreach ($govDefaults as $field => $amount) {
        $incoming = isset($data[$field]) ? floatval($data[$field]) : floatval($current[$field] ?? 0);
        if ($incoming <= 0) {
            $data[$field] = $amount;
        }
    }

    $currentStatus = strtolower((string)($current['status'] ?? 'draft'));
    $nextStatus = isset($data['status'])
        ? normalizePayrollStatus($data['status'], $currentStatus, true)
        : $currentStatus;
    $hasNonStatusUpdates = count(array_diff(array_keys($data), ['id', 'status'])) > 0;

    if ($currentStatus === 'archived') {
        if ($hasNonStatusUpdates) {
            sendError('Archived payroll records cannot be modified.', 400);
        }

        if ($nextStatus === 'approved') {
            // Allow restoring archived payroll records back to active scope.
        } elseif ($nextStatus !== 'archived') {
            sendError('Archived payroll records can only be restored to paid status.', 400);
        } else {
            sendResponse(true, [
                'gross_pay' => floatval($current['gross_pay'] ?? 0),
                'total_deductions' => floatval($current['total_deductions'] ?? 0),
                'net_pay' => floatval($current['net_pay'] ?? 0)
            ], 'Payroll record is already archived.');
        }

    }

    if ($nextStatus === 'archived' && $hasNonStatusUpdates) {
        sendError('Archive payroll records separately from other updates.', 400);
    }

    $payPeriodStart = isset($data['pay_period_start']) ? $data['pay_period_start'] : $current['pay_period_start'];
    $payPeriodEnd = isset($data['pay_period_end']) ? $data['pay_period_end'] : $current['pay_period_end'];
    validatePayrollPeriodDates($payPeriodStart, $payPeriodEnd);
    
    // Use new values or keep current (null-coalesce)
    $v = function($field) use ($data, $current) {
        return isset($data[$field]) ? floatval($data[$field]) : floatval($current[$field]);
    };
    
    $ot_hours = $v('overtime_hours');
    $ot_rate = $v('overtime_rate');
    $ot_pay = $ot_hours * $ot_rate;
    $bonus_amt = $v('bonus');
    
    // Allowances
    $clothing = $v('clothing_allowance');
    $travel = $v('travel_allowance');
    $adj = $v('salary_adjustment');
    
    // Attendance deductions
    $late = $v('late_deduction');
    $absence = $v('absence_deduction');

    // Same auto-fill convention as create: empty absence picks up approved
    // unpaid leaves overlapping the period; manual values are respected.
    $leaveImpact = computeUnpaidLeaveImpact($conn, intval($current['employee_id'] ?? 0), $payPeriodStart, $payPeriodEnd, $govMonthlyBase);
    if ($absence <= 0 && $leaveImpact['amount'] > 0) {
        $absence = $leaveImpact['amount'];
        $data['absence_deduction'] = $absence;
    }
    
    // Gross — bonus excluded per client requirement
    $gross_pay = $current['basic_salary'] + $ot_pay + $clothing + $travel + $adj - $late - $absence;
    
    // Government contributions
    $tax_amt = $v('tax');
    $sss_amt = $v('sss_contribution');
    $pagibig_amt = $v('pagibig_contribution');
    $philhealth_amt = $v('philhealth_contribution');
    
    // Loan deductions
    $ca_amt = isset($data['cash_advance_manual_deduction'])
        ? floatval($data['cash_advance_manual_deduction'])
        : floatval($current['cash_advance_manual_deduction'] ?? ($current['cash_advance_deduction'] ?? 0));
    $laptop_amt = $v('laptop_loan_deduction');
    $other_amt = $v('other_deductions');
    
    $total_deductions = $tax_amt + $sss_amt + $pagibig_amt + $philhealth_amt + $ca_amt + $laptop_amt + $other_amt;
    $net_pay = max(0, $gross_pay - $total_deductions + $bonus_amt);
    
    $updates = [];
    $params = [];
    $types = '';
    
    $allowed_fields = ['pay_period_start', 'pay_period_end', 'overtime_hours', 'overtime_rate', 
                       'bonus', 'clothing_allowance', 'travel_allowance', 'salary_adjustment',
                       'late_deduction', 'absence_deduction',
                       'tax', 'sss_contribution', 'pagibig_contribution', 
                       'philhealth_contribution', 'cash_advance_manual_deduction', 'laptop_loan_deduction',
                       'other_deductions', 'status', 'notes'];
    $numeric_fields = [
        'overtime_hours',
        'overtime_rate',
        'bonus',
        'clothing_allowance',
        'travel_allowance',
        'salary_adjustment',
        'late_deduction',
        'absence_deduction',
        'tax',
        'sss_contribution',
        'pagibig_contribution',
        'philhealth_contribution',
        'cash_advance_manual_deduction',
        'laptop_loan_deduction',
        'other_deductions'
    ];
    
    foreach ($allowed_fields as $field) {
        if (isset($data[$field])) {
            $updates[] = "$field = ?";
            
            if ($field === 'status') {
                $params[] = $nextStatus;
                $types .= 's';
            } elseif (in_array($field, $numeric_fields, true)) {
                $params[] = floatval($data[$field]);
                $types .= 'd';
            } else {
                $params[] = sanitizeInput($data[$field]);
                $types .= 's';
            }
        }
    }
    
    // Always update calculated fields
    $updates[] = "overtime_pay = ?";
    $updates[] = "gross_pay = ?";
    $updates[] = "total_deductions = ?";
    $updates[] = "net_pay = ?";
    $params[] = $ot_pay;
    $params[] = $gross_pay;
    $params[] = $total_deductions;
    $params[] = $net_pay;
    $types .= 'dddd';

    // Informational unpaid-leave breakdown for this period.
    $updates[] = "unpaid_leave_days = ?";
    $updates[] = "unpaid_leave_amount = ?";
    $params[] = $leaveImpact['days'];
    $params[] = $leaveImpact['amount'];
    $types .= 'dd';
    
    $params[] = $payroll_id;
    $types .= 'i';
    
    $sql = "UPDATE payroll SET " . implode(', ', $updates) . " WHERE id = ?";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);
    
    if ($stmt->execute()) {
        syncPayrollCashAdvanceRequests($conn, $payroll_id);
        $after = null;
        $afterStmt = $conn->prepare("SELECT * FROM payroll WHERE id = ? LIMIT 1");
        if ($afterStmt) {
            $afterStmt->bind_param('i', $payroll_id);
            $afterStmt->execute();
            $after = $afterStmt->get_result()->fetch_assoc();
            $afterStmt->close();
        }

        // Log activity
        if ($user_id = checkAuthentication()) {
        releaseSessionLock();
            logActivity($conn, $user_id, 'update_payroll', "Updated payroll ID: $payroll_id", 'payroll_management');
            logAuditTrail($conn, $user_id, 'payroll', $payroll_id, 'update', $current, $after, basename(__FILE__));
        }

        $responseData = [
            'gross_pay' => floatval($after['gross_pay'] ?? $gross_pay),
            'total_deductions' => floatval($after['total_deductions'] ?? $total_deductions),
            'net_pay' => floatval($after['net_pay'] ?? $net_pay),
            'unpaid_leave' => [
                'days' => $leaveImpact['days'],
                'amount' => $leaveImpact['amount'],
                'daily_rate' => $leaveImpact['daily_rate'],
                'items' => $leaveImpact['items'],
            ],
        ];

        if (isset($data['status']) && $nextStatus === 'approved') {
            sendResponseAndContinue(true, $responseData, 'Payroll record updated successfully', 200, function () use ($conn, $payroll_id) {
                sendPayslipReleaseEmails($conn, [$payroll_id]);
            });
        }

        sendResponse(true, $responseData, 'Payroll record updated successfully');
    } else {
        error_log($conn->error);
        sendError('Failed to update payroll record.', 500);
    }
}

/**
 * Unpaid-leave impact for an employee over a pay period.
 *
 * Sums Monday-Friday working days of APPROVED leave requests whose type is configured as
 * unpaid (leave_type.is_paid = 0; falls back to the 'unpaid' key when the
 * leave_type table is absent), clipped to the period. Amount = days × daily
 * rate, using the shared payrollPeriodDailyRate() — the same figure printed
 * on payslips.
 *
 * @return array{days: float, amount: float, daily_rate: float, items: array}
 */
function payrollCountWorkingDays($startDate, $endDate) {
    try {
        $start = new DateTime(substr((string)$startDate, 0, 10));
        $end = new DateTime(substr((string)$endDate, 0, 10));
    } catch (Exception $e) {
        return 0.0;
    }
    if ($end < $start) return 0.0;

    $days = 0;
    $cursor = clone $start;
    while ($cursor <= $end) {
        $weekday = intval($cursor->format('N'));
        if ($weekday >= 1 && $weekday <= 5) $days++;
        $cursor->modify('+1 day');
    }
    return (float)$days;
}

function computeUnpaidLeaveImpact($conn, $employeeId, $periodStart, $periodEnd, $monthlySalary) {
    $result = ['days' => 0.0, 'amount' => 0.0, 'daily_rate' => 0.0, 'items' => []];
    $employeeId = intval($employeeId);
    $monthlySalary = max(0.0, (float)$monthlySalary);
    $pStart = substr(trim((string)$periodStart), 0, 10);
    $pEnd = substr(trim((string)$periodEnd), 0, 10);
    if ($employeeId <= 0 || $monthlySalary <= 0) return $result;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $pStart) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $pEnd)) return $result;
    $pStartTs = strtotime($pStart);
    $pEndTs = strtotime($pEnd);
    if ($pStartTs === false || $pEndTs === false || $pEndTs < $pStartTs) return $result;
    if (!payrollTableExists($conn, 'leave_request')) return $result;

    $result['daily_rate'] = payrollPeriodDailyRate($monthlySalary, $pStart, $pEnd);

    $hasLeaveType = payrollTableExists($conn, 'leave_type');
    if ($hasLeaveType) {
        $sql = "SELECT lr.leave_request_id, lr.leave_type, lr.start_date, lr.end_date,
                       COALESCE(lt.type_name, lr.leave_type) AS type_name
                FROM leave_request lr
                LEFT JOIN leave_type lt ON LOWER(TRIM(lt.type_key)) = LOWER(TRIM(lr.leave_type))
                WHERE lr.employee_id = ?
                  AND lr.status = 'approved'
                  AND lr.start_date <= ?
                  AND lr.end_date >= ?
                  AND COALESCE(lt.is_paid, 1) = 0
                ORDER BY lr.start_date ASC";
    } else {
        $sql = "SELECT leave_request_id, leave_type, start_date, end_date,
                       leave_type AS type_name
                FROM leave_request
                WHERE employee_id = ?
                  AND status = 'approved'
                  AND start_date <= ?
                  AND end_date >= ?
                  AND LOWER(TRIM(leave_type)) = 'unpaid'
                ORDER BY start_date ASC";
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) return $result;
    $stmt->bind_param('iss', $employeeId, $pEnd, $pStart);
    $stmt->execute();
    $res = $stmt->get_result();

    $totalDays = 0.0;
    $items = [];
    while ($row = $res->fetch_assoc()) {
        $rStartTs = strtotime(substr((string)($row['start_date'] ?? ''), 0, 10));
        $rEndTs = strtotime(substr((string)($row['end_date'] ?? ''), 0, 10));
        if ($rStartTs === false || $rEndTs === false) continue;
        $overlapStart = max($rStartTs, $pStartTs);
        $overlapEnd = min($rEndTs, $pEndTs);
        if ($overlapEnd < $overlapStart) continue;
        $days = payrollCountWorkingDays(date('Y-m-d', $overlapStart), date('Y-m-d', $overlapEnd));
        if ($days <= 0) continue;
        $totalDays += $days;
        $items[] = [
            'leave_request_id' => intval($row['leave_request_id'] ?? 0),
            'leave_type' => (string)($row['leave_type'] ?? ''),
            'type_name' => (string)($row['type_name'] ?? $row['leave_type'] ?? ''),
            'days' => $days,
        ];
    }
    $stmt->close();

    $result['days'] = round($totalDays, 2);
    $result['amount'] = round($totalDays * $result['daily_rate'], 2);
    $result['items'] = $items;
    return $result;
}

/**
 * GET ?action=leave_impact — leave figures + unpaid-leave impact preview for
 * the payroll form. Params: employee_id, pay_period_start, pay_period_end.
 */
function handleLeaveImpact($conn) {
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $employeeId = intval($_GET['employee_id'] ?? 0);
    if ($employeeId <= 0) sendError('Employee is required', 400);
    if ($role === 'staff') {
        $selfEmployeeId = getCurrentSessionEmployeeId($conn);
        if ($selfEmployeeId <= 0 || $selfEmployeeId !== $employeeId) {
            sendError('Your account is not linked to an employee record.', 403);
        }
    }

    $pStart = trim((string)($_GET['pay_period_start'] ?? ''));
    $pEnd = trim((string)($_GET['pay_period_end'] ?? ''));
    validatePayrollPeriodDates($pStart, $pEnd);

    $empStmt = $conn->prepare("SELECT salary FROM employees WHERE employee_id = ? LIMIT 1");
    if (!$empStmt) sendError('Failed to load employee', 500);
    $empStmt->bind_param('i', $employeeId);
    $empStmt->execute();
    $empRow = $empStmt->get_result()->fetch_assoc();
    $empStmt->close();
    if (!$empRow) sendError('Employee not found', 404);
    $basicSalary = max(0.0, (float)($empRow['salary'] ?? 0));

    $impact = computeUnpaidLeaveImpact($conn, $employeeId, $pStart, $pEnd, $basicSalary);

    // Current-year balances with configured figures, so the payroll form can
    // show every leave type's entitlement beside the deduction preview.
    $year = intval(substr($pStart, 0, 4));
    $balances = [];
    if (payrollTableExists($conn, 'leave_balance')) {
        $bSql = "SELECT lb.leave_type,
                        COALESCE(lt.type_name, lb.leave_type) AS type_name,
                        lb.total_days, lb.used_days, lb.remaining_days,
                        lt.default_days AS leave_type_default_days,
                        lt.is_paid AS leave_type_is_paid
                 FROM leave_balance lb
                 LEFT JOIN leave_type lt ON LOWER(TRIM(lt.type_key)) = LOWER(TRIM(lb.leave_type))
                 WHERE lb.employee_id = ? AND lb.year = ?
                 ORDER BY lb.leave_type ASC";
        // LEFT JOIN against a possibly-missing table errors; guard first.
        if (!payrollTableExists($conn, 'leave_type')) {
            $bSql = "SELECT leave_type, leave_type AS type_name, total_days, used_days, remaining_days,
                            NULL AS leave_type_default_days, 1 AS leave_type_is_paid
                     FROM leave_balance
                     WHERE employee_id = ? AND year = ?
                     ORDER BY leave_type ASC";
        }
        $bStmt = $conn->prepare($bSql);
        if ($bStmt) {
            $bStmt->bind_param('ii', $employeeId, $year);
            $bStmt->execute();
            $bRes = $bStmt->get_result();
            while ($bRow = $bRes->fetch_assoc()) {
                $balances[] = [
                    'leave_type' => (string)($bRow['leave_type'] ?? ''),
                    'type_name' => (string)($bRow['type_name'] ?? $bRow['leave_type'] ?? ''),
                    'total_days' => floatval($bRow['total_days'] ?? 0),
                    'used_days' => floatval($bRow['used_days'] ?? 0),
                    'remaining_days' => floatval($bRow['remaining_days'] ?? 0),
                    'default_days' => $bRow['leave_type_default_days'] === null ? null : floatval($bRow['leave_type_default_days']),
                    'is_paid' => isset($bRow['leave_type_is_paid']) ? intval($bRow['leave_type_is_paid']) : 1,
                ];
            }
            $bStmt->close();
        }
    }

    sendResponse(true, [
        'employee_id' => $employeeId,
        'basic_salary' => $basicSalary,
        'daily_rate' => $impact['daily_rate'],
        'unpaid_leave_days' => $impact['days'],
        'unpaid_leave_amount' => $impact['amount'],
        'unpaid_leave_items' => $impact['items'],
        'balances' => $balances,
    ], 'Leave impact calculated successfully');
}
function handleDelete($conn) {
    $payroll_id = $_GET['id'] ?? null;
    
    if (!$payroll_id) {
        sendError('Payroll ID is required', 400);
    }
    
    $payroll_id = intval($payroll_id);
    
    // Only allow deletion of draft or archived records
    $check_sql = "SELECT * FROM payroll WHERE id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $payroll_id);
    $check_stmt->execute();
    $result = $check_stmt->get_result();
    
    if ($result->num_rows === 0) {
        sendError('Payroll record not found', 404);
    }
    
    $record = $result->fetch_assoc();
    $check_stmt->close();
    if ($record['status'] !== 'draft' && $record['status'] !== 'archived') {
        sendError('Only draft or archived payroll records can be deleted', 400);
    }
    
    $sql = "DELETE FROM payroll WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $payroll_id);
    
    if ($stmt->execute()) {
        // Log activity
        if ($user_id = checkAuthentication()) {
        releaseSessionLock();
            logActivity($conn, $user_id, 'delete_payroll', "Deleted payroll ID: $payroll_id", 'payroll_management');
            logAuditTrail($conn, $user_id, 'payroll', $payroll_id, 'delete', $record, null, basename(__FILE__));
        }
        
        sendResponse(true, null, 'Payroll record deleted successfully');
    } else {
        error_log($conn->error);
        sendError('Failed to delete payroll record.', 500);
    }
}

closeDBConnection($conn);
?>
