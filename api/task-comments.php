<?php
/**
 * Task Comments API
 * Supports task discussion (comments/replies) with optional file attachment.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
$GLOBALS['conn'] = $conn;

ensureTaskCollaboratorsTable($conn);
ensureTaskCommentsTable($conn);

switch ($method) {
    case 'GET':
        requireAuth();
        if (strtolower(trim((string)($_GET['action'] ?? ''))) === 'view_attachment') {
            handleViewAttachment($conn);
        } else {
            handleGet($conn);
        }
        break;
    case 'POST':
        requireAuth();
        handlePost($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function handleViewAttachment($conn) {
    $commentId = intval($_GET['comment_id'] ?? 0);
    if ($commentId <= 0) {
        sendError('Comment ID is required', 400);
    }

    $stmt = $conn->prepare(
        "SELECT comment_id, task_id, attachment_path, attachment_name, attachment_mime
         FROM task_comment
         WHERE comment_id = ? AND attachment_path IS NOT NULL
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to prepare attachment lookup', 500);
    $stmt->bind_param('i', $commentId);
    $stmt->execute();
    $attachment = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$attachment) sendError('Attachment not found', 404);

    $role = getCurrentRole();
    $userId = intval($_SESSION['user_id'] ?? 0);
    ensureTaskAccess($conn, intval($attachment['task_id']), $role, $userId);

    $relativePath = ltrim(str_replace(['\\', "\0"], ['/', ''], (string)$attachment['attachment_path']), '/');
    $basePath = realpath(__DIR__ . '/../uploads/task-comments');
    $filePath = realpath(__DIR__ . '/../' . $relativePath);
    if (!$basePath || !$filePath || strpos($filePath, $basePath . DIRECTORY_SEPARATOR) !== 0 || !is_file($filePath)) {
        sendError('Attachment file not found', 404);
    }

    $mime = trim((string)($attachment['attachment_mime'] ?? ''));
    if ($mime === '' || $mime === 'application/octet-stream') {
        $detected = function_exists('mime_content_type') ? mime_content_type($filePath) : false;
        $mime = $detected ?: 'application/octet-stream';
    }
    $safeName = str_replace(["\r", "\n", '"'], ['', '', "'"], (string)($attachment['attachment_name'] ?: basename($filePath)));
    $download = strtolower(trim((string)($_GET['download'] ?? ''))) === '1';

    if (session_status() === PHP_SESSION_ACTIVE) @session_write_close();
    header_remove('Content-Type');
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($filePath));
    header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . $safeName . '"');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, no-store');
    header("Content-Security-Policy: default-src 'none'; script-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    header('X-Frame-Options: SAMEORIGIN');
    readfile($filePath);
    exit();
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

function ensureTaskCommentsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS task_comment (
                comment_id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                user_id INT NOT NULL,
                parent_comment_id INT NULL,
                comment_text TEXT NULL,
                attachment_path VARCHAR(255) NULL,
                attachment_name VARCHAR(255) NULL,
                attachment_mime VARCHAR(120) NULL,
                attachment_size INT NULL,
                attachment_archived TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_task_comment_task (task_id),
                INDEX idx_task_comment_parent (parent_comment_id),
                INDEX idx_task_comment_user (user_id),
                CONSTRAINT fk_task_comment_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_comment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_comment_parent FOREIGN KEY (parent_comment_id) REFERENCES task_comment(comment_id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize task comments storage.', 500);
    }

    ensureTaskCommentArchiveColumn($conn);
}

function ensureTaskCommentArchiveColumn($conn) {
    $columnExists = false;
    $result = $conn->query("SHOW COLUMNS FROM task_comment LIKE 'attachment_archived'");
    if ($result && $result->num_rows > 0) {
        $columnExists = true;
    }
    if ($result) {
        $result->close();
    }

    if (!$columnExists) {
        $alter = "ALTER TABLE task_comment
                  ADD COLUMN attachment_archived TINYINT(1) NOT NULL DEFAULT 0
                  AFTER attachment_size";
        if (!$conn->query($alter)) {
            error_log($conn->error);
            sendError('Failed to update task comments storage.', 500);
        }
    }
}

function ensureTaskExists($conn, $taskId) {
    $stmt = $conn->prepare("SELECT id FROM tasks WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to prepare task lookup', 500);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) sendError('Task not found', 404);
}

function ensureTaskAccess($conn, $taskId, $role, $userId) {
    ensureTaskExists($conn, $taskId);

    if ($role === 'staff') {
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
        if (!$stmt) sendError('Failed to validate task access', 500);
        $stmt->bind_param('iii', $taskId, $userId, $userId);
        $stmt->execute();
        $allowed = $stmt->get_result()->num_rows > 0;
        $stmt->close();

        if (!$allowed) {
            sendError('Forbidden', 403);
        }
    }
}

function normalizeUploadedFileError($errorCode) {
    $code = intval($errorCode);
    $errors = [
        UPLOAD_ERR_INI_SIZE => 'Uploaded file exceeds the server upload limit.',
        UPLOAD_ERR_FORM_SIZE => 'Uploaded file exceeds the form upload limit.',
        UPLOAD_ERR_PARTIAL => 'Uploaded file was only partially uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Temporary upload directory is missing.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write uploaded file to disk.',
        UPLOAD_ERR_EXTENSION => 'File upload blocked by server extension.',
    ];

    return $errors[$code] ?? 'Attachment upload failed.';
}

function appendUploadedAttachmentEntries(&$entries, $rawFile) {
    if (!is_array($rawFile)) return;

    $names = $rawFile['name'] ?? null;
    $tmpNames = $rawFile['tmp_name'] ?? null;
    $sizes = $rawFile['size'] ?? null;
    $errors = $rawFile['error'] ?? null;
    $types = $rawFile['type'] ?? null;

    if (is_array($names)) {
        $count = count($names);
        for ($i = 0; $i < $count; $i++) {
            $entries[] = [
                'name' => isset($names[$i]) ? (string)$names[$i] : '',
                'tmp_name' => isset($tmpNames[$i]) ? (string)$tmpNames[$i] : '',
                'size' => isset($sizes[$i]) ? intval($sizes[$i]) : 0,
                'error' => isset($errors[$i]) ? intval($errors[$i]) : UPLOAD_ERR_NO_FILE,
                'type' => isset($types[$i]) ? (string)$types[$i] : '',
            ];
        }
        return;
    }

    $entries[] = [
        'name' => (string)($names ?? ''),
        'tmp_name' => (string)($tmpNames ?? ''),
        'size' => intval($sizes ?? 0),
        'error' => intval($errors ?? UPLOAD_ERR_NO_FILE),
        'type' => (string)($types ?? ''),
    ];
}

function collectUploadedAttachmentEntries() {
    $entries = [];
    if (isset($_FILES['attachment'])) {
        appendUploadedAttachmentEntries($entries, $_FILES['attachment']);
    }
    if (isset($_FILES['attachments'])) {
        appendUploadedAttachmentEntries($entries, $_FILES['attachments']);
    }
    return $entries;
}

function storeSingleAttachment($taskId, $file) {
    $errorCode = intval($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($errorCode === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    if ($errorCode !== UPLOAD_ERR_OK) {
        sendError(normalizeUploadedFileError($errorCode), 400);
    }

    $tmpPath = (string)($file['tmp_name'] ?? '');
    if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
        sendError('Invalid uploaded attachment payload.', 400);
    }

    $size = intval($file['size'] ?? 0);
    if ($size <= 0) {
        sendError('Uploaded attachment is empty.', 400);
    }
    if ($size > (10 * 1024 * 1024)) {
        sendError('Attachment is too large (max 10MB).', 400);
    }

    $originalName = trim((string)($file['name'] ?? 'attachment'));
    if ($originalName === '') {
        $originalName = 'attachment';
    }
    $baseName = basename($originalName);
    $extension = strtolower(pathinfo($baseName, PATHINFO_EXTENSION));
    $allowedExtensions = ['pdf'];
    if ($extension === '' || !in_array($extension, $allowedExtensions, true)) {
        sendError('Unsupported attachment type. Only PDF files are allowed.', 400);
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        sendError('Failed to resolve project root for attachment upload.', 500);
    }

    $relativeDir = 'uploads/task-comments';
    $targetDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true) && !is_dir($targetDir)) {
        sendError('Failed to create attachment directory.', 500);
    }

    $random = '';
    try {
        $random = bin2hex(random_bytes(4));
    } catch (Throwable $e) {
        $random = (string)mt_rand(1000, 9999);
    }

    $storedName = 'task_' . intval($taskId) . '_' . date('YmdHis') . '_' . $random . '.' . $extension;
    $relativePath = $relativeDir . '/' . $storedName;
    $targetPath = $targetDir . DIRECTORY_SEPARATOR . $storedName;

    if (!move_uploaded_file($tmpPath, $targetPath)) {
        sendError('Failed to store uploaded attachment.', 500);
    }

    // Verify actual MIME type from file contents (not the client-supplied type header).
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->file($targetPath);
    if ($mime !== 'application/pdf') {
        unlink($targetPath);
        sendError('Only PDF files are allowed.', 400);
    }

    return [$relativePath, $baseName, $mime, $size];
}

function storeAttachments($taskId) {
    $entries = collectUploadedAttachmentEntries();
    if (count($entries) === 0) {
        return [];
    }

    $stored = [];
    foreach ($entries as $entry) {
        $attachment = storeSingleAttachment($taskId, $entry);
        if ($attachment !== null) {
            $stored[] = $attachment;
        }
    }

    return $stored;
}

function insertTaskCommentRow($conn, $taskId, $userId, $parentCommentId, $commentText, $attachment) {
    $attachmentPath = null;
    $attachmentName = null;
    $attachmentMime = null;
    $attachmentSize = null;

    if (is_array($attachment)) {
        $attachmentPath = isset($attachment[0]) ? (string)$attachment[0] : null;
        $attachmentName = isset($attachment[1]) ? (string)$attachment[1] : null;
        $attachmentMime = isset($attachment[2]) ? (string)$attachment[2] : null;
        $attachmentSize = isset($attachment[3]) ? intval($attachment[3]) : null;
    }

    $insert = $conn->prepare(
        "INSERT INTO task_comment (
            task_id,
            user_id,
            parent_comment_id,
            comment_text,
            attachment_path,
            attachment_name,
            attachment_mime,
            attachment_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    if (!$insert) sendError('Failed to prepare task comment insert', 500);
    $insert->bind_param(
        'iiissssi',
        $taskId,
        $userId,
        $parentCommentId,
        $commentText,
        $attachmentPath,
        $attachmentName,
        $attachmentMime,
        $attachmentSize
    );

    if (!$insert->execute()) {
        $insert->close();
        error_log($conn->error);
        sendError('Failed to save task comment.', 500);
    }
    $newCommentId = intval($conn->insert_id);
    $insert->close();

    // Reflect in the central Document Management library (best-effort).
    if ($newCommentId > 0 && $attachmentPath !== null && trim((string)$attachmentPath) !== '' && function_exists('registerManagedDocument')) {
        registerManagedDocument($conn, [
            'title' => ($attachmentName !== null && trim((string)$attachmentName) !== '') ? (string)$attachmentName : 'Task attachment',
            'document_type' => 'Other',
            'task_id' => $taskId,
            'source' => 'task_attachment',
            'source_table' => 'task_comment',
            'source_id' => $newCommentId,
            'file_path' => (string)$attachmentPath,
            'file_name' => $attachmentName,
            'mime_type' => $attachmentMime,
            'file_size' => $attachmentSize,
            'notes' => $commentText,
            'uploaded_by' => $userId,
        ]);
    }

    return $newCommentId;
}

function getTaskCommentRecord($conn, $commentId) {
    $stmt = $conn->prepare(
        "SELECT comment_id, task_id, comment_text, attachment_path, attachment_archived
         FROM task_comment
         WHERE comment_id = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to prepare task comment lookup', 500);
    $stmt->bind_param('i', $commentId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row ?: null;
}

function deleteStoredAttachmentFile($relativePath) {
    $path = trim((string)$relativePath);
    if ($path === '') return;

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) return;

    $normalized = str_replace(['\\', '..'], ['/', ''], $path);
    $absolute = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, ltrim($normalized, '/'));
    if (is_file($absolute)) {
        @unlink($absolute);
    }
}

function handleAttachmentAction($conn, $payload, $role, $userId, $action) {
    $commentId = intval($payload['comment_id'] ?? 0);
    if ($commentId <= 0) {
        sendError('Comment ID is required.', 400);
    }

    $comment = getTaskCommentRecord($conn, $commentId);
    if (!$comment) {
        sendError('Attachment comment not found.', 404);
    }

    $taskId = intval($comment['task_id'] ?? 0);
    if ($taskId <= 0) {
        sendError('Task not found for this attachment.', 404);
    }
    ensureTaskAccess($conn, $taskId, $role, $userId);

    $attachmentPath = (string)($comment['attachment_path'] ?? '');
    if ($attachmentPath === '') {
        sendError('Attachment not found.', 404);
    }

    if ($action === 'archive_attachment' || $action === 'restore_attachment') {
        $archived = $action === 'archive_attachment' ? 1 : 0;
        if (isset($payload['archived'])) {
            $archived = intval($payload['archived']) === 1 ? 1 : 0;
        }

        $stmt = $conn->prepare(
            "UPDATE task_comment
             SET attachment_archived = ?
             WHERE comment_id = ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to prepare attachment archive update', 500);
        $stmt->bind_param('ii', $archived, $commentId);
        if (!$stmt->execute()) {
            $stmt->close();
            error_log($conn->error);
            sendError('Failed to update attachment archive status.', 500);
        }
        $stmt->close();

        sendResponse(
            true,
            [
                'comment_id' => $commentId,
                'attachment_archived' => $archived,
            ],
            $archived === 1 ? 'Attachment archived successfully.' : 'Attachment restored successfully.'
        );
    }

    if ($action === 'remove_attachment') {
        deleteStoredAttachmentFile($attachmentPath);

        $commentText = trim((string)($comment['comment_text'] ?? ''));
        if ($commentText !== '') {
            $stmt = $conn->prepare(
                "UPDATE task_comment
                 SET attachment_path = NULL,
                     attachment_name = NULL,
                     attachment_mime = NULL,
                     attachment_size = NULL,
                     attachment_archived = 0
                 WHERE comment_id = ?
                 LIMIT 1"
            );
            if (!$stmt) sendError('Failed to prepare attachment removal update', 500);
            $stmt->bind_param('i', $commentId);
            if (!$stmt->execute()) {
                $stmt->close();
                error_log($conn->error);
                sendError('Failed to remove attachment.', 500);
            }
            $stmt->close();
        } else {
            $stmt = $conn->prepare("DELETE FROM task_comment WHERE comment_id = ? LIMIT 1");
            if (!$stmt) sendError('Failed to prepare attachment delete', 500);
            $stmt->bind_param('i', $commentId);
            if (!$stmt->execute()) {
                $stmt->close();
                error_log($conn->error);
                sendError('Failed to remove attachment row.', 500);
            }
            $stmt->close();
        }

        sendResponse(
            true,
            ['comment_id' => $commentId],
            'Attachment removed successfully.'
        );
    }

    sendError('Unsupported attachment action.', 400);
}

function handleGet($conn) {
    $role = getCurrentRole();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $taskId = intval($_GET['task_id'] ?? $_GET['id'] ?? 0);
    if ($taskId <= 0) {
        sendError('Task ID is required', 400);
    }

    $userId = intval($_SESSION['user_id'] ?? 0);
    ensureTaskAccess($conn, $taskId, $role, $userId);

    $sql = "SELECT c.comment_id,
                   c.task_id,
                   c.user_id,
                   c.parent_comment_id,
                   c.comment_text,
                   c.attachment_path,
                   c.attachment_name,
                   c.attachment_mime,
                   c.attachment_size,
                   c.attachment_archived,
                   c.created_at,
                   c.updated_at,
                   u.first_name,
                   u.last_name,
                   u.username,
                   LOWER(COALESCE(u.role, '')) AS commenter_role
            FROM task_comment c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.task_id = ?
            ORDER BY c.created_at ASC, c.comment_id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare task comments query', 500);
    $stmt->bind_param('i', $taskId);
    $stmt->execute();
    $result = $stmt->get_result();

    $comments = [];
    while ($row = $result->fetch_assoc()) {
        $fullName = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
        $comments[] = [
            'comment_id' => intval($row['comment_id']),
            'task_id' => intval($row['task_id']),
            'user_id' => intval($row['user_id']),
            'parent_comment_id' => $row['parent_comment_id'] !== null ? intval($row['parent_comment_id']) : null,
            'comment_text' => $row['comment_text'] !== null ? (string)$row['comment_text'] : null,
            'attachment_path' => $row['attachment_path'] !== null ? (string)$row['attachment_path'] : null,
            'attachment_name' => $row['attachment_name'] !== null ? (string)$row['attachment_name'] : null,
            'attachment_mime' => $row['attachment_mime'] !== null ? (string)$row['attachment_mime'] : null,
            'attachment_size' => $row['attachment_size'] !== null ? intval($row['attachment_size']) : null,
            'attachment_archived' => intval($row['attachment_archived'] ?? 0),
            'created_at' => (string)($row['created_at'] ?? ''),
            'updated_at' => (string)($row['updated_at'] ?? ''),
            'commenter_name' => $fullName !== '' ? $fullName : ((string)($row['username'] ?? 'Unknown User')),
            'commenter_role' => (string)($row['commenter_role'] ?? ''),
        ];
    }
    $stmt->close();

    sendResponse(true, $comments, 'Task comments retrieved successfully');
}

function handlePost($conn) {
    $role = getCurrentRole();
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden', 403);
    }

    $payload = !empty($_POST) ? $_POST : getJSONInput();
    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) {
        sendError('Authentication required', 401);
    }

    $action = strtolower(trim((string)($payload['action'] ?? '')));
    if (in_array($action, ['archive_attachment', 'restore_attachment', 'remove_attachment'], true)) {
        handleAttachmentAction($conn, $payload, $role, $userId, $action);
        return;
    }

    $taskId = intval($payload['task_id'] ?? 0);
    if ($taskId <= 0) {
        sendError('Task ID is required', 400);
    }
    ensureTaskAccess($conn, $taskId, $role, $userId);

    $commentTextRaw = trim((string)($payload['comment_text'] ?? $payload['comment'] ?? ''));
    if (strlen($commentTextRaw) > 4000) {
        sendError('Comment is too long (max 4000 characters).', 400);
    }
    $commentText = $commentTextRaw !== '' ? sanitizeInput($commentTextRaw) : null;

    $attachments = storeAttachments($taskId);
    if ($commentText === null && count($attachments) === 0) {
        sendError('Comment text or attachment is required.', 400);
    }

    $parentCommentId = null;
    if (isset($payload['parent_comment_id']) && $payload['parent_comment_id'] !== '' && $payload['parent_comment_id'] !== null) {
        $parentCommentId = intval($payload['parent_comment_id']);
        if ($parentCommentId <= 0) {
            sendError('Invalid parent comment ID.', 400);
        }

        $parentStmt = $conn->prepare(
            "SELECT comment_id
             FROM task_comment
             WHERE comment_id = ? AND task_id = ?
             LIMIT 1"
        );
        if (!$parentStmt) sendError('Failed to prepare parent comment lookup', 500);
        $parentStmt->bind_param('ii', $parentCommentId, $taskId);
        $parentStmt->execute();
        $parent = $parentStmt->get_result()->fetch_assoc();
        $parentStmt->close();

        if (!$parent) {
            sendError('Parent comment not found for this task.', 404);
        }
    }

    $createdCommentIds = [];
    $remainingAttachments = $attachments;
    if ($commentText !== null) {
        $firstAttachment = null;
        if (count($remainingAttachments) > 0) {
            $firstAttachment = array_shift($remainingAttachments);
        }
        $createdCommentIds[] = insertTaskCommentRow(
            $conn,
            $taskId,
            $userId,
            $parentCommentId,
            $commentText,
            $firstAttachment
        );
    }

    foreach ($remainingAttachments as $attachment) {
        $createdCommentIds[] = insertTaskCommentRow(
            $conn,
            $taskId,
            $userId,
            $parentCommentId,
            null,
            $attachment
        );
    }

    $newCommentId = count($createdCommentIds) > 0 ? intval($createdCommentIds[0]) : 0;

    logActivity(
        $conn,
        $userId,
        'task_comment',
        'Added a task comment to task ID: ' . $taskId,
        'task_management'
    );

    sendResponse(
        true,
        [
            'comment_id' => $newCommentId,
            'comment_ids' => $createdCommentIds,
            'attachment_count' => count($attachments),
        ],
        'Task comment posted successfully',
        201
    );
}

closeDBConnection($conn);
?>
