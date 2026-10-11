<?php

require_once 'config.php';
require_once 'utils.php';
require_once 'edit_request_utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

requireAuth();
ensureProfileEditRequestTable($conn);

$currentUserId = intval($_SESSION['user_id'] ?? 0);
$currentRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
$currentBranchId = profileEditResolveBranchId($conn, $currentUserId);

if ($currentUserId <= 0) {
    sendError('Authentication required.', 401);
}

switch ($method) {
    case 'GET':
        $action = strtolower(trim((string)($_GET['action'] ?? '')));
        if ($action === 'my-access') {
            $status = profileEditGetSelfAccessStatus($conn, $currentUserId);
            sendResponse(true, [
                'eligible' => in_array($currentRole, ['manager', 'staff'], true),
                'active_access' => $status['active_access'] ?? null,
                'pending_request' => $status['pending_request'] ?? null,
                'latest_request' => $status['latest_request'] ?? null,
            ], 'Edit access status retrieved successfully.');
        }

        // Management queue is admin-only. Managers/staff may still request via POST.
        if ($currentRole !== 'admin') {
            sendError('Only administrators can manage profile edit requests.', 403);
        }

        $activeRows = profileEditListRequestsForReviewer($conn, $currentRole, $currentUserId, $currentBranchId, false);
        $archivedRows = profileEditListRequestsForReviewer($conn, $currentRole, $currentUserId, $currentBranchId, true);
        $summary = profileEditBuildReviewSummary($activeRows, $archivedRows);

        sendResponse(true, [
            'summary' => $summary,
            'active_items' => $activeRows,
            'archived_items' => $archivedRows,
        ], 'Edit requests retrieved successfully.');
        break;

    case 'POST':
        if (!in_array($currentRole, ['manager', 'staff'], true)) {
            sendError('Only manager and staff accounts can request edit access.', 403);
        }

        $data = getJSONInput();
        $requestReason = trim((string)($data['request_reason'] ?? ''));
        $requestedFields = is_array($data['requested_fields'] ?? null) ? $data['requested_fields'] : [];
        $created = profileEditCreateRequest($conn, $currentUserId, $requestReason, $requestedFields);
        if (empty($created['success'])) {
            sendError((string)($created['message'] ?? 'Failed to submit edit request.'), 400);
        }

        sendResponse(true, [
            'request_id' => intval($created['request_id'] ?? 0),
        ], 'Edit access request submitted successfully.', 201);
        break;

    case 'PUT':
        if ($currentRole !== 'admin') {
            sendError('Only administrators can manage profile edit requests.', 403);
        }

        $data = getJSONInput();
        $requestId = intval($data['request_id'] ?? 0);
        $action = strtolower(trim((string)($data['action'] ?? '')));
        if ($requestId <= 0) {
            sendError('Request ID is required.', 400);
        }

        if ($action === 'approve') {
            $result = profileEditApproveRequest($conn, $requestId, $currentUserId, $currentRole, $currentBranchId, 24);
        } elseif ($action === 'reject') {
            $result = profileEditRejectRequest($conn, $requestId, $currentUserId, $currentRole, $currentBranchId);
        } elseif ($action === 'revoke') {
            $result = profileEditRevokeRequest($conn, $requestId, $currentUserId, $currentRole, $currentBranchId);
        } elseif ($action === 'archive') {
            $result = profileEditArchiveRequest($conn, $requestId, $currentUserId, $currentRole, $currentBranchId);
        } else {
            sendError('Unsupported action.', 400);
        }

        if (empty($result['success'])) {
            sendError((string)($result['message'] ?? 'Failed to update edit request.'), 400);
        }

        $notifyEmail          = (string)($result['_notify_email'] ?? '');
        $notifyName           = (string)($result['_notify_name'] ?? '');
        $accessGrantedUntil   = $result['access_granted_until'] ?? null;

        sendResponseAndContinue(true, [
            'request_id'          => $requestId,
            'email_sent'          => false,
            'access_granted_until' => $accessGrantedUntil,
        ], (string)($result['message'] ?? 'Edit request updated successfully.'), 200, function () use ($notifyEmail, $notifyName, $accessGrantedUntil) {
            if ($notifyEmail !== '') {
                profileEditSendAccessGrantedEmail($notifyEmail, $notifyName, (string)$accessGrantedUntil);
            }
        });
        break;

    default:
        sendError('Method not allowed', 405);
}
