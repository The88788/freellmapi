import { describe, it, expect, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  acquireLease, releaseLease, resetLeases, inFlightForKey,
  setCooldown, isOnCooldown,
} from '../../services/ratelimit.js';

afterEach(() => resetLeases());

describe('Provider Pacing protection of the existing limiter', () => {
  it('a pacing-admitted stream retains its lease after the legacy 120-second prune', () => {
    const id = acquireLease('pollinations', 'muse:glimmer', 970019, 500, 1000, true);
    expect(inFlightForKey('pollinations', 970019, 122001)).toBe(1);
    expect(inFlightForKey('pollinations', 970019, 600000)).toBe(1);
    releaseLease(id);
    releaseLease(id);
    expect(inFlightForKey('pollinations', 970019, 600000)).toBe(0);
  });

  it('the opt-out legacy lease still has its original stale-lease backstop', () => {
    const id = acquireLease('pollinations', 'muse:glimmer', 970020, 500, 1000);
    expect(inFlightForKey('pollinations', 970020, 1000)).toBe(1);
    expect(inFlightForKey('pollinations', 970020, 122001)).toBe(0);
    releaseLease(id);
  });

  it('a shorter heuristic cannot overwrite a provider-authoritative cooldown deadline', () => {
    initDb(':memory:');
    const model = 'pacing-rt-authoritative-970021';
    const keyId = 970021;
    setCooldown('pollinations', model, keyId, 21000, 'authoritative');
    const before = getDb().prepare(
      'SELECT expires_at_ms, source FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?',
    ).get('pollinations', model, keyId) as { expires_at_ms: number; source: string };
    expect(before.source).toBe('authoritative');
    setCooldown('pollinations', model, keyId, 2000, 'heuristic');
    const after = getDb().prepare(
      'SELECT expires_at_ms, source FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?',
    ).get('pollinations', model, keyId) as { expires_at_ms: number; source: string };
    expect(after.expires_at_ms).toBe(before.expires_at_ms);
    expect(after.source).toBe('authoritative');
    expect(isOnCooldown('pollinations', model, keyId)).toBe(true);
  });
});
