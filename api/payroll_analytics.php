<?php
/**
 * Payroll Analytics API
 * Aggregates data for payroll dashboard
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

ensurePayrollAnalyticsSchema($conn);

function ensurePayrollAnalyticsSchema($conn) {
    $dbName = DB_NAME;
    $checkSql = "SELECT 1
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'employment_type'
                 LIMIT 1";
    $checkStmt = $conn->prepare($checkSql);
    if (!$checkStmt) return;

    $checkStmt->bind_param('s', $dbName);
    $checkStmt->execute();
    $exists = $checkStmt->get_result()->num_rows > 0;
    $checkStmt->close();

    if (!$exists) {
        $conn->query("ALTER TABLE employees ADD COLUMN `employment_type` VARCHAR(50) NOT NULL DEFAULT 'Full-Time'");
    }
}

function buildPayrollAnalyticsFilter($tableAlias, $periodStart, $periodEnd, $branchId = 0) {
    $prefix = $tableAlias !== '' ? $tableAlias . '.' : '';
    $conditions = ["({$prefix}status IS NULL OR {$prefix}status IN ('approved', 'paid', 'archived'))"];
    $params = [];
    $types = '';

    if ($periodStart !== '') {
        $conditions[] = "{$prefix}pay_period_start >= ?";
        $params[] = $periodStart;
        $types .= 's';
    }

    if ($periodEnd !== '') {
        $conditions[] = "{$prefix}pay_period_end <= ?";
        $params[] = $periodEnd;
        $types .= 's';
    }

    if ($branchId > 0) {
        $conditions[] = "{$prefix}employee_id IN (SELECT employee_id FROM employees WHERE branch_id = ?)";
        $params[] = $branchId;
        $types .= 'i';
    }

    return [
        'where' => 'WHERE ' . implode(' AND ', $conditions),
        'types' => $types,
        'params' => $params,
    ];
}

function bindAnalyticsParams($stmt, $types, $params) {
    if ($types === '' || empty($params)) {
        return;
    }

    $bindParams = [$types];
    foreach (array_keys($params) as $index) {
        $bindParams[] = &$params[$index];
    }

    call_user_func_array([$stmt, 'bind_param'], $bindParams);
}

function executeAnalyticsPreparedRows($conn, $sql, $types = '', $params = []) {
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare payroll analytics query.', 500);
    }

    bindAnalyticsParams($stmt, $types, $params);

    if (!$stmt->execute()) {
        $message = $stmt->error;
        $stmt->close();
        sendError('Failed to execute payroll analytics query: ' . $message, 500);
    }

    $result = $stmt->get_result();
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $stmt->close();

    return $rows;
}

function executeAnalyticsPreparedRow($conn, $sql, $types = '', $params = []) {
    $rows = executeAnalyticsPreparedRows($conn, $sql, $types, $params);
    return $rows[0] ?? [];
}

function analyticsFloat($value) {
    return round((float)$value, 2);
}

if ($method === 'GET') {
    requireFeatureAccess('payroll', ['admin', 'manager'], $conn);
    $period_start = trim((string)($_GET['start'] ?? ''));
    $period_end = trim((string)($_GET['end'] ?? ''));
    $branch_id = max(0, intval($_GET['branch_id'] ?? 0));
    $baseFilter = buildPayrollAnalyticsFilter('', $period_start, $period_end, $branch_id);
    $payrollFilter = buildPayrollAnalyticsFilter('p', $period_start, $period_end, $branch_id);
    
    // 1. KPI Cards
    // Headcount (Active employees)
    $headcount_sql = "SELECT COUNT(*) as count FROM employees WHERE status = 'active'";
    if ($branch_id > 0) {
        $headcount_sql .= " AND branch_id = ?";
        $headcountRow = executeAnalyticsPreparedRow($conn, $headcount_sql, 'i', [$branch_id]);
    } else {
        $headcountResult = $conn->query($headcount_sql);
        $headcountRow = $headcountResult ? $headcountResult->fetch_assoc() : ['count' => 0];
        if ($headcountResult) {
            $headcountResult->close();
        }
    }
    $headcount = intval($headcountRow['count'] ?? 0);
    
    // Financials (Total Payroll, Salaries, Benefits, Averages) within period
    $fin_sql = "SELECT 
                    COALESCE(SUM(net_pay), 0) as total_payroll,
                    COALESCE(SUM(basic_salary), 0) as total_salaries,
                    COALESCE(SUM(total_deductions), 0) as stored_total_deductions,
                    COALESCE(SUM(late_deduction), 0) as total_late_deductions,
                    COALESCE(SUM(absence_deduction), 0) as total_absence_deductions,
                    COALESCE(SUM(tax), 0) as total_tax_deductions,
                    COALESCE(SUM(sss_contribution), 0) as total_sss_deductions,
                    COALESCE(SUM(pagibig_contribution), 0) as total_pagibig_deductions,
                    COALESCE(SUM(philhealth_contribution), 0) as total_philhealth_deductions,
                    COALESCE(SUM(cash_advance_deduction), 0) as total_cash_advance_deductions,
                    COALESCE(SUM(laptop_loan_deduction), 0) as total_laptop_loan_deductions,
                    COALESCE(SUM(other_deductions), 0) as total_other_deductions,
                    COALESCE(SUM(overtime_pay), 0) as total_overtime,
                    COALESCE(SUM(bonus), 0) as total_bonus,
                    COALESCE(SUM(sss_contribution + pagibig_contribution + philhealth_contribution), 0) as total_benefits,
                    COALESCE(AVG(basic_salary), 0) as avg_salary,
                    COALESCE(AVG(
                        COALESCE(late_deduction, 0)
                        + COALESCE(absence_deduction, 0)
                        + COALESCE(tax, 0)
                        + COALESCE(sss_contribution, 0)
                        + COALESCE(pagibig_contribution, 0)
                        + COALESCE(philhealth_contribution, 0)
                        + COALESCE(cash_advance_deduction, 0)
                        + COALESCE(laptop_loan_deduction, 0)
                        + COALESCE(other_deductions, 0)
                    ), 0) as avg_total_deductions,
                    COALESCE(AVG(sss_contribution + pagibig_contribution + philhealth_contribution), 0) as avg_benefit
                FROM payroll 
                {$baseFilter['where']}";
    $financials = executeAnalyticsPreparedRow($conn, $fin_sql, $baseFilter['types'], $baseFilter['params']);
    $deduction_breakdown = [
        'Late' => analyticsFloat($financials['total_late_deductions'] ?? 0),
        'Absence' => analyticsFloat($financials['total_absence_deductions'] ?? 0),
        'Tax' => analyticsFloat($financials['total_tax_deductions'] ?? 0),
        'SSS' => analyticsFloat($financials['total_sss_deductions'] ?? 0),
        'Pag-IBIG' => analyticsFloat($financials['total_pagibig_deductions'] ?? 0),
        'PhilHealth' => analyticsFloat($financials['total_philhealth_deductions'] ?? 0),
        'Cash Advance' => analyticsFloat($financials['total_cash_advance_deductions'] ?? 0),
        'Laptop Loan' => analyticsFloat($financials['total_laptop_loan_deductions'] ?? 0),
        'Other' => analyticsFloat($financials['total_other_deductions'] ?? 0),
    ];
    $total_deductions = 0.0;
    foreach ($deduction_breakdown as $amount) {
        $total_deductions += (float)$amount;
    }
    
    // 2. Charts Data
    
    // A. Payroll by Month
    $monthly_sql = "SELECT 
                        DATE_FORMAT(pay_period_start, '%Y-%m') as month_key,
                        DATE_FORMAT(pay_period_start, '%b %Y') as month_label,
                        SUM(net_pay) as total
                    FROM payroll 
                    {$baseFilter['where']}
                    GROUP BY DATE_FORMAT(pay_period_start, '%Y-%m'), DATE_FORMAT(pay_period_start, '%b %Y')
                    ORDER BY MIN(pay_period_start)";

    $monthlyRows = executeAnalyticsPreparedRows($conn, $monthly_sql, $baseFilter['types'], $baseFilter['params']);
    $monthly_data = [];
    foreach ($monthlyRows as $row) {
        $monthly_data[] = [
            'month' => $row['month_label'] ?? '',
            'total' => analyticsFloat($row['total'] ?? 0),
        ];
    }
    
    // B. Payroll Breakdown (Salary vs OT vs Benefits vs Others)
    // Using aggregated financials
    $breakdown = [
        'Salary' => analyticsFloat($financials['total_salaries'] ?? 0),
        'Overtime' => analyticsFloat($financials['total_overtime'] ?? 0),
        'Benefits' => analyticsFloat($financials['total_benefits'] ?? 0),
        'Bonus' => analyticsFloat($financials['total_bonus'] ?? 0)
    ];
    
    // C. Payroll by Contract Type
    // Join with employees table
    $contract_sql = "SELECT 
                        e.employment_type,
                        SUM(p.net_pay) as total
                     FROM payroll p
                     JOIN employees e ON p.employee_id = e.employee_id
                     {$payrollFilter['where']}
                     GROUP BY e.employment_type";

    $contract_result = executeAnalyticsPreparedRows($conn, $contract_sql, $payrollFilter['types'], $payrollFilter['params']);
    $contract_data = [];
    foreach ($contract_result as $row) {
        $contract_data[] = [
            'employment_type' => $row['employment_type'] ?: 'Unknown',
            'total' => analyticsFloat($row['total'] ?? 0),
        ];
    }
    
    // D. Payroll by Branch
    $branch_sql = "SELECT 
                    COALESCE(b.branch_name, 'Unassigned') as branch_name,
                    SUM(p.net_pay) as total
                 FROM payroll p
                 JOIN employees e ON p.employee_id = e.employee_id
                 LEFT JOIN branches b ON e.branch_id = b.branch_id
                 {$payrollFilter['where']}
                 GROUP BY b.branch_name";

    $branch_result = executeAnalyticsPreparedRows($conn, $branch_sql, $payrollFilter['types'], $payrollFilter['params']);
    $branch_data = [];
    foreach ($branch_result as $row) {
        $branch_data[] = [
            'branch_name' => $row['branch_name'] ?: 'Unassigned',
            'total' => analyticsFloat($row['total'] ?? 0),
        ];
    }
    
    // E. Deductions by Branch
    $deduction_branch_sql = "SELECT 
                                COALESCE(b.branch_name, 'Unassigned') as branch_name,
                                SUM(
                                    COALESCE(p.late_deduction, 0)
                                    + COALESCE(p.absence_deduction, 0)
                                    + COALESCE(p.tax, 0)
                                    + COALESCE(p.sss_contribution, 0)
                                    + COALESCE(p.pagibig_contribution, 0)
                                    + COALESCE(p.philhealth_contribution, 0)
                                    + COALESCE(p.cash_advance_deduction, 0)
                                    + COALESCE(p.laptop_loan_deduction, 0)
                                    + COALESCE(p.other_deductions, 0)
                                ) as total
                             FROM payroll p
                             JOIN employees e ON p.employee_id = e.employee_id
                             LEFT JOIN branches b ON e.branch_id = b.branch_id
                             {$payrollFilter['where']}
                             GROUP BY b.branch_name";

    $deduction_branch_result = executeAnalyticsPreparedRows($conn, $deduction_branch_sql, $payrollFilter['types'], $payrollFilter['params']);
    $deduction_branch_data = [];
    foreach ($deduction_branch_result as $row) {
        $deduction_branch_data[] = [
            'branch_name' => $row['branch_name'] ?: 'Unassigned',
            'total' => analyticsFloat($row['total'] ?? 0),
        ];
    }

    sendResponse(true, [
        'kpi' => [
            'headcount' => $headcount,
            'total_payroll' => analyticsFloat($financials['total_payroll'] ?? 0),
            'total_salaries' => analyticsFloat($financials['total_salaries'] ?? 0),
            'total_deductions' => analyticsFloat($total_deductions),
            'total_benefits' => analyticsFloat($financials['total_benefits'] ?? 0),
            'avg_salary' => analyticsFloat($financials['avg_salary'] ?? 0),
            'avg_deductions' => analyticsFloat($financials['avg_total_deductions'] ?? 0),
            'avg_benefit' => analyticsFloat($financials['avg_benefit'] ?? 0)
        ],
        'charts' => [
            'monthly' => $monthly_data,
            'breakdown' => $breakdown,
            'deduction_breakdown' => $deduction_breakdown,
            'deduction_branch' => $deduction_branch_data,
            'contract_type' => $contract_data,
            'branch' => $branch_data
        ],
        'filters' => [
            'start' => $period_start !== '' ? $period_start : null,
            'end' => $period_end !== '' ? $period_end : null,
            'branch_id' => $branch_id > 0 ? $branch_id : null,
            'status_scope' => 'finalized_history'
        ],
    ], 'Analytics data retrieved successfully');

} else {
    sendError('Method not allowed', 405);
}

closeDBConnection($conn);
?>
