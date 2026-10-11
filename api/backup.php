<?php
/**
 * System Backup API
 * Admin-only endpoints for database backup management
 *
 * POST ?action=create          — create a new full DB backup (.sql)
 * GET  ?action=list            — list existing backups
 * GET  ?action=download&file=  — download a backup file
 * POST ?action=archive         — archive an active backup
 * POST ?action=unarchive       — return an archived backup to active history
 * POST ?action=delete          — permanently delete an archived backup
 * GET  ?action=get_deletion_policy — get retention/deletion controls
 * POST ?action=set_deletion_policy — update retention/deletion controls
 * POST ?action=cleanup         — apply retention and deletion controls now
 * GET  ?action=get_schedule    — get auto-backup schedule
 * POST ?action=set_schedule    — save auto-backup schedule
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn   = getDBConnection();

// Admin only
requireAuth();
requireRole(['admin']);

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'create':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleCreateBackup($conn);
        break;
    case 'import':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleImportBackup($conn);
        break;
    case 'list':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleListBackups();
        break;
    case 'download':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleDownloadBackup();
        break;
    case 'delete':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleDeleteBackup($conn);
        break;
    case 'archive':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleArchiveBackup($conn, false);
        break;
    case 'unarchive':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleArchiveBackup($conn, true);
        break;
    case 'get_deletion_policy':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleGetDeletionPolicy($conn);
        break;
    case 'set_deletion_policy':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleSetDeletionPolicy($conn);
        break;
    case 'cleanup':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleCleanupBackups($conn);
        break;
    case 'get_schedule':
        if ($method !== 'GET') sendError('Method not allowed', 405);
        handleGetSchedule($conn);
        break;
    case 'set_schedule':
        if ($method !== 'POST') sendError('Method not allowed', 405);
        handleSetSchedule($conn);
        break;
    default:
        sendError('Invalid action', 400);
}

closeDBConnection($conn);

// ---- Helpers ----

function getBackupDir() {
    $dir = __DIR__ . '/../backups';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    return realpath($dir);
}

function getBackupArchiveDir($backupDir = null) {
    $baseDir = $backupDir ?: getBackupDir();
    $dir = $baseDir . DIRECTORY_SEPARATOR . 'archive';
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        sendError('Backup archive folder could not be created.', 500);
    }
    $resolved = realpath($dir);
    if ($resolved === false || !is_writable($resolved)) {
        sendError('Backup archive folder is not writable.', 500);
    }
    return $resolved;
}

function isValidBackupFilename($filename) {
    return preg_match('/^backup_[\w\-]+\.sql$/', (string)$filename) === 1;
}

function getBackupCreatedTimestamp($filename, $fallback) {
    if (preg_match('/_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.sql$/', (string)$filename, $matches) === 1) {
        $parsed = strtotime("{$matches[1]}-{$matches[2]}-{$matches[3]} {$matches[4]}:{$matches[5]}:{$matches[6]}");
        if ($parsed !== false) return $parsed;
    }
    return $fallback;
}

function getIntegerSetting($conn, $key, $default, $min, $max) {
    $stmt = $conn->prepare('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1');
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$row || !is_numeric($row['setting_value'])) return $default;
    return max($min, min($max, (int)$row['setting_value']));
}

function saveSetting($conn, $key, $value, $type = 'string') {
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

function isAbsoluteBackupPath($path) {
    if (preg_match('/^[A-Za-z]:[\\\\\/]/', $path) === 1) {
        return true;
    }
    if (substr($path, 0, 1) === '/') {
        return true;
    }
    return substr($path, 0, 2) === '\\\\';
}

function prepareBackupDirectory($path) {
    $path = trim((string)$path);
    if ($path === '') {
        return getBackupDir();
    }
    if (strlen($path) > 1024 || strpos($path, "\0") !== false || !isAbsoluteBackupPath($path)) {
        sendError('Backup location must be a valid absolute folder path.', 400);
    }
    if (file_exists($path) && !is_dir($path)) {
        sendError('Backup location points to a file, not a folder.', 400);
    }
    if (!is_dir($path) && !@mkdir($path, 0755, true)) {
        sendError('Backup location could not be created.', 400);
    }
    $resolved = realpath($path);
    if ($resolved === false || !is_dir($resolved) || !is_writable($resolved)) {
        sendError('Backup location is not writable by the server.', 400);
    }
    return $resolved;
}

function getAutoBackupDir($conn) {
    $key = 'backup_auto_save_path';
    $stmt = $conn->prepare('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1');
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();
    $stmt->close();
    $configured = trim((string)($row['setting_value'] ?? ''));
    return $configured === '' ? getBackupDir() : prepareBackupDirectory($configured);
}

function getBackupRetentionLimit($conn) {
    $stored = getIntegerSetting($conn, 'backup_retention_count', 0, 0, 500);
    if ($stored > 0) return $stored;
    $raw = getenv('BACKUP_MAX_FILES');
    if ($raw === false || trim((string)$raw) === '') {
        return 10;
    }

    $limit = (int)$raw;
    if ($limit < 1) {
        return 10;
    }

    return min(500, $limit);
}

function getArchiveRetentionDays($conn) {
    return getIntegerSetting($conn, 'backup_archive_retention_days', 180, 0, 3650);
}

function getBackupImportLimitBytes() {
    $raw = getenv('BACKUP_IMPORT_MAX_BYTES');
    if ($raw === false || trim((string)$raw) === '') {
        return 50 * 1024 * 1024; // 50 MB default
    }

    $limit = (int)$raw;
    if ($limit < 1) {
        return 50 * 1024 * 1024;
    }

    return min(1024 * 1024 * 1024, $limit); // cap at 1 GB
}

function describeUploadError($errorCode) {
    switch ((int)$errorCode) {
        case UPLOAD_ERR_OK:
            return '';
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'Uploaded backup file exceeds the allowed size limit.';
        case UPLOAD_ERR_PARTIAL:
            return 'Backup upload was interrupted. Please try again.';
        case UPLOAD_ERR_NO_FILE:
            return 'No backup file was uploaded.';
        case UPLOAD_ERR_NO_TMP_DIR:
            return 'Server temporary folder is missing.';
        case UPLOAD_ERR_CANT_WRITE:
            return 'Server failed to write uploaded backup file.';
        case UPLOAD_ERR_EXTENSION:
            return 'Backup upload was blocked by a server extension.';
        default:
            return 'Unknown backup upload error.';
    }
}

function archiveOldBackups($backupDir, $keepCount) {
    $result = [
        'archived' => 0,
        'failed'  => 0,
    ];

    if ($keepCount < 1) {
        return $result;
    }

    $files = glob($backupDir . DIRECTORY_SEPARATOR . 'backup_*.sql');
    if (!$files || count($files) <= $keepCount) {
        return $result;
    }

    usort($files, function ($a, $b) {
        return filemtime($b) - filemtime($a);
    });

    $archiveDir = getBackupArchiveDir($backupDir);
    $toArchive = array_slice($files, $keepCount);
    foreach ($toArchive as $file) {
        $destination = $archiveDir . DIRECTORY_SEPARATOR . basename($file);
        if (!file_exists($destination) && @rename($file, $destination)) {
            @touch($destination);
            $result['archived']++;
        } else {
            $result['failed']++;
        }
    }

    return $result;
}

function deleteExpiredArchivedBackups($backupDir, $retentionDays) {
    $result = ['deleted' => 0, 'failed' => 0];
    if ($retentionDays < 1) return $result;
    $archiveDir = getBackupArchiveDir($backupDir);
    $files = glob($archiveDir . DIRECTORY_SEPARATOR . 'backup_*.sql') ?: [];
    $cutoff = time() - ($retentionDays * 86400);
    foreach ($files as $file) {
        if (filemtime($file) >= $cutoff) continue;
        if (@unlink($file)) $result['deleted']++;
        else $result['failed']++;
    }
    return $result;
}

function getBackupStorageStats($directory) {
    $files = glob($directory . DIRECTORY_SEPARATOR . 'backup_*.sql') ?: [];
    $bytes = 0;
    foreach ($files as $file) $bytes += (int)filesize($file);
    return ['count' => count($files), 'bytes' => $bytes];
}

/**
 * Pure-PHP full database dump (no mysqldump dependency)
 */
function handleCreateBackup($conn) {
    $backupDir = getBackupDir();
    $requestData = getJSONInput();
    $isAutomatic = !empty($requestData['automatic']);
    $timestamp = date('Y-m-d_H-i-s');
    $filename  = 'backup_' . DB_NAME . '_' . $timestamp . '.sql';
    $filepath  = $backupDir . DIRECTORY_SEPARATOR . $filename;

    $sql = "-- LLB Accountants System Backup\n";
    $sql .= "-- Database: " . DB_NAME . "\n";
    $sql .= "-- Generated: " . date('Y-m-d H:i:s') . "\n";
    $sql .= "-- =====================================================\n\n";
    $sql .= "SET FOREIGN_KEY_CHECKS=0;\n";
    $sql .= "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n";
    $sql .= "SET NAMES utf8mb4;\n\n";

    // Get all tables
    $tables = [];
    $result = $conn->query("SHOW TABLES");
    while ($row = $result->fetch_row()) {
        $tables[] = $row[0];
    }

    foreach ($tables as $table) {
        // Table structure
        $sql .= "-- -----------------------------------------------\n";
        $sql .= "-- Table: `$table`\n";
        $sql .= "-- -----------------------------------------------\n";
        $sql .= "DROP TABLE IF EXISTS `$table`;\n";

        $createResult = $conn->query("SHOW CREATE TABLE `$table`");
        $createRow = $createResult->fetch_row();
        $sql .= $createRow[1] . ";\n\n";

        // Table data
        $dataResult = $conn->query("SELECT * FROM `$table`");
        if ($dataResult && $dataResult->num_rows > 0) {
            while ($dataRow = $dataResult->fetch_row()) {
                $values = [];
                foreach ($dataRow as $i => $value) {
                    if ($value === null) {
                        $values[] = 'NULL';
                    } else {
                        $values[] = "'" . $conn->real_escape_string($value) . "'";
                    }
                }
                $sql .= "INSERT INTO `$table` VALUES (" . implode(', ', $values) . ");\n";
            }
            $sql .= "\n";
        }
    }

    $sql .= "SET FOREIGN_KEY_CHECKS=1;\n";

    // Write file
    if (file_put_contents($filepath, $sql) === false) {
        sendError('Failed to write backup file.');
    }

    $savedPath = $filepath;
    $customCopyCreated = false;
    $autoBackupDir = $backupDir;
    if ($isAutomatic) {
        $autoBackupDir = getAutoBackupDir($conn);
        if (strcasecmp($autoBackupDir, $backupDir) !== 0) {
            $automaticFilepath = $autoBackupDir . DIRECTORY_SEPARATOR . $filename;
            if (!@copy($filepath, $automaticFilepath)) {
                sendError('Backup was created in the default folder, but it could not be copied to the automatic save location.', 500);
            }
            $savedPath = $automaticFilepath;
            $customCopyCreated = true;
        }
    }

    $user_id = (int)$_SESSION['user_id'];
    $retentionLimit = getBackupRetentionLimit($conn);
    $prune = archiveOldBackups($backupDir, $retentionLimit);
    $autoPrune = $customCopyCreated
        ? archiveOldBackups($autoBackupDir, $retentionLimit)
        : ['archived' => 0, 'failed' => 0];
    $expired = deleteExpiredArchivedBackups($backupDir, getArchiveRetentionDays($conn));

    // Log activity
    $backupMode = $isAutomatic ? 'automatic' : 'manual';
    logActivity($conn, $user_id, 'create_backup', "Created $backupMode database backup: $filename; saved_to=$savedPath", 'backup');
    if ($prune['archived'] > 0 || $prune['failed'] > 0 || $expired['deleted'] > 0) {
        logActivity(
            $conn,
            $user_id,
            'backup_retention_cleanup',
            "Applied backup retention (archived={$prune['archived']}, deleted_expired={$expired['deleted']}, failed={$prune['failed']}, keep_latest={$retentionLimit})",
            'backup'
        );
    }

    sendResponse(true, [
        'filename'   => $filename,
        'size'       => filesize($filepath),
        'created_at' => date('Y-m-d H:i:s'),
        'retention_limit' => $retentionLimit,
        'auto_pruned' => $prune['archived'] + $autoPrune['archived'],
        'automatic' => $isAutomatic,
        'saved_path' => $savedPath,
        'custom_copy_created' => $customCopyCreated,
    ], 'Backup created successfully.');
}

function executeSqlFileStatements($conn, $filePath) {
    $handle = fopen($filePath, 'rb');
    if ($handle === false) {
        return [
            'success' => false,
            'message' => 'Unable to open SQL file for import.',
            'executed' => 0,
        ];
    }

    $statement = '';
    $executed = 0;
    $lineNumber = 0;

    while (($line = fgets($handle)) !== false) {
        $lineNumber++;
        $trimmed = trim($line);

        if ($statement === '') {
            $trimmedLeft = ltrim($line);
            if ($trimmed === '') {
                continue;
            }
            if (strpos($trimmedLeft, '--') === 0 || strpos($trimmedLeft, '#') === 0) {
                continue;
            }
            if (stripos($trimmedLeft, 'DELIMITER ') === 0) {
                continue;
            }
        }

        $statement .= $line;

        if (preg_match('/;\s*$/', $trimmed) !== 1) {
            continue;
        }

        $sql = trim($statement);
        $statement = '';
        if ($sql === '') {
            continue;
        }

        if (!$conn->query($sql)) {
            fclose($handle);
            $preview = preg_replace('/\s+/', ' ', $sql);
            return [
                'success' => false,
                'message' => 'SQL execution failed.',
                'executed' => $executed,
                'line' => $lineNumber,
                'statement_preview' => substr((string)$preview, 0, 180),
            ];
        }

        $executed++;
    }

    if (!feof($handle)) {
        fclose($handle);
        return [
            'success' => false,
            'message' => 'Failed while reading SQL file.',
            'executed' => $executed,
        ];
    }

    fclose($handle);

    $remaining = trim($statement);
    if ($remaining !== '') {
        if (!$conn->query($remaining)) {
            $preview = preg_replace('/\s+/', ' ', $remaining);
            return [
                'success' => false,
                'message' => 'SQL execution failed.',
                'executed' => $executed,
                'statement_preview' => substr((string)$preview, 0, 180),
            ];
        }
        $executed++;
    }

    return [
        'success' => true,
        'executed' => $executed,
    ];
}

function handleImportBackup($conn) {
    $data = getJSONInput();
    $requestedFilename = trim((string)($data['filename'] ?? ''));
    $requestedStatus = ($data['status'] ?? 'active') === 'archived' ? 'archived' : 'active';
    $uploadedFile = $_FILES['backup_file'] ?? null;
    $sourcePath = '';
    $sourceName = '';
    $sourceType = '';
    $sizeBytes = 0;
    $limitBytes = getBackupImportLimitBytes();

    if (is_array($uploadedFile) && (int)($uploadedFile['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
        $uploadError = (int)($uploadedFile['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($uploadError !== UPLOAD_ERR_OK) {
            sendError(describeUploadError($uploadError), 400);
        }

        $originalName = basename((string)($uploadedFile['name'] ?? 'backup.sql'));
        if (!preg_match('/\.sql$/i', $originalName)) {
            sendError('Only .sql backup files are allowed for import.', 400);
        }

        $sizeBytes = (int)($uploadedFile['size'] ?? 0);
        if ($sizeBytes <= 0) {
            sendError('Uploaded backup file is empty.', 400);
        }
        if ($sizeBytes > $limitBytes) {
            sendError("Uploaded backup exceeds limit of {$limitBytes} bytes.", 400);
        }

        $tmpPath = (string)($uploadedFile['tmp_name'] ?? '');
        if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
            sendError('Uploaded backup file is invalid.', 400);
        }

        $sourcePath = $tmpPath;
        $sourceName = $originalName;
        $sourceType = 'upload';
    } elseif ($requestedFilename !== '') {
        if (!isValidBackupFilename($requestedFilename)) {
            sendError('Invalid backup filename.', 400);
        }

        $candidateDir = $requestedStatus === 'archived' ? getBackupArchiveDir() : getBackupDir();
        $candidate = $candidateDir . DIRECTORY_SEPARATOR . $requestedFilename;
        if (!file_exists($candidate)) {
            sendError('Backup file not found.', 404);
        }

        $sizeBytes = (int)filesize($candidate);
        if ($sizeBytes <= 0) {
            sendError('Selected backup file is empty.', 400);
        }
        if ($sizeBytes > $limitBytes) {
            sendError("Selected backup exceeds limit of {$limitBytes} bytes.", 400);
        }

        $sourcePath = $candidate;
        $sourceName = $requestedFilename;
        $sourceType = $requestedStatus === 'archived' ? 'archived' : 'stored';
    } else {
        sendError('No backup file provided for import.', 400);
    }

    @set_time_limit(0);
    $conn->query("SET FOREIGN_KEY_CHECKS=0");
    $result = executeSqlFileStatements($conn, $sourcePath);
    $conn->query("SET FOREIGN_KEY_CHECKS=1");

    if (!$result['success']) {
        $message = 'Backup import failed';
        if (!empty($result['message'])) {
            $message .= ': ' . $result['message'];
        }
        if (!empty($result['line'])) {
            $message .= ' (near line ' . (int)$result['line'] . ')';
        }

        sendError($message, 500, [
            'executed_statements' => (int)($result['executed'] ?? 0),
            'statement_preview' => $result['statement_preview'] ?? null,
        ]);
    }

    $user_id = (int)$_SESSION['user_id'];
    logActivity(
        $conn,
        $user_id,
        'import_backup',
        "Imported backup ($sourceType): $sourceName; statements=" . (int)$result['executed'],
        'backup'
    );

    sendResponse(true, [
        'source' => $sourceName,
        'source_type' => $sourceType,
        'size' => $sizeBytes,
        'statements_executed' => (int)$result['executed'],
        'imported_at' => date('Y-m-d H:i:s'),
    ], 'Backup imported successfully.');
}

function handleListBackups() {
    $backupDir = getBackupDir();
    $backups = [];
    $locations = [
        'active' => $backupDir,
        'archived' => getBackupArchiveDir($backupDir),
    ];

    foreach ($locations as $status => $directory) {
        $files = glob($directory . DIRECTORY_SEPARATOR . 'backup_*.sql') ?: [];
        foreach ($files as $file) {
            $modifiedAt = filemtime($file);
            $createdAt = getBackupCreatedTimestamp(basename($file), $modifiedAt);
            $backups[] = [
                'filename'   => basename($file),
                'size'       => filesize($file),
                'created_at' => date('Y-m-d H:i:s', $createdAt),
                'status'     => $status,
                'archived_at' => $status === 'archived' ? date('Y-m-d H:i:s', $modifiedAt) : null,
            ];
        }
    }

    usort($backups, function ($a, $b) {
        return strcmp($b['created_at'], $a['created_at']);
    });

    sendResponse(true, $backups, 'Backups listed.');
}

function handleDownloadBackup() {
    $filename = $_GET['file'] ?? '';
    $status = ($_GET['status'] ?? 'active') === 'archived' ? 'archived' : 'active';
    if (!$filename || !isValidBackupFilename($filename)) {
        sendError('Invalid filename.', 400);
    }

    $directory = $status === 'archived' ? getBackupArchiveDir() : getBackupDir();
    $filepath = $directory . DIRECTORY_SEPARATOR . $filename;
    if (!file_exists($filepath)) {
        sendError('Backup file not found.', 404);
    }

    // Stream the file
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . filesize($filepath));
    header_remove('Content-Type'); // remove JSON header from setCORSHeaders
    header('Content-Type: application/octet-stream');
    readfile($filepath);
    exit;
}

function handleDeleteBackup($conn) {
    $verifiedUntil = (int)($_SESSION['data_deletion_access_verified_until'] ?? 0);
    if ($verifiedUntil <= time()) {
        sendError('Data Deletion Control verification is required before permanently deleting backups.', 403);
    }
    $data = getJSONInput();
    $filename = $data['filename'] ?? '';

    if (!$filename || !isValidBackupFilename($filename)) {
        sendError('Invalid filename.', 400);
    }

    $filepath = getBackupArchiveDir() . DIRECTORY_SEPARATOR . $filename;
    if (!file_exists($filepath)) {
        sendError('Archived backup file not found. Archive a backup before permanently deleting it.', 404);
    }

    if (!unlink($filepath)) {
        sendError('Failed to delete backup file.');
    }

    $user_id = (int)$_SESSION['user_id'];
    logActivity($conn, $user_id, 'delete_backup_permanently', "Permanently deleted archived backup: $filename", 'backup');

    sendResponse(true, null, 'Archived backup permanently deleted.');
}

function handleArchiveBackup($conn, $unarchive) {
    $data = getJSONInput();
    $filename = trim((string)($data['filename'] ?? ''));
    if (!isValidBackupFilename($filename)) sendError('Invalid filename.', 400);

    $backupDir = getBackupDir();
    $archiveDir = getBackupArchiveDir($backupDir);
    $source = ($unarchive ? $archiveDir : $backupDir) . DIRECTORY_SEPARATOR . $filename;
    $destination = ($unarchive ? $backupDir : $archiveDir) . DIRECTORY_SEPARATOR . $filename;
    if (!file_exists($source)) sendError($unarchive ? 'Archived backup not found.' : 'Active backup not found.', 404);
    if (file_exists($destination)) sendError('A backup with this filename already exists in the destination.', 409);
    if (!@rename($source, $destination)) sendError($unarchive ? 'Failed to restore backup from archive.' : 'Failed to archive backup.', 500);
    @touch($destination);

    $userId = (int)$_SESSION['user_id'];
    $action = $unarchive ? 'unarchive_backup' : 'archive_backup';
    $message = $unarchive ? "Returned backup to active history: $filename" : "Archived backup: $filename";
    logActivity($conn, $userId, $action, $message, 'backup');
    sendResponse(true, ['filename' => $filename, 'status' => $unarchive ? 'active' : 'archived'], $message);
}

function handleGetDeletionPolicy($conn) {
    $backupDir = getBackupDir();
    $archiveDir = getBackupArchiveDir($backupDir);
    $activeStats = getBackupStorageStats($backupDir);
    $archiveStats = getBackupStorageStats($archiveDir);
    sendResponse(true, [
        'retention_count' => getBackupRetentionLimit($conn),
        'archive_retention_days' => getArchiveRetentionDays($conn),
        'active_count' => $activeStats['count'],
        'active_bytes' => $activeStats['bytes'],
        'archive_count' => $archiveStats['count'],
        'archive_bytes' => $archiveStats['bytes'],
        'archive_path' => $archiveDir,
    ], 'Backup deletion policy retrieved.');
}

function handleSetDeletionPolicy($conn) {
    $data = getJSONInput();
    $retentionCount = filter_var($data['retention_count'] ?? null, FILTER_VALIDATE_INT);
    $archiveDays = filter_var($data['archive_retention_days'] ?? null, FILTER_VALIDATE_INT);
    if ($retentionCount === false || $retentionCount < 1 || $retentionCount > 500) {
        sendError('Active backup retention must be between 1 and 500.', 400);
    }
    if ($archiveDays === false || $archiveDays < 0 || $archiveDays > 3650) {
        sendError('Archive deletion period must be between 0 and 3650 days.', 400);
    }
    saveSetting($conn, 'backup_retention_count', $retentionCount, 'number');
    saveSetting($conn, 'backup_archive_retention_days', $archiveDays, 'number');
    logActivity($conn, (int)$_SESSION['user_id'], 'update_backup_deletion_policy', "Backup policy updated: keep_active=$retentionCount; delete_archived_after_days=$archiveDays", 'backup');
    sendResponse(true, null, 'Backup deletion controls saved.');
}

function handleCleanupBackups($conn) {
    $backupDir = getBackupDir();
    $retentionCount = getBackupRetentionLimit($conn);
    $archiveDays = getArchiveRetentionDays($conn);
    $archived = archiveOldBackups($backupDir, $retentionCount);
    $deleted = deleteExpiredArchivedBackups($backupDir, $archiveDays);
    logActivity($conn, (int)$_SESSION['user_id'], 'run_backup_cleanup', "Backup cleanup completed: archived={$archived['archived']}; deleted={$deleted['deleted']}; failed=" . ($archived['failed'] + $deleted['failed']), 'backup');
    sendResponse(true, [
        'archived' => $archived['archived'],
        'deleted' => $deleted['deleted'],
        'failed' => $archived['failed'] + $deleted['failed'],
    ], 'Backup cleanup completed.');
}

function handleGetSchedule($conn) {
    $keys = ['backup_frequency', 'backup_time', 'backup_day_of_week', 'backup_day_of_month', 'backup_auto_save_path'];
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $sql  = "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();

    $schedule = [
        'backup_frequency'     => 'off',
        'backup_time'          => '02:00',
        'backup_day_of_week'   => '0',
        'backup_day_of_month'  => '1',
        'backup_auto_save_path' => '',
        'backup_default_path' => getBackupDir(),
    ];
    while ($row = $result->fetch_assoc()) {
        $schedule[$row['setting_key']] = $row['setting_value'];
    }
    $stmt->close();

    sendResponse(true, $schedule, 'Schedule retrieved.');
}

function handleSetSchedule($conn) {
    $data = getJSONInput();
    $allowed = ['backup_frequency', 'backup_time', 'backup_day_of_week', 'backup_day_of_month', 'backup_auto_save_path'];

    if (array_key_exists('backup_auto_save_path', $data)) {
        $requestedPath = trim((string)$data['backup_auto_save_path']);
        if ($requestedPath !== '') {
            $data['backup_auto_save_path'] = prepareBackupDirectory($requestedPath);
        } else {
            $data['backup_auto_save_path'] = '';
        }
    }

    foreach ($allowed as $key) {
        if (!isset($data[$key])) continue;
        $val = (string)$data[$key];

        $stmt = $conn->prepare(
            "INSERT INTO settings (setting_key, setting_value, setting_type)
             VALUES (?, ?, 'string')
             ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()"
        );
        $stmt->bind_param('sss', $key, $val, $val);
        $stmt->execute();
        $stmt->close();
    }

    $user_id = (int)$_SESSION['user_id'];
    $pathLabel = trim((string)($data['backup_auto_save_path'] ?? '')) ?: getBackupDir();
    logActivity($conn, $user_id, 'update_backup_schedule', 'Updated backup schedule: ' . ($data['backup_frequency'] ?? 'off') . '; save_path=' . $pathLabel, 'backup');

    sendResponse(true, null, 'Schedule saved.');
}
?>
