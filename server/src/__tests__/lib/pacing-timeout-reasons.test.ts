import { describe, it, expect } from 'vitest';
import {
  requestTerminationReason, newClientAbortError, newHedgeAbortError,
} from '../../lib/error-classify.js';
import {
  exhaustedRetryError, exhaustionErrorPayload, routingExhaustionBody,
} from '../../lib/fallback-loop.js';
import { PacingError } from '../../services/provider-pacing-core.js';

describe('timeout and queue diagnostic taxonomy', () => {
  it('classifies the original Pollinations 60-second error as upstream_timeout', () => {
    const err = new Error('The operation was aborted (pollinations, chat, 60s)');
    expect(requestTerminationReason(err)).toBe('upstream_timeout');
    const result = exhaustedRetryError(err, 1, { attempts: [{
      platform: 'pollinations', modelId: 'community/YoannDev90/muse-glimmer-30b:free',
      keyOrdinal: 1, errorClass: 'timeout',
    }] });
    expect(result).toMatchObject({
      status: 502, code: 'upstream_failed', reason: 'upstream_timeout',
    });
    expect(exhaustionErrorPayload(result).reason).toBe('upstream_timeout');
  });

  it('keeps a provider 429 distinct from an aborted upstream request', () => {
    expect(requestTerminationReason({ status: 429, message: 'rate limited' })).toBe('rate_limit');
    expect(requestTerminationReason(new Error('stream stalled: no data for 90000ms (timeout)')))
      .toBe('stream_stall');
    expect(requestTerminationReason(new Error('no first byte within 120000ms (first-byte timeout)')))
      .toBe('first_byte_timeout');
  });

  it('distinguishes client disconnect and fallback deadline from provider slowness', () => {
    expect(requestTerminationReason(newClientAbortError())).toBe('client_abort');
    expect(requestTerminationReason(newHedgeAbortError())).toBe('fallback_exhausted');
  });

  it('surfaces queue timeout without calling it an upstream failure', () => {
    const result = routingExhaustionBody(new PacingError('rate_limit_exceeded', 429));
    expect(result).toMatchObject({
      status: 429, code: 'rate_limit_exceeded', reason: 'queue_timeout',
    });
    expect(exhaustionErrorPayload(result).reason).toBe('queue_timeout');
  });
});
