import { describe, expect, it } from 'vitest';
import {
  ProviderPacingCore,
  type PacingClock,
  type PacingConfig,
  type PacingStartStore,
} from '../../services/provider-pacing-core.js';

/**
 * No mocked router: these tests prove the scheduler's synchronous admission
 * ordering and rollback contract, regardless of HTTP surface.
 */
class Clock implements PacingClock {
  nowMs = 0;
  private jobs = new Map<number, { at: number; fn: () => void }>();
  private sequence = 1;
  now = () => this.nowMs;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.sequence++;
    this.jobs.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  tick(to: number) {
    if (to < this.nowMs) throw Error('Clock cannot go backward');
    for (let count = 0; count < 1000; count++) {
      const entry = [...this.jobs.entries()]
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > to) { this.nowMs = to; return; }
      this.nowMs = entry[1].at;
      this.jobs.delete(entry[0]);
      entry[1].fn();
    }
    throw Error('Infinite timer loop');
  }
}

function config(): PacingConfig {
  return {
    enabled: true, maxPendingGlobal: 50, maxPendingPerClient: 50,
    rules: [{
      id: 'muse-65s', enabled: true, scope: 'model-key',
      match: { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 9 },
      limits: { minStartIntervalMs: 65000 },
      queue: { maxWaitMs: 180000, maxPendingPerBucket: 50 },
    }],
  };
}
const identity = { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 9 };

describe('atomic pacing + existing lease/monthly-budget admission', () => {
  it('claims legacy resources only at dispatch, then records persisted pacing start', async () => {
    const clock = new Clock();
    const events: string[] = [];
    let active = 0;
    const store: PacingStartStore = {
      readNextEligible: () => 0,
      commitStarts: () => { events.push('persist'); expect(active).toBeGreaterThan(0); },
    };
    const scheduler = new ProviderPacingCore(config(), { clock, store });
    const request = (clientId: string) => scheduler.schedule({
      identity, clientId, estimatedTokens: 500,
      onAdmit: () => {
        active++;
        events.push('reserve');
        return {
          resource: { name: clientId },
          rollback: () => { active--; events.push('rollback'); },
        };
      },
    });
    const first = await request('Harness');
    const secondPromise = request('Codex');
    expect(first.resource).toEqual({ name: 'Harness' });
    expect(events).toEqual(['reserve', 'persist']);
    expect(active).toBe(1);
    expect(scheduler.status().pending).toBe(1);
    clock.tick(64999);
    expect(events).toEqual(['reserve', 'persist']);
    clock.tick(65000);
    const second = await secondPromise;
    expect(second.resource).toEqual({ name: 'Codex' });
    expect(events).toEqual(['reserve', 'persist', 'reserve', 'persist']);
    expect(active).toBe(2);
    first.release();
    second.release();
    active -= 2;
    expect(scheduler.status().inflight).toBe(0);
    scheduler.shutdown();
  });

  it('store failure rolls back existing lease and budget and does not spend interval', async () => {
    const clock = new Clock();
    let activeLeases = 0;
    let reservedBudget = 0;
    let fail = true;
    const store: PacingStartStore = {
      readNextEligible: () => 0,
      commitStarts: () => { if (fail) throw Error('SQLITE_BUSY'); },
    };
    const scheduler = new ProviderPacingCore(config(), { clock, store });
    const request = () => scheduler.schedule({
      identity, clientId: 'Harness', estimatedTokens: 500,
      onAdmit: () => {
        activeLeases++;
        reservedBudget += 500;
        let released = false;
        return {
          resource: { lease: activeLeases },
          rollback: () => {
            if (!released) { released = true; activeLeases--; reservedBudget -= 500; }
          },
        };
      },
    });
    await expect(request()).rejects.toMatchObject({ code: 'pacing_store_error' });
    expect(activeLeases).toBe(0);
    expect(reservedBudget).toBe(0);
    expect(scheduler.status().inflight).toBe(0);
    expect(scheduler.counters().admitted).toBe(0);
    fail = false;
    const grant = await request();
    expect(grant.startedAtMs).toBe(0);
    expect(activeLeases).toBe(1);
    grant.release();
    scheduler.shutdown();
  });

  it('candidate disappears during synchronous commit: no reservation and no start', async () => {
    const clock = new Clock();
    let persisted = 0;
    const store: PacingStartStore = {
      readNextEligible: () => 0,
      commitStarts: () => { persisted++; },
    };
    const scheduler = new ProviderPacingCore(config(), { clock, store });
    await expect(scheduler.schedule({
      identity, clientId: 'Codex', estimatedTokens: 500,
      onAdmit: () => { throw Error('candidate disabled'); },
    })).rejects.toThrow('candidate disabled');
    expect(persisted).toBe(0);
    expect(scheduler.status().inflight).toBe(0);
    scheduler.shutdown();
  });

  it('abort during wait cannot invoke legacy commit callback', async () => {
    const clock = new Clock();
    const scheduler = new ProviderPacingCore(config(), { clock });
    const first = await scheduler.schedule({ identity, clientId: 'Harness', estimatedTokens: 500 });
    const abort = new AbortController();
    let attempted = 0;
    const pending = scheduler.schedule({
      identity, clientId: 'Codex', estimatedTokens: 500,
      signal: abort.signal,
      onAdmit: () => {
        attempted++;
        return { resource: true, rollback: () => {} };
      },
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' });
    clock.tick(65000);
    expect(attempted).toBe(0);
    first.release();
    scheduler.shutdown();
  });

  it('abort synchronously inside legacy commit rolls back before recording start', async () => {
    const clock = new Clock();
    let writes = 0;
    let activeLeases = 0;
    const abort = new AbortController();
    const scheduler = new ProviderPacingCore(config(), {
      clock,
      store: {
        readNextEligible: () => 0,
        commitStarts: () => { writes++; },
      },
    });
    const pending = scheduler.schedule({
      identity, clientId: 'Codex', estimatedTokens: 500, signal: abort.signal,
      onAdmit: () => {
        activeLeases++;
        abort.abort();
        return {
          resource: { keyId: 9 },
          rollback: () => { activeLeases--; },
        };
      },
    });
    await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' });
    expect(activeLeases).toBe(0);
    expect(writes).toBe(0);
    expect(scheduler.status().inflight).toBe(0);
    scheduler.shutdown();
  });

  it('reentrant abort during waiter admission does not block the next FIFO caller', async () => {
    const clock = new Clock();
    const scheduler = new ProviderPacingCore(config(), { clock });
    const first = await scheduler.schedule({ identity, clientId: 'Harness', estimatedTokens: 500 });
    const abort = new AbortController();
    let active = 0;
    const cancelled = scheduler.schedule({
      identity, clientId: 'Codex', estimatedTokens: 500, signal: abort.signal,
      onAdmit: () => {
        active++;
        abort.abort(); // abort handler fires synchronously inside drain()
        return { resource: true, rollback: () => { active--; } };
      },
    });
    const next = scheduler.schedule({
      identity, clientId: 'Harness-2', estimatedTokens: 500,
      onAdmit: () => ({ resource: { actual: 'next' }, rollback: () => {} }),
    });
    clock.tick(65_000);
    await expect(cancelled).rejects.toMatchObject({ code: 'client_cancelled' });
    const accepted = await next;
    expect(accepted.startedAtMs).toBe(65_000);
    expect(accepted.resource).toEqual({ actual: 'next' });
    expect(active).toBe(0);
    first.release();
    accepted.release();
    scheduler.shutdown();
  });

  it('a matching-rule miss still acquires legacy route exactly once', async () => {
    const clock = new Clock();
    const scheduler = new ProviderPacingCore(config(), { clock });
    let called = 0;
    const grant = await scheduler.schedule({
      identity: { platform: 'some-other-provider', modelId: 'another', keyId: 2 },
      clientId: 'Harness', estimatedTokens: 500,
      onAdmit: () => {
        called++;
        return { resource: { route: 'unlimited' }, rollback: () => {} };
      },
    });
    expect(called).toBe(1);
    expect(grant.resource).toEqual({ route: 'unlimited' });
    expect(scheduler.status().inflight).toBe(0);
    scheduler.shutdown();
  });
});
