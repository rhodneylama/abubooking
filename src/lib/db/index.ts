import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { seedIfEmpty } from "./seed";

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Schema bootstrap. Kept as plain SQL so a fresh checkout runs with no migration
 * step. Mirrors schema.ts; update both together.
 */
const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  work_days TEXT NOT NULL,
  day_start TEXT NOT NULL,
  day_end TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL,
  step_minutes INTEGER,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  max_per_day INTEGER NOT NULL DEFAULT 0,
  blackout_dates TEXT NOT NULL,
  allowed_zips TEXT NOT NULL,
  zapier_webhook_url TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS estimators (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  google_refresh_token TEXT,
  dripjobs_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'human'
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  estimator_id TEXT NOT NULL REFERENCES estimators(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  address TEXT NOT NULL,
  zip TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  dripjobs_status TEXT NOT NULL DEFAULT 'pending',
  dripjobs_detail TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_idem ON bookings(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_no_double ON bookings(estimator_id, start) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_estimator_start ON bookings(estimator_id, start);
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  estimator_id TEXT NOT NULL REFERENCES estimators(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_busy (
  id TEXT PRIMARY KEY,
  estimator_id TEXT NOT NULL REFERENCES estimators(id),
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(BOOTSTRAP_SQL);
  return drizzle(sqlite, { schema });
}

const globalForDb = globalThis as unknown as { __abuDb?: Db };

/** Process wide database handle. Survives Next.js dev hot reloads. */
export function getDb(): Db {
  if (!globalForDb.__abuDb) {
    const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "abu.db");
    const db = openDb(file);
    seedIfEmpty(db);
    globalForDb.__abuDb = db;
  }
  return globalForDb.__abuDb;
}

export { schema };
