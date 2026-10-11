<?php
/**
 * Documents API
 * Handling document receiving and submission tracking
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

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

// Ensure tables exist
$conn->query("CREATE TABLE IF NOT EXISTS document_received (
    document_id INT AUTO_INCREMENT PRIMARY KEY,
    document_name VARCHAR(255) NOT NULL,
    received_date DATE NOT NULL,
    document_type VARCHAR(100),
    status ENUM('received', 'processing', 'completed', 'archived') DEFAULT 'received',
    client_id INT,
    employee_id INT,
    file_path VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES client(client_id) ON DELETE SET NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

$conn->query("CREATE TABLE IF NOT EXISTS document_submission (
    submission_id INT AUTO_INCREMENT PRIMARY KEY,
    document_id INT NOT NULL,
    submission_date DATE NOT NULL,
    submitted_by INT,
    status ENUM('pending', 'submitted', 'accepted', 'rejected') DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES document_received(document_id) ON DELETE CASCADE,
    FOREIGN KEY (submitted_by) REFERENCES employees(employee_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

// Add task_id columns if they don't exist
try {
    $conn->query("ALTER TABLE document_received ADD COLUMN IF NOT EXISTS task_id INT NULL");
    $conn->query("ALTER TABLE document_received ADD INDEX (task_id)");
    
    $conn->query("ALTER TABLE document_submission ADD COLUMN IF NOT EXISTS task_id INT NULL");
    $conn->query("ALTER TABLE document_submission ADD INDEX (task_id)");
} catch (Exception $e) {
    // Ignore if already exists or fails (shouldn't fail if DB user has rights)
}

requireFeatureAccess('documents', ['admin', 'manager', 'staff'], $conn);
ensureTaskCollaboratorsTable($conn);

$action = $_GET['action'] ?? '';

switch ($method) {
    case 'GET':
        if ($action === 'list_received') handleListReceived($conn);
        elseif ($action === 'list_submissions') handleListSubmissions($conn);
        elseif ($action === 'tracking_analytics') handleTrackingAnalytics($conn);
        else sendError('Invalid action', 400);
        break;
    case 'POST':
        if ($action === 'create_received') handleCreateReceived($conn);
        elseif ($action === 'create_submission') handleCreateSubmission($conn);
        elseif ($action === 'delete_received') { requireRole(['admin']); handleDeleteReceived($conn); }
        elseif ($action === 'delete_submission') { requireRole(['admin']); handleDeleteSubmission($conn); }
        else sendError('Invalid action', 400);
        break;
    case 'PUT':
        if ($action === 'update_received') handleUpdateReceived($conn);
        elseif ($action === 'update_submission') handleUpdateSubmission($conn);
        else sendError('Invalid action', 400);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getCurrentDocumentsRole() {
    return strtolower((string)($_SESSION['role'] ?? ''));
}

function getCurrentDocumentsEmployeeId($conn) {
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

function requireDocumentsEmployeeId($conn) {
    $employeeId = getCurrentDocumentsEmployeeId($conn);
    if ($employeeId <= 0) {
        sendError('Your account is not linked to an employee record.', 403);
    }
    return $employeeId;
}

function canStaffAccessTask($conn, $taskId, $userId) {
    $stmt = $conn->prepare(
        "SELECT id
         FROM tasks t
         WHERE t.id = ?
           AND (
                t.assigned_to = ?
                OR EXISTS (
                    SELECT 1
                    FROM task_collaborators tc
                    WHERE tc.task_id = t.id
                      AND tc.user_id = ?
                )
           )
         LIMIT 1"
    );
    if (!$stmt) {
        sendError('Failed to validate linked task', 500);
    }
    $stmt->bind_param('iii', $taskId, $userId, $userId);
    $stmt->execute();
    $allowed = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $allowed;
}

function handleListReceived($conn) {
    $client_id = $_GET['client_id'] ?? null;
    $status = $_GET['status'] ?? null;
    $search = $_GET['search'] ?? null;
    $role = getCurrentDocumentsRole();
    $selfEmployeeId = ($role === 'staff') ? requireDocumentsEmployeeId($conn) : 0;

    $sql = "SELECT d.*, 
            c.client_name, 
            CONCAT(e.first_name, ' ', e.last_name) as receiver_name,
            t.title as task_title
            FROM document_received d
            LEFT JOIN client c ON d.client_id = c.client_id
            LEFT JOIN employees e ON d.employee_id = e.employee_id
            LEFT JOIN tasks t ON d.task_id = t.id
            WHERE 1=1";
    
    $params = [];
    $types = '';

    if ($client_id) {
        $sql .= " AND d.client_id = ?";
        $params[] = $client_id;
        $types .= 'i';
    }
    if ($status) {
        $sql .= " AND d.status = ?";
        $params[] = $status;
        $types .= 's';
    }
    if ($search) {
        $sql .= " AND (d.document_name LIKE ? OR c.client_name LIKE ?)";
        $term = "%$search%";
        $params[] = $term;
        $params[] = $term;
        $types .= 'ss';
    }
    if ($role === 'staff') {
        $sql .= " AND d.employee_id = ?";
        $params[] = $selfEmployeeId;
        $types .= 'i';
    }

    $sql .= " ORDER BY d.received_date DESC, d.created_at DESC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    $data = [];
    while ($row = $result->fetch_assoc()) {
        $data[] = $row;
    }
    sendResponse(true, $data);
}

function handleCreateReceived($conn) {
    $data = getJSONInput();
    $required = ['document_name', 'received_date', 'client_id'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) sendError("Missing: " . implode(', ', $missing));

    $role = getCurrentDocumentsRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireDocumentsEmployeeId($conn) : 0;
    $currentUserId = intval($_SESSION['user_id'] ?? 0);

    $name = sanitizeInput($data['document_name']);
    $date = $data['received_date'];
    $client_id = intval($data['client_id']);
    $employee_id = isset($data['employee_id']) ? intval($data['employee_id']) : null;
    $notes = sanitizeInput($data['notes'] ?? '');
    $status = $data['status'] ?? 'received';
    $file_path = sanitizeInput($data['file_path'] ?? '');
    $task_id = isset($data['task_id']) && $data['task_id'] ? intval($data['task_id']) : null;

    if ($isStaff) {
        $employee_id = $selfEmployeeId;
        if ($task_id) {
            if (!canStaffAccessTask($conn, $task_id, $currentUserId)) {
                sendError('You can only link tasks assigned or shared with you.', 403);
            }
        }
    }

    $type = resolveDocumentType($conn, $task_id, $client_id, $data['document_type'] ?? '');

    $sql = "INSERT INTO document_received (document_name, received_date, document_type, client_id, employee_id, notes, status, file_path, task_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('sssiisssi', $name, $date, $type, $client_id, $employee_id, $notes, $status, $file_path, $task_id);

    if ($stmt->execute()) {
        $id = $conn->insert_id;
        logThis('create_document', "Received doc: $name");

        syncLinkedTaskFromDocument($conn, $id, $task_id, $status, $name);

        sendResponse(true, ['id' => $id], 'Document recorded');
    } else {
        error_log($conn->error);
        sendError('Failed to record document.');
    }
}

function handleUpdateReceived($conn) {
    $data = getJSONInput();
    $id = $data['document_id'] ?? null;
    if (!$id) sendError('ID required');
    $role = getCurrentDocumentsRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireDocumentsEmployeeId($conn) : 0;
    $currentUserId = intval($_SESSION['user_id'] ?? 0);

    $ownershipStmt = $conn->prepare("SELECT employee_id FROM document_received WHERE document_id = ? LIMIT 1");
    if (!$ownershipStmt) sendError('Failed to validate document ownership', 500);
    $docId = intval($id);
    $ownershipStmt->bind_param('i', $docId);
    $ownershipStmt->execute();
    $ownershipRow = $ownershipStmt->get_result()->fetch_assoc();
    $ownershipStmt->close();
    if (!$ownershipRow) sendError('Document not found', 404);

    if ($isStaff && intval($ownershipRow['employee_id'] ?? 0) !== $selfEmployeeId) {
        sendError('Forbidden', 403);
    }

    if ($isStaff) {
        $staffAllowed = ['document_id', 'document_name', 'received_date', 'document_type', 'notes', 'status', 'file_path', 'task_id'];
        foreach ($data as $key => $value) {
            if (!in_array($key, $staffAllowed, true)) {
                sendError('Staff cannot update that field.', 403);
            }
        }
        if (isset($data['employee_id']) || isset($data['client_id'])) {
            sendError('Staff cannot change client/employee assignments.', 403);
        }
    }

    if (!empty($data['task_id'])) {
        $task_for_type = intval($data['task_id']);
        $client_for_type = isset($data['client_id']) ? intval($data['client_id']) : null;
        if ($isStaff) {
            if (!canStaffAccessTask($conn, $task_for_type, $currentUserId)) {
                sendError('You can only link tasks assigned or shared with you.', 403);
            }
        }
        $data['document_type'] = resolveDocumentType($conn, $task_for_type, $client_for_type, $data['document_type'] ?? '');
    }

    $updates = [];
    $params = [];
    $types = '';
    $fields = ['document_name', 'received_date', 'document_type', 'client_id', 'employee_id', 'notes', 'status', 'file_path', 'task_id'];

    foreach ($fields as $field) {
        if (isset($data[$field])) {
            $updates[] = "$field = ?";
            if (in_array($field, ['client_id', 'employee_id', 'task_id'])) {
                $params[] = $data[$field] ? intval($data[$field]) : null;
                $types .= 'i';
            } else {
                $params[] = sanitizeInput($data[$field]);
                $types .= 's';
            }
        }
    }

    if (empty($updates)) sendError('No changes');
    
    $params[] = $id;
    $types .= 'i';

    $sql = "UPDATE document_received SET " . implode(', ', $updates) . " WHERE document_id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        logThis('update_document', "Updated doc ID: $id");

        // Keep linked task state in sync when a received document is updated.
        syncLinkedTaskFromDocument(
            $conn,
            intval($id),
            $data['task_id'] ?? null,
            $data['status'] ?? null,
            $data['document_name'] ?? null
        );

        sendResponse(true, null, 'Document updated');
    } else {
        sendError('Update failed');
    }
}

function handleDeleteReceived($conn) {
    $data = getJSONInput();
    $id = $data['document_id'] ?? null;
    if (!$id) sendError('ID required');

    $stmt = $conn->prepare("DELETE FROM document_received WHERE document_id = ?");
    $stmt->bind_param('i', $id);
    if ($stmt->execute()) {
        logThis('delete_document', "Deleted doc ID: $id");
        sendResponse(true, null, 'Document deleted');
    } else {
        sendError('Delete failed');
    }
}

// --- Submissions ---

function handleListSubmissions($conn) {
    $document_id = $_GET['document_id'] ?? null;
    $role = getCurrentDocumentsRole();
    $selfEmployeeId = ($role === 'staff') ? requireDocumentsEmployeeId($conn) : 0;
    
    $sql = "SELECT s.*, 
            d.document_name,
            c.client_name,
            CONCAT(e.first_name, ' ', e.last_name) as submitter_name,
            t.title as task_title
            FROM document_submission s
            JOIN document_received d ON s.document_id = d.document_id
            LEFT JOIN client c ON d.client_id = c.client_id
            LEFT JOIN employees e ON s.submitted_by = e.employee_id
            LEFT JOIN tasks t ON s.task_id = t.id
            WHERE 1=1";
    
    $params = [];
    $types = '';
    
    if ($document_id) {
        $sql .= " AND s.document_id = ?";
        $params[] = $document_id;
        $types .= 'i';
    }
    if ($role === 'staff') {
        $sql .= " AND s.submitted_by = ?";
        $params[] = $selfEmployeeId;
        $types .= 'i';
    }

    $sql .= " ORDER BY s.submission_date DESC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }
    
    $data = [];
    while ($row = $result->fetch_assoc()) {
        $data[] = $row;
    }
    sendResponse(true, $data);
}

function handleTrackingAnalytics($conn) {
    if (getCurrentDocumentsRole() === 'staff') {
        sendError('Forbidden: insufficient permissions', 403);
    }

    $search = $_GET['search'] ?? null;

    $sql = "SELECT c.client_id,
                   c.client_name,
                   COUNT(d.document_id) AS total_documents,
                   SUM(CASE WHEN d.status = 'received' THEN 1 ELSE 0 END) AS received_count,
                   SUM(CASE WHEN d.status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
                   SUM(CASE WHEN d.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                   SUM(CASE WHEN d.status = 'archived' THEN 1 ELSE 0 END) AS archived_count,
                   MAX(d.received_date) AS last_received_date
            FROM client c
            LEFT JOIN document_received d ON d.client_id = c.client_id
            WHERE 1=1";

    $params = [];
    $types = '';

    if ($search) {
        $sql .= " AND c.client_name LIKE ?";
        $params[] = '%' . $search . '%';
        $types .= 's';
    }

    $sql .= " GROUP BY c.client_id, c.client_name
              HAVING COUNT(d.document_id) > 0
              ORDER BY c.client_name ASC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    $data = [];
    while ($row = $result->fetch_assoc()) {
        $row['total_documents'] = (int)($row['total_documents'] ?? 0);
        $row['received_count'] = (int)($row['received_count'] ?? 0);
        $row['processing_count'] = (int)($row['processing_count'] ?? 0);
        $row['completed_count'] = (int)($row['completed_count'] ?? 0);
        $row['archived_count'] = (int)($row['archived_count'] ?? 0);
        $row['completion_rate'] = $row['total_documents'] > 0
            ? round(($row['completed_count'] / $row['total_documents']) * 100, 1)
            : 0.0;
        $data[] = $row;
    }

    sendResponse(true, $data);
}

function handleCreateSubmission($conn) {
    $data = getJSONInput();
    $role = getCurrentDocumentsRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireDocumentsEmployeeId($conn) : 0;
    $currentUserId = intval($_SESSION['user_id'] ?? 0);

    $required = ['document_id', 'submission_date'];
    if (!$isStaff) {
        $required[] = 'submitted_by';
    }
    $missing = validateRequiredFields($data, $required);
    if ($missing) sendError("Missing: " . implode(', ', $missing));

    $doc_id = intval($data['document_id']);
    $date = $data['submission_date'];
    $by = $isStaff ? $selfEmployeeId : intval($data['submitted_by']);
    $notes = sanitizeInput($data['notes'] ?? '');
    $status = $data['status'] ?? 'pending';
    $task_id = isset($data['task_id']) && $data['task_id'] ? intval($data['task_id']) : null;

    if ($isStaff) {
        $docOwnership = $conn->prepare("SELECT employee_id FROM document_received WHERE document_id = ? LIMIT 1");
        if (!$docOwnership) sendError('Failed to validate document ownership', 500);
        $docOwnership->bind_param('i', $doc_id);
        $docOwnership->execute();
        $docRow = $docOwnership->get_result()->fetch_assoc();
        $docOwnership->close();
        if (!$docRow) sendError('Document not found', 404);
        if (intval($docRow['employee_id'] ?? 0) !== $selfEmployeeId) {
            sendError('Forbidden', 403);
        }

        if ($task_id) {
            if (!canStaffAccessTask($conn, $task_id, $currentUserId)) {
                sendError('You can only link tasks assigned or shared with you.', 403);
            }
        }
    }

    $sql = "INSERT INTO document_submission (document_id, submission_date, submitted_by, notes, status, task_id)
            VALUES (?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('isissi', $doc_id, $date, $by, $notes, $status, $task_id);

    if ($stmt->execute()) {
        $id = $conn->insert_id;
        logThis('create_submission', "Submission recorded for Doc ID: $doc_id");
        
        // Auto-complete task
        if ($task_id) {
            completeTask($conn, $task_id, "Auto-completed by submission record");
        }

        sendResponse(true, ['id' => $id], 'Submission recorded');
    } else {
        sendError('Failed to record submission');
    }
}

function handleUpdateSubmission($conn) {
    $data = getJSONInput();
    $id = $data['submission_id'] ?? null;
    if (!$id) sendError('ID required');
    $role = getCurrentDocumentsRole();
    $isStaff = $role === 'staff';
    $selfEmployeeId = $isStaff ? requireDocumentsEmployeeId($conn) : 0;
    $currentUserId = intval($_SESSION['user_id'] ?? 0);

    $submissionId = intval($id);
    $submissionOwnership = $conn->prepare("SELECT submitted_by FROM document_submission WHERE submission_id = ? LIMIT 1");
    if (!$submissionOwnership) sendError('Failed to validate submission ownership', 500);
    $submissionOwnership->bind_param('i', $submissionId);
    $submissionOwnership->execute();
    $submissionRow = $submissionOwnership->get_result()->fetch_assoc();
    $submissionOwnership->close();
    if (!$submissionRow) sendError('Submission not found', 404);

    if ($isStaff && intval($submissionRow['submitted_by'] ?? 0) !== $selfEmployeeId) {
        sendError('Forbidden', 403);
    }

    if ($isStaff && isset($data['submitted_by'])) {
        sendError('Staff cannot reassign submission owner.', 403);
    }

    if ($isStaff && !empty($data['task_id'])) {
        $taskId = intval($data['task_id']);
        if (!canStaffAccessTask($conn, $taskId, $currentUserId)) {
            sendError('You can only link tasks assigned or shared with you.', 403);
        }
    }

    $updates = [];
    $params = [];
    $types = '';
    $fields = $isStaff
        ? ['submission_date', 'notes', 'status', 'task_id']
        : ['submission_date', 'submitted_by', 'notes', 'status', 'task_id'];

    foreach ($fields as $field) {
        if (isset($data[$field])) {
            $updates[] = "$field = ?";
            if (in_array($field, ['submitted_by', 'task_id'])) {
                $params[] = $data[$field] ? intval($data[$field]) : null;
                $types .= 'i';
            } else {
                $params[] = sanitizeInput($data[$field]);
                $types .= 's';
            }
        }
    }

    if (empty($updates)) sendError('No changes');
    
    $params[] = $id;
    $types .= 'i';

    $sql = "UPDATE document_submission SET " . implode(', ', $updates) . " WHERE submission_id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        logThis('update_submission', "Updated submission ID: $id");
        sendResponse(true, null, 'Submission updated');
    } else {
        sendError('Update failed');
    }
}

function handleDeleteSubmission($conn) {
    $data = getJSONInput();
    $id = $data['submission_id'] ?? null;
    if (!$id) sendError('ID required');

    $stmt = $conn->prepare("DELETE FROM document_submission WHERE submission_id = ?");
    $stmt->bind_param('i', $id);
    if ($stmt->execute()) {
        logThis('delete_submission', "Deleted submission ID: $id");
        sendResponse(true, null, 'Submission deleted');
    } else {
        sendError('Delete failed');
    }
}

function shouldMarkTaskDoneFromDocumentStatus($status) {
    $normalized = strtolower(trim((string)$status));
    return in_array($normalized, ['received', 'completed'], true);
}

function syncLinkedTaskFromDocument($conn, $document_id, $task_id = null, $status = null, $document_name = null) {
    $resolved_task_id = $task_id ? intval($task_id) : null;
    $resolved_status = $status;
    $resolved_name = $document_name;

    if (!$resolved_task_id || $resolved_status === null || $resolved_name === null || $resolved_name === '') {
        $stmt = $conn->prepare("SELECT task_id, status, document_name FROM document_received WHERE document_id = ?");
        if ($stmt) {
            $doc_id = intval($document_id);
            $stmt->bind_param('i', $doc_id);
            $stmt->execute();
            $result = $stmt->get_result();
            if ($row = $result->fetch_assoc()) {
                if (!$resolved_task_id && !empty($row['task_id'])) {
                    $resolved_task_id = intval($row['task_id']);
                }
                if ($resolved_status === null) {
                    $resolved_status = $row['status'] ?? null;
                }
                if ($resolved_name === null || $resolved_name === '') {
                    $resolved_name = $row['document_name'] ?? null;
                }
            }
        }
    }

    if ($resolved_task_id && shouldMarkTaskDoneFromDocumentStatus($resolved_status)) {
        $label = trim((string)$resolved_name);
        if ($label === '') {
            $label = 'Document #' . intval($document_id);
        }
        completeTask($conn, $resolved_task_id, "Auto-completed by received document: $label");
    }
}

function completeTask($conn, $task_id, $reason) {
    // Check current status first? Assuming if they link it, they want it done.
    $sql = "UPDATE tasks SET status = 'completed' WHERE id = ?";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $task_id);
    if ($stmt->execute()) {
        if (session_status() === PHP_SESSION_NONE) session_start();
        $user_id = $_SESSION['user_id'] ?? null;
        if ($user_id) {
            logActivity($conn, $user_id, 'complete_task', "Task ID $task_id updated to completed. Reason: $reason", 'task_management');
        }
    }
}

function logThis($action, $desc) {
    global $conn;
    if (session_status() === PHP_SESSION_NONE) session_start();
    $user_id = $_SESSION['user_id'] ?? null;
    if ($user_id) {
        logActivity($conn, $user_id, $action, $desc, 'document_management');
    }
}

function documentsColumnExists($conn, $table, $column) {
    $safeTable = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    $safeColumn = preg_replace('/[^A-Za-z0-9_]/', '', (string)$column);
    if ($safeTable === '' || $safeColumn === '') {
        return false;
    }

    $stmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return false;
    }

    $stmt->bind_param('ss', $safeTable, $safeColumn);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();

    return $exists;
}

function resolveDocumentType($conn, $task_id, $client_id, $fallback = '') {
    if ($task_id) {
        $hasTaskServiceId = documentsColumnExists($conn, 'tasks', 'service_id');
        $serviceSelect = $hasTaskServiceId ? 's.service_name' : 'NULL AS service_name';
        $serviceJoin = $hasTaskServiceId ? 'LEFT JOIN services s ON t.service_id = s.service_id' : '';

        $sql = "SELECT $serviceSelect
                FROM tasks t
                $serviceJoin
                LEFT JOIN projects p ON t.project_id = p.id
                WHERE t.id = ?";

        if ($client_id) {
            $sql .= " AND p.client_id = ?";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('ii', $task_id, $client_id);
        } else {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $task_id);
        }

        $stmt->execute();
        $result = $stmt->get_result();
        if ($row = $result->fetch_assoc()) {
            $service_name = trim((string)($row['service_name'] ?? ''));
            if ($service_name !== '') {
                return sanitizeInput($service_name);
            }
        }
    }

    return sanitizeInput((string)$fallback);
}

closeDBConnection($conn);
?>
