/**
 * Provider Pacing & Queue: dependency-free, opt-in, single-process admission core.
 *
 * IMPORTANT: this is NOT an adapter for router.ts. A caller must acquire this
 * grant BEFORE calling code that reserves the existing key lease/monthly budget,
 * then revalidate that exact route and synchronously perform the existing
 * reservations before starting upstream. Never hold a legacy RouteResult while
 * queued. The adapter is deliberately deferred until its atomicity is tested.
 *
 * No credentials, prompt bodies, URLs or response data are retained here.
 */

export interface PacingIdentity {
  platform: string;
  modelId: string;
  keyId: number;
  endpointScope?: string;
  /** Only set after determining the real provider account. */
  accountId?: string;
  /** Only set after confirming shared physical quota ownership. */
  quotaPoolId?: string;
}

export type PacingScope = 'global' | 'provider' | 'model' | 'key' | 'model-key' | 'account' | 'pool';

export interface PacingRule {
  id: string;
  enabled: boolean;
  scope: PacingScope;
  match?: {
    platform?: string;
    modelId?: string;
    keyId?: number;
    endpointScope?: string;
    accountId?: string;
    quotaPoolId?: string;
  };
  limits: {
    minStartIntervalMs?: number;
    rpm?: number;
    tpm?: number;
    maxConcurrent?: number;
  };
  queue: { maxWaitMs: number; maxPendingPerBucket: number };
}

export interface PacingConfig {
  enabled: boolean;
  maxPendingGlobal: number;
  maxPendingPerClient: number;
  rules: PacingRule[];
}

export interface PacingRequest {
  identity: PacingIdentity;
  /** Stable, pseudonymous client identifier, not an Authorization header. */
  clientId: string;
  estimatedTokens: number;
  signal?: AbortSignal;
  /**
   * Optional read-only readiness check against already-existing limiter gates.
   * This is NOT permission to dispatch; routeRequest(commit) must revalidate.
   * Deadline null means wake on legacy lease release or queue timeout.
   */
  readiness?: () => { ready: boolean; readyAtMs: number | null };
  /**
   * Synchronous legacy-route admission. This callback must atomically
   * revalidate the candidate and take the EXISTING key lease/month budget.
   * It is invoked only after pacing + legacy readiness checks pass, and
   * before we persist the next pacing start. No async code is allowed.
   * rollback() must be idempotent; it runs if persisting the start fails.
   */
  onAdmit?: () => { resource: unknown; rollback(): void };
}

export interface PacingClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** Pluggable durable state: commits must be synchronous and atomic. */
export interface PacingStartStore {
  readNextEligible(bucketKey: string): number;
  /** Must commit ALL changes atomically or throw without applying any. */
  commitStarts(nextEligible: ReadonlyArray<{ bucketKey: string; nextEligibleAtMs: number }>): void;
}

export type PacingErrorCode = 'queue_overloaded' | 'rate_limit_exceeded' | 'quota_too_large' | 'client_cancelled' | 'queue_stopped' | 'invalid_policy' | 'pacing_store_error';

export class PacingError extends Error {
  readonly code: PacingErrorCode;
  readonly status: number;
  readonly retryAtMs: number | undefined;
  constructor(code: PacingErrorCode, status: number, retryAtMs?: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAtMs = retryAtMs;
    this.name = 'PacingError';
  }
}

export interface PacingGrant {
  readonly startedAtMs: number;
  readonly waitedMs: number;
  readonly policyIds: readonly string[];
  /** Optional payload acquired synchronously alongside pacing admission. */
  readonly resource?: unknown;
  /** Exactly once. For unknown actual usage, keeps the safe estimate. */
  release(actualTokens?: number): void;
}

export interface PacingStatus {
  pending: number;
  inflight: number;
  stopped: boolean;
  buckets: ReadonlyArray<{
    policyId: string;
    scope: PacingScope;
    pending: number;
    inflight: number;
    nextEligibleAtMs: number;
  }>;
}

const realClock: PacingClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Usage { atMs: number; tokens: number; active: boolean }
interface Bucket {
  key: string;
  rule: PacingRule;
  nextEligibleAtMs: number;
  starts: number[];
  usages: Usage[];
  inflight: number;
  pending: Waiter[];
}
interface Waiter {
  request: PacingRequest;
  buckets: Bucket[];
  queuedAtMs: number;
  expiresAtMs: number;
  resolve(grant: PacingGrant): void;
  reject(err: Error): void;
  onAbort?: () => void;
}

const MINUTE = 60_000;
const MAX_WAIT = 10 * MINUTE;
const MAX_TIMER = 2_147_483_647;

function finitePositiveInt(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function ensureIdentity(id: PacingIdentity): void {
  if (!id.platform || !id.modelId || !Number.isSafeInteger(id.keyId) || id.keyId < 0) {
    throw new PacingError('invalid_policy', 400);
  }
}

/** Reject unsafe scopes rather than accidentally grouping unrelated accounts. */
export function validatePacingConfig(config: PacingConfig): void {
  if (typeof config.enabled !== 'boolean' ||
    !finitePositiveInt(config.maxPendingGlobal) ||
    !finitePositiveInt(config.maxPendingPerClient) ||
    !Array.isArray(config.rules)) throw new PacingError('invalid_policy', 400);
  const ids = new Set<string>();
  for (const r of config.rules) {
    if (!r || !r.id || ids.has(r.id) || typeof r.enabled !== 'boolean' ||
      !(['global', 'provider', 'model', 'key', 'model-key', 'account', 'pool'] as string[]).includes(r.scope) ||
      !r.limits || !r.queue ||
      !finitePositiveInt(r.limits.minStartIntervalMs) ||
      !finitePositiveInt(r.limits.rpm) ||
      !finitePositiveInt(r.limits.tpm) ||
      !finitePositiveInt(r.limits.maxConcurrent) ||
      !finitePositiveInt(r.queue.maxWaitMs) ||
      !finitePositiveInt(r.queue.maxPendingPerBucket) ||
      r.queue.maxWaitMs > MAX_WAIT) throw new PacingError('invalid_policy', 400);
    const m = r.match ?? {};
    if ((r.scope !== 'global' && !m.platform) ||
      ((r.scope === 'model' || r.scope === 'model-key') && !m.modelId) ||
      ((r.scope === 'key' || r.scope === 'model-key') && (!Number.isSafeInteger(m.keyId) || m.keyId! < 0)) ||
      (r.scope === 'account' && !m.accountId) ||
      (r.scope === 'pool' && !m.quotaPoolId)) {
      throw new PacingError('invalid_policy', 400);
    }
    if ((m.keyId !== undefined && (!Number.isSafeInteger(m.keyId) || m.keyId < 0)) ||
      (r.scope === 'global' && Object.keys(m).length > 0)) throw new PacingError('invalid_policy', 400);
    ids.add(r.id);
  }
}

/** Encoded tuple, NOT colon-delimited: model IDs and endpoints may contain ':'. */
export function pacingBucketKey(rule: PacingRule, id: PacingIdentity): string {
  let parts: (string | number)[];
  switch (rule.scope) {
    case 'global': parts = []; break;
    case 'provider': parts = [id.platform]; break;
    case 'model': parts = [id.platform, id.modelId, id.endpointScope ?? '']; break;
    case 'key': parts = [id.platform, id.keyId]; break;
    case 'model-key': parts = [id.platform, id.modelId, id.endpointScope ?? '', id.keyId]; break;
    case 'account': parts = [id.platform, id.accountId!]; break;
    case 'pool': parts = [id.platform, id.quotaPoolId!]; break;
  }
  return JSON.stringify([rule.id, rule.scope, ...parts]);
}

function matchRule(rule: PacingRule, id: PacingIdentity): boolean {
  if (!rule.enabled) return false;
  const m = rule.match ?? {};
  if (m.platform !== undefined && m.platform !== id.platform) return false;
  if (m.modelId !== undefined && m.modelId !== id.modelId) return false;
  if (m.keyId !== undefined && m.keyId !== id.keyId) return false;
  if (m.endpointScope !== undefined && m.endpointScope !== (id.endpointScope ?? '')) return false;
  if (m.accountId !== undefined && m.accountId !== id.accountId) return false;
  if (m.quotaPoolId !== undefined && m.quotaPoolId !== id.quotaPoolId) return false;
  // Never silently collapse unknown account identities into a shared bucket.
  if (rule.scope === 'account' && id.accountId === undefined) return false;
  if (rule.scope === 'pool' && id.quotaPoolId === undefined) return false;
  return true;
}

export class ProviderPacingCore {
  readonly config: PacingConfig;
  private readonly clock: PacingClock;
  private readonly buckets = new Map<string, Bucket>();
  private readonly waiting: Waiter[] = [];
  private timer: unknown;
  private stopped = false;
  private draining = false;
  private drainRequested = false;
  private inflight = 0;
  private readonly metrics = {
    enqueued: 0, admitted: 0, cancelled: 0, timedOut: 0, overloaded: 0,
  };

  constructor(
    config: PacingConfig,
    opts: { clock?: PacingClock; store?: PacingStartStore } = {},
  ) {
    validatePacingConfig(config);
    this.config = config;
    this.clock = opts.clock ?? realClock;
    this.store = opts.store;
  }
  private readonly store: PacingStartStore | undefined;

  private matchingBuckets(identity: PacingIdentity): Bucket[] {
    const result: Bucket[] = [];
    for (const rule of this.config.rules) {
      if (!matchRule(rule, identity)) continue;
      const key = pacingBucketKey(rule, identity);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        let nextEligibleAtMs = 0;
        try {
          nextEligibleAtMs = this.store?.readNextEligible(key) ?? 0;
          if (!Number.isFinite(nextEligibleAtMs) || nextEligibleAtMs < 0) throw new Error('invalid persisted timestamp');
        } catch {
          throw new PacingError('pacing_store_error', 503);
        }
        bucket = { key, rule, nextEligibleAtMs, starts: [], usages: [], inflight: 0, pending: [] };
        this.buckets.set(key, bucket);
      }
      result.push(bucket);
    }
    return result;
  }

  private prune(bucket: Bucket, now: number): void {
    bucket.starts = bucket.starts.filter(at => at > now - MINUTE);
    bucket.usages = bucket.usages.filter(u => u.active || u.atMs > now - MINUTE);
  }

  private available(buckets: Bucket[], estimatedTokens: number, now: number): number {
    let nextAtMs = now;
    for (const bucket of buckets) {
      this.prune(bucket, now);
      const { limits } = bucket.rule;
      if (limits.tpm !== undefined && estimatedTokens > limits.tpm) {
        throw new PacingError('quota_too_large', 429);
      }
      if (limits.maxConcurrent !== undefined && bucket.inflight >= limits.maxConcurrent) {
        nextAtMs = Infinity; // wait for release event; timeout is separate
      }
      nextAtMs = Math.max(nextAtMs, bucket.nextEligibleAtMs);
      if (limits.rpm !== undefined && bucket.starts.length >= limits.rpm) {
        const oldest = bucket.starts[bucket.starts.length - limits.rpm]!;
        nextAtMs = Math.max(nextAtMs, oldest + MINUTE);
      }
      if (limits.tpm !== undefined) {
        let used = bucket.usages.reduce((n, u) => n + u.tokens, 0);
        if (used + estimatedTokens > limits.tpm) {
          let tokenAt = now;
          // Active reservations don't expire: only release/settlement can change them.
          const events = bucket.usages.filter(u => !u.active).sort((a, b) => a.atMs - b.atMs);
          tokenAt = Infinity;
          for (const u of events) {
            used -= u.tokens;
            if (used + estimatedTokens <= limits.tpm) {
              tokenAt = u.atMs + MINUTE;
              break;
            }
          }
          nextAtMs = Math.max(nextAtMs, tokenAt);
        }
      }
    }
    return nextAtMs;
  }

  /** Synchronous admission: no await, no partial reservation on rejection. */
  private admit(
    buckets: Bucket[], estimatedTokens: number, queuedAtMs: number,
    fairnessWaiter?: Waiter,
    readiness?: PacingRequest['readiness'],
    onAdmit?: PacingRequest['onAdmit'],
    signal?: AbortSignal,
  ): PacingGrant | null {
    const now = this.clock.now();
    // FIFO for EACH applicable quota bucket. One waiter can belong to many buckets.
    if (buckets.some(b => b.pending.length > 0 && b.pending[0] !== fairnessWaiter)) return null;
    if (this.available(buckets, estimatedTokens, now) > now) return null;
    // Do not reserve our own scheduler tokens/start before the legacy
    // limiter is also ready. A release event or the next timestamp wakes us.
    if (readiness && !readiness().ready) return null;
    const changes = buckets
      .filter(b => b.rule.limits.minStartIntervalMs !== undefined)
      .map(b => ({ bucketKey: b.key, nextEligibleAtMs: now + b.rule.limits.minStartIntervalMs! }));
    // Exact legacy commit and pacing start persistence share ONE synchronous
    // admission turn: if the SQLite write fails, release the legacy budget
    // and lease before any upstream byte can be sent.
    let claimed: ReturnType<NonNullable<PacingRequest['onAdmit']>> | undefined;
    if (onAdmit) claimed = onAdmit();
    // Cancellation may occur synchronously during candidate selection. The
    // caller has not seen a grant, so neither resources nor a pacing start
    // may be retained for that cancelled request.
    if (signal?.aborted) {
      try { claimed?.rollback(); } catch { /* preserve abort */ }
      throw new PacingError('client_cancelled', 499);
    }
    try {
      // Fail-closed: do not dispatch if the durable reservation fails.
      if (changes.length) this.store?.commitStarts(changes);
    } catch {
      try { claimed?.rollback(); } catch { /* preserve storage failure */ }
      throw new PacingError('pacing_store_error', 503);
    }
    for (const b of buckets) {
      if (b.rule.limits.minStartIntervalMs !== undefined) {
        b.nextEligibleAtMs = now + b.rule.limits.minStartIntervalMs;
      }
      b.starts.push(now);
      b.inflight++;
    }
    const usages: Usage[] = buckets.map(() => ({ atMs: now, tokens: estimatedTokens, active: true }));
    for (let i = 0; i < buckets.length; i++) buckets[i]!.usages.push(usages[i]!);
    this.inflight++;
    this.metrics.admitted++;
    let released = false;
    return {
      startedAtMs: now,
      waitedMs: Math.max(0, now - queuedAtMs),
      policyIds: buckets.map(b => b.rule.id),
      ...(claimed ? { resource: claimed.resource } : {}),
      release: (actualTokens?: number) => {
        if (released) return;
        released = true;
        const end = this.clock.now();
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i]!;
          const u = usages[i]!;
          b.inflight--;
          u.active = false;
          if (actualTokens !== undefined && Number.isSafeInteger(actualTokens) && actualTokens >= 0) {
            u.tokens = actualTokens;
          }
          // Streams lasting over a minute still counted their provisional usage;
          // account actual usage in the completion minute for conservative safety.
          if (end - u.atMs >= MINUTE) u.atMs = end;
        }
        this.inflight--;
        this.drain();
      },
    };
  }

  /** Grant never holds existing router/key-budget leases while queued. */
  schedule(request: PacingRequest): Promise<PacingGrant> {
    if (this.stopped) return Promise.reject(new PacingError('queue_stopped', 503));
    if (request.signal?.aborted) return Promise.reject(new PacingError('client_cancelled', 499));
    if (!request.clientId || !Number.isSafeInteger(request.estimatedTokens) || request.estimatedTokens < 0) {
      return Promise.reject(new PacingError('invalid_policy', 400));
    }
    try { ensureIdentity(request.identity); } catch (err) { return Promise.reject(err); }
    const now = this.clock.now();
    if (!this.config.enabled) return Promise.resolve({
      startedAtMs: now, waitedMs: 0, policyIds: [], release() {},
    });
    let buckets: Bucket[];
    try { buckets = this.matchingBuckets(request.identity); } catch (err) { return Promise.reject(err); }
    if (buckets.length === 0) {
      try {
        const claim = request.onAdmit?.();
        return Promise.resolve({
          startedAtMs: now, waitedMs: 0, policyIds: [],
          ...(claim ? { resource: claim.resource } : {}),
          release() {},
        });
      } catch (err) { return Promise.reject(err); }
    }
    try {
      const grant = this.admit(
        buckets, request.estimatedTokens, now, undefined, request.readiness, request.onAdmit,
        request.signal,
      );
      if (grant) return Promise.resolve(grant);
      // Validate impossible TPM before queuing, even if another waiter is ahead.
      this.available(buckets, request.estimatedTokens, now);
    } catch (err) { return Promise.reject(err); }
    if (this.waiting.length >= this.config.maxPendingGlobal ||
      this.waiting.filter(w => w.request.clientId === request.clientId).length >= this.config.maxPendingPerClient ||
      buckets.some(b => b.pending.length >= b.rule.queue.maxPendingPerBucket)) {
      this.metrics.overloaded++;
      return Promise.reject(new PacingError('queue_overloaded', 503));
    }
    const maxWaitMs = Math.min(...buckets.map(b => b.rule.queue.maxWaitMs));
    const expiresAtMs = now + maxWaitMs;
    return new Promise<PacingGrant>((resolve, reject) => {
      const waiter: Waiter = { request, buckets, queuedAtMs: now, expiresAtMs, resolve, reject };
      waiter.onAbort = () => {
        this.metrics.cancelled++;
        this.removeWaiter(waiter);
        reject(new PacingError('client_cancelled', 499));
        this.drain();
      };
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      for (const b of buckets) b.pending.push(waiter);
      this.metrics.enqueued++;
      this.reschedule();
    });
  }

  private removeWaiter(waiter: Waiter): void {
    const i = this.waiting.indexOf(waiter);
    if (i < 0) return;
    this.waiting.splice(i, 1);
    for (const b of waiter.buckets) {
      const j = b.pending.indexOf(waiter);
      if (j >= 0) b.pending.splice(j, 1);
    }
    if (waiter.onAbort) waiter.request.signal?.removeEventListener('abort', waiter.onAbort);
  }

  private drain(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
    // No await: all checks and reservations remain serialized on this process.
    for (const waiter of [...this.waiting]) {
      if (!this.waiting.includes(waiter)) continue;
      const now = this.clock.now();
      if (waiter.expiresAtMs <= now) {
        let retryAt: number | undefined;
        try {
          const possible = this.available(waiter.buckets, waiter.request.estimatedTokens, now);
          if (Number.isFinite(possible)) retryAt = possible;
        } catch { /* expiration retains rate_limit_exceeded */ }
        this.metrics.timedOut++;
        this.removeWaiter(waiter);
        waiter.reject(new PacingError('rate_limit_exceeded', 429, retryAt));
        continue;
      }
      try {
        const grant = this.admit(
          waiter.buckets, waiter.request.estimatedTokens, waiter.queuedAtMs,
          waiter, waiter.request.readiness, waiter.request.onAdmit,
          waiter.request.signal,
        );
        if (grant) {
          this.removeWaiter(waiter);
          waiter.resolve(grant);
        }
      } catch (err) {
        this.removeWaiter(waiter);
        waiter.reject(err instanceof Error ? err : new PacingError('invalid_policy', 503));
      }
    }
    } finally {
      this.draining = false;
      this.reschedule();
      if (this.drainRequested) {
        this.drainRequested = false;
        this.drain();
      }
    }
  }

  private reschedule(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.waiting.length) return;
    const now = this.clock.now();
    let wakeAt = Math.min(...this.waiting.map(w => w.expiresAtMs));
    for (const w of this.waiting) {
      // Respect FIFO: a follower cannot advance before earlier waiter.
      if (w.buckets.some(b => b.pending[0] !== w)) continue;
      try {
        const earliest = this.available(w.buckets, w.request.estimatedTokens, now);
        if (earliest > now && Number.isFinite(earliest)) wakeAt = Math.min(wakeAt, earliest);
        // Also honor legacy RPM/TPM/cooldown availability. A lease with an
        // unknown completion time will wake us through notifyWaiters().
        const eligibility = w.request.readiness?.();
        if (eligibility && !eligibility.ready
          && eligibility.readyAtMs !== null
          && eligibility.readyAtMs > now) {
          wakeAt = Math.min(wakeAt, eligibility.readyAtMs);
        }
        // Admission that's ready at time now is triggered by drain/release,
        // not a 0ms recurring timer.
      } catch { /* drain will surface the error on the next wake */ }
    }
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.drain(); },
      Math.max(1, Math.min(MAX_TIMER, wakeAt - now)));
  }

  /** Called by the legacy limiter on lease release, not by a polling loop. */
  notifyWaiters(): void { this.drain(); }

  /** Cancels undispached waiters, does not abort already dispatched attempts. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of [...this.waiting]) {
      this.removeWaiter(w);
      w.reject(new PacingError('queue_stopped', 503));
    }
  }

  status(): PacingStatus {
    return {
      pending: this.waiting.length,
      inflight: this.inflight,
      stopped: this.stopped,
      buckets: [...this.buckets.values()].map(b => ({
        policyId: b.rule.id, scope: b.rule.scope,
        pending: b.pending.length, inflight: b.inflight,
        nextEligibleAtMs: b.nextEligibleAtMs,
      })),
    };
  }

  counters(): Readonly<typeof this.metrics> { return { ...this.metrics }; }
}