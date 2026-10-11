<?php
/**
 * Projects API
 * Handles CRUD operations for projects
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
runRuntimeSchemaUpgradeOnce('projects_schema_v20260410', function () use ($conn) {
    ensureTaskCollaboratorsTable($conn);
    ensureTableIndex(
        $conn,
        'tasks',
        'idx_project',
        "ALTER TABLE tasks ADD INDEX idx_project (project_id)"
    );
    ensureProjectDateTimeColumns($conn);
}, 86400);

runRuntimeSchemaUpgradeOnce('projects_status_pending_v1', function () use ($conn) {
    // Client auto-creation inserts projects with status='pending', but older
    // databases only allow ('active','completed','archived','on_hold').
    if (!function_exists('isDbConnection') || !isDbConnection($conn)) return;
    if (function_exists('isPostgresConnection') && isPostgresConnection($conn)) return;
    try {
        $dbName = defined('DB_NAME') ? DB_NAME : '';
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

// Backfill service_id on tasks that were created without it.
// Runs once per day; safe to repeat (only updates NULL rows that can be resolved).
runRuntimeSchemaUpgradeOnce('projects_backfill_task_service_id_v1', function () use ($conn) {
    if (!projectsColumnExists($conn, 'tasks', 'service_id')) return;
    // Match tasks to their service via the service_checklist title ↔ task title,
    // scoped to the same project/client so we don't cross-pollinate unrelated tasks.
    $conn->query(
        "UPDATE tasks t
         INNER JOIN projects p ON p.id = t.project_id
         INNER JOIN client_services cs ON cs.client_id = p.client_id AND cs.status = 'active'
         INNER JOIN service_checklists sc
                 ON sc.service_id = cs.service_id
                AND LOWER(TRIM(sc.task_name)) = LOWER(TRIM(t.title))
         SET t.service_id = sc.service_id
         WHERE t.service_id IS NULL"
    );
}, 86400);

switch ($method) {
    case 'GET':
        requireFeatureAccess('projects', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('projects', ['admin', 'manager'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('projects', ['admin', 'manager'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('projects', ['admin', 'manager'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function normalizeProjectName($value) {
    $name = sanitizeInput((string)$value);
    $name = preg_replace('/\s+/', ' ', trim((string)$name));
    return $name;
}

function getClientRecord($conn, $clientId) {
    $id = intval($clientId);
    if ($id <= 0) return null;

    $stmt = $conn->prepare(
        "SELECT client_id, client_name
         FROM client
         WHERE client_id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        sendError('Failed to load client.', 500);
    }

    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ?: null;
}

function getClientActiveServices($conn, $clientId) {
    $id = intval($clientId);
    if ($id <= 0) return [];

    $stmt = $conn->prepare(
        "SELECT s.service_id, s.service_name
         FROM client_services cs
         INNER JOIN services s ON s.service_id = cs.service_id
         WHERE cs.client_id = ?
           AND cs.status = 'active'
         ORDER BY LOWER(TRIM(s.service_name)) ASC, s.service_id ASC"
    );
    if (!$stmt) {
        sendError('Failed to load client services.', 500);
    }

    $stmt->bind_param('i', $id);
    $stmt->execute();
    $result = $stmt->get_result();

    $services = [];
    while ($row = $result->fetch_assoc()) {
        $services[] = $row;
    }
    $stmt->close();

    return $services;
}

function clientHasAcceptedContract($conn, $clientId) {
    $id = intval($clientId);
    if ($id <= 0) return false;

    if (!projectTableExists($conn, 'contracts')) {
        return false;
    }

    $stmt = $conn->prepare(
        "SELECT id
         FROM contracts
         WHERE client_id = ?
           AND status = 'accepted'
         LIMIT 1"
    );
    if (!$stmt) {
        sendError('Failed to validate client contract status.', 500);
    }

    $stmt->bind_param('i', $id);
    $stmt->execute();
    $hasAcceptedContract = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    return $hasAcceptedContract;
}

function buildAutoProjectName($clientName, $services) {
    $normalizedClient = normalizeProjectName($clientName);
    $serviceNames = [];

    foreach ((array)$services as $service) {
        $serviceName = normalizeProjectName($service['service_name'] ?? '');
        if ($serviceName !== '') {
            $serviceNames[] = $serviceName;
        }
    }

    if ($normalizedClient === '' && empty($serviceNames)) {
        return '';
    }
    if (empty($serviceNames)) {
        return $normalizedClient;
    }

    return normalizeProjectName($normalizedClient . ' - ' . implode(' / ', $serviceNames));
}

function ensureProjectDateTimeColumns($conn) {
    $columns = ['start_date', 'end_date'];
    $stmt = $conn->prepare(
        "SELECT COLUMN_NAME, DATA_TYPE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'projects'
           AND COLUMN_NAME IN ('start_date', 'end_date')"
    );
    if (!$stmt) {
        sendError('Failed to inspect project date storage.', 500);
    }

    $stmt->execute();
    $result = $stmt->get_result();
    $typesByColumn = [];
    while ($row = $result->fetch_assoc()) {
        $typesByColumn[strtolower((string)$row['COLUMN_NAME'])] = strtolower((string)$row['DATA_TYPE']);
    }
    $stmt->close();

    foreach ($columns as $column) {
        if (($typesByColumn[$column] ?? '') !== 'datetime') {
            if (!$conn->query("ALTER TABLE projects MODIFY COLUMN {$column} DATETIME NULL")) {
                error_log($conn->error);
                sendError('Failed to upgrade project date storage.', 500);
            }
        }
    }
}

function normalizeProjectRawDateTimeInput($value) {
    if ($value === null) {
        return null;
    }

    $raw = trim((string)$value);
    if ($raw === '') {
        return null;
    }

    // Accept HTML datetime-local format and normalize to DB DATETIME.
    $raw = str_replace('T', ' ', $raw);
    $raw = preg_replace('/\.\d+$/', '', $raw);

    if (!preg_match('/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/', $raw)) {
        return null;
    }

    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $raw)) {
        $raw .= ' 00:00:00';
    } elseif (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/', $raw)) {
        $raw .= ':00';
    }

    $dt = DateTime::createFromFormat('Y-m-d H:i:s', $raw);
    if (!$dt) {
        return null;
    }

    return $dt->format('Y-m-d H:i:s');
}

function normalizeProjectDateTimeInput($value, $fieldLabel) {
    $normalized = normalizeProjectRawDateTimeInput($value);
    if ($value !== null && $value !== '' && $normalized === null) {
        sendError("Invalid {$fieldLabel}.", 400);
    }
    return $normalized;
}

function projectTableExists($conn, $table) {
    $safeTable = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    if ($safeTable === '') return false;

    $stmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
         LIMIT 1"
    );
    if (!$stmt) return false;

    $stmt->bind_param('s', $safeTable);
    $stmt->execute();
    $result = $stmt->get_result();
    $exists = $result && $result->num_rows > 0;
    $stmt->close();

    return $exists;
}

function getProjectManagerId($conn, $projectId) {
    $id = intval($projectId);
    if ($id <= 0) {
        return null;
    }

    $stmt = $conn->prepare("SELECT manager_id FROM projects WHERE id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to validate project assignment.', 500);
    }

    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        return null;
    }

    return intval($row['manager_id'] ?? 0);
}

function requireManagerAssignedToProject($conn, $projectId) {
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if ($role !== 'manager') {
        return;
    }

    $managerId = getProjectManagerId($conn, $projectId);
    if ($managerId === null) {
        sendError('Project not found', 404);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0 || $managerId !== $currentUserId) {
        sendError('Managers can only manage projects assigned to them.', 403);
    }
}

function assertUniqueProjectName($conn, $projectName, $excludeProjectId = null) {
    $name = normalizeProjectName($projectName);
    if ($name === '') return;

    if ($excludeProjectId !== null && intval($excludeProjectId) > 0) {
        $id = intval($excludeProjectId);
        $stmt = $conn->prepare(
            "SELECT id
             FROM projects
             WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
               AND id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate project name.', 500);
        $stmt->bind_param('si', $name, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT id
             FROM projects
             WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate project name.', 500);
        $stmt->bind_param('s', $name);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Project name already exists.', 409);
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

function getProjectTaskCountsJoinSql() {
    return "LEFT JOIN (
                SELECT project_id,
                       COUNT(*) AS task_count,
                       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_task_count,
                       SUM(CASE WHEN assigned_to IS NOT NULL AND assigned_to > 0 THEN 1 ELSE 0 END) AS assigned_task_count,
                       SUM(CASE WHEN assigned_to IS NULL OR assigned_to = 0 THEN 1 ELSE 0 END) AS unassigned_task_count
                FROM tasks
                GROUP BY project_id
            ) task_counts ON task_counts.project_id = p.id";
}

function getProjectWorkCountsJoinSql() {
    return "LEFT JOIN (
                SELECT project_id,
                       COUNT(*) AS work_count
                FROM work
                GROUP BY project_id
            ) work_counts ON work_counts.project_id = p.id";
}

function handleGet($conn) {
    $project_id = $_GET['id'] ?? null;
    $role = $_SESSION['role'] ?? '';
    $current_user_id = intval($_SESSION['user_id'] ?? 0);
    $compact = strtolower(trim((string)($_GET['compact'] ?? '')));
    $is_calendar_compact = $compact === 'calendar';
    $taskCountsJoin = $is_calendar_compact ? '' : getProjectTaskCountsJoinSql();
    
    if ($project_id) {
        $singleProjectReportSelect = projectTableExists($conn, 'project_completion_reports')
            ? ",
                           CASE WHEN EXISTS (
                               SELECT 1
                               FROM project_completion_reports pcr_major
                               WHERE pcr_major.project_id = p.id
                                 AND pcr_major.report_kind = 'major_report'
                           ) THEN 1 ELSE 0 END AS has_major_completion_report,
                           (
                               SELECT pcr_major.sent_at
                               FROM project_completion_reports pcr_major
                               WHERE pcr_major.project_id = p.id
                                 AND pcr_major.report_kind = 'major_report'
                               ORDER BY pcr_major.sent_at DESC
                               LIMIT 1
                           ) AS major_completion_report_sent_at,
                           CASE WHEN EXISTS (
                               SELECT 1
                               FROM project_completion_reports pcr_cert
                               WHERE pcr_cert.project_id = p.id
                                 AND pcr_cert.report_kind = 'certification'
                           ) THEN 1 ELSE 0 END AS has_certification_report,
                           (
                               SELECT pcr_cert.sent_at
                               FROM project_completion_reports pcr_cert
                               WHERE pcr_cert.project_id = p.id
                                 AND pcr_cert.report_kind = 'certification'
                               ORDER BY pcr_cert.sent_at DESC
                               LIMIT 1
                           ) AS certification_report_sent_at"
            : ",
                           0 AS has_major_completion_report,
                           NULL AS major_completion_report_sent_at,
                           0 AS has_certification_report,
                           NULL AS certification_report_sent_at";
        $sql = "SELECT p.*,
                       c.client_name,
                       c.contact_person,
                       c.email as client_email,
                       c.phone as client_phone,
                       c.address as client_address,
                       CONCAT(u.first_name, ' ', u.last_name) as manager_name,
                       COALESCE(task_counts.task_count, 0) as task_count,
                       COALESCE(task_counts.completed_task_count, 0) as completed_task_count,
                       COALESCE(task_counts.assigned_task_count, 0) as assigned_task_count,
                       COALESCE(task_counts.unassigned_task_count, 0) as unassigned_task_count,
                       COALESCE(work_counts.work_count, 0) as work_count,
                       (
                           SELECT GROUP_CONCAT(s.service_name ORDER BY LOWER(TRIM(s.service_name)) SEPARATOR ',')
                           FROM client_services cs
                           INNER JOIN services s ON s.service_id = cs.service_id
                           WHERE cs.client_id = p.client_id
                             AND cs.status = 'active'
                       ) AS service_names
                       $singleProjectReportSelect
                 FROM projects p
                 LEFT JOIN client c ON p.client_id = c.client_id
                 LEFT JOIN users u ON p.manager_id = u.id
                 $taskCountsJoin
                 " . getProjectWorkCountsJoinSql() . "
                 WHERE p.id = ?";

        if ($role === 'staff') {
            $sql .= " AND EXISTS (
                        SELECT 1
                        FROM tasks st
                        WHERE st.project_id = p.id
                          AND (
                                st.assigned_to = ?
                                OR EXISTS (
                                    SELECT 1
                                    FROM task_collaborators tc
                                    WHERE tc.task_id = st.id
                                      AND tc.user_id = ?
                                )
                          )
                    )";
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('iii', $project_id, $current_user_id, $current_user_id);
        } else {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param('i', $project_id);
        }

        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($row = $result->fetch_assoc()) {
            sendResponse(true, $row, 'Project retrieved successfully');
        } else {
            sendError('Project not found', 404);
        }
    } else {
        $status = $_GET['status'] ?? null;
        $client_id = $_GET['client_id'] ?? null;

        if ($is_calendar_compact) {
            $sql = "SELECT p.id,
                           p.status,
                           p.start_date,
                           p.end_date
                    FROM projects p
                    WHERE 1=1";
        } else {
            $sql = "SELECT p.*,
                           c.client_name,
                           CONCAT(u.first_name, ' ', u.last_name) as manager_name,
                           COALESCE(task_counts.task_count, 0) as task_count,
                           COALESCE(task_counts.completed_task_count, 0) as completed_task_count,
                           COALESCE(task_counts.assigned_task_count, 0) as assigned_task_count,
                           COALESCE(task_counts.unassigned_task_count, 0) as unassigned_task_count,
                           (
                               SELECT GROUP_CONCAT(s.service_name ORDER BY LOWER(TRIM(s.service_name)) SEPARATOR ',')
                               FROM client_services cs
                               INNER JOIN services s ON s.service_id = cs.service_id
                               WHERE cs.client_id = p.client_id
                                 AND cs.status = 'active'
                           ) AS service_names
                    FROM projects p
                    LEFT JOIN client c ON p.client_id = c.client_id
                    LEFT JOIN users u ON p.manager_id = u.id
                    $taskCountsJoin
                    WHERE 1=1";
        }
        
        $params = [];
        $types = '';
        
        if ($status) {
            $sql .= " AND p.status = ?";
            $params[] = $status;
            $types .= 's';
        }
        
        if ($client_id) {
            $sql .= " AND p.client_id = ?";
            $params[] = $client_id;
            $types .= 'i';
        }

        // RBAC: staff only sees projects that include tasks assigned to them.
        if ($role === 'staff') {
            $sql .= " AND EXISTS (
                        SELECT 1
                        FROM tasks st
                        WHERE st.project_id = p.id
                          AND (
                                st.assigned_to = ?
                                OR EXISTS (
                                    SELECT 1
                                    FROM task_collaborators tc
                                    WHERE tc.task_id = st.id
                                      AND tc.user_id = ?
                                )
                          )
                    )";
            $params[] = $current_user_id;
            $params[] = $current_user_id;
            $types .= 'ii';
        }
        
        $sql .= " ORDER BY LOWER(TRIM(COALESCE(p.name, ''))) ASC, p.id ASC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
        }
        
        $projects = [];
        while ($row = $result->fetch_assoc()) {
            $projects[] = $row;
        }
        
        sendResponse(true, $projects, 'Projects retrieved successfully');
    }
}

function handlePost($conn) {
    // RBAC: Staff cannot create projects
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot create projects', 403);
    }

    $data = getJSONInput();

    $required = ['client_id', 'manager_id', 'end_date'];
    $missing = validateRequiredFields($data, $required);

    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }

    $description = sanitizeInput($data['description'] ?? '');
    $client_id = $data['client_id'] ?? null;
    if (!$client_id) {
        sendError('Client is required', 400);
    }
    $client_id = intval($client_id);
    $client = getClientRecord($conn, $client_id);
    if (!$client) {
        sendError('Selected client was not found.', 404);
    }

    $clientServices = getClientActiveServices($conn, $client_id);
    if (empty($clientServices)) {
        sendError('Selected client has no active services to build a project from.', 400);
    }

    $autoName = buildAutoProjectName($client['client_name'] ?? '', $clientServices);
    $customName = normalizeProjectName($data['name'] ?? '');
    // Generated name is editable: use the user-provided name when present,
    // otherwise fall back to the auto-generated "Client - Service" name.
    $name = $customName !== '' ? $customName : $autoName;
    if ($name === '') {
        sendError('Project name is required. Unable to generate the project name for this client.', 400);
    }
    $manager_id = intval($data['manager_id'] ?? 0);
    if ($manager_id <= 0) {
        sendError('Manager is required', 400);
    }
    if (strtolower(trim((string)($_SESSION['role'] ?? ''))) === 'manager') {
        $currentManagerId = intval($_SESSION['user_id'] ?? 0);
        if ($currentManagerId <= 0 || $manager_id !== $currentManagerId) {
            sendError('Managers can only create projects assigned to themselves.', 403);
        }
    }
    $created_by = checkAuthentication() ?: null;
    releaseSessionLock();
    $status = $data['status'] ?? 'active';
    // Normalize invalid/empty status to 'active'
    $allowed_status = ['active', 'completed', 'on_hold', 'archived', 'pending'];
    if (!in_array($status, $allowed_status, true) || $status === '' || $status === null) {
        $status = 'active';
    }
    $start_date = date('Y-m-d H:i:s');
    $end_date = normalizeProjectDateTimeInput($data['end_date'] ?? null, 'due date');
    if (!$end_date) {
        sendError('Due date is required', 400);
    }
    $custom_tasks = $data['custom_tasks'] ?? null;

    assertUniqueProjectName($conn, $name);
    
    $sql = "INSERT INTO projects (name, description, client_id, manager_id, created_by, status, start_date, end_date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('ssiiiiss', $name, $description, $client_id, $manager_id, $created_by, $status, $start_date, $end_date);
    
    if ($stmt->execute()) {
        $project_id = $conn->insert_id;
        $clearSetupStmt = $conn->prepare("UPDATE client SET needs_project_setup = 0 WHERE client_id = ?");
        if ($clearSetupStmt) {
            $clearSetupStmt->bind_param('i', $client_id);
            $clearSetupStmt->execute();
            $clearSetupStmt->close();
        }
        
        // Auto-generate tasks: Use custom tasks if provided, otherwise default to all client services
        if ($client_id) {
            generateProjectTasks($conn, $project_id, $client_id, $created_by, $custom_tasks);
        }
        
        if ($created_by) {
            logActivity($conn, $created_by, 'create_project', "Created project: $name", 'project_management');
        }
        
        sendResponse(true, ['project_id' => $project_id], 'Project created successfully', 201);
    } else {
        error_log($conn->error);
        sendError('Failed to create project.', 500);
    }
}

/**
 * Helper to generate tasks from service checklists
 */
function generateProjectTasks($conn, $project_id, $client_id, $created_by, $custom_tasks = null) {
    $soft_delete_filter = hasChecklistSoftDeleteColumn($conn) ? " AND is_deleted = 0" : "";
    $creatorId = intval($created_by);
    $due_date = date('Y-m-d H:i:s', strtotime('+7 days'));

    // Check whether the tasks table has a service_id column so we can populate it.
    $hasServiceId = projectsColumnExists($conn, 'tasks', 'service_id');

    if (is_array($custom_tasks)) {
        $ids = array_values(array_unique(array_filter(array_map('intval', $custom_tasks), function ($id) {
            return $id > 0;
        })));
        if (empty($ids)) return;

        $ids_str = implode(',', $ids);

        if ($hasServiceId) {
            $insertSql = "INSERT INTO tasks (title, description, project_id, service_id, created_by, status, priority, due_date)
                          SELECT sc.task_name,
                                 sc.description,
                                 ?,
                                 sc.service_id,
                                 NULLIF(?, 0),
                                 'pending',
                                 'medium',
                                 ?
                          FROM service_checklists sc
                          WHERE sc.checklist_id IN ($ids_str)$soft_delete_filter";
        } else {
            $insertSql = "INSERT INTO tasks (title, description, project_id, created_by, status, priority, due_date)
                          SELECT sc.task_name,
                                 sc.description,
                                 ?,
                                 NULLIF(?, 0),
                                 'pending',
                                 'medium',
                                 ?
                          FROM service_checklists sc
                          WHERE sc.checklist_id IN ($ids_str)$soft_delete_filter";
        }
        $insertStmt = $conn->prepare($insertSql);
        if (!$insertStmt) {
            return;
        }
        $insertStmt->bind_param('iis', $project_id, $creatorId, $due_date);
        $insertStmt->execute();
        $insertStmt->close();
        return;
    }

    if ($hasServiceId) {
        $insertSql = "INSERT INTO tasks (title, description, project_id, service_id, created_by, status, priority, due_date)
                      SELECT sc.task_name,
                             sc.description,
                             ?,
                             sc.service_id,
                             NULLIF(?, 0),
                             'pending',
                             'medium',
                             ?
                      FROM service_checklists sc
                      INNER JOIN client_services cs
                              ON cs.service_id = sc.service_id
                             AND cs.client_id = ?
                             AND cs.status = 'active'
                      WHERE sc.is_required = 1$soft_delete_filter";
    } else {
        $insertSql = "INSERT INTO tasks (title, description, project_id, created_by, status, priority, due_date)
                      SELECT sc.task_name,
                             sc.description,
                             ?,
                             NULLIF(?, 0),
                             'pending',
                             'medium',
                             ?
                      FROM service_checklists sc
                      INNER JOIN client_services cs
                              ON cs.service_id = sc.service_id
                             AND cs.client_id = ?
                             AND cs.status = 'active'
                      WHERE sc.is_required = 1$soft_delete_filter";
    }
    $insertStmt = $conn->prepare($insertSql);
    if (!$insertStmt) {
        return;
    }
    if ($hasServiceId) {
        $insertStmt->bind_param('iisi', $project_id, $creatorId, $due_date, $client_id);
    } else {
        $insertStmt->bind_param('iisi', $project_id, $creatorId, $due_date, $client_id);
    }
    $insertStmt->execute();
    $insertStmt->close();
}

function projectsColumnExists($conn, $table, $column) {
    $safeTable  = preg_replace('/[^A-Za-z0-9_]/', '', (string)$table);
    $safeColumn = preg_replace('/[^A-Za-z0-9_]/', '', (string)$column);
    $stmt = $conn->prepare(
        "SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ss', $safeTable, $safeColumn);
    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $exists;
}

function hasChecklistSoftDeleteColumn($conn) {
    static $cached = null;
    if ($cached !== null) return $cached;

    $dbName = DB_NAME;
    $sql = "SELECT 1
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'service_checklists'
              AND COLUMN_NAME = 'is_deleted'
            LIMIT 1";
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        $cached = false;
        return $cached;
    }
    $stmt->bind_param('s', $dbName);
    $stmt->execute();
    $cached = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $cached;
}

function handlePut($conn) {
    // RBAC: Staff cannot update projects
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot update projects', 403);
    }

    $data = getJSONInput();

    if (!isset($data['id'])) {
        sendError('Project ID is required', 400);
    }

    $project_id = intval($data['id']);

    // ── Start-project shortcut ─────────────────────────────────────────────
    // When the payload only contains { id, manager_id, start: true } the
    // caller is "starting" a pending project: set status=active, record the
    // manager and stamp start_date to NOW.
    if (!empty($data['start'])) {
        requireRole(['admin']);          // only admins can start a project

        $new_manager_id = intval($data['manager_id'] ?? 0);
        if ($new_manager_id <= 0) {
            sendError('A manager must be assigned before starting the project.', 400);
        }

        // Verify manager exists and has role=manager
        $mgrStmt = $conn->prepare("SELECT id FROM users WHERE id = ? AND LOWER(TRIM(role)) = 'manager' LIMIT 1");
        if (!$mgrStmt) sendError('Failed to validate manager.', 500);
        $mgrStmt->bind_param('i', $new_manager_id);
        $mgrStmt->execute();
        if ($mgrStmt->get_result()->num_rows === 0) {
            sendError('Selected manager was not found.', 404);
        }
        $mgrStmt->close();

        $start_date      = date('Y-m-d H:i:s');
        $contract_signed = isset($data['contract_signed']) ? (intval($data['contract_signed']) > 0 ? 1 : 0) : 0;

        // Ensure contract_signed column exists (safe guard, migration in contracts.php)
        $dbName = DB_NAME;
        $colChk = $conn->prepare(
            "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='projects' AND COLUMN_NAME='contract_signed' LIMIT 1"
        );
        $hasContractSignedCol = false;
        if ($colChk) {
            $colChk->bind_param('s', $dbName);
            $colChk->execute();
            $hasContractSignedCol = $colChk->get_result()->num_rows > 0;
            $colChk->close();
        }
        if (!$hasContractSignedCol) {
            $conn->query("ALTER TABLE projects ADD COLUMN contract_signed TINYINT(1) NOT NULL DEFAULT 0");
            $hasContractSignedCol = true;
        }

        $updStmt = $conn->prepare(
            "UPDATE projects SET status = 'active', manager_id = ?, start_date = ?, contract_signed = ? WHERE id = ? LIMIT 1"
        );
        if (!$updStmt) sendError('Failed to start project.', 500);
        $updStmt->bind_param('isii', $new_manager_id, $start_date, $contract_signed, $project_id);
        if (!$updStmt->execute()) { error_log($conn->error); sendError('Failed to start project.', 500); }
        $updStmt->close();

        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'start_project', "Started project ID: $project_id (contract_signed={$contract_signed})", 'project_management');
        }

        sendResponse(true, ['project_id' => $project_id, 'contract_signed' => $contract_signed], 'Project started successfully.');
    }
    // ──────────────────────────────────────────────────────────────────────

    requireManagerAssignedToProject($conn, $project_id);

    if (
        strtolower(trim((string)($_SESSION['role'] ?? ''))) === 'manager'
        && array_key_exists('manager_id', $data)
        && intval($data['manager_id']) !== intval($_SESSION['user_id'] ?? 0)
    ) {
        sendError('Managers cannot reassign projects to another manager.', 403);
    }

    if (isset($data['name'])) {
        assertUniqueProjectName($conn, $data['name'], $project_id);
    }

    $updates = [];
    $params = [];
    $types = '';

    $allowed_fields = ['name', 'description', 'client_id', 'manager_id', 'status', 'start_date', 'end_date', 'actual_cost'];
    
    foreach ($allowed_fields as $field) {
        if (isset($data[$field])) {
            $updates[] = "$field = ?";
            
            if (in_array($field, ['actual_cost'])) {
                $params[] = floatval($data[$field]);
                $types .= 'd';
            } elseif (in_array($field, ['client_id', 'manager_id'])) {
                $params[] = $data[$field];
                $types .= 'i';
            } else {
                if ($field === 'name') {
                    $params[] = normalizeProjectName($data[$field]);
                } elseif ($field === 'start_date' || $field === 'end_date') {
                    $params[] = normalizeProjectDateTimeInput($data[$field], $field === 'end_date' ? 'due date' : 'start date');
                } else {
                    $params[] = sanitizeInput($data[$field]);
                }
                $types .= 's';
            }
        }
    }
    
    if (empty($updates)) {
        sendError('No fields to update', 400);
    }
    
    $params[] = $project_id;
    $types .= 'i';
    
    $sql = "UPDATE projects SET " . implode(', ', $updates) . " WHERE id = ?";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);
    
    if ($stmt->execute()) {
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'update_project', "Updated project ID: $project_id", 'project_management');
        }
        
        sendResponse(true, null, 'Project updated successfully');
    } else {
        error_log($conn->error);
        sendError('Failed to update project.', 500);
    }
}

function handleDelete($conn) {
    // RBAC: Staff cannot archive/delete projects
    if (isset($_SESSION['role']) && $_SESSION['role'] === 'staff') {
        sendError('Staff cannot archive projects', 403);
    }

    $project_id = $_GET['id'] ?? null;
    
    if (!$project_id) {
        sendError('Project ID is required', 400);
    }
    
    $project_id = intval($project_id);
    requireManagerAssignedToProject($conn, $project_id);
    $permanent = isset($_GET['permanent']) && $_GET['permanent'] == '1';

    if ($permanent) {
        // Permanently delete: remove tasks first, then the project
        $conn->query("DELETE FROM tasks WHERE project_id = $project_id");
        $sql = "DELETE FROM projects WHERE id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $project_id);

        if ($stmt->execute()) {
            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'delete_project', "Permanently deleted project ID: $project_id", 'project_management');
            }
            sendResponse(true, null, 'Project permanently deleted');
        } else {
            error_log($conn->error);
            sendError('Failed to delete project.', 500);
        }
    } else {
        // Soft delete (archive)
        $sql = "UPDATE projects SET status = 'archived' WHERE id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $project_id);
        
        if ($stmt->execute()) {
            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'archive_project', "Archived project ID: $project_id", 'project_management');
            }
            sendResponse(true, null, 'Project archived successfully');
        } else {
            error_log($conn->error);
            sendError('Failed to archive project.', 500);
        }
    }
}

closeDBConnection($conn);
?>
