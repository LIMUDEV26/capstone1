<?php
/**
 * Authentication API
 * Handles user login, logout, and session management
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';
require_once 'password_policy_utils.php';
// Multi-step auth flows write session state throughout the request
// (login identity, reset codes, captcha) — keep the session lock.
$GLOBALS['LLB_KEEP_SESSION_LOCK'] = true;

// Session is started by config.php
const LOGIN_AUTO_CHECK_MIN_DELAY_MS = 0;
const LOGIN_AUTO_CHECK_MAX_DELAY_MS = 0;
const LOGIN_CUSTOM_CAPTCHA_DELAY_MS = 10000;
const LOGIN_SUSPICIOUS_RISK_THRESHOLD_DEFAULT = 3;
const LOGIN_NETWORK_RTT_UNSTABLE_MS = 1200;
const LOGIN_NETWORK_MIN_DOWNLINK_MBPS = 0.7;
const LOGIN_SERVER_CONNECTIVITY_TIMEOUT_SECONDS = 0.05;
const LOGIN_OTP_TTL_SECONDS = 600;      // login code + pending-session validity once a code is issued
const LOGIN_OTP_MAX_ATTEMPTS = 5;       // wrong-code tries before the login attempt is discarded
const LOGIN_OTP_RESEND_SECONDS = 30;    // min wait between code sends
// Data-deletion step-up code. Every request rotates the code, so a burst of
// clicks silently invalidates the code the admin is about to read from the
// email. Throttle resends like the login OTP does.
const DATA_DELETION_CODE_RESEND_SECONDS = 30;
// Server math-image captcha limits. Declared up here (before the dispatch
// switch below) so they are registered before any handler exits. The
// humanity-proof window matches the OTP window; password brute force stays
// lockout-guarded and challenges stay single-use.
const MATH_IMAGE_MAX_FAILURES = 5;
const MATH_IMAGE_FAIL_BLOCK_SECONDS = 60;
const MATH_IMAGE_VERIFIED_TTL_SECONDS = 600;

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

// Keep auth/session queries compatible with older schemas.
ensureAuthRuntimeSchema($conn);

switch ($method) {
    case 'POST':
        $action = $_GET['action'] ?? 'login';
        if ($action === 'login') {
            handleLogin($conn);
        } elseif ($action === 'login_precheck') {
            handleLoginPrecheck($conn);
        } elseif ($action === 'login_complete') {
            handleLoginComplete($conn);
        } elseif ($action === 'math_verify') {
            handleMathVerify($conn);
        } elseif ($action === 'login_verify_otp') {
            handleLoginVerifyOtp($conn);
        } elseif ($action === 'login_request_otp') {
            handleLoginRequestOtp($conn);
        } elseif ($action === 'logout') {
            handleLogout($conn);
        } elseif ($action === 'session_takeover') {
            handleSessionTakeover($conn);
        } elseif ($action === 'login_decision') {
            handleLoginDecision($conn);
        } elseif ($action === 'login_cancel') {
            handleLoginCancel($conn);
        } elseif ($action === 'register') {
            handleRegister($conn);
        } elseif ($action === 'forgot_password') {
            handleForgotPassword($conn);
        } elseif ($action === 'forgot_password_totp') {
            handleForgotPasswordTOTP($conn);
        } elseif ($action === 'forgot_password_verify_totp') {
            handleForgotPasswordVerifyTOTP($conn);
        } elseif ($action === 'forgot_password_verify_email_code') {
            handleForgotPasswordVerifyEmailCode($conn);
        } elseif ($action === 'reset_password') {
            handleResetPassword($conn);
        } elseif ($action === 'first_login_change_password') {
            handleFirstLoginChangePassword($conn);
        } elseif ($action === 'admin_update_profile') {
            handleAdminUpdateProfile($conn);
        } elseif ($action === 'password_policy') {
            handlePasswordPolicy($conn);
        } elseif ($action === 'update_password_policy') {
            handleUpdatePasswordPolicy($conn);
        } elseif ($action === 'request_password_change_otp') {
            handleRequestPasswordChangeOTP($conn);
        } elseif ($action === 'change_password_with_otp') {
            handleChangePasswordWithOTP($conn);
        } elseif ($action === 'totp_pair') {
            handleTOTPpair($conn);
        } elseif ($action === 'totp_validate') {
            handleTOTPvalidate($conn);
        } elseif ($action === 'change_password_with_totp') {
            handleChangePasswordWithTOTP($conn);
        } elseif ($action === 'admin_verify_dashboard_pin') {
            handleAdminVerifyDashboardPin($conn);
        } elseif ($action === 'admin_update_dashboard_pin') {
            handleAdminUpdateDashboardPin($conn);
        } elseif ($action === 'data_deletion_request_code') {
            handleDataDeletionRequestCode($conn);
        } elseif ($action === 'data_deletion_verify_code') {
            handleDataDeletionVerifyCode($conn);
        } else {
            sendError('Invalid action', 400);
        }
        break;
    case 'GET':
        $getAction = $_GET['action'] ?? 'session';
        if ($getAction === 'math_challenge') {
            handleMathChallenge($conn);
        } elseif ($getAction === 'totp_status') {
            handleTOTPStatus($conn);
        } elseif ($getAction === 'lockdown_status') {
            handlePublicLockdownStatus($conn);
        } elseif ($getAction === 'session_status') {
            handleSessionStatus($conn);
        } elseif ($getAction === 'login_await') {
            handleLoginAwait($conn);
        } elseif ($getAction === 'data_deletion_access_status') {
            handleDataDeletionAccessStatus($conn);
        } elseif ($getAction === 'password_policy') {
            handlePasswordPolicy($conn);
        } else {
            handleCheckSession($conn);
        }
        break;
    default:
        sendError('Method not allowed', 405);
}

/**
 * Safely add a column to a table if it does not already exist.
 * Avoids mysqli_sql_exception on duplicate column in PHP 8.x strict mode.
 */
function ensureColumn($conn, $table, $column, $definition) {
    if (isPostgresConnection($conn)) return;
    $db = DB_NAME;
    $check = $conn->prepare(
        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1"
    );
    $check->bind_param('sss', $db, $table, $column);
    $check->execute();
    $exists = $check->get_result()->num_rows > 0;
    $check->close();
    if (!$exists) {
        $conn->query("ALTER TABLE `$table` ADD COLUMN $definition");
    }
}

function ensureAuthSchema($conn) {
    ensureColumn($conn, 'users', 'must_reset_password', 'must_reset_password TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'reset_token_hash', 'reset_token_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'reset_token_expires', 'reset_token_expires DATETIME NULL');
    ensureColumn($conn, 'users', 'reset_request_count', 'reset_request_count INT DEFAULT 0');
    ensureColumn($conn, 'users', 'reset_request_window_start', 'reset_request_window_start DATETIME NULL');
    ensureColumn($conn, 'users', 'password_change_otp_hash', 'password_change_otp_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'password_change_otp_expires', 'password_change_otp_expires DATETIME NULL');
    ensureColumn($conn, 'users', 'forgot_admin_email_code_hash', 'forgot_admin_email_code_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'forgot_admin_email_code_expires', 'forgot_admin_email_code_expires DATETIME NULL');
    ensureColumn($conn, 'users', 'lockout_cooldown_until', 'lockout_cooldown_until DATETIME NULL');
    ensureColumn($conn, 'users', 'fp_request_count', 'fp_request_count INT NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'fp_window_start', 'fp_window_start DATETIME NULL');
    // Data-deletion step-up code: last send time (resend throttle) and the
    // mailer's verdict for that send, so the UI can stop claiming success for
    // an email that never went out.
    ensureColumn($conn, 'users', 'data_deletion_code_sent_at', 'data_deletion_code_sent_at DATETIME NULL');
    ensureColumn($conn, 'users', 'data_deletion_code_send_ok', 'data_deletion_code_send_ok TINYINT(1) NULL');
    if (function_exists('ensureUserStatusEnum')) {
        ensureUserStatusEnum($conn);
    }
}

function ensureAuthRuntimeSchema($conn) {
    if (isPostgresConnection($conn)) return;
    ensureAuthSchema($conn);
    ensurePasswordPolicySchema($conn);
}

function setActiveSessionUserFromRecord($user, $mustResetPassword = false) {
    $userId = intval($user['id'] ?? 0);
    if ($userId <= 0) {
        sendError('Invalid user session data', 500);
    }

    // Prevent session fixation: regenerate session ID on every identity switch.
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_regenerate_id(true);
    }

    $employeeId = isset($user['employee_id']) && $user['employee_id'] !== '' ? intval($user['employee_id']) : null;
    $branchId = isset($user['branch_id']) && $user['branch_id'] !== '' ? intval($user['branch_id']) : null;
    $role = strtolower(trim((string)($user['role'] ?? '')));

    $_SESSION['user_id'] = $userId;
    $_SESSION['username'] = (string)($user['username'] ?? '');
    $_SESSION['role'] = $role;
    $_SESSION['employee_id'] = $employeeId;
    $_SESSION['branch_id'] = $branchId;
    $_SESSION['must_reset_password'] = $mustResetPassword ? 1 : 0;
    $_SESSION['password_change_reason'] = $mustResetPassword ? getPasswordChangeReasonForUser($user) : '';
    $_SESSION['session_started_at'] = time();
    $_SESSION['last_activity_at'] = time();

    // Security-sensitive approval should always be re-verified after identity switches.
    clearDataDeletionAccessSession();
}

function getRoleDashboardPath($role) {
    $normalizedRole = strtolower(trim((string)$role));
    if ($normalizedRole === 'admin') return '/admin/dashboard';
    if ($normalizedRole === 'manager') return '/manager/dashboard';
    return '/dashboard';
}

function fetchAuthUserForSessionSwitch($conn, $userId) {
    $id = intval($userId);
    if ($id <= 0) return null;

    $stmt = $conn->prepare(
        "SELECT id, username, role, status, employee_id, branch_id, must_reset_password, first_name, last_name, password_changed_at, password_expires_at
         FROM users
         WHERE id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        sendError('Failed to fetch account for session switch', 500);
    }
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $user ?: null;
}

function normalizePersonName($value, $maxLen = 50) {
    $str = trim((string)$value);
    if ($str === '') return '';
    $str = preg_replace('/\s+/', ' ', $str);
    $str = sanitizeInput($str);
    if (strlen($str) > $maxLen) $str = substr($str, 0, $maxLen);
    return $str;
}

function ensureUniqueUserFullName($conn, $firstName, $lastName, $excludeUserId = null) {
    $first = normalizePersonName($firstName, 50);
    $last = normalizePersonName($lastName, 50);
    if ($first === '' || $last === '') return;

    if ($excludeUserId !== null) {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
               AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
               AND id <> ?
             LIMIT 1"
        );
        $id = intval($excludeUserId);
        $stmt->bind_param('ssi', $first, $last, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT id
             FROM users
             WHERE LOWER(TRIM(first_name)) = LOWER(TRIM(?))
               AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        $stmt->bind_param('ss', $first, $last);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('A user with the same first name and last name already exists.', 409);
    }
}

function normalizeEmailIdentifier($value) {
    $email = strtolower(trim((string)$value));
    if ($email === '') return '';
    return sanitizeInput(collapseDuplicatedComTld($email));
}

function normalizeLoginIdentifier($value) {
    $identifier = strtolower(trim((string)$value));
    if ($identifier === '') return '';
    return sanitizeInput(collapseDuplicatedComTld($identifier));
}

/**
 * Collapse a duplicated trailing ".com" TLD caused by a typing typo
 * (e.g. "name@gmail.com.com" → "name@gmail.com").
 * No account in this system uses a genuine ".com.com" domain, so treating the
 * doubled suffix as a typo is safe and prevents confusing
 * "Invalid email or password" failures for accounts that are actually correct.
 * @param string $value
 * @return string
 */
function collapseDuplicatedComTld($value) {
    $collapsed = preg_replace('/(\.com)+\.com$/', '.com', $value);
    return is_string($collapsed) ? $collapsed : $value;
}

function parseNullablePositiveInt($value) {
    if (!isset($value) || $value === '') return null;
    if (!is_numeric($value)) return null;
    $n = intval($value);
    return $n > 0 ? $n : null;
}

function assertBranchExistsForRegister($conn, $branchId) {
    $id = intval($branchId);
    if ($id <= 0) sendError('Invalid branch ID', 400);

    $stmt = $conn->prepare("SELECT branch_id FROM branches WHERE branch_id = ? LIMIT 1");
    if (!$stmt) sendError('Failed to validate branch', 500);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        sendError('Selected branch not found', 404);
    }
}

function assertManagerBranchAvailabilityForRegister($conn, $role, $branchId) {
    $normalizedRole = strtolower(trim((string)$role));
    $resolvedBranchId = parseNullablePositiveInt($branchId);

    if ($normalizedRole !== 'manager' || $resolvedBranchId === null) {
        return;
    }

    assertBranchExistsForRegister($conn, $resolvedBranchId);

    $stmt = $conn->prepare(
        "SELECT id
         FROM users
         WHERE LOWER(TRIM(role)) = 'manager'
           AND branch_id = ?
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to validate branch manager assignment', 500);
    $stmt->bind_param('i', $resolvedBranchId);
    $stmt->execute();
    $hasExistingManager = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($hasExistingManager) {
        sendError('This branch already has a manager assigned. Only one manager is allowed per branch.', 409);
    }
}

function buildUsernameBaseFromEmail($email) {
    $normalized = normalizeEmailIdentifier($email);
    if ($normalized === '') return 'user';

    $localPart = $normalized;
    $atPos = strpos($normalized, '@');
    if ($atPos !== false) {
        $localPart = substr($normalized, 0, $atPos);
    }

    $base = preg_replace('/[^a-z0-9._-]/', '', strtolower($localPart));
    $base = trim((string)$base, '._-');
    if ($base === '') $base = 'user';
    if (strlen($base) > 42) $base = substr($base, 0, 42);
    return $base;
}

function generateUniqueUsernameFromEmail($conn, $email) {
    $base = buildUsernameBaseFromEmail($email);

    for ($attempt = 0; $attempt < 1000; $attempt++) {
        if ($attempt === 0) {
            $candidate = $base;
        } else {
            $suffix = '_' . (string)$attempt;
            $maxBaseLen = 50 - strlen($suffix);
            if ($maxBaseLen < 1) $maxBaseLen = 1;
            $candidate = substr($base, 0, $maxBaseLen) . $suffix;
        }

        $check = $conn->prepare("SELECT id FROM users WHERE username = ? LIMIT 1");
        if (!$check) {
            sendError('Failed to validate generated username', 500);
        }
        $check->bind_param('s', $candidate);
        $check->execute();
        $exists = $check->get_result()->num_rows > 0;
        $check->close();

        if (!$exists) {
            return $candidate;
        }
    }

    return 'user_' . substr(bin2hex(random_bytes(8)), 0, 12);
}

/**
 * Resolve the client identifier used to bind multi-step login flows.
 *
 * Keyed exclusively on the server-observed IP address — the client-supplied
 * X-Client-Browser-ID header is deliberately not used here because it can be
 * freely rotated by the client.
 */
function getClientBrowserIdentifier() {
    // A PHP session cookie is the stable browser-bound identifier for this
    // short-lived login flow. Reverse proxies and serverless functions can
    // legitimately use a different source IP on every request, so binding a
    // pending login to REMOTE_ADDR would invalidate the next captcha/OTP call.
    $sessionId = session_id();
    if ($sessionId !== '') {
        return 'session_' . substr(hash('sha256', $sessionId), 0, 40);
    }

    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));

    // Honour X-Forwarded-For only when the direct connection is from a local
    // reverse proxy (e.g. ngrok agent running on the same machine).
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
    if ($xff !== '' && isPrivateOrLocalhost($remote)) {
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') {
            $remote = $candidate;
        }
    }

    return 'ip_' . substr(hash('sha256', $remote), 0, 40);
}

/**
 * Return true when $addr is localhost or an RFC-1918 private address.
 * @param string $addr
 * @return bool
 */
function isPrivateOrLocalhost($addr) {
    if ($addr === '127.0.0.1' || $addr === '::1') return true;
    return (bool)preg_match('/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/', $addr);
}

/**
 * Validate and consume recent math captcha verification from session.
 */
function isMathCaptchaVerified() {
    if (!isset($_SESSION['captcha_verified'])) {
        return false;
    }

    $verification = $_SESSION['captcha_verified'];
    $validUntil = intval($verification['valid_until'] ?? 0);

    if ($validUntil <= time()) {
        unset($_SESSION['captcha_verified']);
        return false;
    }

    return true;
}

function clearMathCaptchaVerification() {
    unset($_SESSION['captcha_verified']);
}

function clearPendingLoginSession() {
    unset($_SESSION['pending_login']);
}



/**
 * Math image timeout (seconds) from Captcha Management settings.
 */
function getMathCaptchaTimeoutSeconds($conn) {
    $ttl = 120;
    try {
        $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = 'math_captcha_timeout_seconds' LIMIT 1");
        if ($stmt) {
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            $stmt->close();
            if ($row && isset($row['setting_value'])) {
                $ttl = intval($row['setting_value']);
            }
        }
    } catch (\Throwable $e) {
        // Fall through to default.
    }
    if ($ttl < 10) $ttl = 10;
    if ($ttl > 3600) $ttl = 3600;
    return $ttl;
}

/**
 * Render a single-digit math question as a noisy SVG image (no GD needed).
 * Operands are ints 1-9, operator is '+' or '-'.
 */
function buildMathCaptchaSvg($a, $op, $b) {
    $question = $a . ' ' . $op . ' ' . $b . ' = ?';
    $w = 170;
    $h = 56;
    $palette = ['#1e3a8a', '#0f766e', '#7c2d12', '#3b0764', '#082f49', '#14532d'];
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' . $w . '" height="' . $h . '" viewBox="0 0 ' . $w . ' ' . $h . '">';
    $svg .= '<rect width="' . $w . '" height="' . $h . '" fill="#f1f5f9"/>';
    // Noise dots.
    for ($i = 0; $i < 26; $i++) {
        $cx = random_int(2, $w - 2);
        $cy = random_int(2, $h - 2);
        $r = random_int(1, 2);
        $c = $palette[random_int(0, count($palette) - 1)];
        $svg .= '<circle cx="' . $cx . '" cy="' . $cy . '" r="' . $r . '" fill="' . $c . '" opacity="0.25"/>';
    }
    // Noise strike lines.
    for ($i = 0; $i < 3; $i++) {
        $y1 = random_int(6, $h - 6);
        $y2 = random_int(6, $h - 6);
        $c = $palette[random_int(0, count($palette) - 1)];
        $svg .= '<line x1="4" y1="' . $y1 . '" x2="' . ($w - 4) . '" y2="' . $y2 . '" stroke="' . $c . '" stroke-width="1" opacity="0.35"/>';
    }
    // One glyph per character, jittered + rotated so it is not plain DOM text.
    $chars = preg_split('//u', $question, -1, PREG_SPLIT_NO_EMPTY);
    $x = 12;
    foreach ($chars as $ch) {
        $esc = htmlspecialchars($ch, ENT_QUOTES, 'UTF-8');
        if ($esc === '') $esc = '?';
        $dy = random_int(-4, 4);
        $rot = random_int(-14, 14);
        $c = $palette[random_int(0, count($palette) - 1)];
        $size = $ch === '?' ? 22 : 26;
        $svg .= '<text x="' . $x . '" y="' . (36 + $dy) . '" font-family="monospace" font-size="' . $size . '" font-weight="bold" fill="' . $c . '" transform="rotate(' . $rot . ' ' . $x . ' ' . (36 + $dy) . ')">' . $esc . '</text>';
        $x += ($ch === ' ') ? 10 : 19;
    }
    $svg .= '</svg>';
    return $svg;
}

/**
 * GET - Issue a single-digit math image challenge. Public (login page).
 * Answer stays server-side in session; only the image leaves the server.
 */
function handleMathChallenge($conn) {
    $a = random_int(1, 9);
    $b = random_int(1, 9);
    $op = random_int(0, 1) === 0 ? '+' : '-';
    if ($op === '-' && $b > $a) {
        $tmp = $a;
        $a = $b;
        $b = $tmp;
    }
    try {
        $id = bin2hex(random_bytes(16));
    } catch (\Throwable $e) {
        $id = sha1(uniqid((string)mt_rand(), true));
    }
    $ttl = getMathCaptchaTimeoutSeconds($conn);
    $now = time();
    $challenges = $_SESSION['math_captchas'] ?? [];
    if (!is_array($challenges)) {
        $challenges = [];
    }

    // More than one captcha request can be in flight at once (for example,
    // React remounts or another security form opening in the same session).
    // Keep challenges by id so a newer request cannot invalidate the image
    // that is already visible to the user.
    foreach ($challenges as $challengeId => $challenge) {
        if (!is_array($challenge) || intval($challenge['expires'] ?? 0) <= $now) {
            unset($challenges[$challengeId]);
        }
    }
    if (count($challenges) >= 8) {
        uasort($challenges, static function ($left, $right) {
            return intval($left['expires'] ?? 0) <=> intval($right['expires'] ?? 0);
        });
        while (count($challenges) >= 8) {
            array_shift($challenges);
        }
    }

    $challenges[$id] = [
        'id' => $id,
        'answer' => ($op === '+') ? ($a + $b) : ($a - $b),
        'expires' => $now + $ttl,
    ];
    $_SESSION['math_captchas'] = $challenges;
    // Remove the legacy single-slot value once this session uses the
    // collision-safe challenge store.
    unset($_SESSION['math_captcha']);
    $svg = buildMathCaptchaSvg($a, $op, $b);
    sendResponse(true, [
        'challenge_id' => $id,
        'image' => 'data:image/svg+xml;base64,' . base64_encode($svg),
        'expires_in' => $ttl,
    ], 'Math challenge ready');
}

/**
 * POST - Verify a math image answer. Payload: { challenge_id, answer }.
 * Single-use challenge + failure throttling; sets captcha_verified on success.
 */
function handleMathVerify($conn) {
    $now = time();
    $fails = intval($_SESSION['math_captcha_failures'] ?? 0);
    $blockedUntil = intval($_SESSION['math_captcha_blocked_until'] ?? 0);
    if ($blockedUntil > $now) {
        $wait = $blockedUntil - $now;
        sendError("Too many wrong answers. Try again after {$wait} seconds.", 429, [
            'field' => 'math_answer',
            'code' => 'captcha_locked',
            'retry_after_seconds' => $wait,
        ]);
    }

    $data = getJSONInput();
    $cid = (string)($data['challenge_id'] ?? '');
    $given = trim((string)($data['answer'] ?? ''));
    $stored = null;
    $challenges = $_SESSION['math_captchas'] ?? [];
    if ($cid !== '' && is_array($challenges) && isset($challenges[$cid]) && is_array($challenges[$cid])) {
        $stored = $challenges[$cid];
        // Single-use: consume only the submitted challenge. Other forms or
        // overlapping requests in this browser session remain valid.
        unset($challenges[$cid]);
        $_SESSION['math_captchas'] = $challenges;
    } else {
        // Accept an already-issued legacy challenge during a rolling update.
        $legacy = $_SESSION['math_captcha'] ?? null;
        if (is_array($legacy) && $cid !== '' && hash_equals((string)($legacy['id'] ?? ''), $cid)) {
            $stored = $legacy;
            unset($_SESSION['math_captcha']);
        }
    }

    if (!is_array($stored) || $cid === '' || !hash_equals((string)($stored['id'] ?? ''), $cid)) {
        sendError('Verification expired. A new image was generated.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_expired',
            'refresh' => true,
        ]);
    }
    if (intval($stored['expires'] ?? 0) <= $now) {
        sendError('Time expired — a new image was generated. Try again.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_expired',
            'refresh' => true,
        ]);
    }
    if ($given === '' || !preg_match('/^\d+$/', $given) || intval($given) !== intval($stored['answer'])) {
        $fails++;
        $_SESSION['math_captcha_failures'] = $fails;
        if ($fails >= MATH_IMAGE_MAX_FAILURES) {
            $_SESSION['math_captcha_blocked_until'] = $now + MATH_IMAGE_FAIL_BLOCK_SECONDS;
        }
        sendError('Incorrect answer. A new image was generated — try again.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_invalid',
            'refresh' => true,
        ]);
    }

    $_SESSION['math_captcha_failures'] = 0;
    unset($_SESSION['math_captcha_blocked_until']);
    $_SESSION['captcha_verified'] = [
        'timestamp' => $now,
        'valid_until' => $now + MATH_IMAGE_VERIFIED_TTL_SECONDS,
        'method' => 'math_image',
    ];
    sendResponse(true, ['verified' => true], 'Math check passed.');
}

function getLoginSuspiciousRiskThreshold($conn) {
    static $cachedThreshold = null;
    if ($cachedThreshold !== null) {
        return $cachedThreshold;
    }

    $threshold = LOGIN_SUSPICIOUS_RISK_THRESHOLD_DEFAULT;
    $stmt = $conn->prepare(
        "SELECT setting_value FROM settings WHERE setting_key = 'login_suspicious_risk_threshold' LIMIT 1"
    );
    if ($stmt) {
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if ($row && isset($row['setting_value'])) {
            $threshold = intval($row['setting_value']);
        }
    }

    $cachedThreshold = max(1, min(10, $threshold));
    return $cachedThreshold;
}

function mergeRiskSignals($baseSignals, $extraSignals) {
    $merged = [];
    $sources = [$baseSignals, $extraSignals];
    foreach ($sources as $source) {
        if (!is_array($source)) {
            continue;
        }
        foreach ($source as $signal) {
            $text = trim((string)$signal);
            if ($text !== '') {
                $merged[$text] = true;
            }
        }
    }
    return array_keys($merged);
}

function collectClientNetworkRiskSignals($payload) {
    $signals = [];
    $network = $payload['network'] ?? null;
    if (!is_array($network)) {
        return $signals;
    }

    if (array_key_exists('online', $network)) {
        $online = filter_var($network['online'], FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($online === false) {
            $signals[] = 'client_reported_offline';
        }
    }

    $effectiveType = strtolower(trim((string)($network['effective_type'] ?? '')));
    if (in_array($effectiveType, ['slow-2g', '2g'], true)) {
        $signals[] = 'client_signal_unstable';
    }

    $rtt = isset($network['rtt']) && is_numeric($network['rtt']) ? floatval($network['rtt']) : null;
    if ($rtt !== null && $rtt >= LOGIN_NETWORK_RTT_UNSTABLE_MS) {
        $signals[] = 'client_high_rtt';
    }

    $downlink = isset($network['downlink']) && is_numeric($network['downlink']) ? floatval($network['downlink']) : null;
    if ($downlink !== null && $downlink > 0 && $downlink < LOGIN_NETWORK_MIN_DOWNLINK_MBPS) {
        $signals[] = 'client_low_downlink';
    }

    return mergeRiskSignals($signals, []);
}

function canReachHostPort($host, $port, $timeoutSeconds = LOGIN_SERVER_CONNECTIVITY_TIMEOUT_SECONDS) {
    $errno = 0;
    $errstr = '';
    $socket = @fsockopen((string)$host, intval($port), $errno, $errstr, floatval($timeoutSeconds));
    if (is_resource($socket)) {
        fclose($socket);
        return true;
    }
    return false;
}

function collectServerNetworkRiskSignals() {
    $signals = [];

    $dnsHost = 'cloudflare.com';
    $resolved = @gethostbyname($dnsHost);
    $dnsLooksHealthy = is_string($resolved) && $resolved !== $dnsHost && filter_var($resolved, FILTER_VALIDATE_IP) !== false;
    if (!$dnsLooksHealthy) {
        $signals[] = 'server_dns_unavailable';
    }

    $outboundReachable = canReachHostPort('1.1.1.1', 53)
        || canReachHostPort('8.8.8.8', 53);
    if (!$outboundReachable) {
        $signals[] = 'server_no_outbound_connectivity';
    }

    if ($dnsLooksHealthy || $outboundReachable) {
        return [];
    }

    return mergeRiskSignals($signals, []);
}

function evaluatePrecheckRiskScore($conn, $user) {
    $score = 0;
    $signals = [];

    $accountFailedCount = 0;
    $lockoutEnabled = true;
    $windowHours = 24;

    $settingsStmt = $conn->prepare(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('lockout_enabled','lockout_window_hours')"
    );
    if ($settingsStmt) {
        $settingsStmt->execute();
        $settingsResult = $settingsStmt->get_result();
        while ($settingRow = $settingsResult->fetch_assoc()) {
            $settingKey = (string)($settingRow['setting_key'] ?? '');
            $settingValue = (string)($settingRow['setting_value'] ?? '');
            if ($settingKey === 'lockout_enabled') {
                $lockoutEnabled = $settingValue === '1';
            } elseif ($settingKey === 'lockout_window_hours') {
                $windowHours = max(1, intval($settingValue));
            }
        }
        $settingsStmt->close();
    }

    if ($lockoutEnabled) {
        $windowStartRaw = trim((string)($user['reset_request_window_start'] ?? ''));
        $windowStartTs = $windowStartRaw !== '' ? strtotime($windowStartRaw) : false;
        if ($windowStartTs !== false && ($windowStartTs + ($windowHours * 3600)) >= time()) {
            $accountFailedCount = max(0, intval($user['reset_request_count'] ?? 0));
        }
    }

    if ($accountFailedCount >= 3) {
        $score += 3;
        $signals[] = 'account_failed_attempts_high';
    } elseif ($accountFailedCount >= 1) {
        $score += 1;
        $signals[] = 'account_failed_attempts_recent';
    }

    $ua = trim((string)($_SERVER['HTTP_USER_AGENT'] ?? ''));
    if ($ua === '' || strlen($ua) < 12) {
        $score += 1;
        $signals[] = 'low_entropy_user_agent';
    }

    $riskThreshold = getLoginSuspiciousRiskThreshold($conn);

    return [
        'score' => $score,
        'signals' => $signals,
        'account_failed_count' => $accountFailedCount,
        'threshold' => $riskThreshold,
        'suspicious' => $score >= $riskThreshold,
    ];
}

function randomAutoCheckDelayMs() {
    return random_int(LOGIN_AUTO_CHECK_MIN_DELAY_MS, LOGIN_AUTO_CHECK_MAX_DELAY_MS);
}

function storePendingLoginSession($user, $clientBrowserId, $captchaMode = 'custom', $autoCheckDelayMs = 0, $riskScore = 0, $riskSignals = []) {
    clearPendingLoginSession();
    clearMathCaptchaVerification();

    $mode = strtolower(trim((string)$captchaMode));
    if (!in_array($mode, ['custom', 'auto'], true)) {
        $mode = 'custom';
    }

    $maxDelayMs = $mode === 'custom' ? LOGIN_CUSTOM_CAPTCHA_DELAY_MS : LOGIN_AUTO_CHECK_MAX_DELAY_MS;
    $safeDelayMs = max(LOGIN_AUTO_CHECK_MIN_DELAY_MS, min($maxDelayMs, intval($autoCheckDelayMs)));
    $autoCheckUntilMs = 0;
    if ($mode === 'auto' || $mode === 'custom') {
        $autoCheckUntilMs = (int)round(microtime(true) * 1000) + $safeDelayMs;
    }

    $signalSummary = [];
    if (is_array($riskSignals)) {
        foreach ($riskSignals as $signal) {
            $text = trim((string)$signal);
            if ($text !== '') {
                $signalSummary[] = $text;
            }
        }
    }

    $_SESSION['pending_login'] = [
        'user_id' => (int)($user['id'] ?? 0),
        'email' => normalizeEmailIdentifier((string)($user['email'] ?? '')),
        'password_hash' => (string)($user['password'] ?? ''),
        'browser_id' => (string)$clientBrowserId,
        'created_at' => time(),
        'valid_until' => time() + 90,
        'captcha_mode' => $mode,
        'auto_check_until_ms' => $autoCheckUntilMs,
        'risk_score' => max(0, intval($riskScore)),
        'risk_signals' => $signalSummary,
    ];
}

function getPendingLoginSession($clientBrowserId) {
    $pending = $_SESSION['pending_login'] ?? null;
    if (!is_array($pending)) {
        return null;
    }

    $validUntil = (int)($pending['valid_until'] ?? 0);
    $pendingUserId = (int)($pending['user_id'] ?? 0);
    $pendingBrowserId = (string)($pending['browser_id'] ?? '');
    $pendingPasswordHash = (string)($pending['password_hash'] ?? '');

    if (
        $validUntil <= time()
        || $pendingUserId <= 0
        || $pendingBrowserId === ''
        || $pendingPasswordHash === ''
        || !hash_equals($pendingBrowserId, (string)$clientBrowserId)
    ) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        return null;
    }

    return $pending;
}

/**
 * True when the given login identifier (email or username) belongs to an
 * admin account. Used to keep admin sign-in immune to blocking mechanisms.
 */
function isLoginIdentifierAdmin($conn, $loginIdentifier) {
    $stmt = $conn->prepare(
        "SELECT role
         FROM users
         WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
            OR LOWER(TRIM(username)) = LOWER(TRIM(?))
         LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ss', $loginIdentifier, $loginIdentifier);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return strtolower(trim((string)($row['role'] ?? ''))) === 'admin';
}

function authenticateLoginCredentials($conn, $loginIdentifier, $password) {
    // ── Browser-lockout gate ────────────────────────────────────────────────
    // Check server-side whether this browser (IP + UA) is blocked.
    // This prevents a blocked browser from logging in even if it clears localStorage.
    // Admin accounts are never blocked here — they must always be able to
    // sign in (correct password + OTP are still required).
    if (!isLoginIdentifierAdmin($conn, $loginIdentifier) && isBrowserLockedOut($conn)) {
        clearMathCaptchaVerification();
        clearPendingLoginSession();
        sendError('Unauthorized Access Detected. This browser has been blocked due to repeated failed login attempts. Contact an administrator.', 403, [
            'browser_blocked' => true,
        ]);
    }

    $lockdownState = getSystemLockdownState($conn);
    if (!empty($lockdownState['enabled'])) {
        $roleStmt = $conn->prepare(
            "SELECT role
             FROM users
             WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
                OR LOWER(TRIM(username)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        $loginRole = '';
        if ($roleStmt) {
            $roleStmt->bind_param('ss', $loginIdentifier, $loginIdentifier);
            $roleStmt->execute();
            $roleRow = $roleStmt->get_result()->fetch_assoc();
            $roleStmt->close();
            $loginRole = strtolower(trim((string)($roleRow['role'] ?? '')));
        }

        if ($loginRole !== 'admin') {
            clearMathCaptchaVerification();
            clearPendingLoginSession();
            sendError(
                'System Lockdown Mode is active. Only admin logins are currently allowed.',
                423,
                [
                    'lockdown_enabled' => true,
                    'lockdown_reason' => (string)$lockdownState['reason'],
                    'lockdown_updated_at' => (string)$lockdownState['updated_at'],
                ]
            );
        }
    }

    $sql = "SELECT u.*, 
                   CONCAT(e.first_name, ' ', e.last_name) as full_name,
                   b.branch_name
            FROM users u
            LEFT JOIN employees e ON u.employee_id = e.employee_id
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE LOWER(TRIM(u.email)) = LOWER(TRIM(?))
               OR LOWER(TRIM(u.username)) = LOWER(TRIM(?))";

    $stmt = $conn->prepare($sql);
    $stmt->bind_param('ss', $loginIdentifier, $loginIdentifier);
    $stmt->execute();
    $result = $stmt->get_result();

    if ($result->num_rows === 0) {
        // Plain generic credential error on purpose: a distinct "unknown
        // email" message/field/code would let attackers enumerate which
        // accounts exist. The specific reason stays in the server log only.
        $attemptIp = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        logActivity($conn, null, 'failed_login', "Failed login attempt for unknown identifier '{$loginIdentifier}' from IP {$attemptIp} — Invalid email", 'auth');
        rejectLoginAttempt('Invalid email or password.', 401, [
            'code' => 'invalid_credentials',
        ]);
    }

    $user = $result->fetch_assoc();

    if ($user['status'] === 'locked') {
        // Same plain response as a bad password: confirming "this account
        // exists but is locked" would also leak account existence.
        clearPendingLoginSession();
        logActivity($conn, intval($user['id']), 'failed_login', "Failed login attempt for locked account ID {$user['id']} — Invalid credentials", 'auth');
        rejectLoginAttempt('Invalid email or password.', 401, [
            'code' => 'invalid_credentials',
        ]);
    }

    if ($user['status'] !== 'active') {
        // Same plain response: confirming "this account exists but is
        // inactive" would also leak account existence.
        clearPendingLoginSession();
        logActivity($conn, intval($user['id']), 'failed_login', "Failed login attempt for inactive account ID {$user['id']} — Invalid credentials", 'auth');
        rejectLoginAttempt('Invalid email or password.', 401, [
            'code' => 'invalid_credentials',
        ]);
    }

    // "Attempt return" countdown: block retries until the cooldown expires.
    $cooldownRemaining = getAccountCooldownRemainingSeconds($conn, $user);
    if ($cooldownRemaining > 0) {
        // Log cooldown block with who's user
        $uLabel = trim(($user['username'] ?? '') !== '' ? $user['username'] : ($user['email'] ?? "User #{$user['id']}"));
        $uRole = strtolower((string)($user['role'] ?? ''));
        logActivity($conn, intval($user['id']), 'failed_login_cooldown', "User '{$uLabel}'" . ($uRole !== '' ? " ({$uRole})" : "") . " blocked by cooldown — Too many request, please try again after {$cooldownRemaining} seconds.", 'auth');
        rejectLoginAttempt(
            "Too many request, please try again after {$cooldownRemaining} seconds.",
            429,
            [
                'code' => 'invalid_credentials',
                'retry_after_seconds' => $cooldownRemaining,
            ]
        );
    }

    if (!verifyPassword($password, $user['password'])) {
        $lockoutResult = checkAndIncrementLoginFailureCounter($conn, $user);
        $remainingAttempts = $lockoutResult['remaining_attempts'] ?? null;
        $threshold = $lockoutResult['threshold'] ?? null;
        $failedAttempts = $lockoutResult['failed_attempts'] ?? null;

        // Plain generic credential error (same message + code as an unknown
        // identifier): no field pointer, no attempt counters — any of those
        // would tell an attacker that this account exists.
        $genericCredentialErrors = [
            'code' => 'invalid_credentials',
        ];

        if (($lockoutResult['status'] ?? '') === 'locked') {
            $lockLabel = trim(($user['username'] ?? '') !== '' ? $user['username'] : ($user['email'] ?? "User #{$user['id']}"));
            $lockRole = strtolower((string)($user['role'] ?? ''));
            logActivity($conn, intval($user['id']), 'account_locked', "Account locked for user '{$lockLabel}'" . ($lockRole !== '' ? " ({$lockRole})" : "") . " after {$failedAttempts} failed attempts (threshold {$threshold})", 'security');
            rejectLoginAttempt('Invalid email or password.', 401, $genericCredentialErrors);
        }

        // Cooldown cycle: block retries until the (escalating) wait expires
        // instead of locking the account straight away.
        if (($lockoutResult['status'] ?? '') === 'cooldown') {
            $retryAfter = max(1, (int)($lockoutResult['retry_after_seconds'] ?? 0));
            $coolLabel = trim(($user['username'] ?? '') !== '' ? $user['username'] : ($user['email'] ?? "User #{$user['id']}"));
            $coolRole = strtolower((string)($user['role'] ?? ''));
            logActivity($conn, intval($user['id']), 'failed_login_cooldown', "User '{$coolLabel}'" . ($coolRole !== '' ? " ({$coolRole})" : "") . " in cooldown — Too many request, please try again after {$retryAfter} seconds.", 'auth');
            rejectLoginAttempt(
                "Too many request, please try again after {$retryAfter} seconds.",
                429,
                [
                    'code' => 'invalid_credentials',
                    'retry_after_seconds' => $retryAfter,
                ]
            );
        }

        // Log failed login with who's user is that for security notification
        $failLabel = trim(($user['username'] ?? '') !== '' ? $user['username'] : ($user['email'] ?? "User #{$user['id']}"));
        $failRole = strtolower((string)($user['role'] ?? ''));
        $failIp = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        $attemptInfo = $failedAttempts !== null && $threshold !== null ? " Attempt {$failedAttempts}/{$threshold}." : "";
        logActivity($conn, intval($user['id']), 'failed_login', "Failed login attempt for user '{$failLabel}'" . ($failRole !== '' ? " ({$failRole})" : "") . " from IP {$failIp} — Invalid password." . $attemptInfo, 'auth');
        rejectLoginAttempt('Invalid email or password.', 401, $genericCredentialErrors);
    }

    $user = preparePasswordExpirationForUser($conn, $user);

    return $user;
}

/**
 * Hold a verified login for approval instead of signing it in immediately.
 * The active holder gets a Stay (= deny) / Logout (= allow) prompt; the
 * newcomer polls login_await until the holder decides or the request expires.
 * Never returns.
 */
function holdLoginForApproval($conn, $user, $activeHolder) {
    $userId = (int)($user['id'] ?? 0);
    if ($userId <= 0) {
        sendError('Invalid user session data', 500);
    }

    storePendingLoginSession($user, getClientBrowserIdentifier(), 'auto', 0, 0, []);
    $approval = createLoginApprovalRequest($conn, $userId, LOGIN_APPROVAL_TTL_SECONDS);
    $_SESSION['login_await'] = (int)$approval['id'];

    sendResponse(true, [
        'awaiting_approval' => 1,
        'request_id' => (int)$approval['id'],
        'expires_in' => (int)$approval['expires_in'],
        'holder' => $activeHolder,
    ], 'Another device is signed in. Waiting for approval from the active session.');
}

function sendAuthenticatedLoginResponse($conn, $user) {
    $mustResetPassword = isPasswordChangeRequired($user) ? 1 : 0;

    setActiveSessionUserFromRecord($user, $mustResetPassword);
    // Single-session rule: this login claims the account's active session,
    // displacing any older session on another browser/device.
    $singleSessionClaim = claimSingleSession($conn, (int)($user['id'] ?? 0), (string)($user['role'] ?? ''));
    touchCurrentSessionPresence($conn);
    clearMathCaptchaVerification();
    clearPendingLoginSession();
    clearAccountLockoutCounter($conn, (int)($user['id'] ?? 0));

    $update_sql = "UPDATE users SET last_login = NOW() WHERE id = ?";
    $update_stmt = $conn->prepare($update_sql);
    $update_stmt->bind_param('i', $user['id']);
    $update_stmt->execute();

    logActivity($conn, $user['id'], 'login', 'User logged in', 'authentication');

    unset($user['password']);
    $user['must_reset_password'] = $mustResetPassword ? 1 : 0;
    $user['password_change_reason'] = $mustResetPassword ? getPasswordChangeReasonForUser($user) : '';
    $user['password_status'] = getPasswordChangeStatus($conn, $user);
    $loginRole = strtolower(trim((string)($user['role'] ?? '')));
    // Phase 1.5: admin is now covered by the idle timeout as well, so the
    // frontend countdown must be told about it. Previously admin reported
    // enabled=false / minutes=0 and never idled out.
    $isManagedRole = in_array($loginRole, ['admin', 'manager', 'staff'], true);
    $timeoutConfig = getManagedRoleSessionTimeoutConfig($conn);
    $roleTimeoutMinutes = getSessionTimeoutMinutesForRole($loginRole, $timeoutConfig);
    $user['session_timeout_enabled'] = $isManagedRole && !empty($timeoutConfig['enabled']);
    $user['session_timeout_minutes'] = $isManagedRole ? max(1, $roleTimeoutMinutes) : 0;
    $user['session_timeout_warning_seconds'] = 30;
    $user['dashboard_path'] = getRoleDashboardPath($loginRole);
    $user['role_feature_access'] = getRoleFeatureAccessMap($loginRole, $conn);

    if ($mustResetPassword) {
        $message = 'Login successful. Please change your temporary password now.';
    } else {
        $message = 'Login successful';
    }
    $user['ended_other_session'] = !empty($singleSessionClaim['ended_other']) ? 1 : 0;
    sendResponse(true, $user, $message);
}

/**
 * End a failed login attempt request.
 * @param string $message
 * @param int $code
 * @param mixed $errors
 * @return void
 */
function rejectLoginAttempt($message, $code = 401, $errors = null) {
    clearMathCaptchaVerification();
    clearPendingLoginSession();

    sendError($message, $code, $errors);
}

/**
 * Build + send the 6-digit email code required on EVERY login, for every user.
 */
function sendLoginOtpEmail($user, $otp) {
    $toEmail = trim((string)($user['email'] ?? ''));
    if ($toEmail === '') {
        return false;
    }

    $fullName = trim((string)(($user['first_name'] ?? '') . ' ' . ($user['last_name'] ?? '')));
    if ($fullName === '') {
        $fullName = trim((string)($user['username'] ?? ''));
    }
    $displayName = $fullName !== '' ? $fullName : $toEmail;
    $safeName = htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8');
    $safeOtp  = htmlspecialchars((string)$otp, ENT_QUOTES, 'UTF-8');

    $innerHtml = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#374151;">Hi ' . $safeName . ',</p>'
        . '<p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#374151;">'
        . 'Your login verification code is:</p>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px auto;">'
        . '<tr><td style="background:#f1f5f9;border:2px solid #0f2d74;border-radius:10px;padding:16px 36px;text-align:center;">'
        . '<span style="font-size:32px;font-weight:700;letter-spacing:10px;color:#0f2d74;font-family:monospace;">' . $safeOtp . '</span>'
        . '</td></tr></table>'
        . '<p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#6b7280;">'
        . 'This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>'
        . '<p style="margin:0;font-size:13px;line-height:1.6;color:#dc2626;">'
        . 'If you did not try to log in, your account may be at risk — change your password immediately.</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($innerHtml, 'Your LLB Accountants login code')
        : $innerHtml;

    return function_exists('sendMail') && sendMail($toEmail, $fullName, 'Your login verification code – LLB Accountants', $html);
}

/**
 * Issue a fresh login OTP for an already-authenticated pending login.
 * Must be called AFTER storePendingLoginSession(). Returns a mail-send
 * closure for use with sendResponseAndContinue().
 */
function issueLoginOtp($conn, $user) {
    $email = trim((string)($user['email'] ?? ''));
    if ($email === '') {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('No email address is on file for this account. Please contact an administrator.', 400, [
            'field' => 'email',
            'code' => 'missing_email',
        ]);
    }

    $otp = strval(random_int(100000, 999999));
    $_SESSION['pending_login']['otp_hash'] = hash('sha256', $otp);
    $_SESSION['pending_login']['otp_expires'] = time() + LOGIN_OTP_TTL_SECONDS;
    $_SESSION['pending_login']['otp_attempts'] = 0;
    $_SESSION['pending_login']['otp_sent_at'] = time();
    $_SESSION['pending_login']['otp_verified'] = false;
    // Give the user time to receive + type the emailed code.
    $_SESSION['pending_login']['valid_until'] = time() + LOGIN_OTP_TTL_SECONDS;

    $userId = (int)($user['id'] ?? 0);
    logActivity($conn, $userId, 'login_otp_sent', 'Login verification code issued', 'authentication');

    return function () use ($conn, $user, $userId, $otp) {
        $sent = sendLoginOtpEmail($user, $otp);
        if (!$sent) {
            error_log('Login OTP email failed to send for user_id=' . $userId);
        }
        logActivity(
            $conn,
            $userId,
            'login_otp_email',
            $sent ? 'Login verification code emailed' : 'Login verification code email failed',
            'authentication'
        );
        return $sent;
    };
}

/**
 * POST - Login
 */
function handleLogin($conn) {
    // Server-side math image gate: the answer is checked against the
    // session challenge — calling this endpoint directly without solving
    // the image first is rejected. Verified BEFORE credentials so failures
    // reveal nothing about account existence.
    if (!isMathCaptchaVerified()) {
        sendError('Please complete the math image verification first.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_required',
        ]);
    }

    $data = getJSONInput();

    $required = ['email', 'password'];
    $missing = validateRequiredFields($data, $required);

    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $email = normalizeLoginIdentifier($data['email']);
    $password = $data['password'];

    $user = authenticateLoginCredentials($conn, $email, $password);

    // Login OTP can be switched off from Admin Profile settings. When off,
    // sign in directly after credentials verify (single-session rule still
    // ends any other active session inside the authenticated response).
    if (!isLoginOtpEnabled($conn)) {
        sendAuthenticatedLoginResponse($conn, $user);
    }

    // OTP is required on every login: verify credentials first, then issue a
    // code and hold the sign-in until it is verified (see login_verify_otp).
    storePendingLoginSession($user, getClientBrowserIdentifier(), 'auto', randomAutoCheckDelayMs(), 0, []);
    $mailCallback = issueLoginOtp($conn, $user);
    if (!$mailCallback()) {
        sendError('We could not send your verification code. The email service is unavailable; please contact the administrator.', 503, [
            'field' => 'otp',
            'code' => 'otp_delivery_failed',
        ]);
    }

    sendResponse(true, [
        'otp_required' => 1,
        'expires_in' => LOGIN_OTP_TTL_SECONDS,
    ], 'Credentials verified. A verification code has been sent to your email.');
}

/**
 * POST - Precheck login credentials and decide whether manual captcha is required.
 */
function handleLoginPrecheck($conn) {
    $data = getJSONInput();

    $required = ['email', 'password'];
    $missing = validateRequiredFields($data, $required);

    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $email = normalizeLoginIdentifier($data['email']);
    $password = $data['password'];

    $clientBrowserId = getClientBrowserIdentifier();

    $user = authenticateLoginCredentials($conn, $email, $password);
    $risk = evaluatePrecheckRiskScore($conn, $user);
    $clientNetworkSignals = collectClientNetworkRiskSignals($data);
    $serverNetworkSignals = collectServerNetworkRiskSignals();
    $networkSignals = mergeRiskSignals($clientNetworkSignals, $serverNetworkSignals);
    $riskSignals = mergeRiskSignals(
        is_array($risk['signals'] ?? null) ? $risk['signals'] : [],
        $networkSignals
    );
    $autoCheckDelayMs = randomAutoCheckDelayMs();
    $captchaEnabled = isLoginMathCaptchaEnabled($conn);
    $captchaMode = $captchaEnabled ? 'custom' : 'auto';
    $pendingCheckDelayMs = $captchaEnabled ? LOGIN_CUSTOM_CAPTCHA_DELAY_MS : $autoCheckDelayMs;

    storePendingLoginSession(
        $user,
        $clientBrowserId,
        $captchaMode,
        $pendingCheckDelayMs,
        intval($risk['score'] ?? 0),
        $riskSignals
    );

    // Captcha comes before OTP: hold the sign-in here. The frontend runs the
    // verification check next, then requests the emailed code
    // (see login_request_otp), then verifies it (see login_verify_otp).
    // When the login OTP is switched off, skip straight to the captcha flow
    // with no code step.
    if (!isLoginOtpEnabled($conn)) {
        if ($captchaEnabled) {
            sendResponse(true, [
                'captcha_required' => true,
                'captcha_mode' => 'custom',
                'expires_in' => 90,
                'auto_check_delay_ms' => LOGIN_CUSTOM_CAPTCHA_DELAY_MS,
                'risk_score' => intval($risk['score'] ?? 0),
            ], 'Credentials verified. Please complete the verification check to continue.');
        }
        sendResponse(true, [
            'captcha_required' => false,
            'captcha_mode' => 'auto',
            'expires_in' => 90,
            'auto_check_delay_ms' => $autoCheckDelayMs,
            'risk_score' => intval($risk['score'] ?? 0),
        ], 'Credentials verified. Server security check is in progress.');
    }
    if ($captchaEnabled) {
        sendResponse(true, [
            'captcha_required' => true,
            'captcha_mode' => 'custom',
            'expires_in' => 90,
            'auto_check_delay_ms' => LOGIN_CUSTOM_CAPTCHA_DELAY_MS,
            'risk_score' => intval($risk['score'] ?? 0),
        ], 'Credentials verified. Please complete the verification check to continue.');
    } else {
        sendResponse(true, [
            'captcha_required' => false,
            'captcha_mode' => 'auto',
            'expires_in' => 90,
            'auto_check_delay_ms' => $autoCheckDelayMs,
            'risk_score' => intval($risk['score'] ?? 0),
        ], 'Credentials verified. Server security check is in progress.');
    }
}

/**
 * POST - Verify the emailed login OTP. Required on every login.
 * Payload: { otp }
 */
function handleLoginVerifyOtp($conn) {
    $data = getJSONInput();
    $code = preg_replace('/\D+/', '', (string)($data['otp'] ?? ($data['code'] ?? '')));
    if (strlen($code) !== 6) {
        sendError('Enter the 6-digit code sent to your email.', 400, [
            'field' => 'otp',
            'code' => 'invalid_otp',
        ]);
    }

    $clientBrowserId = getClientBrowserIdentifier();
    $pending = getPendingLoginSession($clientBrowserId);
    if (!$pending) {
        sendError('Login session expired. Enter your email and password again.', 400, [
            'code' => 'session_expired',
        ]);
    }

    $captchaEnabled = isLoginMathCaptchaEnabled($conn);
    if (!empty($pending['otp_verified'])) {
        sendResponse(true, [
            'otp_verified' => 1,
            'captcha_required' => $captchaEnabled,
            'captcha_mode' => $captchaEnabled ? 'custom' : 'auto',
            'expires_in' => max(0, (int)($pending['valid_until'] ?? 0) - time()),
            'auto_check_delay_ms' => $captchaEnabled ? LOGIN_CUSTOM_CAPTCHA_DELAY_MS : randomAutoCheckDelayMs(),
        ], 'Code already verified. Continue login.');
    }

    $otpHash = (string)($pending['otp_hash'] ?? '');
    $otpExpires = (int)($pending['otp_expires'] ?? 0);
    if ($otpHash === '' || $otpExpires <= time()) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Verification code expired. Enter your email and password again.', 400, [
            'code' => 'otp_expired',
        ]);
    }

    $attempts = (int)($pending['otp_attempts'] ?? 0);
    $userId = (int)($pending['user_id'] ?? 0);
    if ($attempts >= LOGIN_OTP_MAX_ATTEMPTS) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        logActivity($conn, $userId, 'login_otp_locked', 'Login attempt discarded after too many wrong verification codes', 'authentication');
        sendError('Too many incorrect codes. Enter your email and password again.', 403, [
            'code' => 'otp_locked',
        ]);
    }

    if (!hash_equals($otpHash, hash('sha256', $code))) {
        $attempts++;
        $_SESSION['pending_login']['otp_attempts'] = $attempts;
        $remaining = LOGIN_OTP_MAX_ATTEMPTS - $attempts;
        logActivity($conn, $userId, 'login_otp_failed', "Wrong login verification code ({$attempts}/" . LOGIN_OTP_MAX_ATTEMPTS . ")", 'authentication');
        if ($remaining <= 0) {
            clearPendingLoginSession();
            clearMathCaptchaVerification();
            sendError('Too many incorrect codes. Enter your email and password again.', 403, [
                'code' => 'otp_locked',
            ]);
        }
        sendError('Incorrect verification code.', 401, [
            'field' => 'otp',
            'code' => 'invalid_otp',
            'attempts_remaining' => $remaining,
        ]);
    }

    $_SESSION['pending_login']['otp_verified'] = true;
    $_SESSION['pending_login']['otp_attempts'] = 0;
    logActivity($conn, $userId, 'login_otp_verified', 'Login verification code accepted', 'authentication');
    // Proving email ownership extends the humanity proof across the OTP
    // window, so the final step still sees a valid verification without
    // forcing a re-solve. Only extends a still-valid verification.
    if (isMathCaptchaVerified()) {
        $_SESSION['captcha_verified']['valid_until'] = time() + LOGIN_OTP_TTL_SECONDS;
    }

    sendResponse(true, [
        'otp_verified' => 1,
        'captcha_required' => $captchaEnabled,
        'captcha_mode' => $captchaEnabled ? 'custom' : 'auto',
        'expires_in' => max(0, (int)($_SESSION['pending_login']['valid_until'] ?? 0) - time()),
        'auto_check_delay_ms' => $captchaEnabled ? LOGIN_CUSTOM_CAPTCHA_DELAY_MS : randomAutoCheckDelayMs(),
    ], $captchaEnabled
        ? 'Code verified. Please complete the verification check to continue.'
        : 'Code verified. Finishing login...');
}

/**
 * POST - Send (or resend) the emailed login OTP for the current pending login.
 * The captcha/verification check must be completed FIRST when it is enabled —
 * this keeps the login order at credentials → captcha → OTP.
 */
function handleLoginRequestOtp($conn) {
    $clientBrowserId = getClientBrowserIdentifier();
    $pending = getPendingLoginSession($clientBrowserId);
    if (!$pending) {
        sendError('Login session expired. Enter your email and password again.', 400, [
            'code' => 'session_expired',
        ]);
    }
    if (!empty($pending['otp_verified'])) {
        sendError('Code already verified. Continue login.', 400, [
            'code' => 'already_verified',
        ]);
    }

    // Captcha gate: the FIRST code is issued only after a real verification
    // (math image solved via math_verify, or hCaptcha). No auto-pass — a
    // direct API call without solving cannot receive any code. Resends ride
    // on the already-issued OTP state and stay rate-limited below.
    $captchaEnabled = isLoginMathCaptchaEnabled($conn);
    $firstIssuance = empty($pending['otp_hash']);
    if ($captchaEnabled && $firstIssuance && !isMathCaptchaVerified()) {
        sendError('Please complete the math image verification first.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_required',
        ]);
    }

    $alreadySent = !empty($pending['otp_hash']);
    if ($alreadySent) {
        $sentAt = (int)($pending['otp_sent_at'] ?? 0);
        $wait = LOGIN_OTP_RESEND_SECONDS - (time() - $sentAt);
        if ($wait > 0) {
            sendError("Please wait {$wait} seconds before requesting a new code.", 429, [
                'retry_after_seconds' => $wait,
                'code' => 'resend_cooldown',
            ]);
        }
    }

    // Login OTP switched off: no code is issued — tell the caller to finish
    // login straight away (captcha already passed above when enabled).
    if (!isLoginOtpEnabled($conn)) {
        sendResponse(true, [
            'otp_required' => 0,
            'captcha_required' => $captchaEnabled,
        ], 'Login OTP is disabled. Continue login.');
    }

    $pendingUserId = (int)($pending['user_id'] ?? 0);
    $stmt = $conn->prepare("SELECT id, username, email, first_name, last_name FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Could not resend the code. Please try again.', 500);
    }
    $stmt->bind_param('i', $pendingUserId);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!$user) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Login session expired. Enter your email and password again.', 400, [
            'code' => 'session_expired',
        ]);
    }

    $otp = strval(random_int(100000, 999999));
    $_SESSION['pending_login']['otp_hash'] = hash('sha256', $otp);
    $_SESSION['pending_login']['otp_expires'] = time() + LOGIN_OTP_TTL_SECONDS;
    $_SESSION['pending_login']['otp_attempts'] = 0;
    $_SESSION['pending_login']['otp_sent_at'] = time();
    $_SESSION['pending_login']['otp_verified'] = false;
    $_SESSION['pending_login']['valid_until'] = time() + LOGIN_OTP_TTL_SECONDS;

    $userId = (int)($user['id'] ?? 0);
    logActivity($conn, $userId, 'login_otp_resent', 'Login verification code re-sent', 'authentication');

    $mailCallback = function () use ($conn, $user, $userId, $otp) {
        $sent = sendLoginOtpEmail($user, $otp);
        if (!$sent) {
            error_log('Login OTP resend failed for user_id=' . $userId);
        }
        logActivity(
            $conn,
            $userId,
            'login_otp_email',
            $sent ? 'Login verification code re-emailed' : 'Login verification code resend email failed',
            'authentication'
        );
        return $sent;
    };

    $sentMessage = $alreadySent
        ? 'A new verification code has been sent to your email.'
        : 'A verification code has been sent to your email.';
    if (!$mailCallback()) {
        sendError('We could not send your verification code. The email service is unavailable; please contact the administrator.', 503, [
            'field' => 'otp',
            'code' => 'otp_delivery_failed',
        ]);
    }

    sendResponse(true, [
        'otp_required' => 1,
        'expires_in' => LOGIN_OTP_TTL_SECONDS,
    ], $sentMessage);
}

/**
 * POST - Finalize login after captcha verification.
 */
function handleLoginComplete($conn) {
    $clientBrowserId = getClientBrowserIdentifier();

    $pending = getPendingLoginSession($clientBrowserId);
    if (!$pending) {
        sendError('Login session expired. Enter your email and password again.', 400);
    }

    // OTP is mandatory on every login while enabled — the emailed code must
    // be verified first. (Skipped entirely when the login OTP is off.)
    if (isLoginOtpEnabled($conn) && empty($pending['otp_verified'])) {
        sendError('Please verify the code sent to your email first.', 400, [
            'field' => 'otp',
            'code' => 'otp_required',
        ]);
    }

    // Both proofs required: verified OTP (when enabled) AND a real captcha
    // verification. No auto-pass — direct API calls cannot finish login.
    if (!isMathCaptchaVerified()) {
        sendError('Please complete the math image verification first.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_required',
        ]);
    }

    $pendingUserId = (int)($pending['user_id'] ?? 0);
    $sql = "SELECT u.*, 
                   CONCAT(e.first_name, ' ', e.last_name) as full_name,
                   b.branch_name
            FROM users u
            LEFT JOIN employees e ON u.employee_id = e.employee_id
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $pendingUserId);
    $stmt->execute();
    $result = $stmt->get_result();

    if ($result->num_rows === 0) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Login session expired. Enter your email and password again.', 400);
    }

    $user = $result->fetch_assoc();

    $storedEmail = normalizeEmailIdentifier((string)($pending['email'] ?? ''));
    $currentEmail = normalizeEmailIdentifier((string)($user['email'] ?? ''));
    $storedPasswordHash = (string)($pending['password_hash'] ?? '');
    $currentPasswordHash = (string)($user['password'] ?? '');

    if (
        $storedEmail === ''
        || $storedPasswordHash === ''
        || !hash_equals($storedEmail, $currentEmail)
        || !hash_equals($storedPasswordHash, $currentPasswordHash)
    ) {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Login session changed. Enter your email and password again.', 400);
    }

    if ($user['status'] === 'locked') {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Your account has been locked due to too many failed login or captcha attempts. Please contact an administrator.', 403);
    }

    if ($user['status'] !== 'active') {
        clearPendingLoginSession();
        clearMathCaptchaVerification();
        sendError('Account is not active', 403);
    }

    // Single-session rule: a login on another device directly ends this
    // account's other active session — no approval prompt, no waiting.
    $user = preparePasswordExpirationForUser($conn, $user);

    sendAuthenticatedLoginResponse($conn, $user);
}

/**
 * POST - Logout
 */
function handleLogout($conn) {
    // Session already started at top of file
    $effectiveUserId = intval($_SESSION['user_id'] ?? 0);

    if ($effectiveUserId > 0) {
        logActivity($conn, $effectiveUserId, 'logout', 'User logged out', 'authentication');
    }

    clearSessionPresenceByUser($effectiveUserId, $conn);

    if (session_status() === PHP_SESSION_ACTIVE) {
        $cookieParams = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $cookieParams['path'] ?? '/',
            $cookieParams['domain'] ?? '',
            $cookieParams['secure'] ?? false,
            $cookieParams['httponly'] ?? true
        );
        session_unset();
        session_destroy();
    }

    sendResponseAndContinue(true, null, 'Logout successful');
}

/**
 * POST - Register new user
 */
function handleRegister($conn) {
    // ── Authorization gate ────────────────────────────────────────────────────
    // Registration requires an authenticated admin session.  Unauthenticated
    // callers and non-admin roles cannot create accounts.
    $callerRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if (empty($_SESSION['user_id']) || $callerRole !== 'admin') {
        sendError('Forbidden: admin authentication required to register users', 403);
    }
    $callerUserId = (int)$_SESSION['user_id'];

    $data = getJSONInput();
    
    $required = ['password', 'email', 'first_name', 'last_name'];
    $missing = validateRequiredFields($data, $required);
    
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }
    
    $email = normalizeEmailIdentifier($data['email']);
    if (!validateGmailComEmail($email)) {
        sendError('Email must be a valid @gmail.com or @phinmaed.com address', 400);
    }
    
    $plainPassword = (string)($data['password'] ?? '');
    if (strlen($plainPassword) < 8) {
        sendError('Password must be at least 8 characters', 400);
    }
    if (!preg_match('/[A-Z]/', $plainPassword)) {
        sendError('Password must contain at least one uppercase letter', 400);
    }
    if (!preg_match('/[0-9]/', $plainPassword)) {
        sendError('Password must contain at least one number', 400);
    }
    if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $plainPassword)) {
        sendError('Password must contain at least one special character', 400);
    }

    $username = generateUniqueUsernameFromEmail($conn, $email);
    $password = hashPassword($plainPassword);
    $first_name = normalizePersonName($data['first_name'], 50);
    $last_name = normalizePersonName($data['last_name'], 50);
    if ($first_name === '' || $last_name === '') {
        sendError('First name and last name are required', 400);
    }
    // Only admin callers can create manager accounts; all others default to staff.
    $requestedRole = strtolower(trim((string)($data['role'] ?? 'staff')));
    if (!in_array($requestedRole, ['manager', 'staff'], true)) {
        // Silently normalise unknown or 'admin' role to 'staff'.
        $requestedRole = 'staff';
    }
    $role = $requestedRole;
    $mustResetPassword = 1; // Admin-created accounts always require a password reset.
    $passwordChangedAt = date('Y-m-d H:i:s');
    $passwordPolicy = getPasswordPolicy($conn);
    $passwordExpiresAt = date('Y-m-d H:i:s', time() + ($passwordPolicy['max_age_days'] * 86400));
    $employee_id = parseNullablePositiveInt($data['employee_id'] ?? null);
    $branch_id = parseNullablePositiveInt($data['branch_id'] ?? null);
    if ($branch_id !== null) {
        assertBranchExistsForRegister($conn, $branch_id);
    }
    assertManagerBranchAvailabilityForRegister($conn, $role, $branch_id);

    ensureUniqueUserFullName($conn, $first_name, $last_name, null);
    
    // Check if email already exists
    $check_sql = "SELECT id, email
                  FROM users
                  WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
                  LIMIT 1";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('s', $email);
    $check_stmt->execute();

    $duplicate = $check_stmt->get_result()->fetch_assoc();
    if ($duplicate) {
        sendError('Email already in use', 409);
    }
    
    $sql = "INSERT INTO users (username, password, email, first_name, last_name, role, employee_id, branch_id, must_reset_password, password_changed_at, password_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $employeeBind = $employee_id ?? 0;
    $branchBind = $branch_id ?? 0;
    // Fix: type string has 11 chars matching all 11 bound values (was 'ssssssiiss' — 10 chars).
    $stmt->bind_param('ssssssiiiss', $username, $password, $email, $first_name, $last_name, $role, $employeeBind, $branchBind, $mustResetPassword, $passwordChangedAt, $passwordExpiresAt);
    
    if ($stmt->execute()) {
        $user_id = $conn->insert_id;

        logActivity($conn, $callerUserId, 'register', 'Admin created new user: ' . $email, 'authentication');
        
        sendResponse(true, ['user_id' => $user_id], 'User registered successfully', 201);
    } else {
        error_log($conn->error);
        sendError('Failed to register user.', 500);
    }
}

/**
 * GET - Check session
 */
function handleCheckSession($conn) {
    // Session already started at top of file
    if (isset($_SESSION['user_id']) && !empty($_SESSION['user_id'])) {
        enforceManagedRoleSessionTimeout($conn, false);
    }
    
    if (!isset($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }
    
    $user_id = $_SESSION['user_id'];
    
    $sql = "SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.status, u.photo,
                   u.employee_id, u.branch_id, u.must_reset_password, u.password_changed_at, u.password_expires_at,
                   CONCAT(e.first_name, ' ', e.last_name) as full_name,
                   b.branch_name
            FROM users u
            LEFT JOIN employees e ON u.employee_id = e.employee_id
            LEFT JOIN branches b ON u.branch_id = b.branch_id
            WHERE u.id = ?";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $result = $stmt->get_result();
    
    if ($result->num_rows === 0) {
        clearSessionPresenceByUser(intval($user_id), $conn);
        session_destroy();
        sendError('Session invalid', 401);
    }
    
    $user = $result->fetch_assoc();
    
    if ($user['status'] !== 'active') {
        clearSessionPresenceByUser(intval($user_id), $conn);
        session_destroy();
        sendError('Account is not active', 403);
    }

    $user = preparePasswordExpirationForUser($conn, $user);

    $mustResetPassword = isPasswordChangeRequired($user) ? 1 : 0;

    $_SESSION['must_reset_password'] = $mustResetPassword ? 1 : 0;
    $_SESSION['password_change_reason'] = $mustResetPassword ? getPasswordChangeReasonForUser($user) : '';
    $user['must_reset_password'] = $mustResetPassword ? 1 : 0;
    $user['password_change_reason'] = $_SESSION['password_change_reason'];
    $user['password_status'] = getPasswordChangeStatus($conn, $user);

    $timeoutConfig = getManagedRoleSessionTimeoutConfig($conn);
    $sessionRole = strtolower(trim((string)($user['role'] ?? '')));
    // Keep server-side authorization synchronized with database role changes.
    $_SESSION['role'] = $sessionRole;
    // Phase 1.5: admin included — see the matching block in the login handler.
    $isManagedRole = in_array($sessionRole, ['admin', 'manager', 'staff'], true);
    $roleTimeoutMinutes = getSessionTimeoutMinutesForRole($sessionRole, $timeoutConfig);
    $user['session_timeout_enabled'] = $isManagedRole && !empty($timeoutConfig['enabled']);
    $user['session_timeout_minutes'] = $isManagedRole ? max(1, $roleTimeoutMinutes) : 0;
    $user['session_timeout_warning_seconds'] = 30;
    $user['dashboard_path'] = getRoleDashboardPath($sessionRole);
    $user['role_feature_access'] = getRoleFeatureAccessMap($sessionRole, $conn);

    $lockdownState = getSystemLockdownState($conn);
    $user['lockdown_enabled'] = !empty($lockdownState['enabled']);
    $user['lockdown_reason'] = (string)($lockdownState['reason'] ?? '');
    $user['lockdown_updated_at'] = (string)($lockdownState['updated_at'] ?? '');

    $singleSession = getSingleSessionStatus($conn);
    $user['session_superseded'] = !empty($singleSession['superseded']);
    $user['session_holder'] = $singleSession['holder'];

    markSessionActivityNow();
    touchCurrentSessionPresence($conn);
    
    sendResponse(true, $user, 'Session valid');
}

/**
 * GET - Lightweight single-session poll (no user payload).
 * Returns { superseded: bool, holder: { device, ip, at } | null }.
 */
function handleSessionStatus($conn) {
    if (!isset($_SESSION['user_id']) || empty($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }

    $status = getSingleSessionStatus($conn);
    markSessionActivityNow();
    touchCurrentSessionPresence($conn);

    sendResponse(true, [
        'superseded' => !empty($status['superseded']),
        'holder' => $status['holder'],
        'approval' => getPendingLoginApproval($conn, intval($_SESSION['user_id'] ?? 0)),
    ], 'ok');
}

/**
 * POST - Keep this device signed in, ending the other active session.
 * The other device will see the takeover prompt on its next poll.
 */
function handleSessionTakeover($conn) {
    requireAuth();
    $uid = intval($_SESSION['user_id'] ?? 0);
    if ($uid <= 0) {
        sendError('Not authenticated', 401);
    }

    claimSingleSession($conn, $uid, (string)($_SESSION['role'] ?? ''));
    logActivity($conn, $uid, 'session_takeover', 'User kept this session; ended the other active session on a different device', 'authentication');

    sendResponse(true, ['active' => true], 'This device is now the active session.');
}

/**
 * GET - Newcomer polls its held login request.
 * Approved  -> completes the login and returns the session user.
 * Denied    -> 403, the active session chose to stay.
 * Expired   -> 408/410, nobody answered in time.
 * Still pending -> { awaiting: 1, expires_in }.
 */
function handleLoginAwait($conn) {
    $reqId = intval($_SESSION['login_await'] ?? 0);
    $pending = getPendingLoginSession(getClientBrowserIdentifier());
    $pendingUserId = (int)($pending['user_id'] ?? 0);
    if ($reqId <= 0 || $pendingUserId <= 0) {
        unset($_SESSION['login_await']);
        sendError('Login request expired. Please sign in again.', 410);
    }

    ensureLoginApprovalStorage($conn);
    expireStaleLoginApprovals($conn);
    $row = getLoginApprovalById($conn, $reqId);
    if (!is_array($row) || (int)($row['user_id'] ?? 0) !== $pendingUserId) {
        unset($_SESSION['login_await']);
        sendError('Login request expired. Please sign in again.', 410);
    }

    $state = (string)($row['status'] ?? 'expired');
    if ($state === 'approved') {
        completeAwaitedLogin($conn, $pending);
    }
    if ($state === 'denied') {
        unset($_SESSION['login_await']);
        sendError('Login was denied by the active session.', 403);
    }
    if ($state !== 'pending') {
        unset($_SESSION['login_await']);
        sendError('Login request expired. Please sign in again.', 410);
    }
    $remaining = strtotime((string)($row['expires_at'] ?? '')) - time();
    if ($remaining <= 0) {
        unset($_SESSION['login_await']);
        sendError('The active session did not respond in time. Try again.', 408);
    }
    sendResponse(true, [
        'awaiting' => 1,
        'request_id' => $reqId,
        'expires_in' => (int)$remaining,
    ], 'Waiting for approval from the active session.');
}

/**
 * Complete a held login after the active session approved it.
 * Re-validates the account before signing in. Never returns.
 */
function completeAwaitedLogin($conn, $pending) {
    $pendingUserId = (int)($pending['user_id'] ?? 0);
    $stmt = $conn->prepare(
        "SELECT u.*,
               CONCAT(e.first_name, ' ', e.last_name) as full_name,
               b.branch_name
         FROM users u
         LEFT JOIN employees e ON u.employee_id = e.employee_id
         LEFT JOIN branches b ON u.branch_id = b.branch_id
         WHERE u.id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        unset($_SESSION['login_await']);
        sendError('Login request expired. Enter your email and password again.', 400);
    }
    $stmt->bind_param('i', $pendingUserId);
    $stmt->execute();
    $result = $stmt->get_result();
    if ($result->num_rows === 0) {
        clearPendingLoginSession();
        unset($_SESSION['login_await']);
        sendError('Login session expired. Enter your email and password again.', 400);
    }
    $user = $result->fetch_assoc();

    $storedEmail = normalizeEmailIdentifier((string)($pending['email'] ?? ''));
    $currentEmail = normalizeEmailIdentifier((string)($user['email'] ?? ''));
    $storedPasswordHash = (string)($pending['password_hash'] ?? '');
    $currentPasswordHash = (string)($user['password'] ?? '');
    if (
        $storedEmail === ''
        || $storedPasswordHash === ''
        || !hash_equals($storedEmail, $currentEmail)
        || !hash_equals($storedPasswordHash, $currentPasswordHash)
    ) {
        clearPendingLoginSession();
        unset($_SESSION['login_await']);
        sendError('Login session changed. Enter your email and password again.', 400);
    }

    if ($user['status'] === 'locked') {
        clearPendingLoginSession();
        unset($_SESSION['login_await']);
        sendError('Your account has been locked due to too many failed login or captcha attempts. Please contact an administrator.', 403);
    }

    if ($user['status'] !== 'active') {
        clearPendingLoginSession();
        unset($_SESSION['login_await']);
        sendError('Account is not active', 403);
    }

    // Same strict chain as a normal login: verified OTP (when enabled) and
    // a real captcha verification. No direct-call bypass.
    if (isLoginOtpEnabled($conn) && empty($pending['otp_verified'])) {
        unset($_SESSION['login_await']);
        sendError('Please verify the code sent to your email first.', 400, [
            'field' => 'otp',
            'code' => 'otp_required',
        ]);
    }
    if (!isMathCaptchaVerified()) {
        unset($_SESSION['login_await']);
        sendError('Please complete the math image verification first.', 400, [
            'field' => 'math_answer',
            'code' => 'captcha_required',
        ]);
    }

    $user = preparePasswordExpirationForUser($conn, $user);
    unset($_SESSION['login_await']);
    sendAuthenticatedLoginResponse($conn, $user);
}

/**
 * POST - Active holder decides on a held login.
 * Body: { decision: 'approve' | 'deny' }
 * Approve = sign this device out so the newcomer can proceed.
 * Deny (Stay) = keep this session; the newcomer cannot log in.
 */
function handleLoginDecision($conn) {
    requireAuth();
    $uid = intval($_SESSION['user_id'] ?? 0);
    if ($uid <= 0) {
        sendError('Not authenticated', 401);
    }
    $data = getJSONInput();
    $rawDecision = $data['decision'] ?? '';
    $allow = $rawDecision === true || $rawDecision === 1
        || in_array(strtolower(trim((string)$rawDecision)), ['approve', 'allow', '1', 'true'], true);

    ensureLoginApprovalStorage($conn);
    expireStaleLoginApprovals($conn);
    $req = getPendingLoginApproval($conn, $uid);
    if (!is_array($req)) {
        sendError('No pending login request (it may have expired).', 410);
    }

    if ($allow) {
        setLoginApprovalStatus($conn, (int)$req['id'], 'approved');
        $deviceDesc = trim((string)($req['device'] ?? '')) !== '' ? (string)$req['device'] : 'another device';
        logActivity($conn, $uid, 'session_takeover', "User approved a sign-in from {$deviceDesc}; this session was signed out", 'authentication');
        clearSessionPresenceByUser($uid, $conn);
        if (session_status() === PHP_SESSION_ACTIVE) {
            $cookieParams = session_get_cookie_params();
            setcookie(
                session_name(),
                '',
                time() - 42000,
                $cookieParams['path'] ?? '/',
                $cookieParams['domain'] ?? '',
                $cookieParams['secure'] ?? false,
                $cookieParams['httponly'] ?? true
            );
            session_unset();
            session_destroy();
        }
        sendResponse(true, ['approved' => true], 'Approved. You have been signed out.');
    }

    setLoginApprovalStatus($conn, (int)$req['id'], 'denied');
    logActivity($conn, $uid, 'session_takeover', 'User stayed signed in; denied a sign-in from another device', 'authentication');
    sendResponse(true, ['approved' => false], 'Stayed signed in. The other sign-in was denied.');
}

/**
 * POST - Newcomer cancels its held login request.
 */
function handleLoginCancel($conn) {
    $reqId = intval($_SESSION['login_await'] ?? 0);
    unset($_SESSION['login_await']);
    if ($reqId > 0) {
        ensureLoginApprovalStorage($conn);
        setLoginApprovalStatus($conn, $reqId, 'expired');
    }
    sendResponse(true, ['cancelled' => true], 'Login request cancelled.');
}

/**
 * GET - Public lockdown status (no auth required)
 */
function handlePublicLockdownStatus($conn) {
    $state = getSystemLockdownState($conn);

    sendResponse(true, [
        'enabled' => !empty($state['enabled']),
        'reason' => (string)($state['reason'] ?? ''),
        'updated_at' => (string)($state['updated_at'] ?? ''),
    ], 'Lockdown status retrieved.');
}

/**
 * POST - Forgot password (request reset link)
 * Payload: { email }
 */
function handleForgotPassword($conn) {
    $data = getJSONInput();
    $email = normalizeEmailIdentifier($data['email'] ?? ($data['usernameOrEmail'] ?? ''));

    if ($email === '') {
        sendError('Missing required fields: email', 400);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        sendError('Please enter a valid email address.', 400);
    }

    // hCaptcha is mandatory for every forgot-password request (all roles)
    // whenever it is configured — the emailed OTP is never sent without a
    // solved challenge first. (This is separate from the login captcha.)
    $captchaToken = trim((string)($data['captchaToken'] ?? ''));
    $hcaptchaSecret = getHcaptchaSecret();
    if ($hcaptchaSecret !== '') {
        if ($captchaToken === '') {
            sendError('Please complete the CAPTCHA challenge first.', 400);
        }
        $captchaError = verifyHcaptchaTokenRaw($captchaToken);
        if ($captchaError !== null) {
            sendError($captchaError, 400);
        }
    }

    ensureTOTPColumns($conn);

    // fp_request_count / fp_window_start columns are added by ensureAuthSchema on every
    // request, so they will always exist by the time we reach this point.

    // Lookup user by email
    $sql = "SELECT id, username, email, first_name, last_name, status, role,
                   reset_request_count, reset_request_window_start,
                   fp_request_count, fp_window_start
            FROM users
            WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $res = $stmt->get_result();

    // Generic response for inactive accounts or accounts without email
    $genericMsg = 'If the account exists, a password reset email has been sent.';

    if ($res->num_rows === 0) {
        // Unknown email: fail fast with 404 and send nothing — no OTP,
        // no code, no email of any kind is prepared or dispatched below.
        sendError('Email not found.', 404, ['code' => 'email_not_found']);
    }

    $user = $res->fetch_assoc();

    // Locked accounts get the same generic response as unknown/inactive ones:
    // confirming "this email belongs to a locked account" would leak
    // account existence to anyone typing emails into this form.
    if ($user['status'] === 'locked') {
        sendResponse(true, null, $genericMsg);
    }

    if ($user['status'] !== 'active') {
        sendResponse(true, null, $genericMsg);
    }

    // ── Forgot-password rate limit: max 3 requests per 3-minute window per account ──
    $fpMaxRequests = 3;
    $fpWindowSecs  = 180; // 3 minutes

    $fpCount       = (int)($user['fp_request_count'] ?? 0);
    $fpWindowStart = (string)($user['fp_window_start'] ?? '');
    $now           = time();

    // Reset the window if it has expired.
    if ($fpWindowStart === '' || ($now - strtotime($fpWindowStart)) >= $fpWindowSecs) {
        $fpCount       = 0;
        $fpWindowStart = date('Y-m-d H:i:s', $now);
    }

    if ($fpCount >= $fpMaxRequests) {
        $windowEndsAt    = strtotime($fpWindowStart) + $fpWindowSecs;
        $retryAfter      = max(1, $windowEndsAt - $now);
        $mins            = (int)ceil($retryAfter / 60);
        $label           = $mins === 1 ? '1 minute' : "{$mins} minutes";
        sendError(
            "Too many password reset requests. Please wait {$label} before trying again.",
            429,
            ['retry_after_seconds' => $retryAfter]
        );
    }

    // Increment counter for this request.
    $fpCount++;
    $upFp = $conn->prepare(
        "UPDATE users SET fp_request_count = ?, fp_window_start = ? WHERE id = ?"
    );
    if ($upFp) {
        $upFp->bind_param('isi', $fpCount, $fpWindowStart, $user['id']);
        $upFp->execute();
        $upFp->close();
    }

    // --- All roles: send email verification code (OTP) ---
    if (!$user['email']) {
        sendResponse(true, null, $genericMsg);
    }

    // Start fresh for each forgot-password attempt.
    clearAdminForgotPasswordSession();
    clearAdminForgotPasswordEmailCode($conn, (int)$user['id']);

    // Prepare code + DB write; get back a mail-send closure.
    $mailCallback = prepareAdminForgotPasswordEmailCode($conn, $user);
    $_SESSION['admin_forgot_password_user_id'] = (int)$user['id'];
    $_SESSION['admin_forgot_password_totp_verified_at'] = time();

    // Return success only after Resend confirms delivery. The former
    // background callback reported success before the email request completed.
    if (!$mailCallback()) {
        clearAdminForgotPasswordSession();
        clearAdminForgotPasswordEmailCode($conn, (int)$user['id']);
        sendError('We could not send the password reset code. Check the email service configuration or contact the administrator.', 503, [
            'code' => 'email_delivery_failed',
        ]);
    }
    sendResponse(true, ['emailCodeSent' => true], 'A verification code has been sent to your email address.');
}

/**
 * Resolve the browser fingerprint key for the current request (mirrors browser-lockout.php).
 */
function getBrowserLockoutKey() {
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
    if ($xff !== '' && isPrivateOrLocalhost($remote)) {
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') $remote = $candidate;
    }
    $ua = trim((string)($_SERVER['HTTP_USER_AGENT'] ?? ''));
    return 'bk_' . substr(hash('sha256', $remote . '|' . $ua), 0, 40);
}

/**
 * Return true if the current browser is blocked in browser_lockout_attempts.
 * Silently returns false if the table doesn't exist yet.
 */
function isBrowserLockedOut($conn) {
    if (!$conn || !(isDbConnection($conn))) return false;

    // Check table exists first (it may not exist on a fresh install before first lockout-check)
    $tableCheck = $conn->query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'browser_lockout_attempts' LIMIT 1");
    if (!$tableCheck || $tableCheck->num_rows === 0) {
        return false;
    }

    $key = getBrowserLockoutKey();
    $stmt = $conn->prepare("SELECT is_blocked FROM browser_lockout_attempts WHERE browser_key = ? LIMIT 1");
    if (!$stmt) return false;
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $row && (bool)$row['is_blocked'];
}

/**
 * Clear failed login counters for a user after a successful login or manual unlock.
 * The storage columns keep their historical names for backward compatibility.
 */
function clearAccountLockoutCounter($conn, $userId) {
    $id = (int)$userId;
    if ($id <= 0) return;

    $stmt = $conn->prepare(
        "UPDATE users
         SET reset_request_count = 0,
             reset_request_window_start = NULL,
             lockout_cooldown_until = NULL
         WHERE id = ?"
    );
    if (!$stmt) return;

    $stmt->bind_param('i', $id);
    $stmt->execute();
    $stmt->close();
}

/**
 * Check and increment the failed-login counter for a user.
 * If lockout is enabled and the threshold is reached, lock the account.
 * The storage columns keep their historical names for backward compatibility.
 * @return string 'ok' or 'locked'
 */
function checkAndIncrementLoginFailureCounter($conn, $user) {
    // Load lockout settings.
    $settingsStmt = $conn->prepare(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('lockout_enabled','lockout_window_hours')"
    );
    $settingsStmt->execute();
    $settingsResult = $settingsStmt->get_result();
    $cfg = [];
    while ($r = $settingsResult->fetch_assoc()) {
        $cfg[$r['setting_key']] = $r['setting_value'];
    }
    $settingsStmt->close();

    $enabled = ($cfg['lockout_enabled'] ?? '1') === '1';
    if (!$enabled) {
        return [
            'status' => 'disabled',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => null,
        ];
    }

    // Admin accounts are exempt from lockout — only staff and manager are affected.
    $role = strtolower(trim($user['role'] ?? ''));
    if ($role === 'admin') {
        return [
            'status' => 'admin_exempt',
            'failed_attempts' => 0,
            'remaining_attempts' => null,
            'threshold' => null,
        ];
    }

    // Attempts counting applies to staff and manager: a right
    // email + wrong password always consumes an attempt and reports how many
    // remain before lockout.

    // Per-role threshold from the Account Lockout settings page
    // (lockout_threshold_manager / lockout_threshold_staff), with a generic fallback.
    $threshold = getLockoutThresholdForRole($conn, $user['role'] ?? null);
    $windowHours = (int)($cfg['lockout_window_hours'] ?? 24);

    $count       = (int)($user['reset_request_count'] ?? 0);
    $windowStart = $user['reset_request_window_start'] ?? null;

    // If no window set, or window expired, reset counter
    if (!$windowStart || (strtotime($windowStart) + $windowHours * 3600) < time()) {
        $count = 0;
        $windowStart = date('Y-m-d H:i:s');
    }

    $count++;
    // Cooldown settings — needed to decide whether lock should be delayed by one attempt
    $cooldownStartAttempt = getLockoutCooldownStartAttempt($conn);
    $retryDelaySeconds = getLockoutRetryDelaySeconds($conn);
    $cooldownEnabled = $retryDelaySeconds > 0 && $cooldownStartAttempt > 0;

    // When cooldown is enabled and it starts at or before the threshold, the
    // threshold attempt should trigger a cooldown first, and the account should
    // only be auto-locked after N cooldown cycles beyond the threshold.
    // e.g. threshold=3, start=2, delay=30s, maxCooldown=3 → attempt 2 waits 30s,
    // 3 waits 60s, 4 waits 90s, 5 waits 120s, attempt 6 locks.
    $effectiveLockThreshold = $threshold;
    if ($cooldownEnabled && $cooldownStartAttempt <= $threshold) {
        $maxCooldownAttempts = getLockoutMaxCooldownAttempts($conn);
        $effectiveLockThreshold = $threshold + max(1, $maxCooldownAttempts);
    }
    $remainingAttempts = max(0, $threshold - $count);

    // "Attempt return" countdown: if cooldown is due, it takes precedence over
    // an immediate lock at the threshold so the user experiences a wait first.
    // The wait ESCALATES: every further wrong attempt multiplies the base wait
    // by the cooldown cycle number (30s, 60s, 90s, …), capped at 1 hour, until
    // the max cycles are exhausted and the account hard-locks per settings.
    if ($cooldownEnabled && $count >= $cooldownStartAttempt && $count < $effectiveLockThreshold) {
        ensureLockoutCooldownColumn($conn);
        $cooldownCycle = max(1, $count - $cooldownStartAttempt + 1);
        $thisCooldownSeconds = min(3600, $retryDelaySeconds * $cooldownCycle);
        $cooldownUntil = date('Y-m-d H:i:s', time() + $thisCooldownSeconds);
        $cdStmt = $conn->prepare(
            "UPDATE users SET reset_request_count = ?, reset_request_window_start = ?, lockout_cooldown_until = ? WHERE id = ?"
        );
        if ($cdStmt) {
            $cdStmt->bind_param('issi', $count, $windowStart, $cooldownUntil, $user['id']);
            $cdStmt->execute();
            $cdStmt->close();
        }

        return [
            'status' => 'cooldown',
            'failed_attempts' => $count,
            'remaining_attempts' => $remainingAttempts,
            'threshold' => $threshold,
            'retry_after_seconds' => $thisCooldownSeconds,
        ];
    }

    if ($count >= $effectiveLockThreshold) {
        // Lock the account (only after cooldown has been given a chance)
        $lockStmt = $conn->prepare(
            "UPDATE users SET status = 'locked', reset_request_count = ?, reset_request_window_start = ? WHERE id = ?"
        );
        $lockStmt->bind_param('isi', $count, $windowStart, $user['id']);
        $lockStmt->execute();
        $lockStmt->close();

        logActivity($conn, $user['id'], 'account_locked',
            "Account locked after {$count} failed login or captcha attempts (threshold: {$threshold})",
            'security');

        return [
            'status' => 'locked',
            'failed_attempts' => $count,
            'remaining_attempts' => 0,
            'threshold' => $threshold,
        ];
    }

    // Just increment the counter
    $incStmt = $conn->prepare(
        "UPDATE users SET reset_request_count = ?, reset_request_window_start = ? WHERE id = ?"
    );
    $incStmt->bind_param('isi', $count, $windowStart, $user['id']);
    $incStmt->execute();
    $incStmt->close();

    return [
        'status' => 'ok',
        'failed_attempts' => $count,
        'remaining_attempts' => $remainingAttempts,
        'threshold' => $threshold,
    ];
}

function clearAdminForgotPasswordSession() {
    unset($_SESSION['admin_forgot_password_user_id']);
    unset($_SESSION['admin_forgot_password_totp_verified_at']);
    unset($_SESSION['admin_forgot_password_email_verified_user_id']);
    unset($_SESSION['admin_forgot_password_email_verified_at']);
}

function clearAdminForgotPasswordEmailCode($conn, $userId) {
    ensureColumn($conn, 'users', 'forgot_admin_email_code_hash', 'forgot_admin_email_code_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'forgot_admin_email_code_expires', 'forgot_admin_email_code_expires DATETIME NULL');

    $id = (int)$userId;
    $stmt = $conn->prepare("UPDATE users SET forgot_admin_email_code_hash = NULL, forgot_admin_email_code_expires = NULL WHERE id = ?");
    $stmt->bind_param('i', $id);
    $stmt->execute();
}

function generateAlphaCode($length = 6) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    $out = '';
    for ($i = 0; $i < $length; $i++) {
        $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $out;
}

/**
 * Build the email HTML and write the code to the DB. Returns a mail closure.
 */
function prepareAdminForgotPasswordEmailCode($conn, $user): \Closure {
    $userId = (int)$user['id'];
    $email  = trim((string)($user['email'] ?? ''));
    if ($email === '') {
        sendError('Email is not configured for this account. Please contact system support.', 400);
    }

    ensureColumn($conn, 'users', 'forgot_admin_email_code_hash', 'forgot_admin_email_code_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'forgot_admin_email_code_expires', 'forgot_admin_email_code_expires DATETIME NULL');

    $code      = generateAlphaCode(6);
    $codeHash  = hash('sha256', $code);
    $expiresAt = date('Y-m-d H:i:s', time() + 10 * 60); // 10 minutes

    $up = $conn->prepare("UPDATE users SET forgot_admin_email_code_hash = ?, forgot_admin_email_code_expires = ? WHERE id = ?");
    $up->bind_param('ssi', $codeHash, $expiresAt, $userId);
    if (!$up->execute()) {
        sendError('Failed to store email verification code', 500);
    }

    $fullName = trim((string)($user['first_name'] ?? '') . ' ' . (string)($user['last_name'] ?? ''));
    $subject  = 'Your password reset verification code';
    $frontendBase = getFrontendBaseUrl();
    $resetUrl = $frontendBase !== ''
        ? rtrim($frontendBase, '/') . '/forgot-password/?email=' . rawurlencode($email)
        : '';
    $resetLink = $resetUrl !== ''
        ? '<p><a href="' . htmlspecialchars($resetUrl, ENT_QUOTES, 'UTF-8') . '">Continue password reset</a></p>'
        : '';
    $html     = "<p>Hi " . htmlspecialchars($fullName ?: (string)($user['username'] ?? 'Admin'), ENT_QUOTES, 'UTF-8') . ",</p>"
              . "<p>Your 6-letter verification code is:</p>"
              . "<h2 style=\"letter-spacing:3px\">" . htmlspecialchars($code) . "</h2>"
              . "<p>This code expires in 10 minutes. If this was not you, secure your account immediately.</p>"
              . $resetLink;

    return function () use ($conn, $userId, $email, $fullName, $subject, $html) {
        $sent = function_exists('sendPasswordResetEmail')
            ? sendPasswordResetEmail($email, $fullName, $subject, $html)
            : false;
        if (!$sent) {
            error_log('Forgot-password email code failed to send for user_id=' . $userId);
        }
        logActivity($conn, $userId, 'forgot_password_admin_email_code',
            $sent ? 'Sent forgot-password email code' : 'Failed to send forgot-password email code',
            'authentication');
        return $sent;
    };
}

/**
 * POST - Verify TOTP code only (admin forgot-password step 1)
 * Payload: { email, pin }
 */
function handleForgotPasswordVerifyTOTP($conn) {
    $data = getJSONInput();
    $email = normalizeEmailIdentifier($data['email'] ?? ($data['usernameOrEmail'] ?? ''));
    $pin = preg_replace('/\D+/', '', (string)($data['pin'] ?? ''));

    if ($email === '') sendError('Missing email', 400);
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) sendError('Please enter a valid email address.', 400);
    if (strlen($pin) !== 6) sendError('Invalid authenticator code', 400);

    ensureTOTPColumns($conn);

    $sql = "SELECT id, username, email, first_name, last_name, status, role, totp_secret, totp_enabled
            FROM users
            WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('Invalid credentials', 400);
    if ($u['status'] !== 'active') sendError('Account is not active', 403);
    if ($u['role'] !== 'admin') sendError('This method is only for admin accounts', 403);
    if (!$u['totp_secret']) sendError('TOTP is not set up', 400);

    $secret = $u['totp_secret'];
    $ok = validateTOTP($secret, $pin);
    if (!$ok) sendError('Invalid authenticator code', 400);

    // Enable TOTP if this is the first successful validation
    if (!(bool)$u['totp_enabled']) {
        $conn->query("UPDATE users SET totp_enabled = 1 WHERE id = " . intval($u['id']));
    }

    $mailCallback = prepareAdminForgotPasswordEmailCode($conn, $u);

    $_SESSION['admin_forgot_password_user_id'] = (int)$u['id'];
    $_SESSION['admin_forgot_password_totp_verified_at'] = time();
    unset($_SESSION['admin_forgot_password_email_verified_user_id']);
    unset($_SESSION['admin_forgot_password_email_verified_at']);

    // Respond immediately, send the email in the background.
    sendResponseAndContinue(
        true,
        ['verified' => true, 'emailCodeSent' => true],
        'Authenticator verified. A 6-letter code was sent to your admin email.',
        200,
        $mailCallback
    );
}

/**
 * POST - Verify email code after authenticator verification (admin forgot-password step 2)
 * Payload: { email, emailCode }
 */
function handleForgotPasswordVerifyEmailCode($conn) {
    $data = getJSONInput();
    $email = normalizeEmailIdentifier($data['email'] ?? ($data['usernameOrEmail'] ?? ''));
    $emailCode = strtoupper(trim((string)($data['emailCode'] ?? '')));
    $emailCode = preg_replace('/[^A-Z]/', '', $emailCode);

    if ($email === '') sendError('Missing email', 400);
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) sendError('Please enter a valid email address.', 400);
    if (strlen($emailCode) !== 6) sendError('Invalid email verification code', 400);

    ensureColumn($conn, 'users', 'forgot_admin_email_code_hash', 'forgot_admin_email_code_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'forgot_admin_email_code_expires', 'forgot_admin_email_code_expires DATETIME NULL');

    $sql = "SELECT id, username, status, role, forgot_admin_email_code_hash, forgot_admin_email_code_expires
            FROM users
            WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('Invalid credentials', 400);
    if ($u['status'] !== 'active') sendError('Account is not active', 403);

    $sessionUserId = (int)($_SESSION['admin_forgot_password_user_id'] ?? 0);
    $flowStartAt = (int)($_SESSION['admin_forgot_password_totp_verified_at'] ?? 0);
    if (
        $sessionUserId !== (int)$u['id'] ||
        $flowStartAt <= 0 ||
        (time() - $flowStartAt) > (15 * 60)
    ) {
        clearAdminForgotPasswordSession();
        sendError('Session expired. Please start the password reset process again.', 400);
    }

    $storedHash = (string)($u['forgot_admin_email_code_hash'] ?? '');
    $expiresAt = (string)($u['forgot_admin_email_code_expires'] ?? '');
    if ($storedHash === '' || $expiresAt === '') {
        sendError('Email code not requested or expired. Please start the process again.', 400);
    }

    if (strtotime($expiresAt) < time()) {
        clearAdminForgotPasswordEmailCode($conn, (int)$u['id']);
        unset($_SESSION['admin_forgot_password_email_verified_user_id']);
        unset($_SESSION['admin_forgot_password_email_verified_at']);
        sendError('Email code expired. Please start the process again.', 400);
    }

    $incomingHash = hash('sha256', $emailCode);
    if (!hash_equals($storedHash, $incomingHash)) {
        sendError('Invalid email verification code', 400);
    }

    clearAdminForgotPasswordEmailCode($conn, (int)$u['id']);
    $_SESSION['admin_forgot_password_email_verified_user_id'] = (int)$u['id'];
    $_SESSION['admin_forgot_password_email_verified_at'] = time();

    sendResponse(true, ['emailVerified' => true], 'Email code verified. You may now set a new password.');
}

/**
 * POST - Set new password after admin forgot-password verification
 * Payload: { email, newPassword }
 */
function handleForgotPasswordTOTP($conn) {
    $data = getJSONInput();
    $email = normalizeEmailIdentifier($data['email'] ?? ($data['usernameOrEmail'] ?? ''));
    $newPassword = (string)($data['newPassword'] ?? '');
    // NOTE: no current-password here by design — this is the FORGOT password
    // flow (the user cannot know it). The verified email-code session below
    // is the ownership proof. Current password is only required in the
    // authenticated change-password flows (change_password_with_otp, etc.).

    if ($email === '') sendError('Missing email', 400);
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) sendError('Please enter a valid email address.', 400);
    if (strlen($newPassword) < 8) sendError('Password must be at least 8 characters', 400);
    if (!preg_match('/[A-Z]/', $newPassword)) sendError('Password must contain at least one uppercase letter', 400);
    if (!preg_match('/[0-9]/', $newPassword)) sendError('Password must contain at least one number', 400);
    if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $newPassword)) sendError('Password must contain at least one special character', 400);

    $sql = "SELECT id, username, status, role, password, email, first_name, last_name FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('s', $email);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('Invalid credentials', 400);
    if ($u['status'] !== 'active') sendError('Account is not active', 403);

    $now = time();
    $sessionUserId = (int)($_SESSION['admin_forgot_password_user_id'] ?? 0);
    $flowStartAt = (int)($_SESSION['admin_forgot_password_totp_verified_at'] ?? 0);
    $emailVerifiedUserId = (int)($_SESSION['admin_forgot_password_email_verified_user_id'] ?? 0);
    $emailVerifiedAt = (int)($_SESSION['admin_forgot_password_email_verified_at'] ?? 0);
    $ttl = 15 * 60;

    if (
        $sessionUserId !== (int)$u['id'] ||
        $flowStartAt <= 0 ||
        ($now - $flowStartAt) > $ttl
    ) {
        clearAdminForgotPasswordSession();
        sendError('Session expired. Please start the password reset process again.', 400);
    }

    if (
        $emailVerifiedUserId !== (int)$u['id'] ||
        $emailVerifiedAt <= 0 ||
        ($now - $emailVerifiedAt) > $ttl
    ) {
        sendError('Please verify the email code before setting a new password.', 400);
    }

    // The verified email code proves inbox access + account ownership
    // (it was sent to the account email and gated by the server session).

    // Update password with history and expiration metadata.
    ensurePasswordPolicySchema($conn);
    $policy = getPasswordPolicy($conn);
    $hashed = validateAndHashPasswordForChange($conn, $u['id'], $newPassword, (string)($u['password'] ?? ''), $policy['history_count']);
    persistPasswordChange($conn, (int)$u['id'], $hashed, (string)($u['password'] ?? ''), $policy['history_count'], $policy['max_age_days'], true);

    clearAdminForgotPasswordEmailCode($conn, (int)$u['id']);
    clearAdminForgotPasswordSession();

    logActivity($conn, $u['id'], 'forgot_password_totp', 'User reset password via email code (forgot password)', 'authentication');

    // The caller only sets this flag when the new password came from the
    // "suggest a strong password" picker — email a copy to the account's
    // Gmail since generated passwords are hard to remember. Safe here: the
    // verified email-code session gates this endpoint,
    // and the recipient is the account email from the database.
    $passwordEmailed = false;
    if (!empty($data['emailGeneratedPassword'])) {
        $accountEmail = trim((string)($u['email'] ?? ''));
        $accountName = trim(trim((string)($u['first_name'] ?? '')) . ' ' . trim((string)($u['last_name'] ?? '')));
        if ($accountName === '') $accountName = trim((string)($u['username'] ?? ''));
        if (function_exists('sendGeneratedPasswordEmail') && $accountEmail !== '') {
            $passwordEmailed = (bool)sendGeneratedPasswordEmail($accountEmail, $accountName, $newPassword);
            logActivity($conn, (int)$u['id'], 'forgot_password_totp', $passwordEmailed ? 'Emailed copy of suggested password to account Gmail' : 'Failed to email suggested password copy', 'authentication');
        }
    }

    sendResponse(true, ['passwordEmailed' => $passwordEmailed], 'Password reset successfully. You can now log in.');
}

/**
 * POST - Reset password
 * Payload: { token, newPassword }
 */
function handleResetPassword($conn) {
    $data = getJSONInput();
    $required = ['token', 'newPassword'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $token = (string)$data['token'];
    $newPassword = (string)$data['newPassword'];

    if (strlen($newPassword) < 8) {
        sendError('Password must be at least 8 characters', 400);
    }
    if (!preg_match('/[A-Z]/', $newPassword)) {
        sendError('Password must contain at least one uppercase letter', 400);
    }
    if (!preg_match('/[0-9]/', $newPassword)) {
        sendError('Password must contain at least one number', 400);
    }
    if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $newPassword)) {
        sendError('Password must contain at least one special character', 400);
    }

    ensureColumn($conn, 'users', 'must_reset_password', 'must_reset_password TINYINT(1) NOT NULL DEFAULT 0');

    $token_hash = hash('sha256', $token);

    $sql = "SELECT id, status, password, reset_token_expires, email, first_name, last_name, username FROM users WHERE reset_token_hash = ? LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('s', $token_hash);
    $stmt->execute();
    $res = $stmt->get_result();

    if ($res->num_rows === 0) {
        sendError('Invalid or expired token', 400);
    }

    $user = $res->fetch_assoc();

    if ($user['status'] !== 'active') {
        sendError('Account is not active', 403);
    }

    if (!$user['reset_token_expires'] || strtotime($user['reset_token_expires']) < time()) {
        sendError('Invalid or expired token', 400);
    }

    $policy = getPasswordPolicy($conn);
    $hashed = validateAndHashPasswordForChange($conn, $user['id'], $newPassword, (string)($user['password'] ?? ''), $policy['history_count']);
    persistPasswordChange($conn, (int)$user['id'], $hashed, (string)($user['password'] ?? ''), $policy['history_count'], $policy['max_age_days'], true);

    $clear = $conn->prepare("UPDATE users SET reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?");
    $clear->bind_param('i', $user['id']);
    $clear->execute();
    $clear->close();

    logActivity($conn, $user['id'], 'reset_password', 'Password reset successful', 'authentication');

    // Same suggested-password copy as the forgot-password flow. Safe here:
    // the single-use reset token proves inbox access, and the recipient is
    // the account email from the database.
    $passwordEmailed = false;
    if (!empty($data['emailGeneratedPassword'])) {
        $accountEmail = trim((string)($user['email'] ?? ''));
        $accountName = trim(trim((string)($user['first_name'] ?? '')) . ' ' . trim((string)($user['last_name'] ?? '')));
        if ($accountName === '') $accountName = trim((string)($user['username'] ?? ''));
        if (function_exists('sendGeneratedPasswordEmail') && $accountEmail !== '') {
            $passwordEmailed = (bool)sendGeneratedPasswordEmail($accountEmail, $accountName, $newPassword);
            logActivity($conn, (int)$user['id'], 'reset_password', $passwordEmailed ? 'Emailed copy of suggested password to account Gmail' : 'Failed to email suggested password copy', 'authentication');
        }
    }

    sendResponse(true, ['passwordEmailed' => $passwordEmailed], 'Password updated successfully');
}

/**
 * POST - Change temporary password after first login (authenticated only)
 * Payload: { newPassword }
 */
function handleFirstLoginChangePassword($conn) {
    if (!isset($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }

    $data = getJSONInput();
    $required = ['newPassword'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $newPassword = (string)$data['newPassword'];
    // Optional: the dedicated first-login page omits it (the temporary
    // session itself proves recent authentication), while other callers
    // (e.g. PasswordChangeModal) still send it and get it verified.
    $currentPassword = isset($data['currentPassword']) ? (string)$data['currentPassword'] : '';
    if (strlen($newPassword) < 8) {
        sendError('Password must be at least 8 characters', 400);
    }
    if (!preg_match('/[A-Z]/', $newPassword)) {
        sendError('Password must contain at least one uppercase letter', 400);
    }
    if (!preg_match('/[0-9]/', $newPassword)) {
        sendError('Password must contain at least one number', 400);
    }
    if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $newPassword)) {
        sendError('Password must contain at least one special character', 400);
    }

    ensureColumn($conn, 'users', 'must_reset_password', 'must_reset_password TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'users', 'reset_token_hash', 'reset_token_hash VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'reset_token_expires', 'reset_token_expires DATETIME NULL');
    ensurePasswordPolicySchema($conn);

    $policy = getPasswordPolicy($conn);
    $userId = (int)$_SESSION['user_id'];
    $stmt = $conn->prepare("SELECT id, role, status, password, must_reset_password, password_changed_at, password_expires_at, email, first_name, last_name, username FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $res = $stmt->get_result();

    if ($res->num_rows === 0) {
        session_destroy();
        sendError('Session invalid', 401);
    }

    $user = $res->fetch_assoc();

    if ($user['status'] !== 'active') {
        sendError('Account is not active', 403);
    }
    if ((int)($user['must_reset_password'] ?? 0) !== 1) {
        sendError('Password change is not required for this account.', 400);
    }
    // Verify the temporary password only when the caller supplies it.
    // Possession of the must-reset session is sufficient otherwise.
    if ($currentPassword !== '' && !verifyPassword($currentPassword, (string)($user['password'] ?? ''))) {
        sendError('Current password is incorrect.', 401);
    }
    if (verifyPassword($newPassword, (string)$user['password'])) {
        sendError('New password must be different from your current password.', 400);
    }

    $hashed = validateAndHashPasswordForChange($conn, $userId, $newPassword, (string)($user['password'] ?? ''), $policy['history_count']);
    persistPasswordChange($conn, $userId, $hashed, (string)($user['password'] ?? ''), $policy['history_count'], $policy['max_age_days'], true);

    $_SESSION['must_reset_password'] = 0;
    $_SESSION['password_change_reason'] = '';
    logActivity($conn, $userId, 'first_login_password_change', 'User changed temporary password after first login', 'authentication');

    // Same suggested-password copy. Safe here: the caller is authenticated
    // and the recipient is their own account email from the database.
    $passwordEmailed = false;
    if (!empty($data['emailGeneratedPassword'])) {
        $accountEmail = trim((string)($user['email'] ?? ''));
        $accountName = trim(trim((string)($user['first_name'] ?? '')) . ' ' . trim((string)($user['last_name'] ?? '')));
        if ($accountName === '') $accountName = trim((string)($user['username'] ?? ''));
        if (function_exists('sendGeneratedPasswordEmail') && $accountEmail !== '') {
            $passwordEmailed = (bool)sendGeneratedPasswordEmail($accountEmail, $accountName, $newPassword);
            logActivity($conn, $userId, 'first_login_password_change', $passwordEmailed ? 'Emailed copy of suggested password to account Gmail' : 'Failed to email suggested password copy', 'authentication');
        }
    }

    sendResponse(true, [
        'role' => $user['role'],
        'passwordEmailed' => $passwordEmailed,
    ], 'Password updated successfully');
}

/**
 * POST - Admin update own profile details (settings)
 * Payload: { username, email, first_name, last_name }
 */
function handleAdminUpdateProfile($conn) {
    if (!isset($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }

    $user_id = (int)$_SESSION['user_id'];
    $data = getJSONInput();

    $currentStmt = $conn->prepare("SELECT first_name, last_name FROM users WHERE id = ? LIMIT 1");
    $currentStmt->bind_param('i', $user_id);
    $currentStmt->execute();
    $currentUser = $currentStmt->get_result()->fetch_assoc();
    $currentStmt->close();
    if (!$currentUser) {
        sendError('User not found', 404);
    }

    $nextFirstName = array_key_exists('first_name', $data)
        ? normalizePersonName($data['first_name'], 50)
        : normalizePersonName($currentUser['first_name'] ?? '', 50);
    $nextLastName = array_key_exists('last_name', $data)
        ? normalizePersonName($data['last_name'], 50)
        : normalizePersonName($currentUser['last_name'] ?? '', 50);
    ensureUniqueUserFullName($conn, $nextFirstName, $nextLastName, $user_id);

    $allowed = ['username', 'email', 'first_name', 'last_name', 'mobile_number'];
    $updates = [];
    $types = '';
    $params = [];

    foreach ($allowed as $k) {
        if (array_key_exists($k, $data)) {
            $val = is_string($data[$k]) ? trim($data[$k]) : $data[$k];
            if ($k === 'email' && $val !== '' && !validateGmailComEmail($val)) {
                sendError('Email must be a valid @gmail.com or @phinmaed.com address', 400);
            }
            if ($k === 'email' && $val !== '') {
                // Ensure email is unique
                $check = $conn->prepare("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1");
                $check->bind_param('si', $val, $user_id);
                $check->execute();
                if ($check->get_result()->num_rows > 0) {
                    sendError('Email already in use', 409);
                }
            }
            if ($k === 'username') {
                $val = sanitizeInput($val);
                if ($val === '') {
                    sendError('Username cannot be empty', 400);
                }
                // ensure unique
                $check = $conn->prepare("SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1");
                $check->bind_param('si', $val, $user_id);
                $check->execute();
                if ($check->get_result()->num_rows > 0) {
                    sendError('Username already exists', 409);
                }
            }
            if ($k === 'first_name') {
                $val = $nextFirstName;
            }
            if ($k === 'last_name') {
                $val = $nextLastName;
            }
            if ($k === 'mobile_number') {
                $normalizedMobileNumber = normalizeInternationalPhoneNumber($val, '+63');
                if ($normalizedMobileNumber === false) {
                    sendError('Mobile number must be a valid international number', 400);
                }
                $val = $normalizedMobileNumber ?? '';
            }

            $updates[] = "$k = ?";
            $types .= 's';
            $params[] = $val;
        }
    }

    if (empty($updates)) {
        sendError('No fields to update', 400);
    }

    $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
    $types .= 'i';
    $params[] = $user_id;

    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);

    if (!$stmt->execute()) {
        sendError('Failed to update profile', 500);
    }

    // Update session username if changed
    if (isset($data['username'])) {
        $_SESSION['username'] = trim((string)$data['username']);
    }
    if (isset($data['email'])) {
        $_SESSION['email'] = trim((string)$data['email']);
    }
    if (isset($data['first_name'])) {
        $_SESSION['first_name'] = $nextFirstName;
    }
    if (isset($data['last_name'])) {
        $_SESSION['last_name'] = $nextLastName;
    }

    // Sync first_name / last_name to employees table if linked
    $employee_id = $_SESSION['employee_id'] ?? null;
    if ($employee_id && (isset($data['first_name']) || isset($data['last_name']))) {
        $empUpdates = [];
        $empTypes = '';
        $empParams = [];
        if (isset($data['first_name'])) {
            $empUpdates[] = 'first_name = ?';
            $empTypes .= 's';
            $empParams[] = $nextFirstName;
        }
        if (isset($data['last_name'])) {
            $empUpdates[] = 'last_name = ?';
            $empTypes .= 's';
            $empParams[] = $nextLastName;
        }
        if (!empty($empUpdates)) {
            $empSql = "UPDATE employees SET " . implode(', ', $empUpdates) . " WHERE employee_id = ?";
            $empTypes .= 'i';
            $empParams[] = (int)$employee_id;
            $empStmt = $conn->prepare($empSql);
            $empStmt->bind_param($empTypes, ...$empParams);
            $empStmt->execute();
        }
    }

    logActivity($conn, $user_id, 'admin_update_profile', 'Admin updated profile details', 'authentication');

    // Return updated user
    $fetch = $conn->prepare("SELECT id, username, email, first_name, last_name, TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) AS full_name, role, status, photo, mobile_number FROM users WHERE id = ?");
    $fetch->bind_param('i', $user_id);
    $fetch->execute();
    $user = $fetch->get_result()->fetch_assoc();

    sendResponse(true, $user, 'Profile updated successfully');
}

/**
 * GET - Return password expiration and history policy (admin only).
 */
function handlePasswordPolicy($conn) {
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') {
        sendError('Forbidden', 403);
    }

    sendResponse(true, getPasswordPolicy($conn), 'Password policy retrieved');
}

/**
 * POST - Update password expiration and history policy (admin only).
 * Payload: { max_age_days, history_count }
 */
function handleUpdatePasswordPolicy($conn) {
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') {
        sendError('Forbidden', 403);
    }

    $data = getJSONInput();
    $maxAgeDays = isset($data['max_age_days']) ? (int)$data['max_age_days'] : 90;
    $historyCount = isset($data['history_count']) ? (int)$data['history_count'] : 5;
    $policy = updatePasswordPolicy($conn, $maxAgeDays, $historyCount);

    logActivity($conn, (int)$_SESSION['user_id'], 'update_password_policy', 'Updated password expiration and history policy', 'settings');

    sendResponse(true, $policy, 'Password policy updated');
}

/**
 * POST - Request OTP for changing password while logged in.
 * Payload: { }
 */
function handleRequestPasswordChangeOTP($conn) {
    if (!isset($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }

    $user_id = (int)$_SESSION['user_id'];

    $stmt = $conn->prepare("SELECT id, username, email, first_name, last_name, status FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $res = $stmt->get_result();

    if ($res->num_rows === 0) {
        sendError('User not found', 404);
    }

    $user = $res->fetch_assoc();
    if ($user['status'] !== 'active') {
        sendError('Account is not active', 403);
    }

    $toEmail = $user['email'];
    if (!$toEmail) {
        sendError('Email is not configured for this account. Please contact an administrator.', 400);
    }

    ensurePasswordPolicySchema($conn);

    $otp = strval(random_int(100000, 999999));
    $otpHash = hash('sha256', $otp);
    $expires_at = date('Y-m-d H:i:s', time() + 10 * 60); // 10 minutes

    $up = $conn->prepare("UPDATE users SET password_change_otp_hash = ?, password_change_otp_expires = ? WHERE id = ?");
    if (!$up) sendError('Failed to prepare OTP', 500);
    $up->bind_param('ssi', $otpHash, $expires_at, $user_id);
    if (!$up->execute()) {
        $up->close();
        sendError('Failed to store OTP', 500);
    }
    $up->close();

    // Respond to the browser immediately so the UI is never blocked by SMTP latency,
    // then send the email in the background callback.
    sendResponseAndContinue(true, null, 'OTP sent to your email.', 200, function () use ($user, $otp, $conn, $user_id) {
        $sent = sendPasswordChangeOtpEmail($user, $otp);
        logActivity($conn, $user_id, 'request_password_change_otp', $sent ? 'OTP sent' : 'OTP send failed', 'authentication');
        if (!$sent) {
            error_log('OTP email failed to send for user_id=' . $user_id);
        }
    });
}

/**
 * POST - Change password with OTP (admin settings)
 * Payload: { otp, newPassword }
 */
function handleChangePasswordWithOTP($conn) {
    if (!isset($_SESSION['user_id'])) {
        sendError('Not authenticated', 401);
    }

    $user_id = (int)$_SESSION['user_id'];
    $data = getJSONInput();

    $required = ['otp', 'newPassword', 'currentPassword'];
    $missing = validateRequiredFields($data, $required);
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $otp = preg_replace('/\D+/', '', (string)$data['otp']);
    $newPassword = (string)$data['newPassword'];
    $currentPassword = (string)$data['currentPassword'];

    if (strlen($otp) !== 6) {
        sendError('Invalid OTP', 400);
    }

    ensurePasswordPolicySchema($conn);

    $stmt = $conn->prepare("SELECT id, status, password, password_change_otp_hash, password_change_otp_expires FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $res = $stmt->get_result();

    if ($res->num_rows === 0) {
        sendError('User not found', 404);
    }

    $u = $res->fetch_assoc();

    if ($u['status'] !== 'active') {
        sendError('Account is not active', 403);
    }

    // Current password comes first: knowledge of the inbox (OTP) alone must
    // not be enough to take over the account from an unattended session.
    if ($currentPassword === '') {
        sendError('Enter your current password first.', 400);
    }
    if (!verifyPassword($currentPassword, (string)($u['password'] ?? ''))) {
        sendError('Current password is incorrect.', 401);
    }

    if (!$u['password_change_otp_hash'] || !$u['password_change_otp_expires']) {
        sendError('OTP not requested or expired', 400);
    }

    if (strtotime($u['password_change_otp_expires']) < time()) {
        $conn->query("UPDATE users SET password_change_otp_hash = NULL, password_change_otp_expires = NULL WHERE id = " . intval($user_id));
        sendError('OTP not requested or expired', 400);
    }

    $otpHash = hash('sha256', $otp);
    if (!hash_equals($u['password_change_otp_hash'], $otpHash)) {
        sendError('Invalid OTP', 400);
    }

    $policy = getPasswordPolicy($conn);
    $hashed = validateAndHashPasswordForChange($conn, $user_id, $newPassword, (string)($u['password'] ?? ''), $policy['history_count']);
    persistPasswordChange($conn, $user_id, $hashed, (string)($u['password'] ?? ''), $policy['history_count'], $policy['max_age_days'], true);

    $clear = $conn->prepare("UPDATE users SET password_change_otp_hash = NULL, password_change_otp_expires = NULL WHERE id = ?");
    $clear->bind_param('i', $user_id);
    $clear->execute();
    $clear->close();

    logActivity($conn, $user_id, 'change_password', 'User changed password via email OTP', 'authentication');

    sendResponse(true, null, 'Password changed successfully');
}

// --- AuthenticatorAPI.com (TOTP) ---

function ensureTOTPColumns($conn) {
    // best-effort
    ensureColumn($conn, 'users', 'totp_secret', 'totp_secret VARCHAR(64) NULL');
    ensureColumn($conn, 'users', 'totp_enabled', 'totp_enabled TINYINT(1) NOT NULL DEFAULT 0');
}

function generateTOTPSecret($length = 20) {
    // Base32 alphabet for TOTP secrets
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $secret = '';
    for ($i = 0; $i < $length; $i++) {
        $secret .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $secret;
}

/**
 * Validate a TOTP PIN locally using RFC 6238.
 * Checks current time window ±1 (30-second tolerance for clock drift).
 * @param string $secret Base32-encoded secret
 * @param string $pin 6-digit code
 * @return bool
 */
function validateTOTP($secret, $pin) {
    // Base32 decode the secret
    $base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $binary = '';
    $secret = strtoupper(rtrim($secret, '='));
    $buffer = 0;
    $bitsLeft = 0;
    for ($i = 0; $i < strlen($secret); $i++) {
        $val = strpos($base32chars, $secret[$i]);
        if ($val === false) continue;
        $buffer = ($buffer << 5) | $val;
        $bitsLeft += 5;
        if ($bitsLeft >= 8) {
            $bitsLeft -= 8;
            $binary .= chr(($buffer >> $bitsLeft) & 0xFF);
        }
    }

    // Check current, previous, and next 30-second windows (±1 tolerance)
    $timeStep = 30;
    $currentTime = time();
    for ($offset = -1; $offset <= 1; $offset++) {
        $counter = intdiv($currentTime, $timeStep) + $offset;
        // Pack counter as 8-byte big-endian
        $counterBytes = pack('N*', 0, $counter);
        $hash = hash_hmac('sha1', $counterBytes, $binary, true);
        // Dynamic truncation
        $offsetByte = ord($hash[strlen($hash) - 1]) & 0x0F;
        $code = (
            ((ord($hash[$offsetByte]) & 0x7F) << 24) |
            ((ord($hash[$offsetByte + 1]) & 0xFF) << 16) |
            ((ord($hash[$offsetByte + 2]) & 0xFF) << 8) |
            (ord($hash[$offsetByte + 3]) & 0xFF)
        ) % 1000000;

        $expectedPin = str_pad((string)$code, 6, '0', STR_PAD_LEFT);
        if (hash_equals($expectedPin, $pin)) {
            return true;
        }
    }
    return false;
}

/**
 * POST - Create/get pairing link for current admin
 * Response includes pairUrl that the user can open/scan.
 */
function handleTOTPpair($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    ensureTOTPColumns($conn);

    $user_id = (int)$_SESSION['user_id'];

    $stmt = $conn->prepare("SELECT id, username, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('User not found', 404);

    $data = getJSONInput();
    $regenerate = !empty($data['regenerate']);

    $secret = $u['totp_secret'];
    if (!$secret || $regenerate) {
        $secret = generateTOTPSecret(24);
        $up = $conn->prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?");
        $up->bind_param('si', $secret, $user_id);
        $up->execute();
    }

    $appName = urlencode(getenv('TOTP_APP_NAME') ?: 'LLB Accountants');
    $appInfo = urlencode($u['username']);
    $pairUrl = "https://www.authenticatorapi.com/pair.aspx?AppName={$appName}&AppInfo={$appInfo}&SecretCode=" . urlencode($secret);

    // Build otpauth URI for standard QR code generation
    $label = rawurlencode('LLB Accountants') . ':' . rawurlencode($u['username']);
    $otpauthUri = "otpauth://totp/{$label}?secret=" . urlencode($secret) . '&issuer=' . rawurlencode('LLB Accountants');

    sendResponse(true, [
        'pairUrl'    => $pairUrl,
        'qrCodeUrl'  => 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($otpauthUri),
        'secret'     => $secret,
        'enabled'    => (bool)$u['totp_enabled'],
    ], 'Pairing link generated');
}

/**
 * GET - Check current TOTP status for logged-in admin
 * Auto-generates a TOTP secret if one doesn't exist yet.
 */
function handleTOTPStatus($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    ensureTOTPColumns($conn);

    $user_id = (int)$_SESSION['user_id'];
    $stmt = $conn->prepare("SELECT username, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('User not found', 404);

    // Auto-generate a TOTP secret if one doesn't exist
    $secret = $u['totp_secret'];
    if (!$secret) {
        $secret = generateTOTPSecret(24);
        $up = $conn->prepare("UPDATE users SET totp_secret = ? WHERE id = ?");
        $up->bind_param('si', $secret, $user_id);
        $up->execute();
    }

    // Build QR code URL so frontend can always display it
    $label = rawurlencode('LLB Accountants') . ':' . rawurlencode($u['username']);
    $otpauthUri = "otpauth://totp/{$label}?secret=" . urlencode($secret) . '&issuer=' . rawurlencode('LLB Accountants');
    $qrCodeUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($otpauthUri);

    sendResponse(true, [
        'hasSecret'  => true,
        'enabled'    => (bool)$u['totp_enabled'],
        'secret'     => $secret,
        'qrCodeUrl'  => $qrCodeUrl,
    ], 'TOTP status');
}

/**
 * POST - Validate a TOTP PIN; enables TOTP on first successful validation.
 * Payload: { pin }
 */
function handleTOTPvalidate($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    ensureTOTPColumns($conn);

    $user_id = (int)$_SESSION['user_id'];
    $data = getJSONInput();
    $missing = validateRequiredFields($data, ['pin']);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $pin = preg_replace('/\D+/', '', (string)$data['pin']);
    if (strlen($pin) !== 6) sendError('Invalid code', 400);

    $stmt = $conn->prepare("SELECT id, username, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();
    if (!$u || !$u['totp_secret']) sendError('TOTP not set up', 400);

    $secret = $u['totp_secret'];
    $ok = validateTOTP($secret, $pin);
    if (!$ok) {
        sendError('Invalid code', 400);
    }

    if (!(bool)$u['totp_enabled']) {
        $conn->query("UPDATE users SET totp_enabled = 1 WHERE id = " . intval($user_id));
    }

    sendResponse(true, ['enabled' => true], 'Code verified');
}

/**
 * POST - Change password with TOTP
 * Payload: { pin, newPassword }
 */
function handleChangePasswordWithTOTP($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    ensureTOTPColumns($conn);

    $user_id = (int)$_SESSION['user_id'];
    $data = getJSONInput();
    $missing = validateRequiredFields($data, ['pin', 'newPassword']);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $pin = preg_replace('/\D+/', '', (string)$data['pin']);
    $newPassword = (string)$data['newPassword'];

    if (strlen($pin) !== 6) sendError('Invalid code', 400);
    if (strlen($newPassword) < 8) sendError('Password must be at least 8 characters', 400);
    if (!preg_match('/[A-Z]/', $newPassword)) sendError('Password must contain at least one uppercase letter', 400);
    if (!preg_match('/[0-9]/', $newPassword)) sendError('Password must contain at least one number', 400);
    if (!preg_match('/[!@#$%^&*()\-_=+\[\]{};:\'",.<>\/?\\\\|]/', $newPassword)) sendError('Password must contain at least one special character', 400);

    $stmt = $conn->prepare("SELECT id, username, status, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();

    if (!$u) sendError('User not found', 404);
    if ($u['status'] !== 'active') sendError('Account is not active', 403);
    if (!$u['totp_secret']) sendError('TOTP is not set up', 400);

    $secret = $u['totp_secret'];
    $ok = validateTOTP($secret, $pin);
    if (!$ok) sendError('Invalid code', 400);

    $hashed = hashPassword($newPassword);
    $up = $conn->prepare("UPDATE users SET password = ? WHERE id = ?");
    $up->bind_param('si', $hashed, $user_id);
    if (!$up->execute()) sendError('Failed to update password', 500);

    logActivity($conn, $user_id, 'change_password', 'Admin changed password via TOTP', 'authentication');

    sendResponse(true, null, 'Password changed successfully');
}

/**
 * Ensure hidden admin dashboard PIN setting exists.
 */
function ensureAdminDashboardPinSetting($conn) {
    $defaultPin = '1433';
    $stmt = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type)
         VALUES ('admin_dashboard_access_pin', ?, 'string')
         ON DUPLICATE KEY UPDATE setting_key = setting_key"
    );
    if ($stmt) {
        $stmt->bind_param('s', $defaultPin);
        $stmt->execute();
        $stmt->close();
    }
}

/**
 * Read stored hidden admin dashboard PIN.
 */
function getAdminDashboardPin($conn) {
    ensureAdminDashboardPinSetting($conn);

    $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = 'admin_dashboard_access_pin' LIMIT 1");
    if (!$stmt) return '1433';

    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $pin = (string)($row['setting_value'] ?? '1433');
    $pin = preg_replace('/\D+/', '', $pin);
    if (strlen($pin) !== 4) return '1433';
    return $pin;
}

/**
 * POST - Verify hidden admin dashboard PIN.
 * Payload: { pin }
 */
function handleAdminVerifyDashboardPin($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    $data = getJSONInput();
    $pin = preg_replace('/\D+/', '', (string)($data['pin'] ?? ''));
    if (strlen($pin) !== 4) sendError('PIN must be exactly 4 digits', 400);

    $storedPin = getAdminDashboardPin($conn);
    if (!hash_equals($storedPin, $pin)) {
        sendError('Invalid dashboard PIN', 403);
    }

    $_SESSION['admin_dashboard_pin_verified_at'] = time();
    sendResponse(true, ['verified' => true], 'Dashboard PIN verified');
}

/**
 * POST - Update hidden admin dashboard PIN.
 * Payload: { newPin, totpPin }
 */
function handleAdminUpdateDashboardPin($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    ensureTOTPColumns($conn);
    ensureAdminDashboardPinSetting($conn);

    $user_id = (int)$_SESSION['user_id'];
    $data = getJSONInput();

    $newPin = preg_replace('/\D+/', '', (string)($data['newPin'] ?? ''));
    $totpPin = preg_replace('/\D+/', '', (string)($data['totpPin'] ?? ''));

    if (strlen($newPin) !== 4) sendError('New dashboard PIN must be exactly 4 digits', 400);
    if (strlen($totpPin) !== 6) sendError('Invalid authenticator code', 400);

    $stmt = $conn->prepare("SELECT id, username, status, totp_secret, totp_enabled FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $u = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$u) sendError('User not found', 404);
    if ($u['status'] !== 'active') sendError('Account is not active', 403);
    if (!$u['totp_secret']) sendError('TOTP is not set up', 400);

    if (!validateTOTP($u['totp_secret'], $totpPin)) {
        sendError('Invalid authenticator code', 400);
    }

    if (!(bool)$u['totp_enabled']) {
        $conn->query("UPDATE users SET totp_enabled = 1 WHERE id = " . intval($user_id));
    }

    $up = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type)
         VALUES ('admin_dashboard_access_pin', ?, 'string')
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_type = 'string', updated_at = NOW()"
    );
    $up->bind_param('s', $newPin);
    if (!$up->execute()) sendError('Failed to update dashboard PIN', 500);
    $up->close();

    logActivity($conn, $user_id, 'admin_update_dashboard_pin', 'Admin updated hidden dashboard PIN via TOTP', 'settings');

    sendResponse(true, null, 'Hidden dashboard PIN updated successfully');
}

function clearDataDeletionAccessSession() {
    unset($_SESSION['data_deletion_access_verified_until']);
    unset($_SESSION['data_deletion_access_code_hash']);
    unset($_SESSION['data_deletion_access_code_expires_at']);
    unset($_SESSION['data_deletion_access_code_attempts']);
}

function clearDataDeletionCodeSession() {
    unset($_SESSION['data_deletion_access_code_hash']);
    unset($_SESSION['data_deletion_access_code_expires_at']);
    unset($_SESSION['data_deletion_access_code_attempts']);
}

function maskEmailForDisplay($email) {
    $value = trim((string)$email);
    if ($value === '' || strpos($value, '@') === false) return '';

    [$local, $domain] = explode('@', $value, 2);
    $localLen = strlen($local);
    if ($localLen <= 2) {
        $maskedLocal = str_repeat('*', max(1, $localLen));
    } else {
        $maskedLocal = substr($local, 0, 1) . str_repeat('*', max(1, $localLen - 2)) . substr($local, -1);
    }

    return $maskedLocal . '@' . $domain;
}

function getCurrentAdminForDataDeletion($conn) {
    if (!isset($_SESSION['user_id'])) sendError('Not authenticated', 401);
    if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') sendError('Forbidden', 403);

    $user_id = (int)$_SESSION['user_id'];
    $stmt = $conn->prepare("SELECT id, username, first_name, last_name, email, password, status,
                                   data_deletion_code_sent_at, data_deletion_code_send_ok
                            FROM users WHERE id = ? LIMIT 1");
    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $user = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$user) sendError('User not found', 404);
    if (($user['status'] ?? '') !== 'active') sendError('Account is not active', 403);

    return $user;
}

/**
 * GET - Check current step-up status for data deletion page.
 */
function handleDataDeletionAccessStatus($conn) {
    $admin = getCurrentAdminForDataDeletion($conn);
    $now = time();

    $verifiedUntil = (int)($_SESSION['data_deletion_access_verified_until'] ?? 0);
    if ($verifiedUntil > 0 && $verifiedUntil <= $now) {
        unset($_SESSION['data_deletion_access_verified_until']);
        $verifiedUntil = 0;
    }

    $codeExpires = (int)($_SESSION['data_deletion_access_code_expires_at'] ?? 0);
    if ($codeExpires > 0 && $codeExpires <= $now) {
        clearDataDeletionCodeSession();
        $codeExpires = 0;
    }

    // Resend throttle + the mailer's verdict for the last send. Without these
    // the UI could only ever report "code sent", even when SMTP refused it.
    $lastSentTs = strtotime((string)($admin['data_deletion_code_sent_at'] ?? '')) ?: 0;
    $resendAvailableIn = $lastSentTs > 0
        ? max(0, ($lastSentTs + DATA_DELETION_CODE_RESEND_SECONDS) - $now)
        : 0;
    $lastSendOkRaw = $admin['data_deletion_code_send_ok'] ?? null;
    $lastSendOk = ($lastSendOkRaw === null || $lastSendOkRaw === '') ? null : ((int)$lastSendOkRaw === 1);

    sendResponse(true, [
        'verified' => $verifiedUntil > $now,
        'verified_until' => $verifiedUntil > $now ? date('c', $verifiedUntil) : null,
        'code_requested' => !empty($_SESSION['data_deletion_access_code_hash']) && $codeExpires > $now,
        'code_expires_at' => $codeExpires > $now ? date('c', $codeExpires) : null,
        'code_sent_at' => $lastSentTs > 0 ? date('c', $lastSentTs) : null,
        'code_send_ok' => $lastSendOk,
        'resend_available_in' => $resendAvailableIn,
        'email_masked' => maskEmailForDisplay($admin['email'] ?? ''),
    ], 'Data deletion access status');
}

/**
 * POST - Validate admin password and send 8-digit email code for data deletion.
 * Payload: { password }
 */
function handleDataDeletionRequestCode($conn) {
    $admin = getCurrentAdminForDataDeletion($conn);
    $data = getJSONInput();
    $password = (string)($data['password'] ?? '');

    if ($password === '') {
        sendError('Password is required', 400);
    }

    if (!verifyPassword($password, (string)$admin['password'])) {
        logActivity($conn, (int)$admin['id'], 'data_deletion_request_code_failed', 'Invalid admin password for data deletion access', 'settings');
        sendError('Invalid password', 401);
    }

    $adminId = (int)($admin['id'] ?? 0);

    // Resend throttle. Each accepted request rotates the stored code, so two
    // clicks in quick succession leave the admin holding the older (now dead)
    // code from the first email.
    $lastSentTs = strtotime((string)($admin['data_deletion_code_sent_at'] ?? '')) ?: 0;
    if ($lastSentTs > 0) {
        $waitSeconds = ($lastSentTs + DATA_DELETION_CODE_RESEND_SECONDS) - time();
        if ($waitSeconds > 0) {
            sendError(
                'Please wait ' . $waitSeconds . ' second(s) before requesting another code.',
                429,
                ['retry_after' => $waitSeconds]
            );
        }
    }

    $toEmail = trim((string)($admin['email'] ?? ''));
    if ($toEmail === '') {
        sendError('Admin email is missing. Update your profile email first.', 400);
    }

    $code = str_pad((string)random_int(0, 99999999), 8, '0', STR_PAD_LEFT);
    $codeHash = hash('sha256', $code);
    $expiresAtTs = time() + (10 * 60);

    clearDataDeletionAccessSession();
    $_SESSION['data_deletion_access_code_hash'] = $codeHash;
    $_SESSION['data_deletion_access_code_expires_at'] = $expiresAtTs;
    $_SESSION['data_deletion_access_code_attempts'] = 0;

    // Record the attempt up front so the resend throttle applies even when the
    // background send fails. send_ok stays NULL until the mailer reports back
    // (the session is already closed by then, so the verdict lands in the DB).
    $markStmt = $conn->prepare('UPDATE users SET data_deletion_code_sent_at = NOW(), data_deletion_code_send_ok = NULL WHERE id = ?');
    if ($markStmt) {
        $markStmt->bind_param('i', $adminId);
        $markStmt->execute();
        $markStmt->close();
    }

    $fullName = trim((string)($admin['first_name'] ?? '') . ' ' . (string)($admin['last_name'] ?? ''));
    $displayName = $fullName !== '' ? $fullName : (string)($admin['username'] ?? 'Admin');
    $subject = 'Data Storage Access Verification Code';

    $content = '<p>Hi ' . htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8') . ',</p>'
        . '<p>Your verification code for Data Storage settings is:</p>'
        . '<h2 style="letter-spacing:3px;margin:10px 0;">' . htmlspecialchars($code, ENT_QUOTES, 'UTF-8') . '</h2>'
        . '<p>This code expires in 10 minutes.</p>'
        . '<p>If you did not request this code, secure your account immediately.</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, 'Your data deletion access code is ready.')
        : $content;

    $adminId      = (int)$admin['id'];
    $emailMasked  = maskEmailForDisplay($toEmail);
    $codeExpiresAt = date('c', $expiresAtTs);

    // Respond to the browser immediately so the UI is not blocked by SMTP latency,
    // then send the email in the background — same pattern as forgot-password.
    sendResponseAndContinue(true, [
        'email_masked'        => $emailMasked,
        'code_expires_at'     => $codeExpiresAt,
        'resend_available_in' => DATA_DELETION_CODE_RESEND_SECONDS,
    ], 'Verification code sent to admin email.', 200, function () use ($conn, $adminId, $toEmail, $displayName, $subject, $html) {
        $sent = function_exists('sendMail')
            ? sendMail($toEmail, $displayName, $subject, $html)
            : false;
        // The session was already closed when this runs, so the verdict has to
        // land in the database — that is what the status endpoint reports.
        $resultStmt = $conn->prepare('UPDATE users SET data_deletion_code_send_ok = ? WHERE id = ?');
        if ($resultStmt) {
            $sendOk = $sent ? 1 : 0;
            $resultStmt->bind_param('ii', $sendOk, $adminId);
            $resultStmt->execute();
            $resultStmt->close();
        }
        if (!$sent) {
            error_log('Data deletion code email failed to send for admin_id=' . $adminId);
        }
        logActivity($conn, $adminId, 'data_deletion_request_code', $sent ? 'Sent data deletion access code to admin email' : 'Failed to send data deletion access code email', 'settings');
    });
}

/**
 * POST - Verify 8-digit code and grant temporary access to data deletion.
 * Payload: { code }
 */
function handleDataDeletionVerifyCode($conn) {
    $admin = getCurrentAdminForDataDeletion($conn);
    $data = getJSONInput();
    $code = preg_replace('/\D+/', '', (string)($data['code'] ?? ''));

    if (strlen($code) !== 8) {
        sendError('Verification code must be 8 digits', 400);
    }

    $now = time();
    $codeHash = (string)($_SESSION['data_deletion_access_code_hash'] ?? '');
    $codeExpires = (int)($_SESSION['data_deletion_access_code_expires_at'] ?? 0);
    $attempts = (int)($_SESSION['data_deletion_access_code_attempts'] ?? 0);

    if ($codeHash === '' || $codeExpires <= $now) {
        clearDataDeletionCodeSession();
        sendError('No active verification code. Request a new code.', 400);
    }

    if ($attempts >= 5) {
        clearDataDeletionCodeSession();
        sendError('Too many invalid attempts. Request a new code.', 429);
    }

    $incomingHash = hash('sha256', $code);
    if (!hash_equals($codeHash, $incomingHash)) {
        $_SESSION['data_deletion_access_code_attempts'] = $attempts + 1;
        if (((int)$_SESSION['data_deletion_access_code_attempts']) >= 5) {
            clearDataDeletionCodeSession();
            sendError('Too many invalid attempts. Request a new code.', 429);
        }
        sendError('Invalid verification code', 400);
    }

    clearDataDeletionCodeSession();
    $verifiedUntil = time() + (15 * 60);
    $_SESSION['data_deletion_access_verified_until'] = $verifiedUntil;

    logActivity($conn, (int)$admin['id'], 'data_deletion_access_verified', 'Admin completed step-up verification for data deletion', 'settings');

    sendResponse(true, [
        'verified' => true,
        'verified_until' => date('c', $verifiedUntil),
    ], 'Data deletion access granted.');
}

closeDBConnection($conn);
?>
