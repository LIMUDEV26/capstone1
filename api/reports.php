<?php
/**
 * Centralized reports API for admin and manager users.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensurePhaseOneTables($conn);

if ($method !== 'GET') {
    sendError('Method not allowed', 405);
}

$role = requireRole(['admin', 'manager']);
$action = strtolower(trim((string)($_GET['action'] ?? 'list')));

switch ($action) {
    case 'list':
        handleListReports($conn, $role);
        break;
    case 'generate':
        handleGenerateReport($conn, $role);
        break;
    default:
        sendError('Invalid action', 400);
}

function getReportCatalog() {
    return [
        [
            'key' => 'executive_overview',
            'title' => 'Executive Overview',
            'description' => 'A cross-module snapshot of operations, workload, compliance, and delivery status.',
        ],
        [
            'key' => 'project_delivery',
            'title' => 'Project Delivery',
            'description' => 'Project status, task progress, overdue work, and completion report dispatch summary.',
        ],
        [
            'key' => 'payroll_attendance',
            'title' => 'Payroll and Attendance',
            'description' => 'Payroll totals, deductions, attendance activity, overtime, and branch payroll health.',
        ],
        [
            'key' => 'documents_compliance',
            'title' => 'Documents and Compliance',
            'description' => 'Document intake, submission flow, completion rates, and compliance tracking activity.',
        ],
        [
            'key' => 'audit_activity',
            'title' => 'Audit and Activity',
            'description' => 'Activity logs, audit trail changes, actor distribution, and exception visibility.',
        ],
    ];
}

function getReportCatalogMap() {
    $map = [];
    foreach (getReportCatalog() as $item) {
        $map[$item['key']] = $item;
    }
    return $map;
}

function reportTableExists($conn, $table) {
    $dbName = DB_NAME;
    $stmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
         LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ss', $dbName, $table);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function reportQueryRows($conn, $sql, $types = '', $params = []) {
    if ($types !== '' && !empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) {
            error_log($conn->error);
            sendError('Failed to prepare report query.', 500);
        }

        $bindParams = [$types];
        foreach (array_keys($params) as $index) {
            $bindParams[] = &$params[$index];
        }

        call_user_func_array([$stmt, 'bind_param'], $bindParams);

        if (!$stmt->execute()) {
            $message = $stmt->error;
            $stmt->close();
            sendError('Failed to execute report query: ' . $message, 500);
        }

        $result = $stmt->get_result();
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = $row;
        }
        $stmt->close();
        return $rows;
    }

    $result = $conn->query($sql);
    if (!$result) {
        error_log($conn->error);
        sendError('Failed to execute report query.', 500);
    }

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $result->close();
    return $rows;
}

function reportQueryRow($conn, $sql, $types = '', $params = []) {
    $rows = reportQueryRows($conn, $sql, $types, $params);
    return $rows[0] ?? [];
}

function reportMetric($label, $value, $hint = '', $tone = 'neutral') {
    return [
        'label' => $label,
        'value' => $value,
        'hint' => $hint,
        'tone' => $tone,
    ];
}

function reportMetricsSection($title, $items, $description = '') {
    return [
        'type' => 'metrics',
        'title' => $title,
        'description' => $description,
        'items' => array_values($items),
    ];
}

function reportTableSection($title, $columns, $rows, $description = '') {
    return [
        'type' => 'table',
        'title' => $title,
        'description' => $description,
        'columns' => array_values($columns),
        'rows' => array_values($rows),
    ];
}

function reportNumber($value, $decimals = 0) {
    return number_format((float)$value, $decimals, '.', ',');
}

function reportCurrency($value) {
    return 'PHP ' . number_format((float)$value, 2, '.', ',');
}

function reportPercent($value, $decimals = 1) {
    return number_format((float)$value, $decimals, '.', ',') . '%';
}

function sanitizeReportDate($value, $fieldName) {
    $date = trim((string)$value);
    if ($date === '') return '';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        sendError('Invalid ' . $fieldName . ' value. Use YYYY-MM-DD.', 400);
    }
    return $date;
}

function resolveReportScopeBranchId($conn, $role) {
    if ($role === 'admin') {
        $requested = intval($_GET['branch_id'] ?? 0);
        return max(0, $requested);
    }

    $sessionBranchId = intval($_SESSION['branch_id'] ?? 0);
    if ($sessionBranchId > 0) {
        return $sessionBranchId;
    }

    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) {
        return 0;
    }

    $stmt = $conn->prepare("SELECT branch_id FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) {
        return 0;
    }
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

function getReportBranchOptions($conn, $role, $scopeBranchId) {
    if (!reportTableExists($conn, 'branches')) {
        return [];
    }

    if ($role === 'admin') {
        $rows = reportQueryRows(
            $conn,
            "SELECT branch_id, branch_name
             FROM branches
             ORDER BY branch_name ASC"
        );
        return array_map(function ($row) {
            return [
                'branch_id' => intval($row['branch_id'] ?? 0),
                'branch_name' => (string)($row['branch_name'] ?? 'Unnamed Branch'),
            ];
        }, $rows);
    }

    if ($scopeBranchId <= 0) {
        return [];
    }

    $row = reportQueryRow(
        $conn,
        "SELECT branch_id, branch_name
         FROM branches
         WHERE branch_id = ?
         LIMIT 1",
        'i',
        [$scopeBranchId]
    );

    if (empty($row)) {
        return [];
    }

    return [[
        'branch_id' => intval($row['branch_id'] ?? 0),
        'branch_name' => (string)($row['branch_name'] ?? 'Assigned Branch'),
    ]];
}

function resolveReportBranchLabel($branches, $branchId) {
    $target = intval($branchId);
    if ($target <= 0) return 'All branches';
    foreach ((array)$branches as $branch) {
        if (intval($branch['branch_id'] ?? 0) === $target) {
            return (string)($branch['branch_name'] ?? 'Selected branch');
        }
    }
    return 'Selected branch';
}

function getReportFilters($conn, $role) {
    $dateFrom = sanitizeReportDate($_GET['date_from'] ?? '', 'date_from');
    $dateTo = sanitizeReportDate($_GET['date_to'] ?? '', 'date_to');
    if ($dateFrom !== '' && $dateTo !== '' && $dateFrom > $dateTo) {
        sendError('date_from cannot be later than date_to.', 400);
    }

    $branchId = resolveReportScopeBranchId($conn, $role);
    $branches = getReportBranchOptions($conn, $role, $branchId);

    return [
        'date_from' => $dateFrom,
        'date_to' => $dateTo,
        'branch_id' => $branchId > 0 ? $branchId : null,
        'branch_label' => resolveReportBranchLabel($branches, $branchId),
        'scope_note' => $role === 'manager'
            ? 'Manager scope is applied to employee-based records using your assigned branch where available.'
            : 'Admin scope can cover all branches or a selected branch filter.',
        'role' => $role,
    ];
}

function appendDateRangeClause(&$conditions, &$types, &$params, $column, $dateFrom, $dateTo) {
    if ($dateFrom !== '') {
        $conditions[] = "DATE($column) >= ?";
        $types .= 's';
        $params[] = $dateFrom;
    }
    if ($dateTo !== '') {
        $conditions[] = "DATE($column) <= ?";
        $types .= 's';
        $params[] = $dateTo;
    }
}

function appendBranchClause(&$conditions, &$types, &$params, $branchColumn, $branchId) {
    $branchId = intval($branchId ?? 0);
    if ($branchId <= 0 || trim((string)$branchColumn) === '') {
        return;
    }
    $conditions[] = $branchColumn . ' = ?';
    $types .= 'i';
    $params[] = $branchId;
}

function fetchActivityCountsByDay($conn, $filters) {
    $conditions = [];
    $types = '';
    $params = [];
    appendDateRangeClause($conditions, $types, $params, 'al.created_at', $filters['date_from'], $filters['date_to']);
    appendBranchClause($conditions, $types, $params, 'u.branch_id', $filters['branch_id']);
    $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';

    $rows = reportQueryRows(
        $conn,
        "SELECT DATE(al.created_at) AS activity_date,
                COUNT(*) AS activity_count
         FROM activity_log al
         LEFT JOIN users u ON u.id = al.user_id
         $where
         GROUP BY DATE(al.created_at)
         ORDER BY activity_date DESC
         LIMIT 7",
        $types,
        $params
    );

    if (!reportTableExists($conn, 'audit_trail')) {
        return array_map(function ($row) {
            return [
                'activity_date' => (string)($row['activity_date'] ?? ''),
                'activity_count' => intval($row['activity_count'] ?? 0),
                'audit_count' => 0,
            ];
        }, $rows);
    }

    $auditConditions = [];
    $auditTypes = '';
    $auditParams = [];
    appendDateRangeClause($auditConditions, $auditTypes, $auditParams, 'a.created_at', $filters['date_from'], $filters['date_to']);
    appendBranchClause($auditConditions, $auditTypes, $auditParams, 'u.branch_id', $filters['branch_id']);
    $auditWhere = !empty($auditConditions) ? 'WHERE ' . implode(' AND ', $auditConditions) : '';

    $auditRows = reportQueryRows(
        $conn,
        "SELECT DATE(a.created_at) AS audit_date,
                COUNT(*) AS audit_count
         FROM audit_trail a
         LEFT JOIN users u ON u.id = a.user_id
         $auditWhere
         GROUP BY DATE(a.created_at)",
        $auditTypes,
        $auditParams
    );

    $auditMap = [];
    foreach ($auditRows as $auditRow) {
        $auditMap[(string)($auditRow['audit_date'] ?? '')] = intval($auditRow['audit_count'] ?? 0);
    }

    return array_map(function ($row) use ($auditMap) {
        $date = (string)($row['activity_date'] ?? '');
        return [
            'activity_date' => $date,
            'activity_count' => intval($row['activity_count'] ?? 0),
            'audit_count' => intval($auditMap[$date] ?? 0),
        ];
    }, $rows);
}

function fetchRequestOverviewSummary($conn, $filters) {
    $branchId = intval($filters['branch_id'] ?? 0);
    $dateFrom = (string)$filters['date_from'];
    $dateTo = (string)$filters['date_to'];

    $leaveConditions = [];
    $leaveTypes = '';
    $leaveParams = [];
    appendDateRangeClause($leaveConditions, $leaveTypes, $leaveParams, 'lr.created_at', $dateFrom, $dateTo);
    appendBranchClause($leaveConditions, $leaveTypes, $leaveParams, 'e.branch_id', $branchId);
    $leaveWhere = !empty($leaveConditions) ? 'WHERE ' . implode(' AND ', $leaveConditions) : '';
    $leave = reportQueryRows(
        $conn,
        "SELECT 'Leave Requests' AS module_name,
                lr.status AS status,
                COUNT(*) AS total_count,
                SUM(CASE WHEN lr.status = 'pending' THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN lr.status = 'approved' THEN 1 ELSE 0 END) AS closed_count,
                SUM(CASE WHEN lr.status = 'pending' AND lr.end_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_count
         FROM leave_request lr
         LEFT JOIN employees e ON e.employee_id = lr.employee_id
         $leaveWhere
         GROUP BY lr.status",
        $leaveTypes,
        $leaveParams
    );

    $otConditions = [];
    $otTypes = '';
    $otParams = [];
    appendDateRangeClause($otConditions, $otTypes, $otParams, 'ot.created_at', $dateFrom, $dateTo);
    appendBranchClause($otConditions, $otTypes, $otParams, 'e.branch_id', $branchId);
    $otWhere = !empty($otConditions) ? 'WHERE ' . implode(' AND ', $otConditions) : '';
    $overtime = reportQueryRows(
        $conn,
        "SELECT 'Overtime Requests' AS module_name,
                ot.status AS status,
                COUNT(*) AS total_count,
                SUM(CASE WHEN ot.status = 'submitted' THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN ot.status = 'approved' THEN 1 ELSE 0 END) AS closed_count,
                0 AS overdue_count
         FROM overtime_request ot
         LEFT JOIN employees e ON e.employee_id = ot.employee_id
         $otWhere
         GROUP BY ot.status",
        $otTypes,
        $otParams
    );

    $cashConditions = [];
    $cashTypes = '';
    $cashParams = [];
    appendDateRangeClause($cashConditions, $cashTypes, $cashParams, 'car.created_at', $dateFrom, $dateTo);
    appendBranchClause($cashConditions, $cashTypes, $cashParams, 'e.branch_id', $branchId);
    $cashWhere = !empty($cashConditions) ? 'WHERE ' . implode(' AND ', $cashConditions) : '';
    $cashAdvance = reportQueryRows(
        $conn,
        "SELECT 'Cash Advance' AS module_name,
                car.status AS status,
                COUNT(*) AS total_count,
                SUM(CASE WHEN car.status = 'submitted' THEN 1 ELSE 0 END) AS open_count,
                SUM(CASE WHEN car.status = 'approved' THEN 1 ELSE 0 END) AS closed_count,
                0 AS overdue_count
         FROM cash_advance_request car
         LEFT JOIN employees e ON e.employee_id = car.employee_id
         $cashWhere
         GROUP BY car.status",
        $cashTypes,
        $cashParams
    );

    $modules = [
        'Leave Requests' => ['rows' => $leave],
        'Overtime Requests' => ['rows' => $overtime],
        'Cash Advance' => ['rows' => $cashAdvance],
    ];

    $summaryRows = [];
    $statusRows = [];
    $totals = [
        'all_requests' => 0,
        'open_requests' => 0,
        'closed_requests' => 0,
    ];

    foreach ($modules as $moduleName => $meta) {
        $moduleTotal = 0;
        $moduleOpen = 0;
        $moduleClosed = 0;

        foreach ($meta['rows'] as $row) {
            $count = intval($row['total_count'] ?? 0);
            $moduleTotal += $count;
            $moduleOpen += intval($row['open_count'] ?? 0);
            $moduleClosed += intval($row['closed_count'] ?? 0);
            $statusRows[] = [
                'module_name' => $moduleName,
                'status' => (string)($row['status'] ?? 'unknown'),
                'count' => $count,
            ];
        }

        $summaryRows[] = [
            'module_name' => $moduleName,
            'total_requests' => $moduleTotal,
            'open_requests' => $moduleOpen,
            'closed_requests' => $moduleClosed,
        ];

        $totals['all_requests'] += $moduleTotal;
        $totals['open_requests'] += $moduleOpen;
        $totals['closed_requests'] += $moduleClosed;
    }

    return [
        'totals' => $totals,
        'summary_rows' => $summaryRows,
        'status_rows' => $statusRows,
    ];
}

function buildExecutiveOverviewReport($conn, $role, $filters) {
    $userConditions = [];
    $userTypes = '';
    $userParams = [];
    appendDateRangeClause($userConditions, $userTypes, $userParams, 'u.created_at', $filters['date_from'], $filters['date_to']);
    appendBranchClause($userConditions, $userTypes, $userParams, 'u.branch_id', $filters['branch_id']);
    $userWhere = !empty($userConditions) ? 'WHERE ' . implode(' AND ', $userConditions) : '';
    $userSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_users
         FROM users u
         $userWhere",
        $userTypes,
        $userParams
    );

    $projectConditions = [];
    $projectTypes = '';
    $projectParams = [];
    appendDateRangeClause($projectConditions, $projectTypes, $projectParams, 'p.created_at', $filters['date_from'], $filters['date_to']);
    $projectWhere = !empty($projectConditions) ? 'WHERE ' . implode(' AND ', $projectConditions) : '';
    $projectStatusRows = reportQueryRows(
        $conn,
        "SELECT p.status,
                COUNT(*) AS project_count,
                COALESCE(SUM(p.budget), 0) AS total_budget,
                COALESCE(SUM(p.actual_cost), 0) AS total_actual_cost
         FROM projects p
         $projectWhere
         GROUP BY p.status
         ORDER BY project_count DESC",
        $projectTypes,
        $projectParams
    );

    $projectTotals = [
        'total_projects' => 0,
        'completed_projects' => 0,
    ];
    foreach ($projectStatusRows as $row) {
        $count = intval($row['project_count'] ?? 0);
        $projectTotals['total_projects'] += $count;
        if ((string)($row['status'] ?? '') === 'completed') {
            $projectTotals['completed_projects'] += $count;
        }
    }

    $taskConditions = [];
    $taskTypes = '';
    $taskParams = [];
    appendDateRangeClause($taskConditions, $taskTypes, $taskParams, 't.created_at', $filters['date_from'], $filters['date_to']);
    $taskWhere = !empty($taskConditions) ? 'WHERE ' . implode(' AND ', $taskConditions) : '';
    $taskSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_tasks,
                SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) AS pending_tasks,
                SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_tasks,
                SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
                SUM(CASE WHEN t.status NOT IN ('completed', 'cancelled') AND t.due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_tasks
         FROM tasks t
         $taskWhere",
        $taskTypes,
        $taskParams
    );

    $payrollConditions = [];
    $payrollTypes = '';
    $payrollParams = [];
    appendDateRangeClause($payrollConditions, $payrollTypes, $payrollParams, 'p.pay_period_end', $filters['date_from'], $filters['date_to']);
    appendBranchClause($payrollConditions, $payrollTypes, $payrollParams, 'e.branch_id', $filters['branch_id']);
    $payrollWhere = !empty($payrollConditions) ? 'WHERE ' . implode(' AND ', $payrollConditions) : '';
    $payrollSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS payroll_records,
                SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) AS payroll_pending,
                COALESCE(SUM(p.net_pay), 0) AS total_net_pay
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         $payrollWhere",
        $payrollTypes,
        $payrollParams
    );

    $documentConditions = [];
    $documentTypes = '';
    $documentParams = [];
    appendDateRangeClause($documentConditions, $documentTypes, $documentParams, 'dr.received_date', $filters['date_from'], $filters['date_to']);
    $documentWhere = !empty($documentConditions) ? 'WHERE ' . implode(' AND ', $documentConditions) : '';
    $documentSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_documents,
                SUM(CASE WHEN dr.status = 'completed' THEN 1 ELSE 0 END) AS completed_documents,
                SUM(CASE WHEN dr.status = 'processing' THEN 1 ELSE 0 END) AS processing_documents
         FROM document_received dr
         $documentWhere",
        $documentTypes,
        $documentParams
    );

    $requests = fetchRequestOverviewSummary($conn, $filters);

    $taskReportsSent = 0;
    if (reportTableExists($conn, 'task_completion_reports')) {
        $taskReportConditions = [];
        $taskReportTypes = '';
        $taskReportParams = [];
        appendDateRangeClause($taskReportConditions, $taskReportTypes, $taskReportParams, 'tcr.sent_at', $filters['date_from'], $filters['date_to']);
        $taskReportWhere = !empty($taskReportConditions) ? 'WHERE ' . implode(' AND ', $taskReportConditions) : '';
        $row = reportQueryRow(
            $conn,
            "SELECT COUNT(*) AS total_reports
             FROM task_completion_reports tcr
             $taskReportWhere",
            $taskReportTypes,
            $taskReportParams
        );
        $taskReportsSent = intval($row['total_reports'] ?? 0);
    }

    $projectReportsSent = 0;
    if (reportTableExists($conn, 'project_completion_reports')) {
        $projectReportConditions = [];
        $projectReportTypes = '';
        $projectReportParams = [];
        appendDateRangeClause($projectReportConditions, $projectReportTypes, $projectReportParams, 'pcr.sent_at', $filters['date_from'], $filters['date_to']);
        $projectReportWhere = !empty($projectReportConditions) ? 'WHERE ' . implode(' AND ', $projectReportConditions) : '';
        $row = reportQueryRow(
            $conn,
            "SELECT COUNT(*) AS total_reports
             FROM project_completion_reports pcr
             $projectReportWhere",
            $projectReportTypes,
            $projectReportParams
        );
        $projectReportsSent = intval($row['total_reports'] ?? 0);
    }

    $exceptionSummary = ['open_exceptions' => 0, 'critical_exceptions' => 0];
    if (reportTableExists($conn, 'exception_queue')) {
        $exceptionConditions = [];
        $exceptionTypes = '';
        $exceptionParams = [];
        appendDateRangeClause($exceptionConditions, $exceptionTypes, $exceptionParams, 'eq.created_at', $filters['date_from'], $filters['date_to']);
        $exceptionWhere = !empty($exceptionConditions) ? 'WHERE ' . implode(' AND ', $exceptionConditions) : '';
        $exceptionSummary = reportQueryRow(
            $conn,
            "SELECT SUM(CASE WHEN eq.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open_exceptions,
                    SUM(CASE WHEN eq.severity = 'critical' AND eq.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS critical_exceptions
             FROM exception_queue eq
             $exceptionWhere",
            $exceptionTypes,
            $exceptionParams
        );
    }

    $domainRows = [
        [
            'domain_name' => 'Projects',
            'total_records' => intval($projectTotals['total_projects'] ?? 0),
            'open_or_pending' => max(0, intval($projectTotals['total_projects'] ?? 0) - intval($projectTotals['completed_projects'] ?? 0)),
            'closed_or_completed' => intval($projectTotals['completed_projects'] ?? 0),
            'completion_rate' => intval($projectTotals['total_projects'] ?? 0) > 0
                ? reportPercent((intval($projectTotals['completed_projects'] ?? 0) / intval($projectTotals['total_projects'] ?? 0)) * 100)
                : reportPercent(0),
        ],
        [
            'domain_name' => 'Tasks',
            'total_records' => intval($taskSummary['total_tasks'] ?? 0),
            'open_or_pending' => intval($taskSummary['pending_tasks'] ?? 0) + intval($taskSummary['in_progress_tasks'] ?? 0),
            'closed_or_completed' => intval($taskSummary['completed_tasks'] ?? 0),
            'completion_rate' => intval($taskSummary['total_tasks'] ?? 0) > 0
                ? reportPercent((intval($taskSummary['completed_tasks'] ?? 0) / intval($taskSummary['total_tasks'] ?? 0)) * 100)
                : reportPercent(0),
        ],
        [
            'domain_name' => 'Requests',
            'total_records' => intval($requests['totals']['all_requests'] ?? 0),
            'open_or_pending' => intval($requests['totals']['open_requests'] ?? 0),
            'closed_or_completed' => intval($requests['totals']['closed_requests'] ?? 0),
            'completion_rate' => intval($requests['totals']['all_requests'] ?? 0) > 0
                ? reportPercent((intval($requests['totals']['closed_requests'] ?? 0) / intval($requests['totals']['all_requests'] ?? 0)) * 100)
                : reportPercent(0),
        ],
        [
            'domain_name' => 'Documents',
            'total_records' => intval($documentSummary['total_documents'] ?? 0),
            'open_or_pending' => intval($documentSummary['processing_documents'] ?? 0),
            'closed_or_completed' => intval($documentSummary['completed_documents'] ?? 0),
            'completion_rate' => intval($documentSummary['total_documents'] ?? 0) > 0
                ? reportPercent((intval($documentSummary['completed_documents'] ?? 0) / intval($documentSummary['total_documents'] ?? 0)) * 100)
                : reportPercent(0),
        ],
    ];

    $activityRows = fetchActivityCountsByDay($conn, $filters);

    return [
        'report_key' => 'executive_overview',
        'title' => 'Executive Overview',
        'description' => 'Cross-functional snapshot of delivery, payroll, requests, documents, and control activity.',
        'generated_at' => date('c'),
        'filters' => $filters,
        'sections' => [
            reportMetricsSection('Core Snapshot', [
                reportMetric('Users', reportNumber($userSummary['total_users'] ?? 0), 'Accounts inside the current report scope.'),
                reportMetric('Projects', reportNumber($projectTotals['total_projects'] ?? 0), 'Total projects in the selected window.'),
                reportMetric('Tasks', reportNumber($taskSummary['total_tasks'] ?? 0), 'All tasks created in scope.'),
                reportMetric('Payroll Records', reportNumber($payrollSummary['payroll_records'] ?? 0), 'Payroll rows matched by the filter.'),
                reportMetric('Requests', reportNumber($requests['totals']['all_requests'] ?? 0), 'Combined leave, overtime, and cash advance requests.'),
                reportMetric('Documents', reportNumber($documentSummary['total_documents'] ?? 0), 'Document intake records.'),
            ], 'High-level totals across the main operational modules.'),
            reportMetricsSection('Operational Health', [
                reportMetric('Overdue Tasks', reportNumber($taskSummary['overdue_tasks'] ?? 0), 'Open tasks whose due date has already passed.', intval($taskSummary['overdue_tasks'] ?? 0) > 0 ? 'danger' : 'good'),
                reportMetric('Pending Payroll', reportNumber($payrollSummary['payroll_pending'] ?? 0), 'Payroll records waiting for review or action.', intval($payrollSummary['payroll_pending'] ?? 0) > 0 ? 'warn' : 'good'),
                reportMetric('Open Requests', reportNumber($requests['totals']['open_requests'] ?? 0), 'Requests still waiting for action.', intval($requests['totals']['open_requests'] ?? 0) > 0 ? 'warn' : 'good'),
                reportMetric('Open Exceptions', reportNumber($exceptionSummary['open_exceptions'] ?? 0), 'Items in the exception queue that are still unresolved.', intval($exceptionSummary['open_exceptions'] ?? 0) > 0 ? 'warn' : 'good'),
                reportMetric('Task Reports Sent', reportNumber($taskReportsSent), 'Completion reports emailed at task level.'),
                reportMetric('Project Reports Sent', reportNumber($projectReportsSent), 'Final reports and certifications sent at project level.'),
            ], 'A fast read on backlog, open issues, and outbound reporting activity.'),
            reportTableSection(
                'Domain Snapshot',
                [
                    ['key' => 'domain_name', 'label' => 'Domain'],
                    ['key' => 'total_records', 'label' => 'Total'],
                    ['key' => 'open_or_pending', 'label' => 'Open / Pending'],
                    ['key' => 'closed_or_completed', 'label' => 'Closed / Completed'],
                    ['key' => 'completion_rate', 'label' => 'Completion Rate'],
                ],
                $domainRows,
                'Each domain rolls up the active workload against completed output.'
            ),
            reportTableSection(
                'Recent Activity Trend',
                [
                    ['key' => 'activity_date', 'label' => 'Date'],
                    ['key' => 'activity_count', 'label' => 'Activity Logs'],
                    ['key' => 'audit_count', 'label' => 'Audit Trail Changes'],
                ],
                $activityRows,
                'Latest activity and audited changes captured per day.'
            ),
        ],
    ];
}

function buildProjectDeliveryReport($conn, $role, $filters) {
    $projectConditions = [];
    $projectTypes = '';
    $projectParams = [];
    appendDateRangeClause($projectConditions, $projectTypes, $projectParams, 'p.created_at', $filters['date_from'], $filters['date_to']);
    $projectWhere = !empty($projectConditions) ? 'WHERE ' . implode(' AND ', $projectConditions) : '';

    $projectStatusRows = reportQueryRows(
        $conn,
        "SELECT p.status,
                COUNT(*) AS project_count,
                COALESCE(SUM(p.budget), 0) AS total_budget,
                COALESCE(SUM(p.actual_cost), 0) AS total_actual_cost
         FROM projects p
         $projectWhere
         GROUP BY p.status
         ORDER BY project_count DESC",
        $projectTypes,
        $projectParams
    );

    $totals = [
        'total_projects' => 0,
        'active_projects' => 0,
        'completed_projects' => 0,
        'on_hold_projects' => 0,
    ];
    foreach ($projectStatusRows as $row) {
        $status = (string)($row['status'] ?? '');
        $count = intval($row['project_count'] ?? 0);
        $totals['total_projects'] += $count;
        if ($status === 'active') $totals['active_projects'] += $count;
        if ($status === 'completed') $totals['completed_projects'] += $count;
        if ($status === 'on_hold') $totals['on_hold_projects'] += $count;
    }

    $taskConditions = [];
    $taskTypes = '';
    $taskParams = [];
    appendDateRangeClause($taskConditions, $taskTypes, $taskParams, 't.created_at', $filters['date_from'], $filters['date_to']);
    $taskWhere = !empty($taskConditions) ? 'WHERE ' . implode(' AND ', $taskConditions) : '';
    $taskSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_tasks,
                SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
                SUM(CASE WHEN t.status NOT IN ('completed', 'cancelled') AND t.due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue_tasks
         FROM tasks t
         $taskWhere",
        $taskTypes,
        $taskParams
    );

    $projectProgressRows = reportQueryRows(
        $conn,
        "SELECT p.id,
                p.name AS project_name,
                COALESCE(c.client_name, 'No client') AS client_name,
                p.status,
                COUNT(t.id) AS task_total,
                SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS task_completed,
                SUM(CASE WHEN t.status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) AS task_open
         FROM projects p
         LEFT JOIN client c ON c.client_id = p.client_id
         LEFT JOIN tasks t ON t.project_id = p.id
         $projectWhere
         GROUP BY p.id, p.name, c.client_name, p.status
         ORDER BY task_open DESC, p.updated_at DESC
         LIMIT 20",
        $projectTypes,
        $projectParams
    );

    $hasProjectReports = reportTableExists($conn, 'project_completion_reports');
    $projectReportMap = [];
    if ($hasProjectReports) {
        $projectReportRows = reportQueryRows(
            $conn,
            "SELECT project_id,
                    SUM(CASE WHEN report_kind = 'major_report' THEN 1 ELSE 0 END) AS major_report_count,
                    SUM(CASE WHEN report_kind = 'certification' THEN 1 ELSE 0 END) AS certification_count
             FROM project_completion_reports
             GROUP BY project_id"
        );
        foreach ($projectReportRows as $row) {
            $projectId = intval($row['project_id'] ?? 0);
            if ($projectId <= 0) continue;
            $projectReportMap[$projectId] = [
                'major' => intval($row['major_report_count'] ?? 0),
                'certification' => intval($row['certification_count'] ?? 0),
            ];
        }
    }

    $progressRows = array_map(function ($row) use ($projectReportMap) {
        $projectId = intval($row['id'] ?? 0);
        $taskTotal = intval($row['task_total'] ?? 0);
        $taskCompleted = intval($row['task_completed'] ?? 0);
        $progress = $taskTotal > 0 ? ($taskCompleted / $taskTotal) * 100 : 0;
        $reportInfo = $projectReportMap[$projectId] ?? ['major' => 0, 'certification' => 0];

        return [
            'project_name' => (string)($row['project_name'] ?? 'Untitled Project'),
            'client_name' => (string)($row['client_name'] ?? 'No client'),
            'status' => (string)($row['status'] ?? 'unknown'),
            'task_total' => $taskTotal,
            'task_completed' => $taskCompleted,
            'task_open' => intval($row['task_open'] ?? 0),
            'progress_percent' => reportPercent($progress),
            'final_report_sent' => intval($reportInfo['major'] ?? 0) > 0 ? 'Yes' : 'No',
            'certification_sent' => intval($reportInfo['certification'] ?? 0) > 0 ? 'Yes' : 'No',
        ];
    }, $projectProgressRows);

    $taskReportCount = 0;
    if (reportTableExists($conn, 'task_completion_reports')) {
        $conditions = [];
        $types = '';
        $params = [];
        appendDateRangeClause($conditions, $types, $params, 'sent_at', $filters['date_from'], $filters['date_to']);
        $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';
        $row = reportQueryRow(
            $conn,
            "SELECT COUNT(*) AS total_count
             FROM task_completion_reports
             $where",
            $types,
            $params
        );
        $taskReportCount = intval($row['total_count'] ?? 0);
    }

    $projectReportCount = 0;
    if ($hasProjectReports) {
        $conditions = [];
        $types = '';
        $params = [];
        appendDateRangeClause($conditions, $types, $params, 'sent_at', $filters['date_from'], $filters['date_to']);
        $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';
        $row = reportQueryRow(
            $conn,
            "SELECT COUNT(*) AS total_count
             FROM project_completion_reports
             $where",
            $types,
            $params
        );
        $projectReportCount = intval($row['total_count'] ?? 0);
    }

    $overdueConditions = [];
    $overdueTypes = '';
    $overdueParams = [];
    appendDateRangeClause($overdueConditions, $overdueTypes, $overdueParams, 't.created_at', $filters['date_from'], $filters['date_to']);
    $overdueConditions[] = "t.status NOT IN ('completed', 'cancelled')";
    $overdueConditions[] = "t.due_date < CURDATE()";
    $overdueWhere = 'WHERE ' . implode(' AND ', $overdueConditions);
    $overdueRows = reportQueryRows(
        $conn,
        "SELECT t.title AS task_title,
                COALESCE(p.name, 'No project') AS project_name,
                COALESCE(c.client_name, 'No client') AS client_name,
                COALESCE(CONCAT(u.first_name, ' ', u.last_name), u.username, 'Unassigned') AS assignee_name,
                t.status,
                t.priority,
                t.due_date,
                CASE WHEN tcr.report_id IS NULL THEN 'No' ELSE 'Yes' END AS report_sent
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN client c ON c.client_id = p.client_id
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN task_completion_reports tcr ON tcr.task_id = t.id
         $overdueWhere
         ORDER BY t.due_date ASC, t.priority DESC
         LIMIT 20",
        $overdueTypes,
        $overdueParams
    );

    $statusRows = array_map(function ($row) {
        return [
            'status' => (string)($row['status'] ?? 'unknown'),
            'project_count' => intval($row['project_count'] ?? 0),
            'total_budget' => reportCurrency($row['total_budget'] ?? 0),
            'total_actual_cost' => reportCurrency($row['total_actual_cost'] ?? 0),
        ];
    }, $projectStatusRows);

    return [
        'report_key' => 'project_delivery',
        'title' => 'Project Delivery',
        'description' => 'Project volume, task completion, overdue work, and outbound delivery reporting.',
        'generated_at' => date('c'),
        'filters' => $filters,
        'sections' => [
            reportMetricsSection('Delivery Snapshot', [
                reportMetric('Projects', reportNumber($totals['total_projects']), 'Projects in the current report window.'),
                reportMetric('Active Projects', reportNumber($totals['active_projects']), 'Projects still being worked on.'),
                reportMetric('Completed Projects', reportNumber($totals['completed_projects']), 'Projects marked as completed.', $totals['completed_projects'] > 0 ? 'good' : 'neutral'),
                reportMetric('On Hold', reportNumber($totals['on_hold_projects']), 'Projects paused for follow-up.', $totals['on_hold_projects'] > 0 ? 'warn' : 'neutral'),
                reportMetric('Tasks', reportNumber($taskSummary['total_tasks'] ?? 0), 'Tasks created across all projects.'),
                reportMetric('Completed Tasks', reportNumber($taskSummary['completed_tasks'] ?? 0), 'Tasks finished by assignees.', intval($taskSummary['completed_tasks'] ?? 0) > 0 ? 'good' : 'neutral'),
            ]),
            reportMetricsSection('Report Dispatch', [
                reportMetric('Overdue Tasks', reportNumber($taskSummary['overdue_tasks'] ?? 0), 'Open tasks that missed due dates.', intval($taskSummary['overdue_tasks'] ?? 0) > 0 ? 'danger' : 'good'),
                reportMetric('Task Reports Sent', reportNumber($taskReportCount), 'Client-facing completion reports at task level.'),
                reportMetric('Project Reports Sent', reportNumber($projectReportCount), 'Final reports and certifications dispatched.'),
                reportMetric(
                    'Task Completion Rate',
                    intval($taskSummary['total_tasks'] ?? 0) > 0
                        ? reportPercent((intval($taskSummary['completed_tasks'] ?? 0) / intval($taskSummary['total_tasks'] ?? 0)) * 100)
                        : reportPercent(0),
                    'Completed tasks divided by total tasks.'
                ),
            ], 'Delivery health and project closing documentation in one view.'),
            reportTableSection(
                'Project Status Breakdown',
                [
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'project_count', 'label' => 'Projects'],
                    ['key' => 'total_budget', 'label' => 'Budget'],
                    ['key' => 'total_actual_cost', 'label' => 'Actual Cost'],
                ],
                $statusRows,
                'Project counts and financial totals by status.'
            ),
            reportTableSection(
                'Top Project Progress',
                [
                    ['key' => 'project_name', 'label' => 'Project'],
                    ['key' => 'client_name', 'label' => 'Client'],
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'task_total', 'label' => 'Tasks'],
                    ['key' => 'task_completed', 'label' => 'Completed'],
                    ['key' => 'task_open', 'label' => 'Open'],
                    ['key' => 'progress_percent', 'label' => 'Progress'],
                    ['key' => 'final_report_sent', 'label' => 'Final Report'],
                    ['key' => 'certification_sent', 'label' => 'Certification'],
                ],
                $progressRows,
                'Projects with the biggest current workload or open task count.'
            ),
            reportTableSection(
                'Overdue Task Watchlist',
                [
                    ['key' => 'task_title', 'label' => 'Task'],
                    ['key' => 'project_name', 'label' => 'Project'],
                    ['key' => 'client_name', 'label' => 'Client'],
                    ['key' => 'assignee_name', 'label' => 'Assignee'],
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'priority', 'label' => 'Priority'],
                    ['key' => 'due_date', 'label' => 'Due Date'],
                    ['key' => 'report_sent', 'label' => 'Report Sent'],
                ],
                $overdueRows,
                'Tasks needing the quickest follow-up.'
            ),
        ],
    ];
}

function buildPayrollAttendanceReport($conn, $role, $filters) {
    $payrollConditions = [];
    $payrollTypes = '';
    $payrollParams = [];
    appendDateRangeClause($payrollConditions, $payrollTypes, $payrollParams, 'p.pay_period_end', $filters['date_from'], $filters['date_to']);
    appendBranchClause($payrollConditions, $payrollTypes, $payrollParams, 'e.branch_id', $filters['branch_id']);
    $payrollWhere = !empty($payrollConditions) ? 'WHERE ' . implode(' AND ', $payrollConditions) : '';

    $payrollSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS payroll_records,
                SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) AS pending_payroll,
                COALESCE(SUM(p.basic_salary), 0) AS total_basic_salary,
                COALESCE(SUM(p.gross_pay), 0) AS total_gross_pay,
                COALESCE(SUM(p.net_pay), 0) AS total_net_pay,
                COALESCE(SUM(p.total_deductions), 0) AS total_deductions,
                COALESCE(SUM(p.overtime_hours), 0) AS total_overtime_hours,
                COALESCE(SUM(p.overtime_pay), 0) AS total_overtime_pay,
                COALESCE(SUM(p.bonus), 0) AS total_bonus,
                COALESCE(SUM(p.clothing_allowance), 0) AS total_clothing_allowance,
                COALESCE(SUM(p.travel_allowance), 0) AS total_travel_allowance,
                COALESCE(SUM(p.salary_adjustment), 0) AS total_salary_adjustment,
                COALESCE(SUM(p.late_deduction), 0) AS total_late_deductions,
                COALESCE(SUM(p.absence_deduction), 0) AS total_absence_deductions,
                COALESCE(SUM(p.tax), 0) AS total_tax_deductions,
                COALESCE(SUM(p.sss_contribution), 0) AS total_sss_deductions,
                COALESCE(SUM(p.pagibig_contribution), 0) AS total_pagibig_deductions,
                COALESCE(SUM(p.philhealth_contribution), 0) AS total_philhealth_deductions,
                COALESCE(SUM(p.cash_advance_deduction), 0) AS total_cash_advance_deductions,
                COALESCE(SUM(p.laptop_loan_deduction), 0) AS total_laptop_loan_deductions,
                COALESCE(SUM(p.other_deductions), 0) AS total_other_deductions
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         $payrollWhere",
        $payrollTypes,
        $payrollParams
    );

    $headcountConditions = [];
    $headcountTypes = '';
    $headcountParams = [];
    $headcountConditions[] = "e.status = 'active'";
    appendBranchClause($headcountConditions, $headcountTypes, $headcountParams, 'e.branch_id', $filters['branch_id']);
    $headcountWhere = 'WHERE ' . implode(' AND ', $headcountConditions);
    $headcountRow = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS active_headcount
         FROM employees e
         $headcountWhere",
        $headcountTypes,
        $headcountParams
    );

    $attendanceConditions = [];
    $attendanceTypes = '';
    $attendanceParams = [];
    appendDateRangeClause($attendanceConditions, $attendanceTypes, $attendanceParams, 'ar.pay_period_end', $filters['date_from'], $filters['date_to']);
    appendBranchClause($attendanceConditions, $attendanceTypes, $attendanceParams, 'e.branch_id', $filters['branch_id']);
    $attendanceWhere = !empty($attendanceConditions) ? 'WHERE ' . implode(' AND ', $attendanceConditions) : '';
    $attendanceSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS attendance_rows,
                COALESCE(SUM(ar.days_worked), 0) AS total_days_worked,
                COALESCE(SUM(ar.overtime_hours), 0) AS attendance_overtime_hours,
                COALESCE(SUM(ar.late_minutes), 0) AS total_late_minutes,
                COALESCE(SUM(ar.absent_days), 0) AS total_absent_days
         FROM attendance_records ar
         LEFT JOIN employees e ON e.employee_id = ar.employee_id
         $attendanceWhere",
        $attendanceTypes,
        $attendanceParams
    );

    $payrollRecords = intval($payrollSummary['payroll_records'] ?? 0);
    $totalGrossPay = (float)($payrollSummary['total_gross_pay'] ?? 0);
    $totalNetPay = (float)($payrollSummary['total_net_pay'] ?? 0);
    $totalDeductions = (float)($payrollSummary['total_deductions'] ?? 0);
    $governmentDeductions = (float)($payrollSummary['total_tax_deductions'] ?? 0)
        + (float)($payrollSummary['total_sss_deductions'] ?? 0)
        + (float)($payrollSummary['total_pagibig_deductions'] ?? 0)
        + (float)($payrollSummary['total_philhealth_deductions'] ?? 0);
    $attendanceDeductions = (float)($payrollSummary['total_late_deductions'] ?? 0)
        + (float)($payrollSummary['total_absence_deductions'] ?? 0);
    $loanAndOtherDeductions = (float)($payrollSummary['total_cash_advance_deductions'] ?? 0)
        + (float)($payrollSummary['total_laptop_loan_deductions'] ?? 0)
        + (float)($payrollSummary['total_other_deductions'] ?? 0);
    $allowanceAdjustmentSpend = (float)($payrollSummary['total_clothing_allowance'] ?? 0)
        + (float)($payrollSummary['total_travel_allowance'] ?? 0)
        + (float)($payrollSummary['total_salary_adjustment'] ?? 0);
    $averageNetPay = $payrollRecords > 0 ? $totalNetPay / $payrollRecords : 0;
    $deductionRate = $totalGrossPay > 0 ? ($totalDeductions / $totalGrossPay) * 100 : 0;

    $statusRows = reportQueryRows(
        $conn,
        "SELECT p.status,
                COUNT(*) AS payroll_count,
                COALESCE(SUM(p.net_pay), 0) AS total_net_pay
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         $payrollWhere
         GROUP BY p.status
         ORDER BY payroll_count DESC",
        $payrollTypes,
        $payrollParams
    );
    $statusRows = array_map(function ($row) {
        return [
            'status' => (string)($row['status'] ?? 'unknown'),
            'payroll_count' => intval($row['payroll_count'] ?? 0),
            'total_net_pay' => reportCurrency($row['total_net_pay'] ?? 0),
        ];
    }, $statusRows);

    $deductionRows = [
        ['deduction_name' => 'Tax', 'amount' => reportCurrency($payrollSummary['total_tax_deductions'] ?? 0)],
        ['deduction_name' => 'SSS', 'amount' => reportCurrency($payrollSummary['total_sss_deductions'] ?? 0)],
        ['deduction_name' => 'Pag-IBIG', 'amount' => reportCurrency($payrollSummary['total_pagibig_deductions'] ?? 0)],
        ['deduction_name' => 'PhilHealth', 'amount' => reportCurrency($payrollSummary['total_philhealth_deductions'] ?? 0)],
        ['deduction_name' => 'Late', 'amount' => reportCurrency($payrollSummary['total_late_deductions'] ?? 0)],
        ['deduction_name' => 'Absence', 'amount' => reportCurrency($payrollSummary['total_absence_deductions'] ?? 0)],
        ['deduction_name' => 'Cash Advance', 'amount' => reportCurrency($payrollSummary['total_cash_advance_deductions'] ?? 0)],
        ['deduction_name' => 'Laptop Loan', 'amount' => reportCurrency($payrollSummary['total_laptop_loan_deductions'] ?? 0)],
        ['deduction_name' => 'Other', 'amount' => reportCurrency($payrollSummary['total_other_deductions'] ?? 0)],
    ];

    $branchPayrollRows = reportQueryRows(
        $conn,
        "SELECT COALESCE(b.branch_name, 'Unassigned Branch') AS branch_name,
                COUNT(*) AS payroll_count,
                COALESCE(SUM(p.gross_pay), 0) AS total_gross_pay,
                COALESCE(SUM(p.net_pay), 0) AS total_net_pay,
                COALESCE(SUM(p.total_deductions), 0) AS total_deductions
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         LEFT JOIN branches b ON b.branch_id = e.branch_id
         $payrollWhere
         GROUP BY b.branch_name
         ORDER BY total_net_pay DESC
         LIMIT 20",
        $payrollTypes,
        $payrollParams
    );
    $branchPayrollRows = array_map(function ($row) {
        return [
            'branch_name' => (string)($row['branch_name'] ?? 'Unassigned Branch'),
            'payroll_count' => intval($row['payroll_count'] ?? 0),
            'total_gross_pay' => reportCurrency($row['total_gross_pay'] ?? 0),
            'total_net_pay' => reportCurrency($row['total_net_pay'] ?? 0),
            'total_deductions' => reportCurrency($row['total_deductions'] ?? 0),
        ];
    }, $branchPayrollRows);

    $spendByEmployeeRows = reportQueryRows(
        $conn,
        "SELECT p.employee_id,
                TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS employee_name,
                COALESCE(b.branch_name, 'Unassigned Branch') AS branch_name,
                COUNT(*) AS payroll_count,
                COALESCE(SUM(p.gross_pay), 0) AS total_gross_pay,
                COALESCE(SUM(p.net_pay), 0) AS total_net_pay,
                COALESCE(SUM(p.overtime_pay), 0) AS total_overtime_pay,
                COALESCE(SUM(p.total_deductions), 0) AS total_deductions
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         LEFT JOIN branches b ON b.branch_id = e.branch_id
         $payrollWhere
         GROUP BY p.employee_id, employee_name, branch_name
         ORDER BY total_gross_pay DESC
         LIMIT 15",
        $payrollTypes,
        $payrollParams
    );
    $spendByEmployeeRows = array_map(function ($row) {
        $employeeId = intval($row['employee_id'] ?? 0);
        $employeeName = trim((string)($row['employee_name'] ?? ''));
        return [
            'employee_name' => $employeeName !== '' ? $employeeName : ('Employee #' . $employeeId),
            'branch_name' => (string)($row['branch_name'] ?? 'Unassigned Branch'),
            'payroll_count' => intval($row['payroll_count'] ?? 0),
            'total_gross_pay' => reportCurrency($row['total_gross_pay'] ?? 0),
            'total_net_pay' => reportCurrency($row['total_net_pay'] ?? 0),
            'total_overtime_pay' => reportCurrency($row['total_overtime_pay'] ?? 0),
            'total_deductions' => reportCurrency($row['total_deductions'] ?? 0),
        ];
    }, $spendByEmployeeRows);

    $deductionLoadRows = reportQueryRows(
        $conn,
        "SELECT p.employee_id,
                TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS employee_name,
                COALESCE(b.branch_name, 'Unassigned Branch') AS branch_name,
                COUNT(*) AS payroll_count,
                COALESCE(SUM(p.total_deductions), 0) AS total_deductions,
                COALESCE(SUM(p.late_deduction + p.absence_deduction), 0) AS attendance_deductions,
                COALESCE(SUM(p.tax + p.sss_contribution + p.pagibig_contribution + p.philhealth_contribution), 0) AS government_deductions,
                COALESCE(SUM(p.cash_advance_deduction + p.laptop_loan_deduction + p.other_deductions), 0) AS loan_other_deductions
         FROM payroll p
         LEFT JOIN employees e ON e.employee_id = p.employee_id
         LEFT JOIN branches b ON b.branch_id = e.branch_id
         $payrollWhere
         GROUP BY p.employee_id, employee_name, branch_name
         ORDER BY total_deductions DESC
         LIMIT 15",
        $payrollTypes,
        $payrollParams
    );
    $deductionLoadRows = array_map(function ($row) {
        $employeeId = intval($row['employee_id'] ?? 0);
        $employeeName = trim((string)($row['employee_name'] ?? ''));
        return [
            'employee_name' => $employeeName !== '' ? $employeeName : ('Employee #' . $employeeId),
            'branch_name' => (string)($row['branch_name'] ?? 'Unassigned Branch'),
            'payroll_count' => intval($row['payroll_count'] ?? 0),
            'total_deductions' => reportCurrency($row['total_deductions'] ?? 0),
            'government_deductions' => reportCurrency($row['government_deductions'] ?? 0),
            'attendance_deductions' => reportCurrency($row['attendance_deductions'] ?? 0),
            'loan_other_deductions' => reportCurrency($row['loan_other_deductions'] ?? 0),
        ];
    }, $deductionLoadRows);

    $attendanceBranchRows = reportQueryRows(
        $conn,
        "SELECT COALESCE(b.branch_name, 'Unassigned Branch') AS branch_name,
                COUNT(*) AS attendance_rows,
                COALESCE(SUM(ar.days_worked), 0) AS total_days_worked,
                COALESCE(SUM(ar.overtime_hours), 0) AS total_overtime_hours,
                COALESCE(SUM(ar.late_minutes), 0) AS total_late_minutes,
                COALESCE(SUM(ar.absent_days), 0) AS total_absent_days
         FROM attendance_records ar
         LEFT JOIN employees e ON e.employee_id = ar.employee_id
         LEFT JOIN branches b ON b.branch_id = e.branch_id
         $attendanceWhere
         GROUP BY b.branch_name
         ORDER BY attendance_rows DESC
         LIMIT 20",
        $attendanceTypes,
        $attendanceParams
    );
    $attendanceBranchRows = array_map(function ($row) {
        return [
            'branch_name' => (string)($row['branch_name'] ?? 'Unassigned Branch'),
            'attendance_rows' => intval($row['attendance_rows'] ?? 0),
            'total_days_worked' => reportNumber($row['total_days_worked'] ?? 0, 2),
            'total_overtime_hours' => reportNumber($row['total_overtime_hours'] ?? 0, 2),
            'total_late_minutes' => reportNumber($row['total_late_minutes'] ?? 0),
            'total_absent_days' => reportNumber($row['total_absent_days'] ?? 0, 2),
        ];
    }, $attendanceBranchRows);

    return [
        'report_key' => 'payroll_attendance',
        'title' => 'Payroll and Attendance',
        'description' => 'Payroll spend, deduction pressure, attendance movement, and branch-level payroll trends.',
        'generated_at' => date('c'),
        'filters' => $filters,
        'sections' => [
            reportMetricsSection('Payroll Snapshot', [
                reportMetric('Active Headcount', reportNumber($headcountRow['active_headcount'] ?? 0), 'Employees marked as active in scope.'),
                reportMetric('Payroll Records', reportNumber($payrollRecords), 'Payroll records included by the filter.'),
                reportMetric('Pending Payroll', reportNumber($payrollSummary['pending_payroll'] ?? 0), 'Payroll records waiting for review.', intval($payrollSummary['pending_payroll'] ?? 0) > 0 ? 'warn' : 'good'),
                reportMetric('Gross Payroll Spend', reportCurrency($totalGrossPay), 'Total payroll outlay before deductions.', 'good'),
                reportMetric('Total Net Pay', reportCurrency($totalNetPay), 'Combined net payroll amount released to employees.', 'good'),
                reportMetric('Total Deductions', reportCurrency($totalDeductions), 'Combined deductions across payroll rows.', $totalDeductions > 0 ? 'warn' : 'neutral'),
            ]),
            reportMetricsSection('Payroll Spend Summary', [
                reportMetric('Basic Salary', reportCurrency($payrollSummary['total_basic_salary'] ?? 0), 'Combined base salary value.'),
                reportMetric('Overtime Pay', reportCurrency($payrollSummary['total_overtime_pay'] ?? 0), 'Extra spend created by overtime work.', 'good'),
                reportMetric('Bonuses Paid', reportCurrency($payrollSummary['total_bonus'] ?? 0), 'Bonuses added to payroll records.', 'good'),
                reportMetric('Allowances and Adjustments', reportCurrency($allowanceAdjustmentSpend), 'Clothing, travel, and salary adjustments combined.'),
                reportMetric('Average Net Pay', reportCurrency($averageNetPay), 'Average take-home pay per payroll record.'),
                reportMetric('Deduction Rate', reportPercent($deductionRate), 'Share of gross payroll removed through deductions.', $deductionRate >= 20 ? 'warn' : 'neutral'),
            ]),
            reportMetricsSection('Deduction Summary', [
                reportMetric('Government Deductions', reportCurrency($governmentDeductions), 'Tax, SSS, Pag-IBIG, and PhilHealth combined.', $governmentDeductions > 0 ? 'warn' : 'neutral'),
                reportMetric('Attendance Deductions', reportCurrency($attendanceDeductions), 'Late and absence deductions combined.', $attendanceDeductions > 0 ? 'warn' : 'neutral'),
                reportMetric('Cash Advance and Loans', reportCurrency($loanAndOtherDeductions), 'Cash advance, laptop loan, and other deductions combined.', $loanAndOtherDeductions > 0 ? 'warn' : 'neutral'),
                reportMetric('Other Deductions', reportCurrency($payrollSummary['total_other_deductions'] ?? 0), 'Miscellaneous deduction value booked to payroll.'),
                reportMetric('Total Deductions', reportCurrency($totalDeductions), 'Full deduction burden across all payroll rows.', $totalDeductions > 0 ? 'warn' : 'neutral'),
            ]),
            reportMetricsSection('Attendance Snapshot', [
                reportMetric('Attendance Rows', reportNumber($attendanceSummary['attendance_rows'] ?? 0), 'Imported attendance records in scope.'),
                reportMetric('Days Worked', reportNumber($attendanceSummary['total_days_worked'] ?? 0, 2), 'Total days worked captured in attendance imports.'),
                reportMetric('Overtime Hours', reportNumber(($payrollSummary['total_overtime_hours'] ?? 0) + ($attendanceSummary['attendance_overtime_hours'] ?? 0), 2), 'Combined overtime visibility from payroll and attendance.', 'good'),
                reportMetric('Late Minutes', reportNumber($attendanceSummary['total_late_minutes'] ?? 0), 'Accumulated late minutes in attendance.'),
                reportMetric('Absent Days', reportNumber($attendanceSummary['total_absent_days'] ?? 0, 2), 'Tracked absences from attendance records.', intval($attendanceSummary['total_absent_days'] ?? 0) > 0 ? 'warn' : 'neutral'),
            ], 'Payroll totals are paired with attendance inputs to spot operational drift early.'),
            reportTableSection(
                'Payroll Status Breakdown',
                [
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'payroll_count', 'label' => 'Records'],
                    ['key' => 'total_net_pay', 'label' => 'Net Pay'],
                ],
                $statusRows
            ),
            reportTableSection(
                'Deduction Breakdown',
                [
                    ['key' => 'deduction_name', 'label' => 'Deduction'],
                    ['key' => 'amount', 'label' => 'Amount'],
                ],
                $deductionRows
            ),
            reportTableSection(
                'Branch Payroll Totals',
                [
                    ['key' => 'branch_name', 'label' => 'Branch'],
                    ['key' => 'payroll_count', 'label' => 'Payroll Records'],
                    ['key' => 'total_gross_pay', 'label' => 'Gross Pay'],
                    ['key' => 'total_net_pay', 'label' => 'Net Pay'],
                    ['key' => 'total_deductions', 'label' => 'Deductions'],
                ],
                $branchPayrollRows
            ),
            reportTableSection(
                'Payroll Spend by Employee',
                [
                    ['key' => 'employee_name', 'label' => 'Employee'],
                    ['key' => 'branch_name', 'label' => 'Branch'],
                    ['key' => 'payroll_count', 'label' => 'Payroll Records'],
                    ['key' => 'total_gross_pay', 'label' => 'Gross Pay'],
                    ['key' => 'total_net_pay', 'label' => 'Net Pay'],
                    ['key' => 'total_overtime_pay', 'label' => 'Overtime Pay'],
                    ['key' => 'total_deductions', 'label' => 'Deductions'],
                ],
                $spendByEmployeeRows,
                'Employees consuming the highest payroll spend in the selected scope.'
            ),
            reportTableSection(
                'Top Deduction Loads',
                [
                    ['key' => 'employee_name', 'label' => 'Employee'],
                    ['key' => 'branch_name', 'label' => 'Branch'],
                    ['key' => 'payroll_count', 'label' => 'Payroll Records'],
                    ['key' => 'total_deductions', 'label' => 'Total Deductions'],
                    ['key' => 'government_deductions', 'label' => 'Government'],
                    ['key' => 'attendance_deductions', 'label' => 'Attendance'],
                    ['key' => 'loan_other_deductions', 'label' => 'Loans and Other'],
                ],
                $deductionLoadRows,
                'Employees carrying the heaviest deduction load in the selected scope.'
            ),
            reportTableSection(
                'Attendance by Branch',
                [
                    ['key' => 'branch_name', 'label' => 'Branch'],
                    ['key' => 'attendance_rows', 'label' => 'Attendance Rows'],
                    ['key' => 'total_days_worked', 'label' => 'Days Worked'],
                    ['key' => 'total_overtime_hours', 'label' => 'Overtime Hours'],
                    ['key' => 'total_late_minutes', 'label' => 'Late Minutes'],
                    ['key' => 'total_absent_days', 'label' => 'Absent Days'],
                ],
                $attendanceBranchRows
            ),
        ],
    ];
}

function buildDocumentsComplianceReport($conn, $role, $filters) {
    $documentConditions = [];
    $documentTypes = '';
    $documentParams = [];
    appendDateRangeClause($documentConditions, $documentTypes, $documentParams, 'dr.received_date', $filters['date_from'], $filters['date_to']);
    $documentWhere = !empty($documentConditions) ? 'WHERE ' . implode(' AND ', $documentConditions) : '';

    $documentSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_documents,
                SUM(CASE WHEN dr.status = 'received' THEN 1 ELSE 0 END) AS received_count,
                SUM(CASE WHEN dr.status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
                SUM(CASE WHEN dr.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN dr.status = 'archived' THEN 1 ELSE 0 END) AS archived_count
         FROM document_received dr
         $documentWhere",
        $documentTypes,
        $documentParams
    );

    $submissionConditions = [];
    $submissionTypes = '';
    $submissionParams = [];
    appendDateRangeClause($submissionConditions, $submissionTypes, $submissionParams, 'ds.submission_date', $filters['date_from'], $filters['date_to']);
    $submissionWhere = !empty($submissionConditions) ? 'WHERE ' . implode(' AND ', $submissionConditions) : '';
    $submissionSummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS total_submissions,
                SUM(CASE WHEN ds.status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
                SUM(CASE WHEN ds.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
         FROM document_submission ds
         $submissionWhere",
        $submissionTypes,
        $submissionParams
    );

    $clientRows = reportQueryRows(
        $conn,
        "SELECT COALESCE(c.client_name, 'No client') AS client_name,
                COUNT(dr.document_id) AS total_documents,
                SUM(CASE WHEN dr.status = 'received' THEN 1 ELSE 0 END) AS received_count,
                SUM(CASE WHEN dr.status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
                SUM(CASE WHEN dr.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN dr.status = 'archived' THEN 1 ELSE 0 END) AS archived_count,
                MAX(dr.received_date) AS last_received_date
         FROM document_received dr
         LEFT JOIN client c ON c.client_id = dr.client_id
         $documentWhere
         GROUP BY c.client_name
         ORDER BY total_documents DESC, client_name ASC
         LIMIT 20",
        $documentTypes,
        $documentParams
    );
    $clientRows = array_map(function ($row) {
        $total = intval($row['total_documents'] ?? 0);
        $completed = intval($row['completed_count'] ?? 0);
        return [
            'client_name' => (string)($row['client_name'] ?? 'No client'),
            'total_documents' => $total,
            'received_count' => intval($row['received_count'] ?? 0),
            'processing_count' => intval($row['processing_count'] ?? 0),
            'completed_count' => $completed,
            'archived_count' => intval($row['archived_count'] ?? 0),
            'completion_rate' => $total > 0 ? reportPercent(($completed / $total) * 100) : reportPercent(0),
            'last_received_date' => (string)($row['last_received_date'] ?? ''),
        ];
    }, $clientRows);

    $submissionStatusRows = reportQueryRows(
        $conn,
        "SELECT ds.status,
                COUNT(*) AS submission_count
         FROM document_submission ds
         $submissionWhere
         GROUP BY ds.status
         ORDER BY submission_count DESC",
        $submissionTypes,
        $submissionParams
    );
    $submissionStatusRows = array_map(function ($row) {
        return [
            'status' => (string)($row['status'] ?? 'unknown'),
            'submission_count' => intval($row['submission_count'] ?? 0),
        ];
    }, $submissionStatusRows);

    $recentRows = reportQueryRows(
        $conn,
        "SELECT dr.document_name,
                COALESCE(c.client_name, 'No client') AS client_name,
                COALESCE(CONCAT(e.first_name, ' ', e.last_name), 'Unassigned') AS employee_name,
                dr.document_type,
                dr.status,
                dr.received_date
         FROM document_received dr
         LEFT JOIN client c ON c.client_id = dr.client_id
         LEFT JOIN employees e ON e.employee_id = dr.employee_id
         $documentWhere
         ORDER BY dr.received_date DESC, dr.document_id DESC
         LIMIT 20",
        $documentTypes,
        $documentParams
    );

    $completionRate = intval($documentSummary['total_documents'] ?? 0) > 0
        ? (intval($documentSummary['completed_count'] ?? 0) / intval($documentSummary['total_documents'] ?? 0)) * 100
        : 0;
    $acceptanceRate = intval($submissionSummary['total_submissions'] ?? 0) > 0
        ? (intval($submissionSummary['accepted_count'] ?? 0) / intval($submissionSummary['total_submissions'] ?? 0)) * 100
        : 0;

    return [
        'report_key' => 'documents_compliance',
        'title' => 'Documents and Compliance',
        'description' => 'Document intake, submission outcomes, client completion rates, and recent compliance movement.',
        'generated_at' => date('c'),
        'filters' => $filters,
        'sections' => [
            reportMetricsSection('Document Intake', [
                reportMetric('Documents', reportNumber($documentSummary['total_documents'] ?? 0), 'All received documents in scope.'),
                reportMetric('Received', reportNumber($documentSummary['received_count'] ?? 0), 'Freshly received documents.'),
                reportMetric('Processing', reportNumber($documentSummary['processing_count'] ?? 0), 'Documents currently being processed.', intval($documentSummary['processing_count'] ?? 0) > 0 ? 'warn' : 'neutral'),
                reportMetric('Completed', reportNumber($documentSummary['completed_count'] ?? 0), 'Finished documents.', intval($documentSummary['completed_count'] ?? 0) > 0 ? 'good' : 'neutral'),
                reportMetric('Archived', reportNumber($documentSummary['archived_count'] ?? 0), 'Archived documents.'),
                reportMetric('Completion Rate', reportPercent($completionRate), 'Completed documents divided by total documents.'),
            ]),
            reportMetricsSection('Submission Flow', [
                reportMetric('Submissions', reportNumber($submissionSummary['total_submissions'] ?? 0), 'Document submission attempts in scope.'),
                reportMetric('Accepted', reportNumber($submissionSummary['accepted_count'] ?? 0), 'Accepted submissions.', intval($submissionSummary['accepted_count'] ?? 0) > 0 ? 'good' : 'neutral'),
                reportMetric('Rejected', reportNumber($submissionSummary['rejected_count'] ?? 0), 'Rejected submissions.', intval($submissionSummary['rejected_count'] ?? 0) > 0 ? 'warn' : 'neutral'),
                reportMetric('Acceptance Rate', reportPercent($acceptanceRate), 'Accepted submissions divided by total submissions.'),
            ], 'Submission health helps confirm whether document turnaround is keeping pace.'),
            reportTableSection(
                'Documents by Client',
                [
                    ['key' => 'client_name', 'label' => 'Client'],
                    ['key' => 'total_documents', 'label' => 'Documents'],
                    ['key' => 'received_count', 'label' => 'Received'],
                    ['key' => 'processing_count', 'label' => 'Processing'],
                    ['key' => 'completed_count', 'label' => 'Completed'],
                    ['key' => 'archived_count', 'label' => 'Archived'],
                    ['key' => 'completion_rate', 'label' => 'Completion Rate'],
                    ['key' => 'last_received_date', 'label' => 'Last Received'],
                ],
                $clientRows
            ),
            reportTableSection(
                'Submission Status Breakdown',
                [
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'submission_count', 'label' => 'Count'],
                ],
                $submissionStatusRows
            ),
            reportTableSection(
                'Recent Document Activity',
                [
                    ['key' => 'document_name', 'label' => 'Document'],
                    ['key' => 'client_name', 'label' => 'Client'],
                    ['key' => 'employee_name', 'label' => 'Employee'],
                    ['key' => 'document_type', 'label' => 'Type'],
                    ['key' => 'status', 'label' => 'Status'],
                    ['key' => 'received_date', 'label' => 'Received Date'],
                ],
                $recentRows
            ),
        ],
    ];
}

function buildAuditActivityReport($conn, $role, $filters) {
    $activityConditions = [];
    $activityTypes = '';
    $activityParams = [];
    appendDateRangeClause($activityConditions, $activityTypes, $activityParams, 'al.created_at', $filters['date_from'], $filters['date_to']);
    appendBranchClause($activityConditions, $activityTypes, $activityParams, 'u.branch_id', $filters['branch_id']);
    $activityWhere = !empty($activityConditions) ? 'WHERE ' . implode(' AND ', $activityConditions) : '';

    $activitySummary = reportQueryRow(
        $conn,
        "SELECT COUNT(*) AS activity_entries,
                COUNT(DISTINCT al.user_id) AS active_users,
                COUNT(DISTINCT COALESCE(al.activity_type, 'uncategorized')) AS unique_activity_types
         FROM activity_log al
         LEFT JOIN users u ON u.id = al.user_id
         $activityWhere",
        $activityTypes,
        $activityParams
    );

    $activityTypeRows = reportQueryRows(
        $conn,
        "SELECT COALESCE(al.activity_type, 'uncategorized') AS activity_type,
                COUNT(*) AS activity_count,
                MAX(al.created_at) AS last_seen_at
         FROM activity_log al
         LEFT JOIN users u ON u.id = al.user_id
         $activityWhere
         GROUP BY COALESCE(al.activity_type, 'uncategorized')
         ORDER BY activity_count DESC, last_seen_at DESC
         LIMIT 20",
        $activityTypes,
        $activityParams
    );
    $activityTypeRows = array_map(function ($row) {
        return [
            'activity_type' => (string)($row['activity_type'] ?? 'uncategorized'),
            'activity_count' => intval($row['activity_count'] ?? 0),
            'last_seen_at' => (string)($row['last_seen_at'] ?? ''),
        ];
    }, $activityTypeRows);

    $recentActivityRows = reportQueryRows(
        $conn,
        "SELECT al.created_at,
                COALESCE(CONCAT(u.first_name, ' ', u.last_name), u.username, 'System') AS actor_name,
                al.action,
                COALESCE(al.description, '') AS description,
                COALESCE(al.activity_type, 'uncategorized') AS activity_type
         FROM activity_log al
         LEFT JOIN users u ON u.id = al.user_id
         $activityWhere
         ORDER BY al.created_at DESC
         LIMIT 20",
        $activityTypes,
        $activityParams
    );

    $auditSummary = ['audit_entries' => 0];
    $recentAuditRows = [];
    if (reportTableExists($conn, 'audit_trail')) {
        $auditConditions = [];
        $auditTypes = '';
        $auditParams = [];
        appendDateRangeClause($auditConditions, $auditTypes, $auditParams, 'a.created_at', $filters['date_from'], $filters['date_to']);
        appendBranchClause($auditConditions, $auditTypes, $auditParams, 'u.branch_id', $filters['branch_id']);
        $auditWhere = !empty($auditConditions) ? 'WHERE ' . implode(' AND ', $auditConditions) : '';

        $auditSummary = reportQueryRow(
            $conn,
            "SELECT COUNT(*) AS audit_entries
             FROM audit_trail a
             LEFT JOIN users u ON u.id = a.user_id
             $auditWhere",
            $auditTypes,
            $auditParams
        );

        $recentAuditRows = reportQueryRows(
            $conn,
            "SELECT a.created_at,
                    COALESCE(CONCAT(u.first_name, ' ', u.last_name), u.username, 'System') AS actor_name,
                    a.entity_type,
                    a.entity_id,
                    a.action,
                    COALESCE(a.changed_fields, '') AS changed_fields,
                    COALESCE(a.source_endpoint, '') AS source_endpoint
             FROM audit_trail a
             LEFT JOIN users u ON u.id = a.user_id
             $auditWhere
             ORDER BY a.created_at DESC
             LIMIT 20",
            $auditTypes,
            $auditParams
        );
    }

    $exceptionSummary = ['open_exceptions' => 0, 'critical_exceptions' => 0];
    if (reportTableExists($conn, 'exception_queue')) {
        $conditions = [];
        $types = '';
        $params = [];
        appendDateRangeClause($conditions, $types, $params, 'eq.created_at', $filters['date_from'], $filters['date_to']);
        $where = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';
        $exceptionSummary = reportQueryRow(
            $conn,
            "SELECT SUM(CASE WHEN eq.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open_exceptions,
                    SUM(CASE WHEN eq.severity = 'critical' AND eq.status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS critical_exceptions
             FROM exception_queue eq
             $where",
            $types,
            $params
        );
    }

    return [
        'report_key' => 'audit_activity',
        'title' => 'Audit and Activity',
        'description' => 'System traceability across activity logs, audit trail records, and exception visibility.',
        'generated_at' => date('c'),
        'filters' => $filters,
        'sections' => [
            reportMetricsSection('Control Snapshot', [
                reportMetric('Activity Entries', reportNumber($activitySummary['activity_entries'] ?? 0), 'Logged actions across the application.'),
                reportMetric('Audit Changes', reportNumber($auditSummary['audit_entries'] ?? 0), 'Before/after trail entries saved by audited workflows.'),
                reportMetric('Active Actors', reportNumber($activitySummary['active_users'] ?? 0), 'Distinct users with tracked activity in scope.'),
                reportMetric('Activity Types', reportNumber($activitySummary['unique_activity_types'] ?? 0), 'Distinct activity categories recorded.'),
                reportMetric('Open Exceptions', reportNumber($exceptionSummary['open_exceptions'] ?? 0), 'Exception queue items still unresolved.', intval($exceptionSummary['open_exceptions'] ?? 0) > 0 ? 'warn' : 'good'),
                reportMetric('Critical Exceptions', reportNumber($exceptionSummary['critical_exceptions'] ?? 0), 'Critical exceptions still unresolved.', intval($exceptionSummary['critical_exceptions'] ?? 0) > 0 ? 'danger' : 'good'),
            ]),
            reportTableSection(
                'Activity by Type',
                [
                    ['key' => 'activity_type', 'label' => 'Activity Type'],
                    ['key' => 'activity_count', 'label' => 'Count'],
                    ['key' => 'last_seen_at', 'label' => 'Last Seen'],
                ],
                $activityTypeRows
            ),
            reportTableSection(
                'Recent Audit Trail',
                [
                    ['key' => 'created_at', 'label' => 'Time'],
                    ['key' => 'actor_name', 'label' => 'Actor'],
                    ['key' => 'entity_type', 'label' => 'Entity Type'],
                    ['key' => 'entity_id', 'label' => 'Entity ID'],
                    ['key' => 'action', 'label' => 'Action'],
                    ['key' => 'changed_fields', 'label' => 'Changed Fields'],
                    ['key' => 'source_endpoint', 'label' => 'Endpoint'],
                ],
                $recentAuditRows,
                'Most recent audited changes with entity and field-level context.'
            ),
            reportTableSection(
                'Recent Activity Log',
                [
                    ['key' => 'created_at', 'label' => 'Time'],
                    ['key' => 'actor_name', 'label' => 'Actor'],
                    ['key' => 'action', 'label' => 'Action'],
                    ['key' => 'description', 'label' => 'Description'],
                    ['key' => 'activity_type', 'label' => 'Type'],
                ],
                $recentActivityRows
            ),
        ],
    ];
}

function buildReportPayload($conn, $role, $reportKey, $filters) {
    switch ($reportKey) {
        case 'executive_overview':
            return buildExecutiveOverviewReport($conn, $role, $filters);
        case 'project_delivery':
            return buildProjectDeliveryReport($conn, $role, $filters);
        case 'payroll_attendance':
            return buildPayrollAttendanceReport($conn, $role, $filters);
        case 'documents_compliance':
            return buildDocumentsComplianceReport($conn, $role, $filters);
        case 'audit_activity':
            return buildAuditActivityReport($conn, $role, $filters);
        default:
            sendError('Unknown report key.', 400);
    }
}

function handleListReports($conn, $role) {
    $scopeBranchId = resolveReportScopeBranchId($conn, $role);
    $branches = getReportBranchOptions($conn, $role, $scopeBranchId);

    sendResponse(true, [
        'role' => $role,
        'reports' => array_values(getReportCatalog()),
        'branches' => $branches,
        'scope' => [
            'branch_id' => $scopeBranchId > 0 ? $scopeBranchId : null,
            'branch_label' => resolveReportBranchLabel($branches, $scopeBranchId),
        ],
    ], 'Reports loaded successfully.');
}

function handleGenerateReport($conn, $role) {
    $catalog = getReportCatalogMap();
    $reportKey = trim((string)($_GET['report_key'] ?? ''));
    if ($reportKey === '' || !isset($catalog[$reportKey])) {
        sendError('A valid report_key is required.', 400);
    }

    $filters = getReportFilters($conn, $role);
    $payload = buildReportPayload($conn, $role, $reportKey, $filters);
    sendResponse(true, $payload, 'Report generated successfully.');
}

closeDBConnection($conn);
?>
