# ADR-001: Provider Pacing & Queue (fork-specific Stage 0)

- **Status:** proposed; implementation gated by production-tree verification and executable test environment.
- **Date:** 2026-10-11
- **Repository:** `The88788/freellmapi`
- **Development base:** `97f06596a0b73e94749f4636e375b10d8e9bf5de` (`fix/cloudflare-vision-image-url`)
- **Development branch:** `feature/provider-pacing-queue`
- **Upstream release ancestor:** `v0.13.6`, `ffef850fe8553b03f89e2f76be4cb4da2b709378`
- **Scope of this commit:** documentation only. No runtime, migrations, services, or production deployment changed.
- **Specification:** `FreeLLMAPI_Provider_Pacing_Queue_TZ_v1.0` (11 October 2026).

## 1. Provenance and compatibility

GitHub comparison establishes 12 commits between the published v0.13.6 ancestor and the fork branch: ten upstream commits through `39a0ff6861bbd226902ad9adb0841318cc6d4d26`, then two fork commits associated with [upstream PR #1462](https://github.com/tashfeenahmed/freellmapi/pull/1462). PR #1462 is **open, not merged** at audit time; its two changed files are `server/src/providers/cloudflare.ts` and `server/src/__tests__/providers/cloudflare.test.ts`. It preserves multimodal user `image_url` blocks in non-stream and stream requests. The PR description reports tests/build/manual vision verification; **this audit has not independently run those tests**.

The runtime installed on the VPS is *reported* as FreeLLMAPI v0.13.6; GitHub ancestry does **not** prove the machine runs this exact tree or the fork HEAD. Before integrating, compare its sanitized `git rev-parse HEAD` / `git status --short` or a sanitized release manifest. **No SSH, production SQLite migration, service restart, or deployment is authorized.**

The `server/package.json` package version `0.2.1` is separate from the desktop/release version `0.13.6`, per `server/src/lib/app-version.ts`.

## 2. Confirmed implemented behavior in fork HEAD

| Concern | Observed entry point | Decision |
|---|---|---|
| Route selection, key/status/capability gates | `services/router.ts`: `routeRequest()`, `selectKeyForModel()` | Reuse candidate eligibility/ordering |
| Lease + provisional RPM/TPM/concurrency | `services/ratelimit.ts`: `acquireLease()`, `canMakeRequest()`, `canUseTokens()`, `canUseKeyConcurrency()` | Reuse accounting, fix long-stream lifetime |
| Monthly in-flight budget reservations | `services/key-budget.ts`: `checkMonthlyBudget()`, `reserveMonthlyBudget()` | Reserve once only at admission |
| Cooldown and provenance | `services/ratelimit.ts`, `lib/fallback-loop.ts` | Preserve authoritative `Retry-After` floor |
| Pool inference/observations | `services/provider-quota.ts`: `inferQuotaPoolKey()` | Use as hint, not proof of independent accounts |
| Retry/fallback loop | `lib/fallback-loop.ts`: `runFallbackLoop()` | Extend shared loop, avoid another retry loop |
| Streaming commit boundary | `routes/proxy.ts`, `routes/responses.ts`, `routes/anthropic.ts`, `lib/inbound-chat.ts` | Preserve existing protocol commit checks |
| Completed non-stream replay/cache | `services/idempotency.ts`, `services/cache.ts` | Bypass scheduler on hit |
| Validation pacing | `services/health.ts` upstream updates | Independent health-pass protection; not a common inference queue |
| Global inference wait queue/pacing rules | No matching implementation found in audited Git tree | New feature |
| Persistence of pacing start timestamps | No matching implementation found | New feature |

The fork includes post-v0.13.6 changes not present in the earlier ADR: `routing_min_reliability_floor`, a 1-second cached active chain, 5-second cached key counts, cached key decryption, new `/v1/rerank` path, and validation-rate-limited health skips. These affect dynamic revalidation, new upstream path inventory, and background traffic policy.

## 3. Existing hazards to resolve, not paper over

1. **Premature reservation:** `selectKeyForModel()` calls `reserveMonthlyBudget()` and `acquireLease()` before returning `RouteResult`. Never sleep after `routeRequest()` with this lease. Create side-effect-free candidate enumeration followed by recheck + synchronous commit immediately before dispatch. `roundRobinIndex` mutation and decryption failure side effects also require a distinction between peek and admission.
2. **Long streaming lease age:** `ratelimit.ts` prunes in-memory leases older than two minutes. A >2-minute valid stream can stop contributing to concurrency while its upstream remains active. Preserve current behavior when feature disabled; design a testable tracked-active-attempt lifetime for opted-in scheduler calls with explicit abort/finally cleanup, and avoid losing legacy provisional accounting.
3. **Cooldown precedence:** `setCooldown()` and persisted `ON CONFLICT ... SET expires_at_ms = excluded.expires_at_ms` can reduce an earlier authoritative expiry. Preserve stronger previously established deadlines (unless explicitly cleared by operator); distinguish authoritatively sourced cooldowns, credit and tier errors, heuristic expiry, and actual caller abort.
4. **Fallback clocks:** the common loop uses a 45-second base wall-clock budget starting before routing. A queue configured for 65 to 180 seconds cannot consume this budget. Delay or suspend fallback/TTFB clocks until actual upstream admission, with an independent bounded global request deadline; no blanket timeout disabling.
5. **Fresh candidate checks:** the fork caches the active chain for one second. On waking a waiter, force a fresh eligible-route check/invalidation of profile, model enabled state, key scope, key enabled/status, capability/context, budget, cost policy, and routing strategy. Never dispatch a stored `RouteResult` containing stale `apiKey`.
6. **Account versus key:** `pollinations::account` is an inferred provider quota-pool label, not an authenticated account identity. Require explicit key-to-account mapping where necessary; several credentials do not automatically mean multiple independent buckets.
7. **Other upstream paths:** Fusion panel/judge (`services/fusion.ts`), embeddings (`services/embeddings.ts`), media (`services/media.ts`), rerank (`services/rerank.ts`), validations/probes (`services/health.ts`, `services/cooldown-probe.ts`) can contact providers without the common chat fallback. Inventory/define coverage; no silent assumption that chat-only interception enforces a global provider/account RPM.
8. **Commit boundary:** no retry of the same attempt once real SSE bytes have reached the client. Keep framing, tool calls, finished message, and `[DONE]` conventions of each surface unchanged.

## 4. Chosen integration architecture (subject to test confirmation)

```text
inbound auth / guards / cache replay
   -> resolve candidate identities without acquiring any resource
   -> apply capability, context, budget, policy and real provider-account scopes
   -> ready candidate? synchronous atomic admission
      otherwise one bounded FIFO waiter (AbortSignal + deadline), no upstream call
   -> wake on next eligible instant, lease release, cooldown/policy change or abort
   -> force fresh eligibility and repeat checks
   -> atomic commit all independent scopes + existing month reservation + existing lease
   -> shared fallback-loop dispatch via original surface-specific adapter
   -> on success settle provider usage once; finally release every acquired reservation
   -> pre-commit 429: existing error classification + shared fallback decision
   -> post-commit SSE: no transparent replay; terminate honestly
```

**Atomic admission** in the single-process MVP is a synchronous critical section without `await`. It checks all applicable buckets in a stable order, validates the candidate again, and commits only when *every* gate allows admission. Rejection is side-effect-free. Persisted pacing timestamps use short SQLite transactions, never a transaction held while waiting or streaming. DB admission failure under enabled quota protection is fail-closed. A scheduler grant must never record a second provisional request: it coordinates the **existing** lease/budget path.

**Scheduler identity:** typed tuple of `platform`, actual `RouteResult.modelId`, `keyId`, canonical `endpointScope`, explicit `providerAccountId` and provider quota pool. Use unambiguous tuple serialization (e.g. JSON array) internally, never split model IDs on colons.

**Policy semantics:** all simultaneously applicable independent scope limits are enforced; specificity resolves each configurable field without disabling unrelated broader safety constraints. Fixed `minStartIntervalMs`, RPM sliding window, TPM estimated reservation/settlement, concurrent streams and authoritative cooldown are *distinct* constraints. Unpublished RPM/TPM remain unknown unless operator configured them; never auto-infer free quota.

**Queue semantics:** bounded FIFO within the limiting bucket, plus global/per-client counts; a request has at most one active waiter and does not hold partial quota resources. Per-bucket timers and release notifications, no polling spin. Cancellation always removes timers and listeners. A sleeping candidate may be invalidated; re-route using fresh eligibility instead of bypassing constraints.

**Fallback semantics:** keep `runFallbackLoop()` the sole retry owner. Add an opt-in asynchronous route admission bridge for scheduler-enabled requests, leaving current synchronous route/dispatch behavior unchanged when disabled. For `auto:*`, prioritize permitted ready candidates under current route policy over waiting; for strict pinning never silently substitute models. Refuse paid fallbacks unless existing policy explicitly permits them. Track upstream attempts only once dispatch starts, queue wait separately.

**Shutdown and restart:** only one Node writer in MVP. Stop accepting waiter registrations on SIGTERM; cancel unadmitted waiters and honor in-flight grace. Persist `nextEligibleAtUtc` and rule revision, not HTTP request bodies or unfinished queues. Use monotonic clocks for local waits. Restart must not erase authoritative cooldowns.

## 5. Proposed file-level changes

**Add**
- `server/src/services/provider-pacing.ts`: scheduler, waiter life cycle, atomic acquisition.
- `server/src/services/provider-pacing-policy.ts`: validated policies, matching/scopes/effective config.
- `server/src/services/provider-pacing-store.ts`: persisted timestamps, config revisions, metrics.
- `server/src/lib/provider-pacing-errors.ts`: bounded machine-readable errors and Retry-After.
- `server/src/routes/provider-pacing.ts`: admin endpoints, existing requireAuth middleware.
- `server/src/db/migrations/<new_timestamp>_provider_pacing.ts`: revisioned settings/state/history (dev DB first).
- `server/src/__tests__/services/provider-pacing*.test.ts`: fake timers, races, cancellation, restart, quotas.
- `server/src/__tests__/routes/provider-pacing*.test.ts`: HTTP/SSE, auth, failover, overload, cross-surface.
- `client/src/pages/ProviderPacingPage.tsx` (or a tab): effective policy, rules and queue status.

**Adapt**
- `server/src/services/router.ts`: side-effect-free candidate eligibility + commit path, profile freshness and legacy-compatible return.
- `server/src/services/ratelimit.ts`: lease lifetime and authoritative cooldown monotonicity.
- `server/src/services/key-budget.ts`: explicitly single admission reservation/settlement contract.
- `server/src/lib/fallback-loop.ts`: opt-in asynchronous admission, separate fallback versus queue clocks, trace semantics.
- `server/src/routes/proxy.ts`, `responses.ts`, `anthropic.ts`, `server/src/lib/inbound-chat.ts`: pass cancellation/deadline; no stream-shape changes.
- `server/src/services/fusion.ts`, `embeddings.ts`, `media.ts`, `rerank.ts`, `provider-credential.ts`, `health.ts`: declared integration or explicit audited bypass by traffic type.
- `server/src/db/migrate/defaults.ts`, `server/src/app.ts`, `server/src/lib/graceful-shutdown.ts`, dashboard routing: activation and safe lifecycle.
- **Preserve** PR #1462 `server/src/providers/cloudflare.ts` and its regression tests, with additional vision+queue E2E tests.

## 6. Verification gates

- **AT-01..AT-22** per specification, no silent reduction in scope. Unit tests using injected fake clock and deterministic scheduling, integration tests with isolated SQLite, local mock upstream HTTP/SSE tests, UI smoke, cancel/timeout/load tests.
- First deterministic test: three simultaneous model-key jobs with `65000` ms pacing dispatch at `0, 65000, 130000` while waiting consumes **zero** leases, monthly reservations, and provider starts.
- Cross-client fairness: Harness and Codex requests hit same provider/key/account bucket regardless of client header.
- Adversarial cases: 20 races, multiple keys one account, pre-commit 429 + 21s Retry-After, 401/402/403/404/413/502 not misclassified, >120s stream, SSE after commit, disconnect, policy edit, key deletion, Caddy/client timeout, restart, DB failure and second process.
- Baseline: existing build, lint and project tests before implementation; flag-off byte/wire compatibility; tests must be executed, not reported solely from PR descriptions.
- Production rollout, systemd/Caddy edits, backup, migrations, keys and traffic changes **require separate explicit user permission**.

## 7. Outstanding facts (not inferred from GitHub)

1. Sanitized production working-tree SHA, local patches, active systemd process count.
2. Actual Pollinations Muse Glimmer 30B `modelId`, `keyId`, `endpointScope`, account grouping in the running SQLite configuration.
3. Current Caddy/Node/Harness/Codex timeouts and acceptable end-to-end deadline.
4. Which background checks/embeddings/fusion/rerank must consume the same configured quota bucket.
5. Availability of full source checkout, dependency installation and ability to run the baseline tests in an isolated environment.

Until these are confirmed, this ADR is a reviewed **proposal**, not proof of deployability. GitHub branch creation and documentation commits do not modify the running VPS.
