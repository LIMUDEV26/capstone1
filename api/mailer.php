<?php
/**
 * PHPMailer bootstrap + helper for sending emails (reset password / OTP)
 *
 * Uses SMTP credentials from environment variables.
 */

// Load Composer autoloader
$vendorAutoload = __DIR__ . '/../vendor/autoload.php';
if (file_exists($vendorAutoload)) {
    require_once $vendorAutoload;
}

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

function isValidGmailAddress($email) {
    $value = trim((string)$email);
    if ($value === '') return false;
    if (!filter_var($value, FILTER_VALIDATE_EMAIL)) return false;
    return (bool)preg_match('/@(gmail\.com|phinmaed\.com)$/i', $value);
}

function resolveEmailBrandLogoPath() {
    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return '';
    }

    $rawCandidate = trim((string)(getenv('MAIL_BRAND_LOGO_PATH') ?: getenv('BRAND_LOGO_PATH') ?: ''));
    $candidates = [];

    if ($rawCandidate !== '') {
        $normalized = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $rawCandidate);
        $candidates[] = $normalized;
        $candidates[] = $projectRoot . DIRECTORY_SEPARATOR . ltrim($normalized, DIRECTORY_SEPARATOR);
    }

    // Email clients have uneven WebP support. Use the small PNG export for
    // inline embedding; the full-size logo.png is several megabytes.
    $candidates[] = $projectRoot . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'logo-email.png';
    $candidates[] = $projectRoot . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'logo-ui.webp';
    $candidates[] = $projectRoot . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'logo.png';
    $candidates[] = $projectRoot . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR . 'logo_v2.png';

    foreach ($candidates as $candidate) {
        $path = trim((string)$candidate);
        if ($path === '') {
            continue;
        }

        $realPath = realpath($path);
        if ($realPath !== false && is_file($realPath) && is_readable($realPath)) {
            return $realPath;
        }
    }

    return '';
}

function getEmailBranding() {
    $brandName = trim((string)(getenv('MAIL_BRAND_NAME') ?: getenv('SMTP_FROM_NAME') ?: 'LLB Accountants'));
    $supportEmail = trim((string)(getenv('SMTP_FROM_EMAIL') ?: getenv('SMTP_USERNAME') ?: ''));
    $logoUrl = trim((string)(getenv('MAIL_BRAND_LOGO_URL') ?: getenv('BRAND_LOGO_URL') ?: ''));
    $logoPath = resolveEmailBrandLogoPath();
    $logoCid = $logoPath !== '' ? 'brand-logo' : '';

    if ($logoUrl === '') {
        $frontendBase = trim((string)(getenv('FRONTEND_URL') ?: getenv('FRONTEND_BASE_URL') ?: ''));
        if ($frontendBase !== '') {
            $logoUrl = rtrim($frontendBase, '/') . '/logo-email.png';
        } else {
            $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
            $scheme = $isHttps ? 'https' : 'http';
            $host = trim((string)($_SERVER['HTTP_HOST'] ?? ''));
            if ($host !== '') {
                // Railway serves the Next.js public directory from the site root.
                $logoUrl = $scheme . '://' . $host . '/logo-email.png';
            }
        }
    }

    return [
        'brand_name' => $brandName !== '' ? $brandName : 'LLB Accountants',
        'logo_path' => $logoPath,
        'logo_cid' => $logoCid,
        'logo_url' => $logoUrl,
        'support_email' => $supportEmail,
        'year' => date('Y'),
    ];
}

function buildBrandedEmailLayout($contentHtml, $preheader = '') {
    $branding = getEmailBranding();
    $safeBrandName = htmlspecialchars((string)$branding['brand_name'], ENT_QUOTES, 'UTF-8');
    $logoPath = trim((string)($branding['logo_path'] ?? ''));
    $logoCid = trim((string)($branding['logo_cid'] ?? ''));
    $safeLogoUrl = htmlspecialchars((string)$branding['logo_url'], ENT_QUOTES, 'UTF-8');
    $safeSupportEmail = htmlspecialchars((string)$branding['support_email'], ENT_QUOTES, 'UTF-8');
    $safePreheader = htmlspecialchars((string)$preheader, ENT_QUOTES, 'UTF-8');
    $year = htmlspecialchars((string)$branding['year'], ENT_QUOTES, 'UTF-8');

    $logoSrc = '';
    if ($logoPath !== '' && $logoCid !== '') {
        $logoSrc = 'cid:' . $logoCid;
    } elseif ($safeLogoUrl !== '') {
        $logoSrc = html_entity_decode($safeLogoUrl, ENT_QUOTES, 'UTF-8');
    }

    $logoBlock = '';
    if ($logoSrc !== '') {
        $logoBlock = '<img src="' . htmlspecialchars($logoSrc, ENT_QUOTES, 'UTF-8') . '" alt="' . $safeBrandName . ' Logo" width="64" height="52" '
            . 'style="display:block;width:64px;height:52px;border:0;outline:none;text-decoration:none;margin:0 auto 10px auto;">';
    }

    $supportLine = '';
    if ($safeSupportEmail !== '') {
        $supportLine = '<p style="margin:8px 0 0 0;font-size:12px;line-height:1.6;color:#6b7280;">'
            . 'For assistance, contact <a href="mailto:' . $safeSupportEmail . '" style="color:#1d4ed8;text-decoration:none;">'
            . $safeSupportEmail . '</a>.</p>';
    }

    return '<div style="margin:0;padding:0;background:#f4f6fb;font-family:Segoe UI,Arial,sans-serif;color:#111827;">'
        . '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' . $safePreheader . '</div>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="padding:24px 12px;background:#f4f6fb;">'
        . '<tr><td align="center">'
        . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
        . 'style="max-width:680px;background:#ffffff;border:1px solid #dbe3ef;border-radius:12px;overflow:hidden;">'
        . '<tr><td style="background:#0f2d74;padding:16px 24px;color:#ffffff;">'
        . '<div style="font-size:18px;line-height:1.2;font-weight:700;">' . $safeBrandName . '</div>'
        . '<div style="margin-top:4px;font-size:12px;line-height:1.4;opacity:0.92;">Client Communication</div>'
        . '</td></tr>'
        . '<tr><td style="padding:22px 24px 8px 24px;text-align:center;">'
        . $logoBlock
        . '<div style="font-size:16px;line-height:1.4;font-weight:700;color:#111827;">' . $safeBrandName . '</div>'
        . '</td></tr>'
        . '<tr><td style="padding:10px 24px 20px 24px;">' . $contentHtml . '</td></tr>'
        . '<tr><td style="border-top:1px solid #e5e7eb;padding:14px 24px;background:#f9fafb;">'
        . '<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">&copy; ' . $year . ' ' . $safeBrandName . '. All rights reserved.</p>'
        . $supportLine
        . '</td></tr>'
        . '</table>'
        . '</td></tr>'
        . '</table>'
        . '</div>';
}

/**
 * Send an email using PHPMailer via SMTP.
 *
 * Returns true on success, false on failure.
 */
/**
 * Resolve and cache the best available CA bundle path.
 * Runs the filesystem scan once per process; subsequent calls return the cached value.
 */
function resolveSmtpCaBundle(): string {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $candidates = array_filter([
        (string)(ini_get('openssl.cafile') ?: ''),
        (string)(ini_get('curl.cainfo') ?: ''),
        'C:/xampp/apache/bin/curl-ca-bundle.crt',
        'C:/xampp/php/extras/ssl/cacert.pem',
        'C:/xampp/apache/conf/ssl.crt/server.crt',
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/ssl/certs/ca-bundle.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
    ]);
    $cached = '';
    foreach ($candidates as $candidate) {
        $candidate = trim((string)$candidate);
        if ($candidate !== '' && is_file($candidate) && is_readable($candidate)) {
            $cached = $candidate;
            break;
        }
    }
    return $cached;
}

function sendMailViaHttpsRelay($relayUrl, $relaySecret, $toEmail, $toName, $subject, $htmlBody, $altBody, $attachments, $cc) {
    if (!filter_var($relayUrl, FILTER_VALIDATE_URL) || stripos($relayUrl, 'https://') !== 0) {
        error_log('sendMail relay failed: MAIL_RELAY_URL must be an HTTPS URL.');
        return false;
    }

    $relayAttachments = [];
    $appendFile = static function ($path, $name = '', $mime = '', $cid = '') use (&$relayAttachments) {
        $path = trim((string)$path);
        if ($path === '' || !is_file($path) || !is_readable($path)) return;
        $content = file_get_contents($path);
        if ($content === false) return;
        $resolvedMime = trim((string)$mime);
        if ($resolvedMime === '' && function_exists('mime_content_type')) {
            $resolvedMime = (string)(mime_content_type($path) ?: '');
        }
        $relayAttachments[] = [
            'filename' => trim((string)$name) !== '' ? trim((string)$name) : basename($path),
            'content' => base64_encode($content),
            'contentType' => $resolvedMime !== '' ? $resolvedMime : 'application/octet-stream',
            'cid' => trim((string)$cid),
        ];
    };

    $branding = function_exists('getEmailBranding') ? getEmailBranding() : [];
    $logoPath = trim((string)($branding['logo_path'] ?? ''));
    $logoCid = trim((string)($branding['logo_cid'] ?? 'brand-logo'));
    if ($logoPath !== '' && $logoCid !== '' && stripos((string)$htmlBody, 'cid:' . $logoCid) !== false) {
        $appendFile($logoPath, basename($logoPath), '', $logoCid);
    }

    foreach ((array)$attachments as $attachment) {
        if (is_string($attachment)) {
            $appendFile($attachment);
            continue;
        }
        if (!is_array($attachment)) continue;
        $content = array_key_exists('content', $attachment) ? (string)($attachment['content'] ?? '') : '';
        $name = trim((string)($attachment['name'] ?? 'attachment'));
        $mime = trim((string)($attachment['mime'] ?? 'application/octet-stream'));
        if ($content !== '') {
            $relayAttachments[] = [
                'filename' => $name !== '' ? $name : 'attachment',
                'content' => base64_encode($content),
                'contentType' => $mime,
                'cid' => '',
            ];
        } else {
            $appendFile((string)($attachment['path'] ?? ''), $name, $mime);
        }
    }

    $relayCc = [];
    foreach ((array)$cc as $entry) {
        $email = is_array($entry) ? trim((string)($entry['email'] ?? '')) : trim((string)$entry);
        $name = is_array($entry) ? trim((string)($entry['name'] ?? '')) : '';
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $relayCc[] = ['email' => $email, 'name' => $name];
        }
    }

    $payload = json_encode([
        'to' => ['email' => (string)$toEmail, 'name' => (string)$toName],
        'cc' => $relayCc,
        'subject' => (string)$subject,
        'html' => (string)$htmlBody,
        'text' => (string)$altBody,
        'attachments' => $relayAttachments,
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($payload === false) {
        error_log('sendMail relay failed: could not encode the email payload.');
        return false;
    }

    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAuthorization: Bearer {$relaySecret}\r\n",
            'content' => $payload,
            'timeout' => 30,
            'ignore_errors' => true,
        ],
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
        ],
    ]);
    $response = @file_get_contents($relayUrl, false, $context);
    $statusLine = (string)($http_response_header[0] ?? '');
    $ok = $response !== false && preg_match('/\s2\d\d\s/', $statusLine) === 1;
    if (!$ok) {
        error_log('sendMail relay failed: ' . ($statusLine !== '' ? $statusLine : 'HTTPS request failed'));
    }
    return $ok;
}

/** Send through Gmail's REST API using OAuth refresh-token credentials. */
function sendMailViaGmailApi($toEmail, $toName, $subject, $htmlBody, $altBody, $attachments, $cc) {
    $clientId = trim((string)(getenv('GOOGLE_OAUTH_CLIENT_ID') ?: ''));
    $clientSecret = trim((string)(getenv('GOOGLE_OAUTH_CLIENT_SECRET') ?: ''));
    $refreshToken = trim((string)(getenv('GMAIL_API_REFRESH_TOKEN') ?: ''));
    $fromEmail = trim((string)(getenv('SMTP_FROM_EMAIL') ?: getenv('SMTP_USERNAME') ?: getenv('GMAIL_USERNAME') ?: ''));
    $fromName = trim((string)(getenv('SMTP_FROM_NAME') ?: 'LLB Accountants'));
    if ($clientId === '' || $clientSecret === '' || $refreshToken === '' || !filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
        error_log('Gmail API mail failed: configure Google OAuth client credentials, GMAIL_API_REFRESH_TOKEN, and a valid SMTP_FROM_EMAIL.');
        return false;
    }

    $postForm = static function ($url, array $fields) {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
                'content' => http_build_query($fields),
                'timeout' => 20,
                'ignore_errors' => true,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $body = @file_get_contents($url, false, $context);
        $status = (string)($http_response_header[0] ?? '');
        return [$body, $status];
    };
    [$tokenBody, $tokenStatus] = $postForm('https://oauth2.googleapis.com/token', [
        'client_id' => $clientId,
        'client_secret' => $clientSecret,
        'refresh_token' => $refreshToken,
        'grant_type' => 'refresh_token',
    ]);
    $tokenData = json_decode((string)$tokenBody, true);
    $accessToken = is_array($tokenData) ? trim((string)($tokenData['access_token'] ?? '')) : '';
    if ($accessToken === '') {
        error_log('Gmail API mail failed while refreshing OAuth access token: ' . ($tokenStatus !== '' ? $tokenStatus : 'HTTPS request failed') . '; response=' . substr((string)$tokenBody, 0, 400));
        return false;
    }

    $cleanHeader = static function ($value) { return trim(str_replace(["\r", "\n"], '', (string)$value)); };
    $encodedName = static function ($value) use ($cleanHeader) {
        $value = $cleanHeader($value);
        return $value !== '' && function_exists('mb_encode_mimeheader') ? mb_encode_mimeheader($value, 'UTF-8', 'B', "\r\n") : $value;
    };
    $formatAddress = static function ($email, $name = '') use ($cleanHeader, $encodedName) {
        $email = $cleanHeader($email);
        $name = $encodedName($name);
        return $name !== '' ? '"' . addcslashes($name, "\\\"") . '" <' . $email . '>' : $email;
    };
    $boundaryMixed = 'llb_m_' . bin2hex(random_bytes(12));
    $boundaryRelated = 'llb_r_' . bin2hex(random_bytes(12));
    $boundaryAlt = 'llb_a_' . bin2hex(random_bytes(12));
    $plainText = (string)$altBody;
    if ($plainText === '') $plainText = strip_tags((string)preg_replace('/<style\b[^>]*>.*?<\/style>/is', '', $htmlBody));
    $mime = 'From: ' . $formatAddress($fromEmail, $fromName) . "\r\n";
    $mime .= 'To: ' . $formatAddress($toEmail, $toName ?: $toEmail) . "\r\n";
    $ccHeaders = [];
    foreach ((array)$cc as $entry) {
        $email = is_array($entry) ? trim((string)($entry['email'] ?? '')) : trim((string)$entry);
        $name = is_array($entry) ? trim((string)($entry['name'] ?? '')) : '';
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) $ccHeaders[] = $formatAddress($email, $name);
    }
    if ($ccHeaders) $mime .= 'Cc: ' . implode(', ', $ccHeaders) . "\r\n";
    $encodedSubject = function_exists('mb_encode_mimeheader') ? mb_encode_mimeheader($cleanHeader($subject), 'UTF-8', 'B', "\r\n") : $cleanHeader($subject);
    $mime .= 'Subject: ' . $encodedSubject . "\r\n";
    $mime .= 'MIME-Version: 1.0' . "\r\n";
    $mime .= 'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000' . "\r\n";
    $mime .= 'Auto-Submitted: auto-generated' . "\r\n";

    $inlineImages = [];
    $fileAttachments = [];
    $branding = function_exists('getEmailBranding') ? getEmailBranding() : [];
    $logoPath = trim((string)($branding['logo_path'] ?? ''));
    $logoCid = trim((string)($branding['logo_cid'] ?? ''));
    if ($logoPath !== '' && $logoCid !== '' && stripos((string)$htmlBody, 'cid:' . $logoCid) !== false && is_file($logoPath) && is_readable($logoPath)) {
        $logoContent = file_get_contents($logoPath);
        if ($logoContent !== false) $inlineImages[] = ['content' => $logoContent, 'name' => basename($logoPath), 'mime' => function_exists('mime_content_type') ? (string)(mime_content_type($logoPath) ?: 'image/png') : 'image/png', 'cid' => $logoCid];
    }
    foreach ((array)$attachments as $attachment) {
        $content = '';
        $name = 'attachment';
        $contentType = 'application/octet-stream';
        if (is_string($attachment)) {
            $path = trim($attachment);
            if ($path === '' || !is_file($path) || !is_readable($path)) continue;
            $content = (string)file_get_contents($path);
            $name = basename($path);
            if (function_exists('mime_content_type')) $contentType = (string)(mime_content_type($path) ?: $contentType);
        } elseif (is_array($attachment)) {
            $content = (string)($attachment['content'] ?? '');
            $name = trim((string)($attachment['name'] ?? 'attachment'));
            $contentType = trim((string)($attachment['mime'] ?? $contentType));
            if ($content === '' && !empty($attachment['path'])) {
                $path = trim((string)$attachment['path']);
                if (!is_file($path) || !is_readable($path)) continue;
                $content = (string)file_get_contents($path);
                if ($name === 'attachment') $name = basename($path);
                if ($contentType === 'application/octet-stream' && function_exists('mime_content_type')) $contentType = (string)(mime_content_type($path) ?: $contentType);
            }
        } else continue;
        if ($content !== '') $fileAttachments[] = ['content' => $content, 'name' => $name, 'mime' => $contentType, 'cid' => ''];
    }

    $alternativeMime = 'Content-Type: multipart/alternative; boundary="' . $boundaryAlt . '"' . "\r\n\r\n";
    $alternativeMime .= '--' . $boundaryAlt . "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($plainText)) . "\r\n";
    $alternativeMime .= '--' . $boundaryAlt . "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode((string)$htmlBody)) . "\r\n";
    $alternativeMime .= '--' . $boundaryAlt . "--\r\n";

    $bodyMime = $alternativeMime;
    if ($inlineImages) {
        // Related MIME is required for clients such as Gmail to resolve cid: images.
        $bodyMime = 'Content-Type: multipart/related; boundary="' . $boundaryRelated . '"' . "\r\n\r\n";
        $bodyMime .= '--' . $boundaryRelated . "\r\n" . $alternativeMime;
        foreach ($inlineImages as $image) {
            $bodyMime .= '--' . $boundaryRelated . "\r\nContent-Type: {$image['mime']}; name=\"" . addcslashes($image['name'], "\\\"") . "\"\r\n";
            $bodyMime .= 'Content-Disposition: inline; filename="' . addcslashes($image['name'], "\\\"") . "\"\r\n";
            $bodyMime .= "Content-Transfer-Encoding: base64\r\nContent-ID: <" . $cleanHeader($image['cid']) . ">\r\n\r\n";
            $bodyMime .= chunk_split(base64_encode($image['content'])) . "\r\n";
        }
        $bodyMime .= '--' . $boundaryRelated . "--\r\n";
    }

    if ($fileAttachments) {
        $mime .= 'Content-Type: multipart/mixed; boundary="' . $boundaryMixed . '"' . "\r\n\r\n";
        $mime .= '--' . $boundaryMixed . "\r\n" . $bodyMime;
    } else {
        $mime .= $bodyMime;
    }
    if ($fileAttachments) {
        foreach ($fileAttachments as $file) {
            $mime .= '--' . $boundaryMixed . "\r\nContent-Type: {$file['mime']}; name=\"" . addcslashes($file['name'], "\\\"") . "\"\r\n";
            $mime .= 'Content-Disposition: attachment; filename="' . addcslashes($file['name'], "\\\"") . "\"\r\n";
            $mime .= "Content-Transfer-Encoding: base64\r\n";
            $mime .= "\r\n" . chunk_split(base64_encode($file['content'])) . "\r\n";
        }
        $mime .= '--' . $boundaryMixed . "--\r\n";
    }
    $rawMessage = rtrim(strtr(base64_encode($mime), '+/', '-_'), '=');
    $requestBody = json_encode(['raw' => $rawMessage]);
    if ($requestBody === false) return false;
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAuthorization: Bearer {$accessToken}\r\n",
            'content' => $requestBody,
            'timeout' => 30,
            'ignore_errors' => true,
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    $response = @file_get_contents('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', false, $context);
    $statusLine = (string)($http_response_header[0] ?? '');
    if ($response === false || preg_match('/\s2\d\d\s/', $statusLine) !== 1) {
        error_log('Gmail API mail send failed: ' . ($statusLine !== '' ? $statusLine : 'HTTPS request failed') . '; response=' . substr((string)$response, 0, 400));
        return false;
    }
    return true;
}

/** Send an email through Resend's HTTPS API, avoiding outbound SMTP ports. */
function sendMailViaResend($apiKey, $toEmail, $toName, $subject, $htmlBody, $altBody, $attachments, $cc) {
    $fromValue = trim((string)(getenv('MAIL_FROM') ?: getenv('RESEND_FROM_EMAIL') ?: getenv('SMTP_FROM_EMAIL') ?: ''));
    $fromName = trim((string)(getenv('MAIL_FROM_NAME') ?: getenv('SMTP_FROM_NAME') ?: 'LLB Accountants'));
    $fromEmail = $fromValue;
    if (preg_match('/^(.+?)\s*<\s*([^<>]+)\s*>$/', $fromValue, $fromMatch)) {
        $fromName = trim(trim($fromMatch[1]), " \"'");
        $fromEmail = trim($fromMatch[2]);
    }
    if ($fromEmail === '' || !filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
        error_log('sendMail Resend failed: set MAIL_FROM to a valid sender verified with Resend.');
        return false;
    }
    if (!function_exists('curl_init')) {
        error_log('sendMail Resend failed: PHP cURL extension is not installed.');
        return false;
    }

    $formatAddress = static function ($email, $name = '') {
        $email = trim((string)$email);
        $name = trim((string)$name);
        return $name !== '' ? $name . ' <' . $email . '>' : $email;
    };
    $resendAttachments = [];
    $appendAttachment = static function ($content, $filename, $contentType = '', $contentId = '') use (&$resendAttachments) {
        $item = [
            'filename' => trim((string)$filename) !== '' ? trim((string)$filename) : 'attachment',
            'content' => base64_encode((string)$content),
        ];
        if (trim((string)$contentType) !== '') $item['content_type'] = trim((string)$contentType);
        if (trim((string)$contentId) !== '') $item['content_id'] = trim((string)$contentId);
        $resendAttachments[] = $item;
    };

    $branding = function_exists('getEmailBranding') ? getEmailBranding() : [];
    $logoPath = trim((string)($branding['logo_path'] ?? ''));
    $logoCid = trim((string)($branding['logo_cid'] ?? ''));
    if ($logoPath !== '' && $logoCid !== '' && stripos((string)$htmlBody, 'cid:' . $logoCid) !== false && is_readable($logoPath)) {
        $logo = file_get_contents($logoPath);
        if ($logo !== false) $appendAttachment($logo, basename($logoPath), function_exists('mime_content_type') ? (string)mime_content_type($logoPath) : 'image/png', $logoCid);
    }

    foreach ((array)$attachments as $attachment) {
        if (is_string($attachment)) {
            $path = trim($attachment);
            if ($path !== '' && is_file($path) && is_readable($path)) {
                $content = file_get_contents($path);
                if ($content !== false) $appendAttachment($content, basename($path), function_exists('mime_content_type') ? (string)mime_content_type($path) : '');
            }
            continue;
        }
        if (!is_array($attachment)) continue;
        $content = array_key_exists('content', $attachment) ? (string)($attachment['content'] ?? '') : '';
        $name = trim((string)($attachment['name'] ?? 'attachment'));
        $mime = trim((string)($attachment['mime'] ?? ''));
        if ($content !== '') {
            $appendAttachment($content, $name, $mime);
        } else {
            $path = trim((string)($attachment['path'] ?? ''));
            if ($path !== '' && is_file($path) && is_readable($path)) {
                $file = file_get_contents($path);
                if ($file !== false) $appendAttachment($file, $name !== '' ? $name : basename($path), $mime !== '' ? $mime : (function_exists('mime_content_type') ? (string)mime_content_type($path) : ''));
            }
        }
    }

    $to = [$formatAddress($toEmail, $toName)];
    $ccList = [];
    foreach ((array)$cc as $entry) {
        $email = is_array($entry) ? trim((string)($entry['email'] ?? '')) : trim((string)$entry);
        $name = is_array($entry) ? trim((string)($entry['name'] ?? '')) : '';
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) $ccList[] = $formatAddress($email, $name);
    }

    $payload = [
        'from' => $formatAddress($fromEmail, $fromName),
        'to' => $to,
        'subject' => (string)$subject,
        'html' => (string)$htmlBody,
    ];
    if ((string)$altBody !== '') $payload['text'] = (string)$altBody;
    if ($ccList) $payload['cc'] = $ccList;
    if ($resendAttachments) $payload['attachments'] = $resendAttachments;
    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        error_log('sendMail Resend failed: could not encode the email payload.');
        return false;
    }

    $curl = curl_init('https://api.resend.com/emails');
    if ($curl === false) {
        error_log('sendMail Resend failed: could not initialize PHP cURL.');
        return false;
    }
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $json,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $apiKey,
            'Content-Type: application/json',
            'Accept: application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    $response = curl_exec($curl);
    $statusCode = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $curlError = curl_error($curl);
    curl_close($curl);

    if ($response === false || $statusCode < 200 || $statusCode >= 300) {
        // Provider response helps diagnose invalid API keys/senders; never log
        // the Authorization header or the API key.
        $requestId = (string)($GLOBALS['LLB_API_REQUEST_ID'] ?? 'unknown');
        error_log('[request:' . $requestId . '] Resend request failed: HTTP ' . $statusCode
            . ($curlError !== '' ? '; cURL=' . $curlError : '')
            . '; response=' . substr((string)$response, 0, 500));
        return false;
    }
    return true;
}

/** Password-reset messages require Resend and never fall back to blocked SMTP. */
function sendPasswordResetEmail($toEmail, $toName, $subject, $htmlBody, $altBody = ''): bool {
    $apiKey = trim((string)(getenv('RESEND_API_KEY') ?: ''));
    if ($apiKey === '') {
        error_log('[request:' . ($GLOBALS['LLB_API_REQUEST_ID'] ?? 'unknown') . '] Forgot-password email unavailable: RESEND_API_KEY is not configured.');
        return false;
    }

    return sendMailViaResend($apiKey, $toEmail, $toName, $subject, $htmlBody, $altBody, [], []);
}

function sendMail($toEmail, $toName, $subject, $htmlBody, $altBody = '', $attachments = [], $cc = []) {
    // Use HTTPS delivery for application mail on Railway when configured.
    $resendApiKey = trim((string)(getenv('RESEND_API_KEY') ?: ''));
    if ($resendApiKey !== '') {
        return sendMailViaResend($resendApiKey, $toEmail, $toName, $subject, $htmlBody, $altBody, $attachments, $cc);
    }

    $gmailApiRefreshToken = trim((string)(getenv('GMAIL_API_REFRESH_TOKEN') ?: ''));
    if ($gmailApiRefreshToken !== '') {
        return sendMailViaGmailApi($toEmail, $toName, $subject, $htmlBody, $altBody, $attachments, $cc);
    }

    $relayUrl = trim((string)(getenv('MAIL_RELAY_URL') ?: ''));
    $relaySecret = trim((string)(getenv('MAIL_RELAY_SECRET') ?: ''));
    if ($relayUrl !== '' && $relaySecret !== '') {
        return sendMailViaHttpsRelay(
            $relayUrl,
            $relaySecret,
            $toEmail,
            $toName,
            $subject,
            $htmlBody,
            $altBody,
            $attachments,
            $cc
        );
    }

    // If PHPMailer isn't installed (vendor/autoload.php missing), fail gracefully.
    if (!class_exists('PHPMailer\\PHPMailer\\PHPMailer')) {
        error_log('sendMail failed: PHPMailer is not installed. Run: composer require phpmailer/phpmailer');
        return false;
    }

    // SMTP configuration from environment
    $smtpHostRaw = trim((string)(getenv('SMTP_HOST') ?: 'smtp.gmail.com'));
    $smtpPortRaw = trim((string)(getenv('SMTP_PORT') ?: '587'));
    $smtpUser = trim((string)(getenv('SMTP_USERNAME') ?: getenv('GMAIL_USERNAME') ?: ''));
    $smtpPassRaw = (string)(getenv('SMTP_PASSWORD') ?: getenv('GMAIL_APP_PASSWORD') ?: '');
    // Google app passwords are often copied with spaces; normalize to contiguous text.
    $smtpPass = preg_replace('/\s+/', '', $smtpPassRaw);
    $fromEmail = trim((string)(getenv('SMTP_FROM_EMAIL') ?: $smtpUser));
    $fromName = trim((string)(getenv('SMTP_FROM_NAME') ?: 'LLB Accountants'));
    $smtpEncryptionRaw = strtolower(trim((string)(getenv('SMTP_ENCRYPTION') ?: 'tls')));
    $smtpDebugRaw = trim((string)(getenv('SMTP_DEBUG') ?: '0'));
    // PHPMailer 7 applies SMTP_TIMEOUT to connection and response waits.
    $smtpTimeoutRaw        = trim((string)(getenv('SMTP_TIMEOUT') ?: '15'));

    $smtpHost = $smtpHostRaw !== '' ? $smtpHostRaw : 'smtp.gmail.com';
    $smtpPort = is_numeric($smtpPortRaw) ? (int)$smtpPortRaw : 587;
    if ($smtpPort <= 0) $smtpPort = 587;

    if ($smtpUser === '' || $smtpPass === '' || $fromEmail === '') {
        error_log('sendMail failed: missing SMTP credentials. Set SMTP_USERNAME, SMTP_PASSWORD, and SMTP_FROM_EMAIL.');
        return false;
    }

    // Enforce allowed sender domains for SMTP credentials.
    if (!isValidGmailAddress($smtpUser)) {
        error_log('sendMail failed: SMTP_USERNAME must be a valid @gmail.com or @phinmaed.com address.');
        return false;
    }
    if (!isValidGmailAddress($fromEmail)) {
        error_log('sendMail failed: SMTP_FROM_EMAIL must be a valid @gmail.com or @phinmaed.com address.');
        return false;
    }

    $smtpDebug = is_numeric($smtpDebugRaw) ? (int)$smtpDebugRaw : 0;
    if ($smtpDebug < 0) $smtpDebug = 0;
    if ($smtpDebug > 4) $smtpDebug = 4;

    $smtpTimeout = is_numeric($smtpTimeoutRaw) ? (int)$smtpTimeoutRaw : 15;
    if ($smtpTimeout < 3)  $smtpTimeout = 3;
    if ($smtpTimeout > 60) $smtpTimeout = 60;

    $smtpSecure = PHPMailer::ENCRYPTION_STARTTLS;
    if ($smtpEncryptionRaw === 'ssl' || $smtpEncryptionRaw === 'smtps') {
        $smtpSecure = PHPMailer::ENCRYPTION_SMTPS;
        if ((int)$smtpPort === 587) $smtpPort = 465;
    } elseif ($smtpEncryptionRaw === 'none' || $smtpEncryptionRaw === 'off' || $smtpEncryptionRaw === 'false') {
        $smtpSecure = '';
    }

    // Release the session lock before the blocking SMTP handshake so other
    // requests from the same browser (e.g. polling) are not stalled.
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }

    try {
        $mail = new PHPMailer(true);

        // SMTP debug: 0 for production, 2+ for troubleshooting
        $mail->SMTPDebug  = $smtpDebug;
        $mail->Debugoutput = function($str, $level) {
            error_log("PHPMailer [{$level}]: {$str}");
        };

        $mail->isSMTP();
        $mail->Host       = $smtpHost;
        $mail->SMTPAuth   = true;
        $mail->Username   = $smtpUser;
        $mail->Password   = $smtpPass;
        $mail->Port       = $smtpPort;
        if ($smtpSecure !== '') {
            $mail->SMTPSecure = $smtpSecure;
        } else {
            $mail->SMTPAutoTLS = false;
        }
        // PHPMailer 7 has no ConnectTimeout property; Timeout controls both
        // the connection attempt and SMTP response reads.
        $mail->Timeout        = $smtpTimeout;
        $mail->SMTPKeepAlive  = false; // Don't keep connection open (single send per request)

        // Resolve CA bundle (cached across calls within the same process).
        $caFile = resolveSmtpCaBundle();

        if ($caFile !== '') {
            $mail->SMTPOptions = [
                'ssl' => [
                    'verify_peer'       => true,
                    'verify_peer_name'  => true,
                    'cafile'            => $caFile,
                ],
            ];
        } else {
            // No CA bundle found — skip peer verification.
            // Safe for a local-only XAMPP dev environment.
            $mail->SMTPOptions = [
                'ssl' => [
                    'verify_peer'      => false,
                    'verify_peer_name' => false,
                    'allow_self_signed'=> true,
                ],
            ];
        }

        $mail->CharSet = 'UTF-8';
        $mail->setFrom($fromEmail, $fromName);
        $mail->addAddress($toEmail, $toName ?: $toEmail);

        // Optional CC recipients
        if (!empty($cc)) {
            foreach ((array)$cc as $ccEntry) {
                if (is_array($ccEntry)) {
                    $ccEmail = trim((string)($ccEntry['email'] ?? ''));
                    $ccName  = trim((string)($ccEntry['name']  ?? ''));
                } else {
                    $ccEmail = trim((string)$ccEntry);
                    $ccName  = '';
                }
                if ($ccEmail !== '' && filter_var($ccEmail, FILTER_VALIDATE_EMAIL)) {
                    $mail->addCC($ccEmail, $ccName ?: $ccEmail);
                }
            }
        }
        $mail->Priority = 1;
        $mail->addCustomHeader('Importance', 'high');
        $mail->addCustomHeader('X-MSMail-Priority', 'High');
        $mail->addCustomHeader('Auto-Submitted', 'auto-generated');

        $mail->isHTML(true);
        $mail->Subject = $subject;
        $mail->Body    = $htmlBody;
        // Avoid running strip_tags() on a large HTML body — use the caller's altBody
        // when provided, otherwise derive a short plaintext version without parsing the full HTML.
        if ($altBody !== '') {
            $mail->AltBody = $altBody;
        } else {
            // Extract just the subject line as the plaintext body; good enough for email clients.
            $mail->AltBody = strip_tags((string)preg_replace('/<style\b[^>]*>.*?<\/style>/is', '', $htmlBody));
        }

        $branding = function_exists('getEmailBranding') ? getEmailBranding() : [];
        $logoPath = trim((string)($branding['logo_path'] ?? ''));
        $logoCid = trim((string)($branding['logo_cid'] ?? 'brand-logo'));
        if (
            $logoPath !== ''
            && $logoCid !== ''
            && is_file($logoPath)
            && stripos($htmlBody, 'cid:' . $logoCid) !== false
        ) {
            $logoMime = function_exists('mime_content_type') ? (string)(mime_content_type($logoPath) ?: '') : '';
            if ($logoMime === '') {
                $logoMime = 'image/png';
            }
            $mail->addEmbeddedImage(
                $logoPath,
                $logoCid,
                basename($logoPath),
                PHPMailer::ENCODING_BASE64,
                $logoMime
            );
        }

        if (is_array($attachments)) {
            foreach ($attachments as $attachment) {
                if (is_string($attachment)) {
                    $path = trim($attachment);
                    if ($path !== '' && is_file($path)) {
                        $mail->addAttachment($path);
                    }
                    continue;
                }

                if (!is_array($attachment)) {
                    continue;
                }

                $content = array_key_exists('content', $attachment) ? (string)($attachment['content'] ?? '') : '';
                $name = trim((string)($attachment['name'] ?? ''));
                $mime = trim((string)($attachment['mime'] ?? ''));
                if ($content !== '') {
                    $mail->addStringAttachment(
                        $content,
                        $name !== '' ? $name : 'attachment',
                        PHPMailer::ENCODING_BASE64,
                        $mime !== '' ? $mime : 'application/octet-stream'
                    );
                    continue;
                }

                $path = trim((string)($attachment['path'] ?? ''));
                if ($path === '' || !is_file($path)) {
                    continue;
                }

                if ($mime !== '') {
                    $mail->addAttachment($path, $name !== '' ? $name : '', PHPMailer::ENCODING_BASE64, $mime);
                } elseif ($name !== '') {
                    $mail->addAttachment($path, $name);
                } else {
                    $mail->addAttachment($path);
                }
            }
        }

        $result = $mail->send();
        if (!$result) {
            error_log('sendMail: send() returned false. ErrorInfo: ' . $mail->ErrorInfo);
        }
        return $result;
    } catch (Exception $e) {
        error_log('sendMail failed: ' . $mail->ErrorInfo . ' | Exception: ' . $e->getMessage());
        return false;
    } catch (\Exception $e) {
        error_log('sendMail failed (general): ' . $e->getMessage());
        return false;
    }
}

/**
 * Build a premium payslip release email for employees.
 * Dark navy/gold aesthetic with payslip summary card.
 *
 * @param string $employeeName Employee's first name or full name
 * @param string $payPeriodStart Start date of pay period (Y-m-d format)
 * @param string $payPeriodEnd End date of pay period (Y-m-d format)
 * @param float $grossPay Gross pay amount
 * @param float $deductions Total deductions amount
 * @param float $netPay Net pay amount
 * @param string $baseUrl Frontend base URL for links
 * @return string Complete HTML email with wrapper
 */
function buildPayslipReleaseEmail($employeeName, $payPeriodStart, $payPeriodEnd, $grossPay, $deductions, $netPay, $baseUrl) {
    // Extract first name from full name if needed
    $firstName = $employeeName;
    if (strpos($employeeName, ' ') !== false) {
        $nameParts = explode(' ', trim($employeeName));
        $firstName = $nameParts[0];
    }

    // Format dates
    $formattedPeriodStart = date('F j, Y', strtotime($payPeriodStart));
    $formattedPeriodEnd = date('F j, Y', strtotime($payPeriodEnd));
    $payPeriodRange = $formattedPeriodStart . ' - ' . $formattedPeriodEnd;
    $payPeriodShort = date('F j', strtotime($payPeriodStart)) . ' - ' . date('F j, Y', strtotime($payPeriodEnd));

    // Format money values
    $formattedGrossPay = '₱' . number_format($grossPay, 2);
    $formattedDeductions = '₱' . number_format($deductions, 2);
    $formattedNetPay = '₱' . number_format($netPay, 2);

    // Build the premium inner HTML content
    $innerHtml = '
    <!-- Hero Banner Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a1628;">
        <tr>
            <td style="padding:40px 24px;text-align:center;">
                <!-- Brand Name -->
                <p style="margin:0 0 16px 0;font-size:11px;font-weight:600;letter-spacing:3px;color:#c9a84c;text-transform:uppercase;">LLB ACCOUNTANTS</p>
                
                <!-- Main Heading -->
                <h1 style="margin:0 0 20px 0;font-family:Georgia, \'Times New Roman\', serif;font-size:28px;font-weight:700;line-height:1.3;color:#c9a84c;">YOUR PAYSLIP HAS BEEN RELEASED</h1>
                
                <!-- Gold Divider Line -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="width:60px;">
                    <tr>
                        <td style="height:1px;background:#c9a84c;"></td>
                    </tr>
                </table>
                
                <!-- Pay Period -->
                <p style="margin:20px 0 0 0;font-size:14px;color:#8896ab;">' . htmlspecialchars($payPeriodShort, ENT_QUOTES, 'UTF-8') . '</p>
            </td>
        </tr>
    </table>
    
    <!-- Content Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
        <tr>
            <td style="padding:32px 24px;">
                <!-- Greeting -->
                <p style="margin:0 0 16px 0;font-size:18px;font-weight:600;color:#1a202c;">Dear ' . htmlspecialchars($firstName, ENT_QUOTES, 'UTF-8') . ',</p>
                
                <!-- Intro Paragraph -->
                <p style="margin:0 0 28px 0;font-size:15px;line-height:1.7;color:#4a5568;">We are pleased to inform you that your compensation for the period below has been processed and is now available for your review.</p>
                
                <!-- Payslip Summary Card -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
                    <tr>
                        <td style="padding:24px;">
                            <!-- Pay Period Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:14px;color:#64748b;">Pay Period</td>
                                    <td style="padding:8px 0;font-size:14px;font-weight:500;color:#1a202c;text-align:right;">' . htmlspecialchars($payPeriodRange, ENT_QUOTES, 'UTF-8') . '</td>
                                </tr>
                            </table>
                            
                            <!-- Gross Pay Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:14px;color:#64748b;">Gross Pay</td>
                                    <td style="padding:8px 0;font-size:14px;font-weight:600;color:#1a202c;text-align:right;">' . $formattedGrossPay . '</td>
                                </tr>
                            </table>
                            
                            <!-- Thin Divider -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0;">
                                <tr>
                                    <td style="height:1px;background:#e2e8f0;"></td>
                                </tr>
                            </table>
                            
                            <!-- Deductions Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:14px;color:#64748b;">Deductions</td>
                                    <td style="padding:8px 0;font-size:14px;font-weight:500;color:#dc2626;text-align:right;">' . $formattedDeductions . '</td>
                                </tr>
                            </table>
                            
                            <!-- Thick Gold Divider -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">
                                <tr>
                                    <td style="height:2px;background:#c9a84c;"></td>
                                </tr>
                            </table>
                            
                            <!-- Net Pay Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:16px;font-weight:700;color:#1a202c;">NET PAY</td>
                                    <td style="padding:8px 0;font-size:22px;font-weight:700;color:#c9a84c;text-align:right;">' . $formattedNetPay . '</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
                
                <!-- CTA Button -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto 0 auto;">
                    <tr>
                        <td>
                            <a href="' . htmlspecialchars(rtrim($baseUrl, '/') . '/my-payslips', ENT_QUOTES, 'UTF-8') . '" style="display:inline-block;background:#c9a84c;color:#0a1628;font-size:15px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:8px;">View Your Payslip</a>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
    <!-- Footer Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;">
        <tr>
            <td style="padding:24px;text-align:center;">
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#64748b;">This payslip is confidential and intended solely for the named recipient.</p>
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#64748b;">If you have questions, please contact your HR department.</p>
                <p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">© ' . date('Y') . ' LLB Accountants. All rights reserved.</p>
            </td>
        </tr>
    </table>';

    // Create preheader text
    $preheader = 'Your payslip for ' . $payPeriodShort . ' is now available';

    // Wrap with branded layout
    return buildBrandedEmailLayout($innerHtml, $preheader);
}

/**
 * Build a premium payslip release notification email for admins/managers.
 * Dark navy/gold aesthetic, simplified content (no financial details).
 *
 * @param string $employeeName Employee's full name
 * @param string $payPeriodStart Start date of pay period (Y-m-d format)
 * @param string $payPeriodEnd End date of pay period (Y-m-d format)
 * @param string $baseUrl Frontend base URL for links
 * @return string Complete HTML email with wrapper
 */
function buildPayslipReleaseAdminEmail($employeeName, $payPeriodStart, $payPeriodEnd, $baseUrl) {
    // Format dates
    $formattedPeriodStart = date('F j, Y', strtotime($payPeriodStart));
    $formattedPeriodEnd = date('F j, Y', strtotime($payPeriodEnd));
    $payPeriodRange = $formattedPeriodStart . ' - ' . $formattedPeriodEnd;

    // Build the premium inner HTML content
    $innerHtml = '
    <!-- Hero Banner Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a1628;">
        <tr>
            <td style="padding:40px 24px;text-align:center;">
                <!-- Brand Name -->
                <p style="margin:0 0 16px 0;font-size:11px;font-weight:600;letter-spacing:3px;color:#c9a84c;text-transform:uppercase;">LLB ACCOUNTANTS</p>
                
                <!-- Main Heading -->
                <h1 style="margin:0 0 20px 0;font-family:Georgia, \'Times New Roman\', serif;font-size:26px;font-weight:700;line-height:1.3;color:#c9a84c;">PAYSLIP RELEASE NOTIFICATION</h1>
                
                <!-- Gold Divider Line -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="width:60px;">
                    <tr>
                        <td style="height:1px;background:#c9a84c;"></td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
    <!-- Content Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
        <tr>
            <td style="padding:32px 24px;">
                <!-- Intro Paragraph -->
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#4a5568;">A payslip has been released for the following employee:</p>
                
                <!-- Employee Info Card -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
                    <tr>
                        <td style="padding:24px;">
                            <!-- Employee Name Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:14px;color:#64748b;">Employee Name</td>
                                    <td style="padding:8px 0;font-size:14px;font-weight:600;color:#1a202c;text-align:right;">' . htmlspecialchars($employeeName, ENT_QUOTES, 'UTF-8') . '</td>
                                </tr>
                            </table>
                            
                            <!-- Thin Divider -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0;">
                                <tr>
                                    <td style="height:1px;background:#e2e8f0;"></td>
                                </tr>
                            </table>
                            
                            <!-- Pay Period Row -->
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                                <tr>
                                    <td style="padding:8px 0;font-size:14px;color:#64748b;">Pay Period</td>
                                    <td style="padding:8px 0;font-size:14px;font-weight:500;color:#1a202c;text-align:right;">' . htmlspecialchars($payPeriodRange, ENT_QUOTES, 'UTF-8') . '</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
                
                <!-- CTA Button -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto 0 auto;">
                    <tr>
                        <td>
                            <a href="' . htmlspecialchars(rtrim($baseUrl, '/') . '/payroll-management', ENT_QUOTES, 'UTF-8') . '" style="display:inline-block;background:#c9a84c;color:#0a1628;font-size:15px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:8px;">View Payroll Management</a>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
    <!-- Footer Section -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;">
        <tr>
            <td style="padding:24px;text-align:center;">
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#64748b;">This notification is confidential and intended for authorized personnel only.</p>
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#64748b;">If you have questions, please contact the payroll department.</p>
                <p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">© ' . date('Y') . ' LLB Accountants. All rights reserved.</p>
            </td>
        </tr>
    </table>';

    // Create preheader text
    $preheader = 'Payslip release notification for ' . $employeeName;

    // Wrap with branded layout
    return buildBrandedEmailLayout($innerHtml, $preheader);
}

/**
 * Build and send an onboarding welcome email to a newly created user account.
 *
 * Sends the user their login email and temporary password with a direct link
 * to the login page. Branded using buildBrandedEmailLayout().
 *
 * @param string $email           The user's login email address.
 * @param string $fullName        Full name of the new user.
 * @param string $temporaryPassword The plain-text temporary password.
 * @param string $role            Role assigned to the user (staff, manager, etc.)
 * @param string $loginUrl        Full URL to the login page.
 * @return bool True if the email was sent successfully, false otherwise.
 */
function sendUserOnboardingEmail($email, $fullName, $temporaryPassword, $role = 'staff', $loginUrl = '') {
    if (!function_exists('sendMail')) {
        error_log('sendUserOnboardingEmail: sendMail unavailable.');
        return false;
    }

    $displayName = trim((string)$fullName) !== '' ? trim((string)$fullName) : trim((string)$email);
    $safeName     = htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8');
    $safePassword = htmlspecialchars((string)$temporaryPassword, ENT_QUOTES, 'UTF-8');
    $safeRole     = htmlspecialchars(ucfirst(strtolower(trim((string)($role ?: 'staff')))), ENT_QUOTES, 'UTF-8');
    $safeEmail    = htmlspecialchars((string)$email, ENT_QUOTES, 'UTF-8');

    if ($loginUrl === '') {
        $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
        if ($frontendBase !== '') {
            $loginUrl = rtrim($frontendBase, '/') . '/';
        } else {
            $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
            $scheme   = $isHttps ? 'https' : 'http';
            $host     = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
            $loginUrl = $scheme . '://' . $host . '/';
        }
    }
    $safeLink = htmlspecialchars($loginUrl, ENT_QUOTES, 'UTF-8');

    $content = ''
        . '<h2 style="margin:0 0 14px 0;font-size:18px;line-height:1.4;color:#0f172a;">Welcome — Your Account is Ready</h2>'
        . '<p style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#334155;">Hello <strong>' . $safeName . '</strong>,</p>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#334155;">'
        . 'An account has been created for you on the LLB Accountants portal. Use the credentials below to sign in.'
        . '</p>'

        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">'
        . '<tr><td style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">'
        . '<span style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">Role</span>'
        . '</td>'
        . '<td style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#0f172a;">' . $safeRole . '</td></tr>'
        . '<tr><td style="padding:10px 16px;">'
        . '<span style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">Login Email</span>'
        . '</td>'
        . '<td style="padding:10px 16px;text-align:right;font-family:Consolas,Monaco,monospace;font-size:13px;font-weight:600;color:#0f172a;word-break:break-all;">' . $safeEmail . '</td></tr>'
        . '</table>'

        . '<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:#b45309;">Temporary Password:</p>'
        . '<div style="margin:0 0 8px 0;padding:16px;background:#111827;border-radius:10px;color:#f9fafb;font-family:Consolas,Monaco,monospace;font-size:22px;font-weight:700;letter-spacing:0.12em;text-align:center;">'
        . $safePassword
        . '</div>'
        . '<p style="margin:0 0 20px 0;font-size:12px;color:#92400e;">You will be required to change this password the first time you sign in.</p>'

        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px auto;">'
        . '<tr><td>'
        . '<a href="' . $safeLink . '" style="display:inline-block;padding:13px 32px;border-radius:999px;background:#1e3a8a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;">Sign In Now</a>'
        . '</td></tr></table>'

        . '<p style="margin:0;font-size:12px;line-height:1.7;color:#64748b;">'
        . 'If you did not expect this email, please contact your HR administrator immediately.'
        . '</p>';

    $html = buildBrandedEmailLayout($content, 'Your LLB Accountants account is ready. Sign in with your temporary password.');

    $alt = "Hello {$displayName},\n\n"
        . "An account has been created for you on the LLB Accountants portal.\n\n"
        . "Role: {$role}\n"
        . "Login Email: {$email}\n"
        . "Temporary Password: {$temporaryPassword}\n\n"
        . "Sign in at: {$loginUrl}\n\n"
        . "You will be required to change this password on first sign-in.\n\n"
        . "If you did not expect this email, contact your HR administrator.";

    return sendMail($email, $displayName, 'Your LLB Accountants account has been created', $html, $alt);
}

/**
 * Build and send a "your new password" email after a verified password reset.
 *
 * Only call this from reset flows that already proved inbox access
 * (verified email-code session or single-use reset token) — the caller
 * passes the plaintext password it just stored.
 *
 * @param string $email        Account email address (must be a valid Gmail-domain address).
 * @param string $displayName  Full name (or username) for the greeting.
 * @param string $newPassword  The plain-text password that was just set.
 * @return bool True if the email was sent successfully, false otherwise.
 */
function sendGeneratedPasswordEmail($email, $displayName, $newPassword) {
    if (!function_exists('sendMail')) {
        error_log('sendGeneratedPasswordEmail: sendMail unavailable.');
        return false;
    }

    $email = trim((string)$email);
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        error_log('sendGeneratedPasswordEmail: invalid recipient email.');
        return false;
    }
    if (!isValidGmailAddress($email)) {
        error_log('sendGeneratedPasswordEmail: recipient is not a Gmail-domain address.');
        return false;
    }

    $name = trim((string)$displayName) !== '' ? trim((string)$displayName) : $email;
    $safeName = htmlspecialchars($name, ENT_QUOTES, 'UTF-8');
    $safePassword = htmlspecialchars((string)$newPassword, ENT_QUOTES, 'UTF-8');

    $content = ''
        . '<h2 style="margin:0 0 14px 0;font-size:18px;line-height:1.4;color:#0f172a;">Your New Password</h2>'
        . '<p style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#334155;">Hello <strong>' . $safeName . '</strong>,</p>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#334155;">'
        . 'Your account password was just changed using a suggested strong password. Since it is hard to remember, '
        . 'here is a copy for your records:'
        . '</p>'

        . '<div style="margin:0 0 8px 0;padding:16px;background:#111827;border-radius:10px;color:#f9fafb;font-family:Consolas,Monaco,monospace;font-size:20px;font-weight:700;letter-spacing:0.1em;text-align:center;word-break:break-all;">'
        . $safePassword
        . '</div>'
        . '<p style="margin:0 0 20px 0;font-size:12px;color:#64748b;">Store it somewhere safe and do not share it with anyone.</p>'

        . '<p style="margin:0;font-size:12px;line-height:1.7;color:#dc2626;">'
        . 'If you did not change your password, secure your account immediately and contact your administrator.'
        . '</p>';

    $html = buildBrandedEmailLayout($content, 'A copy of your new LLB Accountants password.');

    $alt = "Hello {$name},\n\n"
        . "Your account password was just changed using a suggested strong password.\n\n"
        . "Your new password: {$newPassword}\n\n"
        . "Store it somewhere safe and do not share it with anyone.\n\n"
        . "If you did not change your password, secure your account immediately.";

    return sendMail($email, $name, 'Your new LLB Accountants password', $html, $alt);
}

?>
