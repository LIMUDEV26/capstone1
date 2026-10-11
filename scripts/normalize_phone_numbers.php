<?php

require_once __DIR__ . '/../api/config.php';
require_once __DIR__ . '/../api/utils.php';

$conn = getDBConnection();

function normalizeBranchContactEntry($entry) {
    if (!is_array($entry)) {
        return $entry;
    }

    $type = ($entry['contact_number_type'] ?? 'mobile') === 'telephone' ? 'telephone' : 'mobile';
    $rawNumber = $entry['contact_number'] ?? '';

    if ($type === 'mobile') {
        $normalized = normalizePhilippineMobileNumber($rawNumber);
        if ($normalized !== false && $normalized !== null) {
            $entry['contact_number'] = $normalized;
        }
    }

    return $entry;
}

$clientUpdated = 0;
$employeeUpdated = 0;
$branchUpdated = 0;

$clientResult = $conn->query("SELECT client_id, phone FROM client");
if ($clientResult) {
    while ($row = $clientResult->fetch_assoc()) {
        $normalized = normalizePhilippineMobileNumber($row['phone'] ?? null);
        if ($normalized === false || $normalized === null || $normalized === $row['phone']) {
            continue;
        }

        $stmt = $conn->prepare("UPDATE client SET phone = ? WHERE client_id = ?");
        if ($stmt) {
            $clientId = intval($row['client_id']);
            $stmt->bind_param('si', $normalized, $clientId);
            if ($stmt->execute()) {
                $clientUpdated++;
            }
            $stmt->close();
        }
    }
}

$employeeResult = $conn->query("SELECT employee_id, phone_number FROM employees");
if ($employeeResult) {
    while ($row = $employeeResult->fetch_assoc()) {
        $normalized = normalizePhilippineMobileNumber($row['phone_number'] ?? null);
        if ($normalized === false || $normalized === null || $normalized === $row['phone_number']) {
            continue;
        }

        $stmt = $conn->prepare("UPDATE employees SET phone_number = ? WHERE employee_id = ?");
        if ($stmt) {
            $employeeId = intval($row['employee_id']);
            $stmt->bind_param('si', $normalized, $employeeId);
            if ($stmt->execute()) {
                $employeeUpdated++;
            }
            $stmt->close();
        }
    }
}

$branchResult = $conn->query("SELECT branch_id, contact_info FROM branches");
if ($branchResult) {
    while ($row = $branchResult->fetch_assoc()) {
        $raw = trim((string)($row['contact_info'] ?? ''));
        if ($raw === '' || ($raw[0] !== '{' && $raw[0] !== '[')) {
            continue;
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            continue;
        }

        $updated = false;

        if (isset($decoded['primary']) && is_array($decoded['primary'])) {
            $normalizedPrimary = normalizeBranchContactEntry($decoded['primary']);
            if (($normalizedPrimary['contact_number'] ?? null) !== ($decoded['primary']['contact_number'] ?? null)) {
                $decoded['primary'] = $normalizedPrimary;
                $updated = true;
            }
        }

        if (isset($decoded['additional']) && is_array($decoded['additional'])) {
            foreach ($decoded['additional'] as $index => $contact) {
                $normalizedContact = normalizeBranchContactEntry($contact);
                if (($normalizedContact['contact_number'] ?? null) !== ($contact['contact_number'] ?? null)) {
                    $decoded['additional'][$index] = $normalizedContact;
                    $updated = true;
                }
            }
        }

        if (!$updated) {
            continue;
        }

        $encoded = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded) || $encoded === '') {
            continue;
        }

        $stmt = $conn->prepare("UPDATE branches SET contact_info = ? WHERE branch_id = ?");
        if ($stmt) {
            $branchId = intval($row['branch_id']);
            $stmt->bind_param('si', $encoded, $branchId);
            if ($stmt->execute()) {
                $branchUpdated++;
            }
            $stmt->close();
        }
    }
}

echo "Clients updated: {$clientUpdated}\n";
echo "Employees updated: {$employeeUpdated}\n";
echo "Branches updated: {$branchUpdated}\n";
