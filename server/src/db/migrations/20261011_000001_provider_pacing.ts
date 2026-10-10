// Provider Pacing & Queue: config revision and next-start state.
// The feature remains OFF by default. The migration stores no API keys,
// request payloads, prompts or queues. Safe to run repeatedly (catalog sync).
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_pacing_config (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      config_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_pacing_bucket_state (
      bucket_key TEXT PRIMARY KEY,
      next_eligible_at_ms INTEGER NOT NULL CHECK (next_eligible_at_ms >= 0),
      rule_revision INTEGER NOT NULL CHECK (rule_revision >= 0),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_pacing_next_eligible
      ON provider_pacing_bucket_state (next_eligible_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_provider_pacing_next_eligible;
    DROP TABLE IF EXISTS provider_pacing_bucket_state;
    DROP TABLE IF EXISTS provider_pacing_config;
  `);
}
