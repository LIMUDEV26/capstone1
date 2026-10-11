<?php
header('Content-Type: application/json');
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';
setCORSHeaders();

$conn = getDBConnection();
requireAuth();

// ── Authorization (Phase 3 — finding H3 "IDOR in analytics.php") ─────────────
// `?user_id=` was previously honoured for any authenticated caller, so a staff
// user could read a colleague's task metrics just by guessing an id. Only
// admin/manager may scope the figures to somebody else; every other role is
// pinned to its own id.
$sessionUserId = (int)($_SESSION['user_id'] ?? 0);
$sessionRole   = strtolower(trim((string)($_SESSION['role'] ?? '')));
$isPrivileged  = in_array($sessionRole, ['admin', 'manager'], true);

try {
    // Get optional parameters
    $requestedUserId = isset($_GET['user_id']) ? (int)$_GET['user_id'] : 0;
    if ($requestedUserId > 0 && !$isPrivileged && $requestedUserId !== $sessionUserId) {
        sendError('Forbidden: you may only view analytics scoped to your own account.', 403);
    }
    $userId = $requestedUserId > 0 ? $requestedUserId : null;
    $period = isset($_GET['period']) ? strtolower(trim((string)$_GET['period'])) : 'week';
    if (!in_array($period, ['week', 'month', 'year'], true)) {
        $period = 'week';
    }
    
    // Determine date range based on period.
    // Specific month (?month=YYYY-MM) and year (?year=YYYY) pin the window to
    // that calendar month/year; otherwise a relative window is used.
    $today = new DateTime('today');
    $start = clone $today;
    $end = clone $today;
    $bucket = 'day';

    $monthParam = isset($_GET['month']) ? trim((string)$_GET['month']) : '';
    $yearParam = isset($_GET['year']) ? trim((string)$_GET['year']) : '';

    if (preg_match('/^(\d{4})-(\d{2})$/', $monthParam, $m) && (int)$m[2] >= 1 && (int)$m[2] <= 12) {
        $period = 'month';
        $start = new DateTime(sprintf('%04d-%02d-01', (int)$m[1], (int)$m[2]));
        $end = (clone $start)->modify('last day of this month');
        if ($end > $today) $end = clone $today;
    } elseif (preg_match('/^(\d{4})$/', $yearParam, $y)) {
        $period = 'year';
        $bucket = 'month';
        $start = new DateTime(sprintf('%04d-01-01', (int)$y[1]));
        $end = new DateTime(sprintf('%04d-12-01', (int)$y[1]));
        $thisYear = (int)$today->format('Y');
        if ((int)$y[1] >= $thisYear) {
            $end = (clone $today)->modify('first day of this month');
        }
    } else {
        switch ($period) {
            case 'month':
                $start->modify('-30 days');
                break;
            case 'year':
                $bucket = 'month';
                $start->modify('-12 months');
                $start->modify('first day of this month');
                $end = (clone $today)->modify('first day of this month');
                break;
            case 'week':
            default:
                $period = 'week';
                $start->modify('-6 days');
                break;
        }
    }
    
    // Build WHERE clause for user-specific queries
    $userWhere = $userId ? " AND assigned_to = ?" : "";
    
    // Basic counts
    $counts = [
        'total_users' => 0,
        'total_projects' => 0,
        'total_clients' => 0,
        'tasks_total' => 0,
        'tasks_pending' => 0,
        'tasks_in_progress' => 0,
        'tasks_completed' => 0,
        'payroll_pending' => 0,
    ];

    // Total users
    if ($res = $conn->query("SELECT COUNT(*) AS c FROM users")) {
        $row = $res->fetch_assoc();
        $counts['total_users'] = (int)$row['c'];
        $res->close();
    }

    // Total projects
    if ($res = $conn->query("SELECT COUNT(*) AS c FROM projects")) {
        $row = $res->fetch_assoc();
        $counts['total_projects'] = (int)$row['c'];
        $res->close();
    }

    // Total clients (table name is `client` per schema)
    if ($res = $conn->query("SELECT COUNT(*) AS c FROM client")) {
        $row = $res->fetch_assoc();
        $counts['total_clients'] = (int)($row['c'] ?? 0);
        $res->close();
    }

    // Tasks breakdown
    if ($res = $conn->query("SELECT COUNT(*) AS c FROM tasks")) {
        $row = $res->fetch_assoc();
        $counts['tasks_total'] = (int)($row['c'] ?? 0);
        $res->close();
    }

    if ($res = $conn->query("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status")) {
        while ($row = $res->fetch_assoc()) {
            $status = $row['status'] ?? '';
            $c = (int)($row['c'] ?? 0);
            if ($status === 'pending') $counts['tasks_pending'] = $c;
            if ($status === 'in_progress') $counts['tasks_in_progress'] = $c;
            if ($status === 'completed') $counts['tasks_completed'] = $c;
        }
        $res->close();
    }

    // Payroll pending
    if ($res = $conn->query("SELECT COUNT(*) AS c FROM payroll WHERE status IN ('pending')")) {
        $row = $res->fetch_assoc();
        $counts['payroll_pending'] = (int)($row['c'] ?? 0);
        $res->close();
    }

    // Task activity based on selected period (created and completed per day/week/month)
    $labels = [];
    $created = [];
    $completed = [];

    // Generate date labels based on bucket
    if ($bucket === 'month') {
        // Monthly buckets from the start month through the end month
        $cursor = (clone $start)->modify('first day of this month');
        $lastBucket = (clone $end)->modify('first day of this month');
        while ($cursor <= $lastBucket) {
            $key = $cursor->format('Y-m');
            $labels[$key] = 0;
            $created[$key] = 0;
            $completed[$key] = 0;
            $cursor->modify('+1 month');
        }
    } else {
        // Daily buckets across the window
        for ($d = clone $start; $d <= $end; $d->modify('+1 day')) {
            $key = $d->format('Y-m-d');
            $labels[$key] = 0;
            $created[$key] = 0;
            $completed[$key] = 0;
        }
    }

    // Created per day/month
    $dateFormat = $bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
    $startStr = $start->format('Y-m-d 00:00:00');
    $endStr = $end->format('Y-m-d 23:59:59');
    $sqlCreated = "SELECT DATE_FORMAT(created_at, '{$dateFormat}') as d, COUNT(*) as c 
                   FROM tasks 
                   WHERE created_at >= ? AND created_at <= ?{$userWhere} 
                   GROUP BY DATE_FORMAT(created_at, '{$dateFormat}')";
    
    if ($stmt = $conn->prepare($sqlCreated)) {
        $startStr = $start->format('Y-m-d 00:00:00');
        if ($userId) {
            $stmt->bind_param('ssi', $startStr, $endStr, $userId);
        } else {
            $stmt->bind_param('ss', $startStr, $endStr);
        }
        $stmt->execute();
        $res = $stmt->get_result();
        while ($row = $res->fetch_assoc()) {
            $k = $row['d'];
            if (isset($created[$k])) $created[$k] = (int)$row['c'];
        }
        $stmt->close();
    }

    // Completed per day/month (approximate using updated_at when status is completed)
    $sqlCompleted = "SELECT DATE_FORMAT(updated_at, '{$dateFormat}') as d, COUNT(*) as c 
                     FROM tasks 
                     WHERE status = 'completed' AND updated_at >= ? AND updated_at <= ?{$userWhere} 
                     GROUP BY DATE_FORMAT(updated_at, '{$dateFormat}')";
    
    if ($stmt = $conn->prepare($sqlCompleted)) {
        $startStr = $start->format('Y-m-d 00:00:00');
        if ($userId) {
            $stmt->bind_param('ssi', $startStr, $endStr, $userId);
        } else {
            $stmt->bind_param('ss', $startStr, $endStr);
        }
        $stmt->execute();
        $res = $stmt->get_result();
        while ($row = $res->fetch_assoc()) {
            $k = $row['d'];
            if (isset($completed[$k])) $completed[$k] = (int)$row['c'];
        }
        $stmt->close();
    }

    // Compose response
    $trend = [];
    foreach ($labels as $d => $_) {
        $trend[] = [
            'date' => $d,
            'created' => $created[$d],
            'completed' => $completed[$d],
        ];
    }

    // Task Distribution for the same period: tasks created inside the window,
    // grouped by current status (respects user_id scoping like the trend).
    $distribution = [
        'pending' => 0,
        'in_progress' => 0,
        'completed' => 0,
        'total' => 0,
    ];
    $sqlDistribution = "SELECT status, COUNT(*) as c
                        FROM tasks
                        WHERE created_at >= ? AND created_at <= ?{$userWhere}
                        GROUP BY status";
    if ($stmt = $conn->prepare($sqlDistribution)) {
        $startStr = $start->format('Y-m-d 00:00:00');
        if ($userId) {
            $stmt->bind_param('ssi', $startStr, $endStr, $userId);
        } else {
            $stmt->bind_param('ss', $startStr, $endStr);
        }
        $stmt->execute();
        $res = $stmt->get_result();
        while ($row = $res->fetch_assoc()) {
            $status = (string)($row['status'] ?? '');
            $c = (int)($row['c'] ?? 0);
            if ($status === 'pending') $distribution['pending'] = $c;
            elseif ($status === 'in_progress') $distribution['in_progress'] = $c;
            elseif ($status === 'completed') $distribution['completed'] = $c;
            $distribution['total'] += $c;
        }
        $stmt->close();
    }

    echo json_encode([
        'success' => true,
        'data' => [
            'counts' => $counts,
            'trend' => $trend,
            'distribution' => $distribution,
            'period' => $period,
            'bucket' => $bucket,
        ]
    ]);
} catch (Throwable $e) {
    // Error hygiene (Phase 5 — finding H4): never echo internal exception text
    // to the client; it can carry SQL fragments and absolute paths.
    error_log('analytics.php failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Unable to retrieve analytics data.']);
} finally {
    closeDBConnection($conn);
}
