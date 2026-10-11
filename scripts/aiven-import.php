<?php

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

$connection = mysqli_init();
$connection->ssl_set(null, null, getenv('DB_SSL_CA'), null, null);
$connection->options(MYSQLI_OPT_SSL_VERIFY_SERVER_CERT, true);
$connection->real_connect(
    getenv('DB_HOST'),
    getenv('DB_USER'),
    getenv('DB_PASS'),
    getenv('DB_NAME'),
    (int) getenv('DB_PORT'),
    null,
    MYSQLI_CLIENT_SSL
);
$connection->set_charset('utf8mb4');

$tableCount = (int) $connection->query(
    'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()'
)->fetch_row()[0];

$mode = $argv[1] ?? 'inspect';
if ($mode === 'verify') {
    $tableNames = [];
    $tables = $connection->query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name'
    );
    while ($row = $tables->fetch_row()) {
        $tableNames[] = $row[0];
    }

    $rowCounts = [];
    if ($tableNames !== []) {
        $parts = array_map(
            static fn(string $table): string => "SELECT '" . addslashes($table) . "' AS table_name, COUNT(*) AS row_count FROM `"
                . str_replace('`', '``', $table) . '`',
            $tableNames
        );
        $counts = $connection->query(implode(' UNION ALL ', $parts));
        while ($row = $counts->fetch_assoc()) {
            $rowCounts[$row['table_name']] = (int) $row['row_count'];
        }
    }

    $foreignKeys = (int) $connection->query(
        'SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()'
    )->fetch_row()[0];

    echo json_encode([
        'connected' => true,
        'tables' => count($tableNames),
        'foreign_keys' => $foreignKeys,
        'total_rows' => array_sum($rowCounts),
        'nonempty_tables' => array_filter($rowCounts, static fn(int $count): bool => $count > 0),
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
    exit(0);
}

if ($mode === 'reset-partial') {
    if (getenv('DB_NAME') !== 'defaultdb') {
        throw new RuntimeException('Cleanup refused outside the expected defaultdb database.');
    }

    $connection->query('SET FOREIGN_KEY_CHECKS=0');
    $tables = $connection->query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    while ($row = $tables->fetch_row()) {
        $table = str_replace('`', '``', $row[0]);
        $connection->query("DROP TABLE `{$table}`");
    }
    $connection->query('SET FOREIGN_KEY_CHECKS=1');
    echo json_encode(['reset' => true, 'tables' => 0], JSON_THROW_ON_ERROR) . PHP_EOL;
    exit(0);
}

if ($mode !== 'import') {
    echo json_encode([
        'connected' => true,
        'database' => getenv('DB_NAME'),
        'tables' => $tableCount,
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
    exit(0);
}

if ($tableCount !== 0) {
    throw new RuntimeException("Import refused: destination already has {$tableCount} tables.");
}

$sqlPath = dirname(__DIR__) . '/database/Capstone1.sql';
$sql = file_get_contents($sqlPath);
if ($sql === false) {
    throw new RuntimeException('Unable to read the database dump.');
}
$sql = preg_replace('/^\xEF\xBB\xBF/', '', $sql);

$sql = preg_replace(
    '/\ACREATE DATABASE.*?;\s*USE\s+`llb`;\s*/s',
    '',
    $sql,
    1
);
if ($sql === null) {
    throw new RuntimeException('Unable to prepare the database dump.');
}
$sql = preg_replace('/^\s*--.*$/m', '', $sql);
if ($sql === null) {
    throw new RuntimeException('Unable to normalize SQL comments.');
}

/** Split SQL without breaking semicolons embedded in quoted seed data. */
function splitSqlStatements(string $sql): array
{
    $statements = [];
    $buffer = '';
    $quote = null;
    $escaped = false;
    $length = strlen($sql);

    for ($index = 0; $index < $length; $index++) {
        $character = $sql[$index];
        $buffer .= $character;

        if ($escaped) {
            $escaped = false;
            continue;
        }
        if ($quote !== null && $character === '\\') {
            $escaped = true;
            continue;
        }
        if ($quote !== null) {
            if ($character === $quote) {
                $quote = null;
            }
            continue;
        }
        if ($character === "'" || $character === '"' || $character === '`') {
            $quote = $character;
            continue;
        }
        if ($character === ';') {
            $statement = trim(substr($buffer, 0, -1));
            if ($statement !== '') {
                $statements[] = $statement;
            }
            $buffer = '';
        }
    }

    if (trim($buffer) !== '') {
        $statements[] = trim($buffer);
    }

    return $statements;
}

$connection->query('SET FOREIGN_KEY_CHECKS=0');
$statementCount = 0;
$skippedColumns = 0;
foreach (splitSqlStatements($sql) as $statement) {
    $actionSql = preg_replace('/\A(?:\s*--[^\r\n]*(?:\r?\n|$))+/', '', $statement);
    if (preg_match(
        '/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s+(.+)$/is',
        $actionSql ?? $statement,
        $matches
    )) {
        $table = $connection->real_escape_string($matches[1]);
        $column = $connection->real_escape_string($matches[2]);
        $exists = (int) $connection->query(
            "SELECT COUNT(*) FROM information_schema.columns "
            . "WHERE table_schema = DATABASE() AND table_name = '{$table}' AND column_name = '{$column}'"
        )->fetch_row()[0];
        if ($exists > 0) {
            $skippedColumns++;
            continue;
        }
        $statement = "ALTER TABLE `{$matches[1]}` ADD COLUMN `{$matches[2]}` {$matches[3]}";
    }

    $connection->query($statement);
    $statementCount++;
}
$connection->query('SET FOREIGN_KEY_CHECKS=1');

$tableCount = (int) $connection->query(
    'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()'
)->fetch_row()[0];

echo json_encode([
    'connected' => true,
    'imported' => true,
    'statements' => $statementCount,
    'existing_columns_skipped' => $skippedColumns,
    'tables' => $tableCount,
], JSON_THROW_ON_ERROR) . PHP_EOL;
