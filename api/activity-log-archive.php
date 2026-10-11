<?php
/**
 * Activity Log Archive API (admin only)
 *
 * Retention relocation for the audit trail. Logs are NEVER destroyed here:
 * rows older than the retention window are MOVED out of the live activity_log
 * into activity_log_archive (plus a CSV artifact) and stay viewable / importable.
 *
 * GET  ?action=policy                  — retention days + counts
 * POST ?action=set_policy              — save retention days { retention_days }
 * POST ?action=archive_now             — move logs older than the window into the archive
 * GET  ?action=list_batches            — list archive batches
 * GET  ?action=list&batch=&limit=&offset= — list archived log rows
 * GET  ?action=download&batch=         — download a batch CSV
 * POST ?action=import                  — import an archive CSV (multipart field: file)
 * POST ?action=restore                 — restore one archived log { archive_id }
 * POST ?action=restore_all             — restore all archived logs
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$conn = getDBConnection();
requireRole(['admin']);

ensureActivityLogArchiveTables($conn);

$action = $_GET['action'] ?? 'policy';
$method = getRequestMethod();

switch ($action) {
    case 'policy':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleArchivePolicy($conn);
        break;
    case 'set_policy':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleSetArchivePolicy($conn);
        break;
    case 'archive_now':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleArchiveNow($conn);
        break;
    case 'list_batches':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleListArchiveBatches($conn);
        break;
    case 'list':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleListArchivedLogs($conn);
        break;
    case 'download':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleDownloadArchive($conn);
        break;
    case 'import':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleImportArchive($conn);
        break;
    case 'restore':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleRestoreArchivedLogs($conn, false);
        break;
    case 'restore_all':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleRestoreArchivedLogs($conn, true);
        break;
    default:
        sendError('Invalid action', 400);
}

closeDBConnection($conn);

// ---- Constants ----

const ACTIVITY_LOG_ARCHIVE_SETTING = 'activity_log_retention_days';
const ACTIVITY_LOG_ARCHIVE_DEFAULT_DAYS = 90;
const ACTIVITY_LOG_ARCHIVE_EXPIRY_DAYS = 180;
const ACTIVITY_LOG_ARCHIVE_MIN_DAYS = 1;
const ACTIVITY_LOG_ARCHIVE_MAX_DAYS = 3650;

/** CSV column order — also the import contract. */
const ACTIVITY_LOG_ARCHIVE_COLUMNS = [
    'log_id',
    'user_id',
    'work_id',
    'action',
    'description',
    'activity_type',
    'duration',
    'ip_address',
    'created_at',
];

// ---- Tables ----

/**
 * Self-install the archive tables so existing installs work without a manual
 * migration. Mirrors config.php ensureTableColumn()/ensurePayrollStatusEnum().
 */
function ensureActivityLogArchiveTables($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "CREATE TABLE IF NOT EXISTS activity_log_archive_batch (
            batch_id INT AUTO_INCREMENT PRIMARY KEY,
            file_name VARCHAR(255) NULL,
            row_count INT NOT NULL DEFAULT 0,
            checksum_sha256 CHAR(64) NULL,
            retention_days INT NOT NULL,
            cutoff_at DATETIME NOT NULL,
            archived_by INT NULL,
            source VARCHAR(20) NOT NULL DEFAULT 'cleanup',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_archive_batch_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $conn->query(
        "CREATE TABLE IF NOT EXISTS activity_log_archive (
            archive_id BIGINT AUTO_INCREMENT PRIMARY KEY,
            log_id INT NOT NULL,
            archive_batch_id INT NULL,
            user_id INT NULL,
            work_id INT NULL,
            action VARCHAR(100) NOT NULL,
            description TEXT,
            activity_type VARCHAR(50),
            duration INT NULL,
            ip_address VARCHAR(45),
            created_at TIMESTAMP NULL,
            archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_archive_log_id (log_id),
            INDEX idx_archive_batch (archive_batch_id),
            INDEX idx_archive_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

// ---- Helpers ----

function getArchiveRetentionDays($conn) {
    if (!(isDbConnection($conn))) return ACTIVITY_LOG_ARCHIVE_DEFAULT_DAYS;
    $stmt = $conn->prepare('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1');
    if (!$stmt) return ACTIVITY_LOG_ARCHIVE_DEFAULT_DAYS;
    $key = ACTIVITY_LOG_ARCHIVE_SETTING;
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row || !is_numeric($row['setting_value'])) return ACTIVITY_LOG_ARCHIVE_DEFAULT_DAYS;
    return max(ACTIVITY_LOG_ARCHIVE_MIN_DAYS, min(ACTIVITY_LOG_ARCHIVE_MAX_DAYS, (int)$row['setting_value']));
}

function saveArchiveSetting($conn, $key, $value, $type = 'number') {
    $value = (string)$value;
    $stmt = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = ?, setting_type = ?, updated_at = NOW()"
    );
    $stmt->bind_param('sssss', $key, $value, $type, $value, $type);
    $stmt->execute();
    $stmt->close();
}

/** Archive CSV folder. Sits with the other backups, never inside the web root API dir. */
function getArchiveDir() {
    $dir = __DIR__ . '/../backups/activity-log-archive';
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        sendError('Activity log archive folder could not be created.', 500);
    }
    $resolved = realpath($dir);
    if ($resolved === false || !is_writable($resolved)) {
        sendError('Activity log archive folder is not writable.', 500);
    }
    return $resolved;
}

function archiveCutoff($retentionDays) {
    return date('Y-m-d H:i:s', strtotime('-' . (int)$retentionDays . ' days'));
}

/** Permanently remove archive batches after their 180-day recovery window. */
function purgeExpiredActivityLogArchives($conn) {
    $cutoff = archiveCutoff(ACTIVITY_LOG_ARCHIVE_EXPIRY_DAYS);
    $stmt = $conn->prepare('SELECT batch_id, file_name FROM activity_log_archive_batch WHERE created_at < ?');
    if (!$stmt) return 0;
    $stmt->bind_param('s', $cutoff);
    if (!$stmt->execute()) { $stmt->close(); return 0; }
    $result = $stmt->get_result();
    $batches = [];
    while ($row = $result->fetch_assoc()) $batches[] = $row;
    $stmt->close();

    $dir = __DIR__ . '/../backups/activity-log-archive';
    $removed = 0;
    foreach ($batches as $batch) {
        $batchId = (int)$batch['batch_id'];
        $fileName = (string)($batch['file_name'] ?? '');
        if ($fileName !== '' && basename($fileName) === $fileName && is_dir($dir)) {
            $path = $dir . DIRECTORY_SEPARATOR . $fileName;
            $resolved = realpath($path);
            if ($resolved !== false && strpos($resolved, realpath($dir)) === 0 && is_file($resolved) && !@unlink($resolved)) {
                continue;
            }
        }
        $deleteLogs = $conn->prepare('DELETE FROM activity_log_archive WHERE archive_batch_id = ?');
        $deleteBatch = $conn->prepare('DELETE FROM activity_log_archive_batch WHERE batch_id = ?');
        if (!$deleteLogs || !$deleteBatch) {
            if ($deleteLogs) $deleteLogs->close();
            if ($deleteBatch) $deleteBatch->close();
            continue;
        }
        $deleteLogs->bind_param('i', $batchId);
        $deleteBatch->bind_param('i', $batchId);
        if ($deleteLogs->execute() && $deleteBatch->execute()) $removed += $deleteLogs->affected_rows;
        $deleteLogs->close();
        $deleteBatch->close();
    }

    // Imported or manually inserted archive rows may not belong to a batch.
    $orphanCutoff = $cutoff;
    $orphans = $conn->prepare('DELETE FROM activity_log_archive WHERE archive_batch_id IS NULL AND archived_at < ?');
    if ($orphans) {
        $orphans->bind_param('s', $orphanCutoff);
        if ($orphans->execute()) $removed += $orphans->affected_rows;
        $orphans->close();
    }
    return $removed;
}

// ---- Handlers ----

function handleArchivePolicy($conn) {
    purgeExpiredActivityLogArchives($conn);
    $retention = getArchiveRetentionDays($conn);
    $cutoff = archiveCutoff($retention);

    $liveCount = 0;
    $liveRes = $conn->query('SELECT COUNT(*) AS c FROM activity_log');
    if ($liveRes) $liveCount = (int)$liveRes->fetch_assoc()['c'];

    $staleCount = 0;
    $staleStmt = $conn->prepare('SELECT COUNT(*) AS c FROM activity_log WHERE created_at < ?');
    if ($staleStmt) {
        $staleStmt->bind_param('s', $cutoff);
        $staleStmt->execute();
        $staleCount = (int)$staleStmt->get_result()->fetch_assoc()['c'];
        $staleStmt->close();
    }

    $archivedCount = 0;
    $archivedRes = $conn->query('SELECT COUNT(*) AS c FROM activity_log_archive');
    if ($archivedRes) $archivedCount = (int)$archivedRes->fetch_assoc()['c'];

    $batchCount = 0;
    $batchRes = $conn->query('SELECT COUNT(*) AS c FROM activity_log_archive_batch');
    if ($batchRes) $batchCount = (int)$batchRes->fetch_assoc()['c'];

    sendResponse(true, [
        'retention_days' => $retention,
        'archive_expiry_days' => ACTIVITY_LOG_ARCHIVE_EXPIRY_DAYS,
        'cutoff_at' => $cutoff,
        'live_count' => $liveCount,
        'stale_count' => $staleCount,
        'archived_count' => $archivedCount,
        'batch_count' => $batchCount,
    ], 'Activity log retention policy retrieved.');
}

function handleSetArchivePolicy($conn) {
    $data = getJSONInput();
    $days = filter_var($data['retention_days'] ?? null, FILTER_VALIDATE_INT);
    if ($days === false || $days < ACTIVITY_LOG_ARCHIVE_MIN_DAYS || $days > ACTIVITY_LOG_ARCHIVE_MAX_DAYS) {
        sendError('Retention must be between ' . ACTIVITY_LOG_ARCHIVE_MIN_DAYS . ' and ' . ACTIVITY_LOG_ARCHIVE_MAX_DAYS . ' days.', 400);
    }

    saveArchiveSetting($conn, ACTIVITY_LOG_ARCHIVE_SETTING, $days);

    $userId = (int)($_SESSION['user_id'] ?? 0);
    releaseSessionLock();
    logActivity($conn, $userId, 'update_activity_log_retention', "Activity log retention set to {$days} day(s)", 'activity_log_management');

    sendResponse(true, ['retention_days' => $days], 'Activity log retention saved.');
}

/**
 * Move every log older than the retention window into the archive.
 *
 * Order is deliberate: write + verify the CSV artifact first, then move rows
 * inside a transaction. If the CSV fails, nothing is removed from the live table.
 */
function handleArchiveNow($conn) {
    $retention = getArchiveRetentionDays($conn);
    $cutoff = archiveCutoff($retention);

    $stmt = $conn->prepare(
        "SELECT id, user_id, work_id, action, description, activity_type, duration, ip_address, created_at
         FROM activity_log
         WHERE created_at < ?
         ORDER BY id ASC"
    );
    if (!$stmt) sendError('Failed to prepare archive query', 500);
    $stmt->bind_param('s', $cutoff);
    if (!$stmt->execute()) sendError('Failed to read activity logs for archiving', 500);
    $result = $stmt->get_result();
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $stmt->close();

    if (empty($rows)) {
        sendResponse(true, [
            'moved' => 0,
            'batch_id' => null,
            'file_name' => null,
            'checksum_sha256' => null,
            'cutoff_at' => $cutoff,
            'retention_days' => $retention,
        ], 'No activity logs are older than ' . $retention . ' day(s). Nothing to archive.');
    }

    // 1. Write the CSV artifact.
    $dir = getArchiveDir();
    $fileName = 'activity_log_archive_' . date('Y-m-d_His') . '.csv';
    $path = $dir . DIRECTORY_SEPARATOR . $fileName;
    $fh = @fopen($path, 'w');
    if (!$fh) sendError('Could not create the archive CSV file.', 500);

    fputcsv($fh, ACTIVITY_LOG_ARCHIVE_COLUMNS);
    $written = 0;
    foreach ($rows as $row) {
        fputcsv($fh, [
            $row['id'],
            $row['user_id'],
            $row['work_id'],
            $row['action'],
            $row['description'],
            $row['activity_type'],
            $row['duration'],
            $row['ip_address'],
            $row['created_at'],
        ]);
        $written++;
    }
    fclose($fh);

    // 2. Verify before removing anything from the live table.
    if ($written !== count($rows)) {
        @unlink($path);
        sendError('Archive CSV row count mismatch; nothing was archived.', 500);
    }
    $checksum = hash_file('sha256', $path);

    // 3. Move rows in one transaction.
    $conn->begin_transaction();
    try {
        $ins = $conn->prepare(
            "INSERT INTO activity_log_archive_batch
                (file_name, row_count, checksum_sha256, retention_days, cutoff_at, archived_by, source)
             VALUES (?, ?, ?, ?, ?, ?, 'cleanup')"
        );
        if (!$ins) throw new RuntimeException('Failed to prepare archive batch insert.');
        $batchCount = count($rows);
        $userId = (int)($_SESSION['user_id'] ?? 0);
        $ins->bind_param('sisisi', $fileName, $batchCount, $checksum, $retention, $cutoff, $userId);
        if (!$ins->execute()) throw new RuntimeException('Failed to record the archive batch.');
        $batchId = (int)$conn->insert_id;
        $ins->close();

        $move = $conn->prepare(
            "INSERT IGNORE INTO activity_log_archive
                (log_id, archive_batch_id, user_id, work_id, action, description, activity_type, duration, ip_address, created_at)
             SELECT id, ?, user_id, work_id, action, description, activity_type, duration, ip_address, created_at
             FROM activity_log
             WHERE created_at < ?"
        );
        if (!$move) throw new RuntimeException('Failed to prepare archive move.');
        $move->bind_param('is', $batchId, $cutoff);
        if (!$move->execute()) throw new RuntimeException('Failed to copy logs into the archive.');
        $move->close();

        $del = $conn->prepare('DELETE FROM activity_log WHERE created_at < ?');
        if (!$del) throw new RuntimeException('Failed to prepare archive cleanup.');
        $del->bind_param('s', $cutoff);
        if (!$del->execute()) throw new RuntimeException('Failed to relocate logs out of the live table.');
        $moved = (int)$del->affected_rows;
        $del->close();

        $conn->commit();
    } catch (Throwable $e) {
        $conn->rollback();
        @unlink($path);
        sendError('Archive failed and was rolled back: ' . $e->getMessage(), 500);
    }

    $userId = (int)($_SESSION['user_id'] ?? 0);
    releaseSessionLock();
    logActivity(
        $conn,
        $userId,
        'archive_activity_logs',
        "Moved {$moved} activity log(s) older than {$retention} day(s) to the archive (batch #{$batchId}).",
        'activity_log_management'
    );

    sendResponse(true, [
        'moved' => $moved,
        'batch_id' => $batchId,
        'file_name' => $fileName,
        'checksum_sha256' => $checksum,
        'cutoff_at' => $cutoff,
        'retention_days' => $retention,
    ], "Archived {$moved} activity log(s).");
}

function handleListArchiveBatches($conn) {
    $batches = [];
    $res = $conn->query(
        "SELECT b.batch_id, b.file_name, b.row_count, b.checksum_sha256, b.retention_days,
                b.cutoff_at, b.source, b.created_at, u.first_name, u.last_name, u.username
         FROM activity_log_archive_batch b
         LEFT JOIN users u ON b.archived_by = u.id
         ORDER BY b.batch_id DESC
         LIMIT 200"
    );
    if ($res) {
        while ($row = $res->fetch_assoc()) {
            $batches[] = $row;
        }
    }
    sendResponse(true, $batches, 'Archive batches listed.');
}

function handleListArchivedLogs($conn) {
    purgeExpiredActivityLogArchives($conn);
    $batchId = (int)($_GET['batch'] ?? 0);
    $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 200;
    $offset = isset($_GET['offset']) ? max(0, (int)$_GET['offset']) : 0;

    $where = '';
    $params = [];
    $types = '';
    if ($batchId > 0) {
        $where = 'WHERE a.archive_batch_id = ?';
        $params[] = $batchId;
        $types .= 'i';
    }

    $total = 0;
    $countStmt = $conn->prepare("SELECT COUNT(*) AS c FROM activity_log_archive a $where");
    if ($countStmt) {
        if ($types !== '') $countStmt->bind_param($types, ...$params);
        $countStmt->execute();
        $total = (int)$countStmt->get_result()->fetch_assoc()['c'];
        $countStmt->close();
    }

    $sql = "SELECT a.archive_id, a.log_id, a.archive_batch_id, a.user_id, a.action, a.description,
                   a.activity_type, a.ip_address, a.created_at, a.archived_at,
                   u.first_name, u.last_name, u.username, u.role
            FROM activity_log_archive a
            LEFT JOIN users u ON a.user_id = u.id
            $where
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?";

    $rowParams = array_merge($params, [$limit, $offset]);
    $rowTypes = $types . 'ii';
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare archived logs query', 500);
    $stmt->bind_param($rowTypes, ...$rowParams);
    if (!$stmt->execute()) sendError('Failed to read archived logs', 500);

    $result = $stmt->get_result();
    $logs = [];
    while ($row = $result->fetch_assoc()) {
        if (function_exists('cleanAutoActivityDescription')) {
            $row['description'] = cleanAutoActivityDescription($row['description'] ?? '');
        }
        $logs[] = $row;
    }
    $stmt->close();

    sendResponse(true, ['data' => $logs, 'total' => $total, 'limit' => $limit, 'offset' => $offset], 'Archived logs listed.');
}

/** Put archived audit rows back in the live table, preserving their original IDs. */
function handleRestoreArchivedLogs($conn, $all) {
    $archiveId = 0;
    if (!$all) {
        $body = json_decode(file_get_contents('php://input'), true);
        $archiveId = (int)($body['archive_id'] ?? 0);
        if ($archiveId <= 0) sendError('Archived log ID is required', 400);
    }

    $conn->begin_transaction();
    try {
        if ($all) {
            $where = '';
            $params = [];
            $types = '';
        } else {
            $where = ' WHERE archive_id = ?';
            $params = [$archiveId];
            $types = 'i';
        }
        $sql = "INSERT IGNORE INTO activity_log (id, user_id, work_id, action, description, activity_type, duration, ip_address, created_at)
                SELECT log_id, user_id, work_id, action, description, activity_type, duration, ip_address, created_at
                FROM activity_log_archive" . $where;
        $stmt = $conn->prepare($sql);
        if (!$stmt) throw new RuntimeException('Failed to prepare activity log restore.');
        if ($types !== '') $stmt->bind_param($types, ...$params);
        if (!$stmt->execute()) throw new RuntimeException('Failed to restore activity log.');
        $restored = (int)$stmt->affected_rows;
        $stmt->close();

        $deleteSql = 'DELETE FROM activity_log_archive' . $where;
        $delete = $conn->prepare($deleteSql);
        if (!$delete) throw new RuntimeException('Failed to prepare archive cleanup.');
        if ($types !== '') $delete->bind_param($types, ...$params);
        if (!$delete->execute()) throw new RuntimeException('Failed to remove restored archive entries.');
        $removed = (int)$delete->affected_rows;
        $delete->close();
        $conn->commit();
    } catch (Throwable $e) {
        $conn->rollback();
        sendError('Restore failed: ' . $e->getMessage(), 500);
    }

    $userId = (int)($_SESSION['user_id'] ?? 0);
    releaseSessionLock();
    logActivity($conn, $userId, 'restore_activity_logs', "Restored {$restored} archived activity log(s)", 'activity_log_management');
    sendResponse(true, ['restored' => $restored, 'removed_from_archive' => $removed], "Restored {$restored} activity log(s).");
}

function handleDownloadArchive($conn) {
    $batchId = (int)($_GET['batch'] ?? 0);
    if ($batchId <= 0) sendError('Archive batch is required', 400);

    $stmt = $conn->prepare('SELECT file_name FROM activity_log_archive_batch WHERE batch_id = ? LIMIT 1');
    $stmt->bind_param('i', $batchId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row) sendError('Archive batch not found', 404);

    $fileName = (string)$row['file_name'];
    if ($fileName === '' || basename($fileName) !== $fileName) {
        sendError('Archive file is not available for this batch.', 404);
    }

    $dir = getArchiveDir();
    $path = $dir . DIRECTORY_SEPARATOR . $fileName;
    $resolved = realpath($path);
    if ($resolved === false || strpos($resolved, $dir) !== 0 || !is_file($resolved)) {
        sendError('Archive file no longer exists on disk.', 404);
    }

    // Release the session lock before streaming a potentially large file.
    releaseSessionLock();
    if (ob_get_level() > 0) {
        @ob_end_clean();
    }
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . addslashes($fileName) . '"');
    header('Content-Length: ' . filesize($resolved));
    header('Cache-Control: no-store');
    readfile($resolved);
    exit();
}

/**
 * Import an archive CSV back into the archive store.
 *
 * Append-only and idempotent: rows are keyed on the original log id, so
 * re-importing the same file never duplicates entries. Nothing is written
 * back into the live activity_log.
 */
function handleImportArchive($conn) {
    $file = $_FILES['file'] ?? null;
    if (!is_array($file) || (int)($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        sendError('Upload a CSV file to import.', 400);
    }

    $tmpPath = (string)($file['tmp_name'] ?? '');
    if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
        sendError('The uploaded file could not be read.', 400);
    }

    $checksum = hash_file('sha256', $tmpPath);
    $originalName = basename((string)($file['name'] ?? 'activity_log_import.csv'));

    $fh = @fopen($tmpPath, 'r');
    if (!$fh) sendError('The uploaded CSV could not be opened.', 400);

    $header = fgetcsv($fh, 0, ',');
    if (!is_array($header)) {
        fclose($fh);
        sendError('The CSV is empty or unreadable.', 400);
    }

    $header = array_map(function ($value) {
        // Strip a UTF-8 BOM if the producer added one.
        return strtolower(trim((string)preg_replace('/^\xEF\xBB\xBF/', '', (string)$value)));
    }, $header);

    $columnIndex = [];
    foreach (ACTIVITY_LOG_ARCHIVE_COLUMNS as $column) {
        $index = array_search($column, $header, true);
        if ($index === false) {
            fclose($fh);
            sendError('CSV is missing the required column: ' . $column, 400);
        }
        $columnIndex[$column] = $index;
    }

    $pick = function ($row, $column) use ($columnIndex) {
        $value = $row[$columnIndex[$column]] ?? null;
        return is_string($value) && trim($value) === '' ? null : $value;
    };

    $conn->begin_transaction();
    $inserted = 0;
    $skipped = 0;
    try {
        $ins = $conn->prepare(
            "INSERT INTO activity_log_archive_batch
                (file_name, row_count, checksum_sha256, retention_days, cutoff_at, archived_by, source)
             VALUES (?, 0, ?, 0, NOW(), ?, 'import')"
        );
        if (!$ins) throw new RuntimeException('Failed to prepare import batch insert.');
        $userId = (int)($_SESSION['user_id'] ?? 0);
        $ins->bind_param('ssi', $originalName, $checksum, $userId);
        if (!$ins->execute()) throw new RuntimeException('Failed to record the import batch.');
        $batchId = (int)$conn->insert_id;
        $ins->close();

        $move = $conn->prepare(
            "INSERT IGNORE INTO activity_log_archive
                (log_id, archive_batch_id, user_id, work_id, action, description, activity_type, duration, ip_address, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        if (!$move) throw new RuntimeException('Failed to prepare archive import.');

        while (($row = fgetcsv($fh, 0, ',')) !== false) {
            if ($row === [null] || $row === []) {
                continue;
            }

            $logId = filter_var($pick($row, 'log_id'), FILTER_VALIDATE_INT);
            $action = trim((string)($pick($row, 'action') ?? ''));
            if ($logId === false || $logId < 1 || $action === '') {
                $skipped++;
                continue;
            }

            $vLogId = (int)$logId;
            $vBatch = $batchId;
            $vUserId = filter_var($pick($row, 'user_id'), FILTER_VALIDATE_INT);
            $vUserId = $vUserId === false ? null : (int)$vUserId;
            $vWorkId = filter_var($pick($row, 'work_id'), FILTER_VALIDATE_INT);
            $vWorkId = $vWorkId === false ? null : (int)$vWorkId;
            $vAction = substr($action, 0, 100);
            $vDescription = $pick($row, 'description');
            $vType = $pick($row, 'activity_type');
            $vType = $vType === null ? null : substr((string)$vType, 0, 50);
            $vDuration = filter_var($pick($row, 'duration'), FILTER_VALIDATE_INT);
            $vDuration = $vDuration === false ? null : (int)$vDuration;
            $vIp = $pick($row, 'ip_address');
            $vIp = $vIp === null ? null : substr((string)$vIp, 0, 45);
            $vCreated = $pick($row, 'created_at');
            if ($vCreated !== null && strtotime((string)$vCreated) === false) {
                $vCreated = null;
            }

            $move->bind_param(
                'iiiisssiss',
                $vLogId,
                $vBatch,
                $vUserId,
                $vWorkId,
                $vAction,
                $vDescription,
                $vType,
                $vDuration,
                $vIp,
                $vCreated
            );
            if (!$move->execute()) throw new RuntimeException('Failed to import a CSV row.');
            if ($move->affected_rows > 0) {
                $inserted++;
            } else {
                $skipped++;
            }
        }
        $move->close();
        fclose($fh);

        $update = $conn->prepare('UPDATE activity_log_archive_batch SET row_count = ? WHERE batch_id = ?');
        if ($update) {
            $update->bind_param('ii', $inserted, $batchId);
            $update->execute();
            $update->close();
        }

        $conn->commit();
    } catch (Throwable $e) {
        $conn->rollback();
        if (is_resource($fh)) fclose($fh);
        sendError('Import failed and was rolled back: ' . $e->getMessage(), 500);
    }

    $userId = (int)($_SESSION['user_id'] ?? 0);
    releaseSessionLock();
    logActivity(
        $conn,
        $userId,
        'import_activity_logs',
        "Imported {$inserted} archived activity log(s) from {$originalName} (batch #{$batchId}); skipped={$skipped}.",
        'activity_log_management'
    );

    sendResponse(true, [
        'imported' => $inserted,
        'skipped' => $skipped,
        'batch_id' => $batchId,
        'checksum_sha256' => $checksum,
    ], "Imported {$inserted} archived activity log(s).");
}
