import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { isCloudflareAccountDailyBlocked, recordCloudflareAccountDailyExhaustion } from '../../services/cloudflare-daily-quota.js';
import { encrypt } from '../../lib/crypto.js';
import { routePinnedModel, hasUsableKeyForModel } from '../../services/router.js';

const DAILY = { status: 429, message: 'Cloudflare API error 429: you have used up your daily free allocation of 10,000 neurons' };
let modelId = 0;
function insertKey(value: string) {
  const { encrypted, iv, authTag } = encrypt(value);
  return Number(getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('cloudflare','test',?,?,?,'healthy',1)").run(encrypted,iv,authTag).lastInsertRowid);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  modelId = Number((getDb().prepare("SELECT id FROM models WHERE platform='cloudflare' AND enabled=1 LIMIT 1").get() as { id: number }).id);
});
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'cloudflare_daily_quota:%'").run();
  getDb().prepare("DELETE FROM api_keys WHERE platform='cloudflare'").run();
});

describe('Cloudflare shared daily neurons allowance', () => {
  it('blocks another token of the same account, without blocking a different account', () => {
    expect(recordCloudflareAccountDailyExhaustion('account-a:token-one', DAILY)).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-a:token-two')).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-b:token-one')).toBe(false);
  });

  it('does not confuse transient 429 or other providers with a daily neurons exhaustion', () => {
    expect(recordCloudflareAccountDailyExhaustion('account-a:token-one', { status: 429, message: 'Too Many Requests' })).toBe(false);
    expect(recordCloudflareAccountDailyExhaustion('account-a:token-one', { status: 402, message: DAILY.message })).toBe(false);
    expect(isCloudflareAccountDailyBlocked('account-a:token-two')).toBe(false);
  });

  it('uses UTC reset, respects longer Retry-After and expires without an unlock job', () => {
    const now = Date.UTC(2026, 9, 20, 23, 59, 58);
    expect(recordCloudflareAccountDailyExhaustion('account-a:a', DAILY, now)).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-a:b', now + 1000)).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-a:b', now + 2000)).toBe(false);
    expect(recordCloudflareAccountDailyExhaustion('account-a:a', { ...DAILY, retryAfterMs: 30_000 }, now)).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-a:b', now + 2000)).toBe(true);
    expect(isCloudflareAccountDailyBlocked('account-a:b', now + 30_000)).toBe(false);
  });

  it('persists account cooldown in settings (not just process memory)', () => {
    recordCloudflareAccountDailyExhaustion('account-a:a', DAILY);
    const row = getDb().prepare("SELECT value FROM settings WHERE key LIKE 'cloudflare_daily_quota:%'").get() as { value: string };
    expect(Number(row.value)).toBeGreaterThan(Date.now());
    expect(isCloudflareAccountDailyBlocked('account-a:b')).toBe(true);
  });

  it('router declines a blocked account and accepts a different Cloudflare account', () => {
    insertKey('account-a:token-one');
    insertKey('account-a:token-two');
    recordCloudflareAccountDailyExhaustion('account-a:token-one', DAILY);
    expect(routePinnedModel(modelId)).toBeNull();
    expect(hasUsableKeyForModel(modelId)).toBe(false);
    insertKey('account-b:token-three');
    const route = routePinnedModel(modelId);
    expect(route?.apiKey).toBe('account-b:token-three');
    route?.release?.();
  });
});
