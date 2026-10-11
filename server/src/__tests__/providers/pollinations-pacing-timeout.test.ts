import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollinationsProvider } from '../../providers/pollinations.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { providerTimeoutSetting } from '../../lib/provider-timeout.js';

// All tests replace fetch: no real Pollinations, NVIDIA, Mistral or paid API.
const MODEL = 'community/YoannDev90/muse-glimmer-30b:free';
const messages = [{ role: 'user' as const, content: 'Test message' }];
const completion = () => new Response(JSON.stringify({
  id: 'mock-1', object: 'chat.completion', created: 1, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
}), { headers: { 'Content-Type': 'application/json' } });

function delayedFetch(delayMs: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      const timer = setTimeout(() => resolve(completion()), delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  );
}

function delayedSse(firstByteDelayMs: number, secondByteDelayMs: number | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const encoder = new TextEncoder();
    const chunk = (content: string, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'mock-stream', object: 'chat.completion.chunk', created: 1, model: MODEL,
        choices: [{ index: 0, delta: { content }, finish_reason: finish }],
      })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(chunk('hello', null)));
          if (secondByteDelayMs === null) {
            controller.enqueue(encoder.encode(chunk('', 'stop')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } else {
            setTimeout(() => {
              controller.enqueue(encoder.encode(chunk(' world', 'stop')));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }, secondByteDelayMs);
          }
        }, firstByteDelayMs);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.PROVIDER_TIMEOUT_POLLINATIONS;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.PROVIDER_TIMEOUT_POLLINATIONS;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS;
});

describe('Pollinations 120s timeout, mock upstream, no network', () => {
  it('keeps the provider-specific legacy 60s default when no override is set', () => {
    const provider = new PollinationsProvider();
    expect(provider.getTimeoutStatus().timeoutMs).toBe(60_000);
    expect(provider.getTimeoutStatus().source).toBe('provider_default');
  });

  it('allows a successful nonstream response at 70 seconds with 120s Pollinations override', async () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    delayedFetch(70_000);
    const pending = provider.chatCompletion('fake-key', messages, MODEL);
    await vi.advanceTimersByTimeAsync(70_000);
    const response = await pending;
    expect(response.choices[0]?.message?.content).toBe('ready');
    expect(provider.getTimeoutStatus()).toMatchObject({
      timeoutMs: 120_000, source: 'environment',
      envName: 'PROVIDER_TIMEOUT_POLLINATIONS', restartRequiredToChange: true,
    });
  });

  it('aborts an unresponsive nonstream mock after the 120s provider deadline', async () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    delayedFetch(130_000);
    const pending = provider.chatCompletion('fake-key', messages, MODEL);
    const rejected = expect(pending).rejects.toThrow(/abort|timeout/i);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
  });

  it('65s queue admission delay does not start the 120s upstream timer early', async () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    delayedFetch(70_000);
    let admitted: Promise<unknown> | undefined;
    setTimeout(() => {
      admitted = provider.chatCompletion('fake-key', messages, MODEL);
    }, 65_000);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(admitted).toBeDefined();
    await vi.advanceTimersByTimeAsync(70_000);
    const response = await admitted as Awaited<ReturnType<typeof provider.chatCompletion>>;
    expect(response.choices[0]?.message?.content).toBe('ready');
  });

  it('slow first SSE byte uses 120s grace, independent of 90s stream stall', async () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    delayedSse(105_000, null);
    const output: unknown[] = [];
    const result = (async () => {
      for await (const frame of provider.streamChatCompletion('fake-key', messages, MODEL)) {
        output.push(frame);
      }
    })();
    await vi.advanceTimersByTimeAsync(105_000);
    await result;
    expect(output.length).toBeGreaterThan(0);
    expect(provider.getTimeoutStatus()).toMatchObject({
      firstByteTimeoutMs: 120_000, streamStallTimeoutMs: 90_000,
    });
  });

  it('distinguishes an SSE stall after the first byte from a slow first byte', async () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    delayedSse(1_000, 100_000);
    const pending = (async () => {
      for await (const _frame of provider.streamChatCompletion('fake-key', messages, MODEL)) { /* drain */ }
    })();
    const rejected = expect(pending).rejects.toThrow(/stream stalled/i);
    await vi.advanceTimersByTimeAsync(92_000);
    await rejected;
  });

  it('does not alter NVIDIA and Mistral configured defaults', () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const nvidia = new OpenAICompatProvider({
      platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://mock.test/v1', timeoutMs: 180_000,
    });
    const mistral = new OpenAICompatProvider({
      platform: 'mistral', name: 'Mistral', baseUrl: 'https://mock.test/v1',
    });
    expect(new PollinationsProvider().getTimeoutStatus().timeoutMs).toBe(120_000);
    expect(nvidia.getTimeoutStatus().timeoutMs).toBe(180_000);
    expect(mistral.getTimeoutStatus().timeoutMs).toBe(60_000);
  });

  it('reports constructor-frozen effective value despite later env changes', () => {
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '120000';
    const provider = new PollinationsProvider();
    process.env.PROVIDER_TIMEOUT_POLLINATIONS = '210000';
    expect(provider.getTimeoutStatus().timeoutMs).toBe(120_000);
    expect(providerTimeoutSetting('pollinations', 60_000).timeoutMs).toBe(210_000);
  });
});
