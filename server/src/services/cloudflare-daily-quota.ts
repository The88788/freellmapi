import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../db/index.js';

const DAY_MS = 86_400_000;
const PREFIX = 'cloudflare_daily_quota:';

function accountSetting(apiKey: string): string | null {
  const colon = apiKey.indexOf(':');
  if (colon <= 0 || colon === apiKey.length - 1) return null;
  // Account identity, not token identity. Never persist the raw account ID or token.
  return PREFIX + createHash('sha256').update(apiKey.slice(0, colon).toLowerCase()).digest('hex');
}

export function isCloudflareAccountDailyBlocked(apiKey: string, now = Date.now()): boolean {
  const key = accountSetting(apiKey);
  return key !== null && Number(getSetting(key) ?? 0) > now;
}

/** Only a verified Workers AI daily *neurons* 429 blocks the whole account. */
export function recordCloudflareAccountDailyExhaustion(apiKey: string, err: { status?: number; message?: string; retryAfterMs?: number }, now = Date.now()): boolean {
  if (err?.status !== 429 || !/daily free allocation/i.test(err.message ?? '') || !/neurons/i.test(err.message ?? '')) return false;
  const key = accountSetting(apiKey);
  if (!key) return false;
  const nextUtcMidnight = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const retryAfter = Number.isFinite(err.retryAfterMs) && (err.retryAfterMs ?? 0) > 0 ? err.retryAfterMs! : 0;
  const until = Math.max(nextUtcMidnight, now + retryAfter, Number(getSetting(key) ?? 0));
  setSetting(key, String(until));
  return true;
}
