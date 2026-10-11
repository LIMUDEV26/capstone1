<?php

require_once __DIR__ . '/mailer.php';

function ensureProfileEditRequestTable($conn) {
    // Ensure the mobile_number column exists on users before any snapshot query runs.
    // edit-requests.php does not include users.php, so we guard it here.
    $dbName = defined('DB_NAME') ? DB_NAME : $conn->query("SELECT DATABASE()")->fetch_row()[0];
    $colCheck = $conn->prepare(
        "SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'mobile_number'
         LIMIT 1"
    );
    if ($colCheck) {
        $colCheck->bind_param('s', $dbName);
        $colCheck->execute();
        $exists = $colCheck->get_result()->num_rows > 0;
        $colCheck->close();
        if (!$exists) {
            $conn->query("ALTER TABLE users ADD COLUMN `mobile_number` VARCHAR(20) NULL");
        }
    }

    $sql = "CREATE TABLE IF NOT EXISTS profile_edit_request (
                request_id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                employee_id INT NULL,
                requested_by INT NOT NULL,
                request_reason TEXT NULL,
                requested_fields_json LONGTEXT NULL,
                request_snapshot_json LONGTEXT NULL,
                status ENUM('pending', 'approved', 'used', 'rejected') NOT NULL DEFAULT 'pending',
                approved_by INT NULL,
                approved_at DATETIME NULL,
                access_granted_until DATETIME NULL,
                used_at DATETIME NULL,
                used_by INT NULL,
                updated_fields_json LONGTEXT NULL,
                archived_at DATETIME NULL,
                archived_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_profile_edit_request_user (user_id, status, archived_at),
                KEY idx_profile_edit_request_status (status, archived_at, created_at),
                KEY idx_profile_edit_request_archived (archived_at),
                CONSTRAINT fk_profile_edit_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_profile_edit_request_employee FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE SET NULL,
                CONSTRAINT fk_profile_edit_request_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_profile_edit_request_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT fk_profile_edit_request_used_by FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT fk_profile_edit_request_archived_by FOREIGN KEY (archived_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize profile edit request storage.', 500);
    }

    runRuntimeSchemaUpgradeOnce('profile_edit_request_requested_fields_v20260927_2', function () use ($conn, $dbName) {
        $columnCheck = $conn->prepare(
            "SELECT 1 FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'profile_edit_request' AND COLUMN_NAME = 'requested_fields_json'
             LIMIT 1"
        );
        $columnExists = false;
        if ($columnCheck) {
            $columnCheck->bind_param('s', $dbName);
            $columnCheck->execute();
            $columnExists = $columnCheck->get_result()->num_rows > 0;
            $columnCheck->close();
        }

        if (!$columnExists && !$conn->query("ALTER TABLE profile_edit_request ADD COLUMN requested_fields_json LONGTEXT NULL AFTER request_reason")) {
            error_log($conn->error);
            sendError('Failed to add requested profile fields storage.', 500);
        }

        $legacyFieldsJson = profileEditJsonEncode(array_keys(profileEditGetRequestableFieldLabelMap()));
        $legacyStmt = $conn->prepare(
            "UPDATE profile_edit_request
             SET requested_fields_json = ?
             WHERE requested_fields_json IS NULL OR TRIM(requested_fields_json) = ''"
        );
        if ($legacyStmt) {
            $legacyStmt->bind_param('s', $legacyFieldsJson);
            $legacyStmt->execute();
            $legacyStmt->close();
        }
    });
}

function profileEditJsonEncode($value) {
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function profileEditJsonDecode($value) {
    $text = trim((string)$value);
    if ($text === '') return null;
    $decoded = json_decode($text, true);
    return is_array($decoded) ? $decoded : null;
}

function profileEditNormalizeRole($value) {
    return strtolower(trim((string)$value));
}

function profileEditFormatDisplayName($firstName, $lastName, $username = '') {
    $fullName = trim(trim((string)$firstName) . ' ' . trim((string)$lastName));
    if ($fullName !== '') return $fullName;
    $fallback = trim((string)$username);
    return $fallback !== '' ? $fallback : 'User';
}

function profileEditResolveBranchId($conn, $userId) {
    $sessionUserId = intval($_SESSION['user_id'] ?? 0);
    $sessionBranchId = intval($_SESSION['branch_id'] ?? 0);
    if ($userId > 0 && $sessionUserId === intval($userId) && $sessionBranchId > 0) {
        return $sessionBranchId;
    }

    $stmt = $conn->prepare("SELECT branch_id FROM users WHERE id = ? LIMIT 1");
    if (!$stmt) return 0;
    $id = intval($userId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return intval($row['branch_id'] ?? 0);
}

function profileEditBuildFrontendBaseUrl() {
    $frontendBase = trim((string)(getenv('FRONTEND_BASE_URL') ?: ''));
    if ($frontendBase !== '') {
        return rtrim($frontendBase, '/');
    }

    $scheme = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http';
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    return rtrim($scheme . '://' . $host . '/capstone1', '/');
}

function profileEditFetchUserSnapshot($conn, $userId) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT
                u.id,
                u.employee_id,
                u.username,
                u.email,
                u.first_name,
                u.last_name,
                u.role,
                u.status,
                u.password,
                u.branch_id,
                b.branch_name,
                u.date_of_birth,
                u.photo,
                u.sss_number,
                u.pagibig_number,
                u.philhealth_number,
                u.tin_number,
                u.mobile_number,
                u.document_resume,
                u.document_nbi_clearance,
                u.document_police_clearance,
                u.document_barangay_clearance,
                u.document_birth_certificate,
                u.document_medical_certificate,
                u.document_diploma_tor,
                u.document_employment_contract,
                e.salary
            FROM users u
            LEFT JOIN branches b ON b.branch_id = u.branch_id
            LEFT JOIN employees e ON e.employee_id = u.employee_id
            WHERE u.id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $id = intval($userId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) return null;

    $row['display_name'] = profileEditFormatDisplayName(
        $row['first_name'] ?? '',
        $row['last_name'] ?? '',
        $row['username'] ?? ''
    );

    return $row;
}

function profileEditResolveActorSummary($conn, $userId) {
    $stmt = $conn->prepare(
        "SELECT id, username, first_name, last_name, role
         FROM users
         WHERE id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return [
            'id' => intval($userId),
            'name' => 'System',
            'role' => 'system',
        ];
    }

    $id = intval($userId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return [
        'id' => intval($row['id'] ?? $userId),
        'name' => profileEditFormatDisplayName(
            $row['first_name'] ?? '',
            $row['last_name'] ?? '',
            $row['username'] ?? 'System'
        ),
        'role' => strtolower(trim((string)($row['role'] ?? 'system'))),
    ];
}

function profileEditGetFieldLabelMap() {
    return [
        'first_name' => 'First Name',
        'last_name' => 'Last Name',
        'email' => 'Email',
        'date_of_birth' => 'Birthdate',
        'photo' => 'Profile Picture',
        'password' => 'Password',
        'sss_number' => 'SSS Number',
        'pagibig_number' => 'Pag-IBIG Number',
        'philhealth_number' => 'PhilHealth Number',
        'tin_number' => 'TIN Number',
        'mobile_number' => 'Mobile Number',
        'role' => 'Role',
        'status' => 'Status',
        'branch_id' => 'Branch',
        'salary' => 'Salary',
        'phone_number' => 'Phone Number',
        'address' => 'Address',
        'position' => 'Position',
        'department' => 'Department',
        'employment_type' => 'Employment Type',
        'hire_date' => 'Hire Date',
        'document_resume' => 'Resume / CV',
        'document_nbi_clearance' => 'NBI Clearance',
        'document_police_clearance' => 'Police Clearance',
        'document_barangay_clearance' => 'Barangay Clearance',
        'document_birth_certificate' => 'Birth Certificate',
        'document_medical_certificate' => 'Medical Certificate',
        'document_diploma_tor' => 'Diploma / TOR',
        'document_employment_contract' => 'Employment Contract',
    ];
}

function profileEditGetRequestableFieldLabelMap() {
    return [
        'first_name' => 'First Name',
        'last_name' => 'Last Name',
        'email' => 'Email Address',
        'mobile_number' => 'Mobile Number',
        'date_of_birth' => 'Birthdate',
        'photo' => 'Profile Picture',
        'sss_number' => 'SSS Number',
        'pagibig_number' => 'Pag-IBIG Number',
        'philhealth_number' => 'PhilHealth Number',
        'tin_number' => 'TIN Number',
        'password' => 'Password',
    ];
}

function profileEditNormalizeRequestedFields($fields) {
    if (!is_array($fields)) return [];

    $allowed = profileEditGetRequestableFieldLabelMap();
    $normalized = [];
    foreach ($fields as $field) {
        $key = strtolower(trim((string)$field));
        if ($key !== '' && isset($allowed[$key])) {
            $normalized[$key] = true;
        }
    }

    return array_keys($normalized);
}

function profileEditGetRequestedFieldLabels($fields) {
    $labels = profileEditGetRequestableFieldLabelMap();
    return array_values(array_map(function ($field) use ($labels) {
        return $labels[$field] ?? $field;
    }, profileEditNormalizeRequestedFields($fields)));
}

function profileEditNormalizeTrackedValue($field, $value) {
    if (in_array($field, [
        'document_resume',
        'document_nbi_clearance',
        'document_police_clearance',
        'document_barangay_clearance',
        'document_birth_certificate',
        'document_medical_certificate',
        'document_diploma_tor',
        'document_employment_contract',
    ], true)) {
        return intval($value ? 1 : 0);
    }

    if (in_array($field, ['salary'], true)) {
        return number_format((float)$value, 2, '.', '');
    }

    if (in_array($field, ['branch_id', 'employee_id'], true)) {
        return intval($value);
    }

    if (in_array($field, ['role', 'status'], true)) {
        return strtolower(trim((string)$value));
    }

    if (in_array($field, ['date_of_birth', 'hire_date'], true)) {
        $text = trim((string)$value);
        return strlen($text) >= 10 ? substr($text, 0, 10) : $text;
    }

    return trim((string)$value);
}

function profileEditCollectChangedLabels($before, $after, $candidateFields = null) {
    $labelMap = profileEditGetFieldLabelMap();
    $allowedFields = null;
    if (is_array($candidateFields) && !empty($candidateFields)) {
        $allowedFields = array_fill_keys(array_map('strval', $candidateFields), true);
    }

    $labels = [];
    foreach ($labelMap as $field => $label) {
        if ($allowedFields !== null && !isset($allowedFields[$field])) {
            continue;
        }

        $beforeExists = is_array($before) && array_key_exists($field, $before);
        $afterExists = is_array($after) && array_key_exists($field, $after);
        if (!$beforeExists && !$afterExists) {
            continue;
        }

        $beforeValue = $beforeExists ? profileEditNormalizeTrackedValue($field, $before[$field]) : null;
        $afterValue = $afterExists ? profileEditNormalizeTrackedValue($field, $after[$field]) : null;
        if ($beforeValue !== $afterValue) {
            $labels[] = $label;
        }
    }

    return $labels;
}

function profileEditSummarizeChangedFields($labels, $limit = 4) {
    if (!is_array($labels) || empty($labels)) {
        return 'profile details';
    }

    $labels = array_values(array_unique(array_filter(array_map('strval', $labels))));
    if (count($labels) <= $limit) {
        return implode(', ', $labels);
    }

    $visible = array_slice($labels, 0, $limit);
    $remaining = count($labels) - count($visible);
    return implode(', ', $visible) . ', and ' . $remaining . ' more';
}

function profileEditNormalizeRequestRow($row) {
    if (!$row) return null;

    $row['request_snapshot'] = profileEditJsonDecode($row['request_snapshot_json'] ?? '');
    $row['requested_fields'] = profileEditNormalizeRequestedFields(
        profileEditJsonDecode($row['requested_fields_json'] ?? '')
    );
    $row['updated_fields'] = profileEditJsonDecode($row['updated_fields_json'] ?? '');
    $row['requester_name'] = profileEditFormatDisplayName(
        $row['requester_first_name'] ?? '',
        $row['requester_last_name'] ?? '',
        $row['requester_username'] ?? ''
    );
    $row['approved_by_name'] = profileEditFormatDisplayName(
        $row['approved_by_first_name'] ?? '',
        $row['approved_by_last_name'] ?? '',
        $row['approved_by_username'] ?? ''
    );
    $row['archived_by_name'] = profileEditFormatDisplayName(
        $row['archived_by_first_name'] ?? '',
        $row['archived_by_last_name'] ?? '',
        $row['archived_by_username'] ?? ''
    );

    return $row;
}

function profileEditFetchSingleRequest($conn, $requestId) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT
                per.*,
                u.username AS requester_username,
                u.first_name AS requester_first_name,
                u.last_name AS requester_last_name,
                u.email,
                u.role AS requester_role,
                u.branch_id,
                b.branch_name,
                approver.username AS approved_by_username,
                approver.first_name AS approved_by_first_name,
                approver.last_name AS approved_by_last_name,
                archiver.username AS archived_by_username,
                archiver.first_name AS archived_by_first_name,
                archiver.last_name AS archived_by_last_name
            FROM profile_edit_request per
            INNER JOIN users u ON u.id = per.user_id
            LEFT JOIN branches b ON b.branch_id = u.branch_id
            LEFT JOIN users approver ON approver.id = per.approved_by
            LEFT JOIN users archiver ON archiver.id = per.archived_by
            WHERE per.request_id = ?
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $id = intval($requestId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return profileEditNormalizeRequestRow($row);
}

function profileEditReviewerCanManageRequest($requestRow, $viewerRole, $viewerUserId, $viewerBranchId = 0) {
    if (!is_array($requestRow)) return false;

    $normalizedRole = profileEditNormalizeRole($viewerRole);
    $requesterId = intval($requestRow['user_id'] ?? 0);
    $requesterRole = profileEditNormalizeRole($requestRow['requester_role'] ?? '');

    if ($requesterId <= 0 || $requesterRole === 'admin' || $requesterId === intval($viewerUserId)) {
        return false;
    }

    // Only admins manage the profile edit request queue.
    return $normalizedRole === 'admin';
}

function profileEditActiveAccessRow($conn, $userId) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT *
            FROM profile_edit_request
            WHERE user_id = ?
              AND archived_at IS NULL
              AND status = 'approved'
              AND used_at IS NULL
              AND (access_granted_until IS NULL OR access_granted_until >= NOW())
            ORDER BY approved_at DESC, request_id DESC
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $id = intval($userId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return profileEditNormalizeRequestRow($row);
}

function profileEditPendingRequestRow($conn, $userId) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT *
            FROM profile_edit_request
            WHERE user_id = ?
              AND archived_at IS NULL
              AND status = 'pending'
            ORDER BY created_at DESC, request_id DESC
            LIMIT 1";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return null;
    $id = intval($userId);
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return profileEditNormalizeRequestRow($row);
}

function profileEditGetSelfAccessStatus($conn, $userId) {
    ensureProfileEditRequestTable($conn);

    $activeAccess = profileEditActiveAccessRow($conn, $userId);
    $pendingRequest = profileEditPendingRequestRow($conn, $userId);

    $latestStmt = $conn->prepare(
        "SELECT *
         FROM profile_edit_request
         WHERE user_id = ?
         ORDER BY updated_at DESC, request_id DESC
         LIMIT 1"
    );
    $latestRow = null;
    if ($latestStmt) {
        $id = intval($userId);
        $latestStmt->bind_param('i', $id);
        $latestStmt->execute();
        $latestRow = $latestStmt->get_result()->fetch_assoc();
        $latestStmt->close();
    }

    return [
        'active_access' => profileEditNormalizeRequestRow($activeAccess),
        'pending_request' => profileEditNormalizeRequestRow($pendingRequest),
        'latest_request' => profileEditNormalizeRequestRow($latestRow),
    ];
}

function profileEditCreateRequest($conn, $userId, $requestReason = '', $requestedFields = []) {
    ensureProfileEditRequestTable($conn);

    $existingPending = profileEditPendingRequestRow($conn, $userId);
    if ($existingPending) {
        return [
            'success' => false,
            'message' => 'You already have a pending edit access request.',
        ];
    }

    $activeAccess = profileEditActiveAccessRow($conn, $userId);
    if ($activeAccess) {
        $grantedUntil = trim((string)($activeAccess['access_granted_until'] ?? ''));
        $message = 'You already have approved edit access.';
        if ($grantedUntil !== '') {
            $message .= ' It remains active until ' . date('M d, Y h:i A', strtotime($grantedUntil)) . '.';
        }

        return [
            'success' => false,
            'message' => $message,
        ];
    }

    $snapshot = profileEditFetchUserSnapshot($conn, $userId);
    if (!$snapshot) {
        return [
            'success' => false,
            'message' => 'User profile could not be found.',
        ];
    }

    $reason = trim((string)$requestReason);
    if (strlen($reason) > 2000) {
        $reason = substr($reason, 0, 2000);
    }

    $normalizedRequestedFields = profileEditNormalizeRequestedFields($requestedFields);
    if (empty($normalizedRequestedFields)) {
        return [
            'success' => false,
            'message' => 'Select at least one profile detail you need to edit.',
        ];
    }

    $snapshotJson = profileEditJsonEncode($snapshot);
    $requestedFieldsJson = profileEditJsonEncode($normalizedRequestedFields);
    $stmt = $conn->prepare(
        "INSERT INTO profile_edit_request (
            user_id,
            employee_id,
            requested_by,
            request_reason,
            requested_fields_json,
            request_snapshot_json,
            status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
    );
    if (!$stmt) {
        return [
            'success' => false,
            'message' => 'Failed to prepare edit access request.',
        ];
    }

    $userIdInt = intval($userId);
    $employeeId = intval($snapshot['employee_id'] ?? 0);
    $employeeIdBind = $employeeId > 0 ? $employeeId : null;
    $stmt->bind_param('iiisss', $userIdInt, $employeeIdBind, $userIdInt, $reason, $requestedFieldsJson, $snapshotJson);
    $executed = $stmt->execute();
    $insertId = intval($conn->insert_id);
    $stmt->close();

    if (!$executed) {
        return [
            'success' => false,
            'message' => 'Failed to submit edit access request.',
        ];
    }

    logActivity(
        $conn,
        $userIdInt,
        'request_profile_edit_access',
        'Submitted a profile edit access request for: ' . profileEditSummarizeChangedFields(profileEditGetRequestedFieldLabels($normalizedRequestedFields)) . '.',
        'profile'
    );

    return [
        'success' => true,
        'request_id' => $insertId,
    ];
}

function profileEditListRequestsForReviewer($conn, $viewerRole, $viewerUserId, $viewerBranchId = 0, $archivedOnly = false) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT
                per.*,
                u.username AS requester_username,
                u.first_name AS requester_first_name,
                u.last_name AS requester_last_name,
                u.email,
                u.role AS requester_role,
                u.branch_id,
                b.branch_name,
                approver.username AS approved_by_username,
                approver.first_name AS approved_by_first_name,
                approver.last_name AS approved_by_last_name,
                archiver.username AS archived_by_username,
                archiver.first_name AS archived_by_first_name,
                archiver.last_name AS archived_by_last_name
            FROM profile_edit_request per
            INNER JOIN users u ON u.id = per.user_id
            LEFT JOIN branches b ON b.branch_id = u.branch_id
            LEFT JOIN users approver ON approver.id = per.approved_by
            LEFT JOIN users archiver ON archiver.id = per.archived_by
            WHERE LOWER(TRIM(u.role)) IN ('manager', 'staff')";

    if ($archivedOnly) {
        $sql .= " AND per.archived_at IS NOT NULL";
    } else {
        $sql .= " AND per.archived_at IS NULL";
    }

    // Reviewer listing is admin-only; non-admins receive no queue rows.
    if (profileEditNormalizeRole($viewerRole) !== 'admin') {
        return [];
    }

    $sql .= " ORDER BY
                COALESCE(per.used_at, per.approved_at, per.created_at) DESC,
                per.request_id DESC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return [];

    $stmt->execute();
    $result = $stmt->get_result();
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $normalized = profileEditNormalizeRequestRow($row);
        $canManage = profileEditReviewerCanManageRequest($normalized, $viewerRole, $viewerUserId, $viewerBranchId);
        $normalized['can_approve'] = $canManage && trim((string)($normalized['status'] ?? '')) === 'pending';
        $normalized['can_revoke'] = $canManage
            && trim((string)($normalized['archived_at'] ?? '')) === ''
            && trim((string)($normalized['status'] ?? '')) === 'approved';
        $normalized['can_archive'] = $canManage
            && trim((string)($normalized['archived_at'] ?? '')) === ''
            && trim((string)($normalized['status'] ?? '')) !== 'approved';
        $rows[] = $normalized;
    }
    $stmt->close();

    return $rows;
}

function profileEditBuildReviewSummary($activeRows, $archivedRows) {
    $summary = [
        'pending' => 0,
        'approved' => 0,
        'used' => 0,
        'archived' => count($archivedRows),
    ];

    foreach ($activeRows as $row) {
        $status = strtolower(trim((string)($row['status'] ?? '')));
        if ($status === 'pending') {
            $summary['pending']++;
        } elseif ($status === 'approved') {
            $summary['approved']++;
        } elseif ($status === 'used') {
            $summary['used']++;
        }
    }

    return $summary;
}

function profileEditRejectRequest($conn, $requestId, $reviewerId, $reviewerRole, $reviewerBranchId = 0) {
    $request = profileEditFetchSingleRequest($conn, $requestId);
    if (!$request) {
        return ['success' => false, 'message' => 'Edit request not found.'];
    }

    if (!profileEditReviewerCanManageRequest($request, $reviewerRole, $reviewerId, $reviewerBranchId)) {
        return ['success' => false, 'message' => 'You do not have permission to reject this request.'];
    }

    if (trim((string)($request['archived_at'] ?? '')) !== '') {
        return ['success' => false, 'message' => 'This request is already archived.'];
    }

    if (strtolower(trim((string)($request['status'] ?? ''))) !== 'pending') {
        return ['success' => false, 'message' => 'Only pending requests can be rejected.'];
    }

    $stmt = $conn->prepare(
        "UPDATE profile_edit_request
         SET status = 'rejected',
             approved_by = NULL,
             approved_at = NULL,
             access_granted_until = NULL,
             archived_at = NOW(),
             archived_by = ?
         WHERE request_id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return ['success' => false, 'message' => 'Failed to prepare reject action.'];
    }

    $reviewerIdInt = intval($reviewerId);
    $requestIdInt = intval($requestId);
    $stmt->bind_param('ii', $reviewerIdInt, $requestIdInt);
    $executed = $stmt->execute();
    $stmt->close();

    if (!$executed) {
        return ['success' => false, 'message' => 'Failed to reject the request.'];
    }

    logActivity(
        $conn,
        $reviewerIdInt,
        'reject_profile_edit_request',
        'Rejected profile edit request #' . $requestIdInt . ' for ' . ($request['requester_name'] ?? 'user') . '.',
        'profile'
    );

    return [
        'success' => true,
        'message' => 'Edit request rejected and archived successfully.',
    ];
}

function profileEditRevokeRequest($conn, $requestId, $reviewerId, $reviewerRole, $reviewerBranchId = 0) {
    $request = profileEditFetchSingleRequest($conn, $requestId);
    if (!$request) {
        return ['success' => false, 'message' => 'Edit request not found.'];
    }

    if (!profileEditReviewerCanManageRequest($request, $reviewerRole, $reviewerId, $reviewerBranchId)) {
        return ['success' => false, 'message' => 'You do not have permission to revoke this request.'];
    }

    if (trim((string)($request['archived_at'] ?? '')) !== '') {
        return ['success' => false, 'message' => 'This request is already archived.'];
    }

    if (strtolower(trim((string)($request['status'] ?? ''))) !== 'approved') {
        return ['success' => false, 'message' => 'Only approved requests can be revoked.'];
    }

    $stmt = $conn->prepare(
        "UPDATE profile_edit_request
         SET access_granted_until = NOW(),
             archived_at = NOW(),
             archived_by = ?
         WHERE request_id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return ['success' => false, 'message' => 'Failed to prepare revoke action.'];
    }

    $reviewerIdInt = intval($reviewerId);
    $requestIdInt = intval($requestId);
    $stmt->bind_param('ii', $reviewerIdInt, $requestIdInt);
    $executed = $stmt->execute();
    $stmt->close();

    if (!$executed) {
        return ['success' => false, 'message' => 'Failed to revoke the request.'];
    }

    logActivity(
        $conn,
        $reviewerIdInt,
        'revoke_profile_edit_access',
        'Revoked profile edit access request #' . $requestIdInt . ' for ' . ($request['requester_name'] ?? 'user') . '.',
        'profile'
    );

    return [
        'success' => true,
        'message' => 'Approved edit access was revoked. Any profile changes already saved remain in place.',
    ];
}

function profileEditSendAccessGrantedEmail($email, $fullName, $accessGrantedUntil) {
    $targetEmail = trim((string)$email);
    if ($targetEmail === '' || !filter_var($targetEmail, FILTER_VALIDATE_EMAIL)) {
        return false;
    }

    $displayName = trim((string)$fullName) !== '' ? trim((string)$fullName) : 'User';
    $profileLink = profileEditBuildFrontendBaseUrl() . '/profile';
    $expiryLabel = trim((string)$accessGrantedUntil) !== ''
        ? date('M d, Y h:i A', strtotime((string)$accessGrantedUntil))
        : 'your access window';

    $contentHtml = ''
        . '<h2 style="margin:0 0 12px 0;font-size:18px;line-height:1.4;color:#0f172a;">Edit access approved</h2>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">Hi ' . htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8') . ',</p>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">Your request to edit your profile details has been approved. You can now update your information from the profile page.</p>'
        . '<p style="margin:0 0 18px 0;font-size:14px;line-height:1.7;color:#334155;"><strong>Access valid until:</strong> ' . htmlspecialchars($expiryLabel, ENT_QUOTES, 'UTF-8') . '</p>'
        . '<p style="margin:0 0 18px 0;"><a href="' . htmlspecialchars($profileLink, ENT_QUOTES, 'UTF-8') . '" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;">Open Profile</a></p>'
        . '<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">If you did not request this change, please contact the administrator immediately.</p>';

    $html = buildBrandedEmailLayout($contentHtml, 'Your profile edit access has been approved.');
    $alt = "Hi {$displayName}, your profile edit access has been approved. Access valid until {$expiryLabel}. Open {$profileLink} to update your details.";

    return sendMail($targetEmail, $displayName, 'Profile edit access approved', $html, $alt);
}

function profileEditSendSupervisorUpdateEmail($email, $fullName, $actorName, $actorRole, $changedLabels) {
    $targetEmail = trim((string)$email);
    if ($targetEmail === '' || !filter_var($targetEmail, FILTER_VALIDATE_EMAIL)) {
        return false;
    }

    $displayName = trim((string)$fullName) !== '' ? trim((string)$fullName) : 'User';
    $actorDisplay = trim((string)$actorName) !== '' ? trim((string)$actorName) : 'An administrator';
    $actorRoleLabel = ucfirst(profileEditNormalizeRole($actorRole) ?: 'admin');
    $changeSummary = profileEditSummarizeChangedFields(is_array($changedLabels) ? $changedLabels : []);
    $profileLink = profileEditBuildFrontendBaseUrl() . '/profile';

    $contentHtml = ''
        . '<h2 style="margin:0 0 12px 0;font-size:18px;line-height:1.4;color:#0f172a;">Your details were updated</h2>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">Hi ' . htmlspecialchars($displayName, ENT_QUOTES, 'UTF-8') . ',</p>'
        . '<p style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#334155;">' . htmlspecialchars($actorDisplay, ENT_QUOTES, 'UTF-8') . ' (' . htmlspecialchars($actorRoleLabel, ENT_QUOTES, 'UTF-8') . ') updated your profile or employment details.</p>'
        . '<p style="margin:0 0 18px 0;font-size:14px;line-height:1.7;color:#334155;"><strong>Updated fields:</strong> ' . htmlspecialchars($changeSummary, ENT_QUOTES, 'UTF-8') . '</p>'
        . '<p style="margin:0 0 18px 0;"><a href="' . htmlspecialchars($profileLink, ENT_QUOTES, 'UTF-8') . '" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;">Review Profile</a></p>'
        . '<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">If you were not expecting this update, contact the administrator or your manager.</p>';

    $html = buildBrandedEmailLayout($contentHtml, 'Your profile details were updated.');
    $alt = "Hi {$displayName}, {$actorDisplay} ({$actorRoleLabel}) updated your details. Updated fields: {$changeSummary}. Review {$profileLink}.";

    return sendMail($targetEmail, $displayName, 'Your profile details were updated', $html, $alt);
}

function profileEditApproveRequest($conn, $requestId, $reviewerId, $reviewerRole, $reviewerBranchId = 0, $grantHours = 24) {
    $request = profileEditFetchSingleRequest($conn, $requestId);
    if (!$request) {
        return ['success' => false, 'message' => 'Edit request not found.'];
    }

    if (!profileEditReviewerCanManageRequest($request, $reviewerRole, $reviewerId, $reviewerBranchId)) {
        return ['success' => false, 'message' => 'You do not have permission to approve this request.'];
    }

    if (trim((string)($request['archived_at'] ?? '')) !== '') {
        return ['success' => false, 'message' => 'Archived requests cannot be approved.'];
    }

    if (strtolower(trim((string)($request['status'] ?? ''))) !== 'pending') {
        return ['success' => false, 'message' => 'Only pending requests can be approved.'];
    }

    $hours = max(1, intval($grantHours));
    $accessGrantedUntil = date('Y-m-d H:i:s', time() + ($hours * 3600));

    $stmt = $conn->prepare(
        "UPDATE profile_edit_request
         SET status = 'approved',
             approved_by = ?,
             approved_at = NOW(),
             access_granted_until = ?,
             archived_at = NULL,
             archived_by = NULL
         WHERE request_id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return ['success' => false, 'message' => 'Failed to prepare request approval.'];
    }

    $reviewerIdInt = intval($reviewerId);
    $requestIdInt = intval($requestId);
    $stmt->bind_param('isi', $reviewerIdInt, $accessGrantedUntil, $requestIdInt);
    $executed = $stmt->execute();
    $stmt->close();

    if (!$executed) {
        return ['success' => false, 'message' => 'Failed to approve the request.'];
    }

    logActivity(
        $conn,
        $reviewerIdInt,
        'approve_profile_edit_access',
        'Approved profile edit access request #' . $requestIdInt . ' for ' . ($request['requester_name'] ?? 'user') . '.',
        'profile'
    );

    return [
        'success' => true,
        'message' => 'Edit request approved. The user has been notified.',
        'email_sent' => false,
        'access_granted_until' => $accessGrantedUntil,
        '_notify_email' => $request['email'] ?? '',
        '_notify_name'  => $request['requester_name'] ?? '',
    ];
}

function profileEditArchiveRequest($conn, $requestId, $reviewerId, $reviewerRole, $reviewerBranchId = 0) {
    $request = profileEditFetchSingleRequest($conn, $requestId);
    if (!$request) {
        return ['success' => false, 'message' => 'Edit request not found.'];
    }

    if (!profileEditReviewerCanManageRequest($request, $reviewerRole, $reviewerId, $reviewerBranchId)) {
        return ['success' => false, 'message' => 'You do not have permission to archive this request.'];
    }

    if (trim((string)($request['archived_at'] ?? '')) !== '') {
        return ['success' => false, 'message' => 'This request is already archived.'];
    }

    $stmt = $conn->prepare(
        "UPDATE profile_edit_request
         SET archived_at = NOW(),
             archived_by = ?
         WHERE request_id = ?
         LIMIT 1"
    );
    if (!$stmt) {
        return ['success' => false, 'message' => 'Failed to prepare archive action.'];
    }

    $reviewerIdInt = intval($reviewerId);
    $requestIdInt = intval($requestId);
    $stmt->bind_param('ii', $reviewerIdInt, $requestIdInt);
    $executed = $stmt->execute();
    $stmt->close();

    if (!$executed) {
        return ['success' => false, 'message' => 'Failed to archive the request.'];
    }

    logActivity(
        $conn,
        $reviewerIdInt,
        'archive_profile_edit_request',
        'Archived profile edit request #' . $requestIdInt . ' for ' . ($request['requester_name'] ?? 'user') . '.',
        'profile'
    );

    return [
        'success' => true,
        'message' => 'Edit request archived successfully.',
    ];
}

function profileEditConsumeApprovedAccess($conn, $userId, $usedByUserId, $changedLabels = []) {
    $activeRequest = profileEditActiveAccessRow($conn, $userId);
    if (!$activeRequest) {
        return null;
    }

    $updatedFieldsJson = profileEditJsonEncode(array_values(array_unique(array_filter(array_map('strval', $changedLabels)))));
    $stmt = $conn->prepare(
        "UPDATE profile_edit_request
         SET status = 'used',
             used_at = NOW(),
             used_by = ?,
             updated_fields_json = ?
         WHERE request_id = ?
         LIMIT 1"
    );
    if (!$stmt) return null;

    $usedByInt = intval($usedByUserId);
    $requestIdInt = intval($activeRequest['request_id'] ?? 0);
    $stmt->bind_param('isi', $usedByInt, $updatedFieldsJson, $requestIdInt);
    $stmt->execute();
    $stmt->close();

    logActivity(
        $conn,
        $usedByInt,
        'complete_profile_edit_access',
        'Used approved profile edit access with updated fields: ' . profileEditSummarizeChangedFields($changedLabels) . '.',
        'profile'
    );

    return $requestIdInt;
}

function profileEditRequesterNotificationRows($conn, $userId, $limit = 10) {
    ensureProfileEditRequestTable($conn);

    $sql = "SELECT request_id, status, created_at, approved_at, access_granted_until, used_at
            FROM profile_edit_request
            WHERE user_id = ?
              AND archived_at IS NULL
            ORDER BY updated_at DESC, request_id DESC
            LIMIT ?";

    $stmt = $conn->prepare($sql);
    if (!$stmt) return [];
    $userIdInt = intval($userId);
    $safeLimit = max(1, intval($limit));
    $stmt->bind_param('ii', $userIdInt, $safeLimit);
    $stmt->execute();
    $result = $stmt->get_result();
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $stmt->close();

    return $rows;
}

function profileEditPendingNotificationRows($conn, $viewerRole, $viewerUserId, $viewerBranchId = 0, $limit = 15) {
    $rows = profileEditListRequestsForReviewer($conn, $viewerRole, $viewerUserId, $viewerBranchId, false);
    $pending = array_values(array_filter($rows, function ($row) {
        return strtolower(trim((string)($row['status'] ?? ''))) === 'pending';
    }));
    return array_slice($pending, 0, max(1, intval($limit)));
}

function profileEditUsedNotificationRows($conn, $viewerRole, $viewerUserId, $viewerBranchId = 0, $limit = 15) {
    $rows = profileEditListRequestsForReviewer($conn, $viewerRole, $viewerUserId, $viewerBranchId, false);
    $used = array_values(array_filter($rows, function ($row) {
        return strtolower(trim((string)($row['status'] ?? ''))) === 'used';
    }));
    return array_slice($used, 0, max(1, intval($limit)));
}
