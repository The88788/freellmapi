# Stage 2 checkpoint: Provider Pacing & Queue, opt-in HTTP routing integration

**Date:** 2026-10-11  
**Branch:** `The88788/freellmapi:feature/provider-pacing-queue`  
**Status:** integration code committed; **not yet production-ready**, feature disabled by default. No SSH, VPS services, production DBs, deployments or migrations touched.

## Implemented

1. `router.ts`: `PacingRouteOptions` supports a quota-/lease-side-effect-free `preview` mode and an exact `commit` constrained by both model DB ID and key ID. Preview returns no decrypted API key or proxy URL, reserves neither `key-budget` nor legacy in-flight lease, and does not advance round-robin cursors. Commit rehydrates the enabled catalog row after waking, repeats the ordinary scope/cooldown/quota/budget and request-capability checks, then takes the existing budget reservation and lease exactly once.
2. `provider-pacing-routing.ts`: optional shared bridge from preview to FIFO scheduler grant to exact-key committed route. A changed/deleted key is excluded and retried with a fresh preview within four candidate revisions. A grant cancelled while waiting cannot be dispatched. A scheduled route's `release()` frees the existing monthly reservation, existing lease and scheduler grant idempotently. When no scheduler is installed, the bridge returns the original synchronous `routeRequest(...args)` directly, without preview.
3. `fallback-loop.ts`: a routing hook can now be synchronous or return a Promise. Queue delay is subtracted from the existing fallback/hedge elapsed-time calculations; the original active upstream hedge starts after admission. A cancelled connection during queue sleep is not counted as a provider failure; a grant returned after disconnection is released. Queue errors retain HTTP status, code, and optional retry timestamp, even after preceding upstream failures.
4. `proxy.ts`, `responses.ts`, `anthropic.ts`, `inbound-chat.ts`: the common fallback call sites now use the bridge for Chat, legacy Completions, OpenAI Responses, Anthropic Messages and Gemini/Ollama translated chat. No SSE frames or fake activity are sent while queued.
5. `ratelimit.ts`: newly opted-in in-flight leases are not force-pruned after the legacy two-minute window (release remains in fallback finally), while legacy leases keep the original aging behavior. SQLite cooldown upserts preserve earlier stronger authoritative/credit/tier reset deadlines against shorter subsequent deadlines, avoiding incorrect early resumption.
6. No modifications to Cloudflare Vision PR #1462 provider/test files.

## Tests added

- `server/src/__tests__/services/provider-pacing-routing.test.ts`: four opt-in/legacy tests covering synchronous no-flag behavior, FIFO across clients and no lease while queued, cancellation, and changed candidate releasing a grant.
- `server/src/__tests__/services/provider-pacing-ratelimit.test.ts`: protected long-stream lease, legacy backstop, authoritative 21-second cooldown resisting a 2-second heuristic.
- The 13 deterministic fake-clock scheduler tests from Stage 1 remain in the branch.

## What has actually been executed

- Isolated **Stage 1** `node --experimental-strip-types .../core.test.mjs`: 13 passed, 0 failed, re-run locally during this stage.
- Isolated **Stage 1** `tsc --noEmit ... provider-pacing-core.ts`: passed.
- A minimal local SQLite conflict-upsert smoke test for authoritative cooldown monotonicity: passed.
- New Vitest integration and existing FreeLLMAPI repository tests, `server npm run build` and end-to-end OpenAI/Responses/Anthropic SSE: **NOT RUN**; this environment does not have the full repository checkout/dependencies. Added tests must be run and fixed if necessary before enabling anything. Do not treat source review as substitute for a server build.

## Still required before activation

1. **Stage 3**: authenticated admin API/UI, validated operator policies, transactional `PacingStartStore` SQLite migrations, settings revision and real Pollinations model/account mapping. The scheduler is intentionally **not installed at startup**; runtime traffic is unchanged without an explicit initialized scheduler.
2. **Routing semantics**: currently waits on the preview winner. Auto-routing must prefer another allowed *ready* candidate before unnecessary queue wait, while respecting pinned model/group semantics and paid fallback policy.
3. **Cooldown awareness**: classify temporarily cooled-down candidates separately from permanently unavailable models; wait only when deadline is within the queue budget, without overwriting provider-authoritative Retry-After. Current preview can exhaust if all candidates are on cooldown; this is not yet FR-09 complete.
4. **Dynamic settings**: handle profile changes, model/key updates, policy revision, account/pool ownership, cancellation, fairness and fresh key scope after each wake with explicit tests.
5. **Budget/deadline**: define a bounded global end-to-end HTTP request deadline independent of fallback budget, and test Caddy/client timeouts of waits up to 65–180 sec.
6. **Coverage**: identify and either integrate or explicitly document bypasses: Fusion, Embeddings, Media, Rerank, validations, cooldown probes; account-wide quotas can otherwise be exceeded by those paths.
7. **Integration tests**: all 22 acceptance cases, load/race/long-stream/restart/DB error, Windows Harness and Codex clients with a real isolated server DB, existing baseline tests.
8. **Production provenance**: user-authorized read-only confirmation of VPS tree and one-process topology, backup, dry run and isolated port; **deployment requires separate permission**.

## Safety invariants

- Waiting never holds a legacy `RouteResult`, decrypted key, monthly budget reservation or `ratelimit` lease.
- Scheduler admissions and existing budget/lease reservations occur in immediate succession without an `await` between them, but cross-resource transaction/rollback and multi-process safety remain incomplete; production gate stays closed.
- The original synchronous routing path is preserved when the feature is disabled.
- A post-commit stream error is never transparently replayed by the shared fallback loop.

**Decision: NO-GO for production or claims of completed Stage 2 E2E until the items above are resolved.**
