import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  providerTimeoutEnvName,
  providerTimeoutMs,
  providerTimeoutSetting,
  resetTimeoutWarnings,
  streamStallTimeoutMs,
} from '../../lib/provider-timeout.js';

// Per-provider timeout overrides (issue #547, reworked from PR #509).

afterEach(() => {
  delete process.env.PROVIDER_TIMEOUT_NVIDIA;
  delete process.env.PROVIDER_TIMEOUT_GROQ;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_GROQ;
  resetTimeoutWarnings();
  vi.restoreAllMocks();
});

describe('providerTimeoutEnvName', () => {
  it('upper-cases the platform', () => {
    expect(providerTimeoutEnvName('nvidia')).toBe('PROVIDER_TIMEOUT_NVIDIA');
    expect(providerTimeoutEnvName('aihorde')).toBe('PROVIDER_TIMEOUT_AIHORDE');
  });
});

describe('providerTimeoutMs', () => {
  it('returns the built-in default when the env var is unset', () => {
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(90_000);
  });

  it('lets the env override win over the default', () => {
    process.env.PROVIDER_TIMEOUT_NVIDIA = '300000';
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(300_000);
  });

  it('accepts 0 as "no timeout"', () => {
    process.env.PROVIDER_TIMEOUT_NVIDIA = '0';
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(0);
  });

  it('ignores negative, fractional, and non-numeric values (warns once, keeps default)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['-1', '1.5', 'ninety', '']) {
      process.env.PROVIDER_TIMEOUT_NVIDIA = bad;
      expect(providerTimeoutMs('nvidia', 90_000)).toBe(90_000);
    }
    // '' is treated as unset (no warning); the three malformed values share one
    // env name, so the warn-once gate fires exactly once.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns on sub-second values that would abort nearly every request, but honors them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROVIDER_TIMEOUT_GROQ = '500';
    expect(providerTimeoutMs('groq', 60_000)).toBe(500);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('streamStallTimeoutMs', () => {
  it('defaults to 90s', () => {
    expect(streamStallTimeoutMs()).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
  });

  it('honors PROVIDER_STREAM_STALL_TIMEOUT_MS, including 0 to disable the watchdog', () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '240000';
    expect(streamStallTimeoutMs()).toBe(240_000);
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '0';
    expect(streamStallTimeoutMs()).toBe(0);
  });

  // Per-platform stall override (issue #584): symmetric with
  // PROVIDER_TIMEOUT_<PLATFORM>; per-platform wins over global wins over default.
  it('PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM> wins over the global value', () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '240000';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA = '30000';
    expect(streamStallTimeoutMs('nvidia')).toBe(30_000);
    // Other platforms stay on the global value.
    expect(streamStallTimeoutMs('groq')).toBe(240_000);
    // And the bare (platform-less) call is unchanged.
    expect(streamStallTimeoutMs()).toBe(240_000);
  });

  it('per-platform override works without a global override (falls back through to the default otherwise)', () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA = '30000';
    expect(streamStallTimeoutMs('nvidia')).toBe(30_000);
    expect(streamStallTimeoutMs('groq')).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
  });

  it('per-platform 0 disables the watchdog for that platform only', () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA = '0';
    expect(streamStallTimeoutMs('nvidia')).toBe(0);
    expect(streamStallTimeoutMs('groq')).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
  });

  it('a malformed per-platform value warns and falls back to the global/default chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '240000';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA = 'ninety';
    expect(streamStallTimeoutMs('nvidia')).toBe(240_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('provider timeout diagnostics snapshot (Pollinations)', () => {
  afterEach(() => {
    delete process.env.PROVIDER_TIMEOUT_POLLINATIONS;
  });

  it('resolves the 60s Pollinations default and names its source', () => {
    expect(providerTimeoutSetting('pollinations', 60_000)).toEqual({
      timeoutMs: 60_000,
      source: 'provider_default',
      envName: 'PROVIDER_TIMEOUT_POLLINATIONS',
      defaultMs: 60_000,
      restartRequiredToChange: true,
    });
  });

  it('resolves only the Pollinations 120s override and leaves other sources unchanged', () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    expect(providerTimeoutSetting('pollinations', 60_000)).toMatchObject({
      timeoutMs: 120_000, source: 'environment',
    });
    expect(providerTimeoutSetting('nvidia', 180_000)).toMatchObject({
      timeoutMs: 180_000, source: 'provider_default',
    });
    expect(providerTimeoutSetting('mistral', 60_000)).toMatchObject({
      timeoutMs: 60_000, source: 'provider_default',
    });
  });

  it('rejects an invalid Pollinations env override without misreporting it as active', () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = 'two_minutes';
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(providerTimeoutSetting('pollinations', 60_000)).toMatchObject({
      timeoutMs: 60_000, source: 'provider_default',
    });
    warnings.mockRestore();
  });
});
