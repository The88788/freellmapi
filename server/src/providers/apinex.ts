import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const APINEX_BASE_URL = 'https://api.apinex.bond/v1';
/** Five free-tier inference requests/minute are shared by all free/* models.
 * Space STARTS by slightly more than 12s to avoid boundary/jitter 429s.
 * This is not a per-model RPM and must not be multiplied by model count. */
export const APINEX_INFERENCE_MIN_GAP_MS = 12_500;

function aborted(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('APInex request aborted while queued', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(aborted(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Serialized admission gate, NOT a serialization of completed responses:
 * long-running SSE responses may overlap, but upstream request starts cannot.
 * A caller cancelled while queued does not consume a rate-limit slot.
 */
export class ApinexInferencePacer {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly gapMs = APINEX_INFERENCE_MIN_GAP_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw aborted(signal);
      const remaining = this.lastStart + this.gapMs - this.now();
      if (remaining > 0) await this.sleep(remaining, signal);
      if (signal?.aborted) throw aborted(signal);
      this.lastStart = this.now();
    } finally {
      release();
    }
  }
}

// One queue per FreeLLMAPI process, regardless of how many keys or free models
// are configured. A process restart resets the in-memory gap; the persisted
// router cooldown and provider-observed quota headers remain authoritative.
const inferencePacer = new ApinexInferencePacer();

function requireFreeRoute(modelId: string): void {
  if (!modelId.startsWith('free/')) {
    throw Object.assign(new Error('APInex paid routes are not enabled by the FreeLLMAPI free-tier adapter'), { status: 403 });
  }
}

/** OpenAI wire format; special handling only for the shared free-tier RPM. */
export class ApinexProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'apinex', name: 'APInex', baseUrl: APINEX_BASE_URL });
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    requireFreeRoute(modelId);
    await inferencePacer.wait(options?.signal);
    return super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    requireFreeRoute(modelId);
    await inferencePacer.wait(options?.signal);
    yield* super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext);
  }
}
