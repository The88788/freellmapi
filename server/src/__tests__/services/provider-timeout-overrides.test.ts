import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { PollinationsProvider } from '../../providers/pollinations.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import {
  effectiveProviderTimeout, saveProviderTimeoutOverride,
  validateOperatorTimeout,
} from '../../services/provider-timeout-overrides.js';
import { providerTimeoutSetting } from '../../lib/provider-timeout.js';

beforeEach(() => {
  initDb(':memory:');
  delete process.env.PROVIDER_TIMEOUT_POLLINATIONS;
  delete process.env.PROVIDER_TIMEOUT_NVIDIA;
  delete process.env.PROVIDER_TIMEOUT_MISTRAL;
});
afterEach(() => {
  delete process.env.PROVIDER_TIMEOUT_POLLINATIONS;
  delete process.env.PROVIDER_TIMEOUT_NVIDIA;
  delete process.env.PROVIDER_TIMEOUT_MISTRAL;
});

describe('live dashboard per-provider/model timeout settings', () => {
  it('defaults to 60 seconds and preserves explicit original source', () => {
    const provider = new PollinationsProvider();
    expect(provider.getTimeoutStatus('community/YoannDev90/muse-glimmer-30b:free'))
      .toMatchObject({
        timeoutMs: 60_000, source: 'provider_default',
        providerOverrideMs: null, modelOverrideMs: null,
      });
  });

  it('applies a saved provider override on an existing instance, no restart', () => {
    const provider = new PollinationsProvider();
    expect(provider.getTimeoutStatus().timeoutMs).toBe(60_000);
    saveProviderTimeoutOverride('pollinations', undefined, 120_000);
    expect(provider.getTimeoutStatus()).toMatchObject({
      timeoutMs: 120_000, source: 'dashboard_provider',
      providerOverrideMs: 120_000, modelOverrideMs: null,
      firstByteTimeoutMs: 120_000, streamStallTimeoutMs: 90_000,
    });
    saveProviderTimeoutOverride('pollinations', undefined, null);
    expect(provider.getTimeoutStatus().timeoutMs).toBe(60_000);
  });

  it('model override wins over provider without modifying a sibling model', () => {
    const provider = new PollinationsProvider();
    const muse = 'community/YoannDev90/muse-glimmer-30b:free';
    const another = 'community/another-model:free';
    saveProviderTimeoutOverride('pollinations', undefined, 120_000);
    saveProviderTimeoutOverride('pollinations', muse, 180_000);
    expect(provider.getTimeoutStatus(muse)).toMatchObject({
      timeoutMs: 180_000, source: 'dashboard_model',
      providerOverrideMs: 120_000, modelOverrideMs: 180_000,
    });
    expect(provider.getTimeoutStatus(another).timeoutMs).toBe(120_000);
    saveProviderTimeoutOverride('pollinations', muse, null);
    expect(provider.getTimeoutStatus(muse).timeoutMs).toBe(120_000);
  });

  it('the same setting cannot silently change NVIDIA or Mistral', () => {
    const nvidia = new OpenAICompatProvider({
      platform: 'nvidia', name: 'NVIDIA', baseUrl: 'https://example.invalid/v1',
      timeoutMs: 180_000,
    });
    const mistral = new OpenAICompatProvider({
      platform: 'mistral', name: 'Mistral', baseUrl: 'https://example.invalid/v1',
    });
    saveProviderTimeoutOverride('pollinations', undefined, 120_000);
    expect(nvidia.getTimeoutStatus().timeoutMs).toBe(180_000);
    expect(mistral.getTimeoutStatus().timeoutMs).toBe(60_000);
    expect(new PollinationsProvider().getTimeoutStatus().timeoutMs).toBe(120_000);
  });

  it('saved override wins over environment, reset restores constructor snapshot', () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '90000';
    const provider = new PollinationsProvider();
    saveProviderTimeoutOverride('pollinations', undefined, 120_000);
    expect(provider.getTimeoutStatus()).toMatchObject({
      timeoutMs: 120_000, source: 'dashboard_provider',
    });
    saveProviderTimeoutOverride('pollinations', undefined, null);
    expect(provider.getTimeoutStatus()).toMatchObject({
      timeoutMs: 90_000, source: 'environment',
    });
  });

  it('rejects bad targets, accidental no-timeout 0, and excessive values', () => {
    for (const value of [-1, 0, 999, 900001, NaN, 1.5]) {
      expect(() => validateOperatorTimeout(value)).toThrow();
    }
    expect(() => saveProviderTimeoutOverride('pollinations', 'bad\nmodel', 120_000)).toThrow();
    expect(() => saveProviderTimeoutOverride('pollinations;DELETE', undefined, 120_000)).toThrow();
    expect(() => saveProviderTimeoutOverride('pollinations', undefined, 0)).toThrow();
  });

  it('active call keeps its original timeout snapshot after a concurrent edit', () => {
    const baseline = providerTimeoutSetting('pollinations', 60_000);
    saveProviderTimeoutOverride('pollinations', undefined, 120_000);
    const startedAttempt = effectiveProviderTimeout('pollinations', 'muse', baseline).timeoutMs;
    saveProviderTimeoutOverride('pollinations', undefined, 180_000);
    const nextAttempt = effectiveProviderTimeout('pollinations', 'muse', baseline).timeoutMs;
    expect(startedAttempt).toBe(120_000);
    expect(nextAttempt).toBe(180_000);
  });
});
