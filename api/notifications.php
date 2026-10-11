<?php
/**
 * Notifications API
 * Aggregates contextual reminders/updates for the currently authenticated user.
 * Now includes AI-powered smart notifications via Base44
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'edit_request_utils.php';
require_once 'ai_notifications.php';

setCORSHeaders();

$method = getRequestMethod();
if ($method !== 'GET') {
    sendError('Method not allowed', 405);
}

$conn = getDBConnection();
ensurePhaseOneTables($conn);
ensureTaskCollaboratorsTable($conn);
ensureTaskAssignmentEventsTable($conn);
ensureTaskDeadlineReminderColumn($conn);
ensureLeaveRequestCommentsTable($conn);
ensureAINotificationsTable($conn);
requireAuth();

$userId = intval($_SESSION['user_id'] ?? 0);
$role = strtolower((string)($_SESSION['role'] ?? ''));
$branchId = profileEditResolveBranchId($conn, $userId);

if ($userId <= 0) {
    sendError('Authentication required', 401);
}

function ensureAINotificationsTable($conn) {
    // Ensure AI notifications table exists
    $sql = "CREATE TABLE IF NOT EXISTS ai_notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                event_type VARCHAR(50) NOT NULL,
                target_user_id INT NOT NULL,
                target_role ENUM('admin', 'manager', 'staff') NOT NULL,
                ai_message TEXT NOT NULL,
                icon_emoji VARCHAR(10) DEFAULT '🔔',
                priority_score INT DEFAULT 5,
                suggested_action VARCHAR(255),
                action_url VARCHAR(500),
                context_json JSON,
                is_sent BOOLEAN DEFAULT FALSE,
                sent_at TIMESTAMP NULL,
                read_at TIMESTAMP NULL,
                expires_at TIMESTAMP NULL,
                source ENUM('base44_ai', 'fallback', 'manual') DEFAULT 'base44_ai',
                user_rating INT NULL,
                was_action_taken BOOLEAN DEFAULT FALSE,
                dismissed BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_target_user (target_user_id, is_sent, created_at),
                INDEX idx_event_type (event_type, created_at),
                INDEX idx_target_role (target_role, created_at),
                INDEX idx_priority (priority_score DESC, created_at),
                INDEX idx_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log('[AI Notifications] Failed to create table: ' . $conn->error);
    }
}

function ensureTaskCollaboratorsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS task_collaborators (
                collaborator_id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                user_id INT NOT NULL,
                shift_mode ENUM('none', 'current_time', 'range') NOT NULL DEFAULT 'none',
                shift_start DATETIME NULL,
                shift_end DATETIME NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_task_collaborator (task_id, user_id),
                KEY idx_task_collaborators_user (user_id),
                KEY idx_task_collaborators_shift_start (shift_start),
                CONSTRAINT fk_task_collaborators_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_collaborators_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_collaborators_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize task collaborators storage.', 500);
    }
}

function ensureTaskAssignmentEventsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS task_assignment_event (
                event_id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                previous_assigned_to INT NULL,
                new_assigned_to INT NOT NULL,
                assigned_by INT NULL,
                event_kind ENUM('assigned', 'reassigned') NOT NULL DEFAULT 'assigned',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_task_assignment_new_user (new_assigned_to, created_at),
                KEY idx_task_assignment_created (created_at),
                KEY idx_task_assignment_task (task_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize task assignment events storage.', 500);
    }
}

function notificationColumnExists($conn, $table, $column) {
    $safeTable = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    $safeColumn = preg_replace('/[^A-Za-z0-9_]/', '', (string)$column);
    if ($safeTable === '' || $safeColumn === '') return false;

    $stmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1"
    );
    if (!$stmt) return false;

    $stmt->bind_param('ss', $safeTable, $safeColumn);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();

    return $exists;
}

function ensureTaskDeadlineReminderColumn($conn) {
    if (notificationColumnExists($conn, 'tasks', 'deadline_reminder_at')) {
        return;
    }

    if (!$conn->query("ALTER TABLE tasks ADD COLUMN deadline_reminder_at DATETIME NULL AFTER due_date")) {
        error_log($conn->error);
        sendError('Failed to initialize task deadline reminder storage.', 500);
    }
}

function ensureLeaveRequestCommentsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS leave_request_comment (
                comment_id INT AUTO_INCREMENT PRIMARY KEY,
                leave_request_id INT NOT NULL,
                user_id INT NOT NULL,
                parent_comment_id INT NULL,
                comment_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_leave_comment_request FOREIGN KEY (leave_request_id) REFERENCES leave_request(leave_request_id) ON DELETE CASCADE,
                CONSTRAINT fk_leave_comment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_leave_comment_parent FOREIGN KEY (parent_comment_id) REFERENCES leave_request_comment(comment_id) ON DELETE SET NULL,
                INDEX idx_leave_comment_request (leave_request_id),
                INDEX idx_leave_comment_parent (parent_comment_id),
                INDEX idx_leave_comment_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize leave request comments storage.', 500);
    }
}

function resolveCurrentEmployeeId($conn, $userId) {
    $sessionEmployeeId = intval($_SESSION['employee_id'] ?? 0);
    if ($sessionEmployeeId > 0) return $sessionEmployeeId;

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

function buildNotificationId($type, $title, $message, $occurredAt, $link = '', $sourceKey = '') {
    $payload = implode('|', [
        trim((string)$type),
        trim((string)$title),
        trim((string)$message),
        trim((string)$occurredAt),
        trim((string)$link),
        trim((string)$sourceKey),
    ]);

    return substr(hash('sha256', $payload), 0, 24);
}

function addNotification(&$items, $type, $title, $message, $occurredAt, $severity = 'info', $link = '', $sourceKey = '', $readKey = '', $meta = null, $userRole = '') {
    $id = buildNotificationId($type, $title, $message, $occurredAt, $link, $sourceKey);
    $resolvedReadKey = trim((string)$readKey);
    if ($resolvedReadKey === '') {
        $resolvedReadKey = trim((string)$sourceKey);
    }
    if ($resolvedReadKey === '') {
        $resolvedReadKey = $id;
    }

    $payload = [
        'id' => $id,
        'read_key' => $resolvedReadKey,
        'type' => (string)$type,
        'title' => (string)$title,
        'message' => (string)$message,
        'severity' => (string)$severity,
        'occurred_at' => (string)$occurredAt,
        'link' => (string)$link,
    ];

    $resolvedRole = strtolower(trim((string)$userRole));
    if ($resolvedRole !== '') {
        $payload['user_role'] = $resolvedRole;
    }

    if (is_array($meta) && !empty($meta)) {
        $payload['meta'] = $meta;
    }

    $items[] = $payload;
}

function notificationPreview($value, $limit = 90) {
    $text = trim((string)$value);
    if ($text === '') return '';
    if (function_exists('mb_strlen') && function_exists('mb_substr')) {
        if (mb_strlen($text) > $limit) {
            return mb_substr($text, 0, max(0, $limit - 3)) . '...';
        }
        return $text;
    }
    if (strlen($text) > $limit) {
        return substr($text, 0, max(0, $limit - 3)) . '...';
    }
    return $text;
}

$employeeId = resolveCurrentEmployeeId($conn, $userId);
$items = [];
$today = date('Y-m-d');
$todayTs = strtotime($today);

// Configured pre-deadline reminders for admins, project managers, creators, assignees, and collaborators.
$deadlineReminderStmt = $conn->prepare(
    "SELECT DISTINCT t.id,
            t.project_id,
            t.title,
            t.status,
            t.due_date,
            t.deadline_reminder_at,
            p.name AS project_name,
            CASE WHEN t.assigned_to = ? THEN 1 ELSE 0 END AS is_primary_assignee,
            CASE WHEN tc.user_id IS NULL THEN 0 ELSE 1 END AS is_collaborator
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN task_collaborators tc
            ON tc.task_id = t.id
           AND tc.user_id = ?
     WHERE t.status IN ('pending', 'in_progress')
       AND t.deadline_reminder_at IS NOT NULL
       AND t.deadline_reminder_at <= NOW()
       AND (t.due_date IS NULL OR t.due_date >= NOW())
       AND (? = 1 OR p.manager_id = ? OR t.created_by = ? OR t.assigned_to = ? OR tc.user_id = ?)
     ORDER BY t.due_date ASC, t.deadline_reminder_at ASC
     LIMIT 80"
);
if ($deadlineReminderStmt) {
    $isAdminForDeadlineReminder = $role === 'admin' ? 1 : 0;
    $deadlineReminderStmt->bind_param('iiiiiii', $userId, $userId, $isAdminForDeadlineReminder, $userId, $userId, $userId, $userId);
    $deadlineReminderStmt->execute();
    $deadlineReminderResult = $deadlineReminderStmt->get_result();
    while ($row = $deadlineReminderResult->fetch_assoc()) {
        $dueDate = trim((string)($row['due_date'] ?? ''));
        $dueTs = $dueDate !== '' ? strtotime($dueDate) : false;
        $reminderRaw = trim((string)($row['deadline_reminder_at'] ?? ''));
        $reminderTs = $reminderRaw !== '' ? strtotime($reminderRaw) : time();
        $projectName = trim((string)($row['project_name'] ?? ''));
        $daysUntilDue = $dueTs ? max(0, (int)ceil(($dueTs - time()) / 86400)) : null;
        $audienceNote = '';

        if ($role === 'admin') {
            $audienceNote = ' Admin alert.';
        } elseif (intval($row['is_primary_assignee'] ?? 0) === 1) {
            $audienceNote = ' Assigned task reminder.';
        } elseif (intval($row['is_collaborator'] ?? 0) === 1) {
            $audienceNote = ' Collaborator reminder.';
        } else {
            $audienceNote = ' Manager alert.';
        }

        $dueLabel = $dueTs ? date('M d, Y g:i A', $dueTs) : 'No due date set';
        $message = 'Deadline reminder: ' . $row['title'] . ' is approaching. Due: ' . $dueLabel . '.';
        if ($daysUntilDue !== null) {
            $message .= ' ' . $daysUntilDue . ' day(s) remaining.';
        }
        if ($projectName !== '') {
            $message .= ' Project: ' . $projectName . '.';
        }
        $message .= $audienceNote;

        addNotification(
            $items,
            'task',
            'Task Near Deadline',
            $message,
            date('Y-m-d H:i:s', $reminderTs ?: time()),
            ($daysUntilDue !== null && $daysUntilDue <= 1) ? 'high' : 'medium',
            '/my-tasks',
            'task_deadline_reminder:' . intval($row['id']) . ':' . date('YmdHi', $reminderTs ?: time())
        );
    }
    $deadlineReminderStmt->close();
}

// Task due reminders for assigned tasks and collaborator tasks.
$taskStmt = $conn->prepare(
    "SELECT t.id,
            t.project_id,
            t.title,
            t.status,
            t.due_date,
            CASE WHEN t.assigned_to = ? THEN 1 ELSE 0 END AS is_primary_assignee
     FROM tasks t
     LEFT JOIN task_collaborators tc
            ON tc.task_id = t.id
           AND tc.user_id = ?
     WHERE (t.assigned_to = ? OR tc.user_id = ?)
       AND status IN ('pending', 'in_progress')
     ORDER BY (due_date IS NULL), due_date ASC, id DESC
     LIMIT 60"
);
if ($taskStmt) {
    $taskStmt->bind_param('iiii', $userId, $userId, $userId, $userId);
    $taskStmt->execute();
    $taskResult = $taskStmt->get_result();
    while ($row = $taskResult->fetch_assoc()) {
        $dueDate = trim((string)($row['due_date'] ?? ''));
        if ($dueDate === '') continue;

        $dueTs = strtotime($dueDate);
        if ($dueTs === false) continue;
        $deltaDays = (int)floor(($dueTs - $todayTs) / 86400);
        $isPrimary = intval($row['is_primary_assignee'] ?? 0) === 1;
        $collabSuffix = $isPrimary ? '' : ' (collaborator task)';

        if ($deltaDays < 0) {
            addNotification(
                $items,
                'task',
                'Overdue Task',
                $row['title'] . ' is overdue since ' . date('M d, Y', $dueTs) . '.' . $collabSuffix,
                date('Y-m-d H:i:s', $dueTs),
                'high',
                '/my-tasks',
                'task_due:' . intval($row['id']) . ':overdue'
            );
        } elseif ($deltaDays <= 3) {
            addNotification(
                $items,
                'task',
                'Task Due Soon',
                $row['title'] . ' is due on ' . date('M d, Y', $dueTs) . '.' . $collabSuffix,
                date('Y-m-d H:i:s', $dueTs),
                $deltaDays === 0 ? 'high' : 'medium',
                '/my-tasks',
                'task_due:' . intval($row['id']) . ':soon'
            );
        }
    }
    $taskStmt->close();
}

// Direct task assignment and reassignment updates.
$taskAssignmentStmt = $conn->prepare(
    "SELECT tae.event_id,
            tae.task_id,
            tae.event_kind,
            tae.created_at,
            t.title,
            t.project_id,
            t.priority,
            t.due_date,
            p.name AS project_name,
            c.client_name,
            u.id AS assigner_user_id,
            u.role AS assigner_role,
            u.first_name AS assigner_first_name,
            u.last_name AS assigner_last_name,
            u.username AS assigner_username
     FROM task_assignment_event tae
     INNER JOIN tasks t ON t.id = tae.task_id
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN client c ON c.client_id = p.client_id
     LEFT JOIN users u ON u.id = tae.assigned_by
     WHERE tae.new_assigned_to = ?
       AND tae.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     ORDER BY tae.created_at DESC, tae.event_id DESC
     LIMIT 40"
);
if ($taskAssignmentStmt) {
    $taskAssignmentStmt->bind_param('i', $userId);
    $taskAssignmentStmt->execute();
    $taskAssignmentResult = $taskAssignmentStmt->get_result();
    while ($row = $taskAssignmentResult->fetch_assoc()) {
        $eventKind = strtolower(trim((string)($row['event_kind'] ?? 'assigned')));
        $taskTitle = trim((string)($row['title'] ?? 'Untitled Task'));
        $projectName = trim((string)($row['project_name'] ?? 'N/A'));
        $clientName = trim((string)($row['client_name'] ?? 'N/A'));
        $priority = strtolower(trim((string)($row['priority'] ?? 'medium')));
        $priorityLabel = $priority !== '' ? ucwords(str_replace('_', ' ', $priority)) : 'Not set';
        $dueRaw = trim((string)($row['due_date'] ?? ''));
        $dueTs = $dueRaw !== '' ? strtotime($dueRaw) : false;
        $dueLabel = $dueTs ? date('M d, Y', $dueTs) : 'No due date';

        $assignerRole = strtolower(trim((string)($row['assigner_role'] ?? '')));
        $assignerRoleLabel = $assignerRole === 'manager' ? 'Manager' : 'Administrator';
        $assignerName = trim((string)($row['assigner_first_name'] ?? '') . ' ' . (string)($row['assigner_last_name'] ?? ''));
        if ($assignerName === '') {
            $assignerName = trim((string)($row['assigner_username'] ?? ''));
        }
        if ($assignerName === '') {
            $assignerName = $assignerRoleLabel;
        }

        $title = $eventKind === 'reassigned' ? 'Task Reassignment' : 'Task Assignment';
        $message = '"' . $taskTitle . '" was '
            . ($eventKind === 'reassigned' ? 'reassigned' : 'assigned')
            . ' by ' . $assignerName . ' (' . $assignerRoleLabel . '). '
            . 'Project: ' . $projectName . '. Client: ' . $clientName . '. '
            . 'Priority: ' . $priorityLabel . '. Due: ' . $dueLabel . '.';

        $severity = 'info';
        if ($priority === 'high' || $priority === 'urgent') {
            $severity = 'high';
        } elseif ($priority === 'medium') {
            $severity = 'medium';
        }

        // Staff task-assignment notifications always link to My Tasks.
        // The /projects/<id> path does not exist as a Next.js route
        // (project detail is at /projects/detail?id=<id>, admin/manager only).
        $link = '/my-tasks';

        addNotification(
            $items,
            'task',
            $title,
            $message,
            (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
            $severity,
            $link,
            'task_assignment:' . intval($row['event_id'] ?? 0),
            'task_assignment:' . intval($row['event_id'] ?? 0),
            [
                'assignment' => [
                    'kind' => $eventKind,
                    'task_id' => intval($row['task_id'] ?? 0),
                    'task_title' => $taskTitle,
                    'assigned_by_name' => $assignerName,
                    'assigned_by_role' => strtolower($assignerRoleLabel),
                    'project_name' => $projectName,
                    'client_name' => $clientName,
                    'priority' => $priorityLabel,
                    'due_date' => $dueLabel,
                ],
            ],
            $assignerRole
        );
    }
    $taskAssignmentStmt->close();
}

// Collaborator assignment updates.
$taskCollabStmt = $conn->prepare(
    "SELECT tc.task_id,
            tc.shift_mode,
            tc.shift_start,
            tc.shift_end,
            tc.created_at,
            t.title,
            t.project_id
     FROM task_collaborators tc
     INNER JOIN tasks t ON t.id = tc.task_id
     WHERE tc.user_id = ?
       AND tc.created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
     ORDER BY tc.created_at DESC
     LIMIT 25"
);
if ($taskCollabStmt) {
    $taskCollabStmt->bind_param('i', $userId);
    $taskCollabStmt->execute();
    $taskCollabResult = $taskCollabStmt->get_result();
    while ($row = $taskCollabResult->fetch_assoc()) {
        $shiftMode = strtolower((string)($row['shift_mode'] ?? 'none'));
        $message = 'You were added as a collaborator on "' . (string)$row['title'] . '".';
        if ($shiftMode === 'current_time') {
            $shiftStart = trim((string)($row['shift_start'] ?? ''));
            if ($shiftStart !== '') {
                $message .= ' Shift started at ' . date('M d, Y g:i A', strtotime($shiftStart)) . '.';
            }
        } elseif ($shiftMode === 'range') {
            $shiftStart = trim((string)($row['shift_start'] ?? ''));
            $shiftEnd = trim((string)($row['shift_end'] ?? ''));
            if ($shiftStart !== '' && $shiftEnd !== '') {
                $message .= ' Shift window: ' . date('M d, Y g:i A', strtotime($shiftStart)) . ' to ' . date('M d, Y g:i A', strtotime($shiftEnd)) . '.';
            }
        }

        $occurredAt = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
        addNotification(
            $items,
            'task',
            'New Task Collaboration',
            $message,
            $occurredAt,
            'info',
            '/my-tasks',
            'task_collab:' . intval($row['task_id']) . ':' . $occurredAt
        );
    }
    $taskCollabStmt->close();
}

// Task collaborator shift reminders.
$taskShiftStmt = $conn->prepare(
    "SELECT tc.task_id,
            tc.shift_mode,
            tc.shift_start,
            tc.shift_end,
            t.title,
            t.project_id
     FROM task_collaborators tc
     INNER JOIN tasks t ON t.id = tc.task_id
     WHERE tc.user_id = ?
       AND t.status IN ('pending', 'in_progress')
       AND tc.shift_start IS NOT NULL
       AND tc.shift_start >= NOW()
       AND tc.shift_start <= DATE_ADD(NOW(), INTERVAL 7 DAY)
     ORDER BY tc.shift_start ASC
     LIMIT 20"
);
if ($taskShiftStmt) {
    $taskShiftStmt->bind_param('i', $userId);
    $taskShiftStmt->execute();
    $taskShiftResult = $taskShiftStmt->get_result();
    while ($row = $taskShiftResult->fetch_assoc()) {
        $shiftStartRaw = trim((string)($row['shift_start'] ?? ''));
        if ($shiftStartRaw === '') continue;
        $shiftStartTs = strtotime($shiftStartRaw);
        if ($shiftStartTs === false) continue;

        $shiftEndRaw = trim((string)($row['shift_end'] ?? ''));
        $message = 'Task shift for "' . (string)$row['title'] . '" starts on ' . date('M d, Y g:i A', $shiftStartTs) . '.';
        if ($shiftEndRaw !== '') {
            $shiftEndTs = strtotime($shiftEndRaw);
            if ($shiftEndTs !== false) {
                $message = 'Task shift for "' . (string)$row['title'] . '" is scheduled from '
                    . date('M d, Y g:i A', $shiftStartTs)
                    . ' to '
                    . date('M d, Y g:i A', $shiftEndTs)
                    . '.';
            }
        }

        addNotification(
            $items,
            'shift',
            'Task Shift Reminder',
            $message,
            date('Y-m-d H:i:s', $shiftStartTs),
            'info',
            '/my-tasks',
            'task_shift:' . intval($row['task_id']) . ':' . $shiftStartRaw
        );
    }
    $taskShiftStmt->close();
}

// Leave updates for the current employee.
if ($employeeId > 0) {
    $leaveStmt = $conn->prepare(
        "SELECT leave_request_id, leave_type, start_date, end_date, status, approved_at, created_at
         FROM leave_request
         WHERE employee_id = ?
         ORDER BY leave_request_id DESC
         LIMIT 20"
    );
    if ($leaveStmt) {
        $leaveStmt->bind_param('i', $employeeId);
        $leaveStmt->execute();
        $leaveResult = $leaveStmt->get_result();
        while ($row = $leaveResult->fetch_assoc()) {
            $status = strtolower((string)($row['status'] ?? ''));
            if (!in_array($status, ['approved', 'rejected', 'cancelled', 'pending'], true)) continue;

            $startDate = (string)($row['start_date'] ?? '');
            $endDate = (string)($row['end_date'] ?? '');
            $range = $startDate;
            if ($endDate !== '' && $endDate !== $startDate) {
                $range .= ' to ' . $endDate;
            }

            $severity = $status === 'approved' ? 'success' : ($status === 'rejected' ? 'high' : 'info');
            $label = ucfirst($status);
            $occurredAt = (string)($row['approved_at'] ?? $row['created_at'] ?? date('Y-m-d H:i:s'));
            addNotification(
                $items,
                'leave',
                'Leave Request ' . $label,
                strtoupper((string)$row['leave_type']) . ' leave for ' . $range . ' is now ' . $label . '.',
                $occurredAt,
                $severity,
                '/leave-requests?request_id=' . intval($row['leave_request_id']),
                'leave_request:' . intval($row['leave_request_id']) . ':' . $status
            );
        }
        $leaveStmt->close();
    }
}

// Leave comment notifications for request owners (staff/manager) when someone else comments.
if ($employeeId > 0) {
    $commentStmt = $conn->prepare(
        "SELECT c.comment_id,
                c.leave_request_id,
                c.comment_text,
                c.created_at,
                lr.leave_type,
                lr.start_date,
                lr.end_date,
                u.id AS commenter_user_id,
                u.first_name AS commenter_first_name,
                u.last_name AS commenter_last_name,
                u.username AS commenter_username
         FROM leave_request_comment c
         INNER JOIN leave_request lr ON lr.leave_request_id = c.leave_request_id
         INNER JOIN users u ON u.id = c.user_id
         WHERE lr.employee_id = ?
           AND c.user_id <> ?
         ORDER BY c.created_at DESC
         LIMIT 20"
    );
    if ($commentStmt) {
        $commentStmt->bind_param('ii', $employeeId, $userId);
        $commentStmt->execute();
        $commentResult = $commentStmt->get_result();
        while ($row = $commentResult->fetch_assoc()) {
            $commenterName = trim((string)($row['commenter_first_name'] ?? '') . ' ' . (string)($row['commenter_last_name'] ?? ''));
            if ($commenterName === '') {
                $commenterName = (string)($row['commenter_username'] ?? 'A reviewer');
            }

            $range = (string)($row['start_date'] ?? '');
            if (!empty($row['end_date']) && $row['end_date'] !== $row['start_date']) {
                $range .= ' to ' . $row['end_date'];
            }
            $preview = trim((string)($row['comment_text'] ?? ''));
            if (strlen($preview) > 90) {
                $preview = substr($preview, 0, 87) . '...';
            }

            addNotification(
                $items,
                'leave',
                'Leave Request Comment',
                $commenterName . ' commented on your ' . strtoupper((string)$row['leave_type']) . ' leave request (' . $range . '). ' . $preview,
                (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
                'info',
                '/leave-requests?request_id=' . intval($row['leave_request_id']),
                'leave_comment:' . intval($row['comment_id'])
            );
        }
        $commentStmt->close();
    }
}

// Reviewer reminders for new staff/manager comments on pending leave requests.
if (in_array($role, ['manager', 'admin'], true)) {
    $reviewCommentStmt = $conn->prepare(
        "SELECT c.comment_id,
                c.leave_request_id,
                c.comment_text,
                c.created_at,
                lr.employee_id,
                lr.leave_type,
                lr.start_date,
                lr.end_date,
                lr.status,
                e.first_name AS employee_first_name,
                e.last_name AS employee_last_name,
                u.id AS commenter_user_id
         FROM leave_request_comment c
         INNER JOIN leave_request lr ON lr.leave_request_id = c.leave_request_id
         LEFT JOIN employees e ON e.employee_id = lr.employee_id
         INNER JOIN users u ON u.id = c.user_id
         WHERE c.user_id <> ?
           AND LOWER(lr.status) = 'pending'
           AND LOWER(COALESCE(u.role, '')) IN ('staff', 'manager')
         ORDER BY c.created_at DESC
         LIMIT 20"
    );
    if ($reviewCommentStmt) {
        $reviewCommentStmt->bind_param('i', $userId);
        $reviewCommentStmt->execute();
        $reviewCommentResult = $reviewCommentStmt->get_result();
        while ($row = $reviewCommentResult->fetch_assoc()) {
            $employeeName = trim((string)($row['employee_first_name'] ?? '') . ' ' . (string)($row['employee_last_name'] ?? ''));
            if ($employeeName === '') {
                $employeeName = 'Employee #' . intval($row['employee_id'] ?? 0);
            }

            $preview = trim((string)($row['comment_text'] ?? ''));
            if (strlen($preview) > 90) {
                $preview = substr($preview, 0, 87) . '...';
            }

            addNotification(
                $items,
                'approval',
                'Leave Request Reply',
                $employeeName . ' replied on a pending leave request. ' . $preview,
                (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
                'medium',
                '/leave-requests?request_id=' . intval($row['leave_request_id']),
                'leave_review_comment:' . intval($row['comment_id'])
            );
        }
        $reviewCommentStmt->close();
    }
}

// Payslip/payroll updates for the current employee.
if ($employeeId > 0) {
    $cashAdvanceStmt = $conn->prepare(
        "SELECT cash_advance_request_id,
                request_date,
                amount,
                status,
                manager_notes,
                created_at,
                approved_at,
                updated_at
         FROM cash_advance_request
         WHERE employee_id = ?
         ORDER BY cash_advance_request_id DESC
         LIMIT 20"
    );
    if ($cashAdvanceStmt) {
        $cashAdvanceStmt->bind_param('i', $employeeId);
        $cashAdvanceStmt->execute();
        $cashAdvanceResult = $cashAdvanceStmt->get_result();
        while ($row = $cashAdvanceResult->fetch_assoc()) {
            $status = strtolower((string)($row['status'] ?? 'submitted'));
            if (!in_array($status, ['submitted', 'approved', 'rejected', 'cancelled'], true)) continue;

            $severity = 'info';
            if ($status === 'approved') $severity = 'success';
            if ($status === 'rejected') $severity = 'high';
            if ($status === 'submitted') $severity = 'medium';

            $message = 'Cash advance request #' . intval($row['cash_advance_request_id'])
                . ' for PHP ' . number_format((float)($row['amount'] ?? 0), 2)
                . ' on ' . (string)($row['request_date'] ?? '-')
                . ' is now ' . strtoupper($status) . '.';
            $notesPreview = notificationPreview($row['manager_notes'] ?? '');
            if ($notesPreview !== '' && $status !== 'submitted') {
                $message .= ' Note: ' . $notesPreview;
            }

            addNotification(
                $items,
                'payroll',
                'Cash Advance Update',
                $message,
                (string)($row['approved_at'] ?? $row['updated_at'] ?? $row['created_at'] ?? date('Y-m-d H:i:s')),
                $severity,
                '/cash-advance',
                'cash_advance_request:' . intval($row['cash_advance_request_id']) . ':' . $status
            );
        }
        $cashAdvanceStmt->close();
    }
}

if ($employeeId > 0) {
    $overtimeStmt = $conn->prepare(
        "SELECT overtime_request_id,
                work_date,
                hours_requested,
                status,
                manager_notes,
                created_at,
                approved_at,
                updated_at
         FROM overtime_request
         WHERE employee_id = ?
         ORDER BY overtime_request_id DESC
         LIMIT 20"
    );
    if ($overtimeStmt) {
        $overtimeStmt->bind_param('i', $employeeId);
        $overtimeStmt->execute();
        $overtimeResult = $overtimeStmt->get_result();
        while ($row = $overtimeResult->fetch_assoc()) {
            $status = strtolower((string)($row['status'] ?? 'submitted'));
            if (!in_array($status, ['submitted', 'approved', 'rejected', 'cancelled'], true)) continue;

            $severity = 'info';
            if ($status === 'approved') $severity = 'success';
            if ($status === 'rejected') $severity = 'high';
            if ($status === 'submitted') $severity = 'medium';

            $message = 'Overtime request #' . intval($row['overtime_request_id'])
                . ' for ' . rtrim(rtrim(number_format((float)($row['hours_requested'] ?? 0), 2), '0'), '.')
                . ' hour(s) on ' . (string)($row['work_date'] ?? '-')
                . ' is now ' . strtoupper($status) . '.';
            $notesPreview = notificationPreview($row['manager_notes'] ?? '');
            if ($notesPreview !== '' && $status !== 'submitted') {
                $message .= ' Note: ' . $notesPreview;
            }

            addNotification(
                $items,
                'approval',
                'Overtime Request Update',
                $message,
                (string)($row['approved_at'] ?? $row['updated_at'] ?? $row['created_at'] ?? date('Y-m-d H:i:s')),
                $severity,
                '/overtime-requests',
                'overtime_request:' . intval($row['overtime_request_id']) . ':' . $status
            );
        }
        $overtimeStmt->close();
    }
}

if ($employeeId > 0) {
    $payrollStmt = $conn->prepare(
        "SELECT id, pay_period_start, pay_period_end, status, net_pay, created_at
         FROM payroll
         WHERE employee_id = ?
         ORDER BY pay_period_end DESC, id DESC
         LIMIT 10"
    );
    if ($payrollStmt) {
        $payrollStmt->bind_param('i', $employeeId);
        $payrollStmt->execute();
        $payrollResult = $payrollStmt->get_result();
        while ($row = $payrollResult->fetch_assoc()) {
            $status = strtolower((string)($row['status'] ?? 'draft'));
            if ($status === 'draft') continue;

            $periodStart = (string)($row['pay_period_start'] ?? '');
            $periodEnd = (string)($row['pay_period_end'] ?? '');
            $periodText = trim($periodStart . ' - ' . $periodEnd);
            $net = number_format((float)($row['net_pay'] ?? 0), 2);
            addNotification(
                $items,
                'payroll',
                'Payslip Update',
                'Payroll (' . $periodText . ') is ' . strtoupper($status) . '. Net pay: PHP ' . $net . '.',
                (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
                $status === 'approved' || $status === 'paid' ? 'success' : 'info',
                '/my-payslips',
                'payroll:' . intval($row['id']) . ':' . $status
            );
        }
        $payrollStmt->close();
    }
}

// Upcoming shift reminders.
if ($employeeId > 0) {
    $shiftStmt = $conn->prepare(
        "SELECT shift_schedule_id, shift_date, shift_start, shift_end, status
         FROM shift_schedule
         WHERE employee_id = ?
           AND shift_date >= CURDATE()
           AND shift_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
         ORDER BY shift_date ASC, shift_start ASC
         LIMIT 20"
    );
    if ($shiftStmt) {
        $shiftStmt->bind_param('i', $employeeId);
        $shiftStmt->execute();
        $shiftResult = $shiftStmt->get_result();
        while ($row = $shiftResult->fetch_assoc()) {
            $status = strtolower((string)($row['status'] ?? 'scheduled'));
            if ($status !== 'scheduled') continue;

            $shiftTs = strtotime((string)$row['shift_date'] . ' ' . (string)$row['shift_start']);
            if ($shiftTs === false) continue;

            addNotification(
                $items,
                'shift',
                'Upcoming Shift',
                'You have a scheduled shift on ' . date('M d, Y', $shiftTs) . ' (' . (string)$row['shift_start'] . ' - ' . (string)$row['shift_end'] . ').',
                date('Y-m-d H:i:s', $shiftTs),
                'info',
                '/calendar',
                'shift_schedule:' . intval($row['shift_schedule_id']) . ':' . (string)$row['shift_date'] . ':' . (string)$row['shift_start']
            );
        }
        $shiftStmt->close();
    }
}

// Calendar day alerts for EVERYONE (all roles).
// When any calendar entry reaches the current date, every user is notified.
$calendarToday = date('Y-m-d');
// Stable day timestamp: read-state survives reloads within the day, while a
// new day produces a fresh (unread) alert.
$calendarTodayAt = $calendarToday . ' 00:00:00';

// 1) Company events happening today (single-day or multi-day spanning today).
$calTodayStmt = $conn->prepare(
    "SELECT event_id, title, event_date, end_date, start_time, location
     FROM calendar_events
     WHERE event_date <= CURDATE()
       AND (end_date IS NULL OR end_date >= CURDATE())
     ORDER BY event_date ASC, event_id ASC
     LIMIT 20"
);
if ($calTodayStmt) {
    $calTodayStmt->execute();
    $calTodayResult = $calTodayStmt->get_result();
    while ($row = $calTodayResult->fetch_assoc()) {
        $eventTitle = trim((string)($row['title'] ?? ''));
        if ($eventTitle === '') $eventTitle = 'Company event';
        $detailParts = [];
        $timePart = trim((string)($row['start_time'] ?? ''));
        if ($timePart !== '') $detailParts[] = substr($timePart, 0, 5);
        $locPart = trim((string)($row['location'] ?? ''));
        if ($locPart !== '') $detailParts[] = $locPart;
        $detail = $detailParts ? ' (' . implode(' · ', $detailParts) . ')' : '';
        addNotification(
            $items,
            'calendar',
            'Happening Today',
            $eventTitle . ' is scheduled today' . $detail . '.',
            $calendarTodayAt,
            'info',
            '/calendar',
            'calendar_today:event:' . intval($row['event_id']) . ':' . $calendarToday
        );
    }
    $calTodayStmt->close();
}

// 2) Holidays falling today.
$holidayTodayStmt = $conn->prepare(
    "SELECT holiday_id, holiday_name, holiday_type
     FROM holidays
     WHERE holiday_date = CURDATE()
     ORDER BY holiday_name ASC
     LIMIT 10"
);
if ($holidayTodayStmt) {
    $holidayTodayStmt->execute();
    $holidayTodayResult = $holidayTodayStmt->get_result();
    while ($row = $holidayTodayResult->fetch_assoc()) {
        $holidayName = trim((string)($row['holiday_name'] ?? ''));
        if ($holidayName === '') continue;
        $holidayType = trim((string)($row['holiday_type'] ?? ''));
        $typeSuffix = $holidayType !== '' ? ' (' . $holidayType . ')' : '';
        addNotification(
            $items,
            'calendar',
            "Today's Holiday",
            $holidayName . $typeSuffix . ' is today.',
            $calendarTodayAt,
            'info',
            '/calendar',
            'calendar_today:holiday:' . intval($row['holiday_id']) . ':' . $calendarToday
        );
    }
    $holidayTodayStmt->close();
}

// 3) Birthdays of active users falling today.
$birthdayTodayStmt = $conn->prepare(
    "SELECT id, first_name, last_name
     FROM users
     WHERE status = 'active'
       AND date_of_birth IS NOT NULL
       AND MONTH(date_of_birth) = MONTH(CURDATE())
       AND DAY(date_of_birth) = DAY(CURDATE())
     ORDER BY first_name ASC, last_name ASC
     LIMIT 20"
);
if ($birthdayTodayStmt) {
    $birthdayTodayStmt->execute();
    $birthdayTodayResult = $birthdayTodayStmt->get_result();
    while ($row = $birthdayTodayResult->fetch_assoc()) {
        $birthdayName = trim(trim((string)($row['first_name'] ?? '')) . ' ' . trim((string)($row['last_name'] ?? '')));
        if ($birthdayName === '') continue;
        addNotification(
            $items,
            'calendar',
            'Birthday Today',
            "It's " . $birthdayName . "'s birthday today.",
            $calendarTodayAt,
            'info',
            '/calendar',
            'calendar_today:birthday:' . intval($row['id']) . ':' . $calendarToday
        );
    }
    $birthdayTodayStmt->close();
}

// Client activity updates for the shared notification center.
if (in_array($role, ['admin', 'manager', 'staff'], true)) {
    $clientLink = in_array($role, ['admin', 'manager'], true) ? '/clients' : '';
    $clientActivityStmt = $conn->prepare(
        "SELECT action, description, created_at
         FROM activity_log
         WHERE activity_type = 'client_management'
           AND action IN ('create_client', 'update_client', 'archive_client', 'permanent_delete_client')
           AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         ORDER BY created_at DESC
         LIMIT 20"
    );
    if ($clientActivityStmt) {
        $clientActivityStmt->execute();
        $clientActivityResult = $clientActivityStmt->get_result();
        while ($row = $clientActivityResult->fetch_assoc()) {
            $action = strtolower(trim((string)($row['action'] ?? '')));
            $title = 'Client Activity';
            $severity = 'info';

            if ($action === 'create_client') {
                $title = 'New Client Created';
            } elseif ($action === 'update_client') {
                $title = 'Client Updated';
            } elseif ($action === 'archive_client') {
                $title = 'Client Archived';
                $severity = 'medium';
            } elseif ($action === 'permanent_delete_client') {
                $title = 'Client Deleted';
                $severity = 'high';
            }

            $message = trim((string)($row['description'] ?? ''));
            if ($message === '') {
                $message = 'A client record activity was logged in the system.';
            }

            addNotification(
                $items,
                'client',
                $title,
                $message,
                (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
                $severity,
                $clientLink,
                'client_activity:' . substr(hash('sha256', $action . '|' . $message . '|' . (string)($row['created_at'] ?? '')), 0, 24)
            );
        }
        $clientActivityStmt->close();
    }
}

// Admin-only notifications for recent staff/manager activity log events.
if ($role === 'admin') {
    $teamActivityStmt = $conn->prepare(
        "SELECT al.id,
                al.action,
                al.description,
                al.activity_type,
                al.created_at,
                u.id AS actor_user_id,
                u.role AS actor_role,
                u.first_name AS actor_first_name,
                u.last_name AS actor_last_name,
                u.username AS actor_username
         FROM activity_log al
         INNER JOIN users u ON u.id = al.user_id
         WHERE LOWER(COALESCE(u.role, '')) IN ('staff', 'manager')
           AND al.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT 40"
    );
    if ($teamActivityStmt) {
        $teamActivityStmt->execute();
        $teamActivityResult = $teamActivityStmt->get_result();
        while ($row = $teamActivityResult->fetch_assoc()) {
            $actorRole = strtolower(trim((string)($row['actor_role'] ?? 'staff')));
            $actorRoleLabel = $actorRole === 'manager' ? 'Manager' : 'Staff';
            $actorName = trim((string)($row['actor_first_name'] ?? '') . ' ' . (string)($row['actor_last_name'] ?? ''));
            if ($actorName === '') {
                $actorName = trim((string)($row['actor_username'] ?? ''));
            }
            if ($actorName === '') {
                $actorName = 'User #' . intval($row['actor_user_id'] ?? 0);
            }

            $description = trim((string)($row['description'] ?? ''));
            $action = strtolower(trim((string)($row['action'] ?? '')));
            $activityType = trim((string)($row['activity_type'] ?? ''));
            $activityTypeLabel = $activityType !== '' ? ucwords(str_replace('_', ' ', $activityType)) : 'General';

            if ($description === '') {
                $description = 'performed ' . str_replace('_', ' ', $action);
            }

            $message = $actorName . ' (' . $actorRoleLabel . '): ' . $description;
            if (!preg_match('/[.!?]$/', $message)) {
                $message .= '.';
            }
            $message .= ' Area: ' . $activityTypeLabel . '.';

            $severity = $actorRole === 'manager' ? 'medium' : 'info';
            if (
                strpos($action, 'delete') !== false
                || strpos($action, 'archive') !== false
                || strpos($action, 'reject') !== false
                || strpos($action, 'terminate') !== false
                || strpos($action, 'lock') !== false
                || strpos($action, 'fail') !== false
            ) {
                $severity = 'high';
            }

            addNotification(
                $items,
                'activity',
                $actorRoleLabel . ' Activity',
                $message,
                (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
                $severity,
                '/admin/dashboard',
                'team_activity:' . intval($row['id'] ?? 0),
                '',
                null,
                $actorRole
            );
        }
        $teamActivityStmt->close();
    }
}

// Manager/admin operational reminder.
if (in_array($role, ['manager', 'admin'], true)) {
    $pendingLeaveSql = "SELECT COUNT(*) AS pending_count, MAX(created_at) AS latest_created_at FROM leave_request WHERE status = 'pending'";
    $pendingLeaveResult = $conn->query($pendingLeaveSql);
    if ($pendingLeaveResult) {
        $row = $pendingLeaveResult->fetch_assoc();
        $pending = intval($row['pending_count'] ?? 0);
        if ($pending > 0) {
            $latestCreatedAt = trim((string)($row['latest_created_at'] ?? ''));
            $occurredAt = $latestCreatedAt !== '' ? $latestCreatedAt : date('Y-m-d H:i:s');
            addNotification(
                $items,
                'approval',
                'Pending Leave Approvals',
                'There are ' . $pending . ' leave request(s) waiting for approval.',
                $occurredAt,
                'medium',
                '/leave-requests',
                'pending_leave_approvals:' . $pending . ':' . $occurredAt,
                'pending_leave_approvals'
            );
        }
    }
}

/**
 * Get AI-generated smart notifications for user
 */
function getAINotifications($conn, $userId, $role) {
    $items = [];
    
    // Fetch AI notifications from database
    $sql = "SELECT * FROM ai_notifications 
            WHERE target_user_id = ? 
              AND is_sent = 1 
              AND dismissed = 0
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY priority_score DESC, created_at DESC
            LIMIT 20";
    
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return [];
    }
    
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $result = $stmt->get_result();
    
    while ($row = $result->fetch_assoc()) {
        $priority = 'medium';
        $score = intval($row['priority_score'] ?? 5);
        
        if ($score >= 8) {
            $priority = 'critical';
        } elseif ($score >= 6) {
            $priority = 'high';
        } elseif ($score <= 3) {
            $priority = 'low';
        }
        
        $items[] = [
            'id' => 'ai_' . $row['id'],
            'type' => 'ai_' . $row['event_type'],
            'title' => $row['suggested_action'] ?? 'Smart Notification',
            'message' => $row['ai_message'],
            'occurred_at' => $row['created_at'],
            'priority' => $priority,
            'action_url' => $row['action_url'] ?? '/notifications',
            'icon_emoji' => $row['icon_emoji'] ?? '🔔',
            'is_ai' => true,
            'source' => $row['source'],
            'notification_id' => intval($row['id']),
            'dedup_key' => 'ai_notification:' . $row['id']
        ];
    }
    
    $stmt->close();
    
    return $items;
}

// Profile edit access workflow notifications.
$requesterRows = profileEditRequesterNotificationRows($conn, $userId, 12);
foreach ($requesterRows as $row) {
    $status = strtolower(trim((string)($row['status'] ?? '')));
    $requestId = intval($row['request_id'] ?? 0);

    if ($status === 'pending') {
        addNotification(
            $items,
            'profile',
            'Edit Access Request Submitted',
            'Your request to edit your profile details is waiting for approval.',
            (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
            'info',
            '/profile',
            'profile_request:' . $requestId . ':pending',
            'profile_request:' . $requestId . ':pending'
        );
    } elseif ($status === 'approved') {
        $untilRaw = trim((string)($row['access_granted_until'] ?? ''));
        $message = 'Your edit access request was approved.';
        if ($untilRaw !== '') {
            $message .= ' You can edit your profile until ' . date('M d, Y h:i A', strtotime($untilRaw)) . '.';
        }
        addNotification(
            $items,
            'profile',
            'Edit Access Approved',
            $message,
            (string)($row['approved_at'] ?? $row['created_at'] ?? date('Y-m-d H:i:s')),
            'success',
            '/profile',
            'profile_request:' . $requestId . ':approved',
            'profile_request:' . $requestId . ':approved'
        );
    } elseif ($status === 'used') {
        addNotification(
            $items,
            'profile',
            'Profile Changes Saved',
            'Your approved edit access was used to save your updated profile details.',
            (string)($row['used_at'] ?? $row['approved_at'] ?? $row['created_at'] ?? date('Y-m-d H:i:s')),
            'success',
            '/profile',
            'profile_request:' . $requestId . ':used',
            'profile_request:' . $requestId . ':used'
        );
    }
}

if ($role === 'admin') {
    $pendingRequestRows = profileEditPendingNotificationRows($conn, $role, $userId, $branchId, 12);
    foreach ($pendingRequestRows as $row) {
        $requestId = intval($row['request_id'] ?? 0);
        addNotification(
            $items,
            'profile',
            'Edit Access Review Needed',
            ($row['requester_name'] ?? 'A user') . ' requested access to edit profile details.',
            (string)($row['created_at'] ?? date('Y-m-d H:i:s')),
            'medium',
            '/edit-requests',
            'profile_request_review:' . $requestId,
            'profile_request_review:' . $requestId
        );
    }

    $usedRequestRows = profileEditUsedNotificationRows($conn, $role, $userId, $branchId, 12);
    foreach ($usedRequestRows as $row) {
        $requestId = intval($row['request_id'] ?? 0);
        $changedFields = is_array($row['updated_fields'] ?? null) ? $row['updated_fields'] : [];
        addNotification(
            $items,
            'profile',
            'Profile Self-Update Completed',
            ($row['requester_name'] ?? 'A user') . ' updated their own details. Changed fields: ' . profileEditSummarizeChangedFields($changedFields) . '.',
            (string)($row['used_at'] ?? $row['updated_at'] ?? date('Y-m-d H:i:s')),
            'info',
            '/edit-requests',
            'profile_request_used:' . $requestId,
            'profile_request_used:' . $requestId
        );
    }
}

// ── Task Workflow Notifications ──────────────────────────────────────────────
// These cover every state transition in the document-based task approval flow:
//   staff submits → manager reviews → admin reviews → completed / rejected.
//
// The task_approval_history table is the single source of truth for events.
// We query recent history rows and route them to the correct user(s).

function twNotifTableExists($conn, $table) {
    $stmt = $conn->prepare(
        "SELECT 1 FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

// Only proceed if task workflow tables exist (they are created lazily by task-workflow.php).
if (twNotifTableExists($conn, 'task_approval_history') && twNotifTableExists($conn, 'tasks')) {

    // ── 1. Notifications for STAFF: what happened to their submissions ────────
    if ($role === 'staff') {
        // History actions that matter to staff: manager/admin approved or rejected their task.
        $staffWfStmt = $conn->prepare(
            "SELECT h.history_id,
                    h.task_id,
                    h.action,
                    h.comments,
                    h.new_status,
                    h.created_at,
                    t.title AS task_title,
                    t.project_id,
                    p.name AS project_name,
                    CONCAT(actor.first_name, ' ', actor.last_name) AS actor_name,
                    actor.role AS actor_role
             FROM task_approval_history h
             INNER JOIN tasks t ON t.id = h.task_id
             LEFT JOIN projects p ON p.id = t.project_id
             LEFT JOIN users actor ON actor.id = h.performed_by
             WHERE t.assigned_to = ?
               AND h.action IN ('manager_approved','manager_rejected','admin_approved','admin_rejected')
               AND h.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             ORDER BY h.created_at DESC, h.history_id DESC
             LIMIT 40"
        );
        if ($staffWfStmt) {
            $staffWfStmt->bind_param('i', $userId);
            $staffWfStmt->execute();
            $staffWfResult = $staffWfStmt->get_result();
            while ($row = $staffWfResult->fetch_assoc()) {
                $action      = (string)($row['action'] ?? '');
                $taskTitle   = (string)($row['task_title'] ?? 'Untitled Task');
                $projectName = (string)($row['project_name'] ?? '');
                $actorName   = trim((string)($row['actor_name'] ?? ''));
                $actorRole   = strtolower((string)($row['actor_role'] ?? ''));
                $actorLabel  = $actorRole === 'admin' ? 'Admin' : 'Manager';
                if ($actorName === '' || trim($actorName) === '') $actorName = $actorLabel;
                $comments    = trim((string)($row['comments'] ?? ''));
                $occurredAt  = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
                $taskId      = intval($row['task_id'] ?? 0);
                $projectId   = intval($row['project_id'] ?? 0);
                $link        = $projectId > 0 ? '/my-tasks' : '/my-tasks';
                $historyId   = intval($row['history_id'] ?? 0);

                if ($action === 'manager_approved') {
                    $title   = 'Submission Approved by Manager';
                    $msg     = '"' . $taskTitle . '" was approved by ' . $actorName . ' (' . $actorLabel . ') and forwarded for admin review.';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'success';
                } elseif ($action === 'manager_rejected') {
                    $title   = 'Submission Rejected by Manager';
                    $msg     = '"' . $taskTitle . '" was rejected by ' . $actorName . ' (' . $actorLabel . ').';
                    if ($comments !== '') $msg .= ' Reason: ' . $comments;
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'high';
                } elseif ($action === 'admin_approved') {
                    $title   = 'Task Completed — Admin Approved';
                    $msg     = '"' . $taskTitle . '" was fully approved by ' . $actorName . ' (' . $actorLabel . '). Task is now complete.';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'success';
                } elseif ($action === 'admin_rejected') {
                    $title   = 'Submission Rejected by Admin';
                    $msg     = '"' . $taskTitle . '" was rejected by ' . $actorName . ' (' . $actorLabel . '). Please resubmit.';
                    if ($comments !== '') $msg .= ' Reason: ' . $comments;
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'high';
                } else {
                    continue;
                }

                addNotification(
                    $items,
                    'task',
                    $title,
                    $msg,
                    $occurredAt,
                    $severity,
                    $link,
                    'task_wf_history:' . $historyId,
                    'task_wf_history:' . $historyId,
                    null,
                    $actorRole
                );
            }
            $staffWfStmt->close();
        }
    }

    // ── 2. Notifications for MANAGER: new submissions awaiting their review ───
    if ($role === 'manager') {
        // a) Pending tasks in their projects that need manager review.
        $mgrPendingStmt = $conn->prepare(
            "SELECT t.id AS task_id,
                    t.title AS task_title,
                    t.submitted_at,
                    t.project_id,
                    p.name AS project_name,
                    CONCAT(staff.first_name, ' ', staff.last_name) AS staff_name
             FROM tasks t
             INNER JOIN projects p ON p.id = t.project_id
             LEFT JOIN users staff ON staff.id = t.assigned_to
             WHERE p.manager_id = ?
               AND t.workflow_status = 'pending_manager'
             ORDER BY t.submitted_at ASC
             LIMIT 30"
        );
        if ($mgrPendingStmt) {
            $mgrPendingStmt->bind_param('i', $userId);
            $mgrPendingStmt->execute();
            $mgrPendingResult = $mgrPendingStmt->get_result();
            while ($row = $mgrPendingResult->fetch_assoc()) {
                $taskTitle   = (string)($row['task_title'] ?? 'Untitled Task');
                $staffName   = trim((string)($row['staff_name'] ?? ''));
                if ($staffName === '') $staffName = 'a staff member';
                $projectName = (string)($row['project_name'] ?? '');
                $submittedAt = (string)($row['submitted_at'] ?? date('Y-m-d H:i:s'));
                $taskId      = intval($row['task_id'] ?? 0);
                $projectId   = intval($row['project_id'] ?? 0);
                $msg = $staffName . ' submitted a document for "' . $taskTitle . '" and is awaiting your review.';
                if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                addNotification(
                    $items,
                    'task',
                    'Document Awaiting Your Review',
                    $msg,
                    $submittedAt !== '' ? $submittedAt : date('Y-m-d H:i:s'),
                    'medium',
                    $projectId > 0 ? '/projects/detail?id=' . $projectId : '/task-workflow',
                    'task_wf_pending_mgr:' . $taskId,
                    'task_wf_pending_mgr:' . $taskId
                );
            }
            $mgrPendingStmt->close();
        }

        // b) Recent history: staff submitted/resubmitted docs on manager's projects.
        $mgrSubmitStmt = $conn->prepare(
            "SELECT h.history_id,
                    h.task_id,
                    h.action,
                    h.created_at,
                    t.title AS task_title,
                    t.project_id,
                    p.name AS project_name,
                    CONCAT(actor.first_name, ' ', actor.last_name) AS staff_name
             FROM task_approval_history h
             INNER JOIN tasks t ON t.id = h.task_id
             INNER JOIN projects p ON p.id = t.project_id
             LEFT JOIN users actor ON actor.id = h.performed_by
             WHERE p.manager_id = ?
               AND h.action IN ('document_submitted', 'resubmitted')
               AND h.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             ORDER BY h.created_at DESC, h.history_id DESC
             LIMIT 30"
        );
        if ($mgrSubmitStmt) {
            $mgrSubmitStmt->bind_param('i', $userId);
            $mgrSubmitStmt->execute();
            $mgrSubmitResult = $mgrSubmitStmt->get_result();
            while ($row = $mgrSubmitResult->fetch_assoc()) {
                $action      = (string)($row['action'] ?? '');
                $taskTitle   = (string)($row['task_title'] ?? 'Untitled Task');
                $staffName   = trim((string)($row['staff_name'] ?? ''));
                if ($staffName === '') $staffName = 'A staff member';
                $projectName = (string)($row['project_name'] ?? '');
                $occurredAt  = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
                $historyId   = intval($row['history_id'] ?? 0);
                $projectId   = intval($row['project_id'] ?? 0);
                $isResub     = $action === 'resubmitted';
                $title       = $isResub ? 'Document Resubmitted' : 'New Document Submitted';
                $msg         = $staffName . ($isResub ? ' resubmitted' : ' submitted') . ' a document for "' . $taskTitle . '".';
                if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                addNotification(
                    $items,
                    'task',
                    $title,
                    $msg,
                    $occurredAt,
                    'medium',
                    $projectId > 0 ? '/projects/detail?id=' . $projectId : '/task-workflow',
                    'task_wf_history:' . $historyId,
                    'task_wf_history:' . $historyId
                );
            }
            $mgrSubmitStmt->close();
        }
    }

    // ── 3. Notifications for ADMIN: submissions forwarded for admin review ────
    if ($role === 'admin') {
        // a) Pending tasks awaiting admin review.
        $adminPendingStmt = $conn->prepare(
            "SELECT t.id AS task_id,
                    t.title AS task_title,
                    t.manager_reviewed_at,
                    t.project_id,
                    p.name AS project_name,
                    CONCAT(staff.first_name, ' ', staff.last_name) AS staff_name,
                    CONCAT(mgr.first_name, ' ', mgr.last_name) AS manager_name
             FROM tasks t
             INNER JOIN projects p ON p.id = t.project_id
             LEFT JOIN users staff ON staff.id = t.assigned_to
             LEFT JOIN users mgr ON mgr.id = t.manager_reviewed_by
             WHERE t.workflow_status = 'pending_admin'
             ORDER BY t.manager_reviewed_at ASC
             LIMIT 30"
        );
        if ($adminPendingStmt) {
            $adminPendingStmt->execute();
            $adminPendingResult = $adminPendingStmt->get_result();
            while ($row = $adminPendingResult->fetch_assoc()) {
                $taskTitle   = (string)($row['task_title'] ?? 'Untitled Task');
                $staffName   = trim((string)($row['staff_name'] ?? ''));
                if ($staffName === '') $staffName = 'a staff member';
                $mgrName     = trim((string)($row['manager_name'] ?? ''));
                if ($mgrName === '') $mgrName = 'a manager';
                $projectName = (string)($row['project_name'] ?? '');
                $reviewedAt  = (string)($row['manager_reviewed_at'] ?? date('Y-m-d H:i:s'));
                $taskId      = intval($row['task_id'] ?? 0);
                $projectId   = intval($row['project_id'] ?? 0);
                $msg = '"' . $taskTitle . '" was approved by ' . $mgrName . ' (Manager) and is awaiting your final review.';
                if ($staffName !== '') $msg .= ' Submitted by: ' . $staffName . '.';
                if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                addNotification(
                    $items,
                    'task',
                    'Task Awaiting Admin Review',
                    $msg,
                    $reviewedAt !== '' ? $reviewedAt : date('Y-m-d H:i:s'),
                    'medium',
                    $projectId > 0 ? '/projects/detail?id=' . $projectId : '/task-workflow',
                    'task_wf_pending_admin:' . $taskId,
                    'task_wf_pending_admin:' . $taskId
                );
            }
            $adminPendingStmt->close();
        }

        // b) Recent history: manager approved/rejected submissions (admin oversight).
        $adminHistStmt = $conn->prepare(
            "SELECT h.history_id,
                    h.task_id,
                    h.action,
                    h.comments,
                    h.created_at,
                    t.title AS task_title,
                    t.project_id,
                    p.name AS project_name,
                    CONCAT(actor.first_name, ' ', actor.last_name) AS actor_name,
                    CONCAT(staff.first_name, ' ', staff.last_name) AS staff_name
             FROM task_approval_history h
             INNER JOIN tasks t ON t.id = h.task_id
             LEFT JOIN projects p ON p.id = t.project_id
             LEFT JOIN users actor ON actor.id = h.performed_by
             LEFT JOIN users staff ON staff.id = t.assigned_to
             WHERE h.action IN ('manager_approved','manager_rejected','document_submitted','resubmitted','task_started','admin_approved','admin_rejected')
               AND h.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             ORDER BY h.created_at DESC, h.history_id DESC
             LIMIT 50"
        );
        if ($adminHistStmt) {
            $adminHistStmt->execute();
            $adminHistResult = $adminHistStmt->get_result();
            while ($row = $adminHistResult->fetch_assoc()) {
                $action      = (string)($row['action'] ?? '');
                $taskTitle   = (string)($row['task_title'] ?? 'Untitled Task');
                $actorName   = trim((string)($row['actor_name'] ?? ''));
                $staffName   = trim((string)($row['staff_name'] ?? ''));
                $projectName = (string)($row['project_name'] ?? '');
                $comments    = trim((string)($row['comments'] ?? ''));
                $occurredAt  = (string)($row['created_at'] ?? date('Y-m-d H:i:s'));
                $historyId   = intval($row['history_id'] ?? 0);
                $projectId   = intval($row['project_id'] ?? 0);

                if ($action === 'manager_approved') {
                    $title    = 'Manager Approved — Pending Admin Review';
                    $who      = $actorName !== '' ? $actorName : 'A manager';
                    $msg      = $who . ' approved the submission for "' . $taskTitle . '" and forwarded it for your review.';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'medium';
                } elseif ($action === 'manager_rejected') {
                    $title    = 'Manager Rejected Submission';
                    $who      = $actorName !== '' ? $actorName : 'A manager';
                    $msg      = $who . ' rejected the submission for "' . $taskTitle . '".';
                    if ($comments !== '') $msg .= ' Reason: ' . $comments;
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'info';
                } elseif ($action === 'document_submitted') {
                    $title    = 'Staff Submitted Document';
                    $who      = $staffName !== '' ? $staffName : 'A staff member';
                    $msg      = $who . ' submitted a document for "' . $taskTitle . '".';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'info';
                } elseif ($action === 'resubmitted') {
                    $title    = 'Staff Resubmitted Document';
                    $who      = $actorName !== '' ? $actorName : ($staffName !== '' ? $staffName : 'A staff member');
                    $msg      = $who . ' resubmitted a document for "' . $taskTitle . '".';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'info';
                } elseif ($action === 'task_started') {
                    $title    = 'Task Started by Staff';
                    $who      = $actorName !== '' ? $actorName : 'A staff member';
                    $msg      = $who . ' started the task "' . $taskTitle . '".';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'info';
                } elseif ($action === 'admin_approved') {
                    $title    = 'Task Completed';
                    $msg      = '"' . $taskTitle . '" has been fully approved and marked as completed.';
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'success';
                } elseif ($action === 'admin_rejected') {
                    $title    = 'Admin Rejected Submission';
                    $msg      = '"' . $taskTitle . '" was rejected by admin.';
                    if ($comments !== '') $msg .= ' Reason: ' . $comments;
                    if ($projectName !== '') $msg .= ' Project: ' . $projectName . '.';
                    $severity = 'high';
                } else {
                    continue;
                }

                addNotification(
                    $items,
                    'task',
                    $title,
                    $msg,
                    $occurredAt,
                    $severity,
                    $projectId > 0 ? '/projects/detail?id=' . $projectId : '/task-workflow',
                    'task_wf_history:' . $historyId,
                    'task_wf_history:' . $historyId
                );
            }
            $adminHistStmt->close();
        }
    }

    // ── 4. Pending workflow task counts for manager and admin ─────────────────
    if ($role === 'manager') {
        $mgrCountStmt = $conn->prepare(
            "SELECT COUNT(*) AS cnt, MAX(t.submitted_at) AS latest_at
             FROM tasks t
             INNER JOIN projects p ON p.id = t.project_id
             WHERE p.manager_id = ? AND t.workflow_status = 'pending_manager'"
        );
        if ($mgrCountStmt) {
            $mgrCountStmt->bind_param('i', $userId);
            $mgrCountStmt->execute();
            $mgrCountRow = $mgrCountStmt->get_result()->fetch_assoc();
            $mgrCountStmt->close();
            $cnt = intval($mgrCountRow['cnt'] ?? 0);
            if ($cnt > 0) {
                $latestAt = trim((string)($mgrCountRow['latest_at'] ?? ''));
                $occurredAt = $latestAt !== '' ? $latestAt : date('Y-m-d H:i:s');
                addNotification(
                    $items,
                    'approval',
                    'Pending Document Reviews',
                    'You have ' . $cnt . ' document submission(s) waiting for your review.',
                    $occurredAt,
                    'medium',
                    '/task-workflow',  // summary count — no specific project
                    'task_wf_mgr_pending_count:' . $cnt . ':' . $occurredAt,
                    'task_wf_mgr_pending_count'
                );
            }
        }
    }

    if ($role === 'admin') {
        $adminCountResult = $conn->query(
            "SELECT COUNT(*) AS cnt, MAX(manager_reviewed_at) AS latest_at FROM tasks WHERE workflow_status = 'pending_admin'"
        );
        if ($adminCountResult) {
            $adminCountRow = $adminCountResult->fetch_assoc();
            $cnt = intval($adminCountRow['cnt'] ?? 0);
            if ($cnt > 0) {
                $latestAt = trim((string)($adminCountRow['latest_at'] ?? ''));
                $occurredAt = $latestAt !== '' ? $latestAt : date('Y-m-d H:i:s');
                addNotification(
                    $items,
                    'approval',
                    'Pending Admin Reviews',
                    'There are ' . $cnt . ' task submission(s) awaiting your final approval.',
                    $occurredAt,
                    'medium',
                    '/task-workflow',
                    'task_wf_admin_pending_count:' . $cnt . ':' . $occurredAt,
                    'task_wf_admin_pending_count'
                );
            }
        }
    }

} // end task workflow tables check

// ── Project Manager Assignment Notifications ─────────────────────────────────
// When admin assigns a manager to a project, the manager should be notified.
// We detect this via activity_log entries for 'start_project' / 'create_project'
// and also check the projects table directly for the assigned manager.

if ($role === 'manager') {
    $projAssignStmt = $conn->prepare(
        "SELECT p.id AS project_id,
                p.name AS project_name,
                p.status,
                p.start_date,
                p.end_date,
                c.client_name,
                CONCAT(creator.first_name, ' ', creator.last_name) AS assigned_by_name,
                creator.role AS assigned_by_role
         FROM projects p
         LEFT JOIN client c ON c.client_id = p.client_id
         LEFT JOIN users creator ON creator.id = p.created_by
         WHERE p.manager_id = ?
           AND p.start_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         ORDER BY p.start_date DESC
         LIMIT 20"
    );
    if ($projAssignStmt) {
        $projAssignStmt->bind_param('i', $userId);
        $projAssignStmt->execute();
        $projAssignResult = $projAssignStmt->get_result();
        while ($row = $projAssignResult->fetch_assoc()) {
            $projId      = intval($row['project_id'] ?? 0);
            $projName    = (string)($row['project_name'] ?? 'Untitled Project');
            $clientName  = (string)($row['client_name'] ?? '');
            $assignedBy  = trim((string)($row['assigned_by_name'] ?? ''));
            $assignerRole = strtolower((string)($row['assigned_by_role'] ?? 'admin'));
            $assignerLabel = $assignerRole === 'manager' ? 'Manager' : 'Admin';
            if ($assignedBy === '' || trim($assignedBy) === '') $assignedBy = 'An ' . $assignerLabel;
            $startDate   = (string)($row['start_date'] ?? date('Y-m-d H:i:s'));
            $endDate     = (string)($row['end_date'] ?? '');
            $msg = 'You have been assigned as project manager for "' . $projName . '"';
            if ($clientName !== '') $msg .= ' (Client: ' . $clientName . ')';
            $msg .= ' by ' . $assignedBy . '.';
            if ($endDate !== '') $msg .= ' Due: ' . date('M d, Y', strtotime($endDate)) . '.';
            addNotification(
                $items,
                'task',
                'Project Assignment',
                $msg,
                $startDate,
                'info',
                '/projects/detail?id=' . $projId,
                'project_mgr_assignment:' . $projId,
                'project_mgr_assignment:' . $projId
            );
        }
        $projAssignStmt->close();
    }
}

// ── Frontend success requests: all successful system-flow activities for bell ──
// This ensures the bell shows "system flows activities success requests, and all request in the frontend"
$successLogStmt = $conn->prepare(
    "SELECT action, description, activity_type, created_at
     FROM activity_log
     WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       AND LOWER(activity_type) NOT IN ('security','auth','authentication')
       AND LOWER(description) NOT LIKE '%failed%'
       AND LOWER(description) NOT LIKE '%too many request%'
       AND LOWER(action) NOT LIKE '%failed%'
       AND LOWER(action) NOT LIKE '%lockout%'
     ORDER BY created_at DESC
     LIMIT 20"
);
if ($successLogStmt) {
    $successLogStmt->bind_param('i', $userId);
    $successLogStmt->execute();
    $successRows = $successLogStmt->get_result();
    while ($sr = $successRows->fetch_assoc()) {
        $act = (string)($sr['action'] ?? '');
        $desc = trim((string)($sr['description'] ?? ''));
        // Convert old raw logs to friendly
        if (stripos($desc, 'Updated settings:') === 0) {
            $raw = trim(substr($desc, strlen('Updated settings:')));
            $parts = array_filter(array_map('trim', explode(',', $raw)));
            $map = [
                'lockout_enabled' => 'Account Lockout',
                'lockout_threshold_manager' => 'Manager Threshold',
                'lockout_threshold_staff' => 'Staff Threshold',
                'lockout_window_hours' => 'Time Window',
                'lockout_cooldown_start_attempt' => 'Failed Attempts Before Cooldown',
                'lockout_max_cooldown_attempts' => 'Max Cooldown Attempts',
                'lockout_retry_delay_value' => 'Cooldown Duration', 'lockout_retry_delay_unit' => 'Cooldown Duration',
                'session_timeout_enabled' => 'Session Timeout',
                'session_timeout_manager_minutes' => 'Manager Session Timeout',
                'session_timeout_staff_minutes' => 'Staff Session Timeout',
                'session_timeout_admin_minutes' => 'Admin Session Timeout',
                'pagination_items_per_page' => 'Pagination',
            ];
            $friendly = [];
            foreach ($parts as $k) {
                if ($k === 'lockout_retry_delay_unit') continue;
                if ($k === 'lockout_retry_delay_value') { $friendly[] = 'Cooldown Duration'; continue; }
                $friendly[] = $map[$k] ?? ucwords(str_replace('_', ' ', $k));
            }
            $friendly = array_values(array_unique($friendly));
            $desc = 'Updated ' . implode(', ', $friendly);
        }
        if ($desc === '') $desc = str_replace('_', ' ', $act);
        // Clean title: show what's btn was edited, not raw underscores
        $title = '';
        if (stripos($desc, 'Updated') === 0) {
            $colonPos = strpos($desc, ':');
            if ($colonPos !== false) {
                $rawTitle = trim(substr($desc, 0, $colonPos));
                $rawTitle = trim(str_ireplace('Updated', '', $rawTitle));
                $title = $rawTitle !== '' ? $rawTitle . ' Updated' : 'Settings Updated';
                $title = ucwords(strtolower($title));
            } else {
                $title = strlen($desc) > 36 ? trim(substr($desc, 0, 36)) : $desc;
            }
        } else {
            $title = ucwords(str_replace(['_', '-'], ' ', $act));
        }
        $title = trim($title, " _-");
        if ($title === '') $title = 'System Flow Success';
        if (strlen($title) > 36) $title = trim(substr($title, 0, 36));
        addNotification(
            $items,
            'system',
            $title ?: 'System Flow Success',
            $desc,
            (string)($sr['created_at'] ?? date('Y-m-d H:i:s')),
            'success',
            '',
            'system:' . substr(hash('sha256', $act.$desc.($sr['created_at']??'')),0,16)
        );
    }
    $successLogStmt->close();
}

// ── Bell filtering: keep only success/system flows, move security failures to Suspicious Activity ──
$bellItems = [];
foreach ($items as $it) {
    $sev = strtolower((string)($it['severity'] ?? 'info'));
    $type = strtolower((string)($it['type'] ?? ''));
    $titleLow = strtolower((string)($it['title'] ?? ''));
    $msgLow = strtolower((string)($it['message'] ?? ''));
    $actLow = strtolower((string)($it['type'] ?? '') . ' ' . $titleLow . ' ' . $msgLow);

    // Exclude anything that belongs in Suspicious Activity (security/failed/too many)
    $isSecurity = false;
    if ($type === 'activity' && ($sev === 'high' && (strpos($msgLow, 'failed') !== false || strpos($msgLow, 'lockout') !== false))) $isSecurity = true;
    if (strpos($msgLow, 'too many request') !== false || strpos($msgLow, 'rate limit') !== false || strpos($msgLow, 'sending too much') !== false) $isSecurity = true;
    if ($type === 'security' || $type === 'auth') $isSecurity = true;
    if ($isSecurity) continue;

    // Keep all remaining (system flows success + all frontend requests)
    $bellItems[] = $it;
}
$items = $bellItems;

usort($items, function($left, $right) {
    $leftTs = strtotime((string)($left['occurred_at'] ?? '')) ?: 0;
    $rightTs = strtotime((string)($right['occurred_at'] ?? '')) ?: 0;
    return $rightTs <=> $leftTs;
});

// Add AI-generated smart notifications (also filtered to success flows)
$aiNotifications = getAINotifications($conn, $userId, $role);
// Filter AI to only success/info for bell
$aiFiltered = [];
foreach ($aiNotifications as $ai) {
    $sev = strtolower((string)($ai['priority'] ?? $ai['severity'] ?? 'info'));
    if (in_array($sev, ['success','info','medium','low'], true) || $sev === 'critical') {
        // Keep all AI for now as they are system-flow suggestions
        $aiFiltered[] = $ai;
    }
}
$items = array_merge($items, $aiFiltered);

// Re-sort with AI notifications included
usort($items, function($left, $right) {
    $leftTs = strtotime((string)($left['occurred_at'] ?? '')) ?: 0;
    $rightTs = strtotime((string)($right['occurred_at'] ?? '')) ?: 0;
    return $rightTs <=> $leftTs;
});

if (count($items) > 60) {
    $items = array_slice($items, 0, 60);
}

sendResponse(true, $items, 'Notifications retrieved successfully');
