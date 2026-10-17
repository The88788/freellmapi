import { OpenAICompatProvider } from './openai-compat.js';
import type { ProviderFetchOptions } from './base.js';

/**
 * APInex Free account limit is 5 inference requests per rolling minute,
 * shared between all free/* models. Pace request starts at 12.1s intervals
 * rather than rejecting the sixth DSH tool-followup request immediately.
 *
 * This is a per-process dispatch gate; deployments with multiple independent
 * server processes require a shared distributed limiter. Upstream Retry-After
 * and daily balance limits remain authoritative.
 */
export class ApinexPacer {
  private nextStartMs = 0;
  private tail: Promise<void> = Promise.resolve();

  async acquire(signal?: AbortSignal): Promise<void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal?.aborted) throw signal.reason ?? new Error('APInex request aborted');
      const delay = Math.max(0, this.nextStartMs - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          }, delay);
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('APInex request aborted'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          // Abort may have raced between the preflight and listener setup.
          if (signal?.aborted) { abort(); return; }
        });
      }
      if (signal?.aborted) throw signal.reason ?? new Error('APInex request aborted');
      this.nextStartMs = Date.now() + 12_100;
    } finally {
      release();
    }
  }
}

const sharedPacer = new ApinexPacer();

export class ApinexProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'apinex',
      name: 'APInex',
      baseUrl: 'https://api.apinex.bond/v1',
    });
  }

  protected override async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs?: number,
    fetchOpts?: ProviderFetchOptions,
  ): Promise<Response> {
    // Health checks and GET /models do not consume the 5 RPM inference bucket.
    if (url.endsWith('/chat/completions') && init.method?.toUpperCase() === 'POST') {
      await sharedPacer.acquire(fetchOpts?.signal);
    }
    return super.fetchWithTimeout(url, init, timeoutMs, fetchOpts);
  }
}
