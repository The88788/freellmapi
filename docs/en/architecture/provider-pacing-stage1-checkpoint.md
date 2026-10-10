# Provider Pacing & Queue: Stage 1 development checkpoint

**Status: backend scheduler core isolated, not wired to live HTTP routing. DO NOT DEPLOY as a working pacing feature.**

## Baseline
- Fork branch: `feature/provider-pacing-queue`, descendant of `fix/cloudflare-vision-image-url` (includes unmerged upstream Cloudflare Vision PR #1462).
- Existing router currently holds monthly budget reservations and key leases immediately on selecting a route. Never call it before waiting in the queue.
- This code is additive: it is not imported by any existing inference route, does not change your VPS, and needs an adapter plus data persistence before activation.

## New code
- `server/src/services/provider-pacing-core.ts`: opt-in one-process admission scheduler, validated global/provider/model/key/model+key/account/pool scopes, multiple simultaneous constraints, collision-safe scope identity, FIFO waiters, per-client/global/per-bucket queue bounds, min start intervals, sliding RPM and provisional/settled TPM, maxConcurrent for long calls, cancel/shutdown, error types.
- `server/src/__tests__/services/provider-pacing-core.test.ts`: 13 deterministic fake-clock tests covering 65-second starts, two clients, isolation, 20 competing callers, common account across keys, concurrency >120 sec, RPM/TPM, impossible large TPM, cancellation, queue overload/deadline, idempotent release, persistence callback and fail-closed storage exception.

## Verification
- `tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --strict --skipLibCheck server/src/services/provider-pacing-core.ts` **PASS** locally using TypeScript 5.8.3.
- A local Node.js 22 harness built from the same 13 test bodies: **13 passed, 0 failed**.
- Repository-wide Vitest, server build, integration, HTTP and actual upstream tests: **NOT RUN** in this environment. The runtime has no complete clone or installed server dependencies.

## Deferred, blocking production
1. Wire side-effect-free key candidate selection, queue admission, synchronous existing lease and budget reservations in `router.ts`.
2. Move queue clock outside the 45s fallback/TTFB timers without breaking streaming commit/abort semantics.
3. Add transactional SQLite implementation for `PacingStartStore`, schema migrations, settings revision and admin API/UI.
4. Fix/retest existing lease lifetime (2-minute prune), authoritative cooldown, and account/pool ownership.
5. Run existing baseline tests and end-to-end tests over all chat/Responses/Anthropic protocols. Explicitly inventory fusion/embeddings/rerank/media/health paths.
6. Verify sanitized VPS commit/timeouts and single-process topology before requesting separate authorization for isolated deployment.

**Safety note:** `PacingStartStore.commitStarts()` MUST be implemented transactionally and synchronously. Merely passing a nontransactional callback or wiring the current `routeRequest()` after a grant is NOT enough to establish end-to-end atomic admission against other callers. All downstream failures need explicit release/rollback policy.

There are known MVP omissions and this branch is not a finished implementation of the 22 acceptance tests.
