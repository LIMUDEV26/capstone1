<?php
/**
 * Shared password policy helpers.
 *
 * Enforces:
 * - password expiration after a configured number of days
 * - password history reuse prevention
 * - password metadata on every password change
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';
require_once __DIR__ . '/mailer.php';

function ensurePasswordPolicySchema($conn) {
    if (isPostgresConnection($conn)) return;
    ensureColumn($conn, 'users', 'password_changed_at', '`password_changed_at` DATETIME NULL');
    ensureColumn($conn, 'users', 'password_expires_at', '`password_expires_at` DATETIME NULL');

    $sql = "CREATE TABLE IF NOT EXISTS password_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_password_history_user_created (user_id, created_at DESC),
        INDEX idx_password_history_user_hash (user_id, password_hash(191)),
        CONSTRAINT fk_password_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log('Failed to ensure password_history table: ' . $conn->error);
    }

    if (function_exists('ensureTableIndex')) {
        ensureTableIndex($conn, 'password_history', 'idx_password_history_user_created', "ALTER TABLE password_history ADD INDEX idx_password_history_user_created (user_id, created_at DESC)");
        ensureTableIndex($conn, 'password_history', 'idx_password_history_user_hash', "ALTER TABLE password_history ADD INDEX idx_password_history_user_hash (user_id, password_hash(191))");
    }
}

function getPasswordPolicySettingInt($conn, $key, $default, $min, $max) {
    $stmt = $conn->prepare("SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1");
    if (!$stmt) {
        return $default;
    }

    $stmt->bind_param('s', $key);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();
    $stmt->close();

    if (!$row || !is_numeric($row['setting_value'])) {
        return $default;
    }

    return max($min, min($max, (int)$row['setting_value']));
}

function getPasswordPolicy($conn) {
    ensurePasswordPolicySchema($conn);

    return [
        'max_age_days' => getPasswordPolicySettingInt($conn, 'password_max_age_days', 90, 1, 365),
        'history_count' => getPasswordPolicySettingInt($conn, 'password_history_count', 5, 1, 50),
    ];
}

function savePasswordPolicySetting($conn, $key, $value) {
    $stmt = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type, updated_at)
         VALUES (?, ?, 'number', NOW())
         ON DUPLICATE KEY UPDATE setting_value = ?, setting_type = 'number', updated_at = NOW()"
    );
    if (!$stmt) {
        sendError('Failed to prepare password policy setting update', 500);
    }

    $storeValue = (string)(int)$value;
    $stmt->bind_param('sss', $key, $storeValue, $storeValue);
    if (!$stmt->execute()) {
        $stmt->close();
        sendError('Failed to save password policy setting', 500);
    }
    $stmt->close();
}

function updatePasswordPolicy($conn, $maxAgeDays, $historyCount) {
    $maxAgeDays = max(1, min(365, (int)$maxAgeDays));
    $historyCount = max(1, min(50, (int)$historyCount));

    savePasswordPolicySetting($conn, 'password_max_age_days', $maxAgeDays);
    savePasswordPolicySetting($conn, 'password_history_count', $historyCount);

    $update = $conn->prepare(
        "UPDATE users
         SET password_expires_at = DATE_ADD(COALESCE(password_changed_at, NOW()), INTERVAL ? DAY)
         WHERE id > 0"
    );
    if ($update) {
        $update->bind_param('i', $maxAgeDays);
        $update->execute();
        $update->close();
    }

    return [
        'max_age_days' => $maxAgeDays,
        'history_count' => $historyCount,
    ];
}

function isPasswordChangeRequired($user, $policy = null) {
    $role = strtolower(trim((string)($user['role'] ?? '')));
    if ($role !== 'admin' && (int)($user['must_reset_password'] ?? 0) === 1) {
        return true;
    }

    if (empty($user['password_changed_at']) || empty($user['password_expires_at'])) {
        return true;
    }

    $expiresAt = strtotime((string)$user['password_expires_at']);
    return $expiresAt === false || $expiresAt < time();
}

function getPasswordChangeReasonForUser($user) {
    if (!isPasswordChangeRequired($user)) {
        return '';
    }

    $role = strtolower(trim((string)($user['role'] ?? '')));
    $mustReset = (int)($user['must_reset_password'] ?? 0);

    // must_reset_password flag always means first-login for non-admin users —
    // it is only set at registration, never by the expiry path.
    if ($role !== 'admin' && $mustReset === 1) {
        return 'first_login';
    }

    return 'expired';
}

function preparePasswordExpirationForUser($conn, $user) {
    ensurePasswordPolicySchema($conn);

    $userId = (int)($user['id'] ?? 0);
    if ($userId <= 0) {
        return $user;
    }

    $policy = getPasswordPolicy($conn);
    $now = time();
    $changedAt = (string)($user['password_changed_at'] ?? '');
    $expiresAt = (string)($user['password_expires_at'] ?? '');

    if ($changedAt === '') {
        $changedAt = date('Y-m-d H:i:s', $now);
        $expiresAt = date('Y-m-d H:i:s', $now + ($policy['max_age_days'] * 86400));
        $update = $conn->prepare("UPDATE users SET password_changed_at = ?, password_expires_at = ? WHERE id = ?");
        if ($update) {
            $update->bind_param('ssi', $changedAt, $expiresAt, $userId);
            $update->execute();
            $update->close();
        }
    } elseif ($expiresAt === '') {
        $expiresAt = date('Y-m-d H:i:s', strtotime($changedAt) + ($policy['max_age_days'] * 86400));
        $update = $conn->prepare("UPDATE users SET password_expires_at = ? WHERE id = ?");
        if ($update) {
            $update->bind_param('si', $expiresAt, $userId);
            $update->execute();
            $update->close();
        }
    }

    $user['password_changed_at'] = $changedAt;
    $user['password_expires_at'] = $expiresAt;

    if (isPasswordChangeRequired($user, $policy)) {
        $update = $conn->prepare("UPDATE users SET must_reset_password = 1 WHERE id = ?");
        if ($update) {
            $update->bind_param('i', $userId);
            $update->execute();
            $update->close();
        }
        $user['must_reset_password'] = 1;
    }

    return $user;
}

function getPasswordChangeStatus($conn, $user) {
    ensurePasswordPolicySchema($conn);

    $policy = getPasswordPolicy($conn);
    $userId = (int)($user['id'] ?? 0);
    if ($userId > 0) {
        $user = preparePasswordExpirationForUser($conn, $user);
    }

    $changedAt = (string)($user['password_changed_at'] ?? '');
    $expiresAt = (string)($user['password_expires_at'] ?? '');
    $expiresTimestamp = strtotime($expiresAt);
    $passwordExpired = $expiresTimestamp === false || $expiresTimestamp < time();
    $requiresChange = isPasswordChangeRequired($user, $policy);

    return [
        'expired' => $passwordExpired,
        'requires_change' => $requiresChange,
        'reason' => getPasswordChangeReasonForUser($user),
        'max_age_days' => $policy['max_age_days'],
        'history_count' => $policy['history_count'],
        'password_changed_at' => $changedAt,
        'password_expires_at' => $expiresAt,
        'days_remaining' => $expiresTimestamp === false ? null : max(0, (int)floor(($expiresTimestamp - time()) / 86400)),
    ];
}

function validateAndHashPasswordForChange($conn, $userId, $newPassword, $currentPasswordHash, $historyCount) {
    $newPassword = (string)$newPassword;
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

    if ($currentPasswordHash !== '' && verifyPassword($newPassword, (string)$currentPasswordHash)) {
        sendError('New password must be different from your current password.', 400);
    }

    $newHash = hashPassword($newPassword);

    ensurePasswordPolicySchema($conn);

    $historyCount = max(1, min(50, (int)$historyCount));
    $stmt = $conn->prepare("SELECT id FROM password_history WHERE user_id = ? AND password_hash = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to check password history', 500);
    }
    $userId = (int)$userId;
    $stmt->bind_param('is', $userId, $newHash);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError("Password cannot be reused. Choose a password that was not used in your last {$historyCount} password changes.", 400);
    }

    return $newHash;
}

function recordPasswordHistory($conn, $userId, $oldHash, $newHash, $historyCount) {
    ensurePasswordPolicySchema($conn);

    $userId = (int)$userId;
    $historyCount = max(1, min(50, (int)$historyCount));
    $oldHash = (string)$oldHash;

    if ($oldHash !== '' && $oldHash !== $newHash) {
        $duplicateCheck = $conn->prepare("SELECT id FROM password_history WHERE user_id = ? AND password_hash = ? LIMIT 1");
        if ($duplicateCheck) {
            $duplicateCheck->bind_param('is', $userId, $oldHash);
            $duplicateCheck->execute();
            $duplicateExists = $duplicateCheck->get_result()->num_rows > 0;
            $duplicateCheck->close();

            if (!$duplicateExists) {
                $insert = $conn->prepare("INSERT INTO password_history (user_id, password_hash, created_at) VALUES (?, ?, NOW())");
                if ($insert) {
                    $insert->bind_param('is', $userId, $oldHash);
                    $insert->execute();
                    $insert->close();
                }
            }
        }
    }

    $oldRows = $conn->prepare("SELECT id FROM password_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?, 18446744073709551615");
    if ($oldRows) {
        $offset = $historyCount;
        $oldRows->bind_param('ii', $userId, $offset);
        $oldRows->execute();
        $oldResult = $oldRows->get_result();
        $oldIds = [];
        while ($row = $oldResult->fetch_assoc()) {
            $oldIds[] = (int)$row['id'];
        }
        $oldRows->close();

        if (!empty($oldIds)) {
            $placeholders = implode(',', array_fill(0, count($oldIds), '?'));
            $delete = $conn->prepare("DELETE FROM password_history WHERE id IN ($placeholders)");
            if ($delete) {
                $types = str_repeat('i', count($oldIds));
                $delete->bind_param($types, ...$oldIds);
                $delete->execute();
                $delete->close();
            }
        }
    }
}

function persistPasswordChange($conn, $userId, $newHash, $currentPasswordHash, $historyCount, $maxAgeDays, $clearMustReset = true) {
    ensurePasswordPolicySchema($conn);

    $userId = (int)$userId;
    $historyCount = max(1, min(50, (int)$historyCount));
    $maxAgeDays = max(1, min(365, (int)$maxAgeDays));
    $expiresAt = date('Y-m-d H:i:s', time() + ($maxAgeDays * 86400));

    recordPasswordHistory($conn, $userId, $currentPasswordHash, $newHash, $historyCount);

    $updates = ["password = ?", "password_changed_at = NOW()", "password_expires_at = ?"];
    $types = 'ssi';
    $params = [$newHash, $expiresAt, $userId];

    if ($clearMustReset) {
        $updates[] = "must_reset_password = 0";
    }

    $sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare password update', 500);
    }

    $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        $stmt->close();
        sendError('Failed to update password', 500);
    }
    $stmt->close();

    return $expiresAt;
}

function sendPasswordChangeOtpEmail($user, $otp) {
    $toEmail = trim((string)($user['email'] ?? ''));
    if ($toEmail === '') {
        return false;
    }

    $fullName = trim((string)(($user['first_name'] ?? '') . ' ' . ($user['last_name'] ?? '')));
    $displayName = $fullName ?: ($user['username'] ?? $toEmail);
    $safeName = htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8');
    $safeOtp  = htmlspecialchars((string)$otp, ENT_QUOTES, 'UTF-8');

    $innerHtml = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#374151;">Hi ' . $safeName . ',</p>'
        . '<p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#374151;">'
        . 'Your one-time password (OTP) for changing your account password is:</p>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px auto;">'
        . '<tr><td style="background:#f1f5f9;border:2px solid #0f2d74;border-radius:10px;padding:16px 36px;text-align:center;">'
        . '<span style="font-size:32px;font-weight:700;letter-spacing:10px;color:#0f2d74;font-family:monospace;">' . $safeOtp . '</span>'
        . '</td></tr></table>'
        . '<p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#6b7280;">'
        . 'This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>'
        . '<p style="margin:0;font-size:13px;line-height:1.6;color:#dc2626;">'
        . 'If you did not request this, your account may be at risk — change your password immediately.</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($innerHtml, 'Your LLB Accountants OTP code')
        : $innerHtml;

    return function_exists('sendMail') && sendMail($toEmail, $fullName, 'Your OTP for password change – LLB Accountants', $html);
}
