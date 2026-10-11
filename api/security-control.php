<?php
/**
 * Security Control API
 * Admin-only security controls and alert feed.
 *
 * GET  ?action=alerts          - suspicious inbound/outbound IP/browser events
 * GET  ?action=lockdown_status - current lockdown mode state
 * POST ?action=lockdown        - enable/disable lockdown mode
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';
// Security-control flows may write session state — keep the session lock.
$GLOBALS['LLB_KEEP_SESSION_LOCK'] = true;

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

requireAuth();
requireRole(['admin']);

$action = trim((string)($_GET['action'] ?? ''));

if ($method === 'GET') {
    if ($action === '' || $action === 'alerts') {
        handleGetSecurityAlerts($conn);
    } elseif ($action === 'lockdown_status') {
        handleGetLockdownStatus($conn);
    } else {
        sendError('Invalid action', 400);
    }
}

if ($method === 'POST') {
    if ($action === 'lockdown') {
        handleSetLockdown($conn);
    } else {
        sendError('Invalid action', 400);
    }
}

sendError('Method not allowed', 405);

function normalizeAlertDirection($text) {
    $lower = strtolower((string)$text);
    if (strpos($lower, 'outbound') !== false || strpos($lower, 'egress') !== false || strpos($lower, 'external') !== false) {
        return 'outbound';
    }
    return 'inbound';
}

function normalizeAlertSeverity($text) {
    $lower = strtolower((string)$text);
    if (
        strpos($lower, 'attack') !== false
        || strpos($lower, 'malicious') !== false
        || strpos($lower, 'blocked') !== false
        || strpos($lower, 'lockout') !== false
    ) {
        return 'high';
    }

    if (
        strpos($lower, 'failed') !== false
        || strpos($lower, 'invalid') !== false
        || strpos($lower, 'denied') !== false
        || strpos($lower, 'suspicious') !== false
    ) {
        return 'medium';
    }

    return 'low';
}

function isAttackOrSpamSignal($text) {
    $lower = strtolower((string)$text);
    if ($lower === '') return false;

    return (bool)preg_match(
        '/(attack|malicious|blocked|lockout|intruder|spam|flood|ddos|brute|rate\\s*limit|too\\s*many|unknown\\s*ip|unknown_ip|unrecognized\\s*ip|suspicious\\s*ip|invalid\\s*ip|failed|invalid|denied|suspicious|authentication|login|password|settings|backend|editing|update_?system|cooldown|account_?locked|rate_?limit|too\\s*many\\s*request|sending\\s*too\\s*much)/',
        $lower
    );
}

function isSecurityRelevantActivity($activityType, $action, $description) {
    $type = strtolower(trim((string)$activityType));
    $act = strtolower(trim((string)$action));
    $desc = strtolower(trim((string)$description));

    // All security/auth failures are relevant
    if (in_array($type, ['security','auth','authentication'], true)) return true;
    // Backend settings edits
    if ($type === 'settings' || strpos($act, 'settings') !== false || strpos($act, 'update_system') !== false) return true;
    // Failed requests
    if (strpos($act, 'failed') !== false || strpos($desc, 'failed') !== false) return true;
    if (strpos($desc, 'too many request') !== false || strpos($desc, 'too many failed') !== false) return true;
    if (strpos($act, 'rate_limit') !== false || strpos($desc, 'rate limit') !== false) return true;
    if (strpos($act, 'lockout') !== false || strpos($act, 'account_locked') !== false) return true;
    // General suspicious
    if (isAttackOrSpamSignal($act.' '.$desc.' '.$type)) return true;
    return false;
}

function upsertSettingValue($conn, $key, $value, $type = 'string') {
    $stmt = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_type = VALUES(setting_type), updated_at = NOW()"
    );
    if (!$stmt) {
        return false;
    }

    $stmt->bind_param('sss', $key, $value, $type);
    $ok = $stmt->execute();
    $stmt->close();
    return $ok;
}

function toBoolFlag($value) {
    if (is_bool($value)) return $value;
    if (is_numeric($value)) return ((int)$value) !== 0;
    $raw = strtolower(trim((string)$value));
    return in_array($raw, ['1', 'true', 'yes', 'on'], true);
}

function formatIsoDateTime($value) {
    $raw = trim((string)$value);
    if ($raw === '') return '';
    $ts = strtotime($raw);
    if ($ts === false) return $raw;
    return date('Y-m-d H:i:s', $ts);
}

function handleGetLockdownStatus($conn) {
    $state = getSystemLockdownState($conn);

    sendResponse(true, [
        'enabled' => !empty($state['enabled']),
        'reason' => (string)($state['reason'] ?? ''),
        'updated_at' => formatIsoDateTime((string)($state['updated_at'] ?? '')),
        'updated_by' => (string)($state['updated_by'] ?? ''),
    ], 'Lockdown status retrieved.');
}

function handleSetLockdown($conn) {
    $adminId = (int)($_SESSION['user_id'] ?? 0);
    if ($adminId <= 0) {
        sendError('Authentication required', 401);
    }

    $body      = getJSONInput();
    $enable    = isset($body['enabled']) ? toBoolFlag($body['enabled']) : false;
    $reason    = trim((string)($body['reason'] ?? ''));
    $now       = date('Y-m-d H:i:s');
    $updatedBy = (string)$adminId;

    $enableVal = $enable ? '1' : '0';
    $updatedAt = $enable ? $now : '';
    $storedBy  = $enable ? $updatedBy : '';
    $storedReason = $enable ? $reason : '';

    if (
        !upsertSettingValue($conn, 'security_lockdown_enabled', $enableVal, 'boolean')
        || !upsertSettingValue($conn, 'security_lockdown_reason', $storedReason, 'string')
        || !upsertSettingValue($conn, 'security_lockdown_updated_at', $updatedAt, 'string')
        || !upsertSettingValue($conn, 'security_lockdown_updated_by', $storedBy, 'string')
    ) {
        sendError('Failed to update lockdown settings.', 500);
    }

    $msg = $enable ? 'System lockdown has been enabled.' : 'System lockdown has been removed.';
    sendResponse(true, [
        'enabled'    => $enable,
        'reason'     => $storedReason,
        'updated_at' => $updatedAt,
        'updated_by' => $storedBy,
    ], $msg);
}

function handleGetSecurityAlerts($conn) {
    $lockdown = getSystemLockdownState($conn);

    $limit = isset($_GET['limit']) ? max(1, min(100, (int)$_GET['limit'])) : 25;
    $alerts = [];

    // --- 1. Security-relevant activity logs: failed requests, lockouts, rate limits, backend edits ---
    $logLimit = max($limit * 5, 60);
    $logsSql = "SELECT al.id, al.action, al.description, al.activity_type, al.ip_address, al.created_at, al.user_id, u.username, u.email, u.role, CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,'')) as user_fullname
                FROM activity_log al
                LEFT JOIN users u ON u.id = al.user_id
                WHERE al.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                  AND (
                    al.activity_type IN ('security', 'auth', 'authentication', 'settings', 'general', 'api')
                    OR al.action LIKE '%failed%' OR al.action LIKE '%lockout%' OR al.action LIKE '%rate_limit%' OR al.action LIKE '%too_many%'
                    OR al.description LIKE '%failed%' OR al.description LIKE '%Too many request%' OR al.description LIKE '%rate limit%' OR al.description LIKE '%account_locked%' OR al.description LIKE '%backend%' OR al.description LIKE '%editing%'
                  )
                ORDER BY al.created_at DESC
                LIMIT ?";
    $logsStmt = $conn->prepare($logsSql);
    if ($logsStmt) {
        $logsStmt->bind_param('i', $logLimit);
        $logsStmt->execute();
        $logRows = $logsStmt->get_result();
        while ($row = $logRows->fetch_assoc()) {
            $action = (string)($row['action'] ?? '');
            $description = trim((string)($row['description'] ?? ''));
            // Convert old raw logs like "Updated settings: session_timeout_enabled, ..." to friendly
            if (stripos($description, 'Updated settings:') === 0) {
                $raw = trim(substr($description, strlen('Updated settings:')));
                $parts = array_filter(array_map('trim', explode(',', $raw)));
                $map = [
                    'lockout_enabled' => 'Account Lockout',
                    'lockout_threshold_manager' => 'Manager Threshold',
                    'lockout_threshold_staff' => 'Staff Threshold',
                    'lockout_window_hours' => 'Time Window',
                    'lockout_cooldown_start_attempt' => 'Failed Attempts Before Cooldown',
                    'lockout_max_cooldown_attempts' => 'Max Cooldown Attempts',
                    'lockout_retry_delay_value' => 'Cooldown Duration', 'lockout_retry_delay_unit' => 'Cooldown Duration',
                    'session_timeout_enabled' => 'Session Timeout',
                    'session_timeout_manager_minutes' => 'Manager Session Timeout',
                    'session_timeout_staff_minutes' => 'Staff Session Timeout',
                    'pagination_items_per_page' => 'Pagination', 'captcha_timeout_seconds' => 'Captcha Timeout',
                    'login_failed_attempt_limit' => 'Failed Attempt Limit',
                ];
                $friendly = [];
                foreach ($parts as $k) {
                    if ($k === 'lockout_retry_delay_unit') continue;
                    if ($k === 'lockout_retry_delay_value') { $friendly[] = 'Cooldown Duration'; continue; }
                    $friendly[] = $map[$k] ?? ucwords(str_replace('_', ' ', $k));
                }
                $friendly = array_values(array_unique($friendly));
                $description = 'Updated ' . implode(', ', $friendly);
                if (count($friendly) === 1) $description = 'Updated ' . $friendly[0];
            }
            $activityType = (string)($row['activity_type'] ?? '');
            $ip = trim((string)($row['ip_address'] ?? ''));
            $createdAt = (string)($row['created_at'] ?? '');
            $id = (int)($row['id'] ?? 0);
            $alertUserId = intval($row['user_id'] ?? 0);
            $alertUsername = trim((string)($row['username'] ?? ''));
            $alertEmail = trim((string)($row['email'] ?? ''));
            $alertRole = trim((string)($row['role'] ?? ''));
            $alertFullname = trim((string)($row['user_fullname'] ?? ''));
            $alertUserLabel = $alertUsername !== '' ? $alertUsername : ($alertEmail !== '' ? $alertEmail : ($alertFullname !== '' ? $alertFullname : ($alertUserId > 0 ? "User #{$alertUserId}" : "Unknown user")));
            if ($alertRole !== '') $alertUserLabel .= " ({$alertRole})";
            // For failed logins where user_id is 0, try to extract attempted identifier from description if present
            if ($alertUserId === 0 && preg_match('/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i', $description, $m)) {
                $alertUserLabel = $m[0] . " (guest)";
                $alertUsername = $m[0];
            }

            $signalText = trim($action . ' ' . $description . ' ' . $activityType . ' ' . $ip);
            if (!isSecurityRelevantActivity($activityType, $action, $description) && !isAttackOrSpamSignal($signalText)) {
                continue;
            }

            $severity = normalizeAlertSeverity($signalText);
            $direction = normalizeAlertDirection($signalText);

            // Clean title: show what's been edited, not generic backend label, no underscores or truncated etc.
            if ($activityType === 'settings' && stripos($description, 'Updated') === 0) {
                $colonPos = strpos($description, ':');
                if ($colonPos !== false) {
                    $rawTitle = trim(substr($description, 0, $colonPos)); // e.g., "Updated Session Timeout"
                    $rawTitle = trim(str_ireplace('Updated', '', $rawTitle));
                    $title = $rawTitle !== '' ? $rawTitle . ' Updated' : 'Settings Updated';
                    // Clean up: title case, no underscores
                    $title = ucwords(strtolower($title));
                } else {
                    $title = trim($description);
                    if (strlen($title) > 36) $title = trim(substr($title, 0, 36));
                }
            } else {
                if (stripos($signalText, 'too many request') !== false || stripos($signalText, 'rate limit') !== false) $title = 'Too Many Requests';
                elseif (stripos($signalText, 'lockout') !== false || stripos($signalText, 'account_locked') !== false) $title = 'Account Lockout';
                elseif (stripos($signalText, 'failed') !== false) $title = 'Failed Login';
                elseif (stripos($signalText, 'suspicious') !== false) $title = 'Suspicious Activity';
                elseif ($activityType === 'settings') $title = trim($description) !== '' ? trim(explode(':', $description)[0]) : 'Settings Updated';
                else $title = ucwords(str_replace(['_', '-'], ' ', $action));
            }
            $title = trim($title, " _-");
            if ($title === '') $title = 'Security Alert';
            if (strlen($title) > 36) $title = trim(substr($title, 0, 36));
            // For login/security alerts, prepend who's user is that
            $displayMessage = $description !== '' ? $description : ("Action: {$action} [" . $activityType . "]");
            // If this is a login-related security event, make user explicit in title/message
            $isLoginSecurity = stripos($signalText, 'login') !== false || stripos($signalText, 'failed') !== false || stripos($signalText, 'lockout') !== false || stripos($signalText, 'account_locked') !== false || $activityType === 'auth' || $activityType === 'authentication';
            if ($isLoginSecurity && $alertUserLabel !== 'Unknown user' && $alertUserLabel !== 'Unknown user (guest)') {
                // Append user to message if not already present
                if (stripos($displayMessage, $alertUsername) === false && stripos($displayMessage, $alertEmail) === false) {
                    $displayMessage = "User: {$alertUserLabel} — " . $displayMessage;
                }
                // Also make title more specific with user for login security
                if (stripos($title, 'Failed Login') !== false || stripos($title, 'Account Lockout') !== false) {
                    $title = $title . ' — ' . strtok($alertUserLabel, ' ');
                    if (strlen($title) > 40) $title = trim(substr($title, 0, 40));
                }
            }

            $alerts[] = [
                'id' => 'activity_log:' . $id,
                'kind' => 'activity_signal',
                'severity' => $severity,
                'direction' => $direction,
                'ip_address' => $ip,
                'title' => $title,
                'message' => $displayMessage,
                'occurred_at' => $createdAt,
                'action' => $action,
                'activity_type' => $activityType,
                'user' => $alertUserLabel,
                'username' => $alertUsername,
                'user_id' => $alertUserId,
                'user_role' => $alertRole,
                'email' => $alertEmail,
            ];
        }
        $logsStmt->close();
    }

    // --- 2. Server rate-limiting: too much request for the server ---
    // Check request_rate_limits for clients that have hit high request counts recently
    $rateStmt = $conn->prepare("SELECT client_key, request_count, window_start, last_request_at FROM request_rate_limits WHERE request_count >= 50 AND last_request_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) ORDER BY request_count DESC LIMIT 10");
    if ($rateStmt) {
        $rateStmt->execute();
        $rateRows = $rateStmt->get_result();
        while ($r = $rateRows->fetch_assoc()) {
            $cnt = intval($r['request_count'] ?? 0);
            $lastAt = (string)($r['last_request_at'] ?? date('Y-m-d H:i:s'));
            $windowStart = (string)($r['window_start'] ?? $lastAt);
            $alerts[] = [
                'id' => 'rate_limit:' . substr(hash('sha256', ($r['client_key'] ?? '') . $lastAt), 0, 16),
                'kind' => 'rate_limit',
                'severity' => $cnt >= 100 ? 'high' : 'medium',
                'direction' => 'inbound',
                'ip_address' => 'server',
                'title' => 'Too Many Requests For Server',
                'message' => "Client {$r['client_key']} sent {$cnt} requests in current window (window start {$windowStart}). Possible DoS / brute force.",
                'occurred_at' => $lastAt,
                'action' => 'rate_limit_exceeded',
                'activity_type' => 'security',
            ];
        }
        $rateStmt->close();
    }

    // --- 3. Backend editing frequency: show what's btn been edited, not generic backend label ---
    $editStmt = $conn->prepare("SELECT user_id, COUNT(*) as cnt, MAX(created_at) as last_at FROM activity_log WHERE activity_type='settings' AND action='update_system_settings' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) GROUP BY user_id HAVING cnt >= 3");
    if ($editStmt) {
        $editStmt->execute();
        $editRows = $editStmt->get_result();
        while ($er = $editRows->fetch_assoc()) {
            $uid = intval($er['user_id'] ?? 0);
            $cnt = intval($er['cnt'] ?? 0);
            $lastAt = (string)($er['last_at'] ?? date('Y-m-d H:i:s'));
            // Resolve username and get the most recent specific setting that was edited for this user
            $uStmt = $conn->prepare("SELECT username, role FROM users WHERE id=? LIMIT 1");
            $uname = "User #{$uid}";
            $urole = '';
            if ($uStmt) {
                $uStmt->bind_param('i', $uid);
                $uStmt->execute();
                $urow = $uStmt->get_result()->fetch_assoc();
                if ($urow) {
                    $uname = trim(($urow['username'] ?? '') !== '' ? $urow['username'] : $uname);
                    $urole = (string)($urow['role'] ?? '');
                }
                $uStmt->close();
            }
            // Fetch the latest specific setting description for this user to show what's btn was edited
            $descStmt = $conn->prepare("SELECT description FROM activity_log WHERE user_id=? AND activity_type='settings' AND action='update_system_settings' ORDER BY created_at DESC LIMIT 1");
            $specificTitle = 'Settings Updated';
            $specificDesc = '';
            if ($descStmt) {
                $descStmt->bind_param('i', $uid);
                $descStmt->execute();
                $drow = $descStmt->get_result()->fetch_assoc();
                if ($drow && !empty($drow['description'])) {
                    $specificDesc = trim((string)$drow['description']);
                    // Description is now friendly like "Updated Session Timeout: Manager Session Timeout, Staff Session Timeout"
                    $colonPos = strpos($specificDesc, ':');
                    if ($colonPos !== false) {
                        $specificTitle = trim(substr($specificDesc, 0, $colonPos));
                        $specificTitle = trim(str_ireplace('Updated', '', $specificTitle));
                        if ($specificTitle === '') $specificTitle = 'Settings Updated';
                        else $specificTitle = $specificTitle . ' Updated';
                    } else {
                        $specificTitle = strlen($specificDesc) > 36 ? trim(substr($specificDesc, 0, 36)) : $specificDesc;
                    }
                }
                $descStmt->close();
            }
            $alerts[] = [
                'id' => 'backend_edit:' . $uid . ':' . strtotime($lastAt),
                'kind' => 'backend_editing',
                'severity' => $cnt >= 8 ? 'high' : 'medium',
                'direction' => 'inbound',
                'ip_address' => 'settings',
                'title' => $specificTitle . " — {$cnt}× in 1h",
                'message' => "{$uname} ({$urole}) {$specificDesc} — {$cnt} times in the last hour (last at {$lastAt}).",
                'occurred_at' => $lastAt,
                'action' => 'update_system_settings',
                'activity_type' => 'settings',
            ];
        }
        $editStmt->close();
    }
    // Also flag users sending too many general requests in short time ( >30 logs in 10 min )
    $freqStmt = $conn->prepare("SELECT user_id, COUNT(*) as cnt, MAX(created_at) as last_at FROM activity_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) GROUP BY user_id HAVING cnt >= 30");
    if ($freqStmt) {
        $freqStmt->execute();
        $freqRows = $freqStmt->get_result();
        while ($fr = $freqRows->fetch_assoc()) {
            $uid = intval($fr['user_id'] ?? 0);
            $cnt = intval($fr['cnt'] ?? 0);
            if ($cnt < 30) continue;
            $lastAt = (string)($fr['last_at'] ?? date('Y-m-d H:i:s'));
            $uStmt = $conn->prepare("SELECT username FROM users WHERE id=? LIMIT 1");
            $uname = "User #{$uid}";
            if ($uStmt) {
                $uStmt->bind_param('i', $uid);
                $uStmt->execute();
                $urow = $uStmt->get_result()->fetch_assoc();
                if ($urow && !empty($urow['username'])) $uname = $urow['username'];
                $uStmt->close();
            }
            $alerts[] = [
                'id' => 'freq_request:' . $uid . ':' . strtotime($lastAt),
                'kind' => 'too_many_requests',
                'severity' => 'high',
                'direction' => 'inbound',
                'ip_address' => 'multiple',
                'title' => 'Sending Too Much Request',
                'message' => "{$uname} sent {$cnt} requests in the last 10 minutes (last at {$lastAt}). Possible automated / abusive traffic.",
                'occurred_at' => $lastAt,
                'action' => 'too_many_requests',
                'activity_type' => 'security',
            ];
        }
        $freqStmt->close();
    }

    usort($alerts, function ($a, $b) {
        $ta = strtotime((string)($a['occurred_at'] ?? '')) ?: 0;
        $tb = strtotime((string)($b['occurred_at'] ?? '')) ?: 0;
        return $tb <=> $ta;
    });

    if (count($alerts) > $limit) {
        $alerts = array_slice($alerts, 0, $limit);
    }

    sendResponse(true, [
        'alerts' => $alerts,
        'lockdown' => [
            'enabled' => !empty($lockdown['enabled']),
            'reason' => (string)($lockdown['reason'] ?? ''),
            'updated_at' => formatIsoDateTime((string)($lockdown['updated_at'] ?? '')),
            'updated_by' => (string)($lockdown['updated_by'] ?? ''),
        ],
        'generated_at' => date('Y-m-d H:i:s'),
    ], 'Security alerts retrieved.');
}

closeDBConnection($conn);
?>
