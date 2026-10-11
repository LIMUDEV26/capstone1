<?php
/**
 * Privacy Policy API
 *
 * Public:
 *   GET  ?action=public_get
 *
 * Admin-only:
 *   GET  ?action=admin_get
 *   PUT  ?action=save_draft         body: { html: string }
 *   POST ?action=publish            body: { html?: string }
 *   POST ?action=upload_import      multipart/form-data with field: policy_file
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

$action = trim((string)($_GET['action'] ?? ''));

if ($method === 'GET' && $action === 'public_get') {
    handlePublicGet($conn);
}

requireAuth();
requireRole(['admin']);

switch ($method) {
    case 'GET':
        if ($action === 'admin_get') {
            handleAdminGet($conn);
        }
        sendError('Invalid action', 400);
        break;
    case 'PUT':
        if ($action === 'save_draft') {
            handleSaveDraft($conn);
        }
        sendError('Invalid action', 400);
        break;
    case 'POST':
        if ($action === 'publish') {
            handlePublish($conn);
        }
        if ($action === 'upload_import') {
            handleUploadImport($conn);
        }
        sendError('Invalid action', 400);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getDefaultPolicyHtml() {
    return '<h1>Privacy Policy</h1>'
        . '<p>Last updated: March 05, 2026</p>'
        . '<p>This Privacy Policy describes Our policies and procedures on the collection, use and disclosure of Your information when You use the Service and tells You about Your privacy rights and how the law protects You.</p>'
        . '<p>We use Your Personal Data to provide and improve the Service. By using the Service, You agree to the collection and use of information in accordance with this Privacy Policy.</p>'
        . '<h2>Contact Us</h2>'
        . '<p>If you have any questions about this Privacy Policy, You can contact us at llbandcocpas@gmail.com.</p>';
}

function sanitizePolicyHtml($html) {
    $value = trim((string)$html);
    $value = str_replace(["\r\n", "\r"], "\n", $value);

    // Basic script tag stripping for safety; admin content is otherwise trusted.
    $value = preg_replace('/<script\b[^>]*>(.*?)<\/script>/is', '', $value);

    return $value;
}

function clampWatermarkCountValue($value) {
    return max(1, min(6, (int)$value));
}

function normalizeWatermarkEnabled($value) {
    if (is_bool($value)) return $value;
    $stringVal = strtolower(trim((string)$value));
    return in_array($stringVal, ['1', 'true', 'yes', 'on'], true);
}

function getSettingsMap($conn, $keys) {
    if (!is_array($keys) || count($keys) === 0) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $sql = "SELECT setting_key, setting_value, setting_type FROM settings WHERE setting_key IN ($placeholders)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare settings query', 500);
    }

    $stmt->bind_param($types, ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();

    $settings = [];
    while ($row = $result->fetch_assoc()) {
        $value = $row['setting_value'];
        if ($row['setting_type'] === 'number') {
            $value = is_numeric($value) ? (int)$value : $value;
        } elseif ($row['setting_type'] === 'boolean') {
            $value = ($value === '1' || $value === 'true');
        }

        $settings[$row['setting_key']] = $value;
    }

    $stmt->close();
    return $settings;
}

function upsertSetting($conn, $key, $value, $type = 'string') {
    $stmt = $conn->prepare(
        "INSERT INTO settings (setting_key, setting_value, setting_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_type = VALUES(setting_type), updated_at = NOW()"
    );
    if (!$stmt) {
        sendError('Failed to prepare settings update', 500);
    }

    $k = (string)$key;
    $v = (string)$value;
    $t = (string)$type;
    $stmt->bind_param('sss', $k, $v, $t);
    $ok = $stmt->execute();
    $stmt->close();

    if (!$ok) {
        sendError('Failed to save settings value: ' . $key, 500);
    }
}

function renderTextAsHtmlParagraphs($text) {
    $normalized = str_replace(["\r\n", "\r"], "\n", (string)$text);
    $normalized = trim($normalized);
    if ($normalized === '') return '';

    $blocks = preg_split('/\n{2,}/', $normalized);
    $parts = [];

    foreach ($blocks as $block) {
        $lines = preg_split('/\n+/', (string)$block);
        $lines = array_values(array_filter(array_map('trim', $lines), function ($line) {
            return $line !== '';
        }));

        if (count($lines) === 0) {
            continue;
        }

        $escapedLines = array_map(function ($line) {
            return htmlspecialchars($line, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        }, $lines);

        $parts[] = '<p>' . implode('<br>', $escapedLines) . '</p>';
    }

    return implode("\n", $parts);
}

function decodePdfLiteralString($literal) {
    $value = (string)$literal;
    if (strlen($value) >= 2 && $value[0] === '(' && substr($value, -1) === ')') {
        $value = substr($value, 1, -1);
    }

    $value = preg_replace_callback('/\\\\([0-7]{1,3})/', function ($match) {
        return chr(octdec($match[1]));
    }, $value);

    $map = [
        'n' => "\n",
        'r' => "\r",
        't' => "\t",
        'b' => "\x08",
        'f' => "\x0c",
        '(' => '(',
        ')' => ')',
        '\\' => '\\',
    ];

    $value = preg_replace_callback('/\\\\([nrtbf()\\\\])/', function ($match) use ($map) {
        $token = $match[1];
        return $map[$token] ?? $token;
    }, $value);

    $value = preg_replace('/\\\\\r?\n/', '', $value);
    return $value;
}

function extractPdfTextFromContentStream($stream) {
    $text = '';

    if (preg_match_all('/\((?:\\\\.|[^\\\\)])*\)\s*Tj/s', $stream, $matches)) {
        foreach ($matches[0] as $tokenWithOperator) {
            $token = preg_replace('/\s*Tj\s*$/', '', $tokenWithOperator);
            $text .= decodePdfLiteralString($token) . "\n";
        }
    }

    if (preg_match_all('/\[(.*?)\]\s*TJ/s', $stream, $arrayMatches)) {
        foreach ($arrayMatches[1] as $arrayContent) {
            if (preg_match_all('/\((?:\\\\.|[^\\\\)])*\)/s', $arrayContent, $items)) {
                foreach ($items[0] as $token) {
                    $text .= decodePdfLiteralString($token);
                }
                $text .= "\n";
            }
        }
    }

    return $text;
}

function extractTextFromPdf($path) {
    $raw = @file_get_contents($path);
    if ($raw === false || $raw === '') {
        return '';
    }

    $combinedText = '';

    if (preg_match_all('/stream\r?\n(.*?)\r?\nendstream/s', $raw, $streamMatches)) {
        foreach ($streamMatches[1] as $stream) {
            $candidates = [];
            $streamValue = (string)$stream;
            $candidates[] = $streamValue;

            $uncompressed = @gzuncompress($streamValue);
            if ($uncompressed !== false) {
                $candidates[] = $uncompressed;
            }

            $decoded = @gzdecode($streamValue);
            if ($decoded !== false) {
                $candidates[] = $decoded;
            }

            foreach ($candidates as $candidate) {
                $combinedText .= extractPdfTextFromContentStream((string)$candidate);
            }
        }
    }

    $combinedText = trim((string)$combinedText);
    if ($combinedText !== '') {
        return $combinedText;
    }

    // Fallback: strip non-printable bytes and return rough text.
    $fallback = preg_replace('/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/', ' ', $raw);
    $fallback = preg_replace('/\s{2,}/', ' ', (string)$fallback);
    return trim((string)$fallback);
}

function extractTextFromDocx($path) {
    if (!class_exists('ZipArchive')) {
        return '';
    }

    $zip = new ZipArchive();
    if ($zip->open($path) !== true) {
        return '';
    }

    $xml = $zip->getFromName('word/document.xml');
    $zip->close();

    if ($xml === false || $xml === '') {
        return '';
    }

    $xml = preg_replace('/<w:tab[^>]*\/>/i', "\t", $xml);
    $xml = preg_replace('/<w:br[^>]*\/>/i', "\n", $xml);
    $xml = preg_replace('/<\/w:p>/i', "\n\n", $xml);

    $text = strip_tags($xml);
    $text = html_entity_decode((string)$text, ENT_QUOTES | ENT_XML1, 'UTF-8');
    return trim((string)$text);
}

function extractTextFromFile($path, $extension) {
    $ext = strtolower(trim((string)$extension));

    if ($ext === 'txt') {
        $raw = @file_get_contents($path);
        return $raw === false ? '' : trim((string)$raw);
    }

    if ($ext === 'docx') {
        return extractTextFromDocx($path);
    }

    if ($ext === 'pdf') {
        return extractTextFromPdf($path);
    }

    return '';
}

function handlePublicGet($conn) {
    $keys = [
        'privacy_policy_published_html',
        'privacy_policy_published_at',
        'privacy_policy_watermark_enabled',
        'privacy_policy_watermark_count',
    ];

    $settings = getSettingsMap($conn, $keys);

    $published = trim((string)($settings['privacy_policy_published_html'] ?? ''));
    if ($published === '') {
        $published = getDefaultPolicyHtml();
    }

    $watermarkEnabled = normalizeWatermarkEnabled($settings['privacy_policy_watermark_enabled'] ?? true);
    $watermarkCount = clampWatermarkCountValue($settings['privacy_policy_watermark_count'] ?? 3);

    sendResponse(true, [
        'published_html' => $published,
        'published_at' => (string)($settings['privacy_policy_published_at'] ?? ''),
        'watermark_enabled' => $watermarkEnabled,
        'watermark_count' => $watermarkCount,
    ], 'Privacy policy retrieved');
}

function handleAdminGet($conn) {
    $keys = [
        'privacy_policy_draft_html',
        'privacy_policy_published_html',
        'privacy_policy_published_at',
        'privacy_policy_source_filename',
        'privacy_policy_source_filetype',
        'privacy_policy_source_uploaded_at',
        'privacy_policy_source_path',
        'privacy_policy_enabled',
        'privacy_policy_watermark_enabled',
        'privacy_policy_watermark_count',
    ];

    $settings = getSettingsMap($conn, $keys);

    $published = trim((string)($settings['privacy_policy_published_html'] ?? ''));
    if ($published === '') {
        $published = getDefaultPolicyHtml();
    }

    $draft = trim((string)($settings['privacy_policy_draft_html'] ?? ''));
    if ($draft === '') {
        $draft = $published;
    }

    sendResponse(true, [
        'draft_html' => $draft,
        'published_html' => $published,
        'published_at' => (string)($settings['privacy_policy_published_at'] ?? ''),
        'source_filename' => (string)($settings['privacy_policy_source_filename'] ?? ''),
        'source_filetype' => (string)($settings['privacy_policy_source_filetype'] ?? ''),
        'source_uploaded_at' => (string)($settings['privacy_policy_source_uploaded_at'] ?? ''),
        'source_path' => (string)($settings['privacy_policy_source_path'] ?? ''),
        'privacy_policy_enabled' => normalizeWatermarkEnabled($settings['privacy_policy_enabled'] ?? true),
        'watermark_enabled' => normalizeWatermarkEnabled($settings['privacy_policy_watermark_enabled'] ?? true),
        'watermark_count' => clampWatermarkCountValue($settings['privacy_policy_watermark_count'] ?? 3),
    ], 'Privacy policy editor data retrieved');
}

function handleSaveDraft($conn) {
    $data = getJSONInput();
    $draftHtml = sanitizePolicyHtml($data['html'] ?? '');

    if ($draftHtml === '' || trim(strip_tags($draftHtml)) === '') {
        sendError('Draft content cannot be empty.', 400);
    }

    if (strlen($draftHtml) > 60000) {
        sendError('Draft content is too large. Keep it under 60,000 characters.', 400);
    }

    upsertSetting($conn, 'privacy_policy_draft_html', $draftHtml, 'string');
    upsertSetting($conn, 'privacy_policy_draft_updated_at', date('Y-m-d H:i:s'), 'string');

    sendResponse(true, [
        'draft_html' => $draftHtml,
    ], 'Draft saved successfully');
}

function handlePublish($conn) {
    $data = getJSONInput();
    $incomingHtml = isset($data['html']) ? sanitizePolicyHtml($data['html']) : '';

    if ($incomingHtml === '') {
        $settings = getSettingsMap($conn, ['privacy_policy_draft_html', 'privacy_policy_published_html']);
        $incomingHtml = sanitizePolicyHtml($settings['privacy_policy_draft_html'] ?? '');
        if ($incomingHtml === '') {
            $incomingHtml = sanitizePolicyHtml($settings['privacy_policy_published_html'] ?? '');
        }
    }

    if ($incomingHtml === '' || trim(strip_tags($incomingHtml)) === '') {
        sendError('No policy content available to publish.', 400);
    }

    if (strlen($incomingHtml) > 60000) {
        sendError('Published content is too large. Keep it under 60,000 characters.', 400);
    }

    $publishedAt = date('Y-m-d H:i:s');

    upsertSetting($conn, 'privacy_policy_draft_html', $incomingHtml, 'string');
    upsertSetting($conn, 'privacy_policy_published_html', $incomingHtml, 'string');
    upsertSetting($conn, 'privacy_policy_published_at', $publishedAt, 'string');

    if (function_exists('logActivity')) {
        $userId = intval($_SESSION['user_id'] ?? 0);
        if ($userId > 0) {
            logActivity($conn, $userId, 'publish_privacy_policy', 'Published privacy policy content', 'settings');
        }
    }

    sendResponse(true, [
        'published_html' => $incomingHtml,
        'published_at' => $publishedAt,
    ], 'Privacy policy published');
}

function handleUploadImport($conn) {
    if (!isset($_FILES['policy_file'])) {
        sendError('Missing uploaded file (policy_file).', 400);
    }

    $file = $_FILES['policy_file'];

    if (!is_array($file) || !isset($file['error'])) {
        sendError('Invalid upload payload.', 400);
    }

    if ((int)$file['error'] !== UPLOAD_ERR_OK) {
        sendError('Upload failed with error code ' . (int)$file['error'], 400);
    }

    $tmpPath = (string)($file['tmp_name'] ?? '');
    if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
        sendError('Uploaded file is not valid.', 400);
    }

    $size = intval($file['size'] ?? 0);
    if ($size <= 0) {
        sendError('Uploaded file is empty.', 400);
    }
    if ($size > (10 * 1024 * 1024)) {
        sendError('File is too large (max 10MB).', 400);
    }

    $originalName = trim((string)($file['name'] ?? 'policy'));
    if ($originalName === '') $originalName = 'policy';

    $baseName = basename($originalName);
    $ext = strtolower((string)pathinfo($baseName, PATHINFO_EXTENSION));
    $allowed = ['pdf', 'txt', 'docx'];

    if ($ext === '' || !in_array($ext, $allowed, true)) {
        sendError('Unsupported file type. Allowed: pdf, txt, docx.', 400);
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        sendError('Failed to resolve project root.', 500);
    }

    $relativeDir = 'uploads/privacy-policy';
    $targetDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true) && !is_dir($targetDir)) {
        sendError('Failed to create policy upload directory.', 500);
    }

    try {
        $random = bin2hex(random_bytes(4));
    } catch (Throwable $e) {
        $random = (string)mt_rand(1000, 9999);
    }

    $storedName = 'policy_' . date('YmdHis') . '_' . $random . '.' . $ext;
    $targetPath = $targetDir . DIRECTORY_SEPARATOR . $storedName;
    $relativePath = $relativeDir . '/' . $storedName;

    if (!move_uploaded_file($tmpPath, $targetPath)) {
        sendError('Failed to store uploaded file.', 500);
    }

    $plainText = extractTextFromFile($targetPath, $ext);
    $warning = '';

    if (trim($plainText) === '') {
        $warning = 'File was uploaded, but text extraction was limited. Please edit the draft manually before publishing.';
        $plainText = 'Privacy Policy\n\nImported from file: ' . $baseName . '\n\nPlease review and edit this draft before publishing.';
    }

    $htmlDraft = renderTextAsHtmlParagraphs($plainText);
    $htmlDraft = sanitizePolicyHtml($htmlDraft);

    if ($htmlDraft === '' || trim(strip_tags($htmlDraft)) === '') {
        sendError('Could not build a usable draft from uploaded file.', 400);
    }

    if (strlen($htmlDraft) > 60000) {
        sendError('Imported content is too large. Please shorten it before saving.', 400);
    }

    $uploadedAt = date('Y-m-d H:i:s');

    upsertSetting($conn, 'privacy_policy_draft_html', $htmlDraft, 'string');
    upsertSetting($conn, 'privacy_policy_source_filename', $baseName, 'string');
    upsertSetting($conn, 'privacy_policy_source_filetype', $ext, 'string');
    upsertSetting($conn, 'privacy_policy_source_uploaded_at', $uploadedAt, 'string');
    upsertSetting($conn, 'privacy_policy_source_path', $relativePath, 'string');

    sendResponse(true, [
        'draft_html' => $htmlDraft,
        'source_filename' => $baseName,
        'source_filetype' => $ext,
        'source_uploaded_at' => $uploadedAt,
        'source_path' => $relativePath,
        'warning' => $warning,
    ], 'Policy document uploaded and imported into draft');
}

closeDBConnection($conn);
?>
