<?php
/**
 * ALTCHA bootstrap
 *
 * Loads the bundled ALTCHA PHP library and exposes helpers used by
 * challenge/verification endpoints.
 */

if (!defined('ALTCHA_BOOTSTRAP_LOADED')) {
    define('ALTCHA_BOOTSTRAP_LOADED', true);

    spl_autoload_register(function ($className) {
        $prefix = 'AltchaOrg\\Altcha\\';
        if (strpos($className, $prefix) !== 0) {
            return;
        }

        $relative = substr($className, strlen($prefix));
        $relativePath = str_replace('\\', DIRECTORY_SEPARATOR, $relative) . '.php';
        $fullPath = __DIR__ . DIRECTORY_SEPARATOR . 'lib' . DIRECTORY_SEPARATOR . 'altcha' . DIRECTORY_SEPARATOR . $relativePath;

        if (is_file($fullPath)) {
            require_once $fullPath;
        }
    });
}

/**
 * Resolve a persistent HMAC key used by ALTCHA.
 * Priority:
 * 1) ALTCHA_HMAC_KEY env var
 * 2) Local generated key file
 */
function getAltchaHmacKey() {
    static $resolved = null;
    if ($resolved !== null) {
        return $resolved;
    }

    $fromEnv = trim((string)(getenv('ALTCHA_HMAC_KEY') ?: ''));
    if ($fromEnv !== '') {
        $resolved = $fromEnv;
        return $resolved;
    }

    $keyFile = __DIR__ . DIRECTORY_SEPARATOR . '.altcha_hmac_key';
    if (is_file($keyFile) && is_readable($keyFile)) {
        $existing = trim((string)file_get_contents($keyFile));
        if ($existing !== '') {
            $resolved = $existing;
            return $resolved;
        }
    }

    try {
        $generated = bin2hex(random_bytes(32));
    } catch (Throwable $e) {
        $generated = hash('sha256', __FILE__ . '|' . microtime(true) . '|' . mt_rand());
    }

    // Best effort persistence so existing challenges remain valid across requests.
    @file_put_contents($keyFile, $generated, LOCK_EX);
    if (function_exists('chmod')) {
        @chmod($keyFile, 0600);
    }

    $resolved = $generated;
    return $resolved;
}

/**
 * Create an ALTCHA service instance.
 * @return \AltchaOrg\Altcha\Altcha
 */
function createAltchaService() {
    $hmacKey = getAltchaHmacKey();
    return new \AltchaOrg\Altcha\Altcha($hmacKey);
}

/**
 * Verify an ALTCHA payload string from the client widget.
 * @param mixed $payload
 * @return bool
 */
function verifyAltchaPayload($payload) {
    $raw = trim((string)$payload);
    if ($raw === '') {
        return false;
    }

    try {
        $altcha = createAltchaService();
        return $altcha->verifySolution($raw, true);
    } catch (Throwable $e) {
        error_log('ALTCHA verify failed: ' . $e->getMessage());
        return false;
    }
}

/**
 * Normalize an ALTCHA scope token used to bind challenges to a session context.
 * @param mixed $scope
 * @return string
 */
function normalizeAltchaScope($scope) {
    $clean = strtolower(trim((string)$scope));
    $clean = preg_replace('/[^a-z0-9_-]+/', '', $clean);
    return $clean !== '' ? $clean : 'default';
}

/**
 * Return a stable per-session binding token for the given ALTCHA scope.
 * @param mixed $scope
 * @return string
 */
function getAltchaSessionBinding($scope = 'default') {
    $scopeKey = normalizeAltchaScope($scope);

    if (!isset($_SESSION['altcha_session_bindings']) || !is_array($_SESSION['altcha_session_bindings'])) {
        $_SESSION['altcha_session_bindings'] = [];
    }

    $bindings = &$_SESSION['altcha_session_bindings'];
    if (empty($bindings[$scopeKey]) || !is_string($bindings[$scopeKey])) {
        try {
            $bindings[$scopeKey] = bin2hex(random_bytes(16));
        } catch (Throwable $e) {
            $bindings[$scopeKey] = hash('sha256', $scopeKey . '|' . microtime(true) . '|' . mt_rand());
        }
    }

    return (string)$bindings[$scopeKey];
}

/**
 * Build signed challenge parameters for a specific session scope.
 * @param mixed $scope
 * @return array<string, string>
 */
function getAltchaChallengeParams($scope = 'default') {
    $scopeKey = normalizeAltchaScope($scope);

    return [
        'altcha_scope' => $scopeKey,
        'altcha_session' => getAltchaSessionBinding($scopeKey),
    ];
}

/**
 * Decode an ALTCHA payload from the client into its JSON structure.
 * @param mixed $payload
 * @return array<string, mixed>|null
 */
function decodeAltchaPayload($payload) {
    $raw = trim((string)$payload);
    if ($raw === '') {
        return null;
    }

    $decoded = base64_decode($raw, true);
    if ($decoded === false || $decoded === '') {
        return null;
    }

    $data = json_decode($decoded, true);
    if (!is_array($data) || empty($data)) {
        return null;
    }

    return $data;
}

/**
 * Check whether an ALTCHA payload is bound to the current PHP session for the given scope.
 * @param mixed $payload
 * @param mixed $scope
 * @return bool
 */
function isAltchaPayloadBoundToScope($payload, $scope = 'default') {
    $data = decodeAltchaPayload($payload);
    if (!$data || !isset($data['salt']) || !is_string($data['salt'])) {
        return false;
    }

    $saltParts = explode('?', $data['salt'], 2);
    if (count($saltParts) < 2) {
        return false;
    }

    parse_str($saltParts[1], $params);
    $expectedScope = normalizeAltchaScope($scope);
    $actualScope = normalizeAltchaScope($params['altcha_scope'] ?? '');
    $actualBinding = trim((string)($params['altcha_session'] ?? ''));
    $expectedBinding = getAltchaSessionBinding($expectedScope);

    return $actualScope === $expectedScope
        && $actualBinding !== ''
        && hash_equals($expectedBinding, $actualBinding);
}
