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
import {
  ProviderPacingCore, PacingError, type PacingIdentity,
} from './provider-pacing-core.js';

type RouteArgs = Parameters<typeof routeRequest>;
let activeScheduler: ProviderPacingCore | undefined;

/** Installs only a fully initialized, single-writer scheduler. Not called by default. */
export function installProviderPacingScheduler(scheduler: ProviderPacingCore | undefined): void {
  activeScheduler = scheduler;
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

async function admittedRoute(
  scheduler: ProviderPacingCore,
  clientId: string,
  signal: AbortSignal | undefined,
  args: RouteArgs,
): Promise<RouteResult> {
  const skipKeys = new Set(args[1] ?? []);
  let totalQueueWaitMs = 0;
  // Bound a route that changes while waiting. A changed key/model is retried
  // with a fresh preview; it never inherits the prior grant's identity.
  for (let revision = 0; revision < 4; revision++) {
    if (signal?.aborted) throw new PacingError('client_cancelled', 499);
    const preview = select(args, skipKeys, { mode: 'preview' });
    // Preview does not hold a decrypted API key, budget reservation, or lease.
    const grant = await scheduler.schedule({
      identity: identityOf(preview),
      clientId,
      estimatedTokens: args[0] ?? 1000,
      signal,
    });
    totalQueueWaitMs += grant.waitedMs;
    try {
      if (signal?.aborted) throw new PacingError('client_cancelled', 499);
      const committed = select(args, skipKeys, {
        mode: 'commit', modelDbId: preview.modelDbId, keyId: preview.keyId,
      });
      if (!sameCandidate(preview, committed)) {
        // If the client explicitly pinned a model, do not reroute silently
        // to a substitute. Revalidate the same candidate in the next pass.
        committed.release?.();
        grant.release(0);
        skipKeys.add(`${preview.platform}:${preview.modelId}:${preview.keyId}`);
        continue;
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
    } catch (err) {
      grant.release(0);
      // A routing failure after waiting means the candidate changed; exclude
      // this key for the current inbound attempt and reconsider the full chain.
      // Do NOT retry a failed storage commit or an explicit queue cancel.
      if (err instanceof PacingError) throw err;
      skipKeys.add(`${preview.platform}:${preview.modelId}:${preview.keyId}`);
      if (revision === 3) throw err;
    }
  }
  throw new PacingError('rate_limit_exceeded', 429);
}
