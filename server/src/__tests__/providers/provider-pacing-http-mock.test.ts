import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollinationsProvider } from '../../providers/pollinations.js';

/**
 * Real loopback HTTP upstream, no external/paid API. Scaled wall-clock delays
 * exercise actual undici response bodies and AbortSignal cancellation, while
 * the separate fake-clock suite tests the literal 65s/120s timing values.
 */
let server: Server;
let origin: string;
const realFetch = globalThis.fetch.bind(globalThis);
let responseDelay = 0;
let firstChunkDelay = 0;
let nextChunkDelay = 0;
let transport: 'json' | 'sse' = 'json';

const model = 'community/YoannDev90/muse-glimmer-30b:free';
const input = [{ role: 'user' as const, content: 'mock request' }];
const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
  id: 'mock-1', object: 'chat.completion.chunk', created: 1,
  model, choices: [{ index: 0, delta, finish_reason }],
})}\n\n`;

beforeEach(async () => {
  responseDelay = 0;
  firstChunkDelay = 0;
  nextChunkDelay = 0;
  transport = 'json';
  server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    // Consume request body before replying, matching a real upstream gateway.
    req.resume();
    if (transport === 'json') {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-1', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'local-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        }));
      }, responseDelay);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => {
      if (res.destroyed) return;
      res.write(frame({ content: 'part one' }, null));
      setTimeout(() => {
        if (res.destroyed) return;
        res.write(frame({ content: ' part two' }, 'stop'));
        res.end('data: [DONE]\n\n');
      }, nextChunkDelay);
    }, firstChunkDelay);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Mock server has no TCP address');
  origin = `http://127.0.0.1:${address.port}`;
  // Keep the real adapter and real HTTP transport; substitute ONLY its target.
  vi.spyOn(globalThis, 'fetch').mockImplementation((_remoteUrl, init) =>
    realFetch(origin + '/v1/chat/completions', init),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS;
});

describe('pollinations provider with local HTTP mock', () => {
  it('accepts a slow buffered JSON result inside its per-call timeout', async () => {
    responseDelay = 120;
    const provider = new PollinationsProvider();
    const answer = await provider.chatCompletion('non-secret-test-key', input, model, { timeoutMs: 700 });
    expect(answer.choices[0]?.message?.content).toBe('local-ok');
  });

  it('aborts a buffered JSON result exceeding its per-call timeout', async () => {
    responseDelay = 700;
    const provider = new PollinationsProvider();
    await expect(provider.chatCompletion('fake', input, model, { timeoutMs: 180 }))
      .rejects.toThrow(/abort|timeout/i);
  });

  it('distinguishes SSE first byte from later inactivity without fake frames', async () => {
    firstChunkDelay = 140;
    nextChunkDelay = 40;
    transport = 'sse';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS = '100';
    const provider = new PollinationsProvider();
    const seen = [];
    for await (const chunk of provider.streamChatCompletion('fake', input, model, { timeoutMs: 500 })) {
      seen.push(chunk);
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.choices?.[0]?.delta?.content).toBe('part one');
  });

  it('rejects an SSE stream stalled after its first real chunk', async () => {
    firstChunkDelay = 20;
    nextChunkDelay = 700;
    transport = 'sse';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS = '180';
    const provider = new PollinationsProvider();
    const output: unknown[] = [];
    await expect((async () => {
      for await (const chunk of provider.streamChatCompletion('fake', input, model, { timeoutMs: 550 })) {
        output.push(chunk);
      }
    })()).rejects.toThrow(/stream stalled/i);
    expect(output.length).toBeGreaterThanOrEqual(1);
  });

  it('cancels the mock network request when the client AbortSignal fires', async () => {
    responseDelay = 700;
    const client = new AbortController();
    const provider = new PollinationsProvider();
    const pending = provider.chatCompletion('fake', input, model, {
      timeoutMs: 1200, signal: client.signal,
    });
    setTimeout(() => client.abort(new Error('client disconnected — upstream request canceled')), 60);
    await expect(pending).rejects.toThrow(/client disconnected|abort/i);
  });
});
