/**
 * Operator-controlled provider/model request timeouts.
 * Reuses the existing settings key/value table. No extra migrations.
 *
 * Precedence, highest first:
 * CompletionOptions.timeoutMs (per-call; resolved by adapter)
 *   > saved model override > saved platform override
 *   > constructor-captured PROVIDER_TIMEOUT_<PLATFORM>
 *   > provider registration default.
 *
 * The effective timeout is snapped once per outgoing request. Changes never
 * alter an already-running fetch/response body/SSE stream.
 */
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { ProviderTimeoutSetting } from '../lib/provider-timeout.js';

export const MIN_OPERATOR_TIMEOUT_MS = 1_000;
export const MAX_OPERATOR_TIMEOUT_MS = 900_000;

export type ProviderTimeoutSource =
  | ProviderTimeoutSetting['source']
  | 'dashboard_provider'
  | 'dashboard_model';

export interface EffectiveProviderTimeout extends Omit<ProviderTimeoutSetting, 'source'> {
  source: ProviderTimeoutSource;
  platform: string;
  modelId?: string;
  providerOverrideMs: number | null;
  modelOverrideMs: number | null;
}

const PLATFORM_RE = /^[a-z][a-z0-9_-]{1,45}$/;

function platformKey(platform: string): string {
  return `provider_timeout_override:${platform}`;
}
function modelKey(platform: string, modelId: string): string {
  return `provider_timeout_model_override:${platform}:${modelId}`;
}

export function validateTimeoutTarget(platform: string, modelId?: string): void {
  if (!PLATFORM_RE.test(platform)) throw new Error('Invalid provider platform');
  if (modelId !== undefined && (
    modelId.length < 1 || modelId.length > 300 || /[\u0000-\u001f\u007f]/.test(modelId)
  )) throw new Error('Invalid modelId');
}

export function validateOperatorTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < MIN_OPERATOR_TIMEOUT_MS
    || (value as number) > MAX_OPERATOR_TIMEOUT_MS) {
    throw new Error(`Timeout must be an integer in ${MIN_OPERATOR_TIMEOUT_MS}..${MAX_OPERATOR_TIMEOUT_MS} ms`);
  }
  return value as number;
}

function readOverride(key: string): number | null {
  let stored: string | undefined;
  try {
    stored = getSetting(key);
  } catch {
    // Initial startup and mocked-provider tests may construct adapters before
    // SQLite is initialized. Preserve their old environment/default behavior.
    return null;
  }
  if (stored === undefined) return null;
  const value = Number(stored);
  // Saved invalid operator data is not permission to disable a timeout.
  return Number.isSafeInteger(value)
    && value >= MIN_OPERATOR_TIMEOUT_MS && value <= MAX_OPERATOR_TIMEOUT_MS
    ? value : null;
}

/** Read the effective policy ONCE before the individual upstream fetch starts. */
export function effectiveProviderTimeout(
  platform: string, modelId: string | undefined,
  baseline: ProviderTimeoutSetting,
): EffectiveProviderTimeout {
  // Inference model names come from the catalog, not the dashboard. Never
  // reject an otherwise valid existing request because its model label cannot
  // be used as an operator override key. Just use the provider-level default.
  const validModelKey = modelId !== undefined
    && modelId.length >= 1 && modelId.length <= 300
    && !/[\u0000-\u001f\u007f]/.test(modelId);
  const providerOverrideMs = readOverride(platformKey(platform));
  const modelOverrideMs = validModelKey
    ? readOverride(modelKey(platform, modelId!)) : null;
  const effectiveMs = modelOverrideMs ?? providerOverrideMs ?? baseline.timeoutMs;
  return {
    ...baseline,
    platform,
    ...(modelId !== undefined ? { modelId } : {}),
    timeoutMs: effectiveMs,
    source: modelOverrideMs !== null ? 'dashboard_model'
      : providerOverrideMs !== null ? 'dashboard_provider' : baseline.source,
    providerOverrideMs,
    modelOverrideMs,
  };
}

/** Changes affect subsequent attempts; active HTTP exchanges retain snapshot. */
export function saveProviderTimeoutOverride(
  platform: string,
  modelId: string | undefined,
  timeoutMs: number | null,
): void {
  validateTimeoutTarget(platform, modelId);
  if (timeoutMs !== null) validateOperatorTimeout(timeoutMs);
  const key = modelId === undefined ? platformKey(platform) : modelKey(platform, modelId);
  if (timeoutMs === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    setSetting(key, String(timeoutMs));
  }
}
