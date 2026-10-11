<?php

function renewalEnsureColumn($conn, $table, $column, $definition) {
    $dbName = DB_NAME;
    $sql = "SELECT 1
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
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

function ensureClientServiceRenewalSchema($conn) {
    renewalEnsureColumn($conn, 'client_services', 'renewal_required', '`renewal_required` TINYINT(1) NOT NULL DEFAULT 0');
    renewalEnsureColumn($conn, 'client_services', 'expiry_date', '`expiry_date` DATE NULL');
    renewalEnsureColumn($conn, 'client_services', 'last_renewed_at', '`last_renewed_at` DATE NULL');
    renewalEnsureColumn($conn, 'client_services', 'reminder_days_before', '`reminder_days_before` INT NOT NULL DEFAULT 30');
    renewalEnsureColumn($conn, 'client_services', 'renewal_cycle', "`renewal_cycle` VARCHAR(40) NOT NULL DEFAULT 'none'");
    renewalEnsureColumn($conn, 'client_services', 'auto_renew_enabled', '`auto_renew_enabled` TINYINT(1) NOT NULL DEFAULT 0');
    renewalEnsureColumn($conn, 'client_services', 'renewal_notes', '`renewal_notes` TEXT NULL');
    renewalEnsureColumn($conn, 'client_services', 'change_notes', '`change_notes` TEXT NULL');
}

function normalizeRenewalBool($value, $default = false) {
    if (is_bool($value)) return $value;
    if (is_int($value) || is_float($value)) return ((int)$value) !== 0;
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === '') return $default;
        if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) return true;
        if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) return false;
    }
    return $default;
}

function normalizeRenewalText($value) {
    $sanitized = sanitizeInput((string)$value);
    return trim(html_entity_decode((string)$sanitized, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function normalizeRenewalReminderDays($value, $default = 30) {
    $days = intval($value);
    if ($days <= 0) {
        $days = intval($default);
    }
    return max(1, min(3650, $days));
}

function normalizeRenewalCycle($value) {
    $normalized = strtolower(trim((string)$value));
    $allowed = [
        'none',
        'monthly',
        'quarterly',
        'semiannual',
        'annual',
        'biennial',
        'triennial',
    ];

    return in_array($normalized, $allowed, true) ? $normalized : 'none';
}

function getRenewalCycleMonths($cycle) {
    $normalized = normalizeRenewalCycle($cycle);
    if ($normalized === 'monthly') return 1;
    if ($normalized === 'quarterly') return 3;
    if ($normalized === 'semiannual') return 6;
    if ($normalized === 'annual') return 12;
    if ($normalized === 'biennial') return 24;
    if ($normalized === 'triennial') return 36;
    return 0;
}

function getRenewalCycleLabel($cycle) {
    $normalized = normalizeRenewalCycle($cycle);
    if ($normalized === 'monthly') return 'Monthly';
    if ($normalized === 'quarterly') return 'Quarterly';
    if ($normalized === 'semiannual') return 'Semi-Annual';
    if ($normalized === 'annual') return 'Annual';
    if ($normalized === 'biennial') return 'Every 2 Years';
    if ($normalized === 'triennial') return 'Every 3 Years';
    return 'No Cycle';
}

function normalizeRenewalDateOrNull($value, $fieldLabel = 'Date') {
    $raw = trim((string)$value);
    if ($raw === '') {
        return null;
    }

    if (!validateDate($raw)) {
        sendError($fieldLabel . ' must use the YYYY-MM-DD format.', 400);
    }

    return $raw;
}

function addMonthsToRenewalDate($date, $months) {
    $cleanDate = normalizeRenewalDateOrNull($date, 'Renewal date');
    $cleanMonths = max(0, intval($months));
    if ($cleanDate === null || $cleanMonths <= 0) {
        return $cleanDate;
    }

    $nextDate = DateTimeImmutable::createFromFormat('Y-m-d', $cleanDate);
    if (!$nextDate) {
        return $cleanDate;
    }

    return $nextDate->modify('+' . $cleanMonths . ' months')->format('Y-m-d');
}

function getDefaultRenewalSettings() {
    return [
        'renewal_required' => 0,
        'expiry_date' => null,
        'last_renewed_at' => null,
        'reminder_days_before' => 30,
        'renewal_cycle' => 'none',
        'auto_renew_enabled' => 0,
        'renewal_notes' => '',
        'change_notes' => '',
        'selected_checklist_ids' => null,
    ];
}

function normalizeSelectedChecklistIds($value) {
    if ($value === null) return null;

    $decoded = $value;
    if (is_string($value)) {
        $raw = trim($value);
        if ($raw === '') return [];

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) return [];
    }

    if (!is_array($decoded)) return [];

    $ids = [];
    foreach ($decoded as $checklistId) {
        $id = intval($checklistId);
        if ($id > 0) $ids[$id] = true;
    }

    return array_keys($ids);
}

function normalizeRenewalSettingsArray($data, $existing = null) {
    $defaults = is_array($existing) ? array_merge(getDefaultRenewalSettings(), $existing) : getDefaultRenewalSettings();

    $normalized = [
        'renewal_required' => array_key_exists('renewal_required', $data)
            ? (normalizeRenewalBool($data['renewal_required']) ? 1 : 0)
            : intval($defaults['renewal_required']),
        'expiry_date' => array_key_exists('expiry_date', $data)
            ? normalizeRenewalDateOrNull($data['expiry_date'], 'Expiry date')
            : normalizeRenewalDateOrNull($defaults['expiry_date'] ?? null, 'Expiry date'),
        'last_renewed_at' => array_key_exists('last_renewed_at', $data)
            ? normalizeRenewalDateOrNull($data['last_renewed_at'], 'Last renewed date')
            : normalizeRenewalDateOrNull($defaults['last_renewed_at'] ?? null, 'Last renewed date'),
        'reminder_days_before' => array_key_exists('reminder_days_before', $data)
            ? normalizeRenewalReminderDays($data['reminder_days_before'])
            : normalizeRenewalReminderDays($defaults['reminder_days_before'] ?? 30),
        'renewal_cycle' => array_key_exists('renewal_cycle', $data)
            ? normalizeRenewalCycle($data['renewal_cycle'])
            : normalizeRenewalCycle($defaults['renewal_cycle'] ?? 'none'),
        'auto_renew_enabled' => array_key_exists('auto_renew_enabled', $data)
            ? (normalizeRenewalBool($data['auto_renew_enabled']) ? 1 : 0)
            : (normalizeRenewalBool($defaults['auto_renew_enabled'] ?? 0) ? 1 : 0),
        'renewal_notes' => array_key_exists('renewal_notes', $data)
            ? normalizeRenewalText($data['renewal_notes'])
            : normalizeRenewalText($defaults['renewal_notes'] ?? ''),
        'change_notes' => array_key_exists('change_notes', $data)
            ? normalizeRenewalText($data['change_notes'])
            : normalizeRenewalText($defaults['change_notes'] ?? ''),
        'selected_checklist_ids' => array_key_exists('selected_checklist_ids', $data)
            ? normalizeSelectedChecklistIds($data['selected_checklist_ids'])
            : normalizeSelectedChecklistIds($defaults['selected_checklist_ids'] ?? null),
    ];

    if (!empty($data['mark_renewed'])) {
        $renewedAt = normalizeRenewalDateOrNull(
            $data['renewed_at'] ?? $normalized['last_renewed_at'] ?? date('Y-m-d'),
            'Renewed date'
        );
        if ($renewedAt === null) {
            $renewedAt = date('Y-m-d');
        }

        $normalized['last_renewed_at'] = $renewedAt;
        $cycleMonths = getRenewalCycleMonths($normalized['renewal_cycle']);
        if ($normalized['auto_renew_enabled'] && $cycleMonths > 0) {
            $normalized['expiry_date'] = addMonthsToRenewalDate($renewedAt, $cycleMonths);
        } elseif ($normalized['expiry_date'] === null && $cycleMonths > 0) {
            $normalized['expiry_date'] = addMonthsToRenewalDate($renewedAt, $cycleMonths);
        }
    }

    return $normalized;
}

function mapRenewalAssignmentsByServiceId($rawAssignments) {
    $mapped = [];
    if (!is_array($rawAssignments)) {
        return $mapped;
    }

    foreach ($rawAssignments as $key => $entry) {
        if (!is_array($entry)) {
            continue;
        }

        $serviceId = intval($entry['service_id'] ?? $key);
        if ($serviceId <= 0) {
            continue;
        }

        $mapped[$serviceId] = normalizeRenewalSettingsArray($entry);
    }

    return $mapped;
}

function resolveEffectiveRenewalExpiryDate($row) {
    $manualExpiry = normalizeRenewalDateOrNull($row['expiry_date'] ?? null, 'Expiry date');
    if ($manualExpiry !== null) {
        return [$manualExpiry, 'manual'];
    }

    $cycleMonths = getRenewalCycleMonths($row['renewal_cycle'] ?? 'none');
    $autoRenewEnabled = normalizeRenewalBool($row['auto_renew_enabled'] ?? false);
    $lastRenewed = normalizeRenewalDateOrNull($row['last_renewed_at'] ?? null, 'Last renewed date');
    if ($autoRenewEnabled && $lastRenewed !== null && $cycleMonths > 0) {
        return [addMonthsToRenewalDate($lastRenewed, $cycleMonths), 'calculated'];
    }

    return [null, 'missing'];
}

function getRenewalDaysUntilExpiry($expiryDate, $today = null) {
    $effectiveExpiry = normalizeRenewalDateOrNull($expiryDate, 'Expiry date');
    if ($effectiveExpiry === null) {
        return null;
    }

    $todayDate = $today instanceof DateTimeImmutable
        ? $today
        : new DateTimeImmutable(date('Y-m-d'));
    $expiry = DateTimeImmutable::createFromFormat('Y-m-d', $effectiveExpiry);
    if (!$expiry) {
        return null;
    }

    $diff = $todayDate->diff($expiry);
    $days = intval($diff->days ?? 0);
    return $diff->invert ? -$days : $days;
}

function buildClientServiceRenewalSnapshot($row, $today = null) {
    $row = is_array($row) ? $row : [];
    foreach ([
        'client_name',
        'contact_person',
        'email',
        'phone',
        'address',
        'service_name',
        'renewal_notes',
        'change_notes',
    ] as $field) {
        if (isset($row[$field]) && is_string($row[$field])) {
            $row[$field] = html_entity_decode((string)$row[$field], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
    }

    [$effectiveExpiryDate, $expiryDateSource] = resolveEffectiveRenewalExpiryDate($row);
    $renewalRequired = normalizeRenewalBool($row['renewal_required'] ?? false);
    $autoRenewEnabled = normalizeRenewalBool($row['auto_renew_enabled'] ?? false);
    $renewalCycle = normalizeRenewalCycle($row['renewal_cycle'] ?? 'none');
    $reminderDays = normalizeRenewalReminderDays($row['reminder_days_before'] ?? 30);
    $renewalNotes = normalizeRenewalText($row['renewal_notes'] ?? '');
    $changeNotes = normalizeRenewalText($row['change_notes'] ?? '');
    $trackingEnabled = $renewalRequired
        || $autoRenewEnabled
        || $renewalCycle !== 'none'
        || !empty($row['expiry_date'])
        || !empty($row['last_renewed_at'])
        || $renewalNotes !== ''
        || $changeNotes !== '';

    $daysUntilExpiry = getRenewalDaysUntilExpiry($effectiveExpiryDate, $today);
    $status = 'unconfigured';
    $statusLabel = 'Not Tracked';
    $severity = 'low';
    $needsAttention = false;
    $attentionReason = '';

    if ($trackingEnabled) {
        if ($effectiveExpiryDate === null) {
            $status = 'missing_expiry';
            $statusLabel = 'Missing Expiry';
            $severity = 'medium';
            $needsAttention = true;
            $attentionReason = 'Set an expiry date or mark a renewed date with an auto-renew cycle.';
        } elseif ($daysUntilExpiry !== null && $daysUntilExpiry < 0) {
            $status = 'expired';
            $statusLabel = 'Expired';
            $severity = 'high';
            $needsAttention = true;
            $attentionReason = 'This service is already overdue for renewal.';
        } elseif ($daysUntilExpiry !== null && $daysUntilExpiry <= $reminderDays) {
            $status = 'due_soon';
            $statusLabel = $daysUntilExpiry === 0 ? 'Due Today' : 'Due Soon';
            $severity = $daysUntilExpiry !== null && $daysUntilExpiry <= 7 ? 'high' : 'medium';
            $needsAttention = true;
            $attentionReason = 'This service is inside its reminder window.';
        } else {
            $status = 'healthy';
            $statusLabel = 'On Track';
            $severity = 'low';
        }
    }

    $row['client_service_id'] = intval($row['client_service_id'] ?? $row['id'] ?? 0);
    $row['client_id'] = intval($row['client_id'] ?? 0);
    $row['service_id'] = intval($row['service_id'] ?? 0);
    $row['renewal_required'] = $renewalRequired ? 1 : 0;
    $row['auto_renew_enabled'] = $autoRenewEnabled ? 1 : 0;
    $row['renewal_tracking_enabled'] = $trackingEnabled ? 1 : 0;
    $row['renewal_cycle'] = $renewalCycle;
    $row['renewal_cycle_label'] = getRenewalCycleLabel($renewalCycle);
    $row['reminder_days_before'] = $reminderDays;
    $row['renewal_notes'] = $renewalNotes;
    $row['change_notes'] = $changeNotes;
    $row['selected_checklist_ids'] = normalizeSelectedChecklistIds($row['selected_checklist_ids'] ?? null);
    $row['effective_expiry_date'] = $effectiveExpiryDate;
    $row['expiry_date_source'] = $expiryDateSource;
    $row['days_until_expiry'] = $daysUntilExpiry;
    $row['renewal_status'] = $status;
    $row['renewal_status_label'] = $statusLabel;
    $row['renewal_severity'] = $severity;
    $row['needs_attention'] = $needsAttention ? 1 : 0;
    $row['attention_reason'] = $attentionReason;

    return $row;
}

function buildRenewalSummary($items) {
    $summary = [
        'total_assignments' => 0,
        'tracked_count' => 0,
        'attention_count' => 0,
        'expired_count' => 0,
        'due_soon_count' => 0,
        'missing_expiry_count' => 0,
        'auto_renew_count' => 0,
    ];

    if (!is_array($items)) {
        return $summary;
    }

    foreach ($items as $item) {
        if (!is_array($item)) continue;

        $summary['total_assignments'] += 1;
        if (!empty($item['renewal_tracking_enabled'])) {
            $summary['tracked_count'] += 1;
        }
        if (!empty($item['needs_attention'])) {
            $summary['attention_count'] += 1;
        }
        if (($item['renewal_status'] ?? '') === 'expired') {
            $summary['expired_count'] += 1;
        }
        if (($item['renewal_status'] ?? '') === 'due_soon') {
            $summary['due_soon_count'] += 1;
        }
        if (($item['renewal_status'] ?? '') === 'missing_expiry') {
            $summary['missing_expiry_count'] += 1;
        }
        if (!empty($item['auto_renew_enabled'])) {
            $summary['auto_renew_count'] += 1;
        }
    }

    return $summary;
}

