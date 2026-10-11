<?php
/**
 * hCaptcha API - Server-side token validation
 */

require_once 'config.php';
require_once 'utils.php';
// Captcha verification writes session state — keep the session lock.
$GLOBALS['LLB_KEEP_SESSION_LOCK'] = true;

const CAPTCHA_VERIFICATION_TTL_SECONDS = 120;

setCORSHeaders();

$conn = getDBConnection();
$method = getRequestMethod();
$action = $_GET['action'] ?? '';

if ($method === 'POST' && $action === 'hcaptcha_verify') {
    verifyHcaptchaCaptcha();
} else {
    sendError('Invalid action', 400);
}

function clearCaptchaVerification(): void {
    unset($_SESSION['captcha_verified']);
}

function requirePendingLogin(): array {
    $pending = $_SESSION['pending_login'] ?? null;
    if (!is_array($pending)) {
        clearCaptchaVerification();
        sendError('Login session expired. Enter your email and password again.', 400);
    }

    $validUntil = (int)($pending['valid_until'] ?? 0);
    $browserId = (string)($pending['browser_id'] ?? '');
    $currentBrowserId = function_exists('getIntruderBrowserIdentifier')
        ? (string)getIntruderBrowserIdentifier()
        : '';

    if (
        $validUntil <= time()
        || $browserId === ''
        || $currentBrowserId === ''
        || !hash_equals($browserId, $currentBrowserId)
    ) {
        unset($_SESSION['pending_login']);
        clearCaptchaVerification();
        sendError('Login session expired. Enter your email and password again.', 400);
    }

    return $pending;
}

function getLoginFailureLockoutConfig($conn): array {
    $cfg = [
        'lockout_enabled' => '1',
        'lockout_window_hours' => '24',
    ];

    $stmt = $conn->prepare(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('lockout_enabled','lockout_window_hours')"
    );
    if ($stmt) {
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            $cfg[$row['setting_key']] = $row['setting_value'];
        }
        $stmt->close();
    }

    return [
        'enabled' => ($cfg['lockout_enabled'] ?? '1') === '1',
        'window_hours' => max(1, (int)($cfg['lockout_window_hours'] ?? 24)),
    ];
}

function recordPendingLoginFailure($conn, int $userId): array {
    if ($userId <= 0) {
        return [
            'status' => 'disabled',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => null,
        ];
    }

    $policy = getLoginFailureLockoutConfig($conn);
    if (!$policy['enabled']) {
        return [
            'status' => 'disabled',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => null,
        ];
    }

    // Per-role threshold from the Account Lockout settings page
    // (lockout_threshold_manager / lockout_threshold_staff), with a generic fallback.
    $threshold = getLockoutThresholdForRole($conn, $user['role'] ?? null);
    $windowHours = (int)$policy['window_hours'];

    $stmt = $conn->prepare(
        "SELECT id, status, role, reset_request_count, reset_request_window_start
         FROM users
         WHERE id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        sendError('Failed to update login attempt state.', 500);
    }
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$user) {
        return [
            'status' => 'disabled',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => $threshold,
        ];
    }

    if (strtolower(trim($user['role'] ?? '')) === 'admin') {
        return [
            'status' => 'admin_exempt',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => null,
        ];
    }

    if (($user['status'] ?? '') === 'locked') {
        return [
            'status' => 'locked',
            'failed_attempts' => (int)($user['reset_request_count'] ?? $threshold),
            'remaining_attempts' => 0,
            'threshold' => $threshold,
        ];
    }

    $count = (int)($user['reset_request_count'] ?? 0);
    $windowStart = $user['reset_request_window_start'] ?? null;

    if (!$windowStart || (strtotime((string)$windowStart) + ($windowHours * 3600)) < time()) {
        $count = 0;
        $windowStart = date('Y-m-d H:i:s');
    }

    $count++;
    $cooldownStartAttempt = getLockoutCooldownStartAttempt($conn);
    $retryDelaySeconds = getLockoutRetryDelaySeconds($conn);
    $cooldownEnabled = $retryDelaySeconds > 0 && $cooldownStartAttempt > 0;
    $effectiveLockThreshold = $threshold;
    if ($cooldownEnabled && $cooldownStartAttempt <= $threshold) {
        $maxCooldownAttempts = getLockoutMaxCooldownAttempts($conn);
        $effectiveLockThreshold = $threshold + max(1, $maxCooldownAttempts);
    }
    $remainingAttempts = max(0, $threshold - $count);

    // Cooldown takes precedence over immediate lock — user gets a wait first
    // beyond the configured threshold, and only the next failure beyond that locks.
    if ($cooldownEnabled && $count >= $cooldownStartAttempt && $count < $effectiveLockThreshold) {
        ensureLockoutCooldownColumn($conn);
        $cooldownUntil = date('Y-m-d H:i:s', time() + $retryDelaySeconds);
        $cdStmt = $conn->prepare(
            "UPDATE users SET reset_request_count = ?, reset_request_window_start = ?, lockout_cooldown_until = ? WHERE id = ?"
        );
        if ($cdStmt) {
            $cdStmt->bind_param('issi', $count, $windowStart, $cooldownUntil, $userId);
            $cdStmt->execute();
            $cdStmt->close();
        }

        return [
            'status' => 'cooldown',
            'failed_attempts' => $count,
            'remaining_attempts' => $remainingAttempts,
            'threshold' => $threshold,
            'retry_after_seconds' => $retryDelaySeconds,
        ];
    }

    if ($count >= $effectiveLockThreshold) {
        $lockStmt = $conn->prepare(
            "UPDATE users SET status = 'locked', reset_request_count = ?, reset_request_window_start = ? WHERE id = ?"
        );
        if ($lockStmt) {
            $lockStmt->bind_param('isi', $count, $windowStart, $userId);
            $lockStmt->execute();
            $lockStmt->close();
        }

        logActivity(
            $conn,
            $userId,
            'account_locked',
            "Account locked after {$count} failed login or captcha attempts (threshold: {$threshold})",
            'security'
        );

        return [
            'status' => 'locked',
            'failed_attempts' => $count,
            'remaining_attempts' => 0,
            'threshold' => $threshold,
        ];
    }

    $updateStmt = $conn->prepare(
        "UPDATE users SET reset_request_count = ?, reset_request_window_start = ? WHERE id = ?"
    );
    if ($updateStmt) {
        $updateStmt->bind_param('isi', $count, $windowStart, $userId);
        $updateStmt->execute();
        $updateStmt->close();
    }

    return [
        'status' => 'ok',
        'failed_attempts' => $count,
        'remaining_attempts' => $remainingAttempts,
        'threshold' => $threshold,
    ];
}

function rejectHcaptchaAttempt(array $pending, string $baseMessage, int $statusCode = 400): void {
    global $conn;

    $lockoutResult = recordPendingLoginFailure($conn, (int)($pending['user_id'] ?? 0));
    if (($lockoutResult['status'] ?? '') === 'locked') {
        sendError('Your account has been locked due to too many failed login or captcha attempts. Please contact an administrator.', 403);
    }

    if (($lockoutResult['status'] ?? '') === 'cooldown') {
        $waitSeconds = (int)($lockoutResult['retry_after_seconds'] ?? 0);
        sendError(
            "Too many request, please try again after {$waitSeconds} seconds.",
            429,
            [
                'retry_after_seconds' => $waitSeconds,
                'failed_attempts' => (int)($lockoutResult['failed_attempts'] ?? 0),
            ]
        );
    }

    $message = $baseMessage;
    $remaining = $lockoutResult['remaining_attempts'] ?? null;
    if (is_int($remaining) && $remaining > 0) {
        $label = $remaining === 1 ? 'attempt' : 'attempts';
        $message .= " {$remaining} {$label} remaining before account lock.";
    }

    sendError($message, $statusCode);
}

function verifyHcaptchaCaptcha(): void {
    $pending = requirePendingLogin();
    $data = getJSONInput();
    $token = trim((string)($data['token'] ?? ''));
    $dismissed = !empty($data['dismissed']);

    if ($dismissed) {
        rejectHcaptchaAttempt($pending, 'CAPTCHA was dismissed. Start the login process again to continue.');
    }

    if ($token === '') {
        rejectHcaptchaAttempt($pending, 'CAPTCHA token is missing. Refresh and try again.');
    }

    $siteKey = getHcaptchaSiteKey();
    $secret = getHcaptchaSecret();

    if ($siteKey === '' || $secret === '') {
        rejectHcaptchaAttempt($pending, 'CAPTCHA service is not configured. Contact an administrator.', 503);
    }

    $ch = curl_init('https://api.hcaptcha.com/siteverify');
    if ($ch === false) {
        rejectHcaptchaAttempt($pending, 'CAPTCHA verification service unavailable.', 503);
    }

    $postData = http_build_query([
        'secret' => $secret,
        'response' => $token,
        'sitekey' => $siteKey,
        'remoteip' => $_SERVER['REMOTE_ADDR'] ?? '',
    ]);

    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $postData,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CONNECTTIMEOUT => 5,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $curlError !== '') {
        rejectHcaptchaAttempt($pending, 'CAPTCHA verification service unreachable.', 503);
    }

    $result = json_decode($response, true);
    if (!is_array($result) || empty($result['success'])) {
        $errorCodes = isset($result['error-codes']) ? implode(', ', $result['error-codes']) : '';
        rejectHcaptchaAttempt($pending, 'CAPTCHA verification failed.' . ($errorCodes ? " ($errorCodes)" : ''), 400);
    }

    $_SESSION['captcha_verified'] = [
        'timestamp' => time(),
        'valid_until' => time() + CAPTCHA_VERIFICATION_TTL_SECONDS,
        'method' => 'hcaptcha',
    ];

    sendResponse(true, [
        'success' => true,
    ], 'CAPTCHA verified!');
}
