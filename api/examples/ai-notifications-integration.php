<?php
/**
 * Example: How to integrate AI notifications into existing workflows
 * 
 * This file shows practical examples of adding AI notifications
 * to your current system. Copy the relevant code blocks into
 * your existing API endpoints.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'ai_notifications.php';

// ============================================================================
// EXAMPLE 1: Task Completion - Notify Manager
// ============================================================================
// Add this code to api/tasks.php when task status changes to 'completed'

function notifyManagerOnTaskCompletion($conn, $taskId, $userId) {
    // Get task details
    $stmt = $conn->prepare("
        SELECT t.*, p.name as project_name, c.name as client_name,
               u.first_name, u.last_name, u.email as assigner_email
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN clients c ON p.client_id = c.id
        LEFT JOIN users u ON t.assigned_by = u.id
        WHERE t.id = ?
    ");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) return;
    
    // Get completer details
    $stmt = $conn->prepare("SELECT first_name, last_name FROM users WHERE id = ?");
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $completer = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    // Calculate if completed early
    $wasEarly = false;
    $daysVariance = 0;
    if ($task['due_date']) {
        $dueTime = strtotime($task['due_date']);
        $completedTime = time();
        $wasEarly = $completedTime < $dueTime;
        $daysVariance = floor(abs($dueTime - $completedTime) / 86400);
    }
    
    // Count remaining tasks
    $stmt = $conn->prepare("SELECT COUNT(*) as remaining FROM tasks WHERE project_id = ? AND status != 'Completed'");
    $stmt->bind_param('i', $task['project_id']);
    $stmt->execute();
    $remainingTasks = $stmt->get_result()->fetch_assoc()['remaining'];
    $stmt->close();
    
    // Calculate days until project deadline
    $daysUntilDeadline = 0;
    if ($task['project_deadline']) {
        $daysUntilDeadline = floor((strtotime($task['project_deadline']) - time()) / 86400);
    }
    
    // Build context
    $context = [
        'event_type' => 'task_completed',
        'task_title' => $task['title'],
        'project_name' => $task['project_name'] ?? 'Unknown Project',
        'client_name' => $task['client_name'] ?? '',
        'completed_by_name' => $completer['first_name'] . ' ' . $completer['last_name'],
        'completion_date' => date('Y-m-d'),
        'was_early' => $wasEarly,
        'days_variance' => $daysVariance,
        'remaining_tasks' => $remainingTasks,
        'project_deadline' => $task['project_deadline'],
        'days_until_deadline' => $daysUntilDeadline
    ];
    
    // Create AI notification for manager
    if ($task['assigned_by']) {
        createAINotification(
            $conn,
            'task_completed',
            $task['assigned_by'],
            'manager',
            $context,
            '/projects/detail?id=' . $task['project_id']
        );
    }
}


// ============================================================================
// EXAMPLE 2: Leave Request Submitted - Notify Admin/Manager
// ============================================================================
// Add this to api/leave-requests.php when a new leave request is created

function notifyOnLeaveRequest($conn, $leaveRequestId, $userId) {
    // Get leave request details
    $stmt = $conn->prepare("
        SELECT lr.*, lt.name as leave_type_name,
               u.first_name, u.last_name, u.manager_id, u.branch_id,
               e.department
        FROM leave_request lr
        JOIN leave_types lt ON lr.leave_type_id = lt.leave_type_id
        JOIN users u ON lr.user_id = u.id
        LEFT JOIN employees e ON u.employee_id = e.employee_id
        WHERE lr.leave_request_id = ?
    ");
    $stmt->bind_param('i', $leaveRequestId);
    $stmt->execute();
    $leave = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$leave) return;
    
    // Calculate duration
    $startDate = strtotime($leave['start_date']);
    $endDate = strtotime($leave['end_date']);
    $durationDays = floor(($endDate - $startDate) / 86400) + 1;
    
    // Check team coverage
    $stmt = $conn->prepare("
        SELECT COUNT(DISTINCT u.id) as available
        FROM users u
        LEFT JOIN leave_request lr ON u.id = lr.user_id 
            AND lr.status = 'approved' 
            AND lr.start_date <= ? 
            AND lr.end_date >= ?
        WHERE u.branch_id = ? 
            AND u.id != ?
            AND lr.leave_request_id IS NULL
    ");
    $stmt->bind_param('ssii', $leave['start_date'], $leave['end_date'], $leave['branch_id'], $userId);
    $stmt->execute();
    $availableCoverage = $stmt->get_result()->fetch_assoc()['available'];
    $stmt->close();
    
    // Check for conflicting deadlines
    $conflictingDeadlines = 0; // You can implement this logic
    
    // Build context
    $context = [
        'event_type' => 'leave_requested',
        'employee_name' => $leave['first_name'] . ' ' . $leave['last_name'],
        'department' => $leave['department'] ?? 'Unknown',
        'leave_type' => $leave['leave_type_name'],
        'duration_days' => $durationDays,
        'start_date' => date('M d, Y', $startDate),
        'end_date' => date('M d, Y', $endDate),
        'available_coverage' => $availableCoverage,
        'conflicting_deadlines' => $conflictingDeadlines,
        'pending_tasks_count' => 0 // You can add this
    ];
    
    // Notify all admins
    $stmt = $conn->prepare("SELECT id FROM users WHERE role = 'admin'");
    $stmt->execute();
    $admins = $stmt->get_result();
    while ($admin = $admins->fetch_assoc()) {
        createAINotification(
            $conn,
            'leave_requested',
            $admin['id'],
            'admin',
            $context,
            '/leave-requests'
        );
    }
    $stmt->close();
    
    // Notify manager
    if ($leave['manager_id']) {
        createAINotification(
            $conn,
            'leave_requested',
            $leave['manager_id'],
            'manager',
            $context,
            '/leave-requests'
        );
    }
}


// ============================================================================
// EXAMPLE 3: Payroll Released - Notify Employee
// ============================================================================
// Add this to api/payroll.php when payslip is released

function notifyEmployeeOnPayrollRelease($conn, $payrollId) {
    // Get payroll details
    $stmt = $conn->prepare("
        SELECT p.*, u.id as user_id, u.first_name, u.last_name, u.email
        FROM payroll p
        JOIN users u ON p.user_id = u.id
        WHERE p.payroll_id = ?
    ");
    $stmt->bind_param('i', $payrollId);
    $stmt->execute();
    $payroll = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$payroll) return;
    
    // Build context
    $context = [
        'event_type' => 'payroll_ready',
        'employee_name' => $payroll['first_name'],
        'pay_period_start' => $payroll['period_start'],
        'pay_period_end' => $payroll['period_end'],
        'gross_pay' => $payroll['gross_pay'],
        'total_deductions' => $payroll['total_deductions'],
        'net_pay' => $payroll['net_pay'],
        'overtime_hours' => $payroll['overtime_hours'] ?? 0,
        'days_worked' => $payroll['days_worked'] ?? 0,
        'leave_deductions' => $payroll['leave_deductions'] ?? 0
    ];
    
    // Notify the employee
    createAINotification(
        $conn,
        'payroll_ready',
        $payroll['user_id'],
        'staff',
        $context,
        '/my-payslips'
    );
}


// ============================================================================
// EXAMPLE 4: Task Assigned - Notify Assignee
// ============================================================================
// Add this to api/tasks.php when task is assigned

function notifyOnTaskAssignment($conn, $taskId, $assigneeId) {
    // Get task details
    $stmt = $conn->prepare("
        SELECT t.*, p.name as project_name
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE t.id = ?
    ");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) return;
    
    // Calculate days until due
    $daysUntilDue = 0;
    if ($task['due_date']) {
        $daysUntilDue = floor((strtotime($task['due_date']) - time()) / 86400);
    }
    
    // Get assigner name
    $stmt = $conn->prepare("SELECT first_name, last_name FROM users WHERE id = ?");
    $stmt->bind_param('i', $task['assigned_by']);
    $stmt->execute();
    $assigner = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    // Build context
    $context = [
        'event_type' => 'task_assigned',
        'task_title' => $task['title'],
        'task_priority' => $task['priority'] ?? 'Medium',
        'project_name' => $task['project_name'] ?? '',
        'due_date' => $task['due_date'],
        'days_until_due' => $daysUntilDue,
        'assigner_name' => $assigner['first_name'] . ' ' . $assigner['last_name']
    ];
    
    // Notify the assignee
    createAINotification(
        $conn,
        'task_assigned',
        $assigneeId,
        'staff',
        $context,
        '/my-tasks'
    );
}


// ============================================================================
// EXAMPLE 5: Project Milestone - Notify Team
// ============================================================================
// Add this when project reaches a milestone

function notifyTeamOnMilestone($conn, $projectId, $milestoneName) {
    // Get project details
    $stmt = $conn->prepare("
        SELECT p.*, c.name as client_name,
               (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'Completed') as completed_tasks,
               (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as total_tasks
        FROM projects p
        LEFT JOIN clients c ON p.client_id = c.id
        WHERE p.id = ?
    ");
    $stmt->bind_param('i', $projectId);
    $stmt->execute();
    $project = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$project) return;
    
    // Calculate completion percentage
    $completionPercentage = 0;
    if ($project['total_tasks'] > 0) {
        $completionPercentage = round(($project['completed_tasks'] / $project['total_tasks']) * 100);
    }
    
    // Build context
    $context = [
        'event_type' => 'project_milestone',
        'project_name' => $project['name'],
        'client_name' => $project['client_name'] ?? '',
        'milestone_name' => $milestoneName,
        'completion_percentage' => $completionPercentage,
        'completed_tasks' => $project['completed_tasks'],
        'total_tasks' => $project['total_tasks'],
        'team_size' => 0 // You can calculate this
    ];
    
    // Get all team members
    $stmt = $conn->prepare("
        SELECT DISTINCT u.id as user_id, u.role
        FROM users u
        JOIN tasks t ON u.id = t.assigned_to
        WHERE t.project_id = ?
    ");
    $stmt->bind_param('i', $projectId);
    $stmt->execute();
    $teamMembers = $stmt->get_result();
    
    // Create batch notifications
    $targets = [];
    while ($member = $teamMembers->fetch_assoc()) {
        $targets[] = [
            'user_id' => $member['user_id'],
            'role' => $member['role']
        ];
    }
    $stmt->close();
    
    $count = createBatchAINotifications(
        $conn,
        'project_milestone',
        $targets,
        $context,
        '/projects/detail?id=' . $projectId
    );
    
    error_log("[AI Notifications] Created {$count} milestone notifications for project {$projectId}");
}


// ============================================================================
// USAGE EXAMPLES
// ============================================================================

// Example usage (uncomment to test):

/*
$conn = getDBConnection();

// Test 1: Task completion
notifyManagerOnTaskCompletion($conn, 123, 456);

// Test 2: Leave request
notifyOnLeaveRequest($conn, 789, 456);

// Test 3: Payroll release
notifyEmployeeOnPayrollRelease($conn, 101);

// Test 4: Task assignment
notifyOnTaskAssignment($conn, 123, 456);

// Test 5: Project milestone
notifyTeamOnMilestone($conn, 10, 'Phase 1 Complete');

echo "AI notifications created successfully!";
*/
