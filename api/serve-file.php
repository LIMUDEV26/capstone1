<?php
/**
 * serve-file.php — Authenticated file proxy for the uploads/ directory.
 *
 * All uploaded files (signed contracts, profile photos, task submissions, etc.)
 * are stored outside web-accessible paths and served exclusively through this
 * script, which enforces authentication before streaming the file.
 *
 * Usage: GET /api/serve-file.php?path=signed-contracts/foo.pdf
 *
 * The `path` query parameter must be a relative path underneath the uploads/
 * directory. Any attempt to traverse outside that directory (e.g. ../../etc)
 * is rejected with 400.
 *
 * Authentication:
 *   - Requires an active session (any role: admin / manager / staff).
 *   - Profile photos are the only exception: an authenticated user may only
 *     view their own photo unless they hold an admin or manager role.
 */

require_once __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
// setCORSHeaders() intentionally not called — this is a file endpoint, not JSON.
// Session already started by config.php.

// ── 1. Authentication ────────────────────────────────────────────────────────
if (empty($_SESSION['user_id'])) {
    http_response_code(401);
    header('Content-Type: application/json; charset=UTF-8');
    exit(json_encode(['success' => false, 'message' => 'Not authenticated']));
}

$sessionUserId = (int)$_SESSION['user_id'];
$sessionRole   = strtolower(trim((string)($_SESSION['role'] ?? '')));

// Auth snapshot above is everything this endpoint needs from the session.
// Drop the lock now so slow file streams never block the rest of the app.
if (session_status() === PHP_SESSION_ACTIVE) {
    @session_write_close();
}

// ── 2. Path validation ───────────────────────────────────────────────────────
$rawPath = trim((string)($_GET['path'] ?? ''));
if ($rawPath === '') {
    http_response_code(400);
    header('Content-Type: application/json; charset=UTF-8');
    exit(json_encode(['success' => false, 'message' => 'Missing path parameter']));
}

// Normalise and reject traversal attempts.
// realpath() would resolve symlinks too — we do a string-level check first
// because the file may not exist yet when the check runs.
$normalised = str_replace('\\', '/', $rawPath);
// Reject any component that is ".." or starts with "/"
if (preg_match('#(^|/)\.\.(/|$)#', $normalised) || str_starts_with($normalised, '/')) {
    http_response_code(400);
    header('Content-Type: application/json; charset=UTF-8');
    exit(json_encode(['success' => false, 'message' => 'Invalid path']));
}

// Older records store paths from the application root (uploads/foo.pdf),
// while this endpoint is rooted inside uploads/. Accept both representations
// without ever allowing the resolved path to leave the uploads directory.
if (str_starts_with(strtolower($normalised), 'uploads/')) {
    $normalised = substr($normalised, strlen('uploads/'));
}

// Build absolute path and confirm it stays inside uploads/
$uploadsRoot = realpath(__DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'uploads');
if ($uploadsRoot === false) {
    http_response_code(500);
    exit('Upload directory not found');
}

$absPath = realpath($uploadsRoot . DIRECTORY_SEPARATOR . $normalised);
if ($absPath === false || strpos($absPath, $uploadsRoot . DIRECTORY_SEPARATOR) !== 0) {
    http_response_code(403);
    header('Content-Type: application/json; charset=UTF-8');
    exit(json_encode(['success' => false, 'message' => 'Forbidden']));
}

if (!is_file($absPath)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=UTF-8');
    exit(json_encode(['success' => false, 'message' => 'File not found']));
}

// ── 3. Role-based access for profile photos ──────────────────────────────────
// Staff may only view their own profile photo.
$isPrivileged = in_array($sessionRole, ['admin', 'manager'], true);
if (!$isPrivileged && str_starts_with($normalised, 'profile-photos/')) {
    // Resolve the owner from the DB.
    $conn = getDBConnection();
    $photoFilename = basename($absPath);
    $stmt = $conn->prepare("SELECT id FROM users WHERE photo LIKE ? LIMIT 1");
    $likeParam = '%' . $photoFilename;
    $stmt->bind_param('s', $likeParam);
    $stmt->execute();
    $owner = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    closeDBConnection($conn);

    if (!$owner || (int)$owner['id'] !== $sessionUserId) {
        http_response_code(403);
        header('Content-Type: application/json; charset=UTF-8');
        exit(json_encode(['success' => false, 'message' => 'Forbidden']));
    }
}

// ── 4. Determine MIME type ────────────────────────────────────────────────────
$mimeMap = [
    'pdf'  => 'application/pdf',
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png'  => 'image/png',
    'gif'  => 'image/gif',
    'webp' => 'image/webp',
    'doc'  => 'application/msword',
    'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls'  => 'application/vnd.ms-excel',
    'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt'  => 'text/plain',
    'zip'  => 'application/zip',
];

$ext  = strtolower(pathinfo($absPath, PATHINFO_EXTENSION));
$mime = $mimeMap[$ext] ?? 'application/octet-stream';

// ── 5. Stream the file ────────────────────────────────────────────────────────
$filename = basename($absPath);
$size     = filesize($absPath);

header('Content-Type: ' . $mime);
header('Content-Length: ' . $size);
// Use inline for images/PDFs (viewer), attachment for everything else.
$inlineTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
$disposition = in_array($mime, $inlineTypes, true) ? 'inline' : 'attachment';
header('Content-Disposition: ' . $disposition . '; filename="' . addslashes($filename) . '"');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');
// Phase 1.2/1.3: uploaded files are attacker-influenced content. Even though
// only PDFs pass validation today, serve them under a policy that neutralises
// script execution in case a permissive type ever slips through.
//
// Deliberately NOT using the CSP `sandbox` directive: it would apply full iframe
// sandbox flags to this response and can stop the browser's native PDF viewer
// from rendering, which would break DocumentPreviewModal. object-src stays
// 'self' for the same reason — PDF rendering must keep working.
header("Content-Security-Policy: default-src 'none'; script-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
header('X-Frame-Options: SAMEORIGIN');
header('Cross-Origin-Resource-Policy: same-site');
header_remove('X-Powered-By');

readfile($absPath);
exit();
