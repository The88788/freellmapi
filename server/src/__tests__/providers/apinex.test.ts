import { describe, expect, it } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { detectPlatform, AUTH_JSON_PROVIDER_MAP } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

describe('APInex gateway integration', () => {
  it('registers an OpenAI-compatible provider with the documented API origin', () => {
    const provider = getProvider('apinex');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('apinex');
    expect((provider as unknown as { baseUrl: string }).baseUrl).toBe('https://api.apinex.bond/v1');
  });

  it('recognizes an API key import and auth.json provider name', () => {
    expect(detectPlatform('APINEX_')).toBe('apinex');
    expect(AUTH_JSON_PROVIDER_MAP.apinex).toBe('apinex');
  });

  it('shares free model quota while separating free and paid wallet pools', () => {
    expect(inferPoolForPlatform('apinex', 'free/kimi-k3')).toBe('apinex::free');
    expect(inferPoolForPlatform('apinex', 'free/deepseek-v4.1-flash')).toBe('apinex::free');
    expect(inferPoolForPlatform('apinex', 'some-paid-model')).toBe('apinex::paid');
  });
});
