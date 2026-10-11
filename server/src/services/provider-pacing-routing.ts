/**
 * Opt-in bridge between the synchronous legacy router and the queued scheduler.
 *
 * No scheduler is installed at startup in Stage 2. The feature is OFF and the
 * old routeRequest path is used unchanged until a validated config/persistent
 * store and lifecycle hook are installed by Stage 3.
 *
 * Never hold a RouteResult/legacy lease while awaiting a pacing grant.
 */
import { routeRequest, type RouteResult, type PacingRouteOptions } from './router.js';
import { subscribeLeaseRelease } from './ratelimit.js';
import {
  ProviderPacingCore, PacingError, type PacingIdentity,
} from './provider-pacing-core.js';

type RouteArgs = Parameters<typeof routeRequest>;
let activeScheduler: ProviderPacingCore | undefined;
let unsubscribeLeaseRelease: (() => void) | undefined;

/** Installs only a fully initialized, single-writer scheduler. Not called by default. */
export function installProviderPacingScheduler(scheduler: ProviderPacingCore | undefined): void {
  unsubscribeLeaseRelease?.();
  unsubscribeLeaseRelease = undefined;
  activeScheduler = scheduler;
  if (scheduler) {
    // A stream ending unlocks an existing legacy concurrency/TPM gate.
    // Wake its waiters immediately rather than polling or guessing an ETA.
    unsubscribeLeaseRelease = subscribeLeaseRelease(() => scheduler.notifyWaiters());
  }
}

export function isProviderPacingInstalled(): boolean {
  return activeScheduler !== undefined;
}

/** Sanitized statistics: no credentials, request content or client identifiers. */
export function providerPacingRuntimeStatus() {
  const scheduler = activeScheduler;
  return {
    installed: scheduler !== undefined,
    enabled: scheduler?.config.enabled ?? false,
    status: scheduler?.status() ?? { pending: 0, inflight: 0, stopped: true, buckets: [] },
    counters: scheduler?.counters() ?? {
      enqueued: 0, admitted: 0, cancelled: 0, timedOut: 0, overloaded: 0,
    },
  };
}

function select(args: RouteArgs, skipped: Set<string>, pacing: PacingRouteOptions): RouteResult {
  const copy: unknown[] = [...args];
  copy[1] = skipped.size ? skipped : undefined;
  // routeRequest(...): pacing is argument #12 (zero-based index 11).
  copy[11] = pacing;
  return routeRequest(...(copy as RouteArgs));
}

function identityOf(route: RouteResult): PacingIdentity {
  return {
    platform: route.platform,
    modelId: route.modelId,
    keyId: route.keyId,
    endpointScope: route.endpointScope,
    // Account and shared quota-pool ids require verified metadata/configuration.
    // Do not infer that two provider credentials have separate physical accounts.
  };
}

function sameCandidate(a: RouteResult, b: RouteResult): boolean {
  return a.modelDbId === b.modelDbId
    && a.keyId === b.keyId
    && a.platform === b.platform
    && a.modelId === b.modelId
    && a.endpointScope === b.endpointScope;
}

/** Called from all four shared-fallback chat surfaces. Off means exact legacy route. */
export function schedulePacedRoute(
  clientId: string,
  signal: AbortSignal | undefined,
  ...args: RouteArgs
): RouteResult | Promise<RouteResult> {
  const scheduler = activeScheduler;
  if (!scheduler || !scheduler.config.enabled) return routeRequest(...args);
  return admittedRoute(scheduler, clientId, signal, args);
}

/**
 * The committed legacy route is now acquired INSIDE scheduler.admit(), before
 * the durable pacing timestamp. A failed commit never spends a pacing slot,
 * and a failed SQLite write immediately releases the legacy budget/lease.
 * Nothing in this function awaits between the two reservations.
 */
async function admittedRoute(
  scheduler: ProviderPacingCore,
  clientId: string,
  signal: AbortSignal | undefined,
  args: RouteArgs,
): Promise<RouteResult> {
  const skipKeys = new Set(args[1] ?? []);
  let totalQueueWaitMs = 0;

  for (let revision = 0; revision < 4; revision++) {
    if (signal?.aborted) throw new PacingError('client_cancelled', 499);

    const preview = select(args, skipKeys, { mode: 'preview' });
    let grant;
    try {
      grant = await scheduler.schedule({
        identity: identityOf(preview),
        clientId,
        estimatedTokens: args[0] ?? 1000,
        signal,
        readiness: () => {
          // The profile/key could change during a 65-second queue wait.
          // This check reads the exact model+key and may not reserve anything.
          try {
            const live = select(args, skipKeys, {
              mode: 'preview', modelDbId: preview.modelDbId, keyId: preview.keyId,
            });
            if (!sameCandidate(preview, live)) return { ready: false, readyAtMs: null };
            return {
              ready: !live.pacingTemporarilyBlocked,
              readyAtMs: live.pacingReadyAtMs ?? null,
            };
          } catch {
            return { ready: false, readyAtMs: null };
          }
        },
        onAdmit: () => {
          if (signal?.aborted) throw new PacingError('client_cancelled', 499);
          // The original routeRequest(commit) reserves the EXISTING month
          // budget + key lease. The scheduler will roll it back if DB commit
          // fails before any grant is issued.
          const committed = select(args, skipKeys, {
            mode: 'commit', modelDbId: preview.modelDbId, keyId: preview.keyId,
          });
          if (!sameCandidate(preview, committed)) {
            committed.release?.();
            throw new PacingCandidateChangedError();
          }
          return {
            resource: committed,
            rollback: () => committed.release?.(),
          };
        },
      });
    } catch (err) {
      // No upstream request happened, and no confirmed pacing start was spent.
      // A removed or newly blocked key can be excluded and the remaining
      // permitted chain considered. Operational pacing errors are terminal.
      if (err instanceof PacingError) throw err;
      skipKeys.add(`${preview.platform}:${preview.modelId}:${preview.keyId}`);
      if (revision === 3) throw err;
      continue;
    }

    totalQueueWaitMs += grant.waitedMs;
    const committed = grant.resource as RouteResult | undefined;
    // Important even for zero matching rules: a successful scheduler call
    // MUST carry the exact route reserved by its onAdmit hook.
    if (!committed) {
      grant.release(0);
      throw new PacingError('pacing_store_error', 503);
    }
    if (signal?.aborted) {
      try { committed.release?.(); } finally { grant.release(0); }
      throw new PacingError('client_cancelled', 499);
    }

    const originalRelease = committed.release;
    let released = false;
    committed.release = () => {
      if (released) return;
      released = true;
      try { originalRelease?.(); } finally { grant.release(); }
    };
    committed.pacingWaitedMs = totalQueueWaitMs;
    return committed;
  }
  throw new PacingError('rate_limit_exceeded', 429);
}

class PacingCandidateChangedError extends Error {
  constructor() { super('Pacing candidate changed while queued'); }
}
