<?php
/** Pure identity matching helpers for attendance imports. */

function attendanceNormalizeIdentityValue($value) {
    $normalized = preg_replace('/\\s+/', ' ', trim((string)$value));
    return is_string($normalized) ? $normalized : '';
}

function attendanceNormalizeIdentityKey($value) {
    $normalized = strtolower(attendanceNormalizeIdentityValue($value));
    $normalized = preg_replace('/[^a-z0-9]+/', '', $normalized);
    return is_string($normalized) ? $normalized : '';
}

/** Preserve meaningful punctuation and leading zeroes in device IDs. */
function attendanceNormalizeSourceEmployeeCode($value) {
    $normalized = strtoupper(attendanceNormalizeIdentityValue($value));
    return is_string($normalized) ? $normalized : '';
}

function attendanceBuildResolvedEmployeeMatch($employee, $method, $label, $confidence, $signals) {
    $signals = array_values(array_filter(array_map(
        static fn($signal) => trim((string)$signal),
        is_array($signals) ? $signals : []
    )));
    return [
        'ok' => true,
        'employee' => $employee,
        'method' => $method,
        'label' => $label,
        'confidence' => round(max(0, min(1, floatval($confidence))), 2),
        'signals' => $signals,
        'signal_summary' => implode('; ', $signals),
    ];
}

function attendanceResolveBase44MappedEmployee($employeeDirectory, $mappings, $method, $label, $fieldLabel) {
    if (!is_array($mappings) || empty($mappings)) return null;

    $employeeIds = [];
    $bestMapping = null;
    $bestConfidence = -1;
    foreach ($mappings as $mapping) {
        if (!is_array($mapping)) continue;
        $employeeId = intval($mapping['employee_id'] ?? 0);
        if ($employeeId <= 0) continue;
        $employeeIds[$employeeId] = true;
        $confidence = floatval($mapping['confidence_score'] ?? 1);
        if ($bestMapping === null || $confidence > $bestConfidence) {
            $bestMapping = $mapping;
            $bestConfidence = $confidence;
        }
    }
    if ($bestMapping === null || count($employeeIds) !== 1) return null;

    $employeeId = intval($bestMapping['employee_id'] ?? 0);
    if (!isset($employeeDirectory['by_id'][$employeeId])) return null;
    $signals = ['Confirmed external identity mapping via ' . $fieldLabel];
    $externalName = attendanceNormalizeIdentityValue($bestMapping['external_employee_name'] ?? '');
    if ($externalName !== '') $signals[] = 'Mapped external name "' . $externalName . '"';
    return attendanceBuildResolvedEmployeeMatch(
        $employeeDirectory['by_id'][$employeeId],
        $method,
        $label,
        max(0.95, min(1, $bestConfidence > 0 ? $bestConfidence : 1)),
        $signals
    );
}

function attendanceResolveImportedEmployee($employeeDirectory, $externalMappings, $sourceMappings, $externalEmployeeCode, $externalEmployeeName) {
    $externalEmployeeCode = attendanceNormalizeIdentityValue($externalEmployeeCode);
    $externalEmployeeName = attendanceNormalizeIdentityValue($externalEmployeeName);
    $codeKey = attendanceNormalizeSourceEmployeeCode($externalEmployeeCode);
    $nameKey = attendanceNormalizeIdentityKey($externalEmployeeName);
    $nameMatches = $nameKey !== '' ? ($employeeDirectory['by_name'][$nameKey] ?? []) : [];
    // The employee directory indexes biometric IDs with the identity-key
    // normalizer (which removes punctuation), while saved device mappings
    // deliberately preserve source-code formatting and leading zeroes.
    $idKey = attendanceNormalizeIdentityKey($externalEmployeeCode);
    $idMatches = $idKey !== '' ? ($employeeDirectory['by_date_id'][$idKey] ?? []) : [];

    if ($codeKey !== '') {
        $localMatches = $sourceMappings[$codeKey] ?? [];
        $localEmployeeIds = [];
        foreach ($localMatches as $mapping) {
            $localEmployeeIds[intval($mapping['employee_id'] ?? 0)] = true;
        }
        if (count($localEmployeeIds) > 1) {
            return ['ok' => false, 'message' => 'This source ID is mapped to multiple employee accounts. An administrator must review it.'];
        }
        if (count($localEmployeeIds) === 1) {
            $employeeId = intval(array_key_first($localEmployeeIds));
            if (!isset($employeeDirectory['by_id'][$employeeId])) {
                return ['ok' => false, 'message' => 'The saved source-ID mapping points to an employee who is no longer active. Review this row before importing.'];
            }
            $employee = $employeeDirectory['by_id'][$employeeId];
            if (($localMatches[0]['match_method'] ?? '') !== 'manual_review'
                && count($nameMatches) === 1 && intval($nameMatches[0]['employee_id']) !== $employeeId) {
                return ['ok' => false, 'message' => 'The saved source-ID mapping and uploaded name point to different employees. Review this row before importing.'];
            }
            return attendanceBuildResolvedEmployeeMatch($employee, 'source_id_mapping', 'Saved source ID matched', 1.0, [
                'Previously confirmed source ID ' . $externalEmployeeCode . ' maps to employee #' . $employeeId,
            ]);
        }
    }

    // Optional external mappings are consulted only when they resolve to one
    // registered account; conflicts with an exact employee name go to review.
    $externalCodeMatch = $codeKey !== ''
        ? attendanceResolveBase44MappedEmployee($employeeDirectory, $externalMappings['by_code'][attendanceNormalizeIdentityKey($externalEmployeeCode)] ?? [], 'external_id_mapping', 'Confirmed external ID mapping matched', 'EmployeeID')
        : null;
    $externalNameMatch = $nameKey !== ''
        ? attendanceResolveBase44MappedEmployee($employeeDirectory, $externalMappings['by_name'][$nameKey] ?? [], 'external_name_mapping', 'Confirmed external name mapping matched', 'EmployeeName')
        : null;

    if ($externalCodeMatch && $externalNameMatch
        && intval($externalCodeMatch['employee']['employee_id']) !== intval($externalNameMatch['employee']['employee_id'])) {
        return ['ok' => false, 'message' => 'Confirmed source-ID and name mappings point to different employees. Review this row before importing.'];
    }
    $externalMatch = $externalCodeMatch ?: $externalNameMatch;
    if ($externalMatch) {
        if (count($nameMatches) === 1 && intval($nameMatches[0]['employee_id']) !== intval($externalMatch['employee']['employee_id'])) {
            return ['ok' => false, 'message' => 'The confirmed source mapping conflicts with the registered employee name. Review this row before importing.'];
        }
        return $externalMatch;
    }

    if (count($nameMatches) === 1) {
        $employee = $nameMatches[0];
        if (count($idMatches) === 1 && intval($idMatches[0]['employee_id']) !== intval($employee['employee_id'])) {
            return ['ok' => false, 'message' => 'The uploaded ID matches a different employee than the uploaded name. Review this row before importing.'];
        }
        $sameId = count($idMatches) === 1;
        return attendanceBuildResolvedEmployeeMatch(
            $employee,
            $sameId ? 'employee_date_id_match' : 'smart_name_match',
            $sameId ? 'Biometric ID and employee name matched' : 'Exact employee name matched; source ID differs',
            $sameId ? 1.0 : 0.96,
            [$sameId
                ? 'EmployeeID and EmployeeName matched the same registered account'
                : 'Unique exact employee name matched registered employee #' . intval($employee['employee_id']) . ' despite a different source ID ' . $externalEmployeeCode]
        );
    }

    if ($externalEmployeeCode === '' && count($nameMatches) === 1) {
        return attendanceBuildResolvedEmployeeMatch($nameMatches[0], 'smart_name_match', 'Exact employee name matched', 0.96, [
            'Unique exact employee name matched registered employee #' . intval($nameMatches[0]['employee_id']),
        ]);
    }
    if (count($idMatches) > 1) {
        return ['ok' => false, 'message' => 'The source ID matches multiple employee accounts. Review this row before importing.'];
    }
    if (count($nameMatches) > 1) {
        return ['ok' => false, 'message' => 'The uploaded name matches multiple registered employees. Review this row and select the correct account.'];
    }
    if ($externalEmployeeCode === '' && $externalEmployeeName === '') {
        return ['ok' => false, 'message' => 'The row has no employee ID or name to identify an existing employee. Review it before importing.'];
    }
    return ['ok' => false, 'message' => 'No active employee uniquely matches this source ID and name. Select an existing employee in import review; no employee account was created.'];
}
