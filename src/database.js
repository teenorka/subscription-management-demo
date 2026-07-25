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
      updated_at TEXT NOT NULL,
      idempotency_key TEXT
    );
  `);

  const columns = database.prepare('PRAGMA table_info(subscriptions)').all();
  if (!columns.some(({ name }) => name === 'idempotency_key')) {
    database.exec('ALTER TABLE subscriptions ADD COLUMN idempotency_key TEXT');
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id
      ON subscriptions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_expiration
      ON subscriptions(status, ends_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_idempotency_key
      ON subscriptions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subscription_renewals (
      idempotency_key TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      previous_ends_at TEXT NOT NULL,
      renewed_ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
    );
  `);

  return database;
}
