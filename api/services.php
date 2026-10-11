<?php
/**
 * Services API
 * Handles CRUD for Services and Service Checklists
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureServicesSchema($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('services', ['admin', 'manager'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('services', ['admin', 'manager'], $conn);
        handlePost($conn); // Add Service or Checklist
        break;
    case 'PUT':
        requireFeatureAccess('services', ['admin', 'manager'], $conn);
        handlePut($conn); // Update Service or Checklist
        break;
    case 'DELETE':
        requireFeatureAccess('services', ['admin', 'manager'], $conn);
        handleDelete($conn); // Delete Service or Checklist
        break;
    default:
        sendError('Method not allowed', 405);
}

function normalizeTextInput($value) {
    if (!is_string($value)) {
        return '';
    }

    // Keep user text as plain text in DB. HTML escaping should happen on output.
    $value = trim(stripslashes($value));
    return html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

function assertUniqueServiceName($conn, $serviceName, $excludeServiceId = null) {
    $name = trim((string)$serviceName);
    if ($name === '') return;

    if ($excludeServiceId !== null && intval($excludeServiceId) > 0) {
        $id = intval($excludeServiceId);
        $stmt = $conn->prepare(
            "SELECT service_id
             FROM services
             WHERE LOWER(TRIM(service_name)) = LOWER(TRIM(?))
               AND service_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate service name.', 500);
        $stmt->bind_param('si', $name, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT service_id
             FROM services
             WHERE LOWER(TRIM(service_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate service name.', 500);
        $stmt->bind_param('s', $name);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Service name already exists.', 409);
    }
}

function assertUniqueChecklistTaskName($conn, $serviceId, $taskName, $excludeChecklistId = null) {
    $sid = intval($serviceId);
    $name = trim((string)$taskName);
    if ($sid <= 0 || $name === '') return;

    if ($excludeChecklistId !== null && intval($excludeChecklistId) > 0) {
        $checklistId = intval($excludeChecklistId);
        $stmt = $conn->prepare(
            "SELECT checklist_id
             FROM service_checklists
             WHERE service_id = ?
               AND LOWER(TRIM(task_name)) = LOWER(TRIM(?))
               AND checklist_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate checklist task.', 500);
        $stmt->bind_param('isi', $sid, $name, $checklistId);
    } else {
        $stmt = $conn->prepare(
            "SELECT checklist_id
             FROM service_checklists
             WHERE service_id = ?
               AND LOWER(TRIM(task_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate checklist task.', 500);
        $stmt->bind_param('is', $sid, $name);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Checklist task name already exists for this service.', 409);
    }
}

function decodeServiceRow($row) {
    if (!is_array($row)) {
        return $row;
    }

    if (isset($row['service_name'])) {
        $row['service_name'] = html_entity_decode((string)$row['service_name'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }
    if (isset($row['description'])) {
        $row['description'] = html_entity_decode((string)$row['description'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    return $row;
}

function decodeChecklistRow($row) {
    if (!is_array($row)) {
        return $row;
    }

    if (isset($row['task_name'])) {
        $row['task_name'] = html_entity_decode((string)$row['task_name'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }
    if (isset($row['description'])) {
        $row['description'] = html_entity_decode((string)$row['description'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    return $row;
}

function getServiceCertificateMeta($conn, $serviceId) {
    $sid = intval($serviceId);
    if ($sid <= 0) return null;

    $stmt = $conn->prepare(
        "SELECT certificate_template_path,
                certificate_template_name,
                certificate_template_mime,
                certificate_template_size,
                certificate_template_updated_at
         FROM services
         WHERE service_id = ?
         LIMIT 1"
    );
    if (!$stmt) return null;

    $stmt->bind_param('i', $sid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return is_array($row) ? $row : null;
}

function deleteServiceCertificateFile($relativePath) {
    $normalized = str_replace('\\', '/', trim((string)$relativePath));
    if ($normalized === '' || strpos($normalized, 'uploads/service-certificates/') !== 0) {
        return;
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) return;

    $fullPath = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $normalized);
    if (is_file($fullPath)) {
        @unlink($fullPath);
    }
}

function storeServiceCertificateTemplateUpload($serviceId) {
    $file = $_FILES['certificate_template'] ?? null;
    if (!is_array($file)) {
        sendError('Certificate template file is required.', 400);
    }

    $errorCode = intval($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($errorCode !== UPLOAD_ERR_OK) {
        $errors = [
            UPLOAD_ERR_INI_SIZE => 'Uploaded certificate exceeds the server upload limit.',
            UPLOAD_ERR_FORM_SIZE => 'Uploaded certificate exceeds the form upload limit.',
            UPLOAD_ERR_PARTIAL => 'Uploaded certificate was only partially uploaded.',
            UPLOAD_ERR_NO_FILE => 'No certificate template file was uploaded.',
            UPLOAD_ERR_NO_TMP_DIR => 'Temporary upload directory is missing.',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write uploaded certificate to disk.',
            UPLOAD_ERR_EXTENSION => 'Certificate upload blocked by a server extension.',
        ];
        sendError($errors[$errorCode] ?? 'Certificate template upload failed.', 400);
    }

    $tmpPath = (string)($file['tmp_name'] ?? '');
    if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
        sendError('Invalid uploaded certificate template.', 400);
    }

    $originalName = trim((string)($file['name'] ?? 'certificate-template'));
    if ($originalName === '') {
        $originalName = 'certificate-template';
    }

    $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    $allowedMimeByExt = [
        'svg' => 'image/svg+xml',
        'pdf' => 'application/pdf',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
    ];
    if (!isset($allowedMimeByExt[$ext])) {
        sendError('Unsupported certificate template type. Allowed: svg, pdf, png, jpg, jpeg, webp.', 400);
    }

    $projectRoot = realpath(__DIR__ . '/..');
    if ($projectRoot === false) {
        sendError('Failed to resolve upload path.', 500);
    }

    $relativeDir = 'uploads/service-certificates';
    $uploadDir = $projectRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativeDir);
    if (!is_dir($uploadDir) && !mkdir($uploadDir, 0775, true) && !is_dir($uploadDir)) {
        sendError('Failed to create certificate upload directory.', 500);
    }

    try {
        $randomSuffix = bin2hex(random_bytes(4));
    } catch (Throwable $e) {
        $randomSuffix = substr(md5(uniqid((string)$serviceId, true)), 0, 8);
    }

    $filename = 'service-' . intval($serviceId)
        . '-certificate-'
        . date('YmdHis')
        . '-'
        . $randomSuffix
        . '.'
        . $ext;

    $fullPath = $uploadDir . DIRECTORY_SEPARATOR . $filename;
    if (!move_uploaded_file($tmpPath, $fullPath)) {
        sendError('Failed to store uploaded certificate template.', 500);
    }

    // Verify actual MIME type from file contents (not the client-supplied type header).
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $actualMime = $finfo->file($fullPath);
    if ($actualMime !== $allowedMimeByExt[$ext]) {
        unlink($fullPath);
        sendError('Uploaded file content does not match its extension.', 400);
    }

    return [
        'path' => $relativeDir . '/' . $filename,
        'name' => $originalName,
        'mime' => $actualMime,
        'size' => intval($file['size'] ?? 0),
    ];
}

function handleCertificateTemplateUpload($conn) {
    $serviceId = intval($_POST['service_id'] ?? $_GET['service_id'] ?? 0);
    if ($serviceId <= 0) {
        sendError('Service ID is required.', 400);
    }
    if (!serviceExists($conn, $serviceId)) {
        sendError('Service not found.', 404);
    }

    $existing = getServiceCertificateMeta($conn, $serviceId);
    $stored = storeServiceCertificateTemplateUpload($serviceId);

    $stmt = $conn->prepare(
        "UPDATE services
         SET certificate_template_path = ?,
             certificate_template_name = ?,
             certificate_template_mime = ?,
             certificate_template_size = ?,
             certificate_template_updated_at = NOW()
         WHERE service_id = ?"
    );
    if (!$stmt) {
        deleteServiceCertificateFile($stored['path']);
        error_log($conn->error);
        sendError('Failed to save certificate template.', 500);
    }

    $stmt->bind_param(
        'sssii',
        $stored['path'],
        $stored['name'],
        $stored['mime'],
        $stored['size'],
        $serviceId
    );
    if (!$stmt->execute()) {
        $stmt->close();
        deleteServiceCertificateFile($stored['path']);
        error_log($conn->error);
        sendError('Failed to save certificate template.', 500);
    }
    $stmt->close();

    if (!empty($existing['certificate_template_path'])) {
        deleteServiceCertificateFile($existing['certificate_template_path']);
    }

    sendResponse(true, [
        'service_id' => $serviceId,
        'certificate_template_path' => $stored['path'],
        'certificate_template_name' => $stored['name'],
        'certificate_template_mime' => $stored['mime'],
        'certificate_template_size' => $stored['size'],
    ], 'Certificate template updated successfully.');
}

function handleCertificateTemplateDelete($conn) {
    $serviceId = intval($_GET['service_id'] ?? $_POST['service_id'] ?? 0);
    if ($serviceId <= 0) {
        sendError('Service ID is required.', 400);
    }
    if (!serviceExists($conn, $serviceId)) {
        sendError('Service not found.', 404);
    }

    $existing = getServiceCertificateMeta($conn, $serviceId);
    if (!$existing || empty($existing['certificate_template_path'])) {
        sendResponse(true, ['service_id' => $serviceId], 'Default certificate template is already active.');
    }

    $stmt = $conn->prepare(
        "UPDATE services
         SET certificate_template_path = NULL,
             certificate_template_name = NULL,
             certificate_template_mime = NULL,
             certificate_template_size = NULL,
             certificate_template_updated_at = NOW()
         WHERE service_id = ?"
    );
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to remove certificate template.', 500);
    }
    $stmt->bind_param('i', $serviceId);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to remove certificate template.', 500);
    }
    $stmt->close();

    deleteServiceCertificateFile($existing['certificate_template_path']);

    sendResponse(true, ['service_id' => $serviceId], 'Certificate template reverted to the generated default.');
}

function attachChecklistsToServices($conn, $services, $includeArchivedChecklists = false) {
    if (!is_array($services) || empty($services)) {
        return $services;
    }

    $serviceIds = [];
    foreach ($services as $row) {
        $serviceId = intval($row['service_id'] ?? 0);
        if ($serviceId > 0) {
            $serviceIds[$serviceId] = $serviceId;
        }
    }

    if (empty($serviceIds)) {
        foreach ($services as &$row) {
            $row['checklists'] = [];
        }
        unset($row);
        return $services;
    }

    $ids = array_values($serviceIds);
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $sql = "SELECT *
            FROM service_checklists
            WHERE service_id IN ($placeholders)";
    if (!$includeArchivedChecklists) {
        $sql .= " AND is_deleted = 0";
    }
    $sql .= " ORDER BY service_id ASC, is_deleted ASC, checklist_id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log($conn->error);
        sendError('Failed to load service checklists.', 500);
    }

    $types = str_repeat('i', count($ids));
    $stmt->bind_param($types, ...$ids);
    $stmt->execute();
    $result = $stmt->get_result();

    $grouped = [];
    while ($row = $result->fetch_assoc()) {
        $serviceId = intval($row['service_id'] ?? 0);
        if ($serviceId <= 0) {
            continue;
        }
        if (!isset($grouped[$serviceId])) {
            $grouped[$serviceId] = [];
        }
        $grouped[$serviceId][] = decodeChecklistRow($row);
    }
    $stmt->close();

    foreach ($services as &$row) {
        $serviceId = intval($row['service_id'] ?? 0);
        $row['checklists'] = $grouped[$serviceId] ?? [];
    }
    unset($row);

    return $services;
}

function handleGet($conn) {
    $service_id = $_GET['id'] ?? null;
    $with_checklists = isset($_GET['checklists']) ? true : false;
    $include_archived_checklists = isset($_GET['with_archived_checklists']) ? true : false;

    if ($service_id) {
        // Get single service
        $sql = "SELECT * FROM services WHERE service_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $service_id);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($service = $result->fetch_assoc()) {
            if ($with_checklists) {
                $withChecklists = attachChecklistsToServices($conn, [$service], $include_archived_checklists);
                $service = $withChecklists[0] ?? $service;
            }
            sendResponse(true, decodeServiceRow($service), 'Service retrieved successfully');
        } else {
            sendError('Service not found', 404);
        }
    } else {
        // List all services
        $sql = "SELECT * FROM services ORDER BY service_name";
        $result = $conn->query($sql);
        
        $services = [];
        while ($row = $result->fetch_assoc()) {
            $services[] = decodeServiceRow($row);
        }
        if ($with_checklists) {
            $services = attachChecklistsToServices($conn, $services, $include_archived_checklists);
        }
        sendResponse(true, $services, 'Services retrieved successfully');
    }
}

function handlePost($conn) {
    if (($_GET['action'] ?? '') === 'certificate_template') {
        handleCertificateTemplateUpload($conn);
    }

    $data = getJSONInput();
    $type = $_GET['type'] ?? 'service'; // 'service' or 'checklist'

    if ($type === 'service') {
        $required = ['service_name'];
        if ($missing = validateRequiredFields($data, $required)) {
            sendError('Missing fields: ' . implode(', ', $missing), 400);
        }
        
        $service_name = normalizeTextInput($data['service_name'] ?? '');
        $description = normalizeTextInput($data['description'] ?? '');
        assertUniqueServiceName($conn, $service_name);

        $sql = "INSERT INTO services (service_name, description) VALUES (?, ?)";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('ss', $service_name, $description);
        
        if ($stmt->execute()) {
            sendResponse(true, ['service_id' => $conn->insert_id], 'Service created', 201);
        } else {
            if ($stmt->errno === 1062) sendError('Service name already exists.', 409);
            error_log($conn->error);
            sendError('Failed to create service.', 500);
        }
    } elseif ($type === 'checklist') {
        $required = ['service_id', 'task_name'];
        if ($missing = validateRequiredFields($data, $required)) {
            sendError('Missing fields: ' . implode(', ', $missing), 400);
        }

        $service_id = intval($data['service_id']);
        $task_name = normalizeTextInput($data['task_name'] ?? '');
        $description = normalizeTextInput($data['description'] ?? '');
        $is_required = isset($data['is_required']) ? ($data['is_required'] ? 1 : 0) : 1;
        assertUniqueChecklistTaskName($conn, $service_id, $task_name);

        $sql = "INSERT INTO service_checklists (service_id, task_name, description, is_required, is_deleted, deleted_at) VALUES (?, ?, ?, ?, 0, NULL)";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('issi', $service_id, $task_name, $description, $is_required);

        if ($stmt->execute()) {
            sendResponse(true, ['checklist_id' => $conn->insert_id], 'Checklist item added', 201);
        } else {
            if ($stmt->errno === 1062) sendError('Checklist task name already exists for this service.', 409);
            error_log($conn->error);
            sendError('Failed to add checklist item.', 500);
        }
    }
}

function handlePut($conn) {
    $data = getJSONInput();
    $type = $_GET['type'] ?? 'service';
    $id = intval($_GET['id'] ?? 0);

    if (!$id) sendError('ID required', 400);

    if ($type === 'service') {
        $name = normalizeTextInput($data['service_name'] ?? '');
        $desc = normalizeTextInput($data['description'] ?? '');
        
        if (!$name) sendError('Name required', 400);
        assertUniqueServiceName($conn, $name, $id);

        $sql = "UPDATE services SET service_name = ?, description = ? WHERE service_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('ssi', $name, $desc, $id);
        
        if ($stmt->execute()) {
            sendResponse(true, null, 'Service updated');
        } else {
            if ($stmt->errno === 1062) sendError('Service name already exists.', 409);
            error_log($conn->error);
            sendError('Update failed.', 500);
        }
    } elseif ($type === 'checklist') {
        $checklist = getChecklist($conn, $id);
        if (!$checklist) {
            sendError('Checklist item not found', 404);
        }

        $is_restore = isset($data['restore']) && (bool)$data['restore'];
        if ($is_restore) {
            assertUniqueChecklistTaskName($conn, intval($checklist['service_id'] ?? 0), (string)($checklist['task_name'] ?? ''), $id);

            if ((int)($checklist['is_deleted'] ?? 0) === 0) {
                sendResponse(true, null, 'Checklist item is already active');
            }

            $sql = "UPDATE service_checklists SET is_deleted = 0, deleted_at = NULL WHERE checklist_id = ? AND is_deleted = 1";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $id);

            if ($stmt->execute()) {
                sendResponse(true, null, 'Checklist item restored');
            } else {
                error_log($conn->error);
                sendError('Restore failed.', 500);
            }
        }

        if ((int)($checklist['is_deleted'] ?? 0) === 1) {
            sendError('Checklist item is archived. Restore it before editing.', 409);
        }

        $task_name = normalizeTextInput($data['task_name'] ?? '');
        $desc = normalizeTextInput($data['description'] ?? '');
        $is_required = isset($data['is_required']) ? ($data['is_required'] ? 1 : 0) : 1;
        
        if (!$task_name) sendError('Task name required', 400);
        assertUniqueChecklistTaskName($conn, intval($checklist['service_id'] ?? 0), $task_name, $id);

        $sql = "UPDATE service_checklists SET task_name = ?, description = ?, is_required = ? WHERE checklist_id = ? AND is_deleted = 0";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('ssii', $task_name, $desc, $is_required, $id);

        if ($stmt->execute()) {
            sendResponse(true, null, 'Checklist item updated');
        } else {
            if ($stmt->errno === 1062) sendError('Checklist task name already exists for this service.', 409);
            error_log($conn->error);
            sendError('Update failed.', 500);
        }
    }
}

function handleDelete($conn) {
    if (($_GET['action'] ?? '') === 'certificate_template') {
        handleCertificateTemplateDelete($conn);
    }

    $type = $_GET['type'] ?? 'service';
    $id = intval($_GET['id'] ?? 0);
    
    if (!$id) sendError('ID required', 400);

    if ($type === 'service') {
        if (!serviceExists($conn, $id)) {
            sendError('Service not found', 404);
        }

        if (isServiceInUse($conn, $id)) {
            sendError('Cannot delete this service because it is currently used by active clients or ongoing projects.', 409);
        }

        $sql = "DELETE FROM services WHERE service_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $id);

        if ($stmt->execute()) {
            sendResponse(true, null, 'Service deleted');
        } else {
            error_log($conn->error);
            sendError('Deletion failed.', 500);
        }
    } else {
        $checklist = getChecklist($conn, $id);
        if (!$checklist) {
            sendError('Checklist item not found', 404);
        }
        if ((int)($checklist['is_deleted'] ?? 0) === 1) {
            sendResponse(true, null, 'Checklist item already archived');
        }

        $checklist_in_use = isChecklistInUse($conn, $checklist);
        if ($checklist_in_use['in_use']) {
            sendError($checklist_in_use['message'], 409);
        }

        $sql = "UPDATE service_checklists SET is_deleted = 1, deleted_at = NOW() WHERE checklist_id = ? AND is_deleted = 0";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $id);

        if ($stmt->execute()) {
            sendResponse(true, null, 'Checklist item archived');
        } else {
            error_log($conn->error);
            sendError('Deletion failed.', 500);
        }
    }
}

function ensureServicesSchema($conn) {
    ensureColumn($conn, 'service_checklists', 'is_deleted', '`is_deleted` TINYINT(1) NOT NULL DEFAULT 0');
    ensureColumn($conn, 'service_checklists', 'deleted_at', '`deleted_at` DATETIME NULL');
    ensureColumn($conn, 'services', 'certificate_template_path', '`certificate_template_path` VARCHAR(255) NULL');
    ensureColumn($conn, 'services', 'certificate_template_name', '`certificate_template_name` VARCHAR(255) NULL');
    ensureColumn($conn, 'services', 'certificate_template_mime', '`certificate_template_mime` VARCHAR(120) NULL');
    ensureColumn($conn, 'services', 'certificate_template_size', '`certificate_template_size` INT NULL');
    ensureColumn($conn, 'services', 'certificate_template_updated_at', '`certificate_template_updated_at` DATETIME NULL');
}

function ensureColumn($conn, $table, $column, $definition) {
    $dbName = DB_NAME;
    $sql = "SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return;
    $stmt->bind_param('sss', $dbName, $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if (!$exists) {
        $conn->query("ALTER TABLE `$table` ADD COLUMN $definition");
    }
}

function columnExists($conn, $table, $column) {
    $dbName = DB_NAME;
    $sql = "SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return false;
    $stmt->bind_param('sss', $dbName, $table, $column);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function serviceExists($conn, $service_id) {
    $sql = "SELECT 1 FROM services WHERE service_id = ? LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return false;
    $stmt->bind_param('i', $service_id);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function checklistExists($conn, $checklist_id) {
    $sql = "SELECT 1 FROM service_checklists WHERE checklist_id = ? AND is_deleted = 0 LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return false;
    $stmt->bind_param('i', $checklist_id);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function getChecklist($conn, $checklist_id) {
    $sql = "SELECT checklist_id, service_id, task_name, description, is_deleted
            FROM service_checklists WHERE checklist_id = ? LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $stmt->bind_param('i', $checklist_id);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result ? $result->fetch_assoc() : null;
    $stmt->close();
    return $row ?: null;
}

function isServiceInUse($conn, $service_id) {
    // Active client assignments using this service.
    $sqlClients = "SELECT COUNT(*) AS cnt
                   FROM client_services
                   WHERE service_id = ? AND status = 'active'";
    $stmtClients = $conn->prepare($sqlClients);
    if ($stmtClients) {
        $stmtClients->bind_param('i', $service_id);
        $stmtClients->execute();
        $res = $stmtClients->get_result();
        $count = (int)(($res ? $res->fetch_assoc() : [])['cnt'] ?? 0);
        $stmtClients->close();
        if ($count > 0) return true;
    }

    // Ongoing projects via active client-service assignments.
    $sqlProjectsByClient = "SELECT COUNT(*) AS cnt
                            FROM projects p
                            INNER JOIN client_services cs ON cs.client_id = p.client_id AND cs.service_id = ?
                            WHERE cs.status = 'active'
                              AND p.status IN ('active', 'on_hold')";
    $stmtProjectsByClient = $conn->prepare($sqlProjectsByClient);
    if ($stmtProjectsByClient) {
        $stmtProjectsByClient->bind_param('i', $service_id);
        $stmtProjectsByClient->execute();
        $res = $stmtProjectsByClient->get_result();
        $count = (int)(($res ? $res->fetch_assoc() : [])['cnt'] ?? 0);
        $stmtProjectsByClient->close();
        if ($count > 0) return true;
    }

    // Ongoing tasks linked directly to service_id when available.
    if (columnExists($conn, 'tasks', 'service_id')) {
        $sqlTasks = "SELECT COUNT(*) AS cnt
                     FROM tasks t
                     INNER JOIN projects p ON p.id = t.project_id
                     WHERE t.service_id = ?
                       AND p.status IN ('active', 'on_hold')";
        $stmtTasks = $conn->prepare($sqlTasks);
        if ($stmtTasks) {
            $stmtTasks->bind_param('i', $service_id);
            $stmtTasks->execute();
            $res = $stmtTasks->get_result();
            $count = (int)(($res ? $res->fetch_assoc() : [])['cnt'] ?? 0);
            $stmtTasks->close();
            if ($count > 0) return true;
        }
    }

    return false;
}

function isChecklistInUse($conn, $checklist) {
    $checklist_id = (int)$checklist['checklist_id'];
    $task_name = (string)($checklist['task_name'] ?? '');

    // Preferred check: explicit checklist linkage in tasks table.
    if (columnExists($conn, 'tasks', 'checklist_id')) {
        $sql = "SELECT COUNT(*) AS cnt
                FROM tasks t
                INNER JOIN projects p ON p.id = t.project_id
                WHERE t.checklist_id = ?
                  AND p.status IN ('active', 'on_hold')";
        $stmt = $conn->prepare($sql);
        if ($stmt) {
            $stmt->bind_param('i', $checklist_id);
            $stmt->execute();
            $res = $stmt->get_result();
            $count = (int)(($res ? $res->fetch_assoc() : [])['cnt'] ?? 0);
            $stmt->close();
            if ($count > 0) {
                return [
                    'in_use' => true,
                    'message' => 'Cannot delete this checklist because it is currently used in ongoing projects.'
                ];
            }
        }
    }

    // Backward-compatible fallback when checklist_id is not stored on tasks.
    $sqlFallback = "SELECT COUNT(*) AS cnt
                    FROM tasks t
                    INNER JOIN projects p ON p.id = t.project_id
                    WHERE LOWER(TRIM(t.title)) = LOWER(TRIM(?))
                      AND p.status IN ('active', 'on_hold')";
    $stmtFallback = $conn->prepare($sqlFallback);
    if ($stmtFallback) {
        $stmtFallback->bind_param('s', $task_name);
        $stmtFallback->execute();
        $res = $stmtFallback->get_result();
        $count = (int)(($res ? $res->fetch_assoc() : [])['cnt'] ?? 0);
        $stmtFallback->close();
        if ($count > 0) {
            return [
                'in_use' => true,
                'message' => 'Cannot delete this checklist because a matching task is already used in ongoing projects.'
            ];
        }
    }

    return ['in_use' => false, 'message' => ''];
}

closeDBConnection($conn);
?>
