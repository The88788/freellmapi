import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  readProviderPacingConfig, saveProviderPacingConfig,
  parseProviderPacingConfig, PacingConfigurationError, SqlitePacingStartStore,
  DEFAULT_PROVIDER_PACING_CONFIG,
} from '../../services/provider-pacing-store.js';

describe('provider pacing SQLite persistence and revision guard', () => {
  beforeEach(() => initDb(':memory:'));

  const disabledDraft = () => ({
    enabled: false, maxPendingGlobal: 200, maxPendingPerClient: 10,
    rules: [{
      id: 'pollinations-muse-65s', enabled: true,
      scope: 'model-key' as const,
      match: { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 11 },
      limits: { minStartIntervalMs: 65000, maxConcurrent: 1 },
      queue: { maxWaitMs: 180000, maxPendingPerBucket: 20 },
    }],
  });

  it('migration starts disabled with revision zero', () => {
    const doc = readProviderPacingConfig();
    expect(doc.revision).toBe(0);
    expect(doc.config).toEqual(DEFAULT_PROVIDER_PACING_CONFIG);
  });

  it('validates and saves a draft once, rejects stale editors without partial changes', () => {
    const doc = saveProviderPacingConfig(0, disabledDraft(), 'dashboard-A');
    expect(doc.revision).toBe(1);
    expect(doc.updatedBy).toBe('dashboard-A');
    expect(readProviderPacingConfig().config.rules).toHaveLength(1);
    expect(() => saveProviderPacingConfig(0, { ...disabledDraft(), rules: [] }))
      .toThrowError(PacingConfigurationError);
    expect(readProviderPacingConfig().revision).toBe(1);
    expect(readProviderPacingConfig().config.rules).toHaveLength(1);
  });

  it('refuses activation until E2E and single-writer safeguards are complete', () => {
    const enabled = { ...disabledDraft(), enabled: true };
    expect(() => parseProviderPacingConfig(enabled)).not.toThrow();
    expect(() => saveProviderPacingConfig(0, enabled))
      .toThrowError(PacingConfigurationError);
    expect(readProviderPacingConfig().revision).toBe(0);
  });

  it('rejects ambiguous scope, conflicting rules, zero wait and unknown config fields', () => {
    expect(() => parseProviderPacingConfig({ ...disabledDraft(), hiddenFeature: 'yes' })).toThrow();
    expect(() => parseProviderPacingConfig({ ...disabledDraft(), rules: [
      disabledDraft().rules[0], disabledDraft().rules[0],
    ] })).toThrow();
    expect(() => parseProviderPacingConfig({ ...disabledDraft(), rules: [{
      ...disabledDraft().rules[0], queue: { maxWaitMs: 0, maxPendingPerBucket: 20 },
    }] })).toThrow();
  });

  it('persists intervals between restarts without storing messages or keys', () => {
    const db = getDb();
    let now = 100000;
    const first = new SqlitePacingStartStore(db, 1, () => now);
    expect(first.readNextEligible('bucket-1')).toBe(0);
    first.commitStarts([{ bucketKey: 'bucket-1', nextEligibleAtMs: 165000 }]);
    expect(new SqlitePacingStartStore(db, 1).readNextEligible('bucket-1')).toBe(165000);
    const row = db.prepare('SELECT next_eligible_at_ms, rule_revision FROM provider_pacing_bucket_state WHERE bucket_key = ?')
      .get('bucket-1') as { next_eligible_at_ms: number; rule_revision: number };
    expect(row).toEqual({ next_eligible_at_ms: 165000, rule_revision: 1 });
  });

  it('rejects a second admission inside the same window and keeps all scopes atomic', () => {
    const db = getDb();
    let now = 100000;
    const store = new SqlitePacingStartStore(db, 4, () => now);
    store.commitStarts([{ bucketKey: 'a', nextEligibleAtMs: 165000 }]);
    expect(() => store.commitStarts([
      { bucketKey: 'b', nextEligibleAtMs: 170000 },
      { bucketKey: 'a', nextEligibleAtMs: 166000 },
    ])).toThrow();
    expect(store.readNextEligible('b')).toBe(0);
    expect(store.readNextEligible('a')).toBe(165000);
    now = 165001;
    store.commitStarts([{ bucketKey: 'a', nextEligibleAtMs: 230001 }]);
    expect(store.readNextEligible('a')).toBe(230001);
  });

  it('rejects duplicate bucket names and invalid persisted stamps', () => {
    const store = new SqlitePacingStartStore(getDb(), 1, () => 100000);
    expect(() => store.commitStarts([
      { bucketKey: 'a', nextEligibleAtMs: 165000 },
      { bucketKey: 'a', nextEligibleAtMs: 165000 },
    ])).toThrow();
    expect(store.readNextEligible('a')).toBe(0);
  });
});
