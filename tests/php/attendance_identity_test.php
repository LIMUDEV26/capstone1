<?php

require_once __DIR__ . '/../../api/attendance_identity.php';

function expectMatch($condition, $message) {
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

$marie = [
    'employee_id' => 9071,
    'name' => 'Marie M.E.',
    'employee_date_id' => '2',
];
$directory = [
    'by_id' => [9071 => $marie],
    'by_name' => ['marieme' => [$marie]],
    'by_date_id' => ['2' => [$marie]],
];
$externalMappings = ['by_code' => [], 'by_name' => []];

// Marie's source ID 34 intentionally differs from her internal employee ID
// and registered biometric ID. Her unique exact name must link to account 9071.
$firstImport = attendanceResolveImportedEmployee($directory, $externalMappings, [], '34', 'Marie M.E.');
expectMatch(!empty($firstImport['ok']), 'Marie should match by her unique registered name.');
expectMatch(intval($firstImport['employee']['employee_id'] ?? 0) === 9071, 'Marie must retain her internal employee ID.');
expectMatch(($firstImport['method'] ?? '') === 'smart_name_match', 'A differing source ID should use the exact-name match method.');

// Once confirmed, source ID 34 should resolve from the persistent mapping on
// later imports even if the source file changes its name formatting.
$savedMappings = ['34' => [[
    'employee_id' => 9071,
    'match_method' => 'smart_name_match',
]]];
$laterImport = attendanceResolveImportedEmployee($directory, $externalMappings, $savedMappings, '34', 'MARIE M E');
expectMatch(!empty($laterImport['ok']), 'A saved source-ID mapping should resolve a later import.');
expectMatch(intval($laterImport['employee']['employee_id'] ?? 0) === 9071, 'The saved mapping must point to Marie\'s original account.');
expectMatch(($laterImport['method'] ?? '') === 'source_id_mapping', 'Later imports should use the saved source-ID mapping.');

// Ambiguous names must be reviewed, not guessed.
$otherMarie = ['employee_id' => 9072, 'name' => 'Marie M.E.', 'employee_date_id' => '9'];
$ambiguousDirectory = $directory;
$ambiguousDirectory['by_id'][9072] = $otherMarie;
$ambiguousDirectory['by_name']['marieme'][] = $otherMarie;
$ambiguous = attendanceResolveImportedEmployee($ambiguousDirectory, $externalMappings, [], '34', 'Marie M.E.');
expectMatch(empty($ambiguous['ok']), 'Duplicate exact names must be sent to review.');

// If a source ID points to a different registered biometric ID than the
// uploaded name, do not guess which signal is correct.
$otherEmployee = ['employee_id' => 9073, 'name' => 'M.T.D.', 'employee_date_id' => '34'];
$conflictingDirectory = $directory;
$conflictingDirectory['by_id'][9073] = $otherEmployee;
$conflictingDirectory['by_date_id']['34'][] = $otherEmployee;
$conflict = attendanceResolveImportedEmployee($conflictingDirectory, $externalMappings, [], '34', 'Marie M.E.');
expectMatch(empty($conflict['ok']), 'Conflicting employee ID and exact name must be sent to review.');

expectMatch(attendanceNormalizeSourceEmployeeCode('002') !== attendanceNormalizeSourceEmployeeCode('2'), 'Source IDs must preserve leading zeroes.');
echo "Attendance identity tests passed.\n";
