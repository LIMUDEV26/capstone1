<?php
/**
 * Project Messages API
 * Handles internal project collaboration messages and branded email alerts.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

ensureProjectMessagesTable($conn);
ensureTaskCollaboratorsTable($conn);

switch ($method) {
    case 'GET':
        requireAuth();
        handleGet($conn);
        break;
    case 'POST':
        requireAuth();
        handlePost($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function ensureProjectMessagesTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS project_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                sender_id INT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_project (project_id),
                INDEX idx_sender (sender_id),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize project messages storage.', 500);
    }
}

function ensureTaskCollaboratorsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS task_collaborators (
                collaborator_id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                user_id INT NOT NULL,
                shift_mode ENUM('none', 'current_time', 'range') NOT NULL DEFAULT 'none',
                shift_start DATETIME NULL,
                shift_end DATETIME NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_task_collaborator (task_id, user_id),
                KEY idx_task_collaborators_user (user_id),
                KEY idx_task_collaborators_shift_start (shift_start),
                CONSTRAINT fk_task_collaborators_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_collaborators_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_collaborators_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize task collaborators storage.', 500);
    }
}

function ensureProjectExists($conn, $projectId) {
    $stmt = $conn->prepare("SELECT id FROM projects WHERE id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to validate project.', 500);
    }

    $stmt->bind_param('i', $projectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        sendError('Project not found.', 404);
    }
}

function userCanAccessProjectMessages($conn, $projectId, $userId, $role) {
    $normalizedRole = strtolower(trim((string)$role));
    if (!in_array($normalizedRole, ['admin', 'manager', 'staff'], true)) {
        return false;
    }

    ensureProjectExists($conn, $projectId);

    if ($normalizedRole !== 'staff') {
        return true;
    }

    $sql = "SELECT COUNT(*) AS cnt
            FROM tasks t
            WHERE t.project_id = ?
              AND (
                    t.assigned_to = ?
                    OR EXISTS (
                        SELECT 1
                        FROM task_collaborators tc
                        WHERE tc.task_id = t.id
                          AND tc.user_id = ?
                    )
              )";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to validate project chat access.', 500);
    }

    $stmt->bind_param('iii', $projectId, $userId, $userId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return intval($row['cnt'] ?? 0) > 0;
}

function requireProjectMessageAccess($conn, $projectId, $userId, $role) {
    if (!userCanAccessProjectMessages($conn, $projectId, $userId, $role)) {
        sendError('Access denied', 403);
    }
}

function requireProjectMessagePostAccess($conn, $projectId, $userId, $role) {
    requireProjectMessageAccess($conn, $projectId, $userId, $role);

    $normalizedRole = strtolower(trim((string)$role));
    if ($normalizedRole !== 'manager') {
        return;
    }

    $stmt = $conn->prepare("SELECT manager_id FROM projects WHERE id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to validate project message access.', 500);
    }

    $stmt->bind_param('i', $projectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row || intval($row['manager_id'] ?? 0) !== intval($userId)) {
        sendError('Managers can only post messages in projects assigned to them.', 403);
    }
}

function normalizeProjectMessage($value) {
    $message = trim((string)$value);
    if ($message === '') {
        return '';
    }

    $message = preg_replace("/\r\n?/", "\n", $message);
    $message = preg_replace("/\n{3,}/", "\n\n", $message);
    return trim((string)$message);
}

function buildProjectMessageFrontendBaseUrl() {
    $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
    if ($frontendBase !== '') {
        return rtrim($frontendBase, '/');
    }

    $referer = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    if ($referer !== '') {
        $parsed = parse_url($referer);
        if ($parsed && !empty($parsed['host'])) {
            $scheme = !empty($parsed['scheme']) ? $parsed['scheme'] : 'http';
            $port = !empty($parsed['port']) ? ':' . $parsed['port'] : '';
            return rtrim($scheme . '://' . $parsed['host'] . $port, '/');
        }
    }

    $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
    $scheme = $isHttps ? 'https' : 'http';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    return rtrim($scheme . '://' . $host, '/');
}

function formatProjectMessagePersonName($firstName, $lastName, $fallback = '') {
    $name = trim((string)$firstName . ' ' . (string)$lastName);
    if ($name !== '') {
        return $name;
    }

    $fallbackValue = trim((string)$fallback);
    return $fallbackValue !== '' ? $fallbackValue : 'Team Member';
}

function formatProjectMessageRoleLabel($role) {
    $normalized = strtolower(trim((string)$role));
    if ($normalized === '') {
        return 'Team member';
    }

    return ucwords(str_replace('_', ' ', $normalized));
}

function summarizeProjectMessageForEmail($message, $maxLength = 420) {
    $text = trim((string)$message);
    if ($text === '') {
        return 'No message content.';
    }

    $length = function_exists('mb_strlen') ? mb_strlen($text) : strlen($text);
    if ($length <= $maxLength) {
        return $text;
    }

    return function_exists('mb_substr')
        ? mb_substr($text, 0, $maxLength - 3) . '...'
        : substr($text, 0, $maxLength - 3) . '...';
}

function getProjectMessageNotificationContext($conn, $projectId, $senderId) {
    $sql = "SELECT p.id,
                   p.name AS project_name,
                   p.description AS project_description,
                   c.client_name,
                   c.contact_person,
                   c.email AS client_email,
                   u.first_name AS sender_first_name,
                   u.last_name AS sender_last_name,
                   u.email AS sender_email,
                   u.role AS sender_role
            FROM projects p
            LEFT JOIN client c ON c.client_id = p.client_id
            LEFT JOIN users u ON u.id = ?
            WHERE p.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log('getProjectMessageNotificationContext: prepare failed for project_id=' . intval($projectId) . ': ' . $conn->error);
        return null;
    }

    $stmt->bind_param('ii', $senderId, $projectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function getProjectMessageNotificationRecipients($conn, $projectId, $senderId) {
    $sql = "SELECT DISTINCT u.id,
                   u.email,
                   u.first_name,
                   u.last_name,
                   LOWER(COALESCE(u.role, '')) AS role
            FROM users u
            INNER JOIN (
                SELECT manager_id AS user_id
                FROM projects
                WHERE id = ?
                  AND manager_id IS NOT NULL

                UNION

                SELECT assigned_to AS user_id
                FROM tasks
                WHERE project_id = ?
                  AND assigned_to IS NOT NULL

                UNION

                SELECT tc.user_id AS user_id
                FROM task_collaborators tc
                INNER JOIN tasks t ON t.id = tc.task_id
                WHERE t.project_id = ?

                UNION

                SELECT id AS user_id
                FROM users
                WHERE LOWER(COALESCE(role, '')) = 'admin'
            ) participants ON participants.user_id = u.id
            WHERE u.id <> ?
              AND LOWER(COALESCE(u.role, '')) IN ('admin', 'manager', 'staff')
            ORDER BY
                CASE LOWER(COALESCE(u.role, ''))
                    WHEN 'admin' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                COALESCE(u.first_name, ''),
                COALESCE(u.last_name, ''),
                u.id";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log('getProjectMessageNotificationRecipients: prepare failed for project_id=' . intval($projectId) . ': ' . $conn->error);
        return [];
    }

    $stmt->bind_param('iiii', $projectId, $projectId, $projectId, $senderId);
    $stmt->execute();
    $result = $stmt->get_result();

    $recipients = [];
    while ($row = $result->fetch_assoc()) {
        $email = trim((string)($row['email'] ?? ''));
        if ($email === '' || !validateGmailComEmail($email)) {
            continue;
        }

        $recipients[] = $row;
    }

    $stmt->close();
    return $recipients;
}

function sendProjectMessageNotificationEmails($conn, $projectId, $senderId, $messageRow) {
    if (!function_exists('sendMail')) {
        error_log('sendProjectMessageNotificationEmails: sendMail function unavailable.');
        return ['attempted' => 0, 'sent' => 0];
    }

    $context = getProjectMessageNotificationContext($conn, $projectId, $senderId);
    if (!$context) {
        return ['attempted' => 0, 'sent' => 0];
    }

    $recipients = getProjectMessageNotificationRecipients($conn, $projectId, $senderId);
    if (empty($recipients)) {
        return ['attempted' => 0, 'sent' => 0];
    }

    $projectName = trim((string)($context['project_name'] ?? 'Project Workspace'));
    $clientName = trim((string)($context['client_name'] ?? ''));
    $contactPerson = trim((string)($context['contact_person'] ?? ''));
    $projectUrl = buildProjectMessageFrontendBaseUrl() . '/projects/detail?id=' . intval($projectId);
    $safeProjectUrl = htmlspecialchars($projectUrl, ENT_QUOTES, 'UTF-8');

    $senderName = trim((string)($messageRow['sender_name'] ?? ''));
    if ($senderName === '') {
        $senderName = formatProjectMessagePersonName(
            $context['sender_first_name'] ?? '',
            $context['sender_last_name'] ?? '',
            $context['sender_email'] ?? 'Team Member'
        );
    }
    $senderRoleLabel = formatProjectMessageRoleLabel($messageRow['sender_role'] ?? ($context['sender_role'] ?? ''));

    $messagePreview = summarizeProjectMessageForEmail($messageRow['message'] ?? '');
    $messagePreviewHtml = nl2br(htmlspecialchars($messagePreview, ENT_QUOTES, 'UTF-8'));
    $safeProjectName = htmlspecialchars($projectName, ENT_QUOTES, 'UTF-8');
    $safeClientName = htmlspecialchars($clientName !== '' ? $clientName : 'Not specified', ENT_QUOTES, 'UTF-8');
    $safeContactPerson = htmlspecialchars($contactPerson !== '' ? $contactPerson : 'Not specified', ENT_QUOTES, 'UTF-8');
    $safeSenderName = htmlspecialchars($senderName, ENT_QUOTES, 'UTF-8');
    $safeSenderRole = htmlspecialchars($senderRoleLabel, ENT_QUOTES, 'UTF-8');
    $safeSentAt = htmlspecialchars(
        !empty($messageRow['created_at']) ? date('F d, Y h:i A', strtotime((string)$messageRow['created_at'])) : date('F d, Y h:i A'),
        ENT_QUOTES,
        'UTF-8'
    );

    $subject = 'New project chat update: ' . $projectName;
    $preheader = 'A new collaboration message was posted in ' . $projectName . '.';
    $attempted = 0;
    $sentCount = 0;

    foreach ($recipients as $recipient) {
        $toEmail = trim((string)($recipient['email'] ?? ''));
        if ($toEmail === '') {
            continue;
        }

        $recipientName = formatProjectMessagePersonName(
            $recipient['first_name'] ?? '',
            $recipient['last_name'] ?? '',
            $toEmail
        );
        $safeRecipientName = htmlspecialchars($recipientName, ENT_QUOTES, 'UTF-8');

        $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.75;color:#0f172a;">Hello <strong>' . $safeRecipientName . '</strong>,</p>'
            . '<p style="margin:0 0 18px 0;font-size:14px;line-height:1.85;color:#334155;">A new collaboration message was posted in your project workspace. Review the message summary below and open the project hub for the full discussion.</p>'
            . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px 0;border-collapse:collapse;background:#ffffff;border:1px solid #dbe3ef;border-radius:16px;overflow:hidden;">'
            . '<tr><td style="padding:12px 14px;width:38%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Project</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeProjectName . '</td></tr>'
            . '<tr><td style="padding:12px 14px;width:38%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Client</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeClientName . '</td></tr>'
            . '<tr><td style="padding:12px 14px;width:38%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Contact Person</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeContactPerson . '</td></tr>'
            . '<tr><td style="padding:12px 14px;width:38%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;">Posted By</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #e2e8f0;">' . $safeSenderName . ' (' . $safeSenderRole . ')</td></tr>'
            . '<tr><td style="padding:12px 14px;width:38%;font-size:12px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#64748b;background:#f8fafc;">Sent At</td><td style="padding:12px 14px;font-size:13px;color:#0f172a;">' . $safeSentAt . '</td></tr>'
            . '</table>'
            . '<div style="margin:0 0 18px 0;padding:16px 18px;background:linear-gradient(135deg,#f8fbff 0%,#f2f7ff 100%);border:1px solid #d6e4ff;border-radius:16px;">'
            . '<div style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#1d4ed8;">Message Preview</div>'
            . '<div style="margin:0;font-size:14px;line-height:1.85;color:#0f172a;">' . $messagePreviewHtml . '</div>'
            . '</div>'
            . '<p style="margin:0 0 14px 0;text-align:center;">'
            . '<a href="' . $safeProjectUrl . '" style="display:inline-block;padding:13px 24px;border-radius:999px;background:#0f2d74;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 12px 26px rgba(15,45,116,0.18);">Open Project Collaboration Hub</a>'
            . '</p>'
            . '<p style="margin:0;font-size:12px;line-height:1.8;color:#64748b;text-align:center;">If the button does not open, use this link: <a href="' . $safeProjectUrl . '" style="color:#1d4ed8;text-decoration:none;">' . $safeProjectUrl . '</a></p>';

        $html = function_exists('buildBrandedEmailLayout')
            ? buildBrandedEmailLayout($content, $preheader)
            : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

        $alt = "Hello " . $recipientName . ",\n\n"
            . "A new collaboration message was posted in your project workspace.\n\n"
            . "Project: " . $projectName . "\n"
            . "Client: " . ($clientName !== '' ? $clientName : 'Not specified') . "\n"
            . "Contact Person: " . ($contactPerson !== '' ? $contactPerson : 'Not specified') . "\n"
            . "Posted By: " . $senderName . " (" . $senderRoleLabel . ")\n"
            . "Sent At: " . strip_tags(htmlspecialchars_decode($safeSentAt, ENT_QUOTES)) . "\n\n"
            . "Message Preview:\n"
            . $messagePreview . "\n\n"
            . "Open the project collaboration hub:\n" . $projectUrl;

        $attempted++;
        $sent = sendMail($toEmail, $recipientName, $subject, $html, $alt);
        if ($sent) {
            $sentCount++;
        } else {
            error_log('sendProjectMessageNotificationEmails: failed for project_id=' . intval($projectId) . ', recipient=' . $toEmail);
        }
    }

    return ['attempted' => $attempted, 'sent' => $sentCount];
}

function getProjectMessageById($conn, $messageId) {
    $sql = "SELECT pm.*,
                   CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS sender_name,
                   u.role AS sender_role
            FROM project_messages pm
            LEFT JOIN users u ON pm.sender_id = u.id
            WHERE pm.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to load the new project message.', 500);
    }

    $stmt->bind_param('i', $messageId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if ($row) {
        $row['sender_name'] = trim((string)($row['sender_name'] ?? ''));
    }

    return $row ?: null;
}

function handleGet($conn) {
    $projectId = intval($_GET['project_id'] ?? 0);
    if ($projectId <= 0) {
        sendError('Project ID required', 400);
    }

    $userId = intval($_SESSION['user_id'] ?? 0);
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    requireProjectMessageAccess($conn, $projectId, $userId, $role);

    $sql = "SELECT pm.*,
                   CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) AS sender_name,
                   u.role AS sender_role
            FROM project_messages pm
            LEFT JOIN users u ON pm.sender_id = u.id
            WHERE pm.project_id = ?
            ORDER BY pm.created_at ASC, pm.id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare project messages query.', 500);
    }

    $stmt->bind_param('i', $projectId);
    $stmt->execute();
    $result = $stmt->get_result();

    $messages = [];
    while ($row = $result->fetch_assoc()) {
        $row['sender_name'] = trim((string)($row['sender_name'] ?? ''));
        $messages[] = $row;
    }
    $stmt->close();

    sendResponse(true, $messages, 'Messages retrieved');
}

function handlePost($conn) {
    $data = getJSONInput();
    $projectId = intval($data['project_id'] ?? 0);
    $message = normalizeProjectMessage($data['message'] ?? '');

    if ($projectId <= 0) {
        sendError('Project ID required', 400);
    }
    if ($message === '') {
        sendError('Message is required', 400);
    }
    if (strlen($message) > 5000) {
        sendError('Message is too long (max 5000 characters).', 400);
    }

    $senderId = intval($_SESSION['user_id'] ?? 0);
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    requireProjectMessagePostAccess($conn, $projectId, $senderId, $role);

    $stmt = $conn->prepare("INSERT INTO project_messages (project_id, sender_id, message) VALUES (?, ?, ?)");
    if (!$stmt) {
        sendError('Failed to prepare project message insert.', 500);
    }

    $stmt->bind_param('iis', $projectId, $senderId, $message);

    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to send message.', 500);
    }

    $newId = intval($conn->insert_id);
    $stmt->close();

    $row = getProjectMessageById($conn, $newId);
    if (!$row) {
        sendError('Message sent, but the saved record could not be loaded.', 500);
    }

    $emailSummary = sendProjectMessageNotificationEmails($conn, $projectId, $senderId, $row);
    $row['notification_email_attempted'] = intval($emailSummary['attempted'] ?? 0);
    $row['notification_email_sent'] = intval($emailSummary['sent'] ?? 0);

    logActivity(
        $conn,
        $senderId,
        'project_message',
        'Posted a collaboration message on project ID: ' . $projectId,
        'project_management'
    );

    sendResponse(true, $row, 'Message sent');
}

closeDBConnection($conn);
?>
