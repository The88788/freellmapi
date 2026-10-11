import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import {
  ProviderPacingCore,
  type PacingClock,
  type PacingConfig,
  type PacingRequest,
} from '../../services/provider-pacing-core.js';

class FakeClock implements PacingClock {
  ms = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = () => this.ms;
  setTimeout = (fn: () => void, delay: number): number => {
    const id = this.next++;
    this.tasks.set(id, { at: this.ms + delay, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  tick(to: number): void {
    assert(to >= this.ms);
    let steps = 0;
    for (;;) {
      if (++steps > 10_000) throw new Error('Unexpected zero-delay timer loop');
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      this.ms = next[1].at;
      this.tasks.delete(next[0]);
      next[1].fn();
    }
    this.ms = to;
  }
}
function config(interval = 65_000, maxWaitMs = 180_000): PacingConfig {
  return {
    enabled: true, maxPendingGlobal: 50, maxPendingPerClient: 50,
    rules: [{
      id: 'muse', enabled: true, scope: 'model-key',
      match: { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 9 },
      limits: { minStartIntervalMs: interval, maxConcurrent: 2 },
      queue: { maxWaitMs, maxPendingPerBucket: 50 },
    }],
  };
}
function request(
  clientId: string,
  readiness: NonNullable<PacingRequest['readiness']>,
): PacingRequest {
  return {
    identity: { platform: 'pollinations', modelId: 'muse:glimmer', keyId: 9, endpointScope: 'api:v1' },
    estimatedTokens: 500, clientId, readiness,
  };
}

test('legacy readiness timestamp delays admission with no provisional scheduler reservation', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(config(), { clock });
  const pending = scheduler.schedule(request('Harness', () => ({
    ready: clock.ms >= 35_000, readyAtMs: 35_000,
  })));
  expect(scheduler.status().pending).toBe(1);
  expect(scheduler.status().inflight).toBe(0);
  clock.tick(34_999);
  expect(scheduler.counters().admitted).toBe(0);
  clock.tick(35_000);
  const grant = await pending;
  expect(grant.startedAtMs).toBe(35_000);
  grant.release();
  scheduler.shutdown();
});

test('legacy lease release immediately wakes queued Codex without polling', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(config(), { clock });
  let released = false;
  const pending = scheduler.schedule(request('Codex', () => ({
    ready: released, readyAtMs: null,
  })));
  clock.tick(30_000);
  expect(scheduler.status().inflight).toBe(0);
  released = true;
  scheduler.notifyWaiters();
  const grant = await pending;
  expect(grant.startedAtMs).toBe(30_000);
  grant.release();
  scheduler.shutdown();
});

test('legacy readiness and scheduler min-start interval must both pass', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(config(), { clock });
  let ready = true;
  const first = await scheduler.schedule(request('Harness', () => ({ ready, readyAtMs: null })));
  ready = false;
  const pending = scheduler.schedule(request('Codex', () => ({ ready, readyAtMs: null })));
  clock.tick(65_000);
  expect(scheduler.status().inflight).toBe(1);
  ready = true;
  scheduler.notifyWaiters();
  const second = await pending;
  expect(second.startedAtMs).toBe(65_000);
  first.release();
  second.release();
  scheduler.shutdown();
});

test('an unready legacy limiter can expire a queued request without a grant', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(config(1000, 2000), { clock });
  const pending = scheduler.schedule(request('Harness', () => ({
    ready: false, readyAtMs: null,
  })));
  clock.tick(2000);
  await expect(pending).rejects.toMatchObject({ code: 'rate_limit_exceeded' });
  expect(scheduler.status().inflight).toBe(0);
  expect(scheduler.counters().admitted).toBe(0);
  scheduler.shutdown();
});

test('client abort removes blocked legacy waiter and forbids late grant', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(config(), { clock });
  const ctrl = new AbortController();
  let ready = false;
  const pending = scheduler.schedule({
    ...request('Codex', () => ({ ready, readyAtMs: null })),
    signal: ctrl.signal,
  });
  ctrl.abort();
  await expect(pending).rejects.toMatchObject({ code: 'client_cancelled' });
  ready = true;
  scheduler.notifyWaiters();
  expect(scheduler.counters().admitted).toBe(0);
  expect(scheduler.status().pending).toBe(0);
  scheduler.shutdown();
});


function sharedPollinationsConfig(concurrency: number): PacingConfig {
  return {
    enabled: true, maxPendingGlobal: 20, maxPendingPerClient: 20,
    rules: [{
      id: 'pollinations-provider-65s', enabled: true, scope: 'provider',
      match: { platform: 'pollinations' },
      limits: { minStartIntervalMs: 65_000, maxConcurrent: concurrency },
      queue: { maxWaitMs: 240_000, maxPendingPerBucket: 20 },
    }],
  };
}
const pollinationsCall = (clientId: string, modelId: string, keyId: number) => ({
  identity: { platform: 'pollinations', modelId, keyId },
  clientId, estimatedTokens: 500,
});

test('one Pollinations provider-wide 1 RPM bucket spans models, keys and client apps', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(sharedPollinationsConfig(2), { clock });
  const first = await scheduler.schedule(pollinationsCall('Harness', 'muse-glimmer', 9));
  const secondPromise = scheduler.schedule(pollinationsCall('Codex', 'another-model', 10));
  clock.tick(64_999);
  expect(scheduler.counters().admitted).toBe(1);
  clock.tick(65_000);
  const second = await secondPromise;
  expect(first.startedAtMs).toBe(0);
  expect(second.startedAtMs).toBe(65_000);
  expect(scheduler.counters().admitted).toBe(2);
  first.release();
  second.release();
  scheduler.shutdown();
});

test('1 RPM and maxConcurrent 1 are independent: 120s upstream delays next start beyond 65s', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(sharedPollinationsConfig(1), { clock });
  const first = await scheduler.schedule(pollinationsCall('Harness', 'muse-glimmer', 9));
  const pending = scheduler.schedule(pollinationsCall('Codex', 'muse-glimmer', 9));
  clock.tick(65_000);
  expect(scheduler.status().pending).toBe(1);
  expect(scheduler.status().inflight).toBe(1);
  clock.tick(120_000);
  first.release();
  const second = await pending;
  expect(second.startedAtMs).toBe(120_000);
  second.release();
  scheduler.shutdown();
});

test('unrelated provider does not inherit Pollinations queue or timeout', async () => {
  const clock = new FakeClock();
  const scheduler = new ProviderPacingCore(sharedPollinationsConfig(1), { clock });
  const first = await scheduler.schedule(pollinationsCall('Harness', 'muse-glimmer', 9));
  const nvidia = await scheduler.schedule({
    identity: { platform: 'nvidia', modelId: 'nemotron', keyId: 20 },
    clientId: 'Codex', estimatedTokens: 500,
  });
  expect(nvidia.startedAtMs).toBe(0);
  first.release();
  nvidia.release();
  scheduler.shutdown();
});
