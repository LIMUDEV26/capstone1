<?php
/**
 * Task Workflow API
 * Document-Based Task Approval System
 * Handles: Start Task, Submit Document, Manager Review, Admin Review
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
$action = $_GET['action'] ?? '';

if (!function_exists('sendSuccess')) {
    function sendSuccess($data = null, $message = 'OK') {
        sendResponse(true, $data, $message);
    }
}

if (!function_exists('getRequestData')) {
    function getRequestData() {
        return getJSONInput();
    }
}

// Ensure user is authenticated
requireAuth();
ensureTaskWorkflowStorage($conn);

switch ($method) {
    case 'GET':
        if ($action === 'my_tasks') handleGetMyTasks($conn);
        elseif ($action === 'pending_reviews') handleGetPendingReviews($conn);
        elseif ($action === 'task_details') handleGetTaskDetails($conn);
        elseif ($action === 'approval_history') handleGetApprovalHistory($conn);
        elseif ($action === 'rejection_reasons') handleGetRejectionReasons($conn);
        elseif ($action === 'view_submission') handleViewSubmission($conn);
        else sendError('Invalid action', 400);
        break;
        
    case 'POST':
        if ($action === 'start_task') handleStartTask($conn);
        elseif ($action === 'submit_document') handleSubmitDocument($conn);
        elseif ($action === 'manager_review') handleManagerReview($conn);
        elseif ($action === 'admin_review') handleAdminReview($conn);
        elseif ($action === 'download_submission') handleDownloadSubmission($conn);
        elseif ($action === 'board_move') handleBoardMove($conn);
        else sendError('Invalid action', 400);
        break;
        
    default:
        sendError('Method not allowed', 405);
}

function twColumnExists($conn, $table, $column) {
    $stmt = $conn->prepare(
        "SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ss', $table, $column);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();
    return $exists;
}

function twIndexExists($conn, $table, $indexName) {
    $stmt = $conn->prepare(
        "SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ss', $table, $indexName);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();
    return $exists;
}

function twAddColumnIfMissing($conn, $column, $definition) {
    if (twColumnExists($conn, 'tasks', $column)) return;
    if (!$conn->query("ALTER TABLE tasks ADD COLUMN $column $definition")) {
        error_log($conn->error);
        sendError('Failed to initialize task workflow column ' . $column . '.', 500);
    }
}

function twTableExists($conn, $table) {
    $stmt = $conn->prepare("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1");
    if (!$stmt) return false;
    $stmt->bind_param('s', $table);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function twAddIndexIfMissing($conn, $table, $indexName, $definition) {
    if (twIndexExists($conn, $table, $indexName)) return;
    $safeTable = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    if (!$conn->query("ALTER TABLE $safeTable ADD INDEX $indexName $definition")) {
        // Indexes are performance-only. Keep the workflow usable if an index already exists under another name.
        error_log('Task workflow index init failed: ' . $conn->error);
    }
}

function ensureTaskWorkflowStorage($conn) {
    twAddColumnIfMissing($conn, 'workflow_status', "ENUM('not_started','in_progress','pending_manager','rejected_by_manager','pending_admin','rejected_by_admin','completed') NOT NULL DEFAULT 'not_started' AFTER status");
    twAddColumnIfMissing($conn, 'started_at', "TIMESTAMP NULL AFTER workflow_status");
    twAddColumnIfMissing($conn, 'submitted_at', "TIMESTAMP NULL AFTER started_at");
    twAddColumnIfMissing($conn, 'manager_reviewed_at', "TIMESTAMP NULL AFTER submitted_at");
    twAddColumnIfMissing($conn, 'manager_reviewed_by', "INT NULL AFTER manager_reviewed_at");
    twAddColumnIfMissing($conn, 'admin_reviewed_at', "TIMESTAMP NULL AFTER manager_reviewed_by");
    twAddColumnIfMissing($conn, 'admin_reviewed_by', "INT NULL AFTER admin_reviewed_at");
    twAddColumnIfMissing($conn, 'completed_at', "TIMESTAMP NULL AFTER admin_reviewed_by");

    twAddIndexIfMissing($conn, 'tasks', 'idx_workflow_status', '(workflow_status)');

    $submissionSql = "CREATE TABLE IF NOT EXISTS task_submissions (
        submission_id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        submitted_by INT NULL,
        submission_type ENUM('initial','resubmission') DEFAULT 'initial',
        file_path VARCHAR(500) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_size INT NOT NULL DEFAULT 0,
        mime_type VARCHAR(100),
        notes TEXT,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL,
        review_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_task (task_id),
        INDEX idx_submitted_by (submitted_by),
        INDEX idx_status (status),
        INDEX idx_submitted_at (submitted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    if (!$conn->query($submissionSql)) {
        error_log($conn->error);
        sendError('Failed to initialize task submissions.', 500);
    }

    $historySql = "CREATE TABLE IF NOT EXISTS task_approval_history (
        history_id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        submission_id INT NULL,
        action ENUM('task_started','document_submitted','manager_approved','manager_rejected','admin_approved','admin_rejected','resubmitted') NOT NULL,
        performed_by INT NULL,
        previous_status VARCHAR(50),
        new_status VARCHAR(50),
        comments TEXT,
        metadata JSON NULL,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_task (task_id),
        INDEX idx_action (action),
        INDEX idx_performed_by (performed_by),
        INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    if (!$conn->query($historySql)) {
        error_log($conn->error);
        sendError('Failed to initialize task approval history.', 500);
    }

    $rejectionSql = "CREATE TABLE IF NOT EXISTS task_rejection_reasons (
        rejection_id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        submission_id INT NULL,
        rejected_by INT NULL,
        rejected_by_role ENUM('manager','admin') NOT NULL,
        reason TEXT NOT NULL,
        requires_major_changes TINYINT(1) NOT NULL DEFAULT 0,
        expected_corrections TEXT,
        rejected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_task (task_id),
        INDEX idx_rejected_by (rejected_by),
        INDEX idx_rejected_at (rejected_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    if (!$conn->query($rejectionSql)) {
        error_log($conn->error);
        sendError('Failed to initialize task rejection reasons.', 500);
    }

    // Keep legacy `tasks.status` and workflow state aligned for old data.
    $conn->query("UPDATE tasks SET workflow_status = CASE
        WHEN status = 'completed' THEN 'completed'
        WHEN status = 'in_progress' THEN 'in_progress'
        ELSE 'not_started'
    END WHERE workflow_status IS NULL OR workflow_status = ''");

    $conn->query("CREATE OR REPLACE VIEW v_tasks_pending_manager_review AS
        SELECT t.*, CONCAT(staff.first_name, ' ', staff.last_name) as staff_name,
               staff.email as staff_email, p.name as project_name, p.manager_id,
               CONCAT(mgr.first_name, ' ', mgr.last_name) as manager_name,
               s.file_path, s.file_name, s.submitted_at as document_submitted_at,
               s.notes as submission_notes
        FROM tasks t
        LEFT JOIN users staff ON t.assigned_to = staff.id
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN users mgr ON p.manager_id = mgr.id
        LEFT JOIN task_submissions s ON s.submission_id = (
            SELECT submission_id FROM task_submissions latest
            WHERE latest.task_id = t.id AND latest.status = 'pending'
            ORDER BY latest.submitted_at DESC LIMIT 1
        )
        WHERE t.workflow_status = 'pending_manager'");

    $conn->query("CREATE OR REPLACE VIEW v_tasks_pending_admin_review AS
        SELECT t.*, CONCAT(staff.first_name, ' ', staff.last_name) as staff_name,
               staff.email as staff_email, p.name as project_name, p.manager_id,
               CONCAT(mgr.first_name, ' ', mgr.last_name) as manager_name,
               mgr_user.first_name as manager_approved_by_fname,
               mgr_user.last_name as manager_approved_by_lname,
               s.file_path, s.file_name, s.submitted_at as document_submitted_at
        FROM tasks t
        LEFT JOIN users staff ON t.assigned_to = staff.id
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN users mgr ON p.manager_id = mgr.id
        LEFT JOIN users mgr_user ON t.manager_reviewed_by = mgr_user.id
        LEFT JOIN task_submissions s ON s.submission_id = (
            SELECT submission_id FROM task_submissions latest
            WHERE latest.task_id = t.id AND latest.status = 'approved'
            ORDER BY latest.submitted_at DESC LIMIT 1
        )
        WHERE t.workflow_status = 'pending_admin'");

    $conn->query("CREATE OR REPLACE VIEW v_staff_rejected_tasks AS
        SELECT t.*, p.name as project_name, r.reason as rejection_reason,
               r.expected_corrections, r.rejected_by_role, r.rejected_at,
               CONCAT(rej.first_name, ' ', rej.last_name) as rejected_by_name
        FROM tasks t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN task_rejection_reasons r ON r.rejection_id = (
            SELECT rejection_id FROM task_rejection_reasons latest
            WHERE latest.task_id = t.id ORDER BY latest.rejected_at DESC LIMIT 1
        )
        LEFT JOIN users rej ON r.rejected_by = rej.id
        WHERE t.workflow_status IN ('rejected_by_manager', 'rejected_by_admin')");
}

function taskWorkflowUserHasStaffAccess($conn, $taskId, $userId) {
    $stmt = $conn->prepare("SELECT id FROM tasks WHERE id = ? AND (assigned_to = ? OR EXISTS (SELECT 1 FROM task_collaborators tc WHERE tc.task_id = tasks.id AND tc.user_id = ?)) LIMIT 1");
    if (!$stmt) return false;
    $stmt->bind_param('iii', $taskId, $userId, $userId);
    $stmt->execute();
    $allowed = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $allowed;
}

function getLatestTaskSubmission($conn, $taskId, $statuses = []) {
    $statusSql = '';
    $params = [$taskId];
    $types = 'i';
    if (!empty($statuses)) {
        $placeholders = implode(',', array_fill(0, count($statuses), '?'));
        $statusSql = " AND status IN ($placeholders)";
        foreach ($statuses as $status) {
            $params[] = $status;
            $types .= 's';
        }
    }
    $stmt = $conn->prepare("SELECT * FROM task_submissions WHERE task_id = ? $statusSql ORDER BY submitted_at DESC, submission_id DESC LIMIT 1");
    if (!$stmt) return null;
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

/**
 * Get tasks for the current user based on their role
 */
function handleGetMyTasks($conn) {
    $userId = $_SESSION['user_id'];
    $role = $_SESSION['role'];
    $status = $_GET['status'] ?? null;
    
    $hasServiceId = twColumnExists($conn, 'tasks', 'service_id');
    $serviceSelect = $hasServiceId
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
    $serviceJoin = $hasServiceId ? 'LEFT JOIN services s ON t.service_id = s.service_id' : '';
    $hasCompletionReport = twTableExists($conn, 'task_completion_reports');
    $reportSelect = $hasCompletionReport
        ? "CASE WHEN tcr.report_id IS NULL THEN 0 ELSE 1 END as has_completion_report,
           tcr.sent_at as completion_report_sent_at"
        : "0 as has_completion_report,
           NULL as completion_report_sent_at";
    $reportJoin = $hasCompletionReport ? 'LEFT JOIN task_completion_reports tcr ON tcr.task_id = t.id' : '';
    
    $sql = "SELECT 
                t.*,
                p.name as project_name,
                p.manager_id as project_manager_id,
                c.client_name,
                CONCAT(creator.first_name, ' ', creator.last_name) as created_by_name,
                CONCAT(assignee.first_name, ' ', assignee.last_name) as assigned_to_name,
                $serviceSelect,
                $reportSelect,
                (SELECT COUNT(*) FROM task_submissions WHERE task_id = t.id) as submission_count,
                (SELECT file_name FROM task_submissions WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1) as latest_file,
                (SELECT submitted_at FROM task_submissions WHERE task_id = t.id ORDER BY submitted_at DESC LIMIT 1) as latest_submission_time,
                (SELECT reason FROM task_rejection_reasons WHERE task_id = t.id ORDER BY rejected_at DESC LIMIT 1) as rejection_reason
            FROM tasks t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN client c ON p.client_id = c.client_id
            LEFT JOIN users creator ON t.created_by = creator.id
            LEFT JOIN users assignee ON t.assigned_to = assignee.id
            $serviceJoin
            $reportJoin
            WHERE ";
    
    // Role-based filtering
    if ($role === 'staff') {
        $sql .= "(t.assigned_to = ? OR EXISTS (
                    SELECT 1 FROM task_collaborators tc 
                    WHERE tc.task_id = t.id AND tc.user_id = ?
                ))";
        $params = [$userId, $userId];
        $types = 'ii';
    } elseif ($role === 'manager') {
        $sql .= "(p.manager_id = ? OR t.created_by = ?)";
        $params = [$userId, $userId];
        $types = 'ii';
    } else {
        // Admin sees all
        $sql .= "1=1";
        $params = [];
        $types = '';
    }
    
    // Status filtering
    if ($status) {
        $sql .= " AND t.workflow_status = ?";
        $params[] = $status;
        $types .= 's';
    }
    
    $sql .= " ORDER BY 
                CASE 
                    WHEN t.workflow_status = 'rejected_by_manager' THEN 1
                    WHEN t.workflow_status = 'rejected_by_admin' THEN 2
                    WHEN t.workflow_status = 'in_progress' THEN 3
                    WHEN t.workflow_status = 'pending_manager' THEN 4
                    WHEN t.workflow_status = 'pending_admin' THEN 5
                    WHEN t.workflow_status = 'not_started' THEN 6
                    ELSE 7
                END,
                t.due_date ASC,
                t.created_at DESC";
    
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Database error.', 500);
    }
    
    if (!empty($params)) {
        $stmt->bind_param($types, ...$params);
    }
    
    $stmt->execute();
    $result = $stmt->get_result();
    $tasks = [];
    
    while ($row = $result->fetch_assoc()) {
        $tasks[] = $row;
    }
    
    $stmt->close();
    sendSuccess(['tasks' => $tasks]);
}

/**
 * Get tasks pending review (for managers and admins)
 */
function handleGetPendingReviews($conn) {
    $userId = $_SESSION['user_id'];
    $role = $_SESSION['role'];
    
    if ($role === 'staff') {
        sendError('Staff cannot access pending reviews', 403);
    }
    
    $tasks = [];
    
    if ($role === 'manager' || $role === 'admin') {
        // Pending manager review
        $sql = "SELECT * FROM v_tasks_pending_manager_review WHERE 1=1";
        
        if ($role === 'manager') {
            $sql .= " AND manager_id = ?";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $userId);
        } else {
            $stmt = $conn->prepare($sql);
        }
        
        $stmt->execute();
        $result = $stmt->get_result();
        
        while ($row = $result->fetch_assoc()) {
            $row['review_level'] = 'manager';
            $tasks[] = $row;
        }
        $stmt->close();
    }
    
    if ($role === 'admin') {
        // Pending admin review
        $sql = "SELECT * FROM v_tasks_pending_admin_review";
        $stmt = $conn->prepare($sql);
        $stmt->execute();
        $result = $stmt->get_result();
        
        while ($row = $result->fetch_assoc()) {
            $row['review_level'] = 'admin';
            $tasks[] = $row;
        }
        $stmt->close();
    }
    
    sendSuccess(['tasks' => $tasks]);
}

/**
 * Get detailed task information including all submissions and history
 */
function handleGetTaskDetails($conn) {
    $taskId = $_GET['task_id'] ?? null;
    
    if (!$taskId) {
        sendError('Task ID is required', 400);
    }
    
    $userId = $_SESSION['user_id'];
    $role = $_SESSION['role'];
    
    // Get task details
    $sql = "SELECT 
                t.*,
                p.name as project_name,
                p.manager_id,
                c.client_name,
                CONCAT(staff.first_name, ' ', staff.last_name) as assigned_to_name,
                CONCAT(mgr_rev.first_name, ' ', mgr_rev.last_name) as manager_reviewed_by_name,
                CONCAT(admin_rev.first_name, ' ', admin_rev.last_name) as admin_reviewed_by_name
            FROM tasks t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN client c ON p.client_id = c.client_id
            LEFT JOIN users staff ON t.assigned_to = staff.id
            LEFT JOIN users mgr_rev ON t.manager_reviewed_by = mgr_rev.id
            LEFT JOIN users admin_rev ON t.admin_reviewed_by = admin_rev.id
            WHERE t.id = ?";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) {
        sendError('Task not found', 404);
    }
    
    // Permission check
    $hasAccess = false;
    if ($role === 'admin') {
        $hasAccess = true;
    } elseif ($role === 'manager' && $task['manager_id'] == $userId) {
        $hasAccess = true;
    } elseif ($role === 'staff' && $task['assigned_to'] == $userId) {
        $hasAccess = true;
    } elseif ($role === 'staff') {
        // Check if collaborator
        $stmt = $conn->prepare("SELECT 1 FROM task_collaborators WHERE task_id = ? AND user_id = ?");
        $stmt->bind_param('ii', $taskId, $userId);
        $stmt->execute();
        $hasAccess = $stmt->get_result()->num_rows > 0;
        $stmt->close();
    }
    
    if (!$hasAccess) {
        sendError('Access denied', 403);
    }
    
    // Get submissions
    $sql = "SELECT 
                s.*,
                CONCAT(u.first_name, ' ', u.last_name) as submitted_by_name,
                CONCAT(r.first_name, ' ', r.last_name) as reviewed_by_name
            FROM task_submissions s
            LEFT JOIN users u ON s.submitted_by = u.id
            LEFT JOIN users r ON s.reviewed_by = r.id
            WHERE s.task_id = ?
            ORDER BY s.submitted_at DESC";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $submissions = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    
    // Get rejection reasons
    $sql = "SELECT 
                r.*,
                CONCAT(u.first_name, ' ', u.last_name) as rejected_by_name
            FROM task_rejection_reasons r
            LEFT JOIN users u ON r.rejected_by = u.id
            WHERE r.task_id = ?
            ORDER BY r.rejected_at DESC";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $rejections = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    
    sendSuccess([
        'task' => $task,
        'submissions' => $submissions,
        'rejections' => $rejections
    ]);
}

/**
 * Get approval history for a task
 */
function handleGetApprovalHistory($conn) {
    $taskId = $_GET['task_id'] ?? null;
    
    if (!$taskId) {
        sendError('Task ID is required', 400);
    }
    
    $sql = "SELECT 
                h.*,
                CONCAT(u.first_name, ' ', u.last_name) as performed_by_name,
                u.role as performed_by_role,
                s.file_name as submission_file_name
            FROM task_approval_history h
            LEFT JOIN users u ON h.performed_by = u.id
            LEFT JOIN task_submissions s ON h.submission_id = s.submission_id
            WHERE h.task_id = ?
            ORDER BY h.created_at DESC";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $history = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    
    sendSuccess(['history' => $history]);
}

/**
 * Get rejection reasons for a task
 */
function handleGetRejectionReasons($conn) {
    $taskId = $_GET['task_id'] ?? null;
    
    if (!$taskId) {
        sendError('Task ID is required', 400);
    }
    
    $sql = "SELECT * FROM v_staff_rejected_tasks WHERE id = ? ORDER BY rejected_at DESC";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $rejections = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $stmt->close();
    
    sendSuccess(['rejections' => $rejections]);
}

/**
 * Staff starts a task
 */
function handleStartTask($conn) {
    requireMinRole('staff');
    
    $data = getRequestData();
    $taskId = intval($data['task_id'] ?? 0);
    $userId = intval($_SESSION['user_id'] ?? 0);
    
    if (!$taskId) {
        sendError('Task ID is required', 400);
    }
    
    $stmt = $conn->prepare("SELECT id, workflow_status, assigned_to FROM tasks WHERE id = ?");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) {
        sendError('Task not found', 404);
    }
    
    if (!taskWorkflowUserHasStaffAccess($conn, $taskId, $userId)) {
        sendError('You can only start tasks assigned or shared with you', 403);
    }
    
    if ($task['workflow_status'] !== 'not_started') {
        sendError('Task has already been started', 400);
    }
    
    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start task transaction.', 500);
    }

    $stmt = $conn->prepare("UPDATE tasks SET workflow_status = 'in_progress', status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = ? AND workflow_status = 'not_started'");
    if (!$stmt) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to prepare task start.', 500);
    }
    $stmt->bind_param('i', $taskId);
    if (!$stmt->execute()) {
        $stmt->close();
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to start task.', 500);
    }
    $affected = $stmt->affected_rows;
    $stmt->close();

    if ($affected < 1) {
        $conn->rollback();
        sendError('Task has already been started', 409);
    }

    $stmt = $conn->prepare("INSERT INTO task_approval_history (task_id, action, performed_by, previous_status, new_status, comments) VALUES (?, 'task_started', ?, 'not_started', 'in_progress', 'Task started by staff')");
    if ($stmt) {
        $stmt->bind_param('ii', $taskId, $userId);
        $stmt->execute();
        $stmt->close();
    }

    if (!$conn->commit()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to finalize task start.', 500);
    }

    sendSuccess(['message' => 'Task started successfully']);
}

/**
 * Staff submits document for review
 */
function handleSubmitDocument($conn) {
    requireMinRole('staff');
    
    $taskId = intval($_POST['task_id'] ?? 0);
    $notes = $_POST['notes'] ?? '';
    $userId = intval($_SESSION['user_id'] ?? 0);
    
    if (!$taskId) {
        sendError('Task ID is required', 400);
    }
    
    // Verify task is assigned to this user
    $stmt = $conn->prepare("SELECT id, workflow_status, assigned_to FROM tasks WHERE id = ?");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) {
        sendError('Task not found', 404);
    }
    
    if (!taskWorkflowUserHasStaffAccess($conn, $taskId, $userId)) {
        sendError('You can only submit documents for tasks assigned or shared with you', 403);
    }
    
    if (!in_array($task['workflow_status'], ['in_progress', 'rejected_by_manager', 'rejected_by_admin'])) {
        sendError('Task cannot accept submissions in current status', 400);
    }
    
    // Handle file upload
    if (!isset($_FILES['document']) || $_FILES['document']['error'] !== UPLOAD_ERR_OK) {
        sendError('Document file is required', 400);
    }

    $file = $_FILES['document'];

    // Verify this is a genuine PHP upload (not a path-injection attack).
    if (!is_uploaded_file((string)($file['tmp_name'] ?? ''))) {
        sendError('Invalid file upload.', 400);
    }

    $uploadDir = __DIR__ . '/../uploads/task_submissions/';

    // Create directory if it doesn't exist
    if (!is_dir($uploadDir)) {
        mkdir($uploadDir, 0755, true);
    }

    // Validate file size before touching the filesystem (max 10MB).
    if ((int)($file['size'] ?? 0) > 10 * 1024 * 1024) {
        sendError('File size exceeds 10MB limit', 400);
    }

    // Validate extension against the allowlist.
    $fileExtension = strtolower(pathinfo((string)($file['name'] ?? ''), PATHINFO_EXTENSION));
    $fileName = basename((string)($file['name'] ?? 'document'));
    $allowedTypes = ['pdf'];
    if ($fileExtension === '' || !in_array($fileExtension, $allowedTypes, true)) {
        sendError('Invalid file type. Only PDF files are allowed.', 400);
    }

    // Generate unique filename and move the upload.
    $uniqueFileName = $taskId . '_' . time() . '_' . bin2hex(random_bytes(6)) . '.' . $fileExtension;
    $filePath = $uploadDir . $uniqueFileName;

    if (!move_uploaded_file((string)$file['tmp_name'], $filePath)) {
        sendError('Failed to upload file', 500);
    }

    // Verify actual MIME type from file contents (not the client-supplied type header).
    $finfo    = new finfo(FILEINFO_MIME_TYPE);
    $mimeType = $finfo->file($filePath);
    if ($mimeType !== 'application/pdf') {
        unlink($filePath);
        sendError('Only PDF files are allowed.', 400);
    }

    // Get file info after the move.
    $fileSize = filesize($filePath);
    $relativeFilePath = 'uploads/task_submissions/' . $uniqueFileName;

    if (!$conn->begin_transaction()) {
        unlink($filePath);
        error_log($conn->error);
        sendError('Failed to start document submission transaction.', 500);
    }

    $submissionType = getLatestTaskSubmission($conn, $taskId) ? 'resubmission' : 'initial';
    $previousStatus = (string)$task['workflow_status'];

    $stmt = $conn->prepare("INSERT INTO task_submissions (task_id, submitted_by, file_path, file_name, file_size, mime_type, notes, submission_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    if (!$stmt) {
        $conn->rollback();
        unlink($filePath);
        error_log($conn->error);
        sendError('Failed to prepare document submission.', 500);
    }
    $stmt->bind_param('iississs', $taskId, $userId, $relativeFilePath, $fileName, $fileSize, $mimeType, $notes, $submissionType);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $stmt->close();
        $conn->rollback();
        unlink($filePath);
        sendError('Failed to submit document: ' . $error, 500);
    }
    $submissionId = intval($conn->insert_id);
    $stmt->close();

    $stmt = $conn->prepare("UPDATE tasks
        SET workflow_status = 'pending_manager',
            status = 'in_progress',
            submitted_at = NOW(),
            manager_reviewed_at = NULL,
            manager_reviewed_by = NULL,
            admin_reviewed_at = NULL,
            admin_reviewed_by = NULL
        WHERE id = ? AND workflow_status IN ('in_progress', 'rejected_by_manager', 'rejected_by_admin')");
    if (!$stmt) {
        $conn->rollback();
        unlink($filePath);
        error_log($conn->error);
        sendError('Failed to prepare task workflow update.', 500);
    }
    $stmt->bind_param('i', $taskId);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $stmt->close();
        $conn->rollback();
        unlink($filePath);
        sendError('Failed to update task workflow: ' . $error, 500);
    }
    $affected = $stmt->affected_rows;
    $stmt->close();

    // Guard against a race condition where the task's workflow_status changed
    // between the earlier SELECT and this UPDATE (e.g. manager review happened).
    if ($affected < 1) {
        $conn->rollback();
        unlink($filePath);
        sendError('Task status changed concurrently. Please refresh and try again.', 409);
    }

    $action = $submissionType === 'resubmission' ? 'resubmitted' : 'document_submitted';
    $historyComment = trim($notes) !== '' ? $notes : ('Document submitted: ' . $fileName);
    $stmt = $conn->prepare("INSERT INTO task_approval_history (task_id, submission_id, action, performed_by, previous_status, new_status, comments) VALUES (?, ?, ?, ?, ?, 'pending_manager', ?)");
    if ($stmt) {
        $stmt->bind_param('iisiss', $taskId, $submissionId, $action, $userId, $previousStatus, $historyComment);
        $stmt->execute();
        $stmt->close();
    }

    if (!$conn->commit()) {
        $conn->rollback();
        unlink($filePath);
        error_log($conn->error);
        sendError('Failed to finalize document submission.', 500);
    }

    // Reflect in the central Document Management library (best-effort).
    if (function_exists('registerManagedDocument')) {
        registerManagedDocument($conn, [
            'title' => $fileName,
            'document_type' => 'Report',
            'task_id' => $taskId,
            'source' => 'task_submission',
            'source_table' => 'task_submissions',
            'source_id' => $submissionId,
            'file_path' => $relativeFilePath,
            'file_name' => $fileName,
            'mime_type' => $mimeType,
            'file_size' => $fileSize,
            'notes' => $notes,
            'uploaded_by' => $userId,
        ]);
    }

    sendSuccess([
        'message' => 'Document submitted successfully',
        'submission_id' => $submissionId
    ]);
}

/**
 * Manager reviews task
 */
function handleManagerReview($conn) {
    requireRole(['manager', 'admin']);
    
    $data = getRequestData();
    $taskId = intval($data['task_id'] ?? 0);
    $approved = $data['approved'] ?? null;
    $reviewNotes = $data['review_notes'] ?? '';
    $userId = intval($_SESSION['user_id'] ?? 0);
    $role = $_SESSION['role'];
    
    if (!$taskId || $approved === null) {
        sendError('Task ID and approval status are required', 400);
    }
    $approvedBool = filter_var($approved, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    if ($approvedBool === null) {
        $approvedBool = !empty($approved);
    }
    $reviewNotes = trim((string)$reviewNotes);
    if (!$approvedBool && $reviewNotes === '') {
        sendError('Rejection reason is required', 400);
    }
    
    // Verify task status
    $stmt = $conn->prepare("SELECT t.id, t.workflow_status, p.manager_id 
                            FROM tasks t 
                            LEFT JOIN projects p ON t.project_id = p.id 
                            WHERE t.id = ?");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) {
        sendError('Task not found', 404);
    }
    
    if ($task['workflow_status'] !== 'pending_manager') {
        sendError('Task is not pending manager review', 400);
    }
    
    // Only project manager or admin can review
    if ($role === 'manager' && $task['manager_id'] != $userId) {
        sendError('You are not the manager of this project', 403);
    }

    $submission = getLatestTaskSubmission($conn, $taskId, ['pending']);
    if (!$submission) {
        sendError('No pending document submission found for this task', 409);
    }
    $submissionId = intval($submission['submission_id']);

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start manager review transaction.', 500);
    }

    if ($approvedBool) {
        $stmt = $conn->prepare("UPDATE tasks SET workflow_status = 'pending_admin', manager_reviewed_at = NOW(), manager_reviewed_by = ? WHERE id = ? AND workflow_status = 'pending_manager'");
        $action = 'manager_approved';
        $newStatus = 'pending_admin';
    } else {
        $stmt = $conn->prepare("UPDATE tasks SET workflow_status = 'rejected_by_manager', status = 'in_progress', manager_reviewed_at = NOW(), manager_reviewed_by = ? WHERE id = ? AND workflow_status = 'pending_manager'");
        $action = 'manager_rejected';
        $newStatus = 'rejected_by_manager';
    }
    if (!$stmt) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to prepare manager review.', 500);
    }
    $stmt->bind_param('ii', $userId, $taskId);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $stmt->close();
        $conn->rollback();
        sendError('Failed to review task: ' . $error, 500);
    }
    $affected = $stmt->affected_rows;
    $stmt->close();
    if ($affected < 1) {
        $conn->rollback();
        sendError('Task is no longer pending manager review', 409);
    }

    $submissionStatus = $approvedBool ? 'approved' : 'rejected';
    $stmt = $conn->prepare("UPDATE task_submissions SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ? WHERE submission_id = ?");
    if (!$stmt) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to prepare submission review.', 500);
    }
    $stmt->bind_param('sisi', $submissionStatus, $userId, $reviewNotes, $submissionId);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $stmt->close();
        $conn->rollback();
        sendError('Failed to update submission review: ' . $error, 500);
    }
    $stmt->close();

    if (!$approvedBool) {
        $stmt = $conn->prepare("INSERT INTO task_rejection_reasons (task_id, submission_id, rejected_by, rejected_by_role, reason, expected_corrections) VALUES (?, ?, ?, 'manager', ?, ?)");
        if ($stmt) {
            $stmt->bind_param('iiiss', $taskId, $submissionId, $userId, $reviewNotes, $reviewNotes);
            $stmt->execute();
            $stmt->close();
        }
    }

    $stmt = $conn->prepare("INSERT INTO task_approval_history (task_id, submission_id, action, performed_by, previous_status, new_status, comments) VALUES (?, ?, ?, ?, 'pending_manager', ?, ?)");
    if ($stmt) {
        $stmt->bind_param('iisiss', $taskId, $submissionId, $action, $userId, $newStatus, $reviewNotes);
        $stmt->execute();
        $stmt->close();
    }

    if (!$conn->commit()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to finalize manager review.', 500);
    }

    sendSuccess([
        'message' => $approvedBool ? 'Task approved and sent to admin' : 'Task rejected and returned to staff'
    ]);
}

/**
 * Admin reviews task
 */
function handleAdminReview($conn) {
    requireRole(['admin']);
    
    $data = getRequestData();
    $taskId = intval($data['task_id'] ?? 0);
    $approved = $data['approved'] ?? null;
    $reviewNotes = $data['review_notes'] ?? '';
    $userId = intval($_SESSION['user_id'] ?? 0);
    
    if (!$taskId || $approved === null) {
        sendError('Task ID and approval status are required', 400);
    }
    $approvedBool = filter_var($approved, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    if ($approvedBool === null) {
        $approvedBool = !empty($approved);
    }
    $reviewNotes = trim((string)$reviewNotes);
    if (!$approvedBool && $reviewNotes === '') {
        sendError('Rejection reason is required', 400);
    }
    
    // Verify task status
    $stmt = $conn->prepare("SELECT id, workflow_status FROM tasks WHERE id = ?");
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    
    if (!$task) {
        sendError('Task not found', 404);
    }
    
    if ($task['workflow_status'] !== 'pending_admin') {
        sendError('Task is not pending admin review', 400);
    }

    $submission = getLatestTaskSubmission($conn, $taskId, ['approved']);
    if (!$submission) {
        $submission = getLatestTaskSubmission($conn, $taskId);
    }
    if (!$submission) {
        sendError('No document submission found for this task', 409);
    }
    $submissionId = intval($submission['submission_id']);

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start admin review transaction.', 500);
    }

    if ($approvedBool) {
        $stmt = $conn->prepare("UPDATE tasks SET workflow_status = 'completed', status = 'completed', admin_reviewed_at = NOW(), admin_reviewed_by = ?, completed_at = NOW() WHERE id = ? AND workflow_status = 'pending_admin'");
        $action = 'admin_approved';
        $newStatus = 'completed';
    } else {
        $stmt = $conn->prepare("UPDATE tasks SET workflow_status = 'rejected_by_admin', status = 'in_progress', admin_reviewed_at = NOW(), admin_reviewed_by = ? WHERE id = ? AND workflow_status = 'pending_admin'");
        $action = 'admin_rejected';
        $newStatus = 'rejected_by_admin';
    }
    if (!$stmt) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to prepare admin review.', 500);
    }
    $stmt->bind_param('ii', $userId, $taskId);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $stmt->close();
        $conn->rollback();
        sendError('Failed to review task: ' . $error, 500);
    }
    $affected = $stmt->affected_rows;
    $stmt->close();
    if ($affected < 1) {
        $conn->rollback();
        sendError('Task is no longer pending admin review', 409);
    }

    if (!$approvedBool) {
        $stmt = $conn->prepare("UPDATE task_submissions SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_notes = ? WHERE submission_id = ?");
        if (!$stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to prepare admin submission rejection.', 500);
        }
        $stmt->bind_param('isi', $userId, $reviewNotes, $submissionId);
        if (!$stmt->execute()) {
            $error = $stmt->error;
            $stmt->close();
            $conn->rollback();
            sendError('Failed to update admin submission rejection: ' . $error, 500);
        }
        $stmt->close();

        $stmt = $conn->prepare("INSERT INTO task_rejection_reasons (task_id, submission_id, rejected_by, rejected_by_role, reason, expected_corrections) VALUES (?, ?, ?, 'admin', ?, ?)");
        if ($stmt) {
            $stmt->bind_param('iiiss', $taskId, $submissionId, $userId, $reviewNotes, $reviewNotes);
            $stmt->execute();
            $stmt->close();
        }
    }

    $stmt = $conn->prepare("INSERT INTO task_approval_history (task_id, submission_id, action, performed_by, previous_status, new_status, comments) VALUES (?, ?, ?, ?, 'pending_admin', ?, ?)");
    if ($stmt) {
        $stmt->bind_param('iisiss', $taskId, $submissionId, $action, $userId, $newStatus, $reviewNotes);
        $stmt->execute();
        $stmt->close();
    }

    if (!$conn->commit()) {
        $conn->rollback();
        error_log($conn->error);
        sendError('Failed to finalize admin review.', 500);
    }

    sendSuccess([
        'message' => $approvedBool ? 'Task approved and completed' : 'Task rejected and returned to staff for correction'
    ]);
}

/**
 * Download submission file
 */
function handleDownloadSubmission($conn) {
    $submissionId = intval($_POST['submission_id'] ?? 0);

    if (!$submissionId) {
        sendError('Submission ID is required', 400);
    }

    $userId = intval($_SESSION['user_id'] ?? 0);
    $role   = strtolower((string)($_SESSION['role'] ?? ''));

    // Get submission details
    $sql = "SELECT s.*, t.assigned_to, p.manager_id
            FROM task_submissions s
            LEFT JOIN tasks t ON s.task_id = t.id
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE s.submission_id = ?";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $submissionId);
    $stmt->execute();
    $submission = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$submission) {
        sendError('Submission not found', 404);
    }

    // Permission check — staff collaborators also get access (mirrors handleViewSubmission).
    $hasAccess = false;
    if ($role === 'admin') {
        $hasAccess = true;
    } elseif ($role === 'manager' && intval($submission['manager_id'] ?? 0) === $userId) {
        $hasAccess = true;
    } elseif ($role === 'staff' && taskWorkflowUserHasStaffAccess($conn, intval($submission['task_id']), $userId)) {
        $hasAccess = true;
    }

    if (!$hasAccess) {
        sendError('Access denied', 403);
    }

    // Confine the resolved path to the uploads/task_submissions directory
    // to prevent path-traversal via a manipulated file_path DB value.
    $relativePath = ltrim(str_replace(['\\', "\0"], ['/', ''], (string)($submission['file_path'] ?? '')), '/');
    $basePath = realpath(__DIR__ . '/../uploads/task_submissions');
    $filePath = realpath(__DIR__ . '/../' . $relativePath);

    if (!$basePath || !$filePath || strpos($filePath, $basePath . DIRECTORY_SEPARATOR) !== 0 || !is_file($filePath)) {
        sendError('File not found', 404);
    }

    // Return file info for download
    sendSuccess([
        'file_path' => $submission['file_path'],
        'file_name' => $submission['file_name'],
        'file_size' => $submission['file_size'],
        'mime_type' => $submission['mime_type']
    ]);
}

/**
 * Stream a submission for an in-browser preview.
 * Unlike the download action, this endpoint deliberately sends an inline
 * content disposition so clicking View never starts a download by itself.
 */
function handleViewSubmission($conn) {
    $submissionId = intval($_GET['submission_id'] ?? 0);
    if (!$submissionId) {
        sendError('Submission ID is required', 400);
    }

    $userId = intval($_SESSION['user_id'] ?? 0);
    $role = strtolower((string)($_SESSION['role'] ?? ''));
    $sql = "SELECT s.*, t.assigned_to, p.manager_id
            FROM task_submissions s
            LEFT JOIN tasks t ON s.task_id = t.id
            LEFT JOIN projects p ON t.project_id = p.id
            WHERE s.submission_id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to prepare submission preview.', 500);
    }
    $stmt->bind_param('i', $submissionId);
    $stmt->execute();
    $submission = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$submission) {
        sendError('Submission not found', 404);
    }

    $hasAccess = $role === 'admin'
        || ($role === 'manager' && intval($submission['manager_id'] ?? 0) === $userId)
        || ($role === 'staff' && taskWorkflowUserHasStaffAccess($conn, intval($submission['task_id']), $userId));
    if (!$hasAccess) {
        sendError('Access denied', 403);
    }

    $relativePath = ltrim(str_replace(['\\', "\0"], ['/', ''], (string)$submission['file_path']), '/');
    $basePath = realpath(__DIR__ . '/../uploads/task_submissions');
    $filePath = realpath(__DIR__ . '/../' . $relativePath);
    if (!$basePath || !$filePath || strpos($filePath, $basePath . DIRECTORY_SEPARATOR) !== 0 || !is_file($filePath)) {
        sendError('File not found', 404);
    }

    $mimeType = trim((string)($submission['mime_type'] ?? ''));
    if ($mimeType === '' || $mimeType === 'application/octet-stream') {
        $detectedMime = function_exists('mime_content_type') ? mime_content_type($filePath) : false;
        $mimeType = $detectedMime ?: 'application/octet-stream';
    }
    $safeName = str_replace(["\r", "\n", '"'], ['', '', "'"], (string)$submission['file_name']);

    header('Content-Type: ' . $mimeType);
    header('Content-Disposition: inline; filename="' . $safeName . '"');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . filesize($filePath));
    readfile($filePath);
    exit();
}

/**
 * Board Move — Kanban drag-and-drop status update.
 * Managers and admins can freely move any task between workflow columns.
 * Staff can only start their own tasks (not_started → in_progress).
 */
function handleBoardMove($conn) {
    $data   = getRequestData();
    $taskId = intval($data['task_id'] ?? 0);
    $userId = intval($_SESSION['user_id'] ?? 0);
    $role   = strtolower(trim((string)($_SESSION['role'] ?? '')));

    if (!$taskId) sendError('task_id is required', 400);

    $allowedWorkflowStatuses = ['not_started', 'in_progress', 'pending_manager', 'pending_admin', 'completed'];
    $allowedStatuses         = ['pending', 'in_progress', 'completed'];

    $newWorkflow = strtolower(trim((string)($data['workflow_status'] ?? '')));
    $newStatus   = strtolower(trim((string)($data['status']          ?? '')));

    if (!in_array($newWorkflow, $allowedWorkflowStatuses, true)) {
        sendError('Invalid workflow_status for board move.', 400);
    }
    if (!in_array($newStatus, $allowedStatuses, true)) {
        sendError('Invalid status for board move.', 400);
    }

    // Fetch current task state
    $stmt = $conn->prepare("SELECT id, workflow_status, status, assigned_to FROM tasks WHERE id = ? LIMIT 1");
    if (!$stmt) { error_log($conn->error); sendError('Failed to validate task.', 500); }
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $task = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$task) sendError('Task not found', 404);

    $currentWf = strtolower((string)($task['workflow_status'] ?? 'not_started'));

    // Staff: can only move their own tasks from not_started → in_progress
    if ($role === 'staff') {
        $staffAccess = taskWorkflowUserHasStaffAccess($conn, $taskId, $userId);
        if (!$staffAccess) {
            sendError('You can only move tasks assigned or shared with you.', 403);
        }
        if (!($currentWf === 'not_started' && $newWorkflow === 'in_progress')) {
            sendError('Staff can only start tasks (move from Backlog to In Progress).', 403);
        }
    } elseif (!in_array($role, ['manager', 'admin'], true)) {
        sendError('Insufficient permissions for board move.', 403);
    }

    // Compute additional timestamp columns
    $extraSql = '';
    $extraParams = [];
    $extraTypes  = '';

    if ($newWorkflow === 'in_progress' && $currentWf === 'not_started') {
        // Mark started_at on first transition to in_progress
        $extraSql    = ', started_at = COALESCE(started_at, NOW())';
    }
    if ($newWorkflow === 'completed') {
        $extraSql   .= ', completed_at = COALESCE(completed_at, NOW())';
    }

    $stmt = $conn->prepare(
        "UPDATE tasks SET workflow_status = ?, status = ?$extraSql WHERE id = ?"
    );
    if (!$stmt) { error_log($conn->error); sendError('Failed to prepare board move.', 500); }

    $types  = 'ss' . $extraTypes . 'i';
    $params = [$newWorkflow, $newStatus];
    foreach ($extraParams as $p) $params[] = $p;
    $params[] = $taskId;

    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to move task on board.', 500);
    }
    $stmt->close();

    sendSuccess(['task_id' => $taskId, 'workflow_status' => $newWorkflow, 'status' => $newStatus], 'Task moved successfully');
}

?>
