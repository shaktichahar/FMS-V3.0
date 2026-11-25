import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
  var _pgliteClient: PGlite | undefined;
  var _pgliteDrizzleDb: NodePgDatabase<typeof schema> | undefined;
  var _pgliteSchemaReadyPromise: Promise<void> | undefined;
}

const EMBEDDED_SNAPSHOT_PATH = path.resolve(process.cwd(), 'data', 'embedded_db_snapshot.json');

function hasReachableCloudSqlHost(): boolean {
  const sqlHost = process.env.SQL_HOST?.trim();
  if (!sqlHost) return false;
  if (sqlHost.startsWith('/')) {
    try {
      return fs.existsSync(path.join(sqlHost, '.s.PGSQL.5432'));
    } catch {
      return false;
    }
  }
  return true;
}

const useCloudSql = hasReachableCloudSqlHost();
export const isEmbeddedDatabase = !useCloudSql;

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

/**
 * Pure in-memory PGlite instance (lazily created on first DB query).
 * Persistence is handled via atomic JSON snapshots so hard container/dev-server
 * restarts (SIGKILL) can never leave a stale postmaster.pid or corrupt WASM storage.
 */
function getPgliteClient(): PGlite {
  if (!global._pgliteClient) {
    global._pgliteClient = new PGlite();
  }
  return global._pgliteClient;
}

function getEmbeddedDrizzleDb(): NodePgDatabase<typeof schema> {
  if (!global._pgliteDrizzleDb) {
    global._pgliteDrizzleDb = drizzlePglite(getPgliteClient(), {
      schema,
    }) as unknown as NodePgDatabase<typeof schema>;
  }
  return global._pgliteDrizzleDb;
}

const EMBEDDED_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT UNIQUE,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT 'Operations',
  email TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  avatar_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  active_from TIMESTAMP,
  active_until TIMESTAMP,
  deactivated_from TIMESTAMP,
  deactivated_until TIMESTAMP,
  password_hash TEXT,
  password_salt TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'login',
  code_hash TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT 'email,mobile',
  masked_email TEXT,
  masked_mobile TEXT,
  delivery_summary TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_heads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#0F766E',
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_sanctions (
  id TEXT PRIMARY KEY,
  budget_head_id TEXT NOT NULL REFERENCES budget_heads(id) ON DELETE CASCADE,
  sanction_amount DOUBLE PRECISION NOT NULL,
  sanction_date TEXT NOT NULL,
  financial_year TEXT NOT NULL,
  sanction_order_no TEXT NOT NULL,
  sanctioned_by TEXT NOT NULL DEFAULT 'Technical Director RISL',
  notes TEXT NOT NULL DEFAULT '',
  attachment_json TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  budget_head_id TEXT NOT NULL REFERENCES budget_heads(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL DEFAULT 'expense',
  status TEXT NOT NULL DEFAULT 'approved',
  payment_method TEXT NOT NULL DEFAULT 'Cheque',
  date TEXT NOT NULL,
  financial_year TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  cheque_number TEXT,
  cheque_issue_date TEXT,
  sanction_number TEXT,
  sanction_date TEXT,
  payment_sanctioned_by_hod TEXT,
  cheque_attachment_json TEXT,
  sanction_attachment_json TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
`;

export async function ensureDatabaseReady(): Promise<void> {
  if (useCloudSql) return;
  if (!global._pgliteSchemaReadyPromise) {
    global._pgliteSchemaReadyPromise = (async () => {
      try {
        const client = getPgliteClient();
        await client.waitReady;
        await client.exec(EMBEDDED_SCHEMA_DDL);
      } catch (error) {
        global._pgliteSchemaReadyPromise = undefined;
        throw error;
      }
    })();
  }
  return global._pgliteSchemaReadyPromise;
}

export function readEmbeddedSnapshotFromDisk(): unknown | null {
  if (!isEmbeddedDatabase) return null;
  try {
    if (!fs.existsSync(EMBEDDED_SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(EMBEDDED_SNAPSHOT_PATH, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Unable to read embedded DB snapshot from disk; starting fresh:', err);
    return null;
  }
}

export function writeEmbeddedSnapshotToDisk(snapshot: unknown): void {
  if (!isEmbeddedDatabase) return;
  try {
    const dir = path.dirname(EMBEDDED_SNAPSHOT_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${EMBEDDED_SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tmpPath, EMBEDDED_SNAPSHOT_PATH);
  } catch (err) {
    console.error('Failed to persist embedded DB snapshot:', err);
  }
}

const lazyEmbeddedDbProxy = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    const instance = getEmbeddedDrizzleDb();
    const value = Reflect.get(instance as object, prop, receiver);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

export const db: NodePgDatabase<typeof schema> = useCloudSql
  ? drizzlePg(createPool(), { schema })
  : lazyEmbeddedDbProxy;
