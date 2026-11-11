<?php
/** Railway health check: confirms PHP/Apache and the configured database. */
require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    echo json_encode(['success' => false, 'message' => 'Method not allowed.']);
    exit;
}

$connection = getDBConnection();
try {
    if ($connection instanceof mysqli) {
        $connection->query('SELECT 1');
    } elseif (is_object($connection) && method_exists($connection, 'query')) {
        $connection->query('SELECT 1');
    } else {
        throw new RuntimeException('Database driver is not available.');
    }

    closeDBConnection($connection);
    http_response_code(200);
    echo json_encode(['success' => true, 'status' => 'ok', 'database' => 'ok']);
} catch (Throwable $e) {
    $requestId = (string)($GLOBALS['LLB_API_REQUEST_ID'] ?? 'unknown');
    error_log('[request:' . $requestId . '] Health database check failed: ' . $e->getMessage());
    closeDBConnection($connection);
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'status' => 'unavailable',
        'message' => 'The database health check failed.',
        'request_id' => $requestId,
    ], JSON_UNESCAPED_SLASHES);
}
