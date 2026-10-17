import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApinexInferencePacer, ApinexProvider, APINEX_INFERENCE_MIN_GAP_MS } from '../../providers/apinex.js';
import { getDb, initDb } from '../../db/index.js';

const completion = (model: string) => new Response(JSON.stringify({
  id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('APInex shared free 5 RPM pacing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('spaces concurrent model starts across free IDs', async () => {
    let t = 50_000;
    const starts: number[] = [];
    const pacer = new ApinexInferencePacer(12_500, () => t, async (ms) => { t += ms; });
    await Promise.all([
      pacer.wait().then(() => starts.push(t)),
      pacer.wait().then(() => starts.push(t)),
      pacer.wait().then(() => starts.push(t)),
      pacer.wait().then(() => starts.push(t)),
      pacer.wait().then(() => starts.push(t)),
    ]);
    expect(starts).toEqual([50_000, 62_500, 75_000, 87_500, 100_000]);
    expect(APINEX_INFERENCE_MIN_GAP_MS).toBeGreaterThan(12_000);
  });

  it('does not consume an additional slot for an already aborted request', async () => {
    let t = 1000;
    const pacer = new ApinexInferencePacer(12_500, () => t, async (ms) => { t += ms; });
    await pacer.wait();
    const controller = new AbortController();
    controller.abort();
    await expect(pacer.wait(controller.signal)).rejects.toThrow();
    await pacer.wait();
    expect(t).toBe(13_500);
  });

  it('rejects paid IDs locally before sending any request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const provider = new ApinexProvider();
    await expect(provider.chatCompletion('key', [], 'gpt-6-luna')).rejects.toMatchObject({ status: 403 });
    const stream = async () => { for await (const _ of provider.streamChatCompletion('key', [], 'gpt-6-luna')) {} };
    await expect(stream()).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('APInex curated baseline', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => {
    getDb().close();
    delete process.env.ENCRYPTION_KEY;
  });

  it('ships five readable free models without Fetch and disables unverified tools', () => {
    const rows = getDb().prepare("SELECT model_id,display_name,context_window,supports_tools FROM models WHERE platform='apinex'").all() as Array<{model_id:string;display_name:string;context_window:number;supports_tools:number}>;
    expect(rows).toHaveLength(5);
    expect(rows.every(row => row.model_id.startsWith('free/'))).toBe(true);
    expect(rows.every(row => row.context_window === 1_000_000)).toBe(true);
    expect(rows.find(row => row.model_id === 'free/deepseek-v4.1-flash')?.supports_tools).toBe(1);
    expect(rows.find(row => row.model_id === 'free/gemini-3.8-flash')?.supports_tools).toBe(0);
    expect(rows.every(row => !row.display_name.startsWith('free/'))).toBe(true);
  });
});
