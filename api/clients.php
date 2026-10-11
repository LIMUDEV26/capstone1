<?php
/**
 * Clients API
 * Handles CRUD operations for clients
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'mailer.php';
require_once 'renewal_utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
runRuntimeSchemaUpgradeOnce('clients_schema_v20260715_checklist_selection', function () use ($conn) {
    ensureClientServiceRenewalSchema($conn);
    ensureTableColumn(
        $conn,
        'client_services',
        'selected_checklist_ids',
        "ALTER TABLE client_services ADD COLUMN selected_checklist_ids TEXT NULL AFTER change_notes"
    );
    ensureTableColumn(
        $conn,
        'client',
        'company_email',
        "ALTER TABLE client ADD COLUMN company_email VARCHAR(100) NULL AFTER contact_person"
    );
    ensureTableColumn(
        $conn,
        'client',
        'company_phone',
        "ALTER TABLE client ADD COLUMN company_phone VARCHAR(20) NULL AFTER company_email"
    );
    ensureTableColumn(
        $conn,
        'client',
        'additional_contacts',
        "ALTER TABLE client ADD COLUMN additional_contacts TEXT NULL AFTER phone"
    );
    ensureTableIndex(
        $conn,
        'client',
        'idx_client_email',
        "ALTER TABLE client ADD INDEX idx_client_email (email)"
    );
    ensureTableIndex(
        $conn,
        'client',
        'idx_client_company_email',
        "ALTER TABLE client ADD INDEX idx_client_company_email (company_email)"
    );
    ensureTableIndex(
        $conn,
        'client',
        'idx_client_contact_person',
        "ALTER TABLE client ADD INDEX idx_client_contact_person (contact_person)"
    );
}, 86400);

runRuntimeSchemaUpgradeOnce('projects_status_pending_v1', function () use ($conn) {
    // autoCreatePendingProject() inserts projects with status='pending', but
    // older databases only allow ('active','completed','archived','on_hold').
    // Without this, the project INSERT fails and the client ends up with no
    // project (previously a silent failure).
    if (!$conn || !isDbConnection($conn) || isPostgresConnection($conn)) return;
    try {
        $dbName = DB_NAME;
        $checkStmt = $conn->prepare(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'status' LIMIT 1"
        );
        if (!$checkStmt) return;
        $checkStmt->bind_param('s', $dbName);
        $checkStmt->execute();
        $row = $checkStmt->get_result()->fetch_assoc();
        $checkStmt->close();
        $columnType = strtolower((string)($row['COLUMN_TYPE'] ?? ''));
        if ($columnType === '' || strpos($columnType, "'pending'") !== false) return;
        if (strpos($columnType, 'enum(') !== 0) return;
        if (!$conn->query("ALTER TABLE projects MODIFY COLUMN status ENUM('active','completed','archived','on_hold','pending') DEFAULT 'active'")) {
            error_log('projects_status_pending_v1: ' . $conn->error);
        }
    } catch (Throwable $e) {
        error_log('projects_status_pending_v1: ' . $e->getMessage());
    }
}, 86400);

runRuntimeSchemaUpgradeOnce('clients_tasks_archive_flag_v1', function () use ($conn) {
    // Tracks whether a task was cancelled by a client archive operation so
    // restoreClientRelations only restores those tasks, not unrelated cancellations.
    ensureTableColumn(
        $conn,
        'tasks',
        'cancelled_by_client_archive',
        "ALTER TABLE tasks ADD COLUMN cancelled_by_client_archive TINYINT(1) NOT NULL DEFAULT 0"
    );
}, 86400);

runRuntimeSchemaUpgradeOnce('clients_contracts_schema_v20260722_fix1', function () use ($conn) {
    $conn->query("CREATE TABLE IF NOT EXISTS contracts (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        client_id          INT NOT NULL,
        title              VARCHAR(255) NOT NULL,
        body               MEDIUMTEXT NOT NULL,
        status             ENUM('pending','accepted','rejected','expired') NOT NULL DEFAULT 'pending',
        token              VARCHAR(80) NOT NULL UNIQUE,
        token_expires_at   DATETIME NOT NULL,
        sent_at            DATETIME NULL,
        responded_at       DATETIME NULL,
        admin_notified_at  DATETIME NULL,
        created_by         INT NULL,
        created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_contracts_client (client_id),
        INDEX idx_contracts_token  (token),
        INDEX idx_contracts_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}, 86400);

switch ($method) {
    case 'GET':
        // Managers with 'projects' access also need to read clients (for project-client dropdown)
        requireAnyFeatureAccess(['clients', 'projects'], ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        // Allow managers who have either 'clients' OR 'projects' access to create a client
        requireAnyFeatureAccess(['clients', 'projects'], ['admin', 'manager'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('clients', ['admin', 'manager'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('clients', ['admin', 'manager'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function getClientProjectIds($conn, $client_id) {
    $project_ids = [];

    $proj_sql = "SELECT id FROM projects WHERE client_id = ?";
    $proj_stmt = $conn->prepare($proj_sql);
    if (!$proj_stmt) {
        return $project_ids;
    }

    $proj_stmt->bind_param('i', $client_id);
    $proj_stmt->execute();
    $proj_result = $proj_stmt->get_result();
    while ($row = $proj_result->fetch_assoc()) {
        $project_ids[] = intval($row['id']);
    }
    $proj_stmt->close();

    return $project_ids;
}

function dissolveClientRelations($conn, $client_id, $project_ids = null) {
    $client_id = intval($client_id);
    if ($client_id <= 0) return;

    if (!is_array($project_ids)) {
        $project_ids = getClientProjectIds($conn, $client_id);
    }

    // Dissolve all projects for this client.
    $stmt = $conn->prepare("UPDATE projects SET status = 'archived' WHERE client_id = ? AND status != 'archived'");
    if ($stmt) {
        $stmt->bind_param('i', $client_id);
        $stmt->execute();
        $stmt->close();
    }

    // Dissolve active tasks only, and stamp them so restore knows which ones
    // were cancelled by this archive operation (not by a prior manual cancel).
    if (!empty($project_ids)) {
        $ids_str = implode(',', array_map('intval', $project_ids));
        $conn->query("UPDATE tasks SET status = 'cancelled', cancelled_by_client_archive = 1
                      WHERE project_id IN ($ids_str)
                        AND status IN ('pending', 'in_progress')
                        AND COALESCE(cancelled_by_client_archive, 0) = 0");
    }

    // Deactivate service assignments.
    $stmt = $conn->prepare("UPDATE client_services SET status = 'inactive' WHERE client_id = ?");
    if ($stmt) {
        $stmt->bind_param('i', $client_id);
        $stmt->execute();
        $stmt->close();
    }
}

function restoreClientRelations($conn, $client_id, $project_ids = null) {
    $client_id = intval($client_id);
    if ($client_id <= 0) return;

    if (!is_array($project_ids)) {
        $project_ids = getClientProjectIds($conn, $client_id);
    }

    // Restore previously dissolved projects.
    $stmt = $conn->prepare("UPDATE projects SET status = 'active' WHERE client_id = ? AND status = 'archived'");
    if ($stmt) {
        $stmt->bind_param('i', $client_id);
        $stmt->execute();
        $stmt->close();
    }

    // Only restore tasks that were explicitly cancelled by the archive operation
    // (flagged by dissolveClientRelations), not pre-existing cancelled tasks.
    if (!empty($project_ids)) {
        $ids_str = implode(',', array_map('intval', $project_ids));
        $conn->query("UPDATE tasks SET status = 'pending', cancelled_by_client_archive = 0
                      WHERE project_id IN ($ids_str)
                        AND status = 'cancelled'
                        AND COALESCE(cancelled_by_client_archive, 0) = 1");
    }

    // Reactivate service assignments.
    $stmt = $conn->prepare("UPDATE client_services SET status = 'active' WHERE client_id = ?");
    if ($stmt) {
        $stmt->bind_param('i', $client_id);
        $stmt->execute();
        $stmt->close();
    }
}

function filterActiveServiceIds($conn, $service_ids) {
    if (!is_array($service_ids) || empty($service_ids)) {
        return [];
    }

    $ids = [];
    foreach ($service_ids as $sid) {
        $value = intval($sid);
        if ($value > 0) {
            $ids[$value] = true;
        }
    }
    $ids = array_keys($ids);

    if (empty($ids)) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $types = str_repeat('i', count($ids));
    $sql = "SELECT service_id
            FROM services
            WHERE service_id IN ($placeholders)
              AND (
                    description IS NULL
                    OR TRIM(UPPER(description)) NOT LIKE '[ARCHIVED]%'
                  )";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return [];
    }

    $stmt->bind_param($types, ...$ids);
    $stmt->execute();
    $result = $stmt->get_result();

    $filtered = [];
    while ($row = $result->fetch_assoc()) {
        $filtered[] = intval($row['service_id']);
    }
    $stmt->close();

    return array_values(array_unique($filtered));
}

function buildContactPersonName($data) {
    $first_name = normalizeClientText($data['contact_first_name'] ?? '');
    $last_name = normalizeClientText($data['contact_last_name'] ?? '');
    $combined = trim($first_name . ' ' . $last_name);

    if ($combined !== '') {
        return $combined;
    }

    return normalizeClientText($data['contact_person'] ?? '');
}

function normalizeClientAdditionalContactEntry($entry, $label) {
    $source = is_array($entry) ? $entry : [];
    $email = normalizeClientEmail($source['email'] ?? '');
    if ($email !== '' && !validateEmail($email)) {
        sendError($label . ' email must be a valid email address.', 400);
    }

    $phoneRaw = trim((string)($source['phone'] ?? $source['contact_number'] ?? $source['contactNumber'] ?? ''));
    $phone = normalizeInternationalPhoneNumber($phoneRaw, '+63');
    if ($phone === false) {
        sendError($label . ' phone number must be a valid international number with a country code, like +639123456789.', 400);
    }

    return [
        'first_name' => normalizeClientText($source['first_name'] ?? $source['firstName'] ?? ''),
        'last_name' => normalizeClientText($source['last_name'] ?? $source['lastName'] ?? ''),
        'email' => $email,
        'phone' => $phone ?? '',
    ];
}

function normalizeClientAdditionalContacts($value) {
    if (!isset($value)) return '';

    $decoded = $value;
    if (is_string($value)) {
        $raw = trim($value);
        if ($raw === '') return '';

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            sendError('Additional contacts must be valid JSON.', 400);
        }
    }

    if (!is_array($decoded)) {
        sendError('Additional contacts must be an array.', 400);
    }

    if (isset($decoded['additional_contacts']) && is_array($decoded['additional_contacts'])) {
        $decoded = $decoded['additional_contacts'];
    } elseif (isset($decoded['additional']) && is_array($decoded['additional'])) {
        $decoded = $decoded['additional'];
    } elseif (isset($decoded['contacts']) && is_array($decoded['contacts'])) {
        $decoded = $decoded['contacts'];
    }

    $contacts = [];
    foreach ($decoded as $index => $entry) {
        $normalizedEntry = normalizeClientAdditionalContactEntry($entry, 'Additional contact #' . ($index + 1));
        if (
            $normalizedEntry['first_name'] === ''
            && $normalizedEntry['last_name'] === ''
            && $normalizedEntry['email'] === ''
            && $normalizedEntry['phone'] === ''
        ) {
            continue;
        }

        $contacts[] = $normalizedEntry;
    }

    if (empty($contacts)) return '';

    $seen = [];
    foreach ($contacts as $contact) {
        $key = strtolower(trim($contact['first_name'] . ' ' . $contact['last_name'])) . '|' . strtolower($contact['email']) . '|' . strtolower($contact['phone']);
        if ($key === '||') continue;
        if (isset($seen[$key])) {
            sendError('Duplicate additional client contact entries are not allowed.', 409);
        }
        $seen[$key] = true;
    }

    return json_encode($contacts, JSON_UNESCAPED_UNICODE);
}

function normalizeClientText($value) {
    $sanitized = sanitizeInput((string)$value);
    return trim(html_entity_decode((string)$sanitized, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function normalizeClientEmail($value) {
    return strtolower(normalizeClientText($value));
}

function decodeClientRowText($row) {
    if (!is_array($row)) return $row;

    foreach (['client_name', 'contact_person', 'company_email', 'company_phone', 'email', 'phone', 'additional_contacts', 'address'] as $field) {
        if (isset($row[$field]) && is_string($row[$field])) {
            $row[$field] = html_entity_decode($row[$field], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
    }

    return $row;
}

function getClientServiceAssignments($conn, $client_id) {
    $client_id = intval($client_id);
    if ($client_id <= 0) return [];

    $sql = "SELECT
                cs.client_id,
                cs.id AS client_service_id,
                s.service_id,
                s.service_name,
                cs.assigned_date,
                cs.status AS service_assignment_status,
                cs.renewal_required,
                cs.expiry_date,
                cs.last_renewed_at,
                cs.reminder_days_before,
                cs.renewal_cycle,
                cs.auto_renew_enabled,
                cs.renewal_notes,
                cs.change_notes,
                cs.selected_checklist_ids
            FROM client_services cs
            INNER JOIN services s ON s.service_id = cs.service_id
            WHERE cs.client_id = ?
              AND cs.status = 'active'
              AND (
                    s.description IS NULL
                    OR TRIM(UPPER(s.description)) NOT LIKE '[ARCHIVED]%'
                  )
            ORDER BY LOWER(TRIM(COALESCE(s.service_name, ''))) ASC,
                     s.service_id ASC";
    $stmt = $conn->prepare($sql);
    if (!$stmt) return [];

    $stmt->bind_param('i', $client_id);
    $stmt->execute();
    $result = $stmt->get_result();

    $services = [];
    while ($serviceRow = $result->fetch_assoc()) {
        $services[] = buildClientServiceRenewalSnapshot($serviceRow);
    }
    $stmt->close();

    return $services;
}

function assertUniqueClientName($conn, $clientName, $excludeClientId = null) {
    $name = trim((string)$clientName);
    if ($name === '') return;

    if ($excludeClientId !== null && intval($excludeClientId) > 0) {
        $id = intval($excludeClientId);
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(client_name)) = LOWER(TRIM(?))
               AND client_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client name.', 500);
        $stmt->bind_param('si', $name, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(client_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client name.', 500);
        $stmt->bind_param('s', $name);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Client name already exists.', 409);
    }
}

function assertUniqueClientEmail($conn, $email, $excludeClientId = null) {
    $value = trim((string)$email);
    if ($value === '') return;

    if ($excludeClientId !== null && intval($excludeClientId) > 0) {
        $id = intval($excludeClientId);
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
               AND client_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client email.', 500);
        $stmt->bind_param('si', $value, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client email.', 500);
        $stmt->bind_param('s', $value);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Client email already exists.', 409);
    }
}

function assertUniqueClientContactPerson($conn, $contactPerson, $excludeClientId = null) {
    $value = trim((string)$contactPerson);
    if ($value === '') return;

    if ($excludeClientId !== null && intval($excludeClientId) > 0) {
        $id = intval($excludeClientId);
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(contact_person)) = LOWER(TRIM(?))
               AND client_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client contact person.', 500);
        $stmt->bind_param('si', $value, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT client_id
             FROM client
             WHERE LOWER(TRIM(contact_person)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate client contact person.', 500);
        $stmt->bind_param('s', $value);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Contact person already exists.', 409);
    }
}

/**
 * GET - Retrieve clients
 */
function handleGet($conn) {
    $client_id = $_GET['id'] ?? null;

    // Check once whether the contracts table exists so queries stay safe even
    // if the schema migration hasn't run yet (e.g. fresh DB restore).
    try {
        $contractsTableExists = ($conn->query("SELECT 1 FROM contracts LIMIT 1") !== false);
    } catch (Throwable $e) {
        $contractsTableExists = false;
    }

    if ($client_id) {
        // Get single client with related data
        if ($contractsTableExists) {
            $contractJoin = "LEFT JOIN contracts latest_contract
                       ON latest_contract.id = (
                           SELECT co.id
                           FROM contracts co
                           WHERE co.client_id = c.client_id
                           ORDER BY co.created_at DESC, co.id DESC
                           LIMIT 1
                       )";
            $contractCols = "latest_contract.id AS latest_contract_id,
                       latest_contract.status AS latest_contract_status,
                       latest_contract.responded_at AS latest_contract_responded_at,";
        } else {
            $contractJoin = '';
            $contractCols = "NULL AS latest_contract_id,
                       NULL AS latest_contract_status,
                       NULL AS latest_contract_responded_at,";
        }
        $sql = "SELECT c.*,
                       (SELECT COUNT(*) FROM projects WHERE client_id = c.client_id) as project_count,
                       $contractCols
                       0 as invoice_count,
                       0.00 as total_paid,
                       0.00 as total_outstanding
                FROM client c
                $contractJoin
                WHERE c.client_id = ?";
        
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $client_id);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($row = $result->fetch_assoc()) {
            $row = decodeClientRowText($row);
            // Keep the single-client response consistent with the list response.
            $row['services'] = getClientServiceAssignments($conn, $row['client_id'] ?? $client_id);
            sendResponse(true, $row, 'Client retrieved successfully');
        } else {
            sendError('Client not found', 404);
        }
    } else {
        // Get all clients
        $status = $_GET['status'] ?? null;
        $search = $_GET['search'] ?? null;

        if ($contractsTableExists) {
            $contractJoin = "LEFT JOIN contracts latest_contract
                       ON latest_contract.id = (
                           SELECT co.id
                           FROM contracts co
                           WHERE co.client_id = c.client_id
                           ORDER BY co.created_at DESC, co.id DESC
                           LIMIT 1
                       )";
            $contractCols = "latest_contract.id AS latest_contract_id,
                       latest_contract.status AS latest_contract_status,
                       latest_contract.responded_at AS latest_contract_responded_at";
        } else {
            $contractJoin = '';
            $contractCols = "NULL AS latest_contract_id,
                       NULL AS latest_contract_status,
                       NULL AS latest_contract_responded_at";
        }

        $sql = "SELECT c.*,
                       COALESCE(project_counts.project_count, 0) AS project_count,
                       $contractCols
                FROM client c
                LEFT JOIN (
                    SELECT client_id, COUNT(*) AS project_count
                    FROM projects
                    GROUP BY client_id
                ) project_counts ON project_counts.client_id = c.client_id
                $contractJoin
                WHERE 1=1";
        
        $params = [];
        $types = '';
        
        if ($status) {
            $sql .= " AND c.status = ?";
            $params[] = $status;
            $types .= 's';
        }
        
        if ($search) {
            $sql .= " AND (c.client_name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ? OR c.company_email LIKE ? OR c.phone LIKE ? OR c.company_phone LIKE ? OR c.additional_contacts LIKE ?)";
            // Escape LIKE metacharacters so a search for "50%" matches the literal
            // string rather than treating % as a wildcard.
            $safe_search = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
            $search_param = '%' . $safe_search . '%';
            $params[] = $search_param;
            $params[] = $search_param;
            $params[] = $search_param;
            $params[] = $search_param;
            $params[] = $search_param;
            $params[] = $search_param;
            $params[] = $search_param;
            $types .= 'sssssss';
        }
        
        $sql .= " ORDER BY LOWER(TRIM(COALESCE(c.client_name, ''))) ASC, c.client_id ASC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
        }
        
        $clients = [];
        $clientIds = [];
        while ($row = $result->fetch_assoc()) {
            $row = decodeClientRowText($row);
            $row['services'] = [];
            $clients[] = $row;
            $clientIds[] = intval($row['client_id']);
        }

        $servicesByClientId = [];
        $clientIds = array_values(array_unique(array_filter($clientIds, function ($id) {
            return intval($id) > 0;
        })));

        if (!empty($clientIds)) {
            $placeholders = implode(',', array_fill(0, count($clientIds), '?'));
            $types = str_repeat('i', count($clientIds));
            $serviceSql = "SELECT
                               cs.client_id,
                               cs.id AS client_service_id,
                               s.service_id,
                               s.service_name,
                               cs.assigned_date,
                               cs.status AS service_assignment_status,
                               cs.renewal_required,
                               cs.expiry_date,
                               cs.last_renewed_at,
                               cs.reminder_days_before,
                               cs.renewal_cycle,
                               cs.auto_renew_enabled,
                               cs.renewal_notes,
                               cs.change_notes,
                               cs.selected_checklist_ids
                           FROM client_services cs
                           INNER JOIN services s ON s.service_id = cs.service_id
                           WHERE cs.client_id IN ($placeholders)
                             AND cs.status = 'active'
                             AND (
                                   s.description IS NULL
                                   OR TRIM(UPPER(s.description)) NOT LIKE '[ARCHIVED]%'
                                 )
                           ORDER BY cs.client_id ASC,
                                    LOWER(TRIM(COALESCE(s.service_name, ''))) ASC,
                                    s.service_id ASC";
            $serviceStmt = $conn->prepare($serviceSql);
            if ($serviceStmt) {
                $serviceStmt->bind_param($types, ...$clientIds);
                $serviceStmt->execute();
                $serviceResult = $serviceStmt->get_result();

                while ($serviceRow = $serviceResult->fetch_assoc()) {
                    $clientId = intval($serviceRow['client_id'] ?? 0);
                    if ($clientId <= 0) continue;
                    if (!isset($servicesByClientId[$clientId])) {
                        $servicesByClientId[$clientId] = [];
                    }
                    $servicesByClientId[$clientId][] = buildClientServiceRenewalSnapshot($serviceRow);
                }

                $serviceStmt->close();
            }
        }

        foreach ($clients as &$clientRow) {
            $clientId = intval($clientRow['client_id'] ?? 0);
            $clientRow['services'] = $servicesByClientId[$clientId] ?? [];
        }
        unset($clientRow);
        
        sendResponse(true, $clients, 'Clients retrieved successfully');
    }
}

/**
 * POST - Create new client
 */
function handlePost($conn) {
    $data = getJSONInput();

    // Validate required fields
    $required = ['client_name'];
    $missing = validateRequiredFields($data, $required);

    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    // Validate emails if provided
    if (isset($data['email']) && !empty($data['email']) && !validateEmail($data['email'])) {
        sendError('Invalid contact person email format', 400);
    }
    if (isset($data['company_email']) && !empty($data['company_email']) && !validateEmail($data['company_email'])) {
        sendError('Invalid company email format', 400);
    }
    
    $client_name = normalizeClientText($data['client_name']);
    $contact_person = buildContactPersonName($data);
    $company_email = normalizeClientEmail($data['company_email'] ?? '');
    $company_phone = normalizeInternationalPhoneNumber($data['company_phone'] ?? '', '+63');
    if ($company_phone === false) {
        sendError('Company phone number must be a valid international number with a country code, like +639123456789.', 400);
    }
    $company_phone = $company_phone ?? '';
    $email = normalizeClientEmail($data['email'] ?? '');
    $phone = normalizeInternationalPhoneNumber($data['phone'] ?? '', '+63');
    if ($phone === false) {
        sendError('Contact person phone number must be a valid international number with a country code, like +639123456789.', 400);
    }
    $phone = $phone ?? '';
    $additional_contacts = normalizeClientAdditionalContacts($data['additional_contacts'] ?? []);
    $address = normalizeClientText($data['address'] ?? '');
    $status = $data['status'] ?? 'active';
    // Always use current server date on client creation.
    $registration_date = date('Y-m-d');

    assertUniqueClientName($conn, $client_name);
    assertUniqueClientEmail($conn, $email);
    assertUniqueClientContactPerson($conn, $contact_person);

    $service_ids = (isset($data['service_ids']) && is_array($data['service_ids'])) ? $data['service_ids'] : [];
    $service_ids = filterActiveServiceIds($conn, $service_ids);
    if (empty($service_ids)) {
        sendError('Please select at least one service.', 400);
    }
    
    // Set needs_project_setup to 1 by default on client creation
    // Will be cleared when project is created or skipped permanently
    $needs_project_setup = 1;

    $sql = "INSERT INTO client (client_name, contact_person, company_email, company_phone, email, phone, additional_contacts, address, status, registration_date, needs_project_setup)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param(
        'ssssssssssi',
        $client_name,
        $contact_person,
        $company_email,
        $company_phone,
        $email,
        $phone,
        $additional_contacts,
        $address,
        $status,
        $registration_date,
        $needs_project_setup
    );
    
    if ($stmt->execute()) {
        $client_id = $conn->insert_id;

        // Handle Services
        if (!empty($service_ids)) {
            $serviceAssignments = mapRenewalAssignmentsByServiceId($data['service_assignments'] ?? []);
            manageClientServices($conn, $client_id, $service_ids, $serviceAssignments);
        }

        // Auto-create a pending project for this client
        $project_id = autoCreatePendingProject($conn, $client_id, $client_name, $service_ids, $data);

        // Log activity
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'create_client', "Created client: $client_name", 'client_management');
        }

        $response_data = [
            'client_id'   => $client_id,
            'project_id'  => $project_id,
            'contract_id' => 0,
        ];
        // Never claim the project was prepared when it was not — the client
        // stays flagged with needs_project_setup=1 in that case.
        $message = $project_id > 0
            ? 'Client created successfully. A pending project has been prepared.'
            : 'Client created successfully, but the pending project could not be prepared. Please create the project from the Projects page.';
        sendResponse(true, $response_data, $message, 201);
    } else {
        error_log($conn->error);
        sendError('Failed to create client.', 500);
    }
}

/**
 * Auto-creates a project with status='pending' for the newly created client.
 * Returns the new project_id (or 0 on failure).
 */
function autoCreatePendingProject($conn, $client_id, $client_name, $service_ids, $data) {
    // Build service list for naming
    $serviceNames = [];
    if (!empty($service_ids)) {
        $placeholders = implode(',', array_fill(0, count($service_ids), '?'));
        $types        = str_repeat('i', count($service_ids));
        $svcStmt = $conn->prepare("SELECT service_name FROM services WHERE service_id IN ($placeholders) ORDER BY service_name ASC");
        if ($svcStmt) {
            $svcStmt->bind_param($types, ...$service_ids);
            $svcStmt->execute();
            $svcResult = $svcStmt->get_result();
            while ($svcRow = $svcResult->fetch_assoc()) {
                $name = trim((string)($svcRow['service_name'] ?? ''));
                if ($name !== '') $serviceNames[] = $name;
            }
            $svcStmt->close();
        }
    }

    $projectName = trim($client_name);
    if (!empty($serviceNames)) {
        $projectName .= ' - ' . implode(' / ', $serviceNames);
    }
    if ($projectName === '') {
        error_log('autoCreatePendingProject: empty project name, skipping.');
        return 0;
    }

    // Ensure uniqueness
    $baseName  = $projectName;
    $suffix    = 0;
    $checkStmt = $conn->prepare("SELECT id FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1");
    if (!$checkStmt) {
        error_log('autoCreatePendingProject name-check prepare failed: ' . $conn->error);
        return 0;
    }
    while (true) {
        $candidate = $suffix === 0 ? $baseName : $baseName . ' (' . $suffix . ')';
        $checkStmt->bind_param('s', $candidate);
        $checkStmt->execute();
        if ($checkStmt->get_result()->num_rows === 0) { $projectName = $candidate; break; }
        $suffix++;
        if ($suffix > 99) break;
    }
    $checkStmt->close();

    $end_date  = date('Y-m-d H:i:s', strtotime('+30 days'));
    $authUid = checkAuthentication();
    $created_by = ($authUid !== false && $authUid !== null && $authUid !== '') ? intval($authUid) : null;
    releaseSessionLock();

    // status = 'pending' so the project is visible but cannot be worked on until started
    $insStmt = $conn->prepare(
        "INSERT INTO projects (name, description, client_id, manager_id, created_by, status, start_date, end_date)
         VALUES (?, '', ?, NULL, ?, 'pending', NULL, ?)"
    );
    if (!$insStmt) {
        error_log('autoCreatePendingProject insert prepare failed: ' . $conn->error);
        return 0;
    }
    $insStmt->bind_param('siis', $projectName, $client_id, $created_by, $end_date);
    $ok = $insStmt->execute();
    if (!$ok) {
        error_log('autoCreatePendingProject insert failed: ' . $insStmt->error);
        $insStmt->close();
        return 0;
    }
    $project_id = intval($conn->insert_id);
    $insStmt->close();

    if ($project_id > 0) {
        // Auto-generate tasks (checklist-based) for the project
        $custom_tasks = null;
        if (isset($data['service_assignments']) && is_array($data['service_assignments'])) {
            $allChecklistIds = [];
            foreach ($data['service_assignments'] as $assignment) {
                if (isset($assignment['selected_checklist_ids']) && is_array($assignment['selected_checklist_ids'])) {
                    foreach ($assignment['selected_checklist_ids'] as $cid) {
                        $cid = intval($cid);
                        if ($cid > 0) $allChecklistIds[] = $cid;
                    }
                }
            }
            if (!empty($allChecklistIds)) {
                $custom_tasks = array_values(array_unique($allChecklistIds));
            }
        }

        // Use projects.php helper if available; otherwise inline a minimal version
        if (function_exists('generateProjectTasks')) {
            generateProjectTasks($conn, $project_id, $client_id, $created_by, $custom_tasks);
        } else {
            $due_date = date('Y-m-d H:i:s', strtotime('+7 days'));
            $creatorId = intval($created_by);
            $safeProjectId = intval($project_id);
            $safeClientId  = intval($client_id);
            if (is_array($custom_tasks) && !empty($custom_tasks)) {
                $ids_str = implode(',', array_map('intval', $custom_tasks));
                $taskInsStmt = $conn->prepare(
                    "INSERT INTO tasks (title, description, project_id, created_by, status, priority, due_date)
                     SELECT sc.task_name, sc.description, ?, NULLIF(?,0), 'pending', 'medium', ?
                     FROM service_checklists sc WHERE sc.checklist_id IN ($ids_str)"
                );
                if ($taskInsStmt) {
                    $taskInsStmt->bind_param('iis', $safeProjectId, $creatorId, $due_date);
                    $taskInsStmt->execute();
                    $taskInsStmt->close();
                }
            } else {
                $taskInsStmt = $conn->prepare(
                    "INSERT INTO tasks (title, description, project_id, created_by, status, priority, due_date)
                     SELECT sc.task_name, sc.description, ?, NULLIF(?,0), 'pending', 'medium', ?
                     FROM service_checklists sc
                     INNER JOIN client_services cs ON cs.service_id = sc.service_id AND cs.client_id = ? AND cs.status = 'active'
                     WHERE sc.is_required = 1"
                );
                if ($taskInsStmt) {
                    $taskInsStmt->bind_param('iisi', $safeProjectId, $creatorId, $due_date, $safeClientId);
                    $taskInsStmt->execute();
                    $taskInsStmt->close();
                }
            }
        }

        // Clear needs_project_setup
        $clearStmt = $conn->prepare("UPDATE client SET needs_project_setup = 0 WHERE client_id = ?");
        if ($clearStmt) {
            $safeClientId = intval($client_id);
            $clearStmt->bind_param('i', $safeClientId);
            $clearStmt->execute();
            $clearStmt->close();
        }
    }

    return $project_id;
}

/**
 * PUT - Update client
 */
function handlePut($conn) {
    $data = getJSONInput();
    
    if (!isset($data['client_id'])) {
        sendError('Client ID is required', 400);
    }
    
    $client_id = intval($data['client_id']);
    
    // Check if client exists
    $check_sql = "SELECT client_id, status, client_name, email, contact_person FROM client WHERE client_id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $client_id);
    $check_stmt->execute();

    $existing_client = $check_stmt->get_result()->fetch_assoc();
    if (!$existing_client) {
        sendError('Client not found', 404);
    }

    $current_status = strtolower((string)($existing_client['status'] ?? ''));
    $contact_name_update_requested = isset($data['contact_first_name']) || isset($data['contact_last_name']) || isset($data['contact_person']);

    if (isset($data['client_name'])) {
        assertUniqueClientName($conn, normalizeClientText($data['client_name']), $client_id);
    }
    if (isset($data['email'])) {
        assertUniqueClientEmail($conn, normalizeClientEmail($data['email']), $client_id);
    }
    if ($contact_name_update_requested) {
        assertUniqueClientContactPerson($conn, buildContactPersonName($data), $client_id);
    }
    
    $updates = [];
    $params = [];
    $types = '';
    
    $allowed_fields = ['client_name', 'company_email', 'company_phone', 'email', 'phone', 'additional_contacts', 'address', 'status', 'needs_project_setup'];
    
    foreach ($allowed_fields as $field) {
        if (isset($data[$field])) {
            $updates[] = "$field = ?";
            if ($field === 'status') {
                if (!in_array($data[$field], ['active', 'inactive'], true)) {
                    sendError('Invalid status value. Allowed values: active, inactive.', 400);
                }
                $params[] = $data[$field];
                $types .= 's';
            } elseif ($field === 'needs_project_setup') {
                $params[] = intval($data[$field]);
                $types .= 'i';
            } elseif ($field === 'phone' || $field === 'company_phone') {
                $normalizedPhone = normalizeInternationalPhoneNumber($data[$field], '+63');
                if ($normalizedPhone === false) {
                    $label = $field === 'company_phone' ? 'Company phone' : 'Contact person phone';
                    sendError($label . ' number must be a valid international number with a country code, like +639123456789.', 400);
                }
                $params[] = $normalizedPhone ?? '';
                $types .= 's';
            } elseif ($field === 'email' || $field === 'company_email') {
                $emailValue = normalizeClientEmail($data[$field]);
                if ($emailValue !== '' && !validateEmail($emailValue)) {
                    $label = $field === 'company_email' ? 'company' : 'contact person';
                    sendError('Invalid ' . $label . ' email format', 400);
                }
                $params[] = $emailValue;
                $types .= 's';
            } elseif ($field === 'additional_contacts') {
                $params[] = normalizeClientAdditionalContacts($data[$field]);
                $types .= 's';
            } else {
                $params[] = normalizeClientText($data[$field]);
                $types .= 's';
            }
        }
    }

    if (isset($data['contact_first_name']) || isset($data['contact_last_name']) || isset($data['contact_person'])) {
        $updates[] = "contact_person = ?";
        $params[] = buildContactPersonName($data);
        $types .= 's';
    }
    
    if (!empty($updates)) {
        $params[] = $client_id;
        $types .= 'i';
        
        $sql = "UPDATE client SET " . implode(', ', $updates) . " WHERE client_id = ?";
        
        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
    }

    // Cascade dissolve/restore when client status changes.
    if (isset($data['status'])) {
        $next_status = strtolower(trim((string)$data['status']));
        if ($next_status === 'inactive' && $current_status !== 'inactive') {
            dissolveClientRelations($conn, $client_id);
        } elseif ($next_status === 'active' && $current_status === 'inactive') {
            restoreClientRelations($conn, $client_id);
        }
    }

    // Handle Services Update
    if (isset($data['service_ids']) && is_array($data['service_ids'])) {
        $service_ids = filterActiveServiceIds($conn, $data['service_ids']);
        if (empty($service_ids)) {
            sendError('Please select at least one service.', 400);
        }
        $serviceAssignments = mapRenewalAssignmentsByServiceId($data['service_assignments'] ?? []);
        manageClientServices($conn, $client_id, $service_ids, $serviceAssignments);
    }

    // Log update
    if ($user_id = checkAuthentication()) {
        releaseSessionLock();
        logActivity($conn, $user_id, 'update_client', "Updated client ID: $client_id", 'client_management');
    }
    
    sendResponse(true, null, 'Client updated successfully');
}

/**
 * DELETE - Delete client (soft delete with cascade, or permanent)
 */
function handleDelete($conn) {
    $client_id = $_GET['id'] ?? null;
    $permanent = isset($_GET['permanent']) && $_GET['permanent'] == '1';
    
    if (!$client_id) {
        sendError('Client ID is required', 400);
    }
    
    $client_id = intval($client_id);

    // Get all project IDs for this client (needed for cascading)
    $project_ids = getClientProjectIds($conn, $client_id);

    if ($permanent) {
        // === PERMANENT DELETE: Hard delete client and all related data ===

        if (!empty($project_ids)) {
            $ids_str = implode(',', array_map('intval', $project_ids));

            // Delete tasks belonging to client's projects
            $conn->query("DELETE FROM tasks WHERE project_id IN ($ids_str)");

            // Delete project messages belonging to client's projects
            $conn->query("DELETE FROM project_messages WHERE project_id IN ($ids_str)");

            // Delete checklist items for tasks in these projects
            // (tasks already deleted above, but checklist_items has ON DELETE CASCADE so this is already handled)
        }

        // Delete projects belonging to this client
        $conn->query("DELETE FROM projects WHERE client_id = $client_id");

        // Delete client services
        $conn->query("DELETE FROM client_services WHERE client_id = $client_id");

        // Delete document_received for this client
        $conn->query("UPDATE document_received SET client_id = NULL WHERE client_id = $client_id");

        // Hard delete the client (client_receivables_fines CASCADE automatically)
        $del_sql = "DELETE FROM client WHERE client_id = ?";
        $del_stmt = $conn->prepare($del_sql);
        $del_stmt->bind_param('i', $client_id);

        if ($del_stmt->execute()) {
            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'permanent_delete_client', "Permanently deleted client ID: $client_id and all related data", 'client_management');
            }
            sendResponse(true, null, 'Client and all related data permanently deleted');
        } else {
            error_log($conn->error);
            sendError('Failed to delete client.', 500);
        }
    } else {
        // === SOFT DELETE (ARCHIVE): Cascade archive to related entities ===

        // 1. Archive the client
        $sql = "UPDATE client SET status = 'inactive' WHERE client_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $client_id);

        if ($stmt->execute()) {
            // 2-4. Cascade dissolve to projects, tasks, and client services.
            dissolveClientRelations($conn, $client_id, $project_ids);

            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'archive_client', "Archived client ID: $client_id and dissolved related projects/tasks", 'client_management');
            }

            sendResponse(true, null, 'Client archived and all related projects/tasks dissolved');
        } else {
            error_log($conn->error);
            sendError('Failed to archive client.', 500);
        }
    }
}

function getServiceNamesByIds($conn, $service_ids) {
    if (!is_array($service_ids) || empty($service_ids)) {
        return [];
    }

    $ids = [];
    foreach ($service_ids as $sid) {
        $value = intval($sid);
        if ($value > 0) {
            $ids[] = $value;
        }
    }
    $ids = array_values(array_unique($ids));
    if (empty($ids)) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $types = str_repeat('i', count($ids));
    $sql = "SELECT service_name FROM services WHERE service_id IN ($placeholders) ORDER BY service_name ASC";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return [];
    }

    $stmt->bind_param($types, ...$ids);
    $stmt->execute();
    $result = $stmt->get_result();

    $names = [];
    while ($row = $result->fetch_assoc()) {
        if (!empty($row['service_name'])) {
            $names[] = $row['service_name'];
        }
    }
    $stmt->close();

    return $names;
}

function sendClientOnboardingEmail($conn, $client_name, $contact_person, $email, $service_ids = []) {
    $to_email = trim((string)$email);
    if ($to_email === '') {
        return [
            'attempted' => false,
            'sent' => false,
            'message' => 'No client email was provided.',
        ];
    }

    if (!validateGmailComEmail($to_email)) {
        return [
            'attempted' => false,
            'sent' => false,
            'message' => 'Welcome email skipped because the client email is not an allowed domain (@gmail.com or @phinmaed.com).',
        ];
    }

    if (!function_exists('sendMail')) {
        error_log('sendClientOnboardingEmail: sendMail function is unavailable.');
        return [
            'attempted' => true,
            'sent' => false,
            'message' => 'Welcome email service is unavailable.',
        ];
    }

    $recipient_name = trim((string)$contact_person) !== '' ? trim((string)$contact_person) : trim((string)$client_name);
    $safe_client_name = htmlspecialchars((string)$client_name, ENT_QUOTES, 'UTF-8');
    $safe_recipient_name = htmlspecialchars((string)($recipient_name ?: $client_name), ENT_QUOTES, 'UTF-8');

    $service_names = getServiceNamesByIds($conn, $service_ids);
    $service_list_html = '<li>Project setup based on your selected requirements</li>';
    $service_list_alt = '- Project setup based on your selected requirements';
    if (!empty($service_names)) {
        $safe_items = array_map(function ($name) {
            return htmlspecialchars((string)$name, ENT_QUOTES, 'UTF-8');
        }, $service_names);
        $service_list_html = '';
        foreach ($safe_items as $service_name) {
            $service_list_html .= '<li>' . $service_name . '</li>';
        }
        $service_list_alt = "- " . implode("\n- ", $service_names);
    }

    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');
    $safe_brand_name = htmlspecialchars($brand_name, ENT_QUOTES, 'UTF-8');

    $subject = 'Welcome to ' . $brand_name . ' - Project Initiation Confirmation';
    $content = '<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;">Dear ' . $safe_recipient_name . ',</p>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Thank you for selecting <strong>' . $safe_brand_name . '</strong>. '
        . 'We are pleased to confirm that we have formally initiated the service engagement for '
        . '<strong>' . $safe_client_name . '</strong>.'
        . '</p>'
        . '<div style="margin:0 0 14px 0;padding:12px 14px;background:#f8fafc;border:1px solid #dbe3ef;border-radius:10px;">'
        . '<p style="margin:0 0 8px 0;font-size:13px;font-weight:700;color:#1f2937;">Selected Service Scope</p>'
        . '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:#334155;">' . $service_list_html . '</ul>'
        . '</div>'
        . '<p style="margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Our team is now preparing the required workflow and will provide updates as milestones are completed.'
        . '</p>'
        . '<p style="margin:0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'We appreciate your trust and look forward to delivering excellent service.'
        . '</p>'
        . '<p style="margin:16px 0 0 0;font-size:14px;line-height:1.8;color:#1f2937;">'
        . 'Sincerely,<br><strong>' . $safe_brand_name . ' Team</strong>'
        . '</p>';

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, 'Your service engagement has been initiated successfully.')
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    $alt = "Dear " . ($recipient_name ?: $client_name) . ",\n\n"
        . "Thank you for selecting " . $brand_name . ".\n"
        . "We are pleased to confirm that we have formally initiated the service engagement for " . $client_name . ".\n\n"
        . "Selected Service Scope:\n"
        . $service_list_alt . "\n\n"
        . "Our team is now preparing the required workflow and will provide updates as milestones are completed.\n\n"
        . "We appreciate your trust and look forward to delivering excellent service.\n\n"
        . "Sincerely,\n"
        . $brand_name . " Team";

    $sent = sendMail($to_email, $recipient_name, $subject, $html, $alt);
    if (!$sent) {
        error_log('sendClientOnboardingEmail: failed for client ' . $client_name . ' <' . $to_email . '>');
    }

    return [
        'attempted' => true,
        'sent' => (bool)$sent,
        'message' => $sent ? 'Welcome email sent.' : 'Failed to send welcome email.',
    ];
}

/**
 * Helper to manage client services
 */
function manageClientServices($conn, $client_id, $service_ids, $serviceAssignments = []) {
    $service_ids = filterActiveServiceIds($conn, $service_ids);

    $serviceAssignments = is_array($serviceAssignments) ? $serviceAssignments : [];
    $existingAssignments = [];
    $existingSql = "SELECT
                        id AS client_service_id,
                        service_id,
                        renewal_required,
                        expiry_date,
                        last_renewed_at,
                        reminder_days_before,
                        renewal_cycle,
                        auto_renew_enabled,
                        renewal_notes,
                        change_notes,
                        selected_checklist_ids
                    FROM client_services
                    WHERE client_id = ?";
    $existingStmt = $conn->prepare($existingSql);
    if ($existingStmt) {
        $existingStmt->bind_param('i', $client_id);
        $existingStmt->execute();
        $existingResult = $existingStmt->get_result();
        while ($row = $existingResult->fetch_assoc()) {
            $existingAssignments[intval($row['service_id'])] = $row;
        }
        $existingStmt->close();
    }

    $keepIds = [];
    $updateSql = "UPDATE client_services
                  SET status = 'active',
                      renewal_required = ?,
                      expiry_date = ?,
                      last_renewed_at = ?,
                      reminder_days_before = ?,
                      renewal_cycle = ?,
                      auto_renew_enabled = ?,
                      renewal_notes = ?,
                      change_notes = ?,
                      selected_checklist_ids = ?
                  WHERE id = ?
                  LIMIT 1";
    $updateStmt = $conn->prepare($updateSql);

    $insertSql = "INSERT INTO client_services (
                        client_id,
                        service_id,
                        renewal_required,
                        expiry_date,
                        last_renewed_at,
                        reminder_days_before,
                        renewal_cycle,
                        auto_renew_enabled,
                        renewal_notes,
                        change_notes,
                        selected_checklist_ids
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    $insertStmt = $conn->prepare($insertSql);

    foreach ($service_ids as $sid) {
        $sid = intval($sid);
        if ($sid <= 0) continue;

        $existing = $existingAssignments[$sid] ?? null;
        $payload = normalizeRenewalSettingsArray($serviceAssignments[$sid] ?? [], $existing);
        $selectedChecklistIds = $payload['selected_checklist_ids'];
        if ($selectedChecklistIds !== null) {
            $selectedChecklistIdsJson = json_encode($selectedChecklistIds, JSON_UNESCAPED_UNICODE);
        } else {
            $selectedChecklistIdsJson = null;
        }

        if ($existing && $updateStmt) {
            $clientServiceId = intval($existing['client_service_id'] ?? 0);
            $updateStmt->bind_param(
                'issisisssi',
                $payload['renewal_required'],
                $payload['expiry_date'],
                $payload['last_renewed_at'],
                $payload['reminder_days_before'],
                $payload['renewal_cycle'],
                $payload['auto_renew_enabled'],
                $payload['renewal_notes'],
                $payload['change_notes'],
                $selectedChecklistIdsJson,
                $clientServiceId
            );
            $updateStmt->execute();
            $keepIds[] = $clientServiceId;
            continue;
        }

        if ($insertStmt) {
            $insertStmt->bind_param(
                'iiissisisss',
                $client_id,
                $sid,
                $payload['renewal_required'],
                $payload['expiry_date'],
                $payload['last_renewed_at'],
                $payload['reminder_days_before'],
                $payload['renewal_cycle'],
                $payload['auto_renew_enabled'],
                $payload['renewal_notes'],
                $payload['change_notes'],
                $selectedChecklistIdsJson
            );
            $insertStmt->execute();
            $keepIds[] = intval($conn->insert_id);
        }
    }

    if ($updateStmt) {
        $updateStmt->close();
    }
    if ($insertStmt) {
        $insertStmt->close();
    }

    $existingIds = [];
    foreach ($existingAssignments as $assignment) {
        $existingIds[] = intval($assignment['client_service_id'] ?? 0);
    }

    $idsToDelete = array_values(array_diff($existingIds, $keepIds));
    if (!empty($idsToDelete)) {
        $placeholders = implode(',', array_fill(0, count($idsToDelete), '?'));
        $types = str_repeat('i', count($idsToDelete));
        $deleteSql = "DELETE FROM client_services WHERE id IN ($placeholders)";
        $deleteStmt = $conn->prepare($deleteSql);
        if ($deleteStmt) {
            $deleteStmt->bind_param($types, ...$idsToDelete);
            $deleteStmt->execute();
            $deleteStmt->close();
        }
    }
}

/**
 * Auto-create and send a contract to the client upon creation.
 * Generates a standard engagement contract with the selected services and sends via the contracts API.
 */
function autoSendContractToClient($conn, $client_id, $client_name, $contact_person, $email, $service_ids) {
    $to_email = trim((string)$email);
    if ($to_email === '' || !filter_var($to_email, FILTER_VALIDATE_EMAIL)) {
        return [
            'sent' => false,
            'message' => 'Client email is missing or invalid.',
        ];
    }

    // Build the contract body with service names
    $service_names = getServiceNamesByIds($conn, $service_ids);
    $service_list = '';
    foreach ($service_names as $index => $name) {
        $service_list .= ($index + 1) . ". " . $name . "\n";
    }
    if ($service_list === '') {
        $service_list = "- Services as agreed upon during consultation\n";
    }

    $branding = function_exists('getEmailBranding')
        ? getEmailBranding()
        : ['brand_name' => 'LLB Accountants'];
    $brand_name = (string)($branding['brand_name'] ?? 'LLB Accountants');
    $today = date('F j, Y');

    $contract_body = "SERVICE ENGAGEMENT AGREEMENT\n"
        . "Date: {$today}\n\n"
        . "This Service Engagement Agreement (\"Agreement\") is entered into between:\n\n"
        . "Service Provider: {$brand_name}\n"
        . "Client: {$client_name}\n\n"
        . "------------------------------------------------------------\n"
        . "1. SCOPE OF SERVICES\n"
        . "------------------------------------------------------------\n\n"
        . "The Service Provider agrees to provide the following services:\n\n"
        . $service_list . "\n"
        . "------------------------------------------------------------\n"
        . "2. TERMS AND CONDITIONS\n"
        . "------------------------------------------------------------\n\n"
        . "a) The Service Provider shall perform the services with due care and professional diligence.\n\n"
        . "b) The Client agrees to provide all necessary documentation and information required for the completion of services in a timely manner.\n\n"
        . "c) Both parties agree to maintain confidentiality of all proprietary and sensitive information exchanged during the engagement.\n\n"
        . "d) Payment terms shall be in accordance with the fee schedule provided separately or as mutually agreed upon.\n\n"
        . "e) Either party may terminate this agreement with 30 days written notice.\n\n"
        . "------------------------------------------------------------\n"
        . "3. DELIVERABLES AND TIMELINE\n"
        . "------------------------------------------------------------\n\n"
        . "Deliverables and timelines will be established upon project initiation and communicated through the project management system.\n\n"
        . "------------------------------------------------------------\n"
        . "4. ACCEPTANCE\n"
        . "------------------------------------------------------------\n\n"
        . "By accepting this contract, the Client acknowledges that they have read, understood, and agree to the terms set forth in this Agreement.\n\n"
        . "This Agreement shall be effective as of the date of acceptance.\n\n"
        . "--------------------\n"
        . "{$brand_name}\n"
        . "Professional Services Team\n";

    $title = "Service Engagement - " . $client_name;
    $token = bin2hex(random_bytes(40));
    $expires_at = date('Y-m-d H:i:s', strtotime('+7 days'));
    $created_by = checkAuthentication() ?: null;
    releaseSessionLock();

    // Ensure contracts table exists (the contracts.php schema migration may not have run yet)
    $conn->query("CREATE TABLE IF NOT EXISTS contracts (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        client_id          INT NOT NULL,
        title              VARCHAR(255) NOT NULL,
        body               MEDIUMTEXT NOT NULL,
        status             ENUM('pending','accepted','rejected','expired') NOT NULL DEFAULT 'pending',
        token              VARCHAR(80) NOT NULL UNIQUE,
        token_expires_at   DATETIME NOT NULL,
        sent_at            DATETIME NULL,
        responded_at       DATETIME NULL,
        admin_notified_at  DATETIME NULL,
        created_by         INT NULL,
        created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_contracts_client (client_id),
        INDEX idx_contracts_token  (token),
        INDEX idx_contracts_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $ins = $conn->prepare(
        "INSERT INTO contracts (client_id, title, body, token, token_expires_at, sent_at, created_by)
         VALUES (?, ?, ?, ?, ?, NOW(), ?)"
    );
    if (!$ins) {
        error_log('autoSendContractToClient: failed to prepare insert: ' . $conn->error);
        return [
            'sent' => false,
            'message' => 'Could not prepare the agreement record.',
        ];
    }
    $ins->bind_param('issssi', $client_id, $title, $contract_body, $token, $expires_at, $created_by);
    if (!$ins->execute()) {
        error_log('autoSendContractToClient: failed to insert contract: ' . $conn->error);
        return [
            'sent' => false,
            'message' => 'Could not save the agreement record.',
        ];
    }
    $contract_id = intval($conn->insert_id);
    $ins->close();

    // Now send the email using the contract email helper from contracts.php
    // We replicate the email logic here to avoid require_once circular dependency
    $recipient = trim((string)$contact_person) !== '' ? trim((string)$contact_person) : trim((string)$client_name);

    $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
    if ($frontendBase === '') {
        $isHttps = !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off';
        $scheme = $isHttps ? 'https' : 'http';
        $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
        $frontendBase = $scheme . '://' . $host . '/capstone1';
    }
    $review_url = rtrim($frontendBase, '/') . '/contract-review?token=' . urlencode($token);
    $safe_url = htmlspecialchars($review_url, ENT_QUOTES, 'UTF-8');
    $safe_name = htmlspecialchars($recipient, ENT_QUOTES, 'UTF-8');
    $safe_title = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $safe_brand = htmlspecialchars($brand_name, ENT_QUOTES, 'UTF-8');

    $content = "
    <p style='margin:0 0 14px 0;font-size:15px;line-height:1.7;'>Dear {$safe_name},</p>
    <p style='margin:0 0 16px 0;font-size:14px;line-height:1.8;color:#1f2937;'>
        <strong>{$safe_brand}</strong> has prepared a service contract for you titled
        <strong>&ldquo;{$safe_title}&rdquo;</strong>.
    </p>
    <p style='margin:0 0 14px 0;font-size:14px;line-height:1.8;color:#374151;'>
        Please carefully read the entire contract document. Once you have reviewed all the terms, you may
        choose to <strong>Accept</strong> or <strong>Cancel</strong> the contract using the buttons provided on the review page.
    </p>
    <div style='margin:0 0 16px 0;padding:12px 14px;background:#f0f9ff;border-radius:6px;'>
        <p style='margin:0;font-size:13px;color:#0c4a6e;'>
            &#9888; This invitation link will expire in <strong>7 day(s)</strong>.
            Please respond before the deadline.
        </p>
    </div>
    <div style='text-align:center;margin:28px 0;'>
        <a href='{$safe_url}'
           style='display:inline-block;background:#1e3a8a;color:#ffffff;font-size:15px;
                  font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;
                  letter-spacing:0.02em;'>
            Review &amp; Respond to Contract
        </a>
    </div>
    <p style='margin:0;font-size:12px;color:#6b7280;text-align:center;'>
        If the button does not work, copy and paste this link into your browser:<br>
        <a href='{$safe_url}' style='color:#1e3a8a;word-break:break-all;'>{$safe_url}</a>
    </p>";

    $html = function_exists('buildBrandedEmailLayout')
        ? buildBrandedEmailLayout($content, "Action required: review your contract from {$safe_brand}")
        : '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;line-height:1.6;">' . $content . '</div>';

    if (!function_exists('sendMail')) {
        return [
            'sent' => false,
            'message' => 'Email service is unavailable.',
        ];
    }

    $sent = sendMail(
        $to_email,
        $recipient,
        "Action Required: Review Your Contract - {$title}",
        $html,
        "Dear {$recipient},\n\nPlease review the contract titled \"{$title}\" by visiting:\n{$review_url}\n\nThis link expires in 7 day(s)."
    );

    if (!$sent && $contract_id > 0) {
        $cleanup = $conn->prepare("DELETE FROM contracts WHERE id = ?");
        if ($cleanup) {
            $cleanup->bind_param('i', $contract_id);
            $cleanup->execute();
            $cleanup->close();
        }
    }

    return [
        'sent' => (bool)$sent,
        'message' => $sent ? 'Agreement email sent.' : 'Email delivery failed. Please check SMTP settings and the client email address.',
    ];
}

closeDBConnection($conn);
?>
