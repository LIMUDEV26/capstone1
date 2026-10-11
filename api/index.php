<?php

// Vercel exposes this one file as the PHP function. All legacy endpoints are
// routed through it so the project stays below the Hobby function limit.
$endpoint = trim((string)($_GET['endpoint'] ?? ''), '/');
if ($endpoint === '' || !preg_match('/^[A-Za-z0-9_-]+\.php$/', $endpoint)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'message' => 'API endpoint not found']);
    exit;
}

$blocked = ['index.php', 'config.php', 'utils.php', 'mailer.php', 'pg_compat.php', 'password_policy_utils.php', 'chunked_upload_utils.php', 'edit_request_utils.php', 'renewal_utils.php'];
if (in_array($endpoint, $blocked, true)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'message' => 'API endpoint not found']);
    exit;
}

$target = __DIR__ . DIRECTORY_SEPARATOR . $endpoint;
if (!is_file($target)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'message' => 'API endpoint not found']);
    exit;
}

unset($_GET['endpoint']);
chdir(__DIR__);
require $target;

