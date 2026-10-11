<?php
/**
 * Shared resumable chunked-upload infrastructure.
 *
 * Lets large uploads survive network failures: the file is sent in ~1MB
 * chunks, the server confirms received bytes per chunk, and a retry CONTINUES
 * from the last confirmed offset instead of re-uploading from zero.
 *
 * Layout per session: uploads/.tmp-chunks/<upload_id>/data.part + meta.json
 * Sessions are scoped to the owning user id and purged after 24h.
 */

function chunkUploadBaseDir() {
    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return '';
    }
    $dir = $projectRoot . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . '.tmp-chunks';
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        return '';
    }
    return $dir;
}

/** Upload ids are 32 lowercase hex chars; anything else is rejected. */
function chunkUploadSanitizeId($raw) {
    $id = strtolower(trim((string)$raw));
    if (!preg_match('/^[a-f0-9]{32}$/', $id)) {
        return false;
    }
    return $id;
}

function chunkUploadSessionDir($uploadId) {
    $base = chunkUploadBaseDir();
    if ($base === '') return '';
    return $base . DIRECTORY_SEPARATOR . $uploadId;
}

function chunkUploadReadMeta($uploadId) {
    $dir = chunkUploadSessionDir($uploadId);
    if ($dir === '') return null;
    $metaPath = $dir . DIRECTORY_SEPARATOR . 'meta.json';
    if (!is_file($metaPath)) return null;
    $raw = @file_get_contents($metaPath);
    if ($raw === false) return null;
    $meta = json_decode($raw, true);
    return is_array($meta) ? $meta : null;
}

function chunkUploadWriteMeta($uploadId, $meta) {
    $dir = chunkUploadSessionDir($uploadId);
    if ($dir === '') return false;
    return @file_put_contents($dir . DIRECTORY_SEPARATOR . 'meta.json', json_encode($meta)) !== false;
}

function chunkUploadDeleteSession($uploadId) {
    $dir = chunkUploadSessionDir($uploadId);
    if ($dir === '' || !is_dir($dir)) return;
    foreach (['data.part', 'meta.json'] as $name) {
        @unlink($dir . DIRECTORY_SEPARATOR . $name);
    }
    @rmdir($dir);
}

/** Delete sessions (any user) older than $maxAgeSeconds. Runs on init. */
function chunkUploadPurgeStale($maxAgeSeconds = 86400) {
    $base = chunkUploadBaseDir();
    if ($base === '' || !is_dir($base)) return;
    $cutoff = time() - max(3600, (int)$maxAgeSeconds);
    foreach (glob($base . DIRECTORY_SEPARATOR . '*') as $dir) {
        if (!is_dir($dir)) continue;
        $metaPath = $dir . DIRECTORY_SEPARATOR . 'meta.json';
        $mtime = is_file($metaPath) ? (int)@filemtime($metaPath) : (int)@filemtime($dir);
        if ($mtime > 0 && $mtime < $cutoff) {
            @unlink($dir . DIRECTORY_SEPARATOR . 'data.part');
            @unlink($metaPath);
            @rmdir($dir);
        }
    }
}

/**
 * Start (or resume) a chunked upload session.
 * Returns [upload_id, received] or sends an error response.
 */
function chunkUploadInit($userId, $purpose, $fileName, $fileSize, $maxBytes, $allowedExts, $meta = []) {
    $userId = (int)$userId;
    if ($userId <= 0) sendError('Not authenticated', 401);

    chunkUploadPurgeStale();

    $fileName = trim((string)$fileName);
    $fileSize = (int)$fileSize;
    if ($fileName === '') sendError('Missing file_name.', 400);
    if ($fileSize <= 0) sendError('File is empty.', 400);
    if ($fileSize > (int)$maxBytes) {
        sendError('File exceeds the size limit.', 400);
    }

    $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
    if (!in_array($ext, (array)$allowedExts, true)) {
        sendError('File type is not allowed.', 400);
    }

    // Resume: client passes back a previous upload_id for the same file.
    $resumeId = chunkUploadSanitizeId($_POST['resume_id'] ?? '');
    if ($resumeId !== false) {
        $existing = chunkUploadReadMeta($resumeId);
        if (
            is_array($existing)
            && (int)($existing['user_id'] ?? 0) === $userId
            && (string)($existing['purpose'] ?? '') === (string)$purpose
            && (string)($existing['file_name'] ?? '') === $fileName
            && (int)($existing['file_size'] ?? 0) === $fileSize
        ) {
            $received = (int)($existing['received'] ?? 0);
            // Merge fresh meta (titles/client may have been corrected).
            $existing['meta'] = $meta;
            chunkUploadWriteMeta($resumeId, $existing);
            sendResponse(true, ['upload_id' => $resumeId, 'received' => $received]);
        }
    }

    $uploadId = bin2hex(random_bytes(16));
    $dir = chunkUploadSessionDir($uploadId);
    if ($dir === '' || (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir))) {
        sendError('Failed to prepare upload session.', 500);
    }

    chunkUploadWriteMeta($uploadId, [
        'upload_id' => $uploadId,
        'user_id' => $userId,
        'purpose' => (string)$purpose,
        'file_name' => $fileName,
        'file_size' => $fileSize,
        'received' => 0,
        'meta' => $meta,
        'created_at' => date('Y-m-d H:i:s'),
    ]);

    sendResponse(true, ['upload_id' => $uploadId, 'received' => 0]);
}

/**
 * Append one chunk. Expects $_POST upload_id/offset + $_FILES chunk.
 * Always reports the server-confirmed received count so the client can
 * resync (409) or continue after a retry.
 */
function chunkUploadAppend($userId) {
    $userId = (int)$userId;
    if ($userId <= 0) sendError('Not authenticated', 401);

    $uploadId = chunkUploadSanitizeId($_POST['upload_id'] ?? '');
    if ($uploadId === false) sendError('Missing upload_id.', 400);

    $meta = chunkUploadReadMeta($uploadId);
    if (!is_array($meta) || (int)($meta['user_id'] ?? 0) !== $userId) {
        sendError('Upload session not found. Please restart the upload.', 404);
    }

    $offset = (int)($_POST['offset'] ?? -1);
    $received = (int)($meta['received'] ?? 0);
    $fileSize = (int)($meta['file_size'] ?? 0);
    if ($offset < 0 || $offset !== $received) {
        sendResponse(false, ['received' => $received], 'Stale offset. Resume from ' . $received . ' bytes.', 409);
    }
    if ($received >= $fileSize) {
        sendResponse(true, ['received' => $received]);
    }

    $chunk = $_FILES['chunk'] ?? null;
    if (!$chunk || (int)($chunk['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        sendError('Chunk upload failed.', 400);
    }

    $dir = chunkUploadSessionDir($uploadId);
    $partPath = $dir . DIRECTORY_SEPARATOR . 'data.part';
    $src = fopen((string)$chunk['tmp_name'], 'rb');
    $dst = fopen($partPath, 'ab');
    if (!$src || !$dst) {
        if ($src) fclose($src);
        if ($dst) fclose($dst);
        sendError('Failed to store chunk.', 500);
    }
    if (!flock($dst, LOCK_EX)) {
        fclose($src);
        fclose($dst);
        sendError('Failed to lock upload session.', 500);
    }
    $copied = stream_copy_to_stream($src, $dst);
    flock($dst, LOCK_UN);
    fclose($src);
    fclose($dst);

    if ($copied === false) {
        sendError('Failed to store chunk.', 500);
    }

    $received += (int)$copied;
    if ($received > $fileSize) {
        // Client sent more than declared: trim back to a consistent state.
        $received = $fileSize;
    }
    $meta['received'] = $received;
    chunkUploadWriteMeta($uploadId, $meta);

    sendResponse(true, ['received' => $received]);
}

/**
 * Verify the session is complete and return [dataPath, meta].
 * On any problem an error response is sent.
 */
function chunkUploadRequireComplete($userId, $purpose) {
    $userId = (int)$userId;
    if ($userId <= 0) sendError('Not authenticated', 401);

    $uploadId = chunkUploadSanitizeId($_POST['upload_id'] ?? '');
    if ($uploadId === false) sendError('Missing upload_id.', 400);

    $meta = chunkUploadReadMeta($uploadId);
    if (!is_array($meta) || (int)($meta['user_id'] ?? 0) !== $userId) {
        sendError('Upload session not found. Please restart the upload.', 404);
    }
    if ((string)($meta['purpose'] ?? '') !== (string)$purpose) {
        sendError('Upload session purpose mismatch.', 400);
    }

    $received = (int)($meta['received'] ?? 0);
    $fileSize = (int)($meta['file_size'] ?? 0);
    $dir = chunkUploadSessionDir($uploadId);
    $partPath = $dir . DIRECTORY_SEPARATOR . 'data.part';
    clearstatcache(true, $partPath);
    $actual = is_file($partPath) ? (int)filesize($partPath) : 0;
    if ($received < $fileSize || $actual < $fileSize) {
        sendError('Upload is incomplete (' . $actual . ' of ' . $fileSize . ' bytes). Retry to continue.', 400);
    }

    return [$partPath, $meta, $uploadId];
}
