<?php
/**
 * Contracts API
 * Handles contract lifecycle: creation, email dispatch, client acceptance/rejection,
 * and admin notification when the client responds.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn   = getDBConnection();

// Runtime schema bootstrap
runRuntimeSchemaUpgradeOnce('contracts_schema_v20260801_signed', function () use ($conn) {
    // Add contract_signed column to projects table
    $conn->query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_signed TINYINT(1) NOT NULL DEFAULT 0");
    // Fallback for older MySQL without IF NOT EXISTS
    $dbName = DB_NAME;
    $colCheck = $conn->prepare(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='projects' AND COLUMN_NAME='contract_signed' LIMIT 1"
    );
    if ($colCheck) {
        $colCheck->bind_param('s', $dbName);
        $colCheck->execute();
        $exists = $colCheck->get_result()->num_rows > 0;
        $colCheck->close();
        if (!$exists) {
            $conn->query("ALTER TABLE projects ADD COLUMN contract_signed TINYINT(1) NOT NULL DEFAULT 0");
        }
    }
}, 86400);

runRuntimeSchemaUpgradeOnce('contracts_schema_v20260802_archive_sign', function () use ($conn) {
    $dbName = DB_NAME;
    // is_signed column on contracts
    $chk = $conn->prepare("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='contracts' AND COLUMN_NAME='is_signed' LIMIT 1");
    if ($chk) { $chk->bind_param('s', $dbName); $chk->execute(); $ex = $chk->get_result()->num_rows > 0; $chk->close();
        if (!$ex) $conn->query("ALTER TABLE contracts ADD COLUMN is_signed TINYINT(1) NOT NULL DEFAULT 0");
    }
    // is_archived column on contracts
    $chk2 = $conn->prepare("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='contracts' AND COLUMN_NAME='is_archived' LIMIT 1");
    if ($chk2) { $chk2->bind_param('s', $dbName); $chk2->execute(); $ex2 = $chk2->get_result()->num_rows > 0; $chk2->close();
        if (!$ex2) $conn->query("ALTER TABLE contracts ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0");
    }
}, 86400);

runRuntimeSchemaUpgradeOnce('contracts_schema_v20260803_signed_file', function () use ($conn) {
    $dbName = DB_NAME;
    // signed_contract_file — stores the relative path to the uploaded signed contract document
    $chk = $conn->prepare("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='contracts' AND COLUMN_NAME='signed_contract_file' LIMIT 1");
    if ($chk) { $chk->bind_param('s', $dbName); $chk->execute(); $ex = $chk->get_result()->num_rows > 0; $chk->close();
        if (!$ex) $conn->query("ALTER TABLE contracts ADD COLUMN signed_contract_file VARCHAR(512) NULL DEFAULT NULL");
    }
}, 86400);

runRuntimeSchemaUpgradeOnce('contracts_schema_v20260720', function () use ($conn) {
    $conn->query("CREATE TABLE IF NOT EXISTS contracts (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        client_id          INT NOT NULL,
        title              VARCHAR(255) NOT NULL,
        body               MEDIUMTEXT NOT NULL,
        status             ENUM('pending','accepted','rejected','expired') NOT NULL DEFAULT 'pending',
        token              VARCHAR(80) NOT NULL UNIQUE,
        token_expires_at   DATETIME NOT NULL,
        sent_at            DATETIME NULL,
        responded_at       DATETIME NULL,
        admin_notified_at  DATETIME NULL,
        created_by         INT NULL,
        created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_contracts_client (client_id),
        INDEX idx_contracts_token  (token),
        INDEX idx_contracts_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}, 86400);

runRuntimeSchemaUpgradeOnce('contract_edit_requests_schema_v20260721', function () use ($conn) {
    $conn->query("CREATE TABLE IF NOT EXISTS contract_edit_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        contract_id INT NOT NULL,
        requested_by INT NOT NULL,
        reason TEXT NULL,
        status ENUM('pending','approved','rejected','archived') NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_contract_edit_requests_contract (contract_id),
        INDEX idx_contract_edit_requests_requester (requested_by),
        INDEX idx_contract_edit_requests_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}, 86400);

// ──────────────────────────────────────────────────────────────
// Action dispatcher
// ──────────────────────────────────────────────────────────────
$action = strtolower(trim((string)($_GET['action'] ?? '')));

// Public endpoint: client reviewing/deciding a contract via token
if ($action === 'review' || $action === 'decide') {
    if ($action === 'review') {
        handlePublicReview($conn);
    } else {
        handlePublicDecide($conn);
    }
    exit;
}

if ($action === 'request_edit') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    $role = requireFeatureAccess('contract_management', ['manager'], $conn);
    handleRequestEdit($conn, $role);
    exit;
}

if ($action === 'upload_signed_contract') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    requireFeatureAccess('contract_management', ['admin'], $conn);
    handleUploadSignedContract($conn);
    exit;
}

if ($action === 'upload_new_signed_contract') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    requireFeatureAccess('contract_management', ['admin'], $conn);
    handleUploadNewSignedContract($conn);
    exit;
}

if ($action === 'toggle_signed') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    requireFeatureAccess('contract_management', ['admin'], $conn);
    handleToggleSigned($conn);
    exit;
}

if ($action === 'toggle_archive') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    requireFeatureAccess('contract_management', ['admin'], $conn);
    handleToggleArchive($conn);
    exit;
}

if ($action === 'restore_all_archived') {
    if ($method !== 'POST') sendError('Method not allowed', 405);
    requireFeatureAccess('contract_management', ['admin'], $conn);
    $conn->query("UPDATE contracts SET is_archived = 0");
    sendResponse(true, null, 'All archived contracts restored.');
    exit;
}

// All other actions require authentication
switch ($method) {
    case 'GET':
        requireFeatureAccess('contract_management', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('contract_management', ['admin'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('contract_management', ['admin'], $conn);
        handlePutContract($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('contract_management', ['admin'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

// ──────────────────────────────────────────────────────────────
// GET  /api/contracts.php
//      ?client_id=N   – contracts for one client
//      ?id=N          – single contract
//      (no params)    – all contracts (admin view)
// ──────────────────────────────────────────────────────────────
function handleGet($conn) {
    $id        = isset($_GET['id'])        ? intval($_GET['id'])        : null;
    $client_id = isset($_GET['client_id']) ? intval($_GET['client_id']) : null;

    if ($id) {
        $stmt = $conn->prepare(
            "SELECT co.*, c.client_name, COALESCE(NULLIF(c.email, ''), c.company_email) AS client_email,
                    COALESCE(project_counts.project_count, 0) AS project_count
             FROM contracts co
             LEFT JOIN client c ON c.client_id = co.client_id
             LEFT JOIN (
                 SELECT client_id, COUNT(*) AS project_count
                 FROM projects
                 GROUP BY client_id
             ) project_counts ON project_counts.client_id = co.client_id
             WHERE co.id = ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Query failed.', 500);
        $stmt->bind_param('i', $id);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if (!$row) sendError('Contract not found.', 404);
        sendResponse(true, $row, 'Contract retrieved.');
    }

    $showArchived = isset($_GET['archived']) && $_GET['archived'] === '1';

    $sql    = "SELECT co.*, c.client_name, COALESCE(NULLIF(c.email, ''), c.company_email) AS client_email,
                       COALESCE(project_counts.project_count, 0) AS project_count,
                       latest_proj.end_date AS project_deadline
               FROM contracts co
               LEFT JOIN client c ON c.client_id = co.client_id
               LEFT JOIN (
                   SELECT client_id, COUNT(*) AS project_count
                   FROM projects
                   GROUP BY client_id
               ) project_counts ON project_counts.client_id = co.client_id
               LEFT JOIN (
                   SELECT client_id, end_date
                   FROM projects
                   WHERE id IN (SELECT MAX(id) FROM projects GROUP BY client_id)
               ) latest_proj ON latest_proj.client_id = co.client_id
               WHERE 1=1";
    $params = [];
    $types  = '';

    if ($showArchived) {
        $sql .= " AND co.is_archived = 1";
    } else {
        $sql .= " AND (co.is_archived = 0 OR co.is_archived IS NULL)";
    }

    if ($client_id && $client_id > 0) {
        $sql   .= " AND co.client_id = ?";
        $params[] = $client_id;
        $types .= 'i';
    }

    $status = trim((string)($_GET['status'] ?? ''));
    if ($status !== '') {
        $sql   .= " AND co.status = ?";
        $params[] = $status;
        $types .= 's';
    }

    $sql .= " ORDER BY co.created_at DESC";

    if (!empty($params)) {
        $stmt = $conn->prepare($sql);
        if (!$stmt) sendError('Query failed.', 500);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
        $stmt->close();
    } else {
        $result = $conn->query($sql);
    }

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }

    sendResponse(true, $rows, 'Contracts retrieved.');
}

// ──────────────────────────────────────────────────────────────
// POST /api/contracts.php
//   Body: { client_id, title, body, expires_days? }
//   Creates a contract record and emails the client a review link.
// ──────────────────────────────────────────────────────────────
function handlePost($conn) {
    $data = getJSONInput();

    $client_id   = intval($data['client_id'] ?? 0);
    $title       = trim((string)($data['title'] ?? ''));
    $body        = trim((string)($data['body']  ?? ''));
    $expires_days = max(1, intval($data['expires_days'] ?? 7));

    if ($client_id <= 0) sendError('client_id is required.', 400);
    if ($title === '')   sendError('title is required.', 400);
    if ($body  === '')   sendError('Contract body is required.', 400);

    // Load client
    $cStmt = $conn->prepare(
            "SELECT client_id, client_name, contact_person, email, company_email
          FROM client
         WHERE client_id = ?
         LIMIT 1"
    );
    if (!$cStmt) sendError('Failed to load client.', 500);
    $cStmt->bind_param('i', $client_id);
    $cStmt->execute();
    $client = $cStmt->get_result()->fetch_assoc();
    $cStmt->close();

    if (!$client) sendError('Client not found.', 404);

    $client_email = trim((string)($client['email'] ?? ''));
    if ($client_email === '') {
        $client_email = trim((string)($client['company_email'] ?? ''));
        $client['email'] = $client_email;
    }
    if ($client_email === '') {
        sendError('Client does not have an email address on file. Please update the client record first.', 422);
    }

    $existingStmt = $conn->prepare(
        "SELECT id, title, token, status
         FROM contracts
         WHERE client_id = ?
           AND status IN ('pending', 'accepted')
         ORDER BY created_at DESC, id DESC
         LIMIT 1"
    );
    if (!$existingStmt) sendError('Failed to check existing contracts.', 500);
    $existingStmt->bind_param('i', $client_id);
    $existingStmt->execute();
    $existingContract = $existingStmt->get_result()->fetch_assoc();
    $existingStmt->close();

    if ($existingContract) {
        $existing_id = intval($existingContract['id'] ?? 0);
        $existing_title = (string)($existingContract['title'] ?? $title);
        $existing_token = (string)($existingContract['token'] ?? '');
        if ($existing_id <= 0 || $existing_token === '') {
            sendError('Existing contract could not be resent. Please contact support.', 500);
        }

        // Extend the expiry window BEFORE sending the email so the client's
        // link is valid from the moment it arrives in their inbox.
        $next_expires_at = date('Y-m-d H:i:s', strtotime("+{$expires_days} days"));
        $updateSent = $conn->prepare("UPDATE contracts SET sent_at = NOW(), token_expires_at = ? WHERE id = ?");
        if ($updateSent) {
            $updateSent->bind_param('si', $next_expires_at, $existing_id);
            $updateSent->execute();
            $updateSent->close();
        }

        $sent = sendContractInvitationEmail($conn, $existing_id, $client, $existing_title, $existing_token, $expires_days);
        if (!$sent) {
            sendError('Existing contract found, but the resend email could not be sent. Please check the client email address and SMTP settings, then try again.', 502);
        }

        sendResponse(true, [
            'contract_id' => $existing_id,
            'email_sent' => true,
            'duplicate_resend' => true,
        ], 'This client already has a sent contract. The existing contract was resent instead of creating a duplicate.', 200);
    }

    // Generate secure token
    $token      = bin2hex(random_bytes(40));
    $expires_at = date('Y-m-d H:i:s', strtotime("+{$expires_days} days"));
    $created_by = checkAuthentication() ?: null;
    releaseSessionLock();

    $ins = $conn->prepare(
        "INSERT INTO contracts (client_id, title, body, token, token_expires_at, sent_at, created_by)
         VALUES (?, ?, ?, ?, ?, NOW(), ?)"
    );
    if (!$ins) { error_log($conn->error); sendError('Failed to create contract.', 500); }
    $ins->bind_param('issssi', $client_id, $title, $body, $token, $expires_at, $created_by);
    if (!$ins->execute()) { error_log($conn->error); sendError('Failed to save contract.', 500); }
    $contract_id = $conn->insert_id;
    $ins->close();

    // Send email. If delivery fails, do not leave a pending contract that the
    // client never actually received.
    $sent = sendContractInvitationEmail($conn, $contract_id, $client, $title, $token, $expires_days);
    if (!$sent) {
        $cleanup = $conn->prepare("DELETE FROM contracts WHERE id = ?");
        if ($cleanup) {
            $cleanup->bind_param('i', $contract_id);
            $cleanup->execute();
            $cleanup->close();
        }
        sendError('Contract email could not be sent to the client. Please check the client email address and SMTP settings, then try again.', 502);
    }

    if ($created_by) {
        logActivity($conn, $created_by, 'create_contract',
            "Created contract #{$contract_id} for client: " . $client['client_name'], 'contract_management');
    }

    sendResponse(true, [
        'contract_id'  => $contract_id,
        'email_sent'   => $sent,
    ], 'Contract created and invitation email sent to the client.', 201);
}

// ──────────────────────────────────────────────────────────────
// DELETE /api/contracts.php?id=N
// ──────────────────────────────────────────────────────────────
function handleDelete($conn) {
    $id = intval($_GET['id'] ?? 0);
    if ($id <= 0) sendError('Contract ID is required.', 400);

    // Fetch current status before deleting so we can guard accepted contracts.
    $chk = $conn->prepare("SELECT status FROM contracts WHERE id = ? LIMIT 1");
    if (!$chk) sendError('Query failed.', 500);
    $chk->bind_param('i', $id);
    $chk->execute();
    $row = $chk->get_result()->fetch_assoc();
    $chk->close();

    if (!$row) sendError('Contract not found.', 404);

    // Prevent silent deletion of accepted contracts unless the caller
    // explicitly passes ?force=1 to acknowledge they understand the consequence.
    if ($row['status'] === 'accepted' && ($_GET['force'] ?? '') !== '1') {
        sendError(
            'This contract has been accepted by the client and cannot be deleted without explicit confirmation. ' .
            'Pass force=1 to override.',
            409
        );
    }

    $stmt = $conn->prepare("DELETE FROM contracts WHERE id = ?");
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $stmt->close();

    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $user_id, 'delete_contract', "Deleted contract ID: $id", 'contract_management');
    }

    sendResponse(true, null, 'Contract deleted.');
}

// ──────────────────────────────────────────────────────────────
// PUT /api/contracts.php
//   Body: { id, title?, body? }
//   Updates contract title/body (admin only, any status).
// ──────────────────────────────────────────────────────────────
function handlePutContract($conn) {
    $data = getJSONInput();
    $id   = intval($data['id'] ?? 0);
    if ($id <= 0) sendError('Contract ID is required.', 400);

    $stmt = $conn->prepare("SELECT id FROM contracts WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    if ($stmt->get_result()->num_rows === 0) sendError('Contract not found.', 404);
    $stmt->close();

    $updates = [];
    $params  = [];
    $types   = '';

    if (isset($data['title'])) {
        $title = trim((string)$data['title']);
        if ($title === '') sendError('Title cannot be empty.', 400);
        $updates[] = 'title = ?';
        $params[]  = $title;
        $types    .= 's';
    }
    if (isset($data['body'])) {
        $body = trim((string)$data['body']);
        if ($body === '') sendError('Body cannot be empty.', 400);
        $updates[] = 'body = ?';
        $params[]  = $body;
        $types    .= 's';
    }

    if (empty($updates)) sendError('Nothing to update.', 400);

    $params[] = $id;
    $types   .= 'i';

    $sql  = "UPDATE contracts SET " . implode(', ', $updates) . " WHERE id = ?";
    $upd  = $conn->prepare($sql);
    if (!$upd) sendError('Failed to prepare update.', 500);
    $upd->bind_param($types, ...$params);
    if (!$upd->execute()) { error_log($conn->error); sendError('Failed to update contract.', 500); }
    $upd->close();

    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $user_id, 'edit_contract', "Edited contract ID: $id", 'contract_management');
    }

    sendResponse(true, ['id' => $id], 'Contract updated successfully.');
}

function handleToggleSigned($conn) {
    $data = getJSONInput();
    $id   = intval($data['id'] ?? 0);
    if ($id <= 0) sendError('Contract ID is required.', 400);
    $stmt = $conn->prepare("SELECT is_signed FROM contracts WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) sendError('Contract not found.', 404);
    $newVal = $row['is_signed'] ? 0 : 1;
    $upd = $conn->prepare("UPDATE contracts SET is_signed = ? WHERE id = ?");
    if (!$upd) sendError('Update failed.', 500);
    $upd->bind_param('ii', $newVal, $id);
    $upd->execute();
    $upd->close();
    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, $newVal ? 'sign_contract' : 'unsign_contract', "Contract #$id marked " . ($newVal ? 'signed' : 'unsigned'), 'contract_management');
    }
    sendResponse(true, ['is_signed' => $newVal], $newVal ? 'Contract marked as signed.' : 'Contract marked as unsigned.');
}

function handleToggleArchive($conn) {
    $data = getJSONInput();
    $id   = intval($data['id'] ?? 0);
    if ($id <= 0) sendError('Contract ID is required.', 400);
    $stmt = $conn->prepare("SELECT is_archived FROM contracts WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) sendError('Contract not found.', 404);
    $newVal = $row['is_archived'] ? 0 : 1;
    $upd = $conn->prepare("UPDATE contracts SET is_archived = ? WHERE id = ?");
    if (!$upd) sendError('Update failed.', 500);
    $upd->bind_param('ii', $newVal, $id);
    $upd->execute();
    $upd->close();
    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, $newVal ? 'archive_contract' : 'restore_contract', "Contract #$id " . ($newVal ? 'archived' : 'restored'), 'contract_management');
    }
    sendResponse(true, ['is_archived' => $newVal], $newVal ? 'Contract archived.' : 'Contract restored.');
}

/**
 * Shared signed-PDF validation + storage.
 * Returns [relativePath, filename, fullPath]. Errors out on failure.
 */
function storeSignedContractUpload($file, $prefix) {
    if (!$file || (int)($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        sendError('No file uploaded.', 400);
    }
    if ((int)$file['error'] !== UPLOAD_ERR_OK) {
        sendError('File upload error: ' . (int)$file['error'], 400);
    }

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mimeType = $finfo->file((string)$file['tmp_name']);
    if ($mimeType !== 'application/pdf') {
        sendError('Only PDF files are allowed.', 400);
    }

    $ext = strtolower(pathinfo((string)$file['name'], PATHINFO_EXTENSION));
    if ($ext !== 'pdf') sendError('Only PDF files are allowed.', 400);

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) sendError('Failed to resolve upload path.', 500);
    $relativeDir = 'uploads/signed-contracts';
    $uploadDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) {
        sendError('Failed to create upload directory.', 500);
    }

    $filename = $prefix . '_' . time() . '_' . bin2hex(random_bytes(6)) . '.' . $ext;
    $fullPath = $uploadDir . DIRECTORY_SEPARATOR . $filename;
    if (!move_uploaded_file((string)$file['tmp_name'], $fullPath)) {
        sendError('Failed to store uploaded file.', 500);
    }

    return [$relativeDir . '/' . $filename, $filename, $fullPath];
}

function handleUploadSignedContract($conn) {
    $id = intval($_POST['contract_id'] ?? 0);
    if ($id <= 0) sendError('Contract ID is required.', 400);

    $stmt = $conn->prepare("SELECT id, client_id, title FROM contracts WHERE id = ? LIMIT 1");
    if (!$stmt) sendError('Query failed.', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $contractRow = $stmt->get_result()->fetch_assoc();
    if (!$contractRow) sendError('Contract not found.', 404);
    $stmt->close();

    [$relativePath, $filename, $fullPath] = storeSignedContractUpload($_FILES['signed_contract'] ?? null, (string)$id);

    $upd = $conn->prepare("UPDATE contracts SET signed_contract_file = ?, is_signed = 1 WHERE id = ?");
    if (!$upd) sendError('Update failed.', 500);
    $upd->bind_param('si', $relativePath, $id);
    $upd->execute();
    $upd->close();

    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, 'upload_signed_contract', "Uploaded signed contract file for contract #$id", 'contract_management');
    }

    // Reflect in the central Document Management library (best-effort).
    if (function_exists('registerManagedDocument')) {
        $contractTitle = trim((string)($contractRow['title'] ?? ''));
        if ($contractTitle === '') $contractTitle = "Contract #$id";
        registerManagedDocument($conn, [
            'title' => 'Signed: ' . $contractTitle,
            'document_type' => 'Contract',
            'client_id' => intval($contractRow['client_id'] ?? 0) > 0 ? intval($contractRow['client_id']) : null,
            'source' => 'contract_file',
            'source_table' => 'contracts',
            'source_id' => $id,
            'file_path' => $relativePath,
            'file_name' => $filename,
            'mime_type' => 'application/pdf',
            'file_size' => is_file($fullPath) ? filesize($fullPath) : null,
            'uploaded_by' => isset($uid) ? intval($uid) : null,
        ]);
    }

    sendResponse(true, ['signed_contract_file' => $relativePath, 'is_signed' => 1], 'Signed contract uploaded.');
}

/**
 * Creates a NEW contract record from an uploaded signed PDF.
 * The client must be chosen first; the record is saved as accepted + signed.
 */
function handleUploadNewSignedContract($conn) {
    $client_id = intval($_POST['client_id'] ?? 0);
    if ($client_id <= 0) sendError('Please choose a client first.', 400);

    $cStmt = $conn->prepare("SELECT client_id, client_name FROM client WHERE client_id = ? LIMIT 1");
    if (!$cStmt) sendError('Failed to load client.', 500);
    $cStmt->bind_param('i', $client_id);
    $cStmt->execute();
    $client = $cStmt->get_result()->fetch_assoc();
    $cStmt->close();
    if (!$client) sendError('Client not found.', 404);

    $clientName = trim((string)($client['client_name'] ?? ''));
    if ($clientName === '') $clientName = 'Client #' . $client_id;

    [$relativePath, $filename, $fullPath] = storeSignedContractUpload($_FILES['signed_contract'] ?? null, 'c' . $client_id);

    $token      = bin2hex(random_bytes(40));
    $expires_at = date('Y-m-d H:i:s', strtotime('+30 days'));
    $now        = date('Y-m-d H:i:s');
    $created_by = checkAuthentication() ?: null;
    releaseSessionLock();
    $title      = 'Signed Contract - ' . $clientName;
    $body       = "Signed contract document uploaded by admin on " . date('F j, Y') . ".\n"
                . "Client: {$clientName}\n\n"
                . "See the attached signed PDF for the full terms.";

    $ins = $conn->prepare(
        "INSERT INTO contracts (client_id, title, body, status, token, token_expires_at, sent_at, responded_at, is_signed, signed_contract_file, created_by)
         VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, 1, ?, ?)"
    );
    if (!$ins) sendError('Failed to save contract.', 500);
    $ins->bind_param('isssssssi', $client_id, $title, $body, $token, $expires_at, $now, $now, $relativePath, $created_by);
    if (!$ins->execute()) { error_log($conn->error); sendError('Failed to save contract.', 500); }
    $newId = intval($conn->insert_id);
    $ins->close();

    if ($uid = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $uid, 'upload_signed_contract', "Uploaded signed contract #{$newId} for client: {$clientName}", 'contract_management');
    }

    // Reflect in the central Document Management library (best-effort).
    if (function_exists('registerManagedDocument')) {
        registerManagedDocument($conn, [
            'title' => 'Signed: ' . $title,
            'document_type' => 'Contract',
            'client_id' => $client_id,
            'source' => 'contract_file',
            'source_table' => 'contracts',
            'source_id' => $newId,
            'file_path' => $relativePath,
            'file_name' => $filename,
            'mime_type' => 'application/pdf',
            'file_size' => is_file($fullPath) ? filesize($fullPath) : null,
            'uploaded_by' => isset($uid) ? intval($uid) : null,
        ]);
    }

    sendResponse(true, ['contract_id' => $newId, 'signed_contract_file' => $relativePath], "Signed contract uploaded for {$clientName}.");
}

function handleRequestEdit($conn, $role) {
    if ($role !== 'manager') {
        sendError('Only managers can request contract edits.', 403);
    }

    $data = getJSONInput();
    $contractId = intval($data['contract_id'] ?? 0);
    $reason = trim((string)($data['reason'] ?? ''));
    $userId = intval($_SESSION['user_id'] ?? 0);

    if ($contractId <= 0) sendError('Contract ID is required.', 400);
    if ($userId <= 0) sendError('Authentication required.', 401);

    $contractStmt = $conn->prepare("SELECT id, title FROM contracts WHERE id = ? LIMIT 1");
    if (!$contractStmt) sendError('Failed to load contract.', 500);
    $contractStmt->bind_param('i', $contractId);
    $contractStmt->execute();
    $contract = $contractStmt->get_result()->fetch_assoc();
    $contractStmt->close();
    if (!$contract) sendError('Contract not found.', 404);

    $pendingStmt = $conn->prepare(
        "SELECT id FROM contract_edit_requests WHERE contract_id = ? AND requested_by = ? AND status = 'pending' LIMIT 1"
    );
    if (!$pendingStmt) sendError('Failed to check existing request.', 500);
    $pendingStmt->bind_param('ii', $contractId, $userId);
    $pendingStmt->execute();
    $pending = $pendingStmt->get_result()->fetch_assoc();
    $pendingStmt->close();
    if ($pending) {
        sendResponse(true, ['request_id' => intval($pending['id'])], 'You already have a pending edit request for this contract.');
    }

    $insertStmt = $conn->prepare(
        "INSERT INTO contract_edit_requests (contract_id, requested_by, reason) VALUES (?, ?, ?)"
    );
    if (!$insertStmt) sendError('Failed to prepare edit request.', 500);
    $insertStmt->bind_param('iis', $contractId, $userId, $reason);
    if (!$insertStmt->execute()) sendError('Failed to submit edit request.', 500);
    $requestId = $conn->insert_id;
    $insertStmt->close();

    logActivity($conn, $userId, 'request_contract_edit', "Requested edit access for contract #{$contractId}: " . ($contract['title'] ?? ''), 'contract_management');

    sendResponse(true, ['request_id' => $requestId], 'Contract edit request submitted.', 201);
}

// ──────────────────────────────────────────────────────────────
// PUBLIC: GET /api/contracts.php?action=review&token=XXX
// Returns the contract content for the client to read (no auth required).
// ──────────────────────────────────────────────────────────────
function handlePublicReview($conn) {
    $token = trim((string)($_GET['token'] ?? ''));
    if ($token === '') sendError('Token is required.', 400);

    $stmt = $conn->prepare(
        "SELECT co.id, co.title, co.body, co.status, co.token_expires_at,
                c.client_name, c.contact_person
         FROM contracts co
         LEFT JOIN client c ON c.client_id = co.client_id
         WHERE co.token = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Query error.', 500);
    $stmt->bind_param('s', $token);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) sendError('Contract not found or link is invalid.', 404);

    // Mark expired
    if ($row['status'] === 'pending' && strtotime($row['token_expires_at']) < time()) {
        $expId = intval($row['id']);
        $expStmt = $conn->prepare("UPDATE contracts SET status='expired' WHERE id=?");
        if ($expStmt) { $expStmt->bind_param('i', $expId); $expStmt->execute(); $expStmt->close(); }
        $row['status'] = 'expired';
    }

    sendResponse(true, $row, 'Contract retrieved.');
}

// ──────────────────────────────────────────────────────────────
// PUBLIC: POST /api/contracts.php?action=decide&token=XXX
// Body: { decision: "accepted" | "rejected" }
// ──────────────────────────────────────────────────────────────
function handlePublicDecide($conn) {
    $token    = trim((string)($_GET['token'] ?? ''));
    $data     = getJSONInput();
    $decision = strtolower(trim((string)($data['decision'] ?? '')));

    if ($token === '')                                      sendError('Token is required.', 400);
    if (!in_array($decision, ['accepted', 'rejected'], true)) sendError('Decision must be "accepted" or "rejected".', 400);

    // Load the contract
    $stmt = $conn->prepare(
        "SELECT co.id, co.status, co.token_expires_at, co.client_id, co.title,
                c.client_name, c.contact_person, c.email AS client_email
         FROM contracts co
         LEFT JOIN client c ON c.client_id = co.client_id
         WHERE co.token = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Query error.', 500);
    $stmt->bind_param('s', $token);
    $stmt->execute();
    $contract = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$contract) sendError('Invalid or expired link.', 404);

    if ($contract['status'] !== 'pending') {
        sendError('This contract has already been ' . $contract['status'] . '.', 409);
    }

    if (strtotime($contract['token_expires_at']) < time()) {
        $expId = intval($contract['id']);
        $expStmt = $conn->prepare("UPDATE contracts SET status='expired' WHERE id=?");
        if ($expStmt) { $expStmt->bind_param('i', $expId); $expStmt->execute(); $expStmt->close(); }
        sendError('This invitation link has expired. Please contact the office.', 410);
    }

    // Persist decision
    $cid = intval($contract['id']);
    $upd = $conn->prepare(
        "UPDATE contracts SET status=?, responded_at=NOW() WHERE id=?"
    );
    if (!$upd) sendError('Failed to save response.', 500);
    $upd->bind_param('si', $decision, $cid);
    $upd->execute();
    $upd->close();

    if ($decision === 'accepted') {
        $clientId = intval($contract['client_id'] ?? 0);
        if ($clientId > 0) {
            // Only flag project setup when the client is still active.
            $activeCheck = $conn->prepare("SELECT client_id FROM client WHERE client_id = ? AND status = 'active' LIMIT 1");
            if ($activeCheck) {
                $activeCheck->bind_param('i', $clientId);
                $activeCheck->execute();
                $isActive = $activeCheck->get_result()->num_rows > 0;
                $activeCheck->close();
                if ($isActive) {
                    $setupStmt = $conn->prepare("UPDATE client SET needs_project_setup = 1 WHERE client_id = ?");
                    if ($setupStmt) {
                        $setupStmt->bind_param('i', $clientId);
                        $setupStmt->execute();
                        $setupStmt->close();
                    }
                }
            }
        }
    }

    // Notify admin by email + in-app notifications
    notifyAdminOfClientDecision($conn, $contract, $decision);

    $msg = $decision === 'accepted'
        ? 'Thank you! You have accepted the contract. The team has been notified.'
        : 'We have received your response. Thank you for letting us know.';

    sendResponse(true, ['decision' => $decision], $msg);
}

// ──────────────────────────────────────────────────────────────
// Email helpers
// ──────────────────────────────────────────────────────────────

function getContractReviewUrl($token) {
    $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
    if ($frontendBase === '') {
        $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
        $scheme  = $isHttps ? 'https' : 'http';
        $host    = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
        $frontendBase = $scheme . '://' . $host . '/capstone1';
    }
    return rtrim($frontendBase, '/') . '/contract-review?token=' . urlencode($token);
}

function sendContractInvitationEmail($conn, $contract_id, $client, $title, $token, $expires_days) {
    if (!function_exists('sendMail')) return false;

    $to_email    = trim((string)($client['email'] ?? ''));
    if ($to_email === '' || !filter_var($to_email, FILTER_VALIDATE_EMAIL)) return false;

    $recipient   = trim((string)($client['contact_person'] ?? $client['client_name'] ?? ''));
    $client_name = htmlspecialchars((string)($client['client_name'] ?? ''), ENT_QUOTES, 'UTF-8');
    $safe_name   = htmlspecialchars($recipient ?: (string)($client['client_name'] ?? ''), ENT_QUOTES, 'UTF-8');
    $safe_title  = htmlspecialchars((string)$title, ENT_QUOTES, 'UTF-8');
    $review_url  = getContractReviewUrl($token);
    $safe_url    = htmlspecialchars($review_url, ENT_QUOTES, 'UTF-8');

    $branding    = function_exists('getEmailBranding') ? getEmailBranding() : ['brand_name' => 'LLB Accountants'];
    $brand_name  = htmlspecialchars((string)($branding['brand_name'] ?? 'LLB Accountants'), ENT_QUOTES, 'UTF-8');

    $content = "
    <p style='margin:0 0 14px 0;font-size:15px;line-height:1.7;'>Dear {$safe_name},</p>
    <p style='margin:0 0 16px 0;font-size:14px;line-height:1.8;color:#1f2937;'>
        <strong>{$brand_name}</strong> has prepared a service contract for you titled
        <strong>&ldquo;{$safe_title}&rdquo;</strong>.
    </p>
    <p style='margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#374151;'>
        Please carefully read the entire contract document. Once you have reviewed all the terms, you may
        choose to <strong>Accept</strong> or <strong>Cancel</strong> the contract using the buttons provided on the review page.
    </p>
    <div style='margin:0 0 16px 0;padding:12px 14px;background:#f0f9ff;border-radius:6px;'>
        <p style='margin:0;font-size:13px;color:#0c4a6e;'>
            &#9888; This invitation link will expire in <strong>{$expires_days} day(s)</strong>.
            Please respond before the deadline.
        </p>
    </div>
    <div style='text-align:center;margin:28px 0;'>
        <a href='{$safe_url}'
           style='display:inline-block;background:#1e3a8a;color:#ffffff;font-size:15px;
                  font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;
                  letter-spacing:0.02em;'>
            Review &amp; Respond to Contract
        </a>
    </div>
    <p style='margin:0;font-size:12px;color:#6b7280;text-align:center;'>
        If the button does not work, copy and paste this link into your browser:<br>
        <a href='{$safe_url}' style='color:#1e3a8a;word-break:break-all;'>{$safe_url}</a>
    </p>";

    $html = buildBrandedEmailLayout($content, "Action required: review your contract from {$brand_name}");

    // CC the company's own email (from settings) so internal staff always
    // receive a copy of every contract sent to a client.
    $cc = [];
    $companyEmail = '';
    $companyName  = '';
    $settingStmt = $conn->prepare(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_email','company_name')"
    );
    if ($settingStmt) {
        $settingStmt->execute();
        $settingRows = $settingStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $settingStmt->close();
        foreach ($settingRows as $row) {
            if ($row['setting_key'] === 'company_email') $companyEmail = trim((string)($row['setting_value'] ?? ''));
            if ($row['setting_key'] === 'company_name')  $companyName  = trim((string)($row['setting_value'] ?? ''));
        }
    }
    if ($companyEmail !== '' && filter_var($companyEmail, FILTER_VALIDATE_EMAIL)) {
        $cc[] = ['email' => $companyEmail, 'name' => $companyName ?: 'LLB Accountants'];
    }

    return (bool) sendMail(
        $to_email,
        $recipient ?: (string)($client['client_name'] ?? ''),
        "Action Required: Review Your Contract – {$title}",
        $html,
        "Dear {$recipient},\n\nPlease review the contract titled \"{$title}\" by visiting:\n{$review_url}\n\nThis link expires in {$expires_days} day(s).",
        [],
        $cc
    );
}

function notifyAdminOfClientDecision($conn, $contract, $decision) {
    $client_name   = (string)($contract['client_name'] ?? 'Unknown Client');
    $title         = (string)($contract['title'] ?? 'Contract');
    $contract_id   = intval($contract['id']);
    $is_accepted   = $decision === 'accepted';
    $decisionLabel = $is_accepted ? 'ACCEPTED' : 'REJECTED';
    $icon          = $is_accepted ? '✅' : '❌';

    // ── In-app notification for admins ──────────────────────────
    // Insert into ai_notifications table (visible to all admins)
    $adminStmt = $conn->prepare(
        "SELECT id FROM users WHERE LOWER(role) = 'admin' AND status != 'inactive' LIMIT 20"
    );
    $adminIds = [];
    if ($adminStmt) {
        $adminStmt->execute();
        $adminResult = $adminStmt->get_result();
        while ($adminRow = $adminResult->fetch_assoc()) {
            $adminIds[] = intval($adminRow['id']);
        }
        $adminStmt->close();
    }

    $action_url    = "/contracts?highlight={$contract_id}";
    $ai_message    = "{$icon} Client \"{$client_name}\" has {$decisionLabel} the contract \"{$title}\".";
    if ($is_accepted) {
        $ai_message .= " Click to view the contract and create a project for this client.";
        $action_url  = "/contracts?accepted={$contract_id}";
    }

    foreach ($adminIds as $adminId) {
        $notifStmt = $conn->prepare(
            "INSERT INTO ai_notifications
                (event_type, target_user_id, target_role, ai_message, icon_emoji,
                 priority_score, suggested_action, action_url, is_sent, sent_at, source)
             VALUES ('contract_decision', ?, 'admin', ?, ?, 10, ?, ?, 1, NOW(), 'manual')"
        );
        if ($notifStmt) {
            $emoji      = $is_accepted ? '🎉' : '❌';
            $suggested  = $is_accepted
                ? 'Create project for ' . $client_name
                : 'Review and follow up with client';
            $notifStmt->bind_param('issss', $adminId, $ai_message, $emoji, $suggested, $action_url);
            $notifStmt->execute();
            $notifStmt->close();
        }
    }

    // Mark admin_notified_at
    $notifiedStmt = $conn->prepare("UPDATE contracts SET admin_notified_at=NOW() WHERE id=?");
    if ($notifiedStmt) {
        $notifiedStmt->bind_param('i', $contract_id);
        $notifiedStmt->execute();
        $notifiedStmt->close();
    }

    // ── Email the admin(s) ───────────────────────────────────────
    if (!function_exists('sendMail')) return;

    $adminEmailStmt = $conn->prepare(
        "SELECT email, first_name, last_name FROM users
         WHERE LOWER(role) = 'admin'
           AND status != 'inactive'
           AND email IS NOT NULL AND email <> ''
         LIMIT 10"
    );
    if (!$adminEmailStmt) return;
    $adminEmailStmt->execute();
    $adminEmails = $adminEmailStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $adminEmailStmt->close();

    foreach ($adminEmails as $admin) {
        $admin_email  = trim((string)($admin['email'] ?? ''));
        if (!filter_var($admin_email, FILTER_VALIDATE_EMAIL)) continue;

        $admin_name   = trim(($admin['first_name'] ?? '') . ' ' . ($admin['last_name'] ?? ''));
        $safe_admin   = htmlspecialchars($admin_name ?: 'Admin', ENT_QUOTES, 'UTF-8');
        $safe_client  = htmlspecialchars($client_name, ENT_QUOTES, 'UTF-8');
        $safe_title   = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
        $badge_bg     = $is_accepted ? '#d1fae5' : '#fee2e2';
        $badge_color  = $is_accepted ? '#065f46' : '#991b1b';
        $review_link  = '';

        if ($is_accepted) {
            $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
            if ($frontendBase === '') {
                $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
                $scheme  = $isHttps ? 'https' : 'http';
                $host    = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
                $frontendBase = $scheme . '://' . $host . '/capstone1';
            }
            $contracts_url = rtrim($frontendBase, '/') . '/contracts?accepted=' . $contract_id;
            $safe_link     = htmlspecialchars($contracts_url, ENT_QUOTES, 'UTF-8');
            $review_link   = "
            <div style='text-align:center;margin:24px 0;'>
                <a href='{$safe_link}'
                   style='display:inline-block;background:#1e3a8a;color:#ffffff;font-size:14px;
                          font-weight:700;text-decoration:none;padding:12px 32px;border-radius:8px;'>
                    View Contract &amp; Create Project
                </a>
            </div>";
        }

        $content = "
        <p style='margin:0 0 14px 0;font-size:15px;line-height:1.7;'>Dear {$safe_admin},</p>
        <p style='margin:0 0 16px 0;font-size:14px;line-height:1.8;color:#1f2937;'>
            A client has responded to a service contract.
        </p>
        <div style='margin:0 0 16px 0;padding:14px 16px;background:#f8fafc;border-radius:8px;'>
            <p style='margin:0 0 8px 0;font-size:13px;color:#374151;'><strong>Client:</strong> {$safe_client}</p>
            <p style='margin:0 0 8px 0;font-size:13px;color:#374151;'><strong>Contract:</strong> {$safe_title}</p>
            <p style='margin:0;font-size:13px;color:#374151;'>
                <strong>Decision:</strong>&nbsp;
                <span style='background:{$badge_bg};color:{$badge_color};padding:2px 10px;
                             border-radius:20px;font-weight:700;font-size:12px;'>
                    {$decisionLabel}
                </span>
            </p>
        </div>
        " . ($is_accepted
            ? "<p style='margin:0 0 16px 0;font-size:14px;line-height:1.8;color:#374151;'>
                The client has accepted the contract. You may now proceed to create a project
                with the client's selected services.
               </p>"
            : "<p style='margin:0 0 16px 0;font-size:14px;line-height:1.8;color:#374151;'>
                The client has declined the contract. No further action is required at this time.
               </p>")
        . $review_link;

        $html = buildBrandedEmailLayout($content,
            "Contract {$decisionLabel} by {$client_name}");

        sendMail(
            $admin_email,
            $admin_name ?: 'Admin',
            "{$icon} Contract {$decisionLabel}: {$client_name} – {$title}",
            $html,
            "The client \"{$client_name}\" has {$decisionLabel} the contract \"{$title}\"."
        );
    }
}
