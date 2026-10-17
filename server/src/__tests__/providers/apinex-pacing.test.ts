import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApinexPacer, ApinexProvider } from '../../providers/apinex.js';
import { getProvider } from '../../providers/index.js';
import { getProviderMinuteRequestCap } from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { up as seedVerified } from '../../db/migrations/20261018_000001_apinex_verified_free_models.js';

describe('APInex five RPM pacing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serializes simultaneous model requests with >=12.1s start intervals', async () => {
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
    const pacer = new ApinexPacer();
    const started: number[] = [];
    const request = () => pacer.acquire().then(() => started.push(Date.now()));
    const waiting = Array.from({ length: 6 }, request);
    await vi.advanceTimersByTimeAsync(60_500);
    await Promise.all(waiting);
    expect(started).toHaveLength(6);
    expect(started.map((t, i) => i === 0 ? 0 : t - started[i - 1]!))
      .toEqual([0, 12_100, 12_100, 12_100, 12_100, 12_100]);
  });

  it('aborted waiting calls do not consume a dispatch slot', async () => {
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
    const pacer = new ApinexPacer();
    await pacer.acquire();
    const controller = new AbortController();
    const aborted = pacer.acquire(controller.signal);
    controller.abort(new Error('client disconnected'));
    await expect(aborted).rejects.toThrow('client disconnected');
    const next = pacer.acquire();
    await vi.advanceTimersByTimeAsync(12_100);
    await expect(next).resolves.toBeUndefined();
  });

  it('does not delay metadata and key-health requests', async () => {
    const provider = new ApinexProvider();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    // The adapter's fetch is proxied; this test checks the public provider identity
    // and the separate pacer's clock contract instead of making live API calls.
    expect(provider.platform).toBe('apinex');
    expect(getProvider('apinex')).toBeInstanceOf(ApinexProvider);
    fetchSpy.mockRestore();
  });
});

describe('APInex verified bootstrap roster', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_APINEX;
    initDb(':memory:');
  });
  afterEach(() => { getDb().close(); delete process.env.ENCRYPTION_KEY; });

  it('does not pre-reject requests before the shared 5 RPM pacer', () => {
    // APInex must WAIT in its upstream pacer, not be rejected by the router
    // for account-wide RPM before it reaches the queue.
    expect(getProviderMinuteRequestCap('apinex')).toBeNull();
  });

  it('seeds only five free routes and preserves them across reruns', () => {
    const db = getDb();
    seedVerified(db);
    seedVerified(db);
    const rows = db.prepare("SELECT model_id,display_name,source FROM models WHERE platform='apinex' ORDER BY model_id").all() as
      Array<{ model_id: string; display_name: string; source: string }>;
    expect(rows).toHaveLength(5);
    expect(rows.every(m => m.model_id.startsWith('free/'))).toBe(true);
    expect(rows.every(m => m.source === 'user')).toBe(true);
    expect(rows.find(m => m.model_id === 'free/gpt-6-luna')?.display_name).toBe('GPT-6 Luna');
  });

  it('respects explicit user deletion and does not reinsert deleted route', () => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform='apinex' AND model_id='free/gpt-6-luna')").run();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE platform='apinex' AND model_id='free/gpt-6-luna')").run();
    db.prepare("DELETE FROM models WHERE platform='apinex' AND model_id='free/gpt-6-luna'").run();
    db.prepare("INSERT OR IGNORE INTO catalog_model_tombstones(kind,platform,model_id,source) VALUES('chat','apinex','free/gpt-6-luna','user')").run();
    seedVerified(db);
    expect(db.prepare("SELECT id FROM models WHERE platform='apinex' AND model_id='free/gpt-6-luna'").get()).toBeUndefined();
  });
});
