# APInex gateway (2026-10-18, provider integration and catalog handoff)

- Website: https://apinex.bond/
- API base: `https://api.apinex.bond/v1`
- Auth: `Authorization: Bearer <key>` (a working account key used `sk-apx` prefix without requiring a trailing hyphen; never log key values)
- Chat: `POST /v1/chat/completions` (OpenAI-compatible)
- Models: `GET /v1/models` (**authenticated HTTP 200 confirmed 2026-10-17**; omitted authorization returned HTTP 401 `Missing API key`). It returned 43 routes, including 20 `free/*` IDs. A forged *invalid but present* key was not yet tested.
- Free routes use `free/*` IDs. **Paid IDs charge a separate USD wallet** and should not be auto-enabled.

## Candidate verified free models for the signed catalog

Five `free/*` model IDs are **live-verified end to end through an isolated FreeLLMAPI proxy** (2026-10-18). These are candidates for the **separately published, signed hosted model catalog**; they are not bundled or auto-added by this code PR.

| OpenAI model ID | Chat | SSE text | Tool call | Tool result round-trip | SSE tool call |
| --- | --- | --- | --- | --- | --- |
| `free/deepseek-v4.1-flash` | PASS | PASS | PASS | PASS | PASS |
| `free/gemini-3.8-flash` | PASS | PASS | PASS | PASS | PASS |
| `free/glm-5.3` | PASS | PASS | PASS | PASS | PASS |
| `free/glm-5.3-flash` | PASS | PASS | PASS | PASS | PASS |
| `free/gpt-6-luna` | PASS | PASS | PASS | PASS | PASS |

All **25 of 25 live HTTP requests** completed with status 200 and correct provider routing. Non-stream tool calls were returned as structured `tool_calls` with `finish_reason: tool_calls`; result replay produced text responses; SSE tool calls retained their IDs, names and assembled JSON arguments and ended with `[DONE]`. A `ping` function was used as the smoke test, not a real filesystem or coding tool. The test used 14 seconds of spacing between requests to respect the five-RPM shared account limit. `supportsTools: true` is justified for **these five IDs** by the observed calls, but not for untested APInex models. Neither vision support nor per-model context capacities were tested.

This provider PR intentionally contains **no local model-seeding migration**, matching FreeLLMAPI's existing catalog ownership rules. The signed catalog must be updated by its maintainers before new installations show these IDs automatically. Publishing catalog rows requires verifying metadata and preserving user disable/tombstone behavior. Models discovered manually are not automatically promoted into the signed catalog.

APInex Free advertises **5 inference requests per rolling minute per account**, shared across all free/* models. The existing FreeLLMAPI account/key-level `getProviderMinuteRequestCap` and `canUseProviderMinute` gates enforce that ceiling, including in-flight leases. A request after the allowance is spent is skipped by routing and may fail over to another eligible provider; the server **does not queue or delay it**. No APInex-specific queue is installed. This avoids diverging from the project's standard quota tracking and cooldown behavior. Administrators can override the default with `PROVIDER_MINUTE_REQUEST_CAP_APINEX` (0 disables the cap). A manually configured environment override takes precedence over the default.

The user-reported gateway-wide **1M context** is not a measured per-model
context limit. The proposed catalog entries should set `contextWindow: null` until each model's
actual advertised capacity is independently confirmed. No RPM/RPD/TPM/TPD
limits are guessed per model.

## Recurring allowance and observed rate limits

APInex advertises a recurring daily free token allowance, but its public sources
disagree on the size: 1M/day with check-in in social announcements, 3M/day on
the homepage, and 10M/day on the pricing page. Weekend bonus grants and promo
codes are promotional, not guaranteed baseline renewals. Some free models
consume 2x/3x of the shared free-token allowance. Therefore the integration
does **not** seed per-model quota numbers or hard-code a daily cap.

The account's Free dashboard displays **5 RPM**, but on 2026-10-17 at
10:47:38 UTC authenticated `GET /v1/models` returned `x-ratelimit-limit: 60`,
`x-ratelimit-remaining: 59`, `x-ratelimit-reset: 1792234119`
(10:48:39 UTC, 61 seconds later). The `/models` rate-limit bucket is therefore
60 requests per ~minute; it does **not** prove chat/inference gets 60 RPM.
An authenticated non-streaming chat completion at 11:35:12 UTC (based on the
provider's `created` timestamp 1792236912) confirmed **5 RPM for inference**:
`x-ratelimit-limit: 5`, `x-ratelimit-remaining: 4`,
`x-ratelimit-reset: 1792236973` (61 seconds after `created`).
`free/deepseek-v4.1-flash` answered `OK` with HTTP 200 and `finish_reason: stop`.
The returned usage was `prompt_tokens: 312`, `completion_tokens: 1`,
`total_tokens: 313`, `cost_tokens: 0`. `cost_tokens: 0` is an API response
field, not independent evidence that the user's wallet is unchanged.
The earlier HTTP 400 (`Expected property name`) came from PowerShell-to-curl
JSON quoting, not a model/API incompatibility; the successful request used a
properly JSON-encoded `Invoke-WebRequest` body.

An independent September 5, 2026 test reported a shared 30 RPM counter across
different free models. Treat that as a historical observation, not today's Free
tier grant. The quota collector records headers dynamically and does not hardcode
60, 30 or 5 RPM. Daily token quota reset at 00:00 UTC was reported independently
but remains unverified from the authenticated account. Published RPD, TPM, and
per-model contexts remain unknown.

## Earlier direct-provider verification (2026-10-17)

Before the full proxy test, the `free/deepseek-v4.1-flash` endpoint returned HTTP 200 for non-streaming chat, a structured `get_weather` tool call, a complete tool-result dialogue, SSE text, and SSE tool deltas. Its inference response headers reported `x-ratelimit-limit: 5`; the `GET /v1/models` endpoint separately reported 60, so its metadata quota should not be used for inference. The 2026-10-18 isolated proxy run broadened those capability checks to all five models, including streaming tool calls.

## Remaining validation and release considerations

1. Verify a definitely invalid credential is rejected by `GET /v1/models` before claiming definitive negative key validation; missing credentials already returned HTTP 401.
2. Confirm the actual APInex free daily allowance and wallet debit behavior independently; website figures disagree and response `cost_tokens: 0` alone does not establish wallet balance.
3. Validate 429 / 402 handling and cooldowns, provider-reported `Retry-After`, and sustained DSH agent runs; the 25 paced smoke tests **did not exhaust** five RPM or prove long-session reliability.
4. Publish the five `free/*` IDs separately in FreeLLMAPI's **signed model catalog** with `supportsTools: true`, `supportsVision: false` until tested, and `contextWindow: null` until independently confirmed. Without catalog publication new users need manual model discovery.
5. FreeLLMAPI's native RPM limiter counts per **API key**, while APInex describes an **account-level** allowance. If users create multiple keys for the same account, separate per-key counters may overestimate shared headroom. No account identity API is currently verified to merge such keys.
6. Finish compatibility and CI verification against the intended upstream branch.

Sources:
- https://apinex.bond/
- https://apinex.bond/pricing
- https://apinex.bond/developers/models/chat
- https://github.com/Apinex-AI/APInexGate
- Independent API trial: https://www.habr.com/ (see 2026-09-05 APInex tests)
