<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();

requireAuth();
requireRole(['admin']);

switch ($method) {
    case 'GET':
        handleGetRoleFeatureAccess($conn);
        break;
    case 'PUT':
        handleUpdateRoleFeatureAccess($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function buildRoleFeatureAccessPayload($conn) {
    return [
        'catalog' => getRoleFeatureAccessCatalog(),
        'roles' => [
            'manager' => getRoleFeatureAccessMap('manager', $conn),
            'staff' => getRoleFeatureAccessMap('staff', $conn),
        ],
    ];
}

function handleGetRoleFeatureAccess($conn) {
    sendResponse(true, buildRoleFeatureAccessPayload($conn), 'Role feature access retrieved.');
}

function handleUpdateRoleFeatureAccess($conn) {
    $data = getJSONInput();
    $role = strtolower(trim((string)($data['role'] ?? '')));
    $featureAccess = $data['feature_access'] ?? null;

    if (!in_array($role, ['manager', 'staff'], true)) {
        sendError('Role must be manager or staff.', 400);
    }
    if (!is_array($featureAccess)) {
        sendError('feature_access must be an object.', 400);
    }

    saveRoleFeatureAccessMap($conn, $role, $featureAccess);
    sendResponse(true, buildRoleFeatureAccessPayload($conn), 'Role feature access updated.');
}
