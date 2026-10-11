# Stage 6: Manual provider/model timeouts + Pollinations 1 RPM clarification

**Branch:** `The88788/freellmapi:feature/provider-pacing-queue`  
**Status:** implementation committed, tests added but full repo CI/build/E2E **not yet verified**, queue remains **OFF** with `pacing_not_ready` activation gate. **No production VPS, systemd, Caddy, active API keys or database touched.**

## User-observed constraints (not inferred from API docs)

- The DeepSeek Harness + dsh-camel workflow required approximately **65 seconds between Pollinations request starts** to avoid reliable observed 429 responses when sent earlier. Treat this as **tested 1 RPM + safety margin**, not as a 60-second provider response timeout.
- Pollinations Muse Glimmer 30B with large tools/research/programming requests may exceed the default **60-second upstream timeout**. A 60s client-side abort indicates the local timer expired, not proof of 429 or provider overload.
- 65s pacing and a candidate 120s HTTP timeout are separate clocks; concurrent requests are a THIRD control. With `maxConcurrent:1`, a 120s active request blocks the next start even after the 65s RPM interval has expired; with `maxConcurrent:2`, two starts can be at t=0 and t=65 when the previous request is still running, if provider truly supports concurrency.

## Implemented, without new DB tables

1. `server/src/services/provider-timeout-overrides.ts`: typed, sanitized timeout settings backed by the existing `settings` key/value table; 1000–900000ms range, no accidental `0` infinite timeout. Supports provider-level key and more-specific **model-level** key.
2. **Exact precedence:** per-call `CompletionOptions.timeoutMs` > saved model override > saved provider override > constructor-frozen `PROVIDER_TIMEOUT_<PLATFORM>` env > registration default. Existing adapter behavior when no saved overrides remains unchanged.
3. `OpenAICompatProvider.chatCompletion` and `streamChatCompletion` read a timeout **once per outgoing attempt**. Active streamed/non-streamed requests keep the previous snapshot after operator changes. One outgoing SSE attempt uses the SAME snapshotted timeout for HTTP response headers and its first-byte watchdog; mid-stream stall watchdog stays separately configurable.
4. Existing authenticated `settingsRouter` API:
   - `GET /api/settings/provider-timeouts` lists live OpenAI-compatible provider adapters and effective platform timeout.
   - `GET /api/settings/provider-timeouts?platform=pollinations&modelId=<encoded-id>` reports model effective timeout/source (omit modelId to see provider).
   - `PUT /api/settings/provider-timeouts` with `{"platform":"pollinations","timeoutMs":120000}` saves provider override.
   - `PUT /api/settings/provider-timeouts` with `{"platform":"pollinations","modelId":"community/YoannDev90/muse-glimmer-30b:free","timeoutMs":150000}` saves model override.
   - `PUT /api/settings/provider-timeouts` with `{"platform":"pollinations","timeoutMs":null}` **resets** provider override, revealing env/built-in fallback (or send modelId to reset a specific model).
   - Unsupported native adapters return explicit `unsupported_provider_timeout` rather than pretend the setting works. This stage supports **OpenAI-compatible adapters**, including Pollinations, NVIDIA and Mistral. Native Google/etc need a separate small integration in their adapters, not a misleading checkbox.
5. `client/src/components/provider-timeout-editor.tsx` is nested inside the existing Settings > LLM Queue panel, **not a new page**. Allows selecting registered provider, optional model ID, inspecting source, editing in milliseconds, saving and resetting without restarting the Node process. Direct .env changes still require process restart to affect constructor baseline.
6. Pollinations draft pacing rule builder in the same panel now defaults to a **shared provider scope** covering all keys, models and clients. Operator can explicitly narrow to a model or model+key. Separate `maxConcurrent` field; default conservative 1. This is a **draft only**, not automatically activated.
7. A time override does NOT modify `minStartIntervalMs`, RPM windows, fallback count or stream framing, and settings are not bundled into `provider_pacing_config`.

## Source tests added

- `server/src/__tests__/services/provider-timeout-overrides.test.ts`:
  - defaults, provider override and reset, model-over-provider priority, NVIDIA/Mistral unaffected, env restoration, validation against 0/negative/overflow/malformed modelId, active snapshot unchanged, actual `fetchWithTimeout` arguments change only for new attempts, explicit per-call override priority.
- `server/src/__tests__/services/provider-pacing-readiness.test.ts`:
  - shared Pollinations 65-second start gap across Harness/Codex, different keys and models,
  - independent concurrency: `maxConcurrent:1` + 120s upstream holds second start until t=120 despite 65s RPM interval,
  - unrelated NVIDIA request not held by Pollinations queue.

**Execution status:** New tests are committed but **not run under monorepo Vitest** in this execution environment. No claim of full build, CI passing, real Caddy configuration or client watchdog validation.

## Safe integration and caveats

- Runtime `OpenAICompatProvider.getTimeoutStatus(modelId?)` now reports the next-call effective policy, including `dashboard_provider` or `dashboard_model`, as well as first-byte/stall watchdogs. A request using `CompletionOptions.timeoutMs` overrides even these dashboard defaults.
- Persisted overrides survive restart; unlike environment values, **saved values are loaded per attempt** and require no process restart. Do not change/modify any active production database until separately authorized.
- The `pacing_not_ready` gate remains. The saved timeout override API can be used once this dev branch is deployed, independently of enabling the scheduler, but not before dev tests and separate deployment approval.
- Provider-wide bucket is **conservative**, especially if multiple independent Pollinations accounts or models have distinct quotas. It prevents a single-account 1 RPM from accidentally being treated as 1 RPM per key. Refine to explicitly verified account/pool scopes later, never guess physical quota independence.
- A 65s pre-response wait risks Codex's observed Responses idle watchdog. The actual installed Codex/DSH clients, Caddyfile and complete requestDeadline semantics must be tested before enabling server queuing; do not fake SSE heartbeats or silently replay partially committed messages.

## Request-wide timeout design remains BLOCKING (no unsafe shortcut)

The shared fallback budget of 45s, per-attempt upstream timeout of 120s and queue delay of 65s MUST remain separate. A bounded request-wide AbortSignal must cover the whole inbound request and be composed into scheduler waiting + provider dispatch + committed SSE cleanup. This is cross-surface work requiring real mock E2E, client timeouts and safe protocol handling, and is **not implemented** in this stage.

## Caddy read-only inspection

User has been given a read-only grep command for `/etc/caddy` on the VPS. Do not assume actual `response_header_timeout`, `read_timeout`, etc. from online defaults. The user must redact any credentials before sharing output.

## Deployment decision

**NO-GO** for active scheduling or production rollout. Leave the previous five stages' core and Cloudflare Vision PR intact. Run branch-wide TypeScript/lint/Vitest, 1RPM synthetic dual-client tests, mock SSE, and bounded requestDeadline once Caddy/client settings are known. No real paid API load tests.
