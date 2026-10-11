<?php

/**
 * Small mysqli-compatible facade for the existing PHP API when it runs on
 * Supabase PostgreSQL. Local XAMPP development continues to use mysqli.
 */

function llbPostgresUrl(): string {
    return (string)(getenv('POSTGRES_URL') ?: getenv('POSTGRES_URL_NON_POOLING') ?: '');
}

function llbCreatePostgresPdo(): PDO {
    $parts = parse_url(llbPostgresUrl());
    if (!$parts || empty($parts['host']) || empty($parts['path'])) {
        throw new RuntimeException('POSTGRES_URL is missing or invalid.');
    }

    $host = $parts['host'];
    $port = isset($parts['port']) ? (int)$parts['port'] : 5432;
    $database = ltrim((string)$parts['path'], '/');
    $user = isset($parts['user']) ? rawurldecode($parts['user']) : '';
    $password = isset($parts['pass']) ? rawurldecode($parts['pass']) : '';
    $dsn = "pgsql:host={$host};port={$port};dbname={$database};sslmode=require;connect_timeout=15";

    return new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
}

function llbTranslateSql(string $sql): string {
    $sql = str_replace('`', '"', $sql);
    $sql = preg_replace('/\bNOW\s*\(\s*\)/i', 'CURRENT_TIMESTAMP', $sql);
    $sql = preg_replace('/\bCURDATE\s*\(\s*\)/i', 'CURRENT_DATE', $sql);
    $sql = preg_replace('/\bIFNULL\s*\(/i', 'COALESCE(', $sql);
    $sql = preg_replace('/\bUNIX_TIMESTAMP\s*\(\s*([^\)]+)\)/i', 'EXTRACT(EPOCH FROM $1)', $sql);
    $sql = preg_replace_callback(
        '/DATE_(ADD|SUB)\s*\(\s*([^,]+),\s*INTERVAL\s+(\?|\d+)\s+(SECOND|MINUTE|HOUR|DAY|MONTH|YEAR)\s*\)/i',
        function ($m) {
            $operator = strtoupper($m[1]) === 'ADD' ? '+' : '-';
            $quantity = $m[3] === '?' ? 'CAST(? AS integer)' : $m[3];
            return '(' . $m[2] . ' ' . $operator . ' (' . $quantity . " * INTERVAL '1 " . strtolower($m[4]) . "'))";
        },
        $sql
    );
    $formats = [
        '%Y-%m-%d' => 'YYYY-MM-DD', '%Y-%m' => 'YYYY-MM', '%b %Y' => 'Mon YYYY',
        '%Y' => 'YYYY', '%m' => 'MM', '%d' => 'DD',
    ];
    $sql = preg_replace_callback('/DATE_FORMAT\s*\(\s*([^,]+),\s*[\'\"]([^\'\"]+)[\'\"]\s*\)/i', function ($m) use ($formats) {
        $format = $formats[$m[2]] ?? strtr($m[2], ['%Y' => 'YYYY', '%m' => 'MM', '%d' => 'DD', '%b' => 'Mon']);
        return "TO_CHAR({$m[1]}, '{$format}')";
    }, $sql);
    $sql = preg_replace('/\bINSERT\s+IGNORE\s+INTO\b/i', 'INSERT INTO', $sql, -1, $ignoreCount);

    // Schema-guard SQL is only used by MySQL locally, but stripping these
    // clauses makes simple legacy ALTER statements safe if one slips through.
    $sql = preg_replace('/\s+ENGINE\s*=\s*\w+/i', '', $sql);
    $sql = preg_replace('/\s+DEFAULT\s+CHARSET\s*=\s*\w+/i', '', $sql);
    $sql = preg_replace('/\s+COLLATE\s*=\s*\w+/i', '', $sql);
    $sql = preg_replace('/\s+AFTER\s+"?[A-Za-z0-9_]+"?/i', '', $sql);

    if (preg_match('/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i', $sql)) {
        [$insert, $update] = preg_split('/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i', $sql, 2);
        if (preg_match('/INSERT\s+INTO\s+"?settings"?/i', $insert)) {
            $update = preg_replace('/VALUES\s*\(\s*"?([A-Za-z0-9_]+)"?\s*\)/i', 'EXCLUDED."$1"', $update);
            $sql = $insert . ' ON CONFLICT ("setting_key") DO UPDATE SET ' . $update;
        } elseif (preg_match('/INSERT\s+INTO\s+"?active_user_sessions"?/i', $insert)) {
            $update = preg_replace('/VALUES\s*\(\s*"?([A-Za-z0-9_]+)"?\s*\)/i', 'EXCLUDED."$1"', $update);
            $sql = $insert . ' ON CONFLICT ("user_id") DO UPDATE SET ' . $update;
        } else {
            $sql = $insert . ' ON CONFLICT DO NOTHING';
        }
    } elseif (!empty($ignoreCount) && !preg_match('/\bON\s+CONFLICT\b/i', $sql)) {
        $sql .= ' ON CONFLICT DO NOTHING';
    }

    return $sql;
}

final class LlbPgResult {
    private array $rows;
    private int $position = 0;
    public int $num_rows;

    public function __construct(array $rows) {
        $this->rows = $rows;
        $this->num_rows = count($rows);
    }

    public function fetch_assoc() {
        return $this->rows[$this->position++] ?? null;
    }

    public function fetch_row() {
        $row = $this->fetch_assoc();
        return $row === null ? null : array_values($row);
    }

    public function fetch_array($mode = null) {
        $row = $this->fetch_assoc();
        if ($row === null) return null;
        if (defined('MYSQLI_NUM') && $mode === MYSQLI_NUM) return array_values($row);
        if (defined('MYSQLI_BOTH') && $mode === MYSQLI_BOTH) return $row + array_values($row);
        return $row;
    }

    public function fetch_all($mode = null): array {
        if (defined('MYSQLI_NUM') && $mode === MYSQLI_NUM) return array_map('array_values', $this->rows);
        return $this->rows;
    }

    public function free(): void { $this->rows = []; }
}

final class LlbPgStatement {
    private LlbPgConnection $connection;
    private string $sql;
    private array $boundValues = [];
    private array $boundResults = [];
    private ?LlbPgResult $result = null;
    private ?array $fetchRows = null;
    private int $fetchPosition = 0;
    public int $affected_rows = 0;
    public int $errno = 0;
    public string $error = '';

    public function __construct(LlbPgConnection $connection, string $sql) {
        $this->connection = $connection;
        $this->sql = $sql;
    }

    public function bind_param(string $types, &...$values): bool {
        $this->boundValues = &$values;
        return true;
    }

    public function bind_result(&...$values): bool {
        $this->boundResults = &$values;
        return true;
    }

    public function execute(): bool {
        try {
            $statement = $this->connection->pdo()->prepare(llbTranslateSql($this->sql));
            $params = array_map(fn($value) => is_bool($value) ? ($value ? 1 : 0) : $value, $this->boundValues);
            $statement->execute($params);
            $this->affected_rows = $statement->rowCount();
            $this->connection->affected_rows = $this->affected_rows;
            $this->fetchRows = $statement->columnCount() > 0 ? $statement->fetchAll(PDO::FETCH_ASSOC) : [];
            $this->result = new LlbPgResult($this->fetchRows);
            if (preg_match('/^\s*INSERT\b/i', $this->sql)) $this->connection->refreshInsertId();
            $this->error = '';
            $this->errno = 0;
            return true;
        } catch (Throwable $error) {
            $this->error = $error->getMessage();
            $this->errno = $this->connection->mapErrorCode($error);
            $this->connection->recordError($this->error, $this->errno);
            error_log('[Postgres] ' . $this->error . ' SQL=' . $this->sql);
            return false;
        }
    }

    public function get_result(): LlbPgResult { return $this->result ?? new LlbPgResult([]); }

    public function fetch(): bool {
        $row = $this->fetchRows[$this->fetchPosition++] ?? null;
        if ($row === null) return false;
        foreach (array_values($row) as $index => $value) {
            if (array_key_exists($index, $this->boundResults)) $this->boundResults[$index] = $value;
        }
        return true;
    }

    public function close(): bool { $this->result = null; $this->fetchRows = null; return true; }
}

final class LlbPgConnection {
    private PDO $database;
    public string $connect_error = '';
    public string $error = '';
    public int $errno = 0;
    public int $insert_id = 0;
    public int $affected_rows = 0;

    public function __construct() { $this->database = llbCreatePostgresPdo(); }
    public function pdo(): PDO { return $this->database; }
    public function set_charset(string $charset): bool { return true; }
    public function close(): bool { return true; }
    public function real_escape_string(string $value): string { return substr($this->database->quote($value), 1, -1); }
    public function begin_transaction(): bool { return $this->database->beginTransaction(); }
    public function commit(): bool { return $this->database->commit(); }
    public function rollback(): bool { return $this->database->rollBack(); }

    public function prepare(string $sql) {
        return new LlbPgStatement($this, $sql);
    }

    public function query(string $sql) {
        try {
            if (preg_match('/^\s*SHOW\s+TABLES\s+LIKE\s+[\'\"]([^\'\"]+)[\'\"]/i', $sql, $match)) {
                $statement = $this->database->prepare("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ?");
                $statement->execute([$match[1]]);
            } else {
                $statement = $this->database->query(llbTranslateSql($sql));
            }
            $this->affected_rows = $statement->rowCount();
            $rows = $statement->columnCount() > 0 ? $statement->fetchAll(PDO::FETCH_ASSOC) : [];
            if (preg_match('/^\s*INSERT\b/i', $sql)) $this->refreshInsertId();
            $this->error = '';
            $this->errno = 0;
            return new LlbPgResult($rows);
        } catch (Throwable $error) {
            $this->recordError($error->getMessage(), $this->mapErrorCode($error));
            error_log('[Postgres] ' . $this->error . ' SQL=' . $sql);
            return false;
        }
    }

    public function refreshInsertId(): void {
        try { $this->insert_id = (int)$this->database->query('SELECT LASTVAL()')->fetchColumn(); }
        catch (Throwable $ignored) { $this->insert_id = 0; }
    }

    public function mapErrorCode(Throwable $error): int {
        return str_contains($error->getMessage(), 'unique constraint') ? 1062 : 1;
    }

    public function recordError(string $message, int $code): void {
        $this->error = $message;
        $this->errno = $code;
    }
}

final class LlbPgSessionHandler implements SessionHandlerInterface, SessionUpdateTimestampHandlerInterface {
    private PDO $database;
    public function __construct() { $this->database = llbCreatePostgresPdo(); }
    public function open(string $path, string $name): bool { return true; }
    public function close(): bool { return true; }
    public function read(string $id): string|false {
        $statement = $this->database->prepare('SELECT payload FROM public.php_sessions WHERE session_id = ? AND expires_at > CURRENT_TIMESTAMP');
        $statement->execute([$id]);
        $value = $statement->fetchColumn();
        return $value === false ? '' : (string)$value;
    }
    public function write(string $id, string $data): bool {
        $ttl = max(1440, (int)ini_get('session.gc_maxlifetime'));
        $statement = $this->database->prepare("INSERT INTO public.php_sessions (session_id, payload, expires_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP + (? * INTERVAL '1 second'), CURRENT_TIMESTAMP) ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at, updated_at = CURRENT_TIMESTAMP");
        return $statement->execute([$id, $data, $ttl]);
    }
    public function destroy(string $id): bool {
        $statement = $this->database->prepare('DELETE FROM public.php_sessions WHERE session_id = ?');
        return $statement->execute([$id]);
    }
    public function gc(int $max_lifetime): int|false {
        return $this->database->exec('DELETE FROM public.php_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    }
    public function validateId(string $id): bool {
        $statement = $this->database->prepare('SELECT 1 FROM public.php_sessions WHERE session_id = ? AND expires_at > CURRENT_TIMESTAMP');
        $statement->execute([$id]);
        return (bool)$statement->fetchColumn();
    }
    public function updateTimestamp(string $id, string $data): bool { return $this->write($id, $data); }
}

