import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderPacingCore, PacingError } from '../../services/provider-pacing-core.js';

const routing = vi.hoisted(() => ({
  calls: [] as string[],
  activeLeases: 0,
  released: 0,
  commitFails: false,
}));

vi.mock('../../services/router.js', () => ({
  routeRequest: (...args: unknown[]) => {
    const pacing = args[12] as { mode?: 'preview' | 'commit'; keyId?: number } | undefined;
    const mode = pacing?.mode ?? 'legacy';
    routing.calls.push(mode);
    const skipKeys = args[1] as Set<string> | undefined;
    if (skipKeys?.has('pollinations:muse:glimmer:9')) throw new Error('candidate exhausted');
    if (mode === 'commit' && routing.commitFails) throw new Error('candidate unavailable');
    const route = {
      platform: 'pollinations', modelId: 'muse:glimmer', modelDbId: 21,
      keyId: 9, endpointScope: 'api:v1', displayName: 'Muse',
      contextWindow: 64000, rpdLimit: null, tpdLimit: null, keyLabel: null,
      provider: {}, proxyUrl: '', apiKey: mode === 'preview' ? '' : 'test-only',
      release: undefined as (() => void) | undefined,
    };
    if (mode !== 'preview') {
      routing.activeLeases++;
      let released = false;
      route.release = () => {
        if (released) return;
        released = true;
        routing.activeLeases--;
        routing.released++;
      };
    }
    return route;
  },
}));

import {
  installProviderPacingScheduler, schedulePacedRoute, isProviderPacingInstalled,
} from '../../services/provider-pacing-routing.js';

class Clock {
  nowMs = 0;
  jobs = new Map<number, { at: number; fn: () => void }>();
  seq = 0;
  now = () => this.nowMs;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.jobs.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  tick(to: number) {
    while (true) {
      const sorted = [...this.jobs.entries()].sort((a, b) => a[1].at - b[1].at);
      const next = sorted[0];
      if (!next || next[1].at > to) break;
      this.nowMs = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
    }
    this.nowMs = to;
  }
}

const makeScheduler = (clock: Clock) => new ProviderPacingCore({
  enabled: true, maxPendingGlobal: 10, maxPendingPerClient: 10,
  rules: [{
    id: 'muse-65s', enabled: true, scope: 'model-key',
    match: { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 9 },
    limits: { minStartIntervalMs: 65000 },
    queue: { maxWaitMs: 180000, maxPendingPerBucket: 10 },
  }],
}, { clock });

describe('pacing routing bridge (opt in)', () => {
  let clock: Clock;
  let scheduler: ProviderPacingCore;
  beforeEach(() => {
    vi.clearAllMocks();
    routing.calls.length = 0;
    routing.activeLeases = 0;
    routing.released = 0;
    routing.commitFails = false;
    clock = new Clock();
    scheduler = makeScheduler(clock);
    installProviderPacingScheduler(scheduler);
  });
  afterEach(() => {
    installProviderPacingScheduler(undefined);
    scheduler.shutdown();
  });

  it('keeps the exact legacy sync path when no scheduler is installed', () => {
    installProviderPacingScheduler(undefined);
    expect(isProviderPacingInstalled()).toBe(false);
    const result = schedulePacedRoute('Harness', undefined, 500);
    expect(result).not.toBeInstanceOf(Promise);
    expect(routing.calls).toEqual(['legacy']);
    expect(routing.activeLeases).toBe(1);
    (result as { release?: () => void }).release?.();
    expect(routing.activeLeases).toBe(0);
  });

  it('does not take legacy leases while queued and rechecks the same key', async () => {
    const first = schedulePacedRoute('Harness', undefined, 500);
    const second = schedulePacedRoute('Codex', undefined, 500);
    const a = await first;
    expect(routing.calls).toEqual(['preview', 'preview', 'commit']);
    expect(routing.activeLeases).toBe(1);
    expect(scheduler.status().pending).toBe(1);
    clock.tick(64999);
    await Promise.resolve();
    expect(routing.activeLeases).toBe(1);
    clock.tick(65000);
    const b = await second;
    expect(routing.calls).toEqual(['preview', 'preview', 'commit', 'commit']);
    expect(b.pacingWaitedMs).toBe(65000);
    expect(routing.activeLeases).toBe(2);
    a.release?.(); a.release?.(); b.release?.();
    expect(routing.activeLeases).toBe(0);
    expect(routing.released).toBe(2);
  });

  it('aborting a queued client cannot reserve another lease', async () => {
    const a = await schedulePacedRoute('Harness', undefined, 500);
    const abort = new AbortController();
    const pending = schedulePacedRoute('Codex', abort.signal, 500);
    expect(scheduler.status().pending).toBe(1);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' });
    expect(scheduler.status().pending).toBe(0);
    expect(routing.activeLeases).toBe(1);
    a.release?.();
    expect(routing.activeLeases).toBe(0);
  });

  it('a vanished candidate releases the scheduler grant without a legacy lease', async () => {
    routing.commitFails = true;
    await expect(schedulePacedRoute('Harness', undefined, 500)).rejects.toThrow();
    expect(routing.activeLeases).toBe(0);
    expect(scheduler.status().inflight).toBe(0);
  });
});
