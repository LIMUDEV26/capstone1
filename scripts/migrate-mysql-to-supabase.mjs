import fs from "node:fs";
import mysql from "mysql2/promise";
import pg from "pg";

const { Client } = pg;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    }
    process.env[match[1]] = value;
  }
}

loadEnv(".env.local");

const sourceDatabase = process.env.MYSQL_DATABASE || "llb";
const connectionString = process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
if (!connectionString) throw new Error("POSTGRES_URL_NON_POOLING or POSTGRES_URL is required");

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

function postgresType(column) {
  const type = column.DATA_TYPE.toLowerCase();
  const raw = column.COLUMN_TYPE.toLowerCase();
  const unsigned = raw.includes("unsigned");
  switch (type) {
    case "tinyint": return "smallint";
    case "smallint": return unsigned ? "integer" : "smallint";
    case "mediumint": return "integer";
    case "int": return unsigned ? "bigint" : "integer";
    case "bigint": return unsigned ? "numeric(20,0)" : "bigint";
    case "decimal": case "numeric": return `numeric(${column.NUMERIC_PRECISION || 10},${column.NUMERIC_SCALE || 0})`;
    case "float": return "real";
    case "double": return "double precision";
    case "date": return "date";
    case "datetime": case "timestamp": return "timestamp without time zone";
    case "time": return "time without time zone";
    case "year": return "smallint";
    case "json": return "jsonb";
    case "binary": case "varbinary": case "tinyblob": case "blob": case "mediumblob": case "longblob": return "bytea";
    case "char": return `char(${column.CHARACTER_MAXIMUM_LENGTH || 1})`;
    case "varchar": return `varchar(${column.CHARACTER_MAXIMUM_LENGTH || 255})`;
    case "enum": case "set": case "tinytext": case "text": case "mediumtext": case "longtext": return "text";
    case "bit": return "bit varying";
    default: return "text";
  }
}

function postgresDefault(column) {
  const value = column.COLUMN_DEFAULT;
  if (value === null || value === undefined) return "";
  const upper = String(value).toUpperCase();
  if (upper === "NULL") return "";
  if (upper === "CURRENT_TIMESTAMP" || upper.startsWith("CURRENT_TIMESTAMP(")) return " DEFAULT CURRENT_TIMESTAMP";
  if (/^-?\d+(\.\d+)?$/.test(String(value)) && !["char", "varchar", "text", "enum", "set"].includes(column.DATA_TYPE)) {
    return ` DEFAULT ${value}`;
  }
  if (column.DATA_TYPE === "json" && String(value).toLowerCase() === "null") return "";
  const stringValue = String(value).startsWith("'") && String(value).endsWith("'")
    ? String(value).slice(1, -1).replaceAll("''", "'")
    : String(value);
  return ` DEFAULT '${stringValue.replaceAll("'", "''")}'`;
}

function normalizeValue(value, column) {
  if (value === null || value === undefined) return null;
  if (["date", "datetime", "timestamp"].includes(column.DATA_TYPE) && /^0000-00-00/.test(String(value))) return null;
  if (column.DATA_TYPE === "year") return Number(value);
  if (column.DATA_TYPE === "json" && typeof value !== "string") return JSON.stringify(value);
  return value;
}

const mysqlDb = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: sourceDatabase,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

const postgresUrl = new URL(connectionString);
postgresUrl.searchParams.delete("sslmode");
const postgres = new Client({
  connectionString: postgresUrl.toString(),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
});
await postgres.connect();

try {
  const [tables] = await mysqlDb.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [sourceDatabase],
  );
  const tableNames = tables.map((row) => row.TABLE_NAME);
  console.log(`Migrating ${tableNames.length} tables from MySQL to Supabase...`);

  const schema = new Map();
  for (const table of tableNames) {
    const [columns] = await mysqlDb.query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
              CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, ORDINAL_POSITION
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [sourceDatabase, table],
    );
    const [indexes] = await mysqlDb.query(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [sourceDatabase, table],
    );
    schema.set(table, { columns, indexes });
  }

  await postgres.query("BEGIN");
  await postgres.query("SET client_min_messages TO warning");
  for (const table of [...tableNames].reverse()) {
    await postgres.query(`DROP TABLE IF EXISTS public.${quote(table)} CASCADE`);
  }

  for (const table of tableNames) {
    const { columns, indexes } = schema.get(table);
    const primaryColumns = indexes.filter((idx) => idx.INDEX_NAME === "PRIMARY").map((idx) => quote(idx.COLUMN_NAME));
    const definitions = columns.map((column) => {
      const isIdentity = String(column.EXTRA).includes("auto_increment");
      const identity = isIdentity ? " GENERATED BY DEFAULT AS IDENTITY" : "";
      const nullable = column.IS_NULLABLE === "NO" ? " NOT NULL" : "";
      const type = isIdentity && postgresType(column).startsWith("numeric") ? "bigint" : postgresType(column);
      return `${quote(column.COLUMN_NAME)} ${type}${identity}${postgresDefault(column)}${nullable}`;
    });
    if (primaryColumns.length) definitions.push(`PRIMARY KEY (${primaryColumns.join(", ")})`);
    await postgres.query(`CREATE TABLE public.${quote(table)} (\n  ${definitions.join(",\n  ")}\n)`);
  }

  for (const table of tableNames) {
    const { columns, indexes } = schema.get(table);
    const [rows] = await mysqlDb.query(`SELECT * FROM \`${table.replaceAll("`", "``")}\``);
    const names = columns.map((column) => column.COLUMN_NAME);
    for (let offset = 0; offset < rows.length; offset += 250) {
      const batch = rows.slice(offset, offset + 250);
      const values = [];
      const tuples = batch.map((row) => {
        const params = names.map((name) => {
          values.push(normalizeValue(row[name], columns.find((column) => column.COLUMN_NAME === name)));
          return `$${values.length}`;
        });
        return `(${params.join(",")})`;
      });
      await postgres.query(
        `INSERT INTO public.${quote(table)} (${names.map(quote).join(",")}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(",")}`,
        values,
      );
    }

    const grouped = new Map();
    for (const index of indexes.filter((idx) => idx.INDEX_NAME !== "PRIMARY")) {
      if (!grouped.has(index.INDEX_NAME)) grouped.set(index.INDEX_NAME, []);
      grouped.get(index.INDEX_NAME).push(index);
    }
    for (const [indexName, parts] of grouped) {
      const unique = Number(parts[0].NON_UNIQUE) === 0 ? "UNIQUE " : "";
      const safeName = `${table}_${indexName}`.slice(0, 63);
      await postgres.query(`CREATE ${unique}INDEX ${quote(safeName)} ON public.${quote(table)} (${parts.map((p) => quote(p.COLUMN_NAME)).join(",")})`);
    }

    const identityColumn = columns.find((column) => String(column.EXTRA).includes("auto_increment"));
    if (identityColumn && rows.length) {
      await postgres.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quote(identityColumn.COLUMN_NAME)}) FROM public.${quote(table)}), 1), true)`,
        [`public.${table}`, identityColumn.COLUMN_NAME],
      );
    }
    console.log(`  ${table}: ${rows.length} rows`);
  }

  const [foreignKeys] = await mysqlDb.query(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
            r.UPDATE_RULE, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.CONSTRAINT_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [sourceDatabase],
  );
  const constraints = new Map();
  for (const fk of foreignKeys) {
    const key = `${fk.TABLE_NAME}\0${fk.CONSTRAINT_NAME}`;
    if (!constraints.has(key)) constraints.set(key, []);
    constraints.get(key).push(fk);
  }
  for (const parts of constraints.values()) {
    const first = parts[0];
    const constraintName = `${first.TABLE_NAME}_${first.CONSTRAINT_NAME}`.slice(0, 63);
    await postgres.query(
      `ALTER TABLE public.${quote(first.TABLE_NAME)} ADD CONSTRAINT ${quote(constraintName)} FOREIGN KEY (${parts.map((p) => quote(p.COLUMN_NAME)).join(",")}) REFERENCES public.${quote(first.REFERENCED_TABLE_NAME)} (${parts.map((p) => quote(p.REFERENCED_COLUMN_NAME)).join(",")}) ON UPDATE ${first.UPDATE_RULE} ON DELETE ${first.DELETE_RULE} NOT VALID`,
    );
  }

  await postgres.query(`CREATE TABLE public.php_sessions (
    session_id varchar(128) PRIMARY KEY,
    payload text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
  )`);
  await postgres.query("CREATE INDEX php_sessions_expires_at_idx ON public.php_sessions (expires_at)");

  for (const table of [...tableNames, "php_sessions"]) {
    await postgres.query(`ALTER TABLE public.${quote(table)} ENABLE ROW LEVEL SECURITY`);
    await postgres.query(`REVOKE ALL ON TABLE public.${quote(table)} FROM anon, authenticated`);
  }
  await postgres.query("COMMIT");
  console.log("Migration completed successfully.");
} catch (error) {
  await postgres.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await mysqlDb.end();
  await postgres.end();
}
