<?php
/**
 * Settings API
 * Admin-only CRUD for key-value settings table
 *
 * GET  ?keys=key1,key2,...   — returns requested settings
 * PUT  body { settings: { key: value, ... } } — updates settings
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

$method = getRequestMethod();
$conn   = getDBConnection();

// Public endpoint: return login title lines without auth
if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'public_login_title') {
    handlePublicLoginTitle($conn);
    closeDBConnection($conn);
    exit;
}

// Public endpoint: return privacy policy display settings without auth
if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'public_privacy_policy_settings') {
    handlePublicPrivacyPolicySettings($conn);
    closeDBConnection($conn);
    exit;
}

// Public endpoint: return login captcha display settings without auth
if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] === 'public_login_captcha_settings') {
    handlePublicLoginCaptchaSettings($conn);
    closeDBConnection($conn);
    exit;
}

// Admin only
requireAuth();
requireRole(['admin']);

switch ($method) {
    case 'GET':
        handleGetSettings($conn);
        break;
    case 'PUT':
        handleUpdateSettings($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

/**
 * GET — Retrieve settings by keys
 */
function handleGetSettings($conn) {
    $keysParam = $_GET['keys'] ?? '';
    if ($keysParam === '') {
        sendError('Missing "keys" query parameter', 400);
    }

    $keys = array_map('trim', explode(',', $keysParam));
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $sql  = "SELECT setting_key, setting_value, setting_type FROM settings WHERE setting_key IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();

    $settings = [];
    while ($row = $result->fetch_assoc()) {
        $settings[$row['setting_key']] = castSettingValueForResponse(
            $row['setting_key'],
            $row['setting_value'],
            $row['setting_type'] ?? 'string'
        );
    }
    $stmt->close();

    sendResponse(true, $settings, 'Settings retrieved');
}

function getBooleanSettingKeys() {
    return [
        'lockout_enabled',
        'privacy_policy_enabled',
        'privacy_policy_watermark_enabled',
        'session_timeout_enabled',
        'login_math_captcha_enabled',
        'math_captcha_timer_enabled',
        'login_otp_enabled',
        'rate_limit_enabled',
        'leave_planner_show_names',
    ];
}

function getNumberSettingKeys() {
    return [
        'lockout_threshold_manager',
        'lockout_threshold_staff',
        'lockout_window_hours',
        'pagination_items_per_page',
        'hourly_rate_staff',
        'hourly_rate_manager',
        'company_daily_rate',
        'privacy_policy_watermark_count',
        'session_timeout_manager_minutes',
        'session_timeout_staff_minutes',
        'session_timeout_admin_minutes',
        'captcha_timeout_seconds',
        'math_captcha_timeout_seconds',
        'login_failed_attempt_limit',
        'lockout_retry_delay_value',
        'lockout_cooldown_start_attempt',
        'lockout_max_cooldown_attempts',
        'login_suspicious_risk_threshold',
        'rate_limit_max_requests',
        'rate_limit_window_seconds',
        'slider_min_drag_ms',
        'slider_max_attempts',
        'slider_tolerance_px',
        'slider_min_path_points',
    ];
}

function getExpectedSettingType($key, $fallback = 'string') {
    if (in_array($key, getBooleanSettingKeys(), true)) return 'boolean';
    if (in_array($key, getNumberSettingKeys(), true)) return 'number';
    return in_array($fallback, ['string', 'number', 'boolean'], true) ? $fallback : 'string';
}

function normalizeBooleanSetting($value) {
    if (is_bool($value)) return $value;
    if (is_numeric($value)) return ((float)$value) !== 0.0;
    $text = strtolower(trim((string)$value));
    if ($text === '' || $text === '0' || $text === 'false' || $text === 'off' || $text === 'no') return false;
    return true;
}

function stringifySettingValue($value) {
    if (is_bool($value)) return $value ? '1' : '0';
    if (is_float($value)) {
        $text = rtrim(rtrim(sprintf('%.10F', $value), '0'), '.');
        return $text === '' ? '0' : $text;
    }
    return (string)$value;
}

function normalizeSettingForStorage($key, $value) {
    $type = getExpectedSettingType($key, 'string');

    if ($type === 'boolean') {
        $normalized = normalizeBooleanSetting($value);
        return [
            'value' => $normalized,
            'store' => $normalized ? '1' : '0',
            'type' => 'boolean',
        ];
    }

    if ($type === 'number') {
        switch ($key) {
            case 'pagination_items_per_page':
                $normalized = max(1, min(100, (int)$value));
                break;
            case 'privacy_policy_watermark_count':
                $normalized = max(1, min(6, (int)$value));
                break;
            case 'session_timeout_manager_minutes':
            case 'session_timeout_staff_minutes':
            case 'session_timeout_admin_minutes':
                $normalized = max(1, min(1440, (int)$value));
                break;
            case 'captcha_timeout_seconds':
                $normalized = max(30, min(86400, (int)$value));
                break;
            case 'math_captcha_timeout_seconds':
                $normalized = max(10, min(3600, (int)$value));
                break;
            case 'login_failed_attempt_limit':
            case 'lockout_threshold_manager':
            case 'lockout_threshold_staff':
                $normalized = max(1, min(20, (int)$value));
                break;
            case 'lockout_retry_delay_value':
                // 0 disables the "attempt return" countdown
                $normalized = max(0, min(86400, (int)$value));
                break;
            case 'lockout_cooldown_start_attempt':
                // 0 disables the countdown; otherwise the attempt number it starts at
                $normalized = max(0, min(50, (int)$value));
                break;
            case 'lockout_max_cooldown_attempts':
                // number of 30s cooldown cycles before lock (1-10, default 3)
                $normalized = max(1, min(10, (int)$value));
                break;
            case 'login_suspicious_risk_threshold':
                $normalized = max(1, min(10, (int)$value));
                break;
            case 'rate_limit_max_requests':
                $normalized = max(10, min(5000, (int)$value));
                break;
            case 'rate_limit_window_seconds':
                $normalized = max(10, min(86400, (int)$value));
                break;
            case 'hourly_rate_staff':
            case 'hourly_rate_manager':
            case 'company_daily_rate':
                $normalized = max(0, (float)$value);
                break;
            case 'slider_min_drag_ms':
                $normalized = max(200, min(5000, (int)$value));
                break;
            case 'slider_max_attempts':
                $normalized = max(1, min(10, (int)$value));
                break;
            case 'slider_tolerance_px':
                $normalized = max(8, min(40, (int)$value));
                break;
            case 'slider_min_path_points':
                $normalized = max(1, min(20, (int)$value));
                break;
            default:
                $normalized = is_numeric($value) ? (float)$value : 0;
                if (floor($normalized) == $normalized) $normalized = (int)$normalized;
                break;
        }

        return [
            'value' => $normalized,
            'store' => stringifySettingValue($normalized),
            'type' => 'number',
        ];
    }

    if ($key === 'lockout_retry_delay_unit') {
        $unit = strtolower(trim((string)$value));
        if (!in_array($unit, ['seconds', 'minutes'], true)) {
            $unit = 'seconds';
        }
        return [
            'value' => $unit,
            'store' => $unit,
            'type' => 'string',
        ];
    }

    $normalized = trim((string)$value);
    return [
        'value' => $normalized,
        'store' => $normalized,
        'type' => 'string',
    ];
}

function castSettingValueForResponse($key, $value, $storedType = 'string') {
    $type = getExpectedSettingType($key, $storedType);
    if ($type === 'boolean') return normalizeBooleanSetting($value);
    if ($type === 'number') {
        if (!is_numeric($value)) return $value;
        $number = (float)$value;
        return floor($number) == $number ? (int)$number : $number;
    }
    return (string)$value;
}

/**
 * PUT — Update settings
 * Body: { "settings": { "lockout_enabled": true, "lockout_threshold_manager": 3, ... } }
 */
function handleUpdateSettings($conn) {
    $data     = getJSONInput();
    $settings = $data['settings'] ?? [];

    if (empty($settings) || !is_array($settings)) {
        sendError('Missing or invalid "settings" object', 400);
    }

    // Whitelist of allowed keys to prevent arbitrary setting injection
    $allowedKeys = [
        'lockout_enabled',
        'lockout_threshold_manager',
        'lockout_threshold_staff',
        'lockout_window_hours',
        'lockout_retry_delay_value',
        'lockout_retry_delay_unit',
        'lockout_cooldown_start_attempt',
        'lockout_max_cooldown_attempts',
        'login_title_line_1',
        'login_title_line_2',
        'login_title_line_3',
        'login_title_line_4',
        'backup_frequency',
        'backup_time',
        'backup_day_of_week',
        'backup_day_of_month',
        'backup_auto_save_path',
        'pagination_items_per_page',
        'hourly_rate_staff',
        'hourly_rate_manager',
        'company_daily_rate',
        'company_daily_rate_by_branch',
        'privacy_policy_enabled',
        'privacy_policy_watermark_enabled',
        'privacy_policy_watermark_count',
        'session_timeout_enabled',
        'session_timeout_manager_minutes',
        'session_timeout_staff_minutes',
        'session_timeout_admin_minutes',
        'captcha_timeout_seconds',
        'login_math_captcha_enabled',
        'math_captcha_timer_enabled',
        'math_captcha_timeout_seconds',
        'login_otp_enabled',
        'login_failed_attempt_limit',
        'login_suspicious_risk_threshold',
        'rate_limit_enabled',
        'rate_limit_max_requests',
        'rate_limit_window_seconds',
        // Slider captcha bot-resistance
        'slider_min_drag_ms',
        'slider_max_attempts',
        'slider_tolerance_px',
        'slider_min_path_points',
        // hCaptcha configuration
        'hcaptcha_site_key',
        'hcaptcha_secret',
        // Leave Planner display settings
        'leave_planner_show_names',
    ];

    $updated = [];
    foreach ($settings as $key => $value) {
        if (!in_array($key, $allowedKeys)) {
            continue;
        }

        $normalized = normalizeSettingForStorage($key, $value);
        $storeVal = $normalized['store'];
        $settingType = $normalized['type'];

        $stmt = $conn->prepare(
            "INSERT INTO settings (setting_key, setting_value, setting_type)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = ?, setting_type = ?, updated_at = NOW()"
        );
        $stmt->bind_param('sssss', $key, $storeVal, $settingType, $storeVal, $settingType);
        if (!$stmt->execute()) {
            $message = $stmt->error ?: 'Unknown database error';
            $stmt->close();
            sendError("Failed to save setting '{$key}': {$message}", 500);
        }
        $stmt->close();
        $updated[$key] = $normalized['value'];
    }

    if (empty($updated)) {
        sendError('No recognized settings to update', 400);
    }

    // Log with friendly names instead of raw keys (e.g., "Updated Session Timeout" not "session_timeout_enabled,...")
    $user_id = (int)$_SESSION['user_id'];
    $friendlyMap = [
        'lockout_enabled' => 'Account Lockout',
        'lockout_threshold_manager' => 'Manager Threshold',
        'lockout_threshold_staff' => 'Staff Threshold',
        'lockout_window_hours' => 'Time Window',
        'lockout_cooldown_start_attempt' => 'Failed Attempts Before Cooldown',
        'lockout_max_cooldown_attempts' => 'Max Cooldown Attempts',
        'lockout_retry_delay_value' => 'Cooldown Duration',
        'lockout_retry_delay_unit' => 'Cooldown Duration',
        'session_timeout_enabled' => 'Session Timeout',
        'session_timeout_manager_minutes' => 'Manager Session Timeout',
        'session_timeout_staff_minutes' => 'Staff Session Timeout',
        'session_timeout_admin_minutes' => 'Admin Session Timeout',
        'captcha_timeout_seconds' => 'Captcha Timeout',
        'login_math_captcha_enabled' => 'Captcha Management',
        'math_captcha_timer_enabled' => 'Math Captcha Timer',
        'math_captcha_timeout_seconds' => 'Math Captcha Timer',
        'login_failed_attempt_limit' => 'Failed Attempt Limit',
        'pagination_items_per_page' => 'Pagination',
        'hourly_rate_staff' => 'Staff Hourly Rate',
        'hourly_rate_manager' => 'Manager Hourly Rate',
        'company_daily_rate' => 'Company Daily Rate',
        'rate_limit_enabled' => 'Rate Limiting',
        'rate_limit_max_requests' => 'Rate Limit Max Requests',
        'rate_limit_window_seconds' => 'Rate Limit Window',
        'leave_planner_show_names' => 'Leave Planner Display',
        'password_policy_enabled' => 'Password Policy',
    ];
    $friendlyLabels = [];
    foreach (array_keys($updated) as $k) {
        // Combine retry delay value+unit into one label
        if ($k === 'lockout_retry_delay_unit') continue;
        if ($k === 'lockout_retry_delay_value') {
            $friendlyLabels[] = 'Cooldown Duration';
            continue;
        }
        $friendlyLabels[] = $friendlyMap[$k] ?? ucwords(str_replace('_', ' ', $k));
    }
    $friendlyLabels = array_values(array_unique($friendlyLabels));
    // Determine primary btn/section that was edited for title
    $primaryLabel = $friendlyLabels[0] ?? 'Settings';
    if (in_array('Manager Threshold', $friendlyLabels) || in_array('Staff Threshold', $friendlyLabels) || in_array('Account Lockout', $friendlyLabels)) {
        $primaryLabel = 'Account Lockout';
    } elseif (in_array('Manager Session Timeout', $friendlyLabels) || in_array('Staff Session Timeout', $friendlyLabels) || in_array('Session Timeout', $friendlyLabels)) {
        $primaryLabel = 'Session Timeout';
    } elseif (in_array('Cooldown Duration', $friendlyLabels) || in_array('Failed Attempts Before Cooldown', $friendlyLabels) || in_array('Max Cooldown Attempts', $friendlyLabels)) {
        $primaryLabel = 'Account Lockout';
    } elseif (in_array('Pagination', $friendlyLabels)) {
        $primaryLabel = 'Pagination';
    } elseif (in_array('Captcha Management', $friendlyLabels) || in_array('Captcha Timeout', $friendlyLabels)) {
        $primaryLabel = 'Captcha Management';
    }
    $readableList = implode(', ', $friendlyLabels);
    logActivity($conn, $user_id, 'update_system_settings', "Updated {$primaryLabel}: {$readableList}", 'settings');

    sendResponse(true, $updated, 'Settings updated successfully');
}

/**
 * Public — Return login title lines (no auth required)
 */
function handlePublicLoginTitle($conn) {
    $keys = ['login_title_line_1','login_title_line_2','login_title_line_3','login_title_line_4'];
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $sql  = "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();

    $settings = [];
    while ($row = $result->fetch_assoc()) {
        $settings[$row['setting_key']] = $row['setting_value'];
    }
    $stmt->close();

    sendResponse(true, $settings, 'Login title retrieved');
}

/**
 * Public - Return privacy policy display settings (no auth required)
 */
function handlePublicPrivacyPolicySettings($conn) {
    $keys = ['privacy_policy_enabled', 'privacy_policy_watermark_enabled', 'privacy_policy_watermark_count'];
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $sql  = "SELECT setting_key, setting_value, setting_type FROM settings WHERE setting_key IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();

    $settings = [
        'privacy_policy_enabled' => true,
        'privacy_policy_watermark_enabled' => true,
        'privacy_policy_watermark_count' => 3,
    ];

    while ($row = $result->fetch_assoc()) {
        $val = $row['setting_value'];
        if ($row['setting_type'] === 'number') {
            $val = is_numeric($val) ? (int)$val : $val;
        } elseif ($row['setting_type'] === 'boolean') {
            $val = ($val === '1' || $val === 'true');
        }
        $settings[$row['setting_key']] = $val;
    }
    $stmt->close();

    $settings['privacy_policy_enabled'] = !empty($settings['privacy_policy_enabled']);
    $settings['privacy_policy_watermark_enabled'] = !empty($settings['privacy_policy_watermark_enabled']);
    $settings['privacy_policy_watermark_count'] = max(1, min(6, (int)$settings['privacy_policy_watermark_count']));

    sendResponse(true, $settings, 'Privacy policy display settings retrieved');
}

/**
 * Get a setting value from the settings table with a default fallback.
 */
function getSettingValue($conn, $key, $default = null) {
    if (!(isDbConnection($conn))) return $default;
    $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1");
    if (!$stmt) return $default;
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $stmt->bind_result($value);
    $found = $stmt->fetch();
    $stmt->close();
    return $found ? $value : $default;
}

/**
 * Public - Return login captcha display settings (no auth required)
 */
function handlePublicLoginCaptchaSettings($conn) {
    // Only advertise the hCaptcha site key when the secret is also configured.
    // If the secret is missing, the server cannot verify tokens, so showing the
    // widget to users would always result in "CAPTCHA service is not configured".
    $siteKey = getHcaptchaSiteKey();
    $secret  = getHcaptchaSecret();
    $hcaptchaSiteKeyPublic = ($siteKey !== '' && $secret !== '') ? $siteKey : '';

    $settings = [
        'login_math_captcha_enabled' => isLoginMathCaptchaEnabled($conn),
        'captcha_timeout_seconds' => getCaptchaTimeoutSeconds($conn),
        'math_captcha_timer_enabled' => normalizeBooleanSetting(getSettingValue($conn, 'math_captcha_timer_enabled', '1')),
        'math_captcha_timeout_seconds' => max(10, min(3600, (int)getSettingValue($conn, 'math_captcha_timeout_seconds', 120))),
        'login_failed_attempt_limit' => getLoginFailedAttemptLimit($conn),
        'slider_min_drag_ms' => (int)getSettingValue($conn, 'slider_min_drag_ms', 400),
        'slider_max_attempts' => (int)getSettingValue($conn, 'slider_max_attempts', 3),
        'hcaptcha_site_key' => $hcaptchaSiteKeyPublic,
    ];

    sendResponse(true, $settings, 'Login captcha display settings retrieved');
}

closeDBConnection($conn);
?>
