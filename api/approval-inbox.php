<?php
/**
 * Approval Inbox API (Phase 1 MVP)
 * Unified manager/admin approval queue.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
if ($method !== 'GET') {
    sendError('Method not allowed', 405);
}

requireFeatureAccess('approval_inbox', ['admin', 'manager']);

$conn = getDBConnection();
ensurePhaseOneTables($conn);

$role = strtolower(trim((string)($_SESSION['role'] ?? '')));
if (!in_array($role, ['manager', 'admin'], true)) {
    sendError('Forbidden', 403);
}

$typeFilter = strtolower(trim((string)($_GET['type'] ?? 'all')));
$allowedTypes = ['all', 'leave', 'overtime'];
if (!in_array($typeFilter, $allowedTypes, true)) {
    sendError('Invalid type filter', 400);
}

function addApprovalItem(&$items, $type, $id, $title, $subtitle, $submittedAt, $priority, $link, $meta = []) {
    $items[] = [
        'type' => $type,
        'id' => $id,
        'title' => $title,
        'subtitle' => $subtitle,
        'submitted_at' => $submittedAt,
        'priority' => $priority,
        'link' => $link,
        'meta' => $meta,
    ];
}

$items = [];

if ($typeFilter === 'all' || $typeFilter === 'leave') {
    $leaveSql = "SELECT lr.leave_request_id,
                        lr.employee_id,
                        lr.leave_type,
                        lr.start_date,
                        lr.end_date,
                        lr.reason,
                        lr.created_at,
                        CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
                        COALESCE(
                            (SELECT LOWER(u.role) FROM users u WHERE u.employee_id = lr.employee_id ORDER BY u.id DESC LIMIT 1),
                            LOWER(TRIM(e.position))
                        ) AS employee_role
                 FROM leave_request lr
                 LEFT JOIN employees e ON e.employee_id = lr.employee_id
                 WHERE LOWER(lr.status) = 'pending'
                 ORDER BY lr.created_at DESC
                 LIMIT 300";
    $leaveResult = $conn->query($leaveSql);
    if ($leaveResult) {
        while ($row = $leaveResult->fetch_assoc()) {
            $createdAt = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
            $employeeName = trim((string)($row['employee_name'] ?? ''));
            if ($employeeName === '') $employeeName = 'Employee #' . intval($row['employee_id'] ?? 0);
            $range = (string)($row['start_date'] ?? '');
            if (!empty($row['end_date']) && $row['end_date'] !== $row['start_date']) {
                $range .= ' to ' . $row['end_date'];
            }

            addApprovalItem(
                $items,
                'leave',
                intval($row['leave_request_id']),
                $employeeName . ' requested ' . strtoupper((string)$row['leave_type']) . ' leave',
                $range,
                $createdAt,
                'medium',
                '/leave-requests?request_id=' . intval($row['leave_request_id']),
                [
                    'employee_id' => intval($row['employee_id']),
                    'leave_type' => (string)($row['leave_type'] ?? ''),
                    'employee_role' => (string)($row['employee_role'] ?? ''),
                ]
            );
        }
    }
}

if ($typeFilter === 'all' || $typeFilter === 'overtime') {
    $otSql = "SELECT ot.overtime_request_id,
                     ot.employee_id,
                     ot.work_date,
                     ot.hours_requested,
                     ot.reason,
                     ot.created_at,
                     CONCAT(e.first_name, ' ', e.last_name) AS employee_name
              FROM overtime_request ot
              LEFT JOIN employees e ON e.employee_id = ot.employee_id
              WHERE LOWER(ot.status) = 'submitted'
              ORDER BY ot.created_at DESC
              LIMIT 300";
    $otResult = $conn->query($otSql);
    if ($otResult) {
        while ($row = $otResult->fetch_assoc()) {
            $createdAt = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
            $employeeName = trim((string)($row['employee_name'] ?? ''));
            if ($employeeName === '') $employeeName = 'Employee #' . intval($row['employee_id'] ?? 0);
            $hours = number_format((float)($row['hours_requested'] ?? 0), 2);

            addApprovalItem(
                $items,
                'overtime',
                intval($row['overtime_request_id']),
                $employeeName . ' requested overtime (' . $hours . ' hrs)',
                'Work date: ' . (string)($row['work_date'] ?? ''),
                $createdAt,
                floatval($row['hours_requested'] ?? 0) >= 6 ? 'high' : 'medium',
                '/overtime-requests?request_id=' . intval($row['overtime_request_id']),
                [
                    'employee_id' => intval($row['employee_id']),
                    'hours_requested' => floatval($row['hours_requested'] ?? 0),
                ]
            );
        }
    }
}

if (!empty($items)) {
    usort($items, function ($a, $b) {
        $aSubmitted = strtotime((string)($a['submitted_at'] ?? '')) ?: 0;
        $bSubmitted = strtotime((string)($b['submitted_at'] ?? '')) ?: 0;
        return $bSubmitted <=> $aSubmitted;
    });
}

$summary = [
    'total' => count($items),
    'by_type' => [
        'leave' => 0,
        'overtime' => 0,
    ],
];

foreach ($items as $item) {
    $type = strtolower((string)($item['type'] ?? ''));
    if (isset($summary['by_type'][$type])) {
        $summary['by_type'][$type] += 1;
    }
}

sendResponse(true, [
    'summary' => $summary,
    'items' => $items,
], 'Approval inbox retrieved successfully');

closeDBConnection($conn);
?>
