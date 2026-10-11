<?php
/**
 * Branches API
 * Handles CRUD operations for branches
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

switch ($method) {
    case 'GET':
        requireAuth();
        handleGet($conn);
        break;
    case 'POST':
        requireRole(['admin']);
        handlePost($conn);
        break;
    case 'PUT':
        requireRole(['admin']);
        handlePut($conn);
        break;
    case 'DELETE':
        requireRole(['admin']);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function normalizeBranchName($value) {
    $name = sanitizeInput((string)$value);
    $name = preg_replace('/\s+/', ' ', trim((string)$name));
    return $name;
}

function assertUniqueBranchName($conn, $branchName, $excludeBranchId = null) {
    $name = normalizeBranchName($branchName);
    if ($name === '') return;

    if ($excludeBranchId !== null && intval($excludeBranchId) > 0) {
        $id = intval($excludeBranchId);
        $stmt = $conn->prepare(
            "SELECT branch_id
             FROM branches
             WHERE LOWER(TRIM(branch_name)) = LOWER(TRIM(?))
               AND branch_id <> ?
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate branch name.', 500);
        $stmt->bind_param('si', $name, $id);
    } else {
        $stmt = $conn->prepare(
            "SELECT branch_id
             FROM branches
             WHERE LOWER(TRIM(branch_name)) = LOWER(TRIM(?))
             LIMIT 1"
        );
        if (!$stmt) sendError('Failed to validate duplicate branch name.', 500);
        $stmt->bind_param('s', $name);
    }

    $stmt->execute();
    $exists = $stmt->get_result()->num_rows > 0;
    $stmt->close();

    if ($exists) {
        sendError('Branch name already exists.', 409);
    }
}

function normalizeBranchContactName($value) {
    $name = sanitizeInput((string)$value);
    return preg_replace('/\s+/', ' ', trim((string)$name));
}

function normalizeBranchContactNumberType($value) {
    return strtolower(trim((string)$value)) === 'telephone' ? 'telephone' : 'mobile';
}

function normalizeBranchContactEntry($entry, $label) {
    $source = is_array($entry) ? $entry : [];
    $numberRaw = trim((string)($source['contact_number'] ?? $source['contactNumber'] ?? ''));
    $normalizedNumber = normalizeInternationalPhoneNumber($numberRaw, '+63');
    if ($normalizedNumber === false) {
        sendError($label . ' contact number must be a valid international number with a country code, like +639123456789.', 400);
    }

    return [
        'first_name' => normalizeBranchContactName($source['first_name'] ?? $source['firstName'] ?? ''),
        'last_name' => normalizeBranchContactName($source['last_name'] ?? $source['lastName'] ?? ''),
        'contact_number' => $normalizedNumber ?? '',
        'contact_number_type' => normalizeBranchContactNumberType($source['contact_number_type'] ?? $source['contactNumberType'] ?? 'mobile'),
    ];
}

function normalizeBranchContactInfo($value) {
    if (!isset($value)) return '';

    $raw = trim((string)$value);
    if ($raw === '') return '';

    if ($raw[0] !== '{' && $raw[0] !== '[') {
        return sanitizeInput($raw);
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        sendError('Contact information must be valid JSON.', 400);
    }

    $primarySource = [];
    if (isset($decoded['primary']) && is_array($decoded['primary'])) {
        $primarySource = $decoded['primary'];
    } elseif (isset($decoded['contact']) && is_array($decoded['contact'])) {
        $primarySource = $decoded['contact'];
    } else {
        $primarySource = $decoded;
    }
    $primary = normalizeBranchContactEntry($primarySource, 'Primary');

    $additional = [];
    if (isset($decoded['additional']) && is_array($decoded['additional'])) {
        foreach ($decoded['additional'] as $index => $entry) {
            $normalizedEntry = normalizeBranchContactEntry($entry, 'Additional contact #' . ($index + 1));
            if (
                $normalizedEntry['first_name'] === ''
                && $normalizedEntry['last_name'] === ''
                && $normalizedEntry['contact_number'] === ''
            ) {
                continue;
            }
            $additional[] = $normalizedEntry;
        }
    }

    if (
        $primary['first_name'] === ''
        && $primary['last_name'] === ''
        && $primary['contact_number'] === ''
        && empty($additional)
    ) {
        return '';
    }

    $seenContacts = [];
    $contactRows = array_merge([$primary], $additional);
    foreach ($contactRows as $contact) {
        $contactKey = strtolower(trim($contact['first_name'] . ' ' . $contact['last_name'])) . '|' . strtolower(trim((string)$contact['contact_number']));
        if ($contactKey === '|') continue;
        if (isset($seenContacts[$contactKey])) {
            sendError('Duplicate branch contact entries are not allowed.', 409);
        }
        $seenContacts[$contactKey] = true;
    }

    return json_encode(
        [
            'primary' => $primary,
            'additional' => $additional,
        ],
        JSON_UNESCAPED_UNICODE
    );
}

/**
 * GET - Retrieve branches
 */
function handleGet($conn) {
    $branch_id = $_GET['id'] ?? null;
    
    if ($branch_id) {
        // Get single branch
        $sql = "SELECT b.*, 
                       CONCAT(e.first_name, ' ', e.last_name) as manager_name
                FROM branches b
                LEFT JOIN employees e ON b.manager_id = e.employee_id
                WHERE b.branch_id = ?";
        
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $branch_id);
        $stmt->execute();
        $result = $stmt->get_result();
        $row = $result->fetch_assoc();
        $stmt->close();

        if ($row) {
            sendResponse(true, $row, 'Branch retrieved successfully');
        } else {
            sendError('Branch not found', 404);
        }
    } else {
        // Get all branches
        $status = $_GET['status'] ?? null;
        $search = $_GET['search'] ?? null;
        
        $sql = "SELECT b.*, 
                       CONCAT(e.first_name, ' ', e.last_name) as manager_name,
                       (SELECT COUNT(*) FROM employees WHERE branch_id = b.branch_id) as employee_count
                FROM branches b
                LEFT JOIN employees e ON b.manager_id = e.employee_id
                WHERE 1=1";
        
        $params = [];
        $types = '';
        
        if ($status) {
            $sql .= " AND b.status = ?";
            $params[] = $status;
            $types .= 's';
        }
        
        if ($search) {
            $sql .= " AND (b.branch_name LIKE ? OR b.location LIKE ?)";
            $escaped_search = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search);
            $search_param = "%$escaped_search%";
            $params[] = $search_param;
            $params[] = $search_param;
            $types .= 'ss';
        }
        
        $sql .= " ORDER BY LOWER(TRIM(COALESCE(b.branch_name, ''))) ASC, b.branch_id ASC";
        
        if (!empty($params)) {
            $stmt = $conn->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $result = $stmt->get_result();
        } else {
            $result = $conn->query($sql);
        }
        
        $branches = [];
        while ($row = $result->fetch_assoc()) {
            $branches[] = $row;
        }
        
        sendResponse(true, $branches, 'Branches retrieved successfully');
    }
}

/**
 * POST - Create new branch
 */
function handlePost($conn) {
    $data = getJSONInput();
    
    // Validate required fields
    $required = ['branch_name'];
    $missing = validateRequiredFields($data, $required);
    
    if ($missing) {
        sendError('Missing required fields: ' . implode(', ', $missing), 400);
    }
    
    $branch_name = normalizeBranchName($data['branch_name']);
    $location = sanitizeInput($data['location'] ?? '');
    $latitude = isset($data['latitude']) && is_numeric($data['latitude']) ? floatval($data['latitude']) : null;
    $longitude = isset($data['longitude']) && is_numeric($data['longitude']) ? floatval($data['longitude']) : null;
    $contact_info = normalizeBranchContactInfo($data['contact_info'] ?? '');
    $manager_id = isset($data['manager_id']) && is_numeric($data['manager_id']) ? intval($data['manager_id']) : null;
    $status = ($data['status'] ?? 'active') === 'inactive' ? 'inactive' : 'active';

    assertUniqueBranchName($conn, $branch_name);
    
    $sql = "INSERT INTO branches (branch_name, location, latitude, longitude, contact_info, manager_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param('ssddsis', $branch_name, $location, $latitude, $longitude, $contact_info, $manager_id, $status);
    
    if ($stmt->execute()) {
        $branch_id = $conn->insert_id;
        
        // Log activity
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'create_branch', "Created branch: $branch_name", 'branch_management');
        }
        
        sendResponse(true, ['branch_id' => $branch_id], 'Branch created successfully', 201);
    } else {
        error_log($conn->error);
        sendError('Failed to create branch.', 500);
    }
}

/**
 * PUT - Update branch
 */
function handlePut($conn) {
    $data = getJSONInput();
    
    if (!isset($data['branch_id'])) {
        sendError('Branch ID is required', 400);
    }
    
    $branch_id = intval($data['branch_id']);
    
    // Check if branch exists
    $check_sql = "SELECT branch_id FROM branches WHERE branch_id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $branch_id);
    $check_stmt->execute();
    
    if ($check_stmt->get_result()->num_rows === 0) {
        sendError('Branch not found', 404);
    }

    if (isset($data['branch_name'])) {
        assertUniqueBranchName($conn, $data['branch_name'], $branch_id);
    }
    
    $updates = [];
    $params = [];
    $types = '';
    
    $allowed_fields = ['branch_name', 'location', 'latitude', 'longitude', 'contact_info', 'manager_id', 'status'];
    
    foreach ($allowed_fields as $field) {
        if (array_key_exists($field, $data)) {
            $updates[] = "$field = ?";
            if ($field === 'branch_name') {
                $value = normalizeBranchName($data[$field]);
                $types .= 's';
            } elseif ($field === 'contact_info') {
                $value = normalizeBranchContactInfo($data[$field]);
                $types .= 's';
            } elseif ($field === 'latitude' || $field === 'longitude') {
                $value = ($data[$field] !== null && is_numeric($data[$field])) ? floatval($data[$field]) : null;
                $types .= 'd';
            } elseif ($field === 'manager_id') {
                $value = $data[$field];
                $types .= 'i';
            } else {
                $value = sanitizeInput($data[$field]);
                $types .= 's';
            }
            $params[] = $value;
        }
    }
    
    if (empty($updates)) {
        sendError('No fields to update', 400);
    }
    
    $params[] = $branch_id;
    $types .= 'i';
    
    $sql = "UPDATE branches SET " . implode(', ', $updates) . " WHERE branch_id = ?";
    
    $stmt = $conn->prepare($sql);
    $stmt->bind_param($types, ...$params);
    
    if ($stmt->execute()) {
        // Log activity
        if ($user_id = checkAuthentication()) {
            releaseSessionLock();
            logActivity($conn, $user_id, 'update_branch', "Updated branch ID: $branch_id", 'branch_management');
        }
        
        sendResponse(true, null, 'Branch updated successfully');
    } else {
        error_log($conn->error);
        sendError('Failed to update branch.', 500);
    }
}

/**
 * DELETE - Delete/Archive branch
 */
function handleDelete($conn) {
    $branch_id = $_GET['id'] ?? null;
    $permanent = $_GET['permanent'] ?? null;
    
    if (!$branch_id) {
        sendError('Branch ID is required', 400);
    }
    
    $branch_id = intval($branch_id);
    
    // Check if branch exists
    $check_sql = "SELECT branch_id FROM branches WHERE branch_id = ?";
    $check_stmt = $conn->prepare($check_sql);
    $check_stmt->bind_param('i', $branch_id);
    $check_stmt->execute();
    
    if ($check_stmt->get_result()->num_rows === 0) {
        sendError('Branch not found', 404);
    }
    
    if ($permanent == '1') {
        // Permanent delete
        $sql = "DELETE FROM branches WHERE branch_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $branch_id);
        
        if ($stmt->execute()) {
            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'delete_branch', "Permanently deleted branch ID: $branch_id", 'branch_management');
            }
            sendResponse(true, null, 'Branch deleted permanently');
        } else {
            error_log($conn->error);
            sendError('Failed to delete branch.', 500);
        }
    } else {
        // Soft delete - set status to inactive
        $sql = "UPDATE branches SET status = 'inactive' WHERE branch_id = ?";
        $stmt = $conn->prepare($sql);
        $stmt->bind_param('i', $branch_id);
        
        if ($stmt->execute()) {
            if ($user_id = checkAuthentication()) {
                releaseSessionLock();
                logActivity($conn, $user_id, 'archive_branch', "Archived branch ID: $branch_id", 'branch_management');
            }
            sendResponse(true, null, 'Branch archived successfully');
        } else {
            error_log($conn->error);
            sendError('Failed to archive branch.', 500);
        }
    }
}

closeDBConnection($conn);
?>
