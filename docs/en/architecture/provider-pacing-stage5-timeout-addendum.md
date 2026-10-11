# Provider Pacing & Queue: FR-11 timeout addendum, Stage 5 continuation

**Date:** 2026-10-11  
**Branch:** `The88788/freellmapi:feature/provider-pacing-queue`  
**Status:** code and tests committed, **not verified with full repository build**, feature **OFF/activation blocked**. No SSH, working VPS, systemd, live Caddyfile, real API keys, databases or deployments touched.

## Incident (user-provided, source of truth)

During a long DeepSeek Harness tools task with Pollinations Muse Glimmer 30B the gateway reported:

```text
502 upstream_failed
All 1 routed attempt(s) failed with upstream provider errors (timeout ×1).
pollinations/community/YoannDev90/muse-glimmer-30b:free
The operation was aborted (pollinations, chat, 60s)
```

This is evidence that the **gateway aborted a provider attempt after its 60-second configured timeout**. It does **not** prove whether the provider was overloaded, slow-prefilling, stuck, or whether networking delayed a response. Several previous 429s are a separate rate-limit signal. Do not automatically turn this upstream_timeout into rate_limit or escalate an unknown quota.

## What exists already in this fork, do not duplicate

| Logical FR-11 timeout | Actual existing mechanism | Result |
|---|---|---|
| `queueWaitMs` | opt-in scheduler, `RouteResult.pacingWaitedMs`; shared fallback subtracts successful queue wait from retry elapsed budget | Implemented, full E2E verification pending |
| `upstreamTimeoutMs` | `lib/provider-timeout.ts` + `PROVIDER_TIMEOUT_<PLATFORM>`; `OpenAICompatProvider` captures it on construction, unless `CompletionOptions.timeoutMs` overrides per call | Existing; Pollinations defaults **60,000 ms** |
| `firstByteTimeoutMs` | `BaseProvider.readSseStream`, first read `max(chatTimeoutMs, streamStallTimeoutMs)` unless either is 0 | Existing; Pollinations trial with 120s chat + 90s stall = **120s first-byte grace** |
| `streamStallTimeoutMs` | `PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>` > global `PROVIDER_STREAM_STALL_TIMEOUT_MS` > default 90,000 ms | Existing; independent of first byte |
| `fallbackTimeBudgetMs` | `fallback_time_budget_ms` settings / `FALLBACK_TIME_BUDGET_MS`, default **45,000 ms**, first attempt + first retry exempt from budget stop | Existing; distinct from each provider's own timeout |
| `requestDeadlineMs` | no complete request-wide deadline with distinct abort reason crossing queue, upstream and SSE for all surfaces | **NOT implemented; production blocker** |
| Client disconnect | `clientAbort` signal in proxy/responses/anthropic/inbound-chat, final lease cleanup | Existing; needs multi-surface E2E |
| Post-commit SSE retry | shared `DispatchOutcome='committed'`, surface-specific SSE commit handling | Existing; test added for no second fallback attempt |
| Max retry count | `FALLBACK_MAX_RETRIES=20`, skipKey/skipModel/skipPlatform, cooldown, breakers | Existing; scheduler invoked again for each fallback attempt when installed |

`OpenAICompatProvider.chatCompletion()` uses `timeoutBounds:'request'`: whole JSON response body read must finish in the configured time. Streaming uses a header-only fetch timer, then first-byte and stall watchdogs; it intentionally does **not** force a 120-second cap on an actively progressing long SSE stream.

**Timeout source lifecycle:** `OpenAICompatProvider` constructs the HTTP timeout once at process initialization. To change `PROVIDER_TIMEOUT_POLLINATIONS` in a running process, plan an operator-authorized restart; merely editing .env does not modify the existing instance. Stream stall timeout is read per stream invocation. Do not change all providers or use `0` to disable timers.

## Changes committed for this addendum

- `lib/provider-timeout.ts`: `providerTimeoutSetting()` exposes the effective timeout, built-in default, exact env key and source (`environment` vs `provider_default`), reusing existing parser and validation. No new provider timeout setting/database.
- `providers/openai-compat.ts`: `getTimeoutStatus()` captures the **actual constructed** chat timeout and its source; also exposes current first-byte/stall budgets and stall source. Per-call timeout override remains untouched.
- `routes/provider-pacing.ts`: existing authenticated queue diagnostics endpoint now displays Pollinations/NVIDIA/Mistral timeout snapshots. No new route.
- `provider-pacing-core.ts` + `provider-pacing-routing.ts`: successful admissions now accumulate `totalQueueWaitMs` and `maxQueueWaitMs`, separate from existing fallback `request_attempts` upstream attempt durations. The Settings view shows queue mean/max; it does not claim in-flight upstream duration is a queue wait.
- `client/components/provider-pacing-settings.tsx`: shows the snapshots in the **existing** Settings > LLM Queue section, with restart note. No new dashboard page.
- `lib/error-classify.ts`: **diagnostic only** `requestTerminationReason()`, independent of existing retry classification, for `queue_timeout`, `upstream_timeout`, `first_byte_timeout`, `stream_stall`, `client_abort`, `rate_limit`, `fallback_exhausted`.
- `lib/fallback-loop.ts`: existing OpenAI exhaustion `error.code` and HTTP statuses retained. Optional `error.reason` adds actionable cause to compatible error payloads; a queued timeout is not tagged as an upstream timeout, while the 60s Pollinations incident can be identified as `upstream_timeout`. No alteration to retry count, fallback sequencing, provider default timeouts or SSE protocol framing.

### Added test source (local mock, zero external/paid API)

- `server/src/__tests__/providers/pollinations-pacing-timeout.test.ts` (9 fake-time cases): 60s default, successful 70s response with 120s override, >120s provider timeout, real scheduler 65s queue + 70s mock upstream, 105s SSE first byte success, >120s first byte failure, post-first-byte 90s stall failure, NVIDIA/Mistral isolation, constructor-frozen config.
- `server/src/__tests__/lib/pacing-timeout-reasons.test.ts` (4 cases): exact original Pollinations error classification, 429 vs stall/first-byte, client abort vs fallback, queue error mapping.
- `server/src/__tests__/lib/provider-timeout.test.ts` (3 additions): default/env/source/isolation/malformed environment.
- `server/src/__tests__/lib/fallback-loop.test.ts` (3 additions): scheduler 65s wait excluded from 45s fallback budget, no post-commit SSE second attempt, upstream timeout retry max 3 without a 429 cycle.
- `server/src/__tests__/providers/provider-pacing-http-mock.test.ts` (5 additions): real loopback `127.0.0.1` HTTP server with scaled non-stream and SSE delays, first-byte versus mid-SSE stall, timeout, and client cancellation. Its `fetch` target is redirected **only** to localhost; no external key or provider request.

**IMPORTANT evidence boundary:** all listed tests are **committed source**, **not claimed green**. The exact updated monorepo checkout + npm workspaces are unavailable in this tool runtime (git clone cannot resolve github.com). The previous 20 core tests were in a reconstructed isolated harness and do not certify this changed timeout/provider integration. Branch GitHub Actions outcome has not been independently retrieved. Do not deploy or enable on this basis.

## Request-wide deadline design (significant work: do not bolt it onto legacy timeout)

RequestDeadline is a **new lifecycle mechanism**, not a replacement for provider timeout. It requires **one inbound request-scoped monotonic deadline**, carried over all scheduler waits and fallback attempts.

Proposed integration:
1. On request entry, create a single AbortSignal with a tagged **request_deadline** abort, separate from existing tagged `newClientAbortError()` and `newHedgeAbortError()`. The deadline must encompass ALL queue waits + upstream attempts, not reset at each fallback.
2. Compose that signal with the real client-disconnect and per-attempt hedge signals at each provider dispatch, and pass the same deadline to every scheduler wait. Ensure an early client abort is never relabeled provider overload.
3. The queue wait consumes the global request deadline but **never** the provider timer or fallback time budget. The provider timeout starts only inside the actual outgoing fetch. The first-byte/stall clocks start in their existing streaming positions.
4. Expiration releases waiter timers/listeners, scheduler grant, current legacy key lease and monthly provisional reservation. Do not send heartbeats or fake SSE content to keep the socket open.
5. If real SSE bytes are already committed, abort locally and emit the surface's existing terminal SSE failure event rather than performing a second upstream request or mutating the HTTP status.
6. A request-wide deadline should be operator-configured and bounded; **do not** default to infinity, and do not globally change other providers. It must work with request-group/pinned-model semantics and a single Node writer.
7. Use isolated fake-clock and local HTTP SSE E2E tests before enabling, including simultaneous queued requests and actual connection shutdown.

This integration crosses proxy/chat, legacy completions, Responses, Anthropic, inbound-chat, SSE and provider signals. It is a meaningful architecture change and stays a **NO-GO blocker** for the current checkpoint.

## HTTP/proxy review

- `server/src/index.ts` configures Node `keepAliveTimeout=75_000` and `headersTimeout=76_000`. These govern idle persistent connections and request-header parsing, **not** a 76-second maximum for an already-accepted 185-second generation.
- Caddy's documented `reverse_proxy` HTTP transport defaults are no `response_header_timeout` and no `read_timeout`. See https://caddyserver.com/docs/caddyfile/directives/reverse_proxy ; this does **not** prove the running VPS Caddyfile has not set them or that Harness/Codex clients permit 185s.
- **Codex risk identified in the fork:** `server/src/routes/responses.ts` near its Fusion streaming implementation comments on an approximately **15-second Responses client idle watchdog** and uses real `response.in_progress` events for Fusion. This is a code comment/compatibility hint, **not verified against the current Codex CLI binary or Harness**. An ordinary request held for 65 seconds *before* any SSE event may disconnect even if Caddy/Node allow it. Do not introduce invented pre-provider SSE output or prematurely mark a response committed; first test actual client watchdog settings and protocol-valid event ordering in an isolated harness.
- At least 65s queue + 120s possible upstream **= 185s before retries**, excluding tool processing and server translation. For a **single** such attempt, a *candidate* total request deadline around **210,000–240,000 ms** may be reasonable only after checking client/Caddy maximums and validating disconnect semantics. Multiple fallback hops need a separately modeled end-to-end bound, not multiplication of unlimited retries.
- Stalled SSE streams are separately bounded by 90s inactivity by default; a steady streaming response can legitimately run much longer than the initial 120s first-byte allowance.

## Safe trial recommendation (not applied anywhere)

- Only after the mock HTTP tests and real sandbox timeout checks pass, trial **`PROVIDER_TIMEOUT_POLLINATIONS=120000`** on a *separate* local/server test process, keeping other providers' environment unchanged.
- Leave `PROVIDER_STREAM_STALL_TIMEOUT_POLLINATIONS` unset initially (default 90s); adjust only on evidence of healthy inter-frame gaps >90s, not to conceal stalls.
- Keep `FALLBACK_TIME_BUDGET_MS` unchanged initially; it is a different clock. Do not override to infinity to mask a slow provider.
- Do not set global timeout to 120s for NVIDIA, Mistral, etc. Their effective defaults/overrides are independent.
- The user-reported 502 at 60s warrants further investigation with per-attempt timing, upstream HTTP status and SSE first-byte/stall diagnostics. It is **not** sufficient to conclude a provider 429 or actual overload.

## Verification gates still open

1. Full server + client lint/build and all Vitest tests on exact branch head, CI results.
2. Run the committed fake-clock 61–90s and 65s+120s mock tests AND the new scaled loopback HTTP server tests under repository Vitest. End-to-end HTTP through the actual FreeLLMAPI listening gateway, real SSE commit transitions and client disconnect/lease audit remain outstanding.
3. Read-only view of active VPS Caddy, Node and client timeouts only **after user permission**.
4. Confirm named groups, account/pool identity, startup single-writer, durable store, and full AT-01..AT-22 tests before queue activation.
5. No paid upstream API, provider quota or production deployment used in this work.

**Decision:** continue in dev branch, **NO GO** for production. `pacing_not_ready` activation gate remains in effect.
