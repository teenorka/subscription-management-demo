import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export function createDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('basic', 'pro')),
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id
      ON subscriptions(customer_id);
  `);

  return database;
}
