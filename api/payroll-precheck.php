<?php
/**
 * Payroll Pre-check API (Phase 1 MVP)
 * Flags anomalies before payroll finalization.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
if ($method !== 'GET') {
    sendError('Method not allowed', 405);
}

requireFeatureAccess('payroll_precheck', ['admin', 'manager']);

$conn = getDBConnection();
ensurePhaseOneTables($conn);
ensureAttendanceRecordsTable($conn);

function ensureAttendanceRecordsTable($conn) {
    $conn->query(
        "CREATE TABLE IF NOT EXISTS attendance_records (
            id INT AUTO_INCREMENT PRIMARY KEY,
            employee_id INT NOT NULL,
            pay_period_start DATE NOT NULL,
            pay_period_end DATE NOT NULL,
            days_worked DECIMAL(5,2) DEFAULT 0,
            overtime_hours DECIMAL(5,2) DEFAULT 0,
            late_minutes INT DEFAULT 0,
            absent_days DECIMAL(5,2) DEFAULT 0,
            leave_days DECIMAL(5,2) DEFAULT 0,
            import_batch_id VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_attendance_employee (employee_id),
            INDEX idx_attendance_period (pay_period_start, pay_period_end),
            INDEX idx_attendance_batch (import_batch_id),
            CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function getDefaultCurrentPayPeriod() {
    $now = new DateTime('now');
    $year = intval($now->format('Y'));
    $month = intval($now->format('m'));
    $day = intval($now->format('d'));

    if ($day <= 15) {
        $start = new DateTime(sprintf('%04d-%02d-01', $year, $month));
        $end = new DateTime(sprintf('%04d-%02d-15', $year, $month));
    } else {
        $start = new DateTime(sprintf('%04d-%02d-16', $year, $month));
        $end = new DateTime(sprintf('%04d-%02d-%02d', $year, $month, intval($now->format('t'))));
    }

    return [
        'start' => $start->format('Y-m-d'),
        'end' => $end->format('Y-m-d'),
    ];
}

function addAnomaly(&$list, $anomaly) {
    if (!is_array($anomaly)) return;
    $list[] = $anomaly;
}

$period = getDefaultCurrentPayPeriod();
$payPeriodStart = trim((string)($_GET['pay_period_start'] ?? $period['start']));
$payPeriodEnd = trim((string)($_GET['pay_period_end'] ?? $period['end']));

if (!validateDate($payPeriodStart) || !validateDate($payPeriodEnd)) {
    sendError('Invalid pay period dates. Expected YYYY-MM-DD.', 400);
}
if (strtotime($payPeriodEnd) < strtotime($payPeriodStart)) {
    sendError('pay_period_end cannot be earlier than pay_period_start.', 400);
}

$otThreshold = isset($_GET['ot_threshold']) ? max(1, floatval($_GET['ot_threshold'])) : 20.0;
$queueResults = !isset($_GET['queue']) || intval($_GET['queue']) !== 0;
$currentUserId = intval($_SESSION['user_id'] ?? 0);

$anomalies = [];

// 1) Missing logs: active employees without attendance rows for selected period.
$missingSql = "SELECT e.employee_id,
                      CONCAT(e.first_name, ' ', e.last_name) AS employee_name
               FROM employees e
               LEFT JOIN attendance_records ar
                      ON ar.employee_id = e.employee_id
                     AND ar.pay_period_start = ?
                     AND ar.pay_period_end = ?
               WHERE LOWER(COALESCE(e.status, 'active')) = 'active'
                 AND ar.id IS NULL
               ORDER BY e.employee_id ASC
               LIMIT 500";
$missingStmt = $conn->prepare($missingSql);
if ($missingStmt) {
    $missingStmt->bind_param('ss', $payPeriodStart, $payPeriodEnd);
    $missingStmt->execute();
    $missingResult = $missingStmt->get_result();
    while ($row = $missingResult->fetch_assoc()) {
        $employeeId = intval($row['employee_id'] ?? 0);
        $employeeName = trim((string)($row['employee_name'] ?? ''));
        if ($employeeName === '') $employeeName = 'Employee #' . $employeeId;
        $anomalyId = 'missing-log-' . $employeeId . '-' . $payPeriodStart . '-' . $payPeriodEnd;

        addAnomaly($anomalies, [
            'anomaly_id' => $anomalyId,
            'type' => 'missing_logs',
            'severity' => 'high',
            'employee_id' => $employeeId,
            'employee_name' => $employeeName,
            'source_record_id' => null,
            'title' => 'Missing attendance log',
            'details' => $employeeName . ' has no attendance record for ' . $payPeriodStart . ' to ' . $payPeriodEnd . '.',
            'recommended_action' => 'Upload attendance log or validate approved absences before payroll run.',
        ]);

        if ($queueResults) {
            upsertExceptionQueue(
                $conn,
                'payroll_precheck',
                $anomalyId,
                'Missing attendance log',
                $employeeName . ' has no attendance record for ' . $payPeriodStart . ' to ' . $payPeriodEnd . '.',
                'high',
                'admin',
                [
                    'type' => 'missing_logs',
                    'employee_id' => $employeeId,
                    'pay_period_start' => $payPeriodStart,
                    'pay_period_end' => $payPeriodEnd,
                ],
                $currentUserId > 0 ? $currentUserId : null
            );
        }
    }
    $missingStmt->close();
}

// 2) Overtime outliers: attendance overtime above threshold.
$otSql = "SELECT ar.id,
                 ar.employee_id,
                 ar.overtime_hours,
                 ar.import_batch_id,
                 CONCAT(e.first_name, ' ', e.last_name) AS employee_name
          FROM attendance_records ar
          INNER JOIN employees e ON e.employee_id = ar.employee_id
          WHERE ar.pay_period_start = ?
            AND ar.pay_period_end = ?
            AND ar.overtime_hours > ?
          ORDER BY ar.overtime_hours DESC, ar.employee_id ASC
          LIMIT 500";
$otStmt = $conn->prepare($otSql);
if ($otStmt) {
    $otStmt->bind_param('ssd', $payPeriodStart, $payPeriodEnd, $otThreshold);
    $otStmt->execute();
    $otResult = $otStmt->get_result();
    while ($row = $otResult->fetch_assoc()) {
        $attendanceId = intval($row['id'] ?? 0);
        $employeeId = intval($row['employee_id'] ?? 0);
        $employeeName = trim((string)($row['employee_name'] ?? ''));
        if ($employeeName === '') $employeeName = 'Employee #' . $employeeId;
        $hours = floatval($row['overtime_hours'] ?? 0);
        $severity = $hours >= ($otThreshold * 2) ? 'critical' : 'high';
        $anomalyId = 'ot-outlier-' . $attendanceId;

        addAnomaly($anomalies, [
            'anomaly_id' => $anomalyId,
            'type' => 'overtime_outlier',
            'severity' => $severity,
            'employee_id' => $employeeId,
            'employee_name' => $employeeName,
            'source_record_id' => $attendanceId,
            'title' => 'Overtime outlier',
            'details' => $employeeName . ' logged ' . number_format($hours, 2) . ' overtime hours (threshold: ' . number_format($otThreshold, 2) . ').',
            'recommended_action' => 'Review overtime request and manager approval before payroll release.',
        ]);

        if ($queueResults) {
            upsertExceptionQueue(
                $conn,
                'payroll_precheck',
                $anomalyId,
                'Overtime outlier detected',
                $employeeName . ' logged ' . number_format($hours, 2) . ' overtime hours (threshold: ' . number_format($otThreshold, 2) . ').',
                $severity,
                'admin',
                [
                    'type' => 'overtime_outlier',
                    'attendance_id' => $attendanceId,
                    'employee_id' => $employeeId,
                    'overtime_hours' => $hours,
                    'threshold' => $otThreshold,
                    'import_batch_id' => (string)($row['import_batch_id'] ?? ''),
                    'pay_period_start' => $payPeriodStart,
                    'pay_period_end' => $payPeriodEnd,
                ],
                $currentUserId > 0 ? $currentUserId : null
            );
        }
    }
    $otStmt->close();
}

// 3) Unresolved leaves: pending leave requests overlapping the payroll period.
$leaveSql = "SELECT lr.leave_request_id,
                    lr.employee_id,
                    lr.leave_type,
                    lr.start_date,
                    lr.end_date,
                    lr.created_at,
                    CONCAT(e.first_name, ' ', e.last_name) AS employee_name
             FROM leave_request lr
             INNER JOIN employees e ON e.employee_id = lr.employee_id
             WHERE LOWER(lr.status) = 'pending'
               AND lr.start_date <= ?
               AND lr.end_date >= ?
             ORDER BY lr.created_at DESC
             LIMIT 500";
$leaveStmt = $conn->prepare($leaveSql);
if ($leaveStmt) {
    $leaveStmt->bind_param('ss', $payPeriodEnd, $payPeriodStart);
    $leaveStmt->execute();
    $leaveResult = $leaveStmt->get_result();
    while ($row = $leaveResult->fetch_assoc()) {
        $leaveId = intval($row['leave_request_id'] ?? 0);
        $employeeId = intval($row['employee_id'] ?? 0);
        $employeeName = trim((string)($row['employee_name'] ?? ''));
        if ($employeeName === '') $employeeName = 'Employee #' . $employeeId;
        $anomalyId = 'pending-leave-' . $leaveId;

        addAnomaly($anomalies, [
            'anomaly_id' => $anomalyId,
            'type' => 'unresolved_leave',
            'severity' => 'medium',
            'employee_id' => $employeeId,
            'employee_name' => $employeeName,
            'source_record_id' => $leaveId,
            'title' => 'Unresolved leave request',
            'details' => $employeeName . ' has a pending ' . strtoupper((string)($row['leave_type'] ?? 'leave')) . ' request overlapping this pay period.',
            'recommended_action' => 'Resolve the leave request before payroll final approval.',
        ]);

        if ($queueResults) {
            upsertExceptionQueue(
                $conn,
                'payroll_precheck',
                $anomalyId,
                'Pending leave overlaps payroll period',
                $employeeName . ' has a pending leave request overlapping this payroll period.',
                'medium',
                'admin',
                [
                    'type' => 'unresolved_leave',
                    'leave_request_id' => $leaveId,
                    'employee_id' => $employeeId,
                    'leave_type' => (string)($row['leave_type'] ?? ''),
                    'start_date' => (string)($row['start_date'] ?? ''),
                    'end_date' => (string)($row['end_date'] ?? ''),
                    'pay_period_start' => $payPeriodStart,
                    'pay_period_end' => $payPeriodEnd,
                ],
                $currentUserId > 0 ? $currentUserId : null
            );
        }
    }
    $leaveStmt->close();
}

$summary = [
    'period' => [
        'pay_period_start' => $payPeriodStart,
        'pay_period_end' => $payPeriodEnd,
        'ot_threshold' => $otThreshold,
    ],
    'total_anomalies' => count($anomalies),
    'missing_logs' => 0,
    'overtime_outliers' => 0,
    'unresolved_leaves' => 0,
    'severity' => [
        'low' => 0,
        'medium' => 0,
        'high' => 0,
        'critical' => 0,
    ],
];

foreach ($anomalies as $anomaly) {
    $type = strtolower((string)($anomaly['type'] ?? ''));
    if ($type === 'missing_logs') $summary['missing_logs'] += 1;
    if ($type === 'overtime_outlier') $summary['overtime_outliers'] += 1;
    if ($type === 'unresolved_leave') $summary['unresolved_leaves'] += 1;

    $severity = strtolower((string)($anomaly['severity'] ?? 'medium'));
    if (isset($summary['severity'][$severity])) {
        $summary['severity'][$severity] += 1;
    }
}

if ($currentUserId > 0) {
    logActivity(
        $conn,
        $currentUserId,
        'run_payroll_precheck',
        'Ran payroll pre-check for ' . $payPeriodStart . ' to ' . $payPeriodEnd . ' (' . count($anomalies) . ' anomaly/anomalies)',
        'payroll_management'
    );
    logAuditTrail(
        $conn,
        $currentUserId,
        'payroll_precheck',
        $payPeriodStart . '_' . $payPeriodEnd,
        'scan',
        null,
        [
            'summary' => $summary,
            'queued' => $queueResults ? 1 : 0,
        ],
        basename(__FILE__)
    );
}

sendResponse(true, [
    'summary' => $summary,
    'anomalies' => $anomalies,
], 'Payroll pre-check completed successfully');

closeDBConnection($conn);
?>
