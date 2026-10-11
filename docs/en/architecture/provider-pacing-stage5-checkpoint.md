# Provider Pacing & Queue: Stage 5 atomic admission checkpoint

**Development status:** atomic single-process admission path added, opt-in still OFF; production activation remains hard-blocked.  
**Base:** fork `The88788/freellmapi`, `feature/provider-pacing-queue`, descendant of Cloudflare Vision PR #1462.  
**Production:** no SSH, no VPS writes, no SQLite migrations on the running instance, no deployment.

## What was changed

1. **Single-turn pacing + legacy admission:** `ProviderPacingCore.schedule(request)` accepts a synchronous `onAdmit()` callback returning `{ resource, rollback }`. Its `admit()` method checks all matching pacing buckets, FIFO and read-only legacy readiness, then calls `onAdmit()` to reserve the **original** monthly budget and key lease, and then writes the pacing start timestamp through `PacingStartStore.commitStarts()` before accounting a grant. There is no `await` inside this sequence.
2. **Fail-closed rollback:** if saving a pacing start fails, `rollback()` immediately releases the legacy route reservations, no grant is returned, no bucket counters are changed and the error is `pacing_store_error`. If the exact committed route has disappeared, `onAdmit()` throws before persisting a pacing start; the bridge retries an allowed alternative when possible.
3. **Cancellation safety:** an AbortSignal that fires synchronously while claiming the legacy lease now triggers rollback *before* storing the timestamp; the scheduler has a reentrancy guard so an abort/release event raised from inside its waiter-drain does not recursively corrupt the FIFO.
4. **Bridge change:** `provider-pacing-routing.ts` no longer obtains a grant followed by a separate post-await legacy `routeRequest(commit)`. The exact RouteResult is held in `grant.resource` as part of the synchronous admission and its release is composed idempotently with `grant.release()`. A late disconnect releases both.
5. **Legacy budget exception safety:** `router.ts` releases a successfully reserved monthly budget if `acquireLease()` itself throws.
6. **Fresh default and named profile membership:** `getActiveChain(db,true)` bypasses the short active-chain cache on commit. The router tracks `resolveRoutingChain()` auto/profile arrays through a `WeakMap` and re-resolves `auto` and named `auto:profile` chains from current configuration at admission time. A committed route must still be the *same exact model DB ID and key ID* as preview; otherwise there is no grant.

## Important atomicity qualification

The guarantee is **synchronous single-process admission with explicit rollback**, not a single SQLite transaction that spans both the persisted pacing timestamp and all pre-existing in-memory monthly-budget/lease reservations. It requires exactly one Node process/writer. A second independent worker can bypass the in-memory arbitration; process-topology enforcement is still a blocker. PacingStore commits only the start timestamps, and its transaction must remain atomic across buckets.

## Tests committed

- `server/src/__tests__/services/provider-pacing-admission.test.ts`: seven deterministic cases for 65-second ordering, no lease while queued, SQLite failure rollback, model disappearing at commit, abort before grant, no-rule legacy admission, synchronous abort during commit and reentrant abort/FIFO next caller (seven cases total after adding two to five).
- Existing `server/src/__tests__/services/provider-pacing-routing.test.ts`, `provider-pacing-readiness.test.ts`, `provider-pacing-legacy-limits.test.ts`, `provider-pacing-ratelimit.test.ts` and `provider-pacing-store.test.ts` remain for CI.

### Independently executed local tests

- Created an isolated test copy of the core from the supplied Stage 1 ZIP with the exact Stage 4 and Stage 5 edits applied; Node.js 22 native test harness: **20/20 PASS**, including the new atomicity/abort cases (13 original core + 7 atomic admission).
- Standalone `tsc --noEmit --strict` on that isolated core: **PASS**.
- **Not executed**: the complete repository's Vitest test suite, full server/client TypeScript build, running HTTP/SSE server integration, GitHub Actions end-to-end status, and isolated real VPS process.
- The isolated test is not a certification that the entire GitHub branch builds; the full checkout/dependencies are not available in this working environment.

## Remaining blockers (NO-GO)

1. **Named group membership:** auto and named auto profiles re-resolve, but explicit unified model groups currently provide frozen `groupChain` arrays. A group changed while waiting must re-resolve its actual current members and cannot silently fall back outside a pinned group.
2. **Global request deadline:** queue waits across multiple candidates, separate 45-second fallback budget, Caddy/Harness/Codex limits and end-to-end timeout/abort mapping must be tested and bounded.
3. **429 / SSE / health/fusion/rerank/media:** inspect all external provider call paths, ensure meaningful provider-account quota protections and no post-commit SSE retry.
4. **Account/pool identity:** verified mapping of API keys to physical provider quota ownership; no guessing that different keys imply separate accounts.
5. **Startup/shutdown:** single-process enforcement, emergency off switch, cross-surface regression tests and full AT-01..AT-22 matrix.
6. **Operational validation:** run branch CI (migration roundtrip, tests, lint, build); verify runtime commit, existing patches, actual Caddy/user client timeouts before even discussing a test-port deployment.

**Activation remains blocked by `pacing_not_ready` in the admin API. No traffic is currently paced by these changes.**
