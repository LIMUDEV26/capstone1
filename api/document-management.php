<?php
/**
 * Document Management API
 * Central library for every file known to the system: direct uploads,
 * task submissions, task comment attachments, signed contracts, and
 * received documents — plus metadata CRUD and filtered listing.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'chunked_upload_utils.php';

const MANAGED_DOCS_CHUNK_MAX_BYTES = 10 * 1024 * 1024;
const MANAGED_DOCS_CHUNK_ALLOWED_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

ensureManagedDocumentsTable($conn);
requireFeatureAccess('documents', ['admin', 'manager', 'staff'], $conn);

function managedDocsRole() {
    return strtolower(trim((string)($_SESSION['role'] ?? '')));
}

function managedDocsUserId() {
    return intval($_SESSION['user_id'] ?? 0);
}

/**
 * Staff may only see documents they uploaded or documents linked to tasks
 * assigned to them (directly or as collaborator). Appends the scope clause.
 */
function applyManagedDocsStaffScope($conn, &$sql, &$params, &$types) {
    if (managedDocsRole() === 'staff') {
        $me = managedDocsUserId();
        $sql .= " AND (md.uploaded_by = ? OR md.task_id IN (
                        SELECT t.id FROM tasks t WHERE t.assigned_to = ?
                        UNION
                        SELECT tc.task_id FROM task_collaborators tc WHERE tc.user_id = ?
                    ))";
        $params[] = $me;
        $params[] = $me;
        $params[] = $me;
        $types .= 'iii';
    }
}

function managedDocsRowToResponse($row) {
    return $row;
}

switch ($method) {
    case 'GET':
        $action = $_GET['action'] ?? 'list';
        if ($action === 'list') handleManagedDocsList($conn);
        elseif ($action === 'get') handleManagedDocsGet($conn);
        else sendError('Invalid action', 400);
        break;
    case 'POST':
        $action = $_GET['action'] ?? 'upload';
        if ($action === 'upload') handleManagedDocsUpload($conn);
        elseif ($action === 'upload_init') handleManagedDocsUploadInit($conn);
        elseif ($action === 'upload_chunk') handleManagedDocsUploadChunk($conn);
        elseif ($action === 'upload_complete') handleManagedDocsUploadComplete($conn);
        elseif ($action === 'upload_abort') handleManagedDocsUploadAbort($conn);
        elseif ($action === 'delete') {
            requireRole(['admin']);
            handleManagedDocsDelete($conn);
        } else sendError('Invalid action', 400);
        break;
    case 'PUT':
        handleManagedDocsUpdate($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

/**
 * GET - Filtered list of all managed documents.
 * Filters: search, client_id, document_type, source, status, task_id,
 * project_id, date_from, date_to.
 */
function handleManagedDocsList($conn) {
    $sql = "SELECT md.*,
                   c.client_name,
                   t.title AS task_title,
                   p.name AS project_name,
                   CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
            FROM managed_documents md
            LEFT JOIN client c ON c.client_id = md.client_id
            LEFT JOIN tasks t ON t.id = md.task_id
            LEFT JOIN projects p ON p.id = md.project_id
            LEFT JOIN users u ON u.id = md.uploaded_by
            WHERE 1=1";

    $params = [];
    $types = '';

    $search = trim((string)($_GET['search'] ?? ''));
    if ($search !== '') {
        $sql .= " AND (md.title LIKE ? OR md.file_name LIKE ? OR md.notes LIKE ? OR md.document_type LIKE ? OR md.mime_type LIKE ? OR c.client_name LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)";
        $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
        $like = "%{$escaped}%";
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
        $types .= 'sssssss';
    }

    $clientId = intval($_GET['client_id'] ?? 0);
    if ($clientId > 0) {
        $sql .= " AND md.client_id = ?";
        $params[] = $clientId;
        $types .= 'i';
    }

    $docType = trim((string)($_GET['document_type'] ?? ''));
    if ($docType !== '') {
        $sql .= " AND md.document_type = ?";
        $params[] = validManagedDocumentType($docType);
        $types .= 's';
    }

    $source = strtolower(trim((string)($_GET['source'] ?? '')));
    if (in_array($source, ['upload', 'task_submission', 'task_attachment', 'contract_file', 'received'], true)) {
        $sql .= " AND md.source = ?";
        $params[] = $source;
        $types .= 's';
    }

    $status = strtolower(trim((string)($_GET['status'] ?? '')));
    if (in_array($status, ['active', 'archived'], true)) {
        $sql .= " AND md.status = ?";
        $params[] = $status;
        $types .= 's';
    } elseif ($status !== 'all') {
        // Default view hides archived items (they live under the Archived filter).
        $sql .= " AND md.status = 'active'";
    }

    $taskId = intval($_GET['task_id'] ?? 0);
    if ($taskId > 0) {
        $sql .= " AND md.task_id = ?";
        $params[] = $taskId;
        $types .= 'i';
    }

    $projectId = intval($_GET['project_id'] ?? 0);
    if ($projectId > 0) {
        // A project's files = docs linked to it directly + docs on its tasks.
        $sql .= " AND (md.project_id = ? OR md.task_id IN (SELECT id FROM tasks WHERE project_id = ?))";
        $params[] = $projectId;
        $params[] = $projectId;
        $types .= 'ii';
    }

    $dateFrom = trim((string)($_GET['date_from'] ?? ''));
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateFrom)) {
        $sql .= " AND DATE(md.created_at) >= ?";
        $params[] = $dateFrom;
        $types .= 's';
    }
    $dateTo = trim((string)($_GET['date_to'] ?? ''));
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo)) {
        $sql .= " AND DATE(md.created_at) <= ?";
        $params[] = $dateTo;
        $types .= 's';
    }

    applyManagedDocsStaffScope($conn, $sql, $params, $types);

    $sql .= " ORDER BY md.created_at DESC, md.id DESC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Failed to fetch documents.', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
    } else {
        $result = $conn->query($sql);
    }

    $rows = [];
    if ($result) {
        while ($row = $result->fetch_assoc()) {
            $rows[] = managedDocsRowToResponse($row);
        }
    }

    sendResponse(true, $rows, 'Documents retrieved successfully');
}

/**
 * GET?action=get&id= — single document with joined names.
 */
function handleManagedDocsGet($conn) {
    $id = intval($_GET['id'] ?? 0);
    if ($id <= 0) sendError('Document ID is required', 400);

    $sql = "SELECT md.*,
                   c.client_name,
                   t.title AS task_title,
                   p.name AS project_name,
                   CONCAT(u.first_name, ' ', u.last_name) AS uploaded_by_name
            FROM managed_documents md
            LEFT JOIN client c ON c.client_id = md.client_id
            LEFT JOIN tasks t ON t.id = md.task_id
            LEFT JOIN projects p ON p.id = md.project_id
            LEFT JOIN users u ON u.id = md.uploaded_by
            WHERE md.id = ?";
    $params = [$id];
    $types = 'i';
    applyManagedDocsStaffScope($conn, $sql, $params, $types);

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to fetch document.', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) sendError('Document not found', 404);
    sendResponse(true, managedDocsRowToResponse($row), 'Document retrieved successfully');
}

/**
 * POST?action=upload (multipart) — store a file in the central library.
 * Required: title, client_id, file. Optional: document_type, task_id,
 * project_id, notes.
 *
 * $stagedFile lets the chunked-upload complete handler reuse this exact
 * pipeline with an assembled temp file:
 * ['tmp_name' => path, 'name' => original, 'size' => bytes, 'error' => 0].
 */
function handleManagedDocsUpload($conn, $stagedFile = null) {
    $title = trim((string)($_POST['title'] ?? ''));
    if ($title === '') sendError('Document title is required.', 400);

    $clientId = intval($_POST['client_id'] ?? 0);
    if ($clientId <= 0) sendError('Please choose whose client this document belongs to.', 400);
    $check = $conn->prepare("SELECT client_id FROM client WHERE client_id = ? LIMIT 1");
    if (!$check) sendError('Failed to validate client.', 500);
    $check->bind_param('i', $clientId);
    $check->execute();
    if ($check->get_result()->num_rows === 0) {
        $check->close();
        sendError('Selected client not found.', 404);
    }
    $check->close();

    $taskId = isset($_POST['task_id']) && $_POST['task_id'] !== '' ? intval($_POST['task_id']) : null;
    if ($taskId !== null && $taskId <= 0) $taskId = null;
    if ($taskId !== null) {
        $tCheck = $conn->prepare("SELECT id, project_id FROM tasks WHERE id = ? LIMIT 1");
        if (!$tCheck) sendError('Failed to validate task.', 500);
        $tCheck->bind_param('i', $taskId);
        $tCheck->execute();
        $taskRow = $tCheck->get_result()->fetch_assoc();
        $tCheck->close();
        if (!$taskRow) sendError('Selected task not found.', 404);
    }

    $projectId = isset($_POST['project_id']) && $_POST['project_id'] !== '' ? intval($_POST['project_id']) : null;
    if ($projectId !== null && $projectId <= 0) $projectId = null;
    if ($projectId !== null) {
        $pCheck = $conn->prepare("SELECT id FROM projects WHERE id = ? LIMIT 1");
        if (!$pCheck) sendError('Failed to validate project.', 500);
        $pCheck->bind_param('i', $projectId);
        $pCheck->execute();
        $projectExists = $pCheck->get_result()->num_rows > 0;
        $pCheck->close();
        if (!$projectExists) sendError('Selected project not found.', 404);
    }

    // Staff may only link tasks assigned to them (directly or as collaborator).
    if (managedDocsRole() === 'staff' && $taskId !== null) {
        $scopeStmt = $conn->prepare(
            "SELECT 1 FROM tasks t WHERE t.id = ? AND t.assigned_to = ?
             UNION SELECT 1 FROM task_collaborators tc WHERE tc.task_id = ? AND tc.user_id = ? LIMIT 1"
        );
        $me = managedDocsUserId();
        if (!$scopeStmt) sendError('Failed to validate task access.', 500);
        $scopeStmt->bind_param('iiii', $taskId, $me, $taskId, $me);
        $scopeStmt->execute();
        $allowed = $scopeStmt->get_result()->num_rows > 0;
        $scopeStmt->close();
        if (!$allowed) sendError('You can only link tasks assigned to you.', 403);
    }

    $file = $stagedFile !== null ? $stagedFile : ($_FILES['document'] ?? null);
    if (!$file || (int)($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        sendError('No file uploaded.', 400);
    }
    if ((int)$file['error'] !== UPLOAD_ERR_OK) {
        sendError('File upload error: ' . (int)$file['error'], 400);
    }

    $maxBytes = 10 * 1024 * 1024;
    if ((int)($file['size'] ?? 0) > $maxBytes) {
        sendError('File must be 10MB or less.', 400);
    }

    $allowedExts = ['pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'];
    $ext = strtolower(pathinfo((string)$file['name'], PATHINFO_EXTENSION));
    if (!isset($allowedExts[$ext])) {
        sendError('Only PDF, JPG, PNG, or WEBP files are allowed.', 400);
    }
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mimeType = (string)$finfo->file((string)$file['tmp_name']);
    if ($mimeType !== $allowedExts[$ext]) {
        sendError('File content does not match its type.', 400);
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) sendError('Failed to resolve upload path.', 500);
    $relativeDir = 'uploads/managed-documents';
    $uploadDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) {
        sendError('Failed to create upload directory.', 500);
    }

    $originalName = trim((string)$file['name']);
    if ($originalName === '') $originalName = 'document.' . $ext;
    $storedName = time() . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
    $fullPath = $uploadDir . DIRECTORY_SEPARATOR . $storedName;
    // copy+unlink (instead of move_uploaded_file) so both real HTTP uploads
    // and assembled chunked-upload temp files are stored the same way.
    $srcPath = (string)$file['tmp_name'];
    if ($srcPath === '' || !is_file($srcPath) || !@copy($srcPath, $fullPath) || !is_file($fullPath)) {
        sendError('Failed to store uploaded file.', 500);
    }
    if ($stagedFile !== null && is_file($srcPath)) {
        @unlink($srcPath);
    }
    $relativePath = $relativeDir . '/' . $storedName;

    $docType = validManagedDocumentType($_POST['document_type'] ?? 'Other');
    $notes = trim((string)($_POST['notes'] ?? ''));
    $me = managedDocsUserId();

    $stmt = $conn->prepare(
        "INSERT INTO managed_documents (title, document_type, client_id, task_id, project_id, source, file_path, file_name, mime_type, file_size, notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?)"
    );
    if (!$stmt) {
        @unlink($fullPath);
        sendError('Failed to save document.', 500);
    }
    $cId = $clientId;
    $tId = $taskId === null ? 0 : $taskId;
    $pId = $projectId === null ? 0 : $projectId;
    $fSize = intval($file['size'] ?? 0);
    $notesOrNull = $notes === '' ? '' : $notes;
    // bind_param cannot take expressions; use variables (0-placeholders for
    // empty links, normalized back to NULL right after insert).
    // Params: title(s) docType(s) client(i) task(i) project(i) path(s) name(s) mime(s) size(i) notes(s) uploader(i).
    $stmt->bind_param('ssiiisssisi', $title, $docType, $cId, $tId, $pId, $relativePath, $originalName, $mimeType, $fSize, $notesOrNull, $me);
    if (!$stmt->execute()) {
        $stmt->close();
        @unlink($fullPath);
        error_log($conn->error);
        sendError('Failed to save document.', 500);
    }
    $newId = intval($conn->insert_id);
    $stmt->close();
    $conn->query("UPDATE managed_documents SET task_id = NULLIF(task_id, 0), project_id = NULLIF(project_id, 0), uploaded_by = NULLIF(uploaded_by, 0) WHERE id = " . $newId);

    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, 'upload_managed_document', "Uploaded document: $title", 'document_management');
    }

    // Fix NULL-typed columns that bind_param may have stored as ''/0.
    $conn->query("UPDATE managed_documents SET task_id = NULLIF(task_id, 0), project_id = NULLIF(project_id, 0) WHERE id = " . $newId);

    sendResponse(true, ['id' => $newId], 'Document uploaded successfully', 201);
}

/**
 * POST?action=upload_init — start/resume a chunked upload session.
 * Fields: file_name, file_size, title, document_type, client_id,
 * task_id?, project_id?, notes?, resume_id?.
 */
function handleManagedDocsUploadInit($conn) {
    $title = trim((string)($_POST['title'] ?? ''));
    if ($title === '') sendError('Document title is required.', 400);

    $clientId = intval($_POST['client_id'] ?? 0);
    if ($clientId <= 0) sendError('Please choose whose client this document belongs to.', 400);
    $check = $conn->prepare("SELECT client_id FROM client WHERE client_id = ? LIMIT 1");
    if (!$check) sendError('Failed to validate client.', 500);
    $check->bind_param('i', $clientId);
    $check->execute();
    if ($check->get_result()->num_rows === 0) {
        $check->close();
        sendError('Selected client not found.', 404);
    }
    $check->close();

    chunkUploadInit(
        managedDocsUserId(),
        'managed_document',
        (string)($_POST['file_name'] ?? ''),
        (int)($_POST['file_size'] ?? 0),
        MANAGED_DOCS_CHUNK_MAX_BYTES,
        MANAGED_DOCS_CHUNK_ALLOWED_EXTS,
        [
            'title' => $title,
            'document_type' => trim((string)($_POST['document_type'] ?? 'Other')),
            'client_id' => $clientId,
            'task_id' => trim((string)($_POST['task_id'] ?? '')),
            'project_id' => trim((string)($_POST['project_id'] ?? '')),
            'notes' => trim((string)($_POST['notes'] ?? '')),
        ]
    );
}

/** POST?action=upload_chunk — append one chunk (upload_id, offset, chunk). */
function handleManagedDocsUploadChunk($conn) {
    chunkUploadAppend(managedDocsUserId());
}

/**
 * POST?action=upload_complete — validate the assembled file and store it
 * through the exact same pipeline as a direct upload.
 */
function handleManagedDocsUploadComplete($conn) {
    [$partPath, $meta, $uploadId] = chunkUploadRequireComplete(managedDocsUserId(), 'managed_document');

    $stored = (array)($meta['meta'] ?? []);
    // Stage a copy outside the chunk dir, then drop the session: the upload
    // handler below exits via sendResponse, so cleanup must happen first.
    $staged = tempnam(sys_get_temp_dir(), 'managed_complete_');
    if ($staged === false || !@copy($partPath, $staged)) {
        if (is_string($staged)) @unlink($staged);
        sendError('Failed to finalize upload.', 500);
    }
    chunkUploadDeleteSession($uploadId);

    $_POST['title'] = (string)($stored['title'] ?? '');
    $_POST['document_type'] = (string)($stored['document_type'] ?? 'Other');
    $_POST['client_id'] = (string)($stored['client_id'] ?? '');
    $_POST['task_id'] = (string)($stored['task_id'] ?? '');
    $_POST['project_id'] = (string)($stored['project_id'] ?? '');
    $_POST['notes'] = (string)($stored['notes'] ?? '');

    handleManagedDocsUpload($conn, [
        'tmp_name' => $staged,
        'name' => (string)($meta['file_name'] ?? 'document'),
        'size' => (int)($meta['file_size'] ?? 0),
        'error' => UPLOAD_ERR_OK,
    ]);
}

/** POST?action=upload_abort — discard a chunked upload session. */
function handleManagedDocsUploadAbort($conn) {
    $uploadId = chunkUploadSanitizeId($_POST['upload_id'] ?? '');
    if ($uploadId !== false) {
        $meta = chunkUploadReadMeta($uploadId);
        if (is_array($meta) && (int)($meta['user_id'] ?? 0) === managedDocsUserId()) {
            chunkUploadDeleteSession($uploadId);
        }
    }
    sendResponse(true, null, 'Upload discarded.');
}

/**
 * PUT - Update document metadata (title/type/links/notes/status).
 * Admin + manager always; staff only for documents they uploaded.
 */
function handleManagedDocsUpdate($conn) {
    $data = getJSONInput();
    $id = intval($data['id'] ?? 0);
    if ($id <= 0) sendError('Document ID is required', 400);

    $stmt = $conn->prepare("SELECT id, source, uploaded_by, file_name, file_size FROM managed_documents WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to fetch document.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $existing = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$existing) sendError('Document not found', 404);

    $role = managedDocsRole();
    $me = managedDocsUserId();
    if (!in_array($role, ['admin', 'manager'], true) && intval($existing['uploaded_by'] ?? 0) !== $me) {
        sendError('You can only edit documents you uploaded.', 403);
    }

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('title', $data)) {
        $title = trim((string)$data['title']);
        if ($title === '') sendError('Document title cannot be empty.', 400);
        $updates[] = 'title = ?';
        $params[] = substr($title, 0, 255);
        $types .= 's';
    }
    if (array_key_exists('document_type', $data)) {
        $updates[] = 'document_type = ?';
        $params[] = validManagedDocumentType($data['document_type']);
        $types .= 's';
    }
    if (array_key_exists('client_id', $data)) {
        $clientId = intval($data['client_id'] ?? 0);
        if ($clientId <= 0) sendError('Please choose whose client this document belongs to.', 400);
        $check = $conn->prepare("SELECT client_id FROM client WHERE client_id = ? LIMIT 1");
        if ($check) {
            $check->bind_param('i', $clientId);
            $check->execute();
            $found = $check->get_result()->num_rows > 0;
            $check->close();
            if (!$found) sendError('Selected client not found.', 404);
        }
        $updates[] = 'client_id = ?';
        $params[] = $clientId;
        $types .= 'i';
    }
    if (array_key_exists('task_id', $data)) {
        $taskId = $data['task_id'] === null || $data['task_id'] === '' ? null : intval($data['task_id']);
        if ($taskId !== null && $taskId > 0) {
            $tCheck = $conn->prepare("SELECT id FROM tasks WHERE id = ? LIMIT 1");
            if ($tCheck) {
                $tCheck->bind_param('i', $taskId);
                $tCheck->execute();
                $found = $tCheck->get_result()->num_rows > 0;
                $tCheck->close();
                if (!$found) sendError('Selected task not found.', 404);
            }
            $updates[] = 'task_id = ?';
            $params[] = $taskId;
            $types .= 'i';
        } else {
            $updates[] = 'task_id = NULL';
        }
    }
    if (array_key_exists('project_id', $data)) {
        $projectId = $data['project_id'] === null || $data['project_id'] === '' ? null : intval($data['project_id']);
        if ($projectId !== null && $projectId > 0) {
            $pCheck = $conn->prepare("SELECT id FROM projects WHERE id = ? LIMIT 1");
            if ($pCheck) {
                $pCheck->bind_param('i', $projectId);
                $pCheck->execute();
                $found = $pCheck->get_result()->num_rows > 0;
                $pCheck->close();
                if (!$found) sendError('Selected project not found.', 404);
            }
            $updates[] = 'project_id = ?';
            $params[] = $projectId;
            $types .= 'i';
        } else {
            $updates[] = 'project_id = NULL';
        }
    }
    if (array_key_exists('notes', $data)) {
        $updates[] = 'notes = ?';
        $params[] = trim((string)$data['notes']);
        $types .= 's';
    }
    if (array_key_exists('status', $data)) {
        $status = strtolower(trim((string)$data['status']));
        if (!in_array($status, ['active', 'archived'], true)) {
            sendError('Invalid status. Allowed values: active, archived.', 400);
        }
        $updates[] = 'status = ?';
        $params[] = $status;
        $types .= 's';
    }

    if (empty($updates)) sendError('No fields to update', 400);

    $params[] = $id;
    $types .= 'i';
    $sql = 'UPDATE managed_documents SET ' . implode(', ', $updates) . ' WHERE id = ?';
    $upd = $conn->prepare($sql);
    if (!$upd) sendError('Failed to update document.', 500);
    $upd->bind_param($types, ...$params);
    if (!$upd->execute()) {
        $upd->close();
        error_log($conn->error);
        sendError('Failed to update document.', 500);
    }
    $upd->close();

    // The same physical document can enter the central registry from more than
    // one workflow (for example, a direct upload and a task submission). Treat
    // matching name + byte size records as one library item for archive/restore
    // so a duplicate does not remain visible after the user archives it.
    $statusOnlyMutation = array_key_exists('status', $data)
        && count(array_diff(array_keys($data), ['id', 'status'])) === 0;
    $existingFileName = trim((string)($existing['file_name'] ?? ''));
    $existingFileSize = intval($existing['file_size'] ?? 0);
    if ($statusOnlyMutation && $existingFileName !== '' && $existingFileSize > 0) {
        if (in_array($role, ['admin', 'manager'], true)) {
            $cluster = $conn->prepare(
                "UPDATE managed_documents SET status = ?
                 WHERE LOWER(TRIM(file_name)) = LOWER(TRIM(?)) AND file_size = ?"
            );
            if ($cluster) {
                $cluster->bind_param('ssi', $status, $existingFileName, $existingFileSize);
                $cluster->execute();
                $cluster->close();
            }
        } else {
            $cluster = $conn->prepare(
                "UPDATE managed_documents SET status = ?
                 WHERE LOWER(TRIM(file_name)) = LOWER(TRIM(?)) AND file_size = ? AND uploaded_by = ?"
            );
            if ($cluster) {
                $cluster->bind_param('ssii', $status, $existingFileName, $existingFileSize, $me);
                $cluster->execute();
                $cluster->close();
            }
        }
    }

    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, 'update_managed_document', "Updated managed document ID: $id", 'document_management');
    }

    sendResponse(true, null, 'Document updated successfully');
}

/**
 * POST?action=delete&id= — admin only. Removes the registry row; deletes the
 * physical file only for direct uploads (linked task/contract files stay
 * intact so workflows are never broken).
 */
function handleManagedDocsDelete($conn) {
    $id = intval($_GET['id'] ?? 0);
    if ($id <= 0) sendError('Document ID is required', 400);

    $stmt = $conn->prepare("SELECT id, title, source, file_path FROM managed_documents WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to fetch document.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) sendError('Document not found', 404);

    if (($row['source'] ?? '') === 'upload' && trim((string)($row['file_path'] ?? '')) !== '') {
        $projectRoot = realpath(__DIR__ . '/..');
        if ($projectRoot !== false) {
            $fullPath = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, (string)$row['file_path']);
            $uploadsRoot = $projectRoot . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR;
            // Never delete outside uploads/.
            if (str_starts_with($fullPath, $uploadsRoot) && is_file($fullPath)) {
                @unlink($fullPath);
            }
        }
    }

    $del = $conn->prepare("DELETE FROM managed_documents WHERE id = ?");
    if (!$del) sendError('Failed to delete document.', 500);
    $del->bind_param('i', $id);
    if (!$del->execute()) {
        $del->close();
        sendError('Failed to delete document.', 500);
    }
    $del->close();

    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, 'delete_managed_document', "Deleted managed document: " . (string)($row['title'] ?? $id), 'document_management');
    }

    sendResponse(true, null, 'Document deleted successfully');
}

closeDBConnection($conn);
