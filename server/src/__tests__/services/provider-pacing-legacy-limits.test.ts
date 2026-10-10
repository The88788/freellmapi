import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  acquireLease, releaseLease, resetLeases,
  getTemporaryPacingReadiness,
  recordRequest, recordTokens, setCooldown,
  subscribeLeaseRelease,
} from '../../services/ratelimit.js';

const PLATFORM = 'pollinations';
const MODEL = 'muse:glimmer';
const KEY_ID = 840015;
const START = new Date('2026-10-11T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  initDb(':memory:');
  resetLeases();
});
afterEach(() => {
  resetLeases();
  delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_POLLINATIONS;
  vi.useRealTimers();
});

test('legacy RPM sees earliest sliding-window expiry and does not reserve in preview', () => {
  recordRequest(PLATFORM, MODEL, KEY_ID);
  const blocked = getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: 1, tpm: null });
  expect(blocked.ready).toBe(false);
  expect(blocked.readyAtMs).toBe(START.getTime() + 60_000);
  vi.advanceTimersByTime(60_000);
  expect(getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: 1, tpm: null }).ready).toBe(true);
});

test('legacy TPM uses recorded token usage, not new monthly-budget reservations', () => {
  recordTokens(PLATFORM, MODEL, KEY_ID, 550);
  const blocked = getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: 1000 });
  expect(blocked.ready).toBe(false);
  expect(blocked.readyAtMs).toBe(START.getTime() + 60_000);
  vi.advanceTimersByTime(60_000);
  expect(getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: 1000 }).ready).toBe(true);
});

test('provider authoritative cooldown preserves the original release timestamp', () => {
  setCooldown(PLATFORM, MODEL, KEY_ID, 21_000, 'authoritative');
  const blocked = getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: null });
  expect(blocked.ready).toBe(false);
  expect(blocked.readyAtMs).toBe(START.getTime() + 21_000);
  vi.advanceTimersByTime(21_001);
  expect(getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: null }).ready).toBe(true);
});

test('protected active lease has unknown release time and emits a one-shot wake event', () => {
  process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_POLLINATIONS = '1';
  const lease = acquireLease(PLATFORM, MODEL, KEY_ID, 500, START.getTime(), true);
  const blocked = getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: null });
  expect(blocked.ready).toBe(false);
  expect(blocked.waitingOnLease).toBe(true);
  const wake = vi.fn();
  const unsubscribe = subscribeLeaseRelease(wake);
  vi.advanceTimersByTime(130_000);
  expect(getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: null }).ready).toBe(false);
  releaseLease(lease);
  releaseLease(lease);
  expect(wake).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(getTemporaryPacingReadiness(PLATFORM, MODEL, KEY_ID, 500, { rpm: null, tpm: null }).ready).toBe(true);
});
