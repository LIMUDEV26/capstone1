<?php
/**
 * Browser Lockout API
 * Tracks failed login attempts per browser fingerprint.
 * On the configured threshold attempt: blocks the browser and sends "Intruder blocked" system notification.
 *
 * GET  ?action=check           — check if current browser is blocked (public)
 * POST ?action=record_attempt  — record a failed login attempt (public)
 * GET  ?action=list            — admin: list all blocked browsers
 * GET  ?action=settings        — admin: get current threshold setting
 * POST ?action=save_settings   — admin: save threshold setting
 * POST ?action=unblock         — admin: unblock a browser by id
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';
// Lockout flows may write session state — keep the session lock.
$GLOBALS['LLB_KEEP_SESSION_LOCK'] = true;

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

ensureBrowserLockoutStorage($conn);

$action = trim((string)($_GET['action'] ?? 'check'));

// ── Public endpoints (no auth) ────────────────────────────────────────────────
if ($method === 'GET' && $action === 'check') {
    handleCheckBrowserBlocked($conn);
    exit;
}

if ($method === 'POST' && $action === 'record_attempt') {
    handleRecordLoginAttempt($conn);
    exit;
}

// ── Admin-only endpoints ──────────────────────────────────────────────────────
requireAuth();
requireRole(['admin']);

if ($method === 'GET' && $action === 'list') {
    handleListBlockedBrowsers($conn);
} elseif ($method === 'GET' && $action === 'settings') {
    handleGetSettings($conn);
} elseif ($method === 'POST' && $action === 'save_settings') {
    handleSaveSettings($conn);
} elseif ($method === 'POST' && $action === 'unblock') {
    handleUnblockBrowser($conn);
} elseif ($method === 'DELETE' && $action === 'unblock') {
    handleUnblockBrowser($conn);
} else {
    sendError('Invalid action', 400);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the browser_lockout_attempts table exists.
 */
function ensureBrowserLockoutStorage($conn) {
    static $done = false;
    if ($done) return;
    $done = true;

    runRuntimeSchemaUpgradeOnce('browser_lockout_storage_v2', function () use ($conn) {
    // This endpoint is public and can run before the authenticated
    // notifications endpoint has had a chance to initialize its storage.
    // Keep the schema in sync with ensureAINotificationsTable() there so a
    // fresh database does not fail its first browser-lockout check.
    $conn->query("
        CREATE TABLE IF NOT EXISTS ai_notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            event_type VARCHAR(50) NOT NULL,
            target_user_id INT NOT NULL,
            target_role ENUM('admin', 'manager', 'staff') NOT NULL,
            ai_message TEXT NOT NULL,
            icon_emoji VARCHAR(10) DEFAULT '🔔',
            priority_score INT DEFAULT 5,
            suggested_action VARCHAR(255),
            action_url VARCHAR(500),
            context_json JSON,
            is_sent BOOLEAN DEFAULT FALSE,
            sent_at TIMESTAMP NULL,
            read_at TIMESTAMP NULL,
            expires_at TIMESTAMP NULL,
            source ENUM('base44_ai', 'fallback', 'manual') DEFAULT 'base44_ai',
            user_rating INT NULL,
            was_action_taken BOOLEAN DEFAULT FALSE,
            dismissed BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_target_user (target_user_id, is_sent, created_at),
            INDEX idx_event_type (event_type, created_at),
            INDEX idx_target_role (target_role, created_at),
            INDEX idx_priority (priority_score DESC, created_at),
            INDEX idx_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    // Heal any previously inserted but unsent intruder_blocked notifications.
    $conn->query("
        UPDATE ai_notifications
        SET is_sent = 1, sent_at = NOW()
        WHERE event_type = 'intruder_blocked'
          AND is_sent = 0
          AND (expires_at IS NULL OR expires_at > NOW())
    ");

    $conn->query("
        CREATE TABLE IF NOT EXISTS browser_lockout_attempts (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            browser_key   VARCHAR(64)  NOT NULL,
            ip_address    VARCHAR(64)  NOT NULL DEFAULT '',
            attempt_count INT          NOT NULL DEFAULT 0,
            is_blocked    TINYINT(1)   NOT NULL DEFAULT 0,
            blocked_at    DATETIME     NULL,
            last_attempt  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            notes         VARCHAR(255) NULL,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_browser_key (browser_key),
            INDEX idx_bla_blocked (is_blocked),
            INDEX idx_bla_last_attempt (last_attempt)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    });
}

/**
 * Resolve the browser fingerprint key from the request.
 */
function resolveBrowserKey() {
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));

    if ($xff !== '' && isLocalhostOrPrivate($remote)) {
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') {
            $remote = $candidate;
        }
    }

    $ua = trim((string)($_SERVER['HTTP_USER_AGENT'] ?? ''));
    // Combine IP + UA so rotating UA with same IP still gets a unique key.
    return 'bk_' . substr(hash('sha256', $remote . '|' . $ua), 0, 40);
}

/**
 * Resolve the raw IP used in the request.
 */
function resolveClientIp() {
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
    if ($xff !== '' && isLocalhostOrPrivate($remote)) {
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') return $candidate;
    }
    return $remote;
}

/**
 * GET ?action=check — returns { blocked: true|false, attempt_count: int }
 */
function handleCheckBrowserBlocked($conn) {
    // If the feature is disabled, always report not blocked.
    if (!getBrowserLockoutEnabled($conn)) {
        sendResponse(true, ['blocked' => false, 'attempt_count' => 0], 'ok');
        return;
    }

    $key = resolveBrowserKey();
    $stmt = $conn->prepare(
        "SELECT is_blocked, attempt_count FROM browser_lockout_attempts WHERE browser_key = ? LIMIT 1"
    );
    if (!$stmt) {
        sendResponse(true, ['blocked' => false, 'attempt_count' => 0], 'ok');
        return;
    }
    $stmt->bind_param('s', $key);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    sendResponse(true, [
        'blocked'       => $row ? (bool)$row['is_blocked'] : false,
        'attempt_count' => $row ? (int)$row['attempt_count'] : 0,
    ], 'ok');
}

/**
 * Load whether browser lockout is enabled (default true).
 */
function getBrowserLockoutEnabled($conn) {
    static $cached = null;
    if ($cached !== null) return $cached;

    $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = 'browser_lockout_enabled' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($val);
        if ($stmt->fetch() && $val !== null) {
            $cached = ($val === '1' || $val === 'true');
        }
        $stmt->close();
    }

    if ($cached === null) {
        $conn->query("INSERT IGNORE INTO settings (setting_key, setting_value, setting_type) VALUES ('browser_lockout_enabled', '1', 'boolean')");
        $cached = true;
    }
    return $cached;
}

/**
 * Load the block threshold from settings (default 10).
 */
function getBrowserLockoutThreshold($conn) {
    static $cached = null;
    if ($cached !== null) return $cached;

    $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = 'browser_lockout_threshold' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($val);
        if ($stmt->fetch() && $val !== null && (int)$val > 0) {
            $cached = max(1, min(50, (int)$val));
        }
        $stmt->close();
    }

    if ($cached === null) {
        // Seed default if not present
        $conn->query("INSERT IGNORE INTO settings (setting_key, setting_value, setting_type) VALUES ('browser_lockout_threshold', '10', 'number')");
        $cached = 10;
    }
    return $cached;
}

/**
 * POST ?action=record_attempt — increment counter, block on configured threshold.
 * Returns { blocked: bool, attempt_count: int, just_blocked: bool }
 */
function handleRecordLoginAttempt($conn) {
    // If the feature is disabled, skip tracking entirely.
    if (!getBrowserLockoutEnabled($conn)) {
        sendResponse(true, ['blocked' => false, 'attempt_count' => 0, 'just_blocked' => false], 'ok');
        return;
    }

    $key = resolveBrowserKey();
    $ip  = resolveClientIp();
    $now = date('Y-m-d H:i:s');
    $blockThreshold = getBrowserLockoutThreshold($conn);

    // Upsert: insert or increment
    $upsert = $conn->prepare("
        INSERT INTO browser_lockout_attempts (browser_key, ip_address, attempt_count, is_blocked, last_attempt)
        VALUES (?, ?, 1, 0, ?)
        ON DUPLICATE KEY UPDATE
            attempt_count = attempt_count + 1,
            ip_address    = VALUES(ip_address),
            last_attempt  = VALUES(last_attempt),
            updated_at    = CURRENT_TIMESTAMP
    ");
    if ($upsert) {
        $upsert->bind_param('sss', $key, $ip, $now);
        $upsert->execute();
        $upsert->close();
    }

    // Read back current count
    $read = $conn->prepare("SELECT id, attempt_count, is_blocked FROM browser_lockout_attempts WHERE browser_key = ? LIMIT 1");
    if (!$read) {
        sendResponse(true, ['blocked' => false, 'attempt_count' => 0, 'just_blocked' => false], 'ok');
        return;
    }
    $read->bind_param('s', $key);
    $read->execute();
    $row = $read->get_result()->fetch_assoc();
    $read->close();

    $count = (int)($row['attempt_count'] ?? 0);
    $alreadyBlocked = (bool)($row['is_blocked'] ?? false);
    $rowId = (int)($row['id'] ?? 0);

    $justBlocked = false;

    if (!$alreadyBlocked && $count >= $blockThreshold) {
        // Block the browser
        $block = $conn->prepare("UPDATE browser_lockout_attempts SET is_blocked = 1, blocked_at = ? WHERE browser_key = ?");
        if ($block) {
            $block->bind_param('ss', $now, $key);
            $block->execute();
            $block->close();
        }
        $justBlocked = true;
        $alreadyBlocked = true;

        // Send "Intruder blocked" security notification to all admin users
        sendIntruderBlockedNotification($conn, $key, $ip, $count);
    }

    sendResponse(true, [
        'blocked'       => $alreadyBlocked,
        'attempt_count' => $count,
        'just_blocked'  => $justBlocked,
    ], $justBlocked ? 'Browser blocked after ' . $count . ' failed attempts.' : 'Attempt recorded.');
}

/**
 * Insert an "Intruder blocked" security notification into activity_log
 * and the system notifications table for all admins.
 */
function sendIntruderBlockedNotification($conn, $browserKey, $ip, $attemptCount) {
    $desc = "Intruder blocked: Browser fingerprint '{$browserKey}' from IP {$ip} was blocked after {$attemptCount} failed login attempts.";

    // Log in activity_log so the Security Alerts panel picks it up
    // (NULL user — 0 would violate the users FK and 500 the request).
    logActivity($conn, null, 'intruder_blocked', $desc, 'security');

    // Also insert into ai_notifications targeting all admins
    $adminStmt = $conn->prepare("SELECT id FROM users WHERE LOWER(TRIM(role)) = 'admin' AND status = 'active' LIMIT 20");
    if (!$adminStmt) return;
    $adminStmt->execute();
    $admins = $adminStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $adminStmt->close();

    $expiresAt = date('Y-m-d H:i:s', time() + 7 * 86400); // 7-day TTL
    $message = "Intruder blocked — browser from IP {$ip} was blocked after {$attemptCount} consecutive failed login attempts.";
    $title = 'Intruder Blocked';

    foreach ($admins as $admin) {
        $adminId = (int)$admin['id'];
        $ins = $conn->prepare("
            INSERT INTO ai_notifications
                (event_type, target_user_id, target_role, ai_message, icon_emoji, priority_score,
                 suggested_action, action_url, source, is_sent, sent_at, expires_at)
            VALUES
                ('intruder_blocked', ?, 'admin', ?, '🚫', 10,
                 'Review browser lockouts in Settings',
                 '/settings/browser-lockout',
                 'manual', 1, NOW(), ?)
        ");
        if ($ins) {
            $ins->bind_param('iss', $adminId, $message, $expiresAt);
            $ins->execute();
            $ins->close();
        }
    }
}

/**
 * GET ?action=settings — return the current threshold + enabled flag.
 */
function handleGetSettings($conn) {
    $threshold = getBrowserLockoutThreshold($conn);
    $enabled   = getBrowserLockoutEnabled($conn);
    sendResponse(true, [
        'browser_lockout_threshold' => $threshold,
        'browser_lockout_enabled'   => $enabled,
    ], 'ok');
}

/**
 * POST ?action=save_settings — update threshold and/or enabled flag.
 * Body: { threshold?: int, enabled?: bool }
 */
function handleSaveSettings($conn) {
    $data = getJSONInput();
    $callerId = intval($_SESSION['user_id'] ?? 0);

    // Save enabled flag if provided
    if (array_key_exists('enabled', $data)) {
        $enabledVal = ($data['enabled'] === true || $data['enabled'] === 1 || $data['enabled'] === '1') ? '1' : '0';
        $stmt = $conn->prepare(
            "INSERT INTO settings (setting_key, setting_value, setting_type)
             VALUES ('browser_lockout_enabled', ?, 'boolean')
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)"
        );
        if ($stmt) {
            $stmt->bind_param('s', $enabledVal);
            $stmt->execute();
            $stmt->close();
        }
        $label = $enabledVal === '1' ? 'enabled' : 'disabled';
        logActivity($conn, $callerId, 'update_settings', "Browser lockout {$label}", 'settings');
    }

    // Save threshold if provided
    if (array_key_exists('threshold', $data)) {
        $raw = intval($data['threshold']);
        if ($raw < 1 || $raw > 50) {
            sendError('Threshold must be between 1 and 50.', 400);
        }
        $val = (string)$raw;
        $stmt = $conn->prepare(
            "INSERT INTO settings (setting_key, setting_value, setting_type)
             VALUES ('browser_lockout_threshold', ?, 'number')
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)"
        );
        if (!$stmt) {
            sendError('Failed to save setting.', 500);
        }
        $stmt->bind_param('s', $val);
        $stmt->execute();
        $stmt->close();
        logActivity($conn, $callerId, 'update_settings', "Browser lockout threshold updated to {$raw}", 'settings');
    }

    $threshold = getBrowserLockoutThreshold($conn);
    $enabled   = getBrowserLockoutEnabled($conn);
    sendResponse(true, [
        'browser_lockout_threshold' => $threshold,
        'browser_lockout_enabled'   => $enabled,
    ], 'Settings saved.');
}

/**
 * GET ?action=list — admin list of all blocked/tracked browsers
 */
function handleListBlockedBrowsers($conn) {
    $blockedOnly = isset($_GET['blocked_only']) && $_GET['blocked_only'] === '1';

    $sql = "SELECT id, browser_key, ip_address, attempt_count, is_blocked, blocked_at, last_attempt, notes, created_at
            FROM browser_lockout_attempts";
    if ($blockedOnly) {
        $sql .= " WHERE is_blocked = 1";
    }
    $sql .= " ORDER BY last_attempt DESC LIMIT 500";

    $result = $conn->query($sql);
    $rows = [];
    if ($result) {
        while ($row = $result->fetch_assoc()) {
            $rows[] = [
                'id'            => (int)$row['id'],
                'browser_key'   => (string)$row['browser_key'],
                'ip_address'    => (string)$row['ip_address'],
                'attempt_count' => (int)$row['attempt_count'],
                'is_blocked'    => (bool)$row['is_blocked'],
                'blocked_at'    => $row['blocked_at'],
                'last_attempt'  => (string)$row['last_attempt'],
                'notes'         => $row['notes'],
                'created_at'    => (string)$row['created_at'],
            ];
        }
    }

    sendResponse(true, $rows, 'ok');
}

/**
 * POST ?action=unblock — admin unblocks a browser by id
 */
function handleUnblockBrowser($conn) {
    $data = getJSONInput();
    $id = intval($data['id'] ?? 0);
    if ($id <= 0) {
        sendError('Missing or invalid id', 400);
    }

    $stmt = $conn->prepare("UPDATE browser_lockout_attempts SET is_blocked = 0, attempt_count = 0, blocked_at = NULL WHERE id = ?");
    if (!$stmt) {
        sendError('Failed to unblock browser', 500);
    }
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $affected = $stmt->affected_rows;
    $stmt->close();

    if ($affected === 0) {
        sendError('Browser lockout record not found', 404);
    }

    $callerId = intval($_SESSION['user_id'] ?? 0);
    logActivity($conn, $callerId, 'browser_unblocked', "Admin unblocked browser lockout record #{$id}", 'security');

    sendResponse(true, ['id' => $id], 'Browser unblocked successfully.');
}
