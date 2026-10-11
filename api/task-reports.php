<?php
/**
 * Task Completion Reports API
 * Sends completion reports for completed tasks to clients and supports resend.
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
$GLOBALS['conn'] = $conn;
ensureTaskCollaboratorsTable($conn);

switch ($method) {
    case 'POST':
        requireAuth();
        handlePost($conn);
        break;
    default:
        sendError('Method not allowed', 405);
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

function ensureTaskCompletionReportsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS task_completion_reports (
                report_id INT AUTO_INCREMENT PRIMARY KEY,
                task_id INT NOT NULL,
                project_id INT NULL,
                client_id INT NULL,
                report_body TEXT NOT NULL,
                sent_by INT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_task_completion_report_task (task_id),
                INDEX idx_task_completion_report_project (project_id),
                INDEX idx_task_completion_report_client (client_id),
                INDEX idx_task_completion_report_sender (sent_by),
                CONSTRAINT fk_task_completion_report_task
                    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                CONSTRAINT fk_task_completion_report_project
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
                CONSTRAINT fk_task_completion_report_client
                    FOREIGN KEY (client_id) REFERENCES client(client_id) ON DELETE SET NULL,
                CONSTRAINT fk_task_completion_report_sender
                    FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize completion reports storage.', 500);
    }
}

function ensureProjectCompletionReportsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS project_completion_reports (
                report_id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT NOT NULL,
                client_id INT NULL,
                report_kind ENUM('major_report', 'certification') NOT NULL,
                report_body TEXT NOT NULL,
                sent_by INT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_project_completion_report_kind (project_id, report_kind),
                INDEX idx_project_completion_report_client (client_id),
                INDEX idx_project_completion_report_sender (sent_by),
                CONSTRAINT fk_project_completion_report_project
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                CONSTRAINT fk_project_completion_report_client
                    FOREIGN KEY (client_id) REFERENCES client(client_id) ON DELETE SET NULL,
                CONSTRAINT fk_project_completion_report_sender
                    FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize project completion reports storage.', 500);
    }
}

function getTaskForCompletionReport($conn, $task_id) {
    $sql = "SELECT t.id, t.title, t.description, t.status, t.assigned_to, t.project_id,
                   p.name AS project_name,
                   p.manager_id,
                   c.client_id, c.client_name, c.contact_person, c.email AS client_email
            FROM tasks t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN client c ON p.client_id = c.client_id
            WHERE t.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to prepare task lookup query.', 500);
    }

    $stmt->bind_param('i', $task_id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function getProjectForCompletionReport($conn, $project_id) {
    $sql = "SELECT p.id,
                   p.name,
                   p.description,
                   p.status,
                   p.manager_id,
                   p.start_date,
                   p.end_date,
                   c.client_id,
                   c.client_name,
                   c.contact_person,
                   c.email AS client_email,
                   COALESCE(task_counts.total_tasks, 0) AS total_tasks,
                   COALESCE(task_counts.completed_tasks, 0) AS completed_tasks
            FROM projects p
            LEFT JOIN client c ON p.client_id = c.client_id
            LEFT JOIN (
                SELECT project_id,
                       COUNT(*) AS total_tasks,
                       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks
                FROM tasks
                GROUP BY project_id
            ) task_counts ON task_counts.project_id = p.id
            WHERE p.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to prepare project lookup query.', 500);
    }

    $stmt->bind_param('i', $project_id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function getUserDisplayNameById($conn, $user_id) {
    $sql = "SELECT CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, '')) AS full_name
            FROM users
            WHERE id = ?
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return 'LLB Accountants Team';
    }

    $stmt->bind_param('i', $user_id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $full_name = trim((string)($row['full_name'] ?? ''));
    return $full_name !== '' ? $full_name : 'LLB Accountants Team';
}

function buildDefaultReportBody($task, $sender_name) {
    $task_title = trim((string)($task['title'] ?? 'Your task'));
    $project_name = trim((string)($task['project_name'] ?? 'your project'));
    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');

    return "Completion Status: SUCCESS\n"
        . "Task: " . $task_title . "\n"
        . "Project: " . $project_name . "\n\n"
        . "The work scope for this task has been completed in accordance with the agreed requirements.\n"
        . "Thank you for your continued trust in " . $brand_name . ".\n\n"
        . "Best regards,\n"
        . $sender_name;
}

function getProjectReportKindLabel($report_kind) {
    return $report_kind === 'certification' ? 'Certification' : 'Final Report';
}

function buildProjectReportReference($project, $report_kind) {
    $project_id = max(0, intval($project['id'] ?? 0));
    $suffix = $report_kind === 'certification' ? 'CERT' : 'FINAL';
    return 'LLB-PRJ-' . str_pad((string)$project_id, 4, '0', STR_PAD_LEFT) . '-' . $suffix;
}

function formatFormalReportDate($timestamp = null) {
    $ts = $timestamp ? intval($timestamp) : time();
    if ($ts <= 0) {
        $ts = time();
    }
    return date('F j, Y', $ts);
}

function taskReportsColumnExists($conn, $table, $column) {
    // Static cache to avoid repeated information_schema queries
    static $cache = [];
    $cacheKey = $table . '.' . $column;
    if (isset($cache[$cacheKey])) {
        return $cache[$cacheKey];
    }

    $dbName = DB_NAME;
    $sql = "SELECT 1
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        $cache[$cacheKey] = false;
        return false;
    }

    $stmt->bind_param('sss', $dbName, $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    $cache[$cacheKey] = $exists;
    return $exists;
}

function getProjectCertificateServices($conn, $project) {
    $client_id = intval($project['client_id'] ?? 0);
    if ($client_id <= 0) {
        return [];
    }

    $hasTemplatePath = taskReportsColumnExists($conn, 'services', 'certificate_template_path');
    $hasTemplateName = taskReportsColumnExists($conn, 'services', 'certificate_template_name');
    $hasTemplateMime = taskReportsColumnExists($conn, 'services', 'certificate_template_mime');

    $templatePathSelect = $hasTemplatePath ? 's.certificate_template_path' : 'NULL AS certificate_template_path';
    $templateNameSelect = $hasTemplateName ? 's.certificate_template_name' : 'NULL AS certificate_template_name';
    $templateMimeSelect = $hasTemplateMime ? 's.certificate_template_mime' : 'NULL AS certificate_template_mime';

    $sql = "SELECT DISTINCT
                   s.service_id,
                   s.service_name,
                   $templatePathSelect,
                   $templateNameSelect,
                   $templateMimeSelect
            FROM client_services cs
            INNER JOIN services s ON s.service_id = cs.service_id
            WHERE cs.client_id = ?
              AND cs.status = 'active'
            ORDER BY LOWER(TRIM(COALESCE(s.service_name, ''))) ASC, s.service_id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to load project services for certification.', 500);
    }

    $stmt->bind_param('i', $client_id);
    $stmt->execute();
    $result = $stmt->get_result();

    $services = [];
    while ($row = $result->fetch_assoc()) {
        $services[] = $row;
    }
    $stmt->close();

    return $services;
}

function resolveTaskReportsAbsolutePath($relativePath) {
    $normalized = ltrim(str_replace('\\', '/', trim((string)$relativePath)), '/');
    if ($normalized === '') {
        return '';
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return '';
    }

    return $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $normalized);
}

function normalizeCertificateLookupKey($value) {
    return strtolower(preg_replace('/[^a-z0-9]+/i', '', trim((string)$value)));
}

function findBundledServiceCertificateTemplate($service_name) {
    $lookupKey = normalizeCertificateLookupKey($service_name);
    if ($lookupKey === '') {
        return null;
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return null;
    }

    $publicDir = $projectRoot . DIRECTORY_SEPARATOR . 'public';
    if (!is_dir($publicDir)) {
        return null;
    }

    $mimeByExt = [
        'svg' => 'image/svg+xml',
        'pdf' => 'application/pdf',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
    ];

    $entries = scandir($publicDir);
    if ($entries === false) {
        return null;
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }

        $fullPath = $publicDir . DIRECTORY_SEPARATOR . $entry;
        if (!is_file($fullPath)) {
            continue;
        }

        $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
        if (!isset($mimeByExt[$ext])) {
            continue;
        }

        $baseName = pathinfo($entry, PATHINFO_FILENAME);
        if (normalizeCertificateLookupKey($baseName) !== $lookupKey) {
            continue;
        }

        return [
            'path' => $fullPath,
            'name' => $entry,
            'mime' => $mimeByExt[$ext],
            'ext' => $ext,
        ];
    }

    return null;
}

function sanitizeAttachmentFileSegment($value) {
    $segment = trim((string)$value);
    $segment = preg_replace('/[^A-Za-z0-9._ -]+/', '', $segment);
    $segment = preg_replace('/\s+/', ' ', (string)$segment);
    $segment = trim((string)$segment);
    return $segment !== '' ? $segment : 'Certificate';
}

function escapeSvgText($value) {
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_XML1, 'UTF-8');
}

function resolveCertificateRecipientName($project) {
    $client_name = trim((string)($project['client_name'] ?? ''));
    if ($client_name !== '') {
        return $client_name;
    }

    $contact_person = trim((string)($project['contact_person'] ?? ''));
    if ($contact_person !== '') {
        return $contact_person;
    }

    return 'Client';
}

function splitCertificateTextLines($text, $maxCharsPerLine = 18, $maxLines = 3) {
    $normalized = preg_replace('/\s+/', ' ', trim((string)$text));
    if ($normalized === '') {
        return ['CERTIFICATE'];
    }

    $words = preg_split('/\s+/', $normalized) ?: [];
    $lines = [];
    $current = '';
    $index = 0;
    $wordCount = count($words);

    while ($index < $wordCount) {
        $word = $words[$index];
        $candidate = $current === '' ? $word : ($current . ' ' . $word);
        if (mb_strlen($candidate) <= $maxCharsPerLine || $current === '') {
            $current = $candidate;
            $index++;
            continue;
        }

        $lines[] = $current;
        $current = $word;
        if (count($lines) >= $maxLines - 1) {
            break;
        }
        $index++;
    }

    if ($current !== '' && count($lines) < $maxLines) {
        $remainingWords = array_slice($words, $index + 1);
        if (!empty($remainingWords)) {
            $current .= ' ' . implode(' ', $remainingWords);
        }
        $lines[] = $current;
    }

    if (empty($lines)) {
        $lines[] = $normalized;
    }

    if (count($lines) > $maxLines) {
        $lines = array_slice($lines, 0, $maxLines);
    }

    if (mb_strlen($lines[count($lines) - 1]) > $maxCharsPerLine + 6) {
        $lines[count($lines) - 1] = rtrim(mb_substr($lines[count($lines) - 1], 0, $maxCharsPerLine + 3)) . '...';
    }

    return $lines;
}

function buildCertificateTemplateDataUri($path, $mime = '') {
    $filePath = trim((string)$path);
    if ($filePath === '' || !is_file($filePath) || !is_readable($filePath)) {
        return '';
    }

    $resolvedMime = trim((string)$mime);
    if ($resolvedMime === '') {
        $imageInfo = @getimagesize($filePath);
        $resolvedMime = is_array($imageInfo) && !empty($imageInfo['mime'])
            ? (string)$imageInfo['mime']
            : 'application/octet-stream';
    }

    $binary = @file_get_contents($filePath);
    if ($binary === false || $binary === '') {
        return '';
    }

    return 'data:' . $resolvedMime . ';base64,' . base64_encode($binary);
}

function resolveTaskReportNodeBinary() {
    $configured = trim((string)(getenv('NODE_BINARY') ?: ''));
    $candidates = array_filter([
        $configured,
        'node',
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
    ]);

    foreach ($candidates as $candidate) {
        $value = trim((string)$candidate);
        if ($value === '') {
            continue;
        }

        if (preg_match('/[\\\\\\/]/', $value)) {
            if (is_file($value)) {
                return $value;
            }
            continue;
        }

        $resolved = [];
        $status = 1;
        @exec('where ' . escapeshellarg($value) . ' 2>NUL', $resolved, $status);
        if ($status === 0 && !empty($resolved[0])) {
            return trim((string)$resolved[0]);
        }
    }

    return '';
}

function buildRenderedCertificateAttachmentFromSvg($svgContent, $friendlyBase) {
    $svg = trim((string)$svgContent);
    if ($svg === '') {
        return null;
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return null;
    }

    $nodeBinary = resolveTaskReportNodeBinary();
    $scriptPath = realpath($projectRoot . DIRECTORY_SEPARATOR . 'scripts' . DIRECTORY_SEPARATOR . 'render-svg-to-png.mjs');
    if ($nodeBinary === '' || $scriptPath === false || !is_file($scriptPath)) {
        return null;
    }

    $tempDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'capstone1-certificates';
    if (!is_dir($tempDir) && !@mkdir($tempDir, 0777, true) && !is_dir($tempDir)) {
        return null;
    }

    try {
        $token = bin2hex(random_bytes(10));
    } catch (Exception $e) {
        $token = uniqid('cert-', true);
    }

    $svgPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.svg';
    $pngPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.png';
    if (@file_put_contents($svgPath, $svg) === false) {
        return null;
    }

    $command = escapeshellarg($nodeBinary)
        . ' '
        . escapeshellarg($scriptPath)
        . ' '
        . escapeshellarg($svgPath)
        . ' '
        . escapeshellarg($pngPath)
        . ' 2>&1';

    $output = [];
    $status = 1;
    exec($command, $output, $status);
    if ($status !== 0) {
        error_log('[Certificate] SVG-to-PNG render failed (exit ' . $status . '): ' . implode(' | ', $output));
    }

    $pngBinary = ($status === 0 && is_file($pngPath))
        ? @file_get_contents($pngPath)
        : false;

    @unlink($svgPath);
    @unlink($pngPath);

    if ($pngBinary === false || $pngBinary === '') {
        return null;
    }

    return [
        'content' => $pngBinary,
        'name' => $friendlyBase . '.png',
        'mime' => 'image/png',
    ];
}

function buildBundledServiceCertificateSvg($project, $service, $bundledTemplate) {
    $service_name = trim((string)($service['service_name'] ?? 'Professional Services'));
    $recipient_name = resolveCertificateRecipientName($project);
    $image_path = trim((string)($bundledTemplate['path'] ?? ''));
    $image_mime = trim((string)($bundledTemplate['mime'] ?? 'image/png'));
    $image_data_uri = buildCertificateTemplateDataUri($image_path, $image_mime);
    if ($image_data_uri === '') {
        return '';
    }

    $image_info = @getimagesize($image_path);
    $canvas_width = intval($image_info[0] ?? 1024);
    $canvas_height = intval($image_info[1] ?? 1536);
    if ($canvas_width <= 0) {
        $canvas_width = 1024;
    }
    if ($canvas_height <= 0) {
        $canvas_height = 1536;
    }

    $recipientLines = splitCertificateTextLines($recipient_name, 19, 2);
    $longestRecipientLine = 0;
    foreach ($recipientLines as $line) {
        $longestRecipientLine = max($longestRecipientLine, mb_strlen($line));
    }

    $recipientFontSize = 74;
    if ($longestRecipientLine > 20) {
        $recipientFontSize = 56;
    } elseif ($longestRecipientLine > 16) {
        $recipientFontSize = 64;
    }

    $recipientLineHeight = $recipientFontSize + 12;
    $recipientStartY = (int)round($canvas_height * (count($recipientLines) > 1 ? 0.447 : 0.477));
    $recipientTextSvg = '';
    foreach ($recipientLines as $index => $line) {
        $dy = $index === 0 ? '0' : (string)$recipientLineHeight;
        $recipientTextSvg .= '<tspan x="' . ($canvas_width / 2) . '" dy="' . $dy . '">' . escapeSvgText($line) . '</tspan>';
    }

    $maskX = (int)round($canvas_width * 0.215);
    $maskY = (int)round($canvas_height * 0.425);
    $maskWidth = (int)round($canvas_width * 0.57);
    $maskHeight = (int)round($canvas_height * 0.11);

    return '<?xml version="1.0" encoding="UTF-8"?>'
        . '<svg xmlns="http://www.w3.org/2000/svg" width="' . $canvas_width . '" height="' . $canvas_height . '" viewBox="0 0 ' . $canvas_width . ' ' . $canvas_height . '" role="img" aria-label="Certificate for ' . escapeSvgText($service_name) . '">'
        . '<defs>'
        . '<linearGradient id="recipientMask" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fffef9"/><stop offset="100%" stop-color="#f7f0df"/></linearGradient>'
        . '</defs>'
        . '<image href="' . $image_data_uri . '" x="0" y="0" width="' . $canvas_width . '" height="' . $canvas_height . '" preserveAspectRatio="none"/>'
        . '<rect x="' . $maskX . '" y="' . $maskY . '" width="' . $maskWidth . '" height="' . $maskHeight . '" rx="20" fill="url(#recipientMask)" opacity="0.99"/>'
        . '<text x="' . ($canvas_width / 2) . '" y="' . $recipientStartY . '" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="' . $recipientFontSize . '" font-weight="700" fill="#173a76" letter-spacing="1">'
        . $recipientTextSvg
        . '</text>'
        . '</svg>';
}

function buildDefaultServiceCertificateSvg($project, $service, $sender_name, $brand_name) {
    $project_id = intval($project['id'] ?? 0);
    $service_id = intval($service['service_id'] ?? 0);
    $recipient_name = resolveCertificateRecipientName($project);
    $service_name = trim((string)($service['service_name'] ?? 'Professional Services'));
    $issued_date = formatFormalReportDate();
    $certificate_no = 'LLB-CERT-' . str_pad((string)$project_id, 4, '0', STR_PAD_LEFT) . '-' . str_pad((string)$service_id, 3, '0', STR_PAD_LEFT);

    $serviceLines = splitCertificateTextLines(strtoupper($service_name), 17, 3);
    $serviceFontSize = 86;
    $longestServiceLine = 0;
    foreach ($serviceLines as $line) {
        $longestServiceLine = max($longestServiceLine, mb_strlen($line));
    }
    if ($longestServiceLine > 18) {
        $serviceFontSize = 66;
    } elseif ($longestServiceLine > 14) {
        $serviceFontSize = 74;
    }

    $recipientLines = splitCertificateTextLines($recipient_name, 24, 2);
    $longestRecipientLine = 0;
    foreach ($recipientLines as $line) {
        $longestRecipientLine = max($longestRecipientLine, mb_strlen($line));
    }

    $clientFontSize = 64;
    if ($longestRecipientLine > 24) {
        $clientFontSize = 48;
    } elseif ($longestRecipientLine > 18) {
        $clientFontSize = 56;
    }
    $recipientLineHeight = $clientFontSize + 12;
    $recipientStartY = count($recipientLines) > 1 ? 908 : 946;
    $recognitionLines = splitCertificateTextLines(
        'In recognition of successful completion of our ' . strtolower($service_name) . ' engagement.',
        44,
        3
    );

    $serviceTitleSvg = '';
    foreach ($serviceLines as $index => $line) {
        $dy = $index === 0 ? '0' : '94';
        $serviceTitleSvg .= '<tspan x="600" dy="' . $dy . '">' . escapeSvgText($line) . '</tspan>';
    }

    $recognitionSvg = '';
    foreach ($recognitionLines as $index => $line) {
        $dy = $index === 0 ? '0' : '36';
        $recognitionSvg .= '<tspan x="600" dy="' . $dy . '">' . escapeSvgText($line) . '</tspan>';
    }

    $recipientSvg = '';
    foreach ($recipientLines as $index => $line) {
        $dy = $index === 0 ? '0' : (string)$recipientLineHeight;
        $recipientSvg .= '<tspan x="600" dy="' . $dy . '">' . escapeSvgText($line) . '</tspan>';
    }

    return '<?xml version="1.0" encoding="UTF-8"?>'
        . '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1700" viewBox="0 0 1200 1700" role="img" aria-label="Certificate for ' . escapeSvgText($service_name) . '">'
        . '<defs>'
        . '<linearGradient id="bgTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0b4da2"/><stop offset="100%" stop-color="#163b79"/></linearGradient>'
        . '<linearGradient id="bgBottom" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#0b4da2"/><stop offset="100%" stop-color="#102c63"/></linearGradient>'
        . '<linearGradient id="gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#d8a63a"/><stop offset="50%" stop-color="#ffd879"/><stop offset="100%" stop-color="#bf8d26"/></linearGradient>'
        . '<linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fffef9"/><stop offset="100%" stop-color="#f7f0df"/></linearGradient>'
        . '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#0f172a" flood-opacity="0.18"/></filter>'
        . '</defs>'
        . '<rect width="1200" height="1700" fill="#f4efe3"/>'
        . '<rect x="52" y="42" width="1096" height="1616" rx="24" fill="url(#paper)" stroke="url(#gold)" stroke-width="18" filter="url(#shadow)"/>'
        . '<path d="M52 42 H1148 V330 L52 250 Z" fill="url(#bgTop)"/>'
        . '<path d="M52 1450 L1148 1368 V1658 H52 Z" fill="url(#bgBottom)"/>'
        . '<path d="M52 235 L260 165 L360 210 L52 335 Z" fill="url(#gold)" opacity="0.92"/>'
        . '<path d="M1148 180 L940 280 L840 230 L1148 95 Z" fill="url(#gold)" opacity="0.92"/>'
        . '<path d="M52 1405 L242 1490 L360 1440 L52 1326 Z" fill="url(#gold)" opacity="0.92"/>'
        . '<path d="M1148 1320 L950 1410 L840 1362 L1148 1242 Z" fill="url(#gold)" opacity="0.92"/>'
        . '<text x="600" y="152" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="128" font-weight="700" fill="#ffffff" letter-spacing="6">LLB</text>'
        . '<rect x="402" y="184" width="396" height="62" rx="30" fill="#0f3f87" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>'
        . '<text x="600" y="224" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#ffffff" letter-spacing="2">'
        . escapeSvgText(strtoupper($brand_name))
        . '</text>'
        . '<text x="600" y="470" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="64" letter-spacing="7" fill="#173a76">CERTIFICATE OF</text>'
        . '<text x="600" y="590" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="' . $serviceFontSize . '" font-weight="700" fill="#173a76" letter-spacing="2">'
        . $serviceTitleSvg
        . '</text>'
        . '<line x1="210" y1="730" x2="990" y2="730" stroke="#b9c7db" stroke-width="2"/>'
        . '<rect x="515" y="720" width="170" height="20" rx="10" fill="url(#gold)"/>'
        . '<text x="600" y="824" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" letter-spacing="8" fill="#173a76">PRESENTED TO</text>'
        . '<text x="600" y="' . $recipientStartY . '" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-size="' . $clientFontSize . '" font-weight="700" fill="#173a76">'
        . $recipientSvg
        . '</text>'
        . '<line x1="240" y1="1000" x2="960" y2="1000" stroke="#d5deea" stroke-width="2"/>'
        . '<text x="600" y="1086" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" font-style="italic" fill="#27497f">'
        . $recognitionSvg
        . '</text>'
        . '<circle cx="600" cy="1285" r="118" fill="#fff4cf" stroke="url(#gold)" stroke-width="18"/>'
        . '<circle cx="600" cy="1285" r="92" fill="#ffd66c" stroke="#e0ad39" stroke-width="8"/>'
        . '<rect x="440" y="1242" width="320" height="82" rx="20" fill="#0f3f87"/>'
        . '<text x="600" y="1296" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#ffffff" letter-spacing="6">CERTIFIED</text>'
        . '<text x="600" y="1498" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#f6d579" letter-spacing="4">'
        . escapeSvgText('Certificate No. ' . $certificate_no)
        . '</text>'
        . '<text x="600" y="1548" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#f8fbff" letter-spacing="2">'
        . escapeSvgText('Issued ' . $issued_date . ' | Authorized by ' . $sender_name)
        . '</text>'
        . '</svg>';
}

function buildBatchRenderedCertificateAttachments($svgBatch) {
    // $svgBatch = [['svg' => '...', 'friendly_base' => '...'], ...]
    // Returns an array indexed by position: null if failed, or ['content'=>..., 'name'=>..., 'mime'=>...]
    if (empty($svgBatch)) {
        return [];
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        return array_fill(0, count($svgBatch), null);
    }

    $nodeBinary = resolveTaskReportNodeBinary();
    $scriptPath = realpath($projectRoot . DIRECTORY_SEPARATOR . 'scripts' . DIRECTORY_SEPARATOR . 'render-svg-to-png.mjs');
    if ($nodeBinary === '' || $scriptPath === false || !is_file($scriptPath)) {
        return array_fill(0, count($svgBatch), null);
    }

    $tempDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'capstone1-certificates';
    if (!is_dir($tempDir) && !@mkdir($tempDir, 0777, true) && !is_dir($tempDir)) {
        return array_fill(0, count($svgBatch), null);
    }

    try {
        $batchToken = bin2hex(random_bytes(10));
    } catch (Exception $e) {
        $batchToken = uniqid('batch-', true);
    }

    // Write all SVG temp files and build manifest
    $manifest = [];
    $tokens = [];
    foreach ($svgBatch as $i => $item) {
        try {
            $token = bin2hex(random_bytes(10));
        } catch (Exception $e) {
            $token = uniqid('cert-', true);
        }
        $tokens[$i] = $token;
        $svgPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.svg';
        $pngPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.png';
        if (@file_put_contents($svgPath, $item['svg']) === false) {
            $tokens[$i] = null; // mark as failed write
            continue;
        }
        $manifest[] = ['input' => $svgPath, 'output' => $pngPath];
    }

    $manifestPath = $tempDir . DIRECTORY_SEPARATOR . $batchToken . '-batch.json';
    if (@file_put_contents($manifestPath, json_encode($manifest)) === false) {
        // Clean up any written SVGs
        foreach ($tokens as $token) {
            if ($token !== null) {
                @unlink($tempDir . DIRECTORY_SEPARATOR . $token . '.svg');
            }
        }
        return array_fill(0, count($svgBatch), null);
    }

    // Run Node.js once in batch mode
    $command = escapeshellarg($nodeBinary)
        . ' '
        . escapeshellarg($scriptPath)
        . ' --batch '
        . escapeshellarg($manifestPath)
        . ' 2>&1';

    $output = [];
    $status = 1;
    exec($command, $output, $status);

    // Parse JSON results from stdout
    $batchResults = [];
    if ($status === 0) {
        $jsonOutput = trim(implode('', $output));
        $decoded = json_decode($jsonOutput, true);
        if (is_array($decoded) && isset($decoded['results']) && is_array($decoded['results'])) {
            foreach ($decoded['results'] as $r) {
                $batchResults[(string)($r['input'] ?? '')] = $r;
            }
        } else {
            error_log('[Certificate] Batch render produced invalid JSON output: ' . $jsonOutput);
        }
    } else {
        error_log('[Certificate] Batch SVG-to-PNG render failed (exit ' . $status . '): ' . implode(' | ', $output));
    }

    // Map results back to indexed array
    $results = [];
    $manifestIndex = 0;
    foreach ($svgBatch as $i => $item) {
        $token = $tokens[$i] ?? null;
        if ($token === null) {
            $results[$i] = null;
            continue;
        }
        $svgPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.svg';
        $pngPath = $tempDir . DIRECTORY_SEPARATOR . $token . '.png';

        $renderOk = isset($batchResults[$svgPath]) && !empty($batchResults[$svgPath]['success']);
        $pngBinary = ($renderOk && is_file($pngPath)) ? @file_get_contents($pngPath) : false;

        @unlink($svgPath);
        @unlink($pngPath);

        if ($pngBinary === false || $pngBinary === '') {
            $results[$i] = null;
        } else {
            $results[$i] = [
                'content' => $pngBinary,
                'name' => $item['friendly_base'] . '.png',
                'mime' => 'image/png',
            ];
        }
    }

    @unlink($manifestPath);

    return $results;
}

function buildProjectCertificationAttachments($conn, $project, $sender_name) {
    $perfStart = microtime(true);
    $services = getProjectCertificateServices($conn, $project);
    error_log('[Certificate Perf] getProjectCertificateServices: ' . round((microtime(true) - $perfStart) * 1000, 2) . 'ms for ' . count($services) . ' services');
    
    $brand_name = function_exists('getEmailBranding')
        ? (string)((getEmailBranding()['brand_name'] ?? 'LLB Accountants'))
        : 'LLB Accountants';

    $attachments = [];
    $service_names = [];

    // Phase 1: For each service, determine what kind of attachment it will be.
    // Collect SVGs that need rendering into a batch. Non-SVG attachments are resolved immediately.
    // svgBatch: list of ['svg' => string, 'friendly_base' => string, 'fallback' => array|null]
    $svgBatch = [];   // items that need batch SVG->PNG rendering
    $svgBatchMeta = []; // parallel metadata for each batch item
    // pendingAttachments: final ordered list, entries are either resolved arrays or ['__batch_index' => int]
    $pendingAttachments = [];

    foreach ($services as $service) {
        $service_name = trim((string)($service['service_name'] ?? 'Service'));
        if ($service_name === '') {
            continue;
        }

        $service_names[] = $service_name;
        $template_path = trim((string)($service['certificate_template_path'] ?? ''));
        $template_name = trim((string)($service['certificate_template_name'] ?? ''));
        $template_mime = trim((string)($service['certificate_template_mime'] ?? ''));
        $absolute_path = $template_path !== '' ? resolveTaskReportsAbsolutePath($template_path) : '';
        $friendly_base = 'Certificate - ' . sanitizeAttachmentFileSegment($service_name);

        if ($absolute_path !== '' && is_file($absolute_path)) {
            $ext = strtolower(pathinfo($template_name !== '' ? $template_name : $absolute_path, PATHINFO_EXTENSION));
            if ($ext === '') {
                $mimeToExt = [
                    'application/pdf' => 'pdf',
                    'image/png' => 'png',
                    'image/jpeg' => 'jpg',
                    'image/webp' => 'webp',
                    'image/svg+xml' => 'svg',
                ];
                $ext = $mimeToExt[strtolower($template_mime)] ?? 'bin';
            }

            if ($ext === 'svg' || strtolower($template_mime) === 'image/svg+xml') {
                $svgBinary = @file_get_contents($absolute_path);
                if ($svgBinary !== false) {
                    $batchIdx = count($svgBatch);
                    $svgBatch[] = ['svg' => $svgBinary, 'friendly_base' => $friendly_base];
                    // fallback: serve raw SVG if render fails
                    $svgBatchMeta[$batchIdx] = [
                        'fallback' => null, // no non-SVG fallback for custom uploaded SVGs
                    ];
                    $pendingAttachments[] = ['__batch_index' => $batchIdx];
                    continue;
                }
            }

            $pendingAttachments[] = [
                'path' => $absolute_path,
                'name' => $friendly_base . '.' . $ext,
                'mime' => $template_mime,
            ];
            continue;
        }

        $bundledTemplate = findBundledServiceCertificateTemplate($service_name);
        if (is_array($bundledTemplate)) {
            // If the bundled template is already a raster image, attach it directly
            // without the wasteful SVG intermediate round-trip
            $bundledExt = strtolower($bundledTemplate['ext'] ?? '');
            if (in_array($bundledExt, ['png', 'jpg', 'jpeg'], true)) {
                $rasterBinary = @file_get_contents($bundledTemplate['path']);
                if ($rasterBinary !== false) {
                    $pendingAttachments[] = [
                        'content' => $rasterBinary,
                        'name'    => $friendly_base . '.' . $bundledExt,
                        'mime'    => $bundledTemplate['mime'] ?: ('image/' . ($bundledExt === 'jpg' ? 'jpeg' : $bundledExt)),
                    ];
                    continue; // Skip SVG generation for this service
                }
            }

            $bundledSvg = buildBundledServiceCertificateSvg($project, $service, $bundledTemplate);
            if ($bundledSvg !== '') {
                $batchIdx = count($svgBatch);
                $svgBatch[] = ['svg' => $bundledSvg, 'friendly_base' => $friendly_base];
                $svgBatchMeta[$batchIdx] = [
                    'fallback' => [
                        'content' => $bundledSvg,
                        'name' => $friendly_base . '.svg',
                        'mime' => 'image/svg+xml',
                    ],
                ];
                $pendingAttachments[] = ['__batch_index' => $batchIdx];
                continue;
            }

            $pendingAttachments[] = [
                'path' => $bundledTemplate['path'],
                'name' => $friendly_base . '.' . $bundledTemplate['ext'],
                'mime' => $bundledTemplate['mime'],
            ];
            continue;
        }

        $defaultSvg = buildDefaultServiceCertificateSvg($project, $service, $sender_name, $brand_name);
        $batchIdx = count($svgBatch);
        $svgBatch[] = ['svg' => $defaultSvg, 'friendly_base' => $friendly_base];
        $svgBatchMeta[$batchIdx] = [
            'fallback' => [
                'content' => $defaultSvg,
                'name' => $friendly_base . '.svg',
                'mime' => 'image/svg+xml',
            ],
        ];
        $pendingAttachments[] = ['__batch_index' => $batchIdx];
    }

    // Phase 2: Batch-render all collected SVGs in a single Node.js subprocess
    $batchRendered = [];
    if (!empty($svgBatch)) {
        $batchStart = microtime(true);
        $batchRendered = buildBatchRenderedCertificateAttachments($svgBatch);
        error_log('[Certificate Perf] Batch SVG rendering: ' . round((microtime(true) - $batchStart) * 1000, 2) . 'ms for ' . count($svgBatch) . ' certificates');
    }

    // Phase 3: Assemble final attachments list in original order
    foreach ($pendingAttachments as $item) {
        if (!is_array($item) || !isset($item['__batch_index'])) {
            $attachments[] = $item;
            continue;
        }
        $batchIdx = $item['__batch_index'];
        $rendered = $batchRendered[$batchIdx] ?? null;
        if (is_array($rendered)) {
            $attachments[] = $rendered;
        } else {
            // Render failed - use fallback if available
            $fallback = $svgBatchMeta[$batchIdx]['fallback'] ?? null;
            if (is_array($fallback)) {
                $attachments[] = $fallback;
            }
            // If no fallback, skip attachment (e.g. custom SVG template that failed to render)
        }
    }

    return [
        'attachments' => $attachments,
        'service_names' => $service_names,
    ];
}

function buildDefaultProjectReportBody($project, $sender_name, $report_kind) {
    $project_name = trim((string)($project['name'] ?? 'Project'));
    $client_name = trim((string)($project['client_name'] ?? 'Client'));
    $total_tasks = intval($project['total_tasks'] ?? 0);
    $completed_tasks = intval($project['completed_tasks'] ?? 0);
    $report_reference = buildProjectReportReference($project, $report_kind);
    $issue_date = formatFormalReportDate();
    $completion_summary = $completed_tasks . "/" . $total_tasks . " tasks completed";
    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');

    if ($report_kind === 'certification') {
        return "CERTIFICATE OF PROJECT COMPLETION\n"
            . "Reference No.: " . $report_reference . "\n"
            . "Issue Date: " . $issue_date . "\n"
            . "Project: " . $project_name . "\n"
            . "Client: " . $client_name . "\n"
            . "Completion Summary: " . $completion_summary . "\n\n"
            . "This certification serves as the formal confirmation that the professional services, agreed deliverables, and scoped tasks under the above engagement have been completed in accordance with the approved project requirements.\n\n"
            . "Certification Summary:\n"
            . "- All project tasks and required deliverables have been completed.\n"
            . "- Separate service certificates are attached for each active service included in this engagement.\n"
            . "- This certification may be retained as the official project closeout confirmation.\n\n"
            . "Issued by:\n"
            . $brand_name . "\n\n"
            . "Certified by,\n"
            . $sender_name;
    }

    return "FINAL PROJECT REPORT\n"
        . "Reference No.: " . $report_reference . "\n"
        . "Issue Date: " . $issue_date . "\n"
        . "Project: " . $project_name . "\n"
        . "Client: " . $client_name . "\n"
        . "Completion Summary: " . $completion_summary . "\n\n"
        . "Executive Summary:\n"
        . "We are pleased to formally confirm that all agreed deliverables and planned tasks under the above project have been completed successfully and in accordance with the approved scope of work.\n\n"
        . "Project Status:\n"
        . "- All required tasks have been completed.\n"
        . "- Supporting outputs have been prepared for client review and turnover as applicable.\n"
        . "- The engagement is ready for formal closeout.\n\n"
        . "This final report serves as formal confirmation that the project has been successfully completed.\n\n"
        . "Prepared by:\n"
        . $sender_name . "\n"
        . $brand_name;
}

function buildCompletionReportEmail($task, $report_body, $sender_name) {
    $client_name = trim((string)($task['client_name'] ?? 'Client'));
    $contact_person = trim((string)($task['contact_person'] ?? ''));
    $recipient = $contact_person !== '' ? $contact_person : $client_name;
    $task_title = trim((string)($task['title'] ?? 'Task'));
    $project_name = trim((string)($task['project_name'] ?? 'Project'));
    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');

    $safe_recipient = htmlspecialchars($recipient, ENT_QUOTES, 'UTF-8');
    $safe_task_title = htmlspecialchars($task_title, ENT_QUOTES, 'UTF-8');
    $safe_project_name = htmlspecialchars($project_name, ENT_QUOTES, 'UTF-8');
    $safe_report_body = nl2br(htmlspecialchars($report_body, ENT_QUOTES, 'UTF-8'));
    $safe_sender = htmlspecialchars($sender_name, ENT_QUOTES, 'UTF-8');
    $safe_brand_name = htmlspecialchars($brand_name, ENT_QUOTES, 'UTF-8');

    $subject = 'Completion Report - ' . $task_title . ' | ' . $brand_name;
    $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;">Dear ' . $safe_recipient . ',</p>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Congratulations. We are pleased to inform you that the task below has been completed successfully.'
        . '</p>'
        . '<div style="margin:0 0 14px 0;padding:12px 14px;background:#f8fafc;border:1px solid #dbe3ef;border-radius:10px;">'
        . '<p style="margin:0 0 6px 0;font-size:13px;color:#334155;"><strong>Project:</strong> ' . $safe_project_name . '</p>'
        . '<p style="margin:0;font-size:13px;color:#334155;"><strong>Task:</strong> ' . $safe_task_title . '</p>'
        . '</div>'
        . '<p style="margin:0 0 8px 0;font-size:14px;line-height:1.7;color:#1f2937;"><strong>Completion Report</strong></p>'
        . '<div style="padding:12px;border:1px solid #d1d5db;border-radius:8px;background:#ffffff;font-size:13px;line-height:1.8;color:#334155;">'
        . $safe_report_body
        . '</div>'
        . '<p style="margin:14px 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Thank you for choosing ' . $safe_brand_name . '. We appreciate your trust and continued partnership.'
        . '</p>'
        . '<p style="margin:0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Sincerely,<br><strong>' . $safe_sender . '</strong><br>' . $safe_brand_name
        . '</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, 'Your task has been completed and your formal report is ready.')
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    $alt = "Hello " . $recipient . ",\n\n"
        . "Congratulations. We are pleased to inform you that your task has been completed successfully.\n\n"
        . "Project: " . $project_name . "\n"
        . "Task: " . $task_title . "\n\n"
        . "Completion Report:\n"
        . $report_body . "\n\n"
        . "Thank you for choosing " . $brand_name . ". We appreciate your trust and continued partnership.\n\n"
        . "Best regards,\n"
        . $sender_name . "\n"
        . $brand_name;

    return [
        'subject' => $subject,
        'html' => $html,
        'alt' => $alt,
        'recipient' => $recipient,
    ];
}

function buildProjectCompletionEmail($project, $report_body, $sender_name, $report_kind, $certificate_service_names = []) {
    $client_name = trim((string)($project['client_name'] ?? 'Client'));
    $contact_person = trim((string)($project['contact_person'] ?? ''));
    $recipient = $contact_person !== '' ? $contact_person : $client_name;
    $project_name = trim((string)($project['name'] ?? 'Project'));
    $total_tasks = intval($project['total_tasks'] ?? 0);
    $completed_tasks = intval($project['completed_tasks'] ?? 0);
    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');
    $report_label = getProjectReportKindLabel($report_kind);
    $report_label_lower = strtolower($report_label);
    $report_reference = buildProjectReportReference($project, $report_kind);
    $issue_date = formatFormalReportDate();
    $completion_summary = $completed_tasks . '/' . $total_tasks . ' tasks completed';

    $safe_recipient = htmlspecialchars($recipient, ENT_QUOTES, 'UTF-8');
    $safe_project_name = htmlspecialchars($project_name, ENT_QUOTES, 'UTF-8');
    $safe_report_body = nl2br(htmlspecialchars($report_body, ENT_QUOTES, 'UTF-8'));
    $safe_sender = htmlspecialchars($sender_name, ENT_QUOTES, 'UTF-8');
    $safe_brand_name = htmlspecialchars($brand_name, ENT_QUOTES, 'UTF-8');
    $safe_report_label = htmlspecialchars($report_label, ENT_QUOTES, 'UTF-8');
    $safe_report_label_lower = htmlspecialchars($report_label_lower, ENT_QUOTES, 'UTF-8');
    $safe_report_reference = htmlspecialchars($report_reference, ENT_QUOTES, 'UTF-8');
    $safe_issue_date = htmlspecialchars($issue_date, ENT_QUOTES, 'UTF-8');
    $safe_client_name = htmlspecialchars($client_name, ENT_QUOTES, 'UTF-8');
    $safe_completion_summary = htmlspecialchars($completion_summary, ENT_QUOTES, 'UTF-8');
    $attachmentNoteHtml = '';
    $attachmentNoteAlt = '';

    if ($report_kind === 'certification' && is_array($certificate_service_names) && !empty($certificate_service_names)) {
        $attachmentItemsHtml = '';
        $attachmentItemsAlt = [];
        foreach ($certificate_service_names as $service_name) {
            $label = trim((string)$service_name);
            if ($label === '') continue;
            $attachmentItemsHtml .= '<li style="margin:0 0 6px 18px;color:#334155;font-size:13px;line-height:1.7;">'
                . htmlspecialchars($label, ENT_QUOTES, 'UTF-8')
                . '</li>';
            $attachmentItemsAlt[] = '- ' . $label;
        }

        if ($attachmentItemsHtml !== '') {
            $attachmentNoteHtml = '<div style="margin:16px 0 16px 0;padding:14px 16px;border:1px solid #d7e3f4;border-radius:12px;background:#f8fbff;">'
                . '<div style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:#0f172a;">Attached Certificates</div>'
                . '<p style="margin:0 0 8px 0;font-size:13px;line-height:1.75;color:#334155;">'
                . 'This email includes the individual service certificates listed below. Each certificate is attached as a separate file for easy viewing and filing.'
                . '</p>'
                . '<ul style="margin:0;padding:0 0 0 2px;list-style:disc;">'
                . $attachmentItemsHtml
                . '</ul>'
                . '</div>';
            $attachmentNoteAlt = "Attached Certificates:\n" . implode("\n", $attachmentItemsAlt) . "\n\n";
        }
    }

    $subject = $report_kind === 'certification'
        ? 'Official Project Certification Package - ' . $project_name . ' | ' . $brand_name
        : 'Official Final Report - ' . $project_name . ' | ' . $brand_name;
    $introText = $report_kind === 'certification'
        ? 'Please find below the formal certification package confirming the successful completion of the project referenced below. Separate service certificates are attached for your records.'
        : 'Please find below the official final report confirming the successful completion of the project referenced below.';
    $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;">Dear ' . $safe_recipient . ',</p>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . htmlspecialchars($introText, ENT_QUOTES, 'UTF-8')
        . '</p>'
        . '<div style="margin:0 0 16px 0;padding:18px;background:#f8fbff;border:1px solid #d7e3f4;border-radius:14px;">'
        . '<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#0f2d74;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">'
        . $safe_report_label
        . '</div>'
        . '<div style="margin-top:12px;font-size:20px;line-height:1.3;font-weight:700;color:#0f172a;">' . $safe_project_name . '</div>'
        . '<div style="margin-top:4px;font-size:13px;line-height:1.6;color:#475569;">Formal client issuance from ' . $safe_brand_name . '</div>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:14px;border-collapse:collapse;">'
        . '<tr>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Reference No.</td>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">' . $safe_report_reference . '</td>'
        . '</tr>'
        . '<tr>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Issue Date</td>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">' . $safe_issue_date . '</td>'
        . '</tr>'
        . '<tr>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Client</td>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">' . $safe_client_name . '</td>'
        . '</tr>'
        . '<tr>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Document</td>'
        . '<td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">' . $safe_report_label . '</td>'
        . '</tr>'
        . '<tr>'
        . '<td style="padding:8px 0 0 0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Completion</td>'
        . '<td style="padding:8px 0 0 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">' . $safe_completion_summary . '</td>'
        . '</tr>'
        . '</table>'
        . '</div>'
        . '<p style="margin:0 0 8px 0;font-size:14px;line-height:1.7;color:#0f172a;font-weight:700;">Executive Summary</p>'
        . '<div style="padding:14px 16px;border:1px solid #dbe3ef;border-radius:12px;background:#ffffff;font-size:13px;line-height:1.85;color:#334155;">'
        . $safe_report_body
        . '</div>'
        . $attachmentNoteHtml
        . '<p style="margin:14px 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'If you need a signed copy or any additional supporting documents, our team will be glad to assist.'
        . '</p>'
        . '<p style="margin:0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Respectfully,<br><strong>' . $safe_sender . '</strong><br>' . $safe_brand_name
        . '</p>';

    $preheader = $report_kind === 'certification'
        ? 'Your certification package with service certificates is ready.'
        : 'Your final report is ready.';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, $preheader)
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    $altIntro = $report_kind === 'certification'
        ? "Please find your formal certification package for the completed project below. Separate service certificates are attached for your records.\n\n"
        : "Please find your official final report for the completed project below.\n\n";

    $alt = "Hello " . $recipient . ",\n\n"
        . $altIntro
        . "Reference No.: " . $report_reference . "\n"
        . "Issue Date: " . $issue_date . "\n"
        . "Project: " . $project_name . "\n"
        . "Client: " . $client_name . "\n"
        . "Document: " . $report_label . "\n\n"
        . "Completion: " . $completion_summary . "\n\n"
        . $report_body . "\n\n"
        . $attachmentNoteAlt
        . "If you need a signed copy or any supporting documents, our team will be glad to assist.\n\n"
        . "Respectfully,\n"
        . $sender_name . "\n"
        . $brand_name;

    return [
        'subject' => $subject,
        'html' => $html,
        'alt' => $alt,
        'recipient' => $recipient,
    ];
}

function handlePost($conn) {
    $role = getCurrentRole();
    $data = getJSONInput();
    $task_id = intval($data['task_id'] ?? 0);
    $project_id = intval($data['project_id'] ?? 0);

    if ($task_id > 0) {
        handleTaskReportPost($conn, $role, $data, $task_id);
        return;
    }

    if ($project_id > 0) {
        handleProjectReportPost($conn, $role, $data, $project_id);
        return;
    }

    sendError('Task ID or Project ID is required.', 400);
}

function handleTaskReportPost($conn, $role, $data, $task_id) {
    if (!in_array($role, ['admin', 'manager', 'staff'], true)) {
        sendError('Forbidden: only admin, manager, or staff can send completion reports.', 403);
    }

    ensureTaskCompletionReportsTable($conn);

    $task = getTaskForCompletionReport($conn, $task_id);
    if (!$task) {
        sendError('Task not found.', 404);
    }

    $current_user_id = intval($_SESSION['user_id'] ?? 0);
    if ($role === 'manager' && intval($task['manager_id'] ?? 0) !== $current_user_id) {
        sendError('Managers can only send task reports for projects assigned to them.', 403);
    }
    if ($role === 'staff') {
        $accessSql = "SELECT id
                      FROM tasks t
                      WHERE t.id = ?
                        AND (
                            t.assigned_to = ?
                            OR EXISTS (
                                SELECT 1
                                FROM task_collaborators tc
                                WHERE tc.task_id = t.id
                                  AND tc.user_id = ?
                            )
                        )
                      LIMIT 1";
        $accessStmt = $conn->prepare($accessSql);
        if (!$accessStmt) {
            error_log($conn->error);
            sendError('Failed to validate staff task access.', 500);
        }
        $accessStmt->bind_param('iii', $task_id, $current_user_id, $current_user_id);
        $accessStmt->execute();
        $allowed = $accessStmt->get_result()->num_rows > 0;
        $accessStmt->close();

        if (!$allowed) {
            sendError('Staff can only send reports for tasks assigned or shared with them.', 403);
        }
    }

    if (($task['status'] ?? '') !== 'completed') {
        sendError('Completion report can only be sent when the task is completed.', 400);
    }

    $client_email = trim((string)($task['client_email'] ?? ''));
    if ($client_email === '') {
        sendError('Cannot send report: client email is missing for this task.', 400);
    }
    if (!validateGmailComEmail($client_email)) {
        sendError('Cannot send report: client email must be a valid @gmail.com or @phinmaed.com address.', 400);
    }

    $existing_stmt = $conn->prepare("SELECT report_id, sent_at FROM task_completion_reports WHERE task_id = ? LIMIT 1");
    if (!$existing_stmt) {
        error_log($conn->error);
        sendError('Failed to check existing completion report.', 500);
    }
    $existing_stmt->bind_param('i', $task_id);
    $existing_stmt->execute();
    $existing = $existing_stmt->get_result()->fetch_assoc();
    $existing_stmt->close();

    $is_resend = !empty($existing);
    $existing_report_id = $is_resend ? intval($existing['report_id']) : 0;

    $sender_name = getUserDisplayNameById($conn, $current_user_id);
    $report_body = trim((string)($data['report_body'] ?? ''));
    if ($report_body === '') {
        $report_body = buildDefaultReportBody($task, $sender_name);
    }
    if (strlen($report_body) > 5000) {
        $report_body = substr($report_body, 0, 5000);
    }

    if (!function_exists('sendMail')) {
        sendError('Completion report email service is unavailable.', 500);
    }

    $project_id = isset($task['project_id']) && $task['project_id'] !== null ? intval($task['project_id']) : null;
    $client_id = isset($task['client_id']) && $task['client_id'] !== null ? intval($task['client_id']) : null;

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start completion report transaction.', 500);
    }

    if ($is_resend) {
        $update_sql = "UPDATE task_completion_reports
                       SET project_id = ?, client_id = ?, report_body = ?, sent_by = ?, sent_at = CURRENT_TIMESTAMP
                       WHERE report_id = ?
                       LIMIT 1";
        $update_stmt = $conn->prepare($update_sql);
        if (!$update_stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to update completion report record.', 500);
        }

        $update_stmt->bind_param('iisii', $project_id, $client_id, $report_body, $current_user_id, $existing_report_id);
        if (!$update_stmt->execute()) {
            $update_stmt->close();
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to update completion report record.', 500);
        }
        $update_stmt->close();
        $report_id = $existing_report_id;
    } else {
        $insert_sql = "INSERT INTO task_completion_reports (task_id, project_id, client_id, report_body, sent_by)
                       VALUES (?, ?, ?, ?, ?)";
        $insert_stmt = $conn->prepare($insert_sql);
        if (!$insert_stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to save completion report record.', 500);
        }
        $insert_stmt->bind_param('iiisi', $task_id, $project_id, $client_id, $report_body, $current_user_id);

        if (!$insert_stmt->execute()) {
            $is_duplicate = intval($conn->errno) === 1062;
            $insert_stmt->close();
            $conn->rollback();
            if ($is_duplicate) {
                sendError('A completion report already exists for this task.', 409);
            }
            error_log($conn->error);
            sendError('Failed to save completion report record.', 500);
        }

        $report_id = intval($conn->insert_id);
        $insert_stmt->close();
    }

    $email = buildCompletionReportEmail($task, $report_body, $sender_name);
    $sent = sendMail($client_email, $email['recipient'], $email['subject'], $email['html'], $email['alt']);
    if (!$sent) {
        $conn->rollback();
        sendError('Failed to send completion report email. Please check SMTP configuration.', 500);
    }

    if (!$conn->commit()) {
        $conn->rollback();
        sendError('Failed to finalize completion report.', 500);
    }

    if ($current_user_id > 0) {
        $task_name = (string)($task['title'] ?? ('Task ' . $task_id));
        $action_verb = $is_resend ? 'Resent' : 'Sent';
        logActivity(
            $conn,
            $current_user_id,
            'send_task_completion_report',
            "$action_verb completion report for task: $task_name (ID: $task_id)",
            'task_management'
        );
    }

    sendResponse(true, [
        'report_id' => $report_id,
        'task_id' => $task_id,
        'client_email' => $client_email,
        'resent' => $is_resend ? 1 : 0,
        'sent_at' => date('Y-m-d H:i:s'),
    ], $is_resend ? 'Completion report resent successfully.' : 'Completion report sent successfully.');
}

function handleProjectReportPost($conn, $role, $data, $project_id) {
    $totalStart = microtime(true);
    if (!in_array($role, ['admin', 'manager'], true)) {
        sendError('Forbidden: only admin or manager can send final project reports.', 403);
    }

    $report_kind = strtolower(trim((string)($data['report_kind'] ?? '')));
    if ($report_kind !== 'major_report') {
        sendError('Only final project reports can be sent.', 400);
    }

    ensureProjectCompletionReportsTable($conn);

    $project = getProjectForCompletionReport($conn, $project_id);
    if (!$project) {
        sendError('Project not found.', 404);
    }

    $current_user_id = intval($_SESSION['user_id'] ?? 0);
    if ($role === 'manager' && intval($project['manager_id'] ?? 0) !== $current_user_id) {
        sendError('Managers can only send final reports for projects assigned to them.', 403);
    }

    $total_tasks = intval($project['total_tasks'] ?? 0);
    $completed_tasks = intval($project['completed_tasks'] ?? 0);
    if ($total_tasks <= 0) {
        sendError('A final project report can only be sent after the project has at least one task.', 400);
    }
    if ($completed_tasks < $total_tasks) {
        sendError('All project tasks must be completed before sending a final report.', 400);
    }

    $client_email = trim((string)($project['client_email'] ?? ''));
    if ($client_email === '') {
        sendError('Cannot send project report: client email is missing for this project.', 400);
    }
    if (!validateGmailComEmail($client_email)) {
        sendError('Cannot send project report: client email must be a valid @gmail.com or @phinmaed.com address.', 400);
    }

    $existing_stmt = $conn->prepare(
        "SELECT report_id, sent_at
         FROM project_completion_reports
         WHERE project_id = ?
           AND report_kind = ?
         LIMIT 1"
    );
    if (!$existing_stmt) {
        error_log($conn->error);
        sendError('Failed to check existing project report.', 500);
    }
    $existing_stmt->bind_param('is', $project_id, $report_kind);
    $existing_stmt->execute();
    $existing = $existing_stmt->get_result()->fetch_assoc();
    $existing_stmt->close();

    $is_resend = !empty($existing);
    $existing_report_id = $is_resend ? intval($existing['report_id']) : 0;

    $sender_name = getUserDisplayNameById($conn, $current_user_id);
    $report_body = trim((string)($data['report_body'] ?? ''));
    if ($report_body === '') {
        $report_body = buildDefaultProjectReportBody($project, $sender_name, $report_kind);
    }
    if (strlen($report_body) > 5000) {
        $report_body = substr($report_body, 0, 5000);
    }

    if (!function_exists('sendMail')) {
        sendError('Project report email service is unavailable.', 500);
    }

    $certificateAttachments = [];
    $certificateServiceNames = [];
    if ($report_kind === 'certification') {
        $attachmentPayload = buildProjectCertificationAttachments($conn, $project, $sender_name);
        $certificateAttachments = is_array($attachmentPayload['attachments'] ?? null)
            ? $attachmentPayload['attachments']
            : [];
        $certificateServiceNames = is_array($attachmentPayload['service_names'] ?? null)
            ? $attachmentPayload['service_names']
            : [];

        if (empty($certificateAttachments)) {
            sendError('Cannot send certification: no active service certificates are available for this project.', 400);
        }
    }

    $client_id = isset($project['client_id']) && $project['client_id'] !== null ? intval($project['client_id']) : null;

    if (!$conn->begin_transaction()) {
        error_log($conn->error);
        sendError('Failed to start project report transaction.', 500);
    }

    if ($is_resend) {
        $update_sql = "UPDATE project_completion_reports
                       SET client_id = ?, report_body = ?, sent_by = ?, sent_at = CURRENT_TIMESTAMP
                       WHERE report_id = ?
                       LIMIT 1";
        $update_stmt = $conn->prepare($update_sql);
        if (!$update_stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to update project report record.', 500);
        }
        $update_stmt->bind_param('isii', $client_id, $report_body, $current_user_id, $existing_report_id);
        if (!$update_stmt->execute()) {
            $update_stmt->close();
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to update project report record.', 500);
        }
        $update_stmt->close();
        $report_id = $existing_report_id;
    } else {
        $insert_sql = "INSERT INTO project_completion_reports (project_id, client_id, report_kind, report_body, sent_by)
                       VALUES (?, ?, ?, ?, ?)";
        $insert_stmt = $conn->prepare($insert_sql);
        if (!$insert_stmt) {
            $conn->rollback();
            error_log($conn->error);
            sendError('Failed to save project report record.', 500);
        }
        $insert_stmt->bind_param('iissi', $project_id, $client_id, $report_kind, $report_body, $current_user_id);
        if (!$insert_stmt->execute()) {
            $is_duplicate = intval($conn->errno) === 1062;
            $insert_stmt->close();
            $conn->rollback();
            if ($is_duplicate) {
                sendError('A project report already exists for this document type.', 409);
            }
            error_log($conn->error);
            sendError('Failed to save project report record.', 500);
        }
        $report_id = intval($conn->insert_id);
        $insert_stmt->close();
    }

    $email = buildProjectCompletionEmail($project, $report_body, $sender_name, $report_kind, $certificateServiceNames);
    $emailStart = microtime(true);
    $sent = sendMail(
        $client_email,
        $email['recipient'],
        $email['subject'],
        $email['html'],
        $email['alt'],
        $certificateAttachments
    );
    error_log('[Certificate Perf] Email sending (SMTP): ' . round((microtime(true) - $emailStart) * 1000, 2) . 'ms with ' . count($certificateAttachments) . ' attachments');
    if (!$sent) {
        $conn->rollback();
        sendError('Failed to send project report email. Please check SMTP configuration.', 500);
    }

    if (!$conn->commit()) {
        $conn->rollback();
        sendError('Failed to finalize project report.', 500);
    }

    if ($current_user_id > 0) {
        $project_name = (string)($project['name'] ?? ('Project ' . $project_id));
        $action_verb = $is_resend ? 'Resent' : 'Sent';
        $label = strtolower(getProjectReportKindLabel($report_kind));
        logActivity(
            $conn,
            $current_user_id,
            'send_project_completion_report',
            "$action_verb $label for project: $project_name (ID: $project_id)",
            'project_management'
        );
    }

    $success_message = $report_kind === 'certification'
        ? ($is_resend ? 'Project certification resent successfully.' : 'Project certification sent successfully.')
        : ($is_resend ? 'Final project report resent successfully.' : 'Final project report sent successfully.');

    error_log('[Certificate Perf] TOTAL request time: ' . round((microtime(true) - $totalStart) * 1000, 2) . 'ms');

    sendResponse(true, [
        'report_id' => $report_id,
        'project_id' => $project_id,
        'report_kind' => $report_kind,
        'client_email' => $client_email,
        'attachment_count' => count($certificateAttachments),
        'certificate_services' => $certificateServiceNames,
        'resent' => $is_resend ? 1 : 0,
        'sent_at' => date('Y-m-d H:i:s'),
    ], $success_message);
}

closeDBConnection($conn);
?>
