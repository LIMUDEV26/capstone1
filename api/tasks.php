<?php
/**
 * Tasks API
 * Handles operations for project tasks
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureTaskCollaboratorsTable($conn);
ensureTaskAssignmentEventsTable($conn);
ensureTaskCompletionProofColumns($conn);
ensureTaskDueDateDateTimeColumn($conn);
ensureTaskDeadlineReminderColumn($conn);
ensureTaskWorkflowColumns($conn);
ensureTaskServiceIdColumn($conn);

switch ($method) {
    case 'GET':
        requireAnyFeatureAccess(['my_tasks', 'projects'], ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        // Task creation requires manager+ role
        requireAnyFeatureAccess(['my_tasks', 'projects'], ['admin', 'manager', 'staff'], $conn);
        requireMinRole('manager');
        handlePost($conn); 
        break;
    case 'PUT':
        // Staff can update their own assigned tasks (enforced in handler)
        requireAnyFeatureAccess(['my_tasks', 'projects'], ['admin', 'manager', 'staff'], $conn);
        handlePut($conn); // Assign staff, update status
        break;
    case 'DELETE':
        requireAnyFeatureAccess(['my_tasks', 'projects'], ['admin', 'manager', 'staff'], $conn);
        requireMinRole('manager');
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
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

function ensureTaskCompletionProofColumns($conn) {
    $requiredColumns = [
        'require_completion_proof' => "ALTER TABLE tasks ADD COLUMN require_completion_proof TINYINT(1) NOT NULL DEFAULT 0 AFTER assigned_to",
    ];

    foreach ($requiredColumns as $column => $sql) {
        if (!columnExists($conn, 'tasks', $column)) {
            if (!$conn->query($sql)) {
                error_log($conn->error);
                sendError('Failed to update task completion proof settings.', 500);
            }
        }
    }
}

function ensureTaskDueDateDateTimeColumn($conn) {
    $stmt = $conn->prepare(
        "SELECT DATA_TYPE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'tasks'
           AND COLUMN_NAME = 'due_date'
         LIMIT 1"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to inspect task due date storage.', 500);
    }

    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        return;
    }

    $dataType = strtolower(trim((string)($row['DATA_TYPE'] ?? '')));
    if ($dataType === 'datetime') {
        return;
    }

    if (!$conn->query("ALTER TABLE tasks MODIFY COLUMN due_date DATETIME NULL")) {
        error_log($conn->error);
        sendError('Failed to upgrade task due date storage.', 500);
    }
}

function ensureTaskDeadlineReminderColumn($conn) {
    if (columnExists($conn, 'tasks', 'deadline_reminder_at')) {
        return;
    }

    if (!$conn->query("ALTER TABLE tasks ADD COLUMN deadline_reminder_at DATETIME NULL AFTER due_date")) {
        error_log($conn->error);
        sendError('Failed to initialize task deadline reminder storage.', 500);
    }
}

function ensureTaskWorkflowColumns($conn) {
    $workflowColumns = [
        'workflow_status' => "ALTER TABLE tasks ADD COLUMN workflow_status ENUM('not_started','in_progress','pending_manager','rejected_by_manager','pending_admin','rejected_by_admin','completed') NOT NULL DEFAULT 'not_started' AFTER status",
        'started_at' => "ALTER TABLE tasks ADD COLUMN started_at TIMESTAMP NULL AFTER workflow_status",
        'submitted_at' => "ALTER TABLE tasks ADD COLUMN submitted_at TIMESTAMP NULL AFTER started_at",
        'manager_reviewed_at' => "ALTER TABLE tasks ADD COLUMN manager_reviewed_at TIMESTAMP NULL AFTER submitted_at",
        'manager_reviewed_by' => "ALTER TABLE tasks ADD COLUMN manager_reviewed_by INT NULL AFTER manager_reviewed_at",
        'admin_reviewed_at' => "ALTER TABLE tasks ADD COLUMN admin_reviewed_at TIMESTAMP NULL AFTER manager_reviewed_by",
        'admin_reviewed_by' => "ALTER TABLE tasks ADD COLUMN admin_reviewed_by INT NULL AFTER admin_reviewed_at",
        'completed_at' => "ALTER TABLE tasks ADD COLUMN completed_at TIMESTAMP NULL AFTER admin_reviewed_by",
    ];

    foreach ($workflowColumns as $column => $sql) {
        if (!columnExists($conn, 'tasks', $column) && !$conn->query($sql)) {
            error_log($conn->error);
            sendError('Failed to initialize task workflow column ' . $column . '.', 500);
        }
    }
}

function ensureTaskServiceIdColumn($conn) {
    if (columnExists($conn, 'tasks', 'service_id')) {
        return;
    }
    if (!$conn->query("ALTER TABLE tasks ADD COLUMN service_id INT NULL AFTER project_id")) {
        error_log($conn->error);
        sendError('Failed to add service_id column to tasks.', 500);
    }
    // Add foreign key silently (may fail if services table isn't present yet — ignore)
    $conn->query("ALTER TABLE tasks ADD CONSTRAINT fk_task_service FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE SET NULL");
}

function logTaskAssignmentEvent($conn, $taskId, $previousAssignedTo, $newAssignedTo, $assignedBy) {
    $resolvedTaskId = intval($taskId);
    $resolvedPrev = intval($previousAssignedTo);
    $resolvedNew = intval($newAssignedTo);
    $resolvedBy = intval($assignedBy);

    if ($resolvedTaskId <= 0 || $resolvedNew <= 0) {
        return false;
    }
    if ($resolvedPrev > 0 && $resolvedPrev === $resolvedNew) {
        return false;
    }

    $eventKind = $resolvedPrev > 0 ? 'reassigned' : 'assigned';
    $stmt = $conn->prepare(
        "INSERT INTO task_assignment_event (task_id, previous_assigned_to, new_assigned_to, assigned_by, event_kind)
         VALUES (?, ?, ?, ?, ?)"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to prepare task assignment event logging.', 500);
    }

    $prevValue = $resolvedPrev > 0 ? $resolvedPrev : null;
    $byValue = $resolvedBy > 0 ? $resolvedBy : null;
    $stmt->bind_param('iiiis', $resolvedTaskId, $prevValue, $resolvedNew, $byValue, $eventKind);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to log task assignment event.', 500);
    }

    $stmt->close();
    return true;
}

function columnExists($conn, $table, $column) {
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

function parseNullablePositiveIntField($value, $fieldName) {
    if ($value === null || $value === '') {
        return null;
    }

    if (!is_numeric($value)) {
        sendError("Invalid $fieldName", 400);
    }

    $resolved = intval($value);
    return $resolved > 0 ? $resolved : null;
}

function parsePositiveIntListParam($value, $maxItems = 100) {
    if ($value === null || $value === '') {
        return [];
    }

    $raw = is_array($value) ? implode(',', $value) : (string)$value;
    $parts = preg_split('/[\s,]+/', trim($raw)) ?: [];
    $ids = [];

    foreach ($parts as $part) {
        if ($part === '' || !is_numeric($part)) {
            continue;
        }

        $resolved = intval($part);
        if ($resolved <= 0) {
            continue;
        }

        $ids[$resolved] = $resolved;
        if (count($ids) >= $maxItems) {
            break;
        }
    }

    return array_values($ids);
}

function tableExists($conn, $table) {
    $safeTable = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    if ($safeTable === '') return false;

    $stmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
         LIMIT 1"
    );
    if (!$stmt) return false;

    $stmt->bind_param('s', $safeTable);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();

    return $exists;
}

function normalizeDateTimeInput($value) {
    $raw = trim((string)$value);
    if ($raw === '') return null;

    $normalized = str_replace('T', ' ', $raw);
    if (strlen($normalized) === 16) {
        $normalized .= ':00';
    }

    $ts = strtotime($normalized);
    if ($ts === false) {
        return null;
    }

    return date('Y-m-d H:i:s', $ts);
}

function assertDeadlineReminderBeforeDueDate($deadlineReminderAt, $dueDate) {
    $reminderRaw = trim((string)$deadlineReminderAt);
    if ($reminderRaw === '') {
        return;
    }

    $dueRaw = trim((string)$dueDate);
    if ($dueRaw === '') {
        sendError('Set an actual due date before adding a deadline reminder.', 400);
    }

    $reminderTs = strtotime($reminderRaw);
    $dueTs = strtotime($dueRaw);
    if ($reminderTs === false || $dueTs === false) {
        sendError('Invalid deadline reminder or due date.', 400);
    }

    if ($reminderTs >= $dueTs) {
        sendError('Deadline reminder must be before the actual due date.', 400);
    }
}

function normalizeCollaboratorsInput($data) {
    if (!array_key_exists('collaborators', $data)) {
        return null;
    }

    if (!is_array($data['collaborators'])) {
        sendError('Invalid collaborators payload', 400);
    }

    $normalized = [];
    foreach ($data['collaborators'] as $entry) {
        $user_id = 0;
        $shift_mode = 'none';
        $shift_start = null;
        $shift_end = null;

        if (is_numeric($entry)) {
            $user_id = intval($entry);
        } elseif (is_array($entry)) {
            $user_id = intval($entry['user_id'] ?? $entry['id'] ?? 0);

            $rawMode = strtolower(trim((string)($entry['shift_mode'] ?? 'none')));
            if (in_array($rawMode, ['current', 'current_time', 'now'], true)) {
                $shift_mode = 'current_time';
            } elseif (in_array($rawMode, ['range', 'between', 'date_range'], true)) {
                $shift_mode = 'range';
            }

            if ($shift_mode === 'current_time') {
                $shift_start = normalizeDateTimeInput($entry['shift_start'] ?? null) ?: date('Y-m-d H:i:s');
                $shift_end = null;
            } elseif ($shift_mode === 'range') {
                $shift_start = normalizeDateTimeInput($entry['shift_start'] ?? null);
                $shift_end = normalizeDateTimeInput($entry['shift_end'] ?? null);

                if (!$shift_start || !$shift_end) {
                    sendError('Shift range requires both start and end datetime', 400);
                }
                if (strtotime($shift_end) < strtotime($shift_start)) {
                    sendError('Shift end must be after shift start', 400);
                }
            }
        }

        if ($user_id <= 0) {
            continue;
        }

        $normalized[$user_id] = [
            'user_id' => $user_id,
            'shift_mode' => $shift_mode,
            'shift_start' => $shift_start,
            'shift_end' => $shift_end,
        ];
    }

    return array_values($normalized);
}

function getTaskAssignableUserSnapshot($conn, $userId) {
    $resolvedUserId = intval($userId);
    if ($resolvedUserId <= 0) {
        return null;
    }

    $stmt = $conn->prepare(
        "SELECT id, LOWER(TRIM(role)) AS role, branch_id
         FROM users
         WHERE id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to validate task assignee.', 500);
    }

    $stmt->bind_param('i', $resolvedUserId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function assertManagerCanAssignTaskUser($conn, $targetUserId, $actorRole, $actorBranchId) {
    $resolvedUserId = intval($targetUserId);
    if ($resolvedUserId <= 0) {
        return null;
    }

    $user = getTaskAssignableUserSnapshot($conn, $resolvedUserId);
    if (!$user) {
        sendError('Assigned user not found.', 400);
    }

    $normalizedActorRole = strtolower(trim((string)$actorRole));
    $targetRole = strtolower(trim((string)($user['role'] ?? '')));

    if ($targetRole === 'staff' && $normalizedActorRole !== 'manager') {
        sendError('Only managers can assign staff to tasks.', 403);
    }

    if ($normalizedActorRole !== 'manager') {
        return $user;
    }

    $managerBranchId = intval($actorBranchId);
    if ($managerBranchId <= 0) {
        sendError('Your account is not linked to a branch.', 403);
    }

    if ($targetRole !== 'staff') {
        sendError('Managers can only assign tasks to staff in their own branch.', 403);
    }

    $targetBranchId = intval($user['branch_id'] ?? 0);
    if ($targetBranchId <= 0 || $targetBranchId !== $managerBranchId) {
        sendError('Managers can only assign tasks to staff in their own branch.', 403);
    }

    return $user;
}

function getTaskProjectManagerId($conn, $taskId) {
    $resolvedTaskId = intval($taskId);
    if ($resolvedTaskId <= 0) {
        return null;
    }

    $stmt = $conn->prepare(
        "SELECT p.manager_id
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to validate task project assignment.', 500);
    }

    $stmt->bind_param('i', $resolvedTaskId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        return null;
    }

    return intval($row['manager_id'] ?? 0);
}

function getProjectManagerIdForTaskCreation($conn, $projectId) {
    $resolvedProjectId = intval($projectId);
    if ($resolvedProjectId <= 0) {
        return null;
    }

    $stmt = $conn->prepare("SELECT manager_id FROM projects WHERE id = ? LIMIT 1");
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to validate project assignment.', 500);
    }

    $stmt->bind_param('i', $resolvedProjectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        return null;
    }

    return intval($row['manager_id'] ?? 0);
}

function requireManagerOwnsProjectForTaskMutation($conn, $projectId, $taskId = null) {
    $actorRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if ($actorRole !== 'manager') {
        return;
    }

    $managerId = $taskId !== null
        ? getTaskProjectManagerId($conn, $taskId)
        : getProjectManagerIdForTaskCreation($conn, $projectId);

    if ($managerId === null) {
        sendError($taskId !== null ? 'Task not found' : 'Project not found', 404);
    }

    $actorUserId = intval($_SESSION['user_id'] ?? 0);
    if ($actorUserId <= 0 || $managerId !== $actorUserId) {
        sendError('Managers can only manage tasks for projects assigned to them.', 403);
    }
}

function taskHasActiveProofAttachment($conn, $taskId) {
    if (!tableExists($conn, 'task_comment')) {
        return false;
    }

    $resolvedTaskId = intval($taskId);
    if ($resolvedTaskId <= 0) {
        return false;
    }

    $stmt = $conn->prepare(
        "SELECT comment_id
         FROM task_comment
         WHERE task_id = ?
           AND attachment_path IS NOT NULL
           AND TRIM(attachment_path) <> ''
           AND COALESCE(attachment_archived, 0) = 0
         LIMIT 1"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to validate task proof attachment.', 500);
    }

    $stmt->bind_param('i', $resolvedTaskId);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    return $exists;
}

function buildTaskEmailFrontendBaseUrl() {
    $frontendBase = '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    if ($referer) {
        $parsed = parse_url($referer);
        if ($parsed && isset($parsed['host'])) {
            $port = isset($parsed['port']) ? ':' . $parsed['port'] : '';
            $scheme = $parsed['scheme'] ?? 'http';
            $frontendBase = $scheme . '://' . $parsed['host'] . $port;
        }
    }

    if ($frontendBase === '') {
        $configuredFrontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
        if ($configuredFrontendBase !== '') {
            $frontendBase = $configuredFrontendBase;
        } else {
            $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
            $scheme = $isHttps ? 'https' : 'http';
            $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
            $frontendBase = $scheme . '://' . $host;
        }
    }

    return rtrim($frontendBase, '/');
}

function formatTaskPriorityLabel($priority) {
    $raw = strtolower(trim((string)$priority));
    if ($raw === '') return 'Not set';
    return ucwords(str_replace('_', ' ', $raw));
}

function formatTaskDueDateLabel($dueDate) {
    $raw = trim((string)$dueDate);
    if ($raw === '') return 'No due date provided';
    $ts = strtotime($raw);
    if ($ts === false) return $raw;
    return date('F d, Y h:i A', $ts);
}

function formatTaskDateTimeLabel($dateTime) {
    $raw = trim((string)$dateTime);
    if ($raw === '') return 'Not scheduled';
    $ts = strtotime($raw);
    if ($ts === false) return $raw;
    return date('F d, Y h:i A', $ts);
}

function formatTaskEmailPersonName($firstName, $lastName, $fallback = '') {
    $name = trim((string)$firstName . ' ' . (string)$lastName);
    if ($name !== '') {
        return $name;
    }

    $fallbackValue = trim((string)$fallback);
    return $fallbackValue !== '' ? $fallbackValue : 'Team Member';
}

function formatTaskCollaboratorShiftLabel($shiftMode, $shiftStart, $shiftEnd) {
    $normalizedMode = strtolower(trim((string)$shiftMode));
    $startRaw = trim((string)$shiftStart);
    $endRaw = trim((string)$shiftEnd);

    if ($normalizedMode === 'range') {
        if ($startRaw !== '' && $endRaw !== '') {
            return formatTaskDateTimeLabel($shiftStart) . ' to ' . formatTaskDateTimeLabel($shiftEnd);
        }
        if ($startRaw !== '') {
            return 'From ' . formatTaskDateTimeLabel($shiftStart);
        }
    }

    if ($normalizedMode === 'current_time') {
        if ($startRaw !== '') {
            return 'From ' . formatTaskDateTimeLabel($shiftStart);
        }
        return 'Active from the current time';
    }

    return 'No shift window specified';
}

function getTaskAssignmentEmailContext($conn, $taskId, $assignedUserId, $actorUserId) {
    $resolvedTaskId = intval($taskId);
    $resolvedAssignedUserId = intval($assignedUserId);
    $resolvedActorUserId = intval($actorUserId);
    if ($resolvedTaskId <= 0 || $resolvedAssignedUserId <= 0) {
        return null;
    }

    $sql = "SELECT t.id,
                   t.title,
                   t.description,
                   t.priority,
                   t.due_date,
                   p.name AS project_name,
                   c.client_name,
                   au.email AS assignee_email,
                   au.first_name AS assignee_first_name,
                   au.last_name AS assignee_last_name,
                   au.role AS assignee_role,
                   su.first_name AS assigner_first_name,
                   su.last_name AS assigner_last_name,
                   su.role AS assigner_role
            FROM tasks t
            LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN client c ON c.client_id = p.client_id
            LEFT JOIN users au ON au.id = t.assigned_to
            LEFT JOIN users su ON su.id = ?
            WHERE t.id = ?
              AND t.assigned_to = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log('getTaskAssignmentEmailContext: prepare failed for task_id=' . $resolvedTaskId . ': ' . $conn->error);
        return null;
    }

    $stmt->bind_param('iii', $resolvedActorUserId, $resolvedTaskId, $resolvedAssignedUserId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function sendTaskAssignmentNotificationEmail($conn, $taskId, $assignedUserId, $actorRole, $actorUserId, $isReassignment = false) {
    $normalizedActorRole = strtolower(trim((string)$actorRole));
    if (!in_array($normalizedActorRole, ['admin', 'manager'], true)) {
        return ['attempted' => false, 'sent' => null];
    }

    $resolvedAssignedUserId = intval($assignedUserId);
    if ($resolvedAssignedUserId <= 0) {
        return ['attempted' => false, 'sent' => null];
    }

    if (!function_exists('sendMail')) {
        error_log('sendTaskAssignmentNotificationEmail: sendMail function unavailable.');
        return ['attempted' => true, 'sent' => false];
    }

    $context = getTaskAssignmentEmailContext($conn, $taskId, $resolvedAssignedUserId, $actorUserId);
    if (!$context) {
        error_log('sendTaskAssignmentNotificationEmail: context missing for task_id=' . intval($taskId));
        return ['attempted' => true, 'sent' => false];
    }

    $assigneeRole = strtolower(trim((string)($context['assignee_role'] ?? '')));
    $allowedAssigneeRoles = $normalizedActorRole === 'admin'
        ? ['manager', 'staff']
        : ['staff'];
    if (!in_array($assigneeRole, $allowedAssigneeRoles, true)) {
        return ['attempted' => false, 'sent' => null];
    }

    $toEmail = trim((string)($context['assignee_email'] ?? ''));
    if ($toEmail === '') {
        error_log('sendTaskAssignmentNotificationEmail: assignee email is empty for task_id=' . intval($taskId));
        return ['attempted' => true, 'sent' => false];
    }

    $assigneeName = trim((string)($context['assignee_first_name'] ?? '') . ' ' . (string)($context['assignee_last_name'] ?? ''));
    if ($assigneeName === '') {
        $assigneeName = 'Team Member';
    }

    $assignerName = trim((string)($context['assigner_first_name'] ?? '') . ' ' . (string)($context['assigner_last_name'] ?? ''));
    if ($assignerName === '') {
        $assignerName = $normalizedActorRole === 'manager' ? 'Manager' : 'Administrator';
    }
    $assignerRoleForMessage = strtolower(trim((string)($context['assigner_role'] ?? $normalizedActorRole)));
    $assignerTitleForMessage = $assignerRoleForMessage === 'manager' ? 'manager' : 'administrator';

    $taskTitle = trim((string)($context['title'] ?? 'Untitled Task'));
    $taskDescriptionRaw = trim((string)($context['description'] ?? ''));
    $taskDescription = $taskDescriptionRaw !== '' ? $taskDescriptionRaw : 'No additional description was provided.';
    $taskDescriptionLength = function_exists('mb_strlen') ? mb_strlen($taskDescription) : strlen($taskDescription);
    if ($taskDescriptionLength > 420) {
        $taskDescription = function_exists('mb_substr')
            ? mb_substr($taskDescription, 0, 417) . '...'
            : substr($taskDescription, 0, 417) . '...';
    }

    $projectName = trim((string)($context['project_name'] ?? 'N/A'));
    $clientName = trim((string)($context['client_name'] ?? 'N/A'));
    $priorityLabel = formatTaskPriorityLabel($context['priority'] ?? '');
    $dueDateLabel = formatTaskDueDateLabel($context['due_date'] ?? '');
    $taskIdLabel = '#' . intval($context['id'] ?? $taskId);

    $taskHubUrl = buildTaskEmailFrontendBaseUrl() . '/my-tasks';
    $safeTaskHubUrl = htmlspecialchars($taskHubUrl, ENT_QUOTES, 'UTF-8');
    $safeAssigneeName = htmlspecialchars($assigneeName, ENT_QUOTES, 'UTF-8');
    $safeTaskTitle = htmlspecialchars($taskTitle, ENT_QUOTES, 'UTF-8');
    $safeTaskDescription = nl2br(htmlspecialchars($taskDescription, ENT_QUOTES, 'UTF-8'));
    $safeProjectName = htmlspecialchars($projectName, ENT_QUOTES, 'UTF-8');
    $safeClientName = htmlspecialchars($clientName, ENT_QUOTES, 'UTF-8');
    $safePriorityLabel = htmlspecialchars($priorityLabel, ENT_QUOTES, 'UTF-8');
    $safeDueDateLabel = htmlspecialchars($dueDateLabel, ENT_QUOTES, 'UTF-8');
    $safeTaskIdLabel = htmlspecialchars($taskIdLabel, ENT_QUOTES, 'UTF-8');
    $safeAssignerName = htmlspecialchars($assignerName, ENT_QUOTES, 'UTF-8');
    $safeRoleLabel = htmlspecialchars(ucfirst($assigneeRole), ENT_QUOTES, 'UTF-8');

    $headline = $isReassignment ? 'Task Reassignment Notice' : 'New Task Assignment';
    $safeHeadline = htmlspecialchars($headline, ENT_QUOTES, 'UTF-8');
    $subjectPrefix = $isReassignment ? 'Task Reassigned' : 'Task Assigned';
    $subject = $subjectPrefix . ': ' . $taskTitle . ' (' . $taskIdLabel . ')';

    $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;">Dear ' . $safeAssigneeName . ',</p>'
        . '<p style="margin:0 0 16px 0;font-size:14px;line-height:1.85;color:#1f2937;">'
        . 'This is a formal notification that your ' . htmlspecialchars($assignerTitleForMessage, ENT_QUOTES, 'UTF-8') . ' has '
        . ($isReassignment ? 'updated your assignment' : 'assigned a new task')
        . ' in the operations dashboard. Please review the task details below and proceed accordingly.'
        . '</p>'
        . '<div style="margin:0 0 16px 0;padding:14px 16px;background:linear-gradient(135deg,#f8fbff 0%,#f1f7ff 100%);border:1px solid #d6e4ff;border-radius:12px;">'
        . '<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#1d4ed8;">' . $safeHeadline . '</p>'
        . '<p style="margin:0;font-size:18px;line-height:1.5;font-weight:700;color:#0f172a;">' . $safeTaskTitle . '</p>'
        . '</div>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px 0;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Task ID</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safeTaskIdLabel . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Role</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safeRoleLabel . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Project</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safeProjectName . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Client</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safeClientName . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Priority</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safePriorityLabel . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Due Date</td><td style="padding:11px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e2e8f0;">' . $safeDueDateLabel . '</td></tr>'
        . '<tr><td style="padding:11px 14px;width:42%;font-size:12px;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;color:#64748b;background:#f8fafc;">Assigned By</td><td style="padding:11px 14px;font-size:13px;color:#111827;">' . $safeAssignerName . '</td></tr>'
        . '</table>'
        . '<div style="margin:0 0 16px 0;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">'
        . '<p style="margin:0 0 7px 0;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;font-weight:700;color:#64748b;">Task Summary</p>'
        . '<p style="margin:0;font-size:13px;line-height:1.8;color:#1f2937;">' . $safeTaskDescription . '</p>'
        . '</div>'
        . '<p style="margin:0 0 8px 0;text-align:center;">'
        . '<a href="' . $safeTaskHubUrl . '" style="display:inline-block;padding:12px 22px;background:#0f2d74;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Open My Tasks</a>'
        . '</p>'
        . '<p style="margin:0;font-size:12px;line-height:1.7;color:#6b7280;text-align:center;">If the button does not open, use this link: '
        . '<a href="' . $safeTaskHubUrl . '" style="color:#1d4ed8;text-decoration:none;">' . $safeTaskHubUrl . '</a></p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, 'A task assignment has been issued by your ' . $assignerTitleForMessage . '.')
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    $alt = "Dear " . $assigneeName . ",\n\n"
        . "You have been " . ($isReassignment ? 'reassigned' : 'assigned') . " a task by your " . $assignerTitleForMessage . ".\n\n"
        . "Task ID: " . $taskIdLabel . "\n"
        . "Task: " . $taskTitle . "\n"
        . "Project: " . $projectName . "\n"
        . "Client: " . $clientName . "\n"
        . "Priority: " . $priorityLabel . "\n"
        . "Due Date: " . $dueDateLabel . "\n"
        . "Assigned By: " . $assignerName . "\n\n"
        . "Task Summary:\n" . $taskDescription . "\n\n"
        . "Open your task list:\n" . $taskHubUrl;

    $sent = sendMail($toEmail, $assigneeName, $subject, $html, $alt);
    if (!$sent) {
        error_log('sendTaskAssignmentNotificationEmail: failed for task_id=' . intval($taskId) . ', assignee=' . $toEmail);
    }

    return ['attempted' => true, 'sent' => (bool)$sent];
}

function getTaskCollaboratorNotificationContext($conn, $taskId, $collaboratorUserId, $actorUserId) {
    $resolvedTaskId = intval($taskId);
    $resolvedCollaboratorUserId = intval($collaboratorUserId);
    $resolvedActorUserId = intval($actorUserId);
    if ($resolvedTaskId <= 0 || $resolvedCollaboratorUserId <= 0) {
        return null;
    }

    $sql = "SELECT t.id,
                   t.title,
                   t.description,
                   t.priority,
                   t.due_date,
                   t.assigned_to,
                   p.id AS project_id,
                   p.name AS project_name,
                   c.client_name,
                   tc.shift_mode,
                   tc.shift_start,
                   tc.shift_end,
                   cu.email AS collaborator_email,
                   cu.first_name AS collaborator_first_name,
                   cu.last_name AS collaborator_last_name,
                   cu.role AS collaborator_role,
                   au.first_name AS assignee_first_name,
                   au.last_name AS assignee_last_name,
                   su.first_name AS actor_first_name,
                   su.last_name AS actor_last_name,
                   su.role AS actor_role
            FROM tasks t
            LEFT JOIN projects p ON p.id = t.project_id
            LEFT JOIN client c ON c.client_id = p.client_id
            INNER JOIN task_collaborators tc ON tc.task_id = t.id AND tc.user_id = ?
            LEFT JOIN users cu ON cu.id = tc.user_id
            LEFT JOIN users au ON au.id = t.assigned_to
            LEFT JOIN users su ON su.id = ?
            WHERE t.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log('getTaskCollaboratorNotificationContext: prepare failed for task_id=' . $resolvedTaskId . ': ' . $conn->error);
        return null;
    }

    $stmt->bind_param('iii', $resolvedCollaboratorUserId, $resolvedActorUserId, $resolvedTaskId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function sendTaskCollaboratorNotificationEmail($conn, $taskId, $collaboratorUserId, $actorRole, $actorUserId) {
    $normalizedActorRole = strtolower(trim((string)$actorRole));
    if (!in_array($normalizedActorRole, ['admin', 'manager'], true)) {
        return ['attempted' => false, 'sent' => null];
    }

    $resolvedCollaboratorUserId = intval($collaboratorUserId);
    if ($resolvedCollaboratorUserId <= 0) {
        return ['attempted' => false, 'sent' => null];
    }

    if (!function_exists('sendMail')) {
        error_log('sendTaskCollaboratorNotificationEmail: sendMail function unavailable.');
        return ['attempted' => true, 'sent' => false];
    }

    $context = getTaskCollaboratorNotificationContext($conn, $taskId, $resolvedCollaboratorUserId, $actorUserId);
    if (!$context) {
        error_log('sendTaskCollaboratorNotificationEmail: context missing for task_id=' . intval($taskId) . ', collaborator=' . $resolvedCollaboratorUserId);
        return ['attempted' => true, 'sent' => false];
    }

    $toEmail = trim((string)($context['collaborator_email'] ?? ''));
    if ($toEmail === '' || !validateEmail($toEmail)) {
        error_log('sendTaskCollaboratorNotificationEmail: collaborator email is invalid for task_id=' . intval($taskId) . ', collaborator=' . $resolvedCollaboratorUserId);
        return ['attempted' => true, 'sent' => false];
    }

    $collaboratorName = formatTaskEmailPersonName(
        $context['collaborator_first_name'] ?? '',
        $context['collaborator_last_name'] ?? '',
        $toEmail
    );
    $actorName = formatTaskEmailPersonName(
        $context['actor_first_name'] ?? '',
        $context['actor_last_name'] ?? '',
        $normalizedActorRole === 'manager' ? 'Manager' : 'Administrator'
    );

    $actorRoleForMessage = strtolower(trim((string)($context['actor_role'] ?? $normalizedActorRole)));
    $actorTitleForMessage = $actorRoleForMessage === 'manager' ? 'manager' : 'administrator';
    $taskTitle = trim((string)($context['title'] ?? 'Untitled Task'));
    $taskDescriptionRaw = trim((string)($context['description'] ?? ''));
    $taskDescription = $taskDescriptionRaw !== '' ? $taskDescriptionRaw : 'No additional description was provided.';
    $taskDescriptionLength = function_exists('mb_strlen') ? mb_strlen($taskDescription) : strlen($taskDescription);
    if ($taskDescriptionLength > 420) {
        $taskDescription = function_exists('mb_substr')
            ? mb_substr($taskDescription, 0, 417) . '...'
            : substr($taskDescription, 0, 417) . '...';
    }

    $projectId = intval($context['project_id'] ?? 0);
    $projectName = trim((string)($context['project_name'] ?? 'N/A'));
    $clientName = trim((string)($context['client_name'] ?? 'N/A'));
    $priorityLabel = formatTaskPriorityLabel($context['priority'] ?? '');
    $dueDateLabel = formatTaskDueDateLabel($context['due_date'] ?? '');
    $taskIdLabel = '#' . intval($context['id'] ?? $taskId);
    $shiftWindowLabel = formatTaskCollaboratorShiftLabel(
        $context['shift_mode'] ?? 'none',
        $context['shift_start'] ?? '',
        $context['shift_end'] ?? ''
    );

    $primaryAssignee = 'Unassigned';
    if (intval($context['assigned_to'] ?? 0) > 0) {
        $primaryAssignee = formatTaskEmailPersonName(
            $context['assignee_first_name'] ?? '',
            $context['assignee_last_name'] ?? '',
            'Assigned Staff'
        );
    }

    $workspaceUrl = $projectId > 0
        ? buildTaskEmailFrontendBaseUrl() . '/projects/detail?id=' . $projectId
        : buildTaskEmailFrontendBaseUrl() . '/my-tasks';
    $safeWorkspaceUrl = htmlspecialchars($workspaceUrl, ENT_QUOTES, 'UTF-8');
    $safeCollaboratorName = htmlspecialchars($collaboratorName, ENT_QUOTES, 'UTF-8');
    $safeTaskTitle = htmlspecialchars($taskTitle, ENT_QUOTES, 'UTF-8');
    $safeTaskDescription = nl2br(htmlspecialchars($taskDescription, ENT_QUOTES, 'UTF-8'));
    $safeProjectName = htmlspecialchars($projectName, ENT_QUOTES, 'UTF-8');
    $safeClientName = htmlspecialchars($clientName, ENT_QUOTES, 'UTF-8');
    $safePriorityLabel = htmlspecialchars($priorityLabel, ENT_QUOTES, 'UTF-8');
    $safeDueDateLabel = htmlspecialchars($dueDateLabel, ENT_QUOTES, 'UTF-8');
    $safeTaskIdLabel = htmlspecialchars($taskIdLabel, ENT_QUOTES, 'UTF-8');
    $safeShiftWindowLabel = htmlspecialchars($shiftWindowLabel, ENT_QUOTES, 'UTF-8');
    $safePrimaryAssignee = htmlspecialchars($primaryAssignee, ENT_QUOTES, 'UTF-8');
    $safeActorName = htmlspecialchars($actorName, ENT_QUOTES, 'UTF-8');
    $safeActorTitle = htmlspecialchars($actorTitleForMessage, ENT_QUOTES, 'UTF-8');
    $safeCollaboratorRoleLabel = htmlspecialchars('Staff Collaborator', ENT_QUOTES, 'UTF-8');

    $subject = 'Task Collaboration Added: ' . $taskTitle . ' (' . $taskIdLabel . ')';
    $preheader = 'You were added as a collaborator on "' . $taskTitle . '".';

    $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.75;color:#0f172a;">Hello <strong>' . $safeCollaboratorName . '</strong>,</p>'
        . '<p style="margin:0 0 18px 0;font-size:14px;line-height:1.9;color:#334155;">You have been added as a collaborator on a project task by your ' . $safeActorTitle . '. You can now access the task workspace, review the task brief, and coordinate with the assigned staff member based on the collaboration window below.</p>'
        . '<div style="margin:0 0 18px 0;padding:18px 18px 16px 18px;background:linear-gradient(135deg,#f8fbff 0%,#eef4ff 55%,#f8fafc 100%);border:1px solid #d6e4ff;border-radius:16px;">'
        . '<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:#1d4ed8;">Collaboration Access Enabled</p>'
        . '<p style="margin:0 0 8px 0;font-size:20px;line-height:1.4;font-weight:700;color:#0f172a;">' . $safeTaskTitle . '</p>'
        . '<p style="margin:0;font-size:13px;line-height:1.8;color:#475569;">Project: <strong>' . $safeProjectName . '</strong> &nbsp;&middot;&nbsp; Client: <strong>' . $safeClientName . '</strong></p>'
        . '</div>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px 0;border-collapse:collapse;background:#ffffff;border:1px solid #dbe3ef;border-radius:16px;overflow:hidden;">'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Task ID</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeTaskIdLabel . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Role</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeCollaboratorRoleLabel . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Project</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeProjectName . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Client</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeClientName . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Priority</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safePriorityLabel . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Due Date</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeDueDateLabel . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Primary Assignee</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safePrimaryAssignee . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Collaboration Window</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeShiftWindowLabel . '</td></tr>'
        . '<tr><td style="padding:12px 14px;width:40%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;">Added By</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;">' . $safeActorName . '</td></tr>'
        . '</table>'
        . '<div style="margin:0 0 16px 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">'
        . '<p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;font-weight:700;color:#64748b;">Task Brief</p>'
        . '<p style="margin:0;font-size:13px;line-height:1.85;color:#1f2937;">' . $safeTaskDescription . '</p>'
        . '</div>'
        . '<p style="margin:0 0 8px 0;text-align:center;">'
        . '<a href="' . $safeWorkspaceUrl . '" style="display:inline-block;padding:12px 22px;background:#0f2d74;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:700;">Open Project Workspace</a>'
        . '</p>'
        . '<p style="margin:0;font-size:12px;line-height:1.7;color:#6b7280;text-align:center;">If the button does not open, use this link: '
        . '<a href="' . $safeWorkspaceUrl . '" style="color:#1d4ed8;text-decoration:none;">' . $safeWorkspaceUrl . '</a></p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, $preheader)
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    $alt = "Hello " . $collaboratorName . ",\n\n"
        . "You have been added as a collaborator on a project task by your " . $actorTitleForMessage . ".\n\n"
        . "Task ID: " . $taskIdLabel . "\n"
        . "Task: " . $taskTitle . "\n"
        . "Project: " . $projectName . "\n"
        . "Client: " . $clientName . "\n"
        . "Priority: " . $priorityLabel . "\n"
        . "Due Date: " . $dueDateLabel . "\n"
        . "Primary Assignee: " . $primaryAssignee . "\n"
        . "Collaboration Window: " . $shiftWindowLabel . "\n"
        . "Added By: " . $actorName . "\n\n"
        . "Task Brief:\n" . $taskDescription . "\n\n"
        . "Open the project workspace:\n" . $workspaceUrl;

    $sent = sendMail($toEmail, $collaboratorName, $subject, $html, $alt);
    if (!$sent) {
        error_log('sendTaskCollaboratorNotificationEmail: failed for task_id=' . intval($taskId) . ', collaborator=' . $toEmail);
    }

    return ['attempted' => true, 'sent' => (bool)$sent];
}

function sendTaskCollaboratorNotificationEmails($conn, $taskId, $collaboratorUserIds, $actorRole, $actorUserId) {
    if (!is_array($collaboratorUserIds) || empty($collaboratorUserIds)) {
        return ['attempted' => 0, 'sent' => 0];
    }

    $recipientIds = array_values(array_unique(array_filter(array_map('intval', $collaboratorUserIds), function($id) {
        return $id > 0;
    })));

    if (empty($recipientIds)) {
        return ['attempted' => 0, 'sent' => 0];
    }

    $attempted = 0;
    $sentCount = 0;

    foreach ($recipientIds as $recipientId) {
        $result = sendTaskCollaboratorNotificationEmail($conn, $taskId, $recipientId, $actorRole, $actorUserId);
        if (!empty($result['attempted'])) {
            $attempted++;
        }
        if (!empty($result['sent'])) {
            $sentCount++;
        }
    }

    return ['attempted' => $attempted, 'sent' => $sentCount];
}

function validateCollaboratorUsers($conn, $collaborators, $actorRole = '', $actorBranchId = 0) {
    if (empty($collaborators)) {
        return;
    }

    $ids = array_values(array_unique(array_map(function($item) {
        return intval($item['user_id'] ?? 0);
    }, $collaborators)));
    $ids = array_values(array_filter($ids, function($id) {
        return $id > 0;
    }));

    if (empty($ids)) {
        return;
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $sql = "SELECT id, role, branch_id FROM users WHERE id IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to validate collaborators.', 500);
    }

    $types = str_repeat('i', count($ids));
    $stmt->bind_param($types, ...$ids);
    $stmt->execute();
    $result = $stmt->get_result();

    $users = [];
    while ($row = $result->fetch_assoc()) {
        $users[intval($row['id'])] = [
            'role' => strtolower((string)$row['role']),
            'branch_id' => intval($row['branch_id'] ?? 0),
        ];
    }
    $stmt->close();

    $normalizedActorRole = strtolower(trim((string)$actorRole));
    $managerBranchId = intval($actorBranchId);

    foreach ($ids as $id) {
        if (!isset($users[$id])) {
            sendError("Collaborator user not found (ID: $id)", 400);
        }
        if (($users[$id]['role'] ?? '') !== 'staff') {
            sendError('Only staff users can be added as task collaborators', 400);
        }
        if ($normalizedActorRole === 'manager') {
            if ($managerBranchId <= 0) {
                sendError('Your account is not linked to a branch.', 403);
            }
            $targetBranchId = intval($users[$id]['branch_id'] ?? 0);
            if ($targetBranchId <= 0 || $targetBranchId !== $managerBranchId) {
                sendError('Managers can only add task collaborators from their own branch.', 403);
            }
        }
    }
}

function syncTaskCollaborators($conn, $task_id, $collaborators, $actor_user_id = null, $actorRole = '', $actorBranchId = 0) {
    if ($collaborators === null) {
        return ['added' => [], 'removed' => [], 'updated' => []];
    }

    validateCollaboratorUsers($conn, $collaborators, $actorRole, $actorBranchId);

    $existingStmt = $conn->prepare("SELECT user_id FROM task_collaborators WHERE task_id = ?");
    if (!$existingStmt) {
        error_log($conn->error);
        sendError('Failed to load current collaborators.', 500);
    }
    $existingStmt->bind_param('i', $task_id);
    $existingStmt->execute();
    $existingResult = $existingStmt->get_result();

    $existing = [];
    while ($row = $existingResult->fetch_assoc()) {
        $existing[] = intval($row['user_id']);
    }
    $existingStmt->close();

    $incoming = [];
    foreach ($collaborators as $row) {
        $uid = intval($row['user_id'] ?? 0);
        if ($uid > 0) $incoming[$uid] = $row;
    }

    $incomingIds = array_keys($incoming);
    $removed = array_values(array_diff($existing, $incomingIds));
    $added = array_values(array_diff($incomingIds, $existing));
    $updated = array_values(array_intersect($incomingIds, $existing));

    if (!empty($removed)) {
        $placeholders = implode(',', array_fill(0, count($removed), '?'));
        $deleteSql = "DELETE FROM task_collaborators WHERE task_id = ? AND user_id IN ($placeholders)";
        $deleteStmt = $conn->prepare($deleteSql);
        if (!$deleteStmt) {
            error_log($conn->error);
            sendError('Failed to remove collaborators.', 500);
        }
        $params = array_merge([$task_id], $removed);
        $types = 'i' . str_repeat('i', count($removed));
        $deleteStmt->bind_param($types, ...$params);
        if (!$deleteStmt->execute()) {
            $deleteStmt->close();
            error_log($conn->error);
            sendError('Failed to remove collaborators.', 500);
        }
        $deleteStmt->close();
    }

    $insertStmt = $conn->prepare(
        "INSERT INTO task_collaborators (task_id, user_id, shift_mode, shift_start, shift_end, created_by)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    if (!$insertStmt) {
        error_log($conn->error);
        sendError('Failed to prepare collaborator insert.', 500);
    }

    $updateStmt = $conn->prepare(
        "UPDATE task_collaborators
         SET shift_mode = ?, shift_start = ?, shift_end = ?, updated_at = CURRENT_TIMESTAMP
         WHERE task_id = ? AND user_id = ?"
    );
    if (!$updateStmt) {
        $insertStmt->close();
        error_log($conn->error);
        sendError('Failed to prepare collaborator update.', 500);
    }

    foreach ($incoming as $uid => $collab) {
        $shift_mode = $collab['shift_mode'] ?? 'none';
        $shift_start = $collab['shift_start'] ?? null;
        $shift_end = $collab['shift_end'] ?? null;
        $creator = $actor_user_id ? intval($actor_user_id) : null;

        if (in_array($uid, $added, true)) {
            $insertStmt->bind_param('iisssi', $task_id, $uid, $shift_mode, $shift_start, $shift_end, $creator);
            if (!$insertStmt->execute()) {
                $insertStmt->close();
                $updateStmt->close();
                error_log($conn->error);
                sendError('Failed to add collaborator.', 500);
            }
        } else {
            $updateStmt->bind_param('sssii', $shift_mode, $shift_start, $shift_end, $task_id, $uid);
            if (!$updateStmt->execute()) {
                $insertStmt->close();
                $updateStmt->close();
                error_log($conn->error);
                sendError('Failed to update collaborator shift.', 500);
            }
        }
    }

    $insertStmt->close();
    $updateStmt->close();

    return ['added' => $added, 'removed' => $removed, 'updated' => $updated];
}

function attachCollaboratorsToTasks($conn, $tasks, $current_user_id = 0) {
    if (empty($tasks)) return $tasks;

    $taskIds = [];
    foreach ($tasks as $row) {
        $tid = intval($row['id'] ?? 0);
        if ($tid > 0) $taskIds[] = $tid;
    }
    $taskIds = array_values(array_unique($taskIds));
    if (empty($taskIds)) return $tasks;

    $placeholders = implode(',', array_fill(0, count($taskIds), '?'));
    $sql = "SELECT tc.task_id,
                   tc.user_id,
                   tc.shift_mode,
                   tc.shift_start,
                   tc.shift_end,
                   tc.created_at,
                   tc.updated_at,
                   CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS collaborator_name,
                   u.role AS collaborator_role
            FROM task_collaborators tc
            LEFT JOIN users u ON u.id = tc.user_id
            WHERE tc.task_id IN ($placeholders)
            ORDER BY tc.created_at ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return $tasks;
    }
    $types = str_repeat('i', count($taskIds));
    $stmt->bind_param($types, ...$taskIds);
    $stmt->execute();
    $result = $stmt->get_result();

    $collabMap = [];
    while ($row = $result->fetch_assoc()) {
        $tid = intval($row['task_id'] ?? 0);
        if ($tid <= 0) continue;

        $name = trim((string)($row['collaborator_name'] ?? ''));
        if ($name === '') {
            $name = 'User #' . intval($row['user_id'] ?? 0);
        }

        if (!isset($collabMap[$tid])) {
            $collabMap[$tid] = [];
        }
        $collabMap[$tid][] = [
            'user_id' => intval($row['user_id'] ?? 0),
            'name' => $name,
            'role' => strtolower((string)($row['collaborator_role'] ?? '')),
            'shift_mode' => (string)($row['shift_mode'] ?? 'none'),
            'shift_start' => $row['shift_start'] ?? null,
            'shift_end' => $row['shift_end'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
    $stmt->close();

    foreach ($tasks as &$task) {
        $tid = intval($task['id'] ?? 0);
        $collabs = $collabMap[$tid] ?? [];
        $task['collaborators'] = $collabs;

        $task['is_collaborator'] = false;
        if ($current_user_id > 0) {
            foreach ($collabs as $collab) {
                if (intval($collab['user_id'] ?? 0) === intval($current_user_id)) {
                    $task['is_collaborator'] = true;
                    break;
                }
            }
        }
    }
    unset($task);

    return $tasks;
}

function staffHasTaskAccess($conn, $task_id, $user_id) {
    $sql = "SELECT id
            FROM tasks
            WHERE id = ?
              AND (assigned_to = ? OR EXISTS (
                    SELECT 1
                    FROM task_collaborators tc
                    WHERE tc.task_id = tasks.id
                      AND tc.user_id = ?
              ))
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return false;

    $stmt->bind_param('iii', $task_id, $user_id, $user_id);
    $stmt->execute();
    $result = $stmt->get_result();
    $allowed = $result && $result->num_rows > 0;
    $stmt->close();

    return $allowed;
}

function handleGet($conn) {
    $project_id = $_GET['project_id'] ?? null;
    $project_ids = parsePositiveIntListParam($_GET['project_ids'] ?? null);
    $assigned_to = $_GET['assigned_to'] ?? null;
    $task_id = $_GET['id'] ?? null;
    $include_collaborations = filter_var($_GET['include_collaborations'] ?? false, FILTER_VALIDATE_BOOLEAN);
    $compact = strtolower(trim((string)($_GET['compact'] ?? '')));
    $is_dashboard_compact = $compact === 'dashboard';
    $has_service_id = $is_dashboard_compact ? false : columnExists($conn, 'tasks', 'service_id');
    $serviceSelect = $has_service_id
        ? "COALESCE(s.service_name, (
               SELECT GROUP_CONCAT(sv.service_name ORDER BY LOWER(TRIM(sv.service_name)) SEPARATOR ', ')
               FROM client_services cs2
               INNER JOIN services sv ON sv.service_id = cs2.service_id
               WHERE cs2.client_id = p.client_id AND cs2.status = 'active'
           )) as service_name"
        : "(
               SELECT GROUP_CONCAT(sv.service_name ORDER BY LOWER(TRIM(sv.service_name)) SEPARATOR ', ')
               FROM client_services cs2
               INNER JOIN services sv ON sv.service_id = cs2.service_id
               WHERE cs2.client_id = p.client_id AND cs2.status = 'active'
           ) as service_name";
    $serviceJoin = $has_service_id ? 'LEFT JOIN services s ON t.service_id = s.service_id' : '';
    $has_completion_report = $is_dashboard_compact ? false : tableExists($conn, 'task_completion_reports');
    $reportSelect = $has_completion_report
        ? "CASE WHEN tcr.report_id IS NULL THEN 0 ELSE 1 END as has_completion_report,
           tcr.sent_at as completion_report_sent_at,
           tcr.sent_by as completion_report_sent_by"
        : "0 as has_completion_report,
           NULL as completion_report_sent_at,
           NULL as completion_report_sent_by";
    $reportJoin = $has_completion_report ? 'LEFT JOIN task_completion_reports tcr ON tcr.task_id = t.id' : '';
    
    // RBAC: Staff can only see tasks assigned to them
    $role = $_SESSION['role'] ?? '';
    $current_user_id = $_SESSION['user_id'] ?? null;

    if ($task_id) {
        $sql = "SELECT t.*, 
                       CONCAT(u.first_name, ' ', u.last_name) as assigned_name,
                       p.name as project_name,
                       c.client_name,
                       $serviceSelect,
                       $reportSelect
                FROM tasks t
                LEFT JOIN users u ON t.assigned_to = u.id
                LEFT JOIN projects p ON t.project_id = p.id
                LEFT JOIN client c ON p.client_id = c.client_id
                $serviceJoin
                $reportJoin
                WHERE t.id = ?";
        
        // Staff can only view tasks assigned to them or shared with them as collaborator.
        if ($role === 'staff' && $current_user_id) {
            $sql .= " AND (t.assigned_to = ? OR EXISTS (
                            SELECT 1
                            FROM task_collaborators tc_scope
                            WHERE tc_scope.task_id = t.id
                              AND tc_scope.user_id = ?
                        ))";
            $stmt = $conn->prepare($sql);
            if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
            $stmt->bind_param('iii', $task_id, $current_user_id, $current_user_id);
        } else {
            $stmt = $conn->prepare($sql);
            if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
            $stmt->bind_param('i', $task_id);
        }
        
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($row = $result->fetch_assoc()) {
            $rows = attachCollaboratorsToTasks($conn, [$row], intval($current_user_id));
            sendResponse(true, $rows[0], 'Task retrieved');
        } else {
            sendError('Task not found', 404);
        }
    } else {
        if ($is_dashboard_compact) {
            $sql = "SELECT t.id,
                           t.title,
                           t.status,
                           t.due_date,
                           p.name as project_name,
                           c.client_name
                    FROM tasks t
                    LEFT JOIN projects p ON t.project_id = p.id
                    LEFT JOIN client c ON p.client_id = c.client_id
                    WHERE 1=1 AND (p.status IS NULL OR p.status != 'archived')";
        } else {
            $sql = "SELECT t.*, 
                           CONCAT(u.first_name, ' ', u.last_name) as assigned_name,
                           p.name as project_name,
                           c.client_name,
                           $serviceSelect,
                           $reportSelect
                    FROM tasks t
                    LEFT JOIN users u ON t.assigned_to = u.id
                    LEFT JOIN projects p ON t.project_id = p.id
                    LEFT JOIN client c ON p.client_id = c.client_id
                    $serviceJoin
                    $reportJoin
                    WHERE 1=1 AND (p.status IS NULL OR p.status != 'archived')";
        }
        
        $params = [];
        $types = '';
        
        if (!empty($project_ids)) {
            $placeholders = implode(',', array_fill(0, count($project_ids), '?'));
            $sql .= " AND t.project_id IN ($placeholders)";
            foreach ($project_ids as $batchedProjectId) {
                $params[] = $batchedProjectId;
                $types .= 'i';
            }
        } elseif ($project_id) {
            $sql .= " AND t.project_id = ?";
            $params[] = $project_id;
            $types .= 'i';
        }
        
        if ($assigned_to !== null && $assigned_to !== '') {
            $assignedUserId = intval($assigned_to);
            if ($include_collaborations) {
                $sql .= " AND (t.assigned_to = ? OR EXISTS (
                                SELECT 1
                                FROM task_collaborators tc_filter
                                WHERE tc_filter.task_id = t.id
                                  AND tc_filter.user_id = ?
                            ))";
                $params[] = $assignedUserId;
                $params[] = $assignedUserId;
                $types .= 'ii';
            } else {
                $sql .= " AND t.assigned_to = ?";
                $params[] = $assignedUserId;
                $types .= 'i';
            }
        }

        if (isset($_GET['client_id'])) {
            $sql .= " AND p.client_id = ?";
            $params[] = $_GET['client_id'];
            $types .= 'i';
        }
        
        // RBAC: Staff only sees tasks assigned to them or shared with them as collaborator.
        if ($role === 'staff' && $current_user_id) {
            $sql .= " AND (t.assigned_to = ? OR EXISTS (
                            SELECT 1
                            FROM task_collaborators tc_scope
                            WHERE tc_scope.task_id = t.id
                              AND tc_scope.user_id = ?
                        ))";
            $params[] = $current_user_id;
            $params[] = $current_user_id;
            $types .= 'ii';
        }
        
        $sql .= " ORDER BY t.due_date ASC, t.priority DESC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
            if (!$result) { error_log($conn->error); sendError('Query execution failed.', 500); }
        }
        
        $tasks = [];
        while ($row = $result->fetch_assoc()) {
            $tasks[] = $row;
        }
        if (!$is_dashboard_compact) {
            $tasks = attachCollaboratorsToTasks($conn, $tasks, intval($current_user_id));
        }
        
        sendResponse(true, $tasks, 'Tasks retrieved');
    }
}

function handlePost($conn) {
    // RBAC: Staff cannot create tasks
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot create tasks', 403);
    }

    $data = getJSONInput();
    
    $required = ['title', 'project_id'];
    if ($missing = validateRequiredFields($data, $required)) {
        sendError('Missing fields', 400);
    }
    
    $title = sanitizeInput($data['title']);
    $desc = sanitizeInput($data['description'] ?? '');
    $project_id = intval($data['project_id']);
    $has_service_id = columnExists($conn, 'tasks', 'service_id');
    $service_id = $has_service_id ? parseNullablePositiveIntField($data['service_id'] ?? null, 'service_id') : null;
    $assigned_to = parseNullablePositiveIntField($data['assigned_to'] ?? null, 'assigned_to');
    $created_by = checkAuthentication() ?: null;
    releaseSessionLock();
    $actorUserId = intval($created_by ?: 0);
    $due_date = normalizeDateTimeInput($data['due_date'] ?? null);
    if (array_key_exists('due_date', $data) && $data['due_date'] !== null && $data['due_date'] !== '' && $due_date === null) {
        sendError('Invalid due date.', 400);
    }
    $deadline_reminder_at = normalizeDateTimeInput($data['deadline_reminder_at'] ?? null);
    if (array_key_exists('deadline_reminder_at', $data) && $data['deadline_reminder_at'] !== null && $data['deadline_reminder_at'] !== '' && $deadline_reminder_at === null) {
        sendError('Invalid deadline reminder date.', 400);
    }
    assertDeadlineReminderBeforeDueDate($deadline_reminder_at, $due_date);
    $priority = $data['priority'] ?? 'medium';
    $collaborators = normalizeCollaboratorsInput($data);
    $actorRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
    $actorBranchId = intval($_SESSION['branch_id'] ?? 0);
    $collaboratorSyncResult = ['added' => [], 'removed' => [], 'updated' => []];
    $requireCompletionProof = !empty($data['require_completion_proof']) ? 1 : 0;
    $initialStatus = 'pending';

    requireManagerOwnsProjectForTaskMutation($conn, $project_id);

    if ($assigned_to !== null) {
        assertManagerCanAssignTaskUser($conn, $assigned_to, $actorRole, $actorBranchId);
    }

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start task creation transaction.', 500);
    }

    if ($has_service_id) {
        $sql = "INSERT INTO tasks (title, description, project_id, service_id, assigned_to, require_completion_proof, created_by, status, workflow_status, priority, due_date, deadline_reminder_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?)";
        
        $stmt = $conn->prepare($sql);
        if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
        $stmt->bind_param('ssiiiisssss', $title, $desc, $project_id, $service_id, $assigned_to, $requireCompletionProof, $created_by, $initialStatus, $priority, $due_date, $deadline_reminder_at);
    } else {
        $sql = "INSERT INTO tasks (title, description, project_id, assigned_to, require_completion_proof, created_by, status, workflow_status, priority, due_date, deadline_reminder_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?)";
        
        $stmt = $conn->prepare($sql);
        if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
        $stmt->bind_param('ssiiisssss', $title, $desc, $project_id, $assigned_to, $requireCompletionProof, $created_by, $initialStatus, $priority, $due_date, $deadline_reminder_at);
    }
    
    if (!$stmt->execute()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Create failed.', 500);
    }

    $task_id = intval($conn->insert_id);

    if ($assigned_to !== null && intval($assigned_to) > 0) {
        logTaskAssignmentEvent($conn, $task_id, 0, intval($assigned_to), $actorUserId);
    }

    if ($collaborators !== null) {
        $collaboratorSyncResult = syncTaskCollaborators($conn, $task_id, $collaborators, $created_by ?: null, $actorRole, $actorBranchId);
    }

    if (!$conn->commit()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to finalize task creation.', 500);
    }

    // ── Fetch the created task row BEFORE flushing the response ──────────────
    $createdTask = null;
    $has_completion_report = tableExists($conn, 'task_completion_reports');
    $serviceSelect = $has_service_id
        ? "COALESCE(s.service_name, (
               SELECT GROUP_CONCAT(sv.service_name ORDER BY LOWER(TRIM(sv.service_name)) SEPARATOR ', ')
               FROM client_services cs2
               INNER JOIN services sv ON sv.service_id = cs2.service_id
               WHERE cs2.client_id = p.client_id AND cs2.status = 'active'
           )) as service_name"
        : "(
               SELECT GROUP_CONCAT(sv.service_name ORDER BY LOWER(TRIM(sv.service_name)) SEPARATOR ', ')
               FROM client_services cs2
               INNER JOIN services sv ON sv.service_id = cs2.service_id
               WHERE cs2.client_id = p.client_id AND cs2.status = 'active'
           ) as service_name";
    $serviceJoin = $has_service_id ? 'LEFT JOIN services s ON t.service_id = s.service_id' : '';
    $reportSelect = $has_completion_report
        ? "CASE WHEN tcr.report_id IS NULL THEN 0 ELSE 1 END as has_completion_report,
           tcr.sent_at as completion_report_sent_at,
           tcr.sent_by as completion_report_sent_by"
        : "0 as has_completion_report,
           NULL as completion_report_sent_at,
           NULL as completion_report_sent_by";
    $reportJoin = $has_completion_report ? 'LEFT JOIN task_completion_reports tcr ON tcr.task_id = t.id' : '';

    $createdTaskSql = "SELECT t.*,
                              CONCAT(u.first_name, ' ', u.last_name) as assigned_name,
                              p.name as project_name,
                              c.client_name,
                              $serviceSelect,
                              $reportSelect
                       FROM tasks t
                       LEFT JOIN users u ON t.assigned_to = u.id
                       LEFT JOIN projects p ON t.project_id = p.id
                       LEFT JOIN client c ON p.client_id = c.client_id
                       $serviceJoin
                       $reportJoin
                       WHERE t.id = ?
                       LIMIT 1";
    $createdTaskStmt = $conn->prepare($createdTaskSql);
    if ($createdTaskStmt) {
        $createdTaskStmt->bind_param('i', $task_id);
        $createdTaskStmt->execute();
        $createdTaskRow = $createdTaskStmt->get_result()->fetch_assoc();
        $createdTaskStmt->close();
        if ($createdTaskRow) {
            $createdRows = attachCollaboratorsToTasks($conn, [$createdTaskRow], $actorUserId);
            $createdTask = $createdRows[0] ?? $createdTaskRow;
        }
    }

    if (!$createdTask) {
        $createdTask = [
            'id' => $task_id,
            'title' => $title,
            'description' => $desc,
            'project_id' => $project_id,
            'service_id' => $service_id,
            'assigned_to' => $assigned_to,
            'require_completion_proof' => $requireCompletionProof,
            'created_by' => $created_by,
            'status' => $initialStatus,
            'workflow_status' => 'not_started',
            'priority' => $priority,
            'due_date' => $due_date,
            'deadline_reminder_at' => $deadline_reminder_at,
            'assigned_name' => null,
            'collaborators' => [],
            'has_completion_report' => 0,
        ];
    }

    $responseData = $createdTask;
    $responseData['task_id'] = $task_id;
    $responseData['assignment_email_sent'] = null;
    $responseData['collaborator_email_attempted'] = null;
    $responseData['collaborator_email_sent'] = null;

    // ── Flush response to browser immediately; send emails in background ──────
    // SMTP calls to Gmail block for several seconds. sendResponseAndContinue
    // releases the HTTP connection first, so the UI responds instantly.
    $emailAssignedTo = $assigned_to;
    $emailCollaboratorsAdded = $collaboratorSyncResult['added'] ?? [];

    sendResponseAndContinue(true, $responseData, 'Task created', 201);

    // ── Background: send notification emails after response is flushed ───────
    sendTaskAssignmentNotificationEmail(
        $conn,
        $task_id,
        $emailAssignedTo,
        $actorRole,
        $actorUserId,
        false
    );
    sendTaskCollaboratorNotificationEmails(
        $conn,
        $task_id,
        $emailCollaboratorsAdded,
        $actorRole,
        $actorUserId
    );
}

function handlePut($conn) {
    $data = getJSONInput();
    $id = intval($data['id'] ?? 0);
    $actorRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
    $actorBranchId = intval($_SESSION['branch_id'] ?? 0);
    $actorUserId = intval(checkAuthentication() ?: 0);
    releaseSessionLock();
    
    if (!$id) sendError('Task ID required', 400);
    requireManagerOwnsProjectForTaskMutation($conn, null, $id);

    $existsStmt = $conn->prepare("SELECT id, status, workflow_status, assigned_to, due_date, deadline_reminder_at, COALESCE(require_completion_proof, 0) AS require_completion_proof FROM tasks WHERE id = ? LIMIT 1");
    if (!$existsStmt) { error_log($conn->error); sendError('Failed to validate task.', 500); }
    $existsStmt->bind_param('i', $id);
    $existsStmt->execute();
    $taskRow = $existsStmt->get_result()->fetch_assoc();
    $existsStmt->close();
    if (!$taskRow) sendError('Task not found', 404);
    $currentTaskStatus = strtolower((string)($taskRow['status'] ?? ''));
    $currentWorkflowStatus = strtolower((string)($taskRow['workflow_status'] ?? 'not_started'));
    $previousAssignedTo = intval($taskRow['assigned_to'] ?? 0);
    $currentDueDate = $taskRow['due_date'] ?? null;
    $currentDeadlineReminderAt = $taskRow['deadline_reminder_at'] ?? null;
    $currentRequireCompletionProof = intval($taskRow['require_completion_proof'] ?? 0) === 1;
    $resolvedAssignee = null;
    $collaboratorSyncResult = ['added' => [], 'removed' => [], 'updated' => []];

    // RBAC: Staff restrictions
    $isStaff = isset($_SESSION['role']) && $_SESSION['role'] === 'staff';
    if ($isStaff) {
        if (array_key_exists('collaborators', $data)) {
            sendError('Staff cannot update task collaborators', 403);
        }
        $staff_id = intval($_SESSION['user_id'] ?? 0);
        if ($staff_id <= 0 || !staffHasTaskAccess($conn, $id, $staff_id)) {
            sendError('You can only update tasks assigned or shared with you', 403);
        }
    }
    
    $updates = [];
    $params = [];
    $types = '';
    $has_service_id = columnExists($conn, 'tasks', 'service_id');
    $collaborators = $isStaff ? null : normalizeCollaboratorsInput($data);

    // Completed tasks are closed for non-status changes.
    if ($currentTaskStatus === 'completed') {
        $nonStatusFields = ['title', 'description', 'assigned_to', 'priority', 'due_date', 'deadline_reminder_at', 'service_id'];
        $hasNonStatusUpdate = false;
        foreach ($nonStatusFields as $field) {
            if (array_key_exists($field, $data)) {
                $hasNonStatusUpdate = true;
                break;
            }
        }

        if ($collaborators !== null) {
            $hasNonStatusUpdate = true;
        }

        if ($hasNonStatusUpdate) {
            sendError('This task is closed because it is completed. Change status first to reopen it.', 409);
        }
    }
    
    $statusRequested = array_key_exists('status', $data);
    $requestedStatus = $statusRequested ? strtolower(trim((string)$data['status'])) : null;

    if ($statusRequested) {
        if ($isStaff) {
            sendError('Task status can only be changed through Start Task, Done/upload, and review actions.', 403);
        }
        if ($requestedStatus !== 'cancelled') {
            sendError('Task status can only be changed through the approval workflow. Use Start Task, Done/upload, manager review, or admin review.', 403);
        }
        if ($currentWorkflowStatus === 'completed') {
            sendError('Completed workflow tasks cannot be archived by editing status.', 409);
        }
    }

    // Staff cannot directly change status. Managers/admins can only archive/cancel from this legacy endpoint.
    $allowed = $isStaff
        ? ['require_completion_proof']
        : ['title', 'description', 'assigned_to', 'status', 'priority', 'due_date', 'deadline_reminder_at', 'require_completion_proof'];
    
    if (!$isStaff && $has_service_id) {
        $allowed[] = 'service_id';
    }

    if (array_key_exists('assigned_to', $data)) {
        $resolvedAssignee = parseNullablePositiveIntField($data['assigned_to'], 'assigned_to');
        if ($resolvedAssignee !== null) {
            assertManagerCanAssignTaskUser($conn, $resolvedAssignee, $actorRole, $actorBranchId);
        }
    }

    $requireProofRequested = array_key_exists('require_completion_proof', $data);
    $nextRequireCompletionProof = $requireProofRequested
        ? (!empty($data['require_completion_proof']) ? 1 : 0)
        : ($currentRequireCompletionProof ? 1 : 0);
    $assignedFieldProvided = array_key_exists('assigned_to', $data);
    $newAssignedTo = $assignedFieldProvided ? intval($resolvedAssignee ?? 0) : $previousAssignedTo;
    $assignmentChanged = $assignedFieldProvided && $newAssignedTo !== $previousAssignedTo;
    $assignmentNowAssigned = $newAssignedTo > 0;
    $dueDateFieldProvided = array_key_exists('due_date', $data);
    $deadlineReminderFieldProvided = array_key_exists('deadline_reminder_at', $data);
    $nextDueDateForValidation = $currentDueDate;
    $nextDeadlineReminderAtForValidation = $currentDeadlineReminderAt;

    foreach ($allowed as $field) {
        $hasField = ($field === 'assigned_to' || $field === 'service_id' || $field === 'require_completion_proof' || $field === 'due_date' || $field === 'deadline_reminder_at')
            ? array_key_exists($field, $data)
            : isset($data[$field]);
        if ($hasField) {
            if ($field === 'status') {
                $status = sanitizeInput($data[$field]);
                if (!in_array($status, ['pending', 'in_progress', 'completed', 'cancelled'], true)) {
                    sendError('Invalid task status', 400);
                }
            }
            $updates[] = "$field = ?";
            if ($field === 'assigned_to' || $field === 'service_id' || $field === 'require_completion_proof') {
                if ($field === 'assigned_to') {
                    $params[] = $resolvedAssignee;
                } elseif ($field === 'require_completion_proof') {
                    $params[] = $nextRequireCompletionProof;
                } else {
                    $params[] = parseNullablePositiveIntField($data[$field], $field);
                }
                $types .= 'i';
            } else {
                if ($field === 'due_date') {
                    $normalizedDueDate = normalizeDateTimeInput($data[$field]);
                    if ($data[$field] !== null && $data[$field] !== '' && $normalizedDueDate === null) {
                        sendError('Invalid due date.', 400);
                    }
                    $params[] = $normalizedDueDate;
                    $nextDueDateForValidation = $normalizedDueDate;
                } elseif ($field === 'deadline_reminder_at') {
                    $normalizedDeadlineReminder = normalizeDateTimeInput($data[$field]);
                    if ($data[$field] !== null && $data[$field] !== '' && $normalizedDeadlineReminder === null) {
                        sendError('Invalid deadline reminder date.', 400);
                    }
                    $params[] = $normalizedDeadlineReminder;
                    $nextDeadlineReminderAtForValidation = $normalizedDeadlineReminder;
                } else {
                    $params[] = sanitizeInput($data[$field]);
                }
                $types .= 's';
            }
        }
    }

    if ($dueDateFieldProvided || $deadlineReminderFieldProvided) {
        assertDeadlineReminderBeforeDueDate($nextDeadlineReminderAtForValidation, $nextDueDateForValidation);
    }

    if (empty($updates) && $collaborators === null) sendError('No update data', 400);

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start task update transaction.', 500);
    }

    if (!empty($updates)) {
        $params[] = $id;
        $types .= 'i';

        $sql = "UPDATE tasks SET " . implode(', ', $updates) . " WHERE id = ?";
        $stmt = $conn->prepare($sql);
        if (!$stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Query preparation failed.', 500);
        }
        $stmt->bind_param($types, ...$params);

        if (!$stmt->execute()) {
            $stmt->close();
            $conn->rollback();
            error_log($conn->error);
            sendError('Update failed.', 500);
        }
        $stmt->close();
    }

    if (!$isStaff && $collaborators !== null) {
        $collaboratorSyncResult = syncTaskCollaborators($conn, $id, $collaborators, $actorUserId > 0 ? $actorUserId : null, $actorRole, $actorBranchId);
    }

    $assignmentNowAssigned = $assignmentChanged && $newAssignedTo > 0;

    if ($assignmentNowAssigned) {
        logTaskAssignmentEvent($conn, $id, $previousAssignedTo, $newAssignedTo, $actorUserId);
    }

    if (!$conn->commit()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to finalize task update.', 500);
    }

    // Log if status changed (before flushing response)
    if ($actorUserId > 0 && isset($data['status'])) {
        logActivity($conn, $actorUserId, 'update_task', "Task $id status: " . $data['status'], 'task_management');
    }

    // ── Send HTTP response immediately so the browser isn't blocked by SMTP ──
    // Email sending (SMTP to Gmail) can take several seconds. We flush the
    // response to Next.js / the browser first, then send emails in the
    // background after the connection is released.
    $assignmentChangedToAssignee = $assignmentChanged && $newAssignedTo > 0;

    sendResponseAndContinue(true, [
        'assignment_email_sent' => null,
        'collaborator_email_attempted' => null,
        'collaborator_email_sent' => null,
    ], 'Task updated');

    // ── Background email sending (runs after response is flushed) ────────────
    if ($assignmentChangedToAssignee) {
        sendTaskAssignmentNotificationEmail(
            $conn,
            $id,
            $newAssignedTo,
            $actorRole,
            $actorUserId,
            $previousAssignedTo > 0
        );
    }
    sendTaskCollaboratorNotificationEmails(
        $conn,
        $id,
        $collaboratorSyncResult['added'] ?? [],
        $actorRole,
        $actorUserId
    );
}

function handleDelete($conn) {
    $id = intval($_GET['id'] ?? 0);
    if (!$id) sendError('ID required', 400);

    // RBAC: Staff cannot delete tasks
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot delete tasks', 403);
    }
    requireManagerOwnsProjectForTaskMutation($conn, null, $id);
    
    $sql = "DELETE FROM tasks WHERE id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) { error_log($conn->error); sendError('Query preparation failed.', 500); }
    $stmt->bind_param('i', $id);
    
    if ($stmt->execute()) {
        sendResponse(true, null, 'Task deleted');
    } else {
        error_log($conn->error);
        sendError('Delete failed.', 500);
    }
}

closeDBConnection($conn);
?>
