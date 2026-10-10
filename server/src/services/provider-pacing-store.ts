/**
 * Stage 3: SQLite persistence for the opt-in Provider Pacing & Queue.
 *
 * Configuration is ALWAYS disabled on a fresh database. A saved enabled
 * configuration cannot start traffic in this stage: runtime activation is
 * intentionally gated until multi-process and E2E verification is complete.
 */
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import {
  validatePacingConfig, type PacingConfig, type PacingStartStore,
} from './provider-pacing-core.js';

export const PROVIDER_PACING_SCHEMA_VERSION = 1;
export const DEFAULT_PROVIDER_PACING_CONFIG: PacingConfig = {
  enabled: false,
  maxPendingGlobal: 200,
  maxPendingPerClient: 10,
  rules: [],
};

const finiteId = z.string().min(1).max(180);
const positive = z.number().int().positive();
const matchSchema = z.object({
  platform: finiteId.optional(),
  modelId: finiteId.optional(),
  keyId: z.number().int().nonnegative().optional(),
  endpointScope: z.string().max(512).optional(),
  accountId: finiteId.optional(),
  quotaPoolId: finiteId.optional(),
}).strict();

const ruleSchema = z.object({
  id: finiteId,
  enabled: z.boolean(),
  scope: z.enum(['global', 'provider', 'model', 'key', 'model-key', 'account', 'pool']),
  match: matchSchema.optional(),
  limits: z.object({
    minStartIntervalMs: positive.max(86400000).optional(),
    rpm: positive.max(100000).optional(),
    tpm: positive.max(1000000000).optional(),
    maxConcurrent: positive.max(10000).optional(),
  }).strict(),
  queue: z.object({
    maxWaitMs: positive.max(600000),
    maxPendingPerBucket: positive.max(1000),
  }).strict(),
}).strict();

export const providerPacingConfigSchema = z.object({
  enabled: z.boolean(),
  maxPendingGlobal: positive.max(1000),
  maxPendingPerClient: positive.max(100),
  rules: z.array(ruleSchema).max(200),
}).strict();

export interface SavedProviderPacingConfig {
  schemaVersion: number;
  revision: number;
  config: PacingConfig;
  updatedAtMs: number | null;
  updatedBy: string | null;
}

export class PacingConfigurationError extends Error {
  constructor(public readonly code: 'invalid_policy' | 'revision_conflict' | 'pacing_not_ready') {
    super(code);
  }
}

export function parseProviderPacingConfig(raw: unknown): PacingConfig {
  const parsed = providerPacingConfigSchema.safeParse(raw);
  if (!parsed.success) throw new PacingConfigurationError('invalid_policy');
  // Zod validates the shape, core checks scope identity, duplicate rule IDs,
  // and all cross-field limitations. No permissive fallback on error.
  const config = parsed.data as PacingConfig;
  try { validatePacingConfig(config); }
  catch { throw new PacingConfigurationError('invalid_policy'); }
  return config;
}

export function readProviderPacingConfig(db: Db = getDb()): SavedProviderPacingConfig {
  const row = db.prepare(
    'SELECT schema_version, revision, config_json, updated_at_ms, updated_by FROM provider_pacing_config WHERE singleton_id = 1',
  ).get() as {
    schema_version: number; revision: number; config_json: string;
    updated_at_ms: number; updated_by: string;
  } | undefined;
  if (!row) return {
    schemaVersion: PROVIDER_PACING_SCHEMA_VERSION,
    revision: 0, config: { ...DEFAULT_PROVIDER_PACING_CONFIG, rules: [] },
    updatedAtMs: null, updatedBy: null,
  };
  if (row.schema_version !== PROVIDER_PACING_SCHEMA_VERSION) {
    throw new Error('Unsupported provider pacing configuration schema version');
  }
  // Never silently replace a corrupt policy with pass-through: that would
  // conceal persistence failures and cause unexpected upstream traffic.
  const config = parseProviderPacingConfig(JSON.parse(row.config_json) as unknown);
  return {
    schemaVersion: row.schema_version,
    revision: row.revision,
    config,
    updatedAtMs: row.updated_at_ms,
    updatedBy: row.updated_by,
  };
}

/** Optimistic concurrency CAS; the transaction is short and synchronous. */
export function saveProviderPacingConfig(
  expectedRevision: number,
  raw: unknown,
  updatedBy = 'dashboard',
  db: Db = getDb(),
): SavedProviderPacingConfig {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PacingConfigurationError('invalid_policy');
  }
  const config = parseProviderPacingConfig(raw);
  // Stage 3 intentionally cannot activate production scheduling. Saving and
  // validating disabled drafts is supported; enabled=true requires a later
  // audited activation implementation, not an accidental runtime toggle.
  if (config.enabled) throw new PacingConfigurationError('pacing_not_ready');
  const stamp = Date.now();
  const change = db.transaction(() => {
    const prior = db.prepare(
      'SELECT revision FROM provider_pacing_config WHERE singleton_id = 1',
    ).get() as { revision: number } | undefined;
    const revision = prior?.revision ?? 0;
    if (revision !== expectedRevision) throw new PacingConfigurationError('revision_conflict');
    db.prepare(`
      INSERT INTO provider_pacing_config
        (singleton_id, schema_version, revision, config_json, updated_at_ms, updated_by)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        config_json = excluded.config_json,
        updated_at_ms = excluded.updated_at_ms,
        updated_by = excluded.updated_by
    `).run(PROVIDER_PACING_SCHEMA_VERSION, revision + 1, JSON.stringify(config), stamp, updatedBy);
    return revision + 1;
  });
  const revision = change();
  return {
    schemaVersion: PROVIDER_PACING_SCHEMA_VERSION,
    revision, config, updatedAtMs: stamp, updatedBy,
  };
}

/**
 * Single-writer SQLite deadline store. Does not store prompt bodies or waiters.
 * Values are absolute UTC timestamps and survive process restarts. The caller
 * must enforce a SINGLE process; independent workers have separate in-memory
 * concurrency/RPM/TPM and require a distributed scheduler, not this store.
 */
export class SqlitePacingStartStore implements PacingStartStore {
  constructor(
    private readonly db: Db,
    private readonly ruleRevision: number,
    private readonly now: () => number = Date.now,
  ) {}

  readNextEligible(bucketKey: string): number {
    const row = this.db.prepare(
      'SELECT next_eligible_at_ms FROM provider_pacing_bucket_state WHERE bucket_key = ?',
    ).get(bucketKey) as { next_eligible_at_ms: number } | undefined;
    return row?.next_eligible_at_ms ?? 0;
  }

  commitStarts(changes: ReadonlyArray<{ bucketKey: string; nextEligibleAtMs: number }>): void {
    if (changes.length === 0) return;
    const keys = new Set<string>();
    for (const { bucketKey, nextEligibleAtMs } of changes) {
      if (!bucketKey || keys.has(bucketKey) || !Number.isSafeInteger(nextEligibleAtMs) || nextEligibleAtMs < 0) {
        throw new Error('Invalid provider pacing bucket transition');
      }
      keys.add(bucketKey);
    }
    const write = this.db.transaction(() => {
      const current = this.now();
      const select = this.db.prepare(
        'SELECT next_eligible_at_ms FROM provider_pacing_bucket_state WHERE bucket_key = ?',
      );
      const insert = this.db.prepare(`
        INSERT INTO provider_pacing_bucket_state
          (bucket_key, next_eligible_at_ms, rule_revision, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          next_eligible_at_ms = excluded.next_eligible_at_ms,
          rule_revision = excluded.rule_revision,
          updated_at_ms = excluded.updated_at_ms
      `);
      for (const c of changes) {
        const previous = select.get(c.bucketKey) as { next_eligible_at_ms: number } | undefined;
        // Fail closed if the in-memory scheduler had stale state. In particular
        // NEVER shorten the next-start deadline after restarting.
        if (previous && previous.next_eligible_at_ms > current) {
          throw new Error('Stale provider pacing grant, previous interval still active');
        }
        insert.run(c.bucketKey, c.nextEligibleAtMs, this.ruleRevision, current);
      }
    });
    write();
  }
}
