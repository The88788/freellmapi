# APInex gateway (2026-10-18, provider integration and catalog handoff)

- Website: https://apinex.bond/
- API base: `https://api.apinex.bond/v1`
- Auth: `Authorization: Bearer <key>` (a working account key used `sk-apx` prefix without requiring a trailing hyphen; never log key values)
- Chat: `POST /v1/chat/completions` (OpenAI-compatible)
- Models: `GET /v1/models` (**authenticated HTTP 200 confirmed 2026-10-17**; omitted authorization returned HTTP 401 `Missing API key`). It returned 43 routes, including 20 `free/*` IDs. A forged *invalid but present* key was not yet tested.
- Free routes use `free/*` IDs. **Paid IDs charge a separate USD wallet** and should not be auto-enabled.

## Candidate verified free models for the signed catalog

The integration has five **chat-smoke-tested** free model IDs proposed for the **separately published, signed hosted model catalog**. They are **not bundled or auto-added** by this provider PR; until catalog maintainers publish them, users can manually register them through Fetch models:

| OpenAI model ID | Display name | Tool support |
| --- | --- | --- |
| `free/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | nonstream/stream tool calling and round-trip tested |
| `free/gemini-3.8-flash` | Gemini 3.8 Flash | not verified; Tools flag off |
| `free/glm-5.3` | GLM 5.3 | not verified; Tools flag off |
| `free/glm-5.3-flash` | GLM 5.3 Flash | not verified; Tools flag off |
| `free/gpt-6-luna` | GPT-6 Luna | agent tool calls observed, reliability limited by RPM |

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

## Live tool-calling smoke test (2026-10-17)

Authenticated `POST /v1/chat/completions` on `free/deepseek-v4.1-flash`
with one `get_weather` function and `tool_choice: "required"` returned
HTTP 200. The model emitted `finish_reason: "tool_calls"` and one structured
`get_weather` call with JSON arguments `{"city": "Almaty"}`. The response
reported `x-ratelimit-limit: 5`, `x-ratelimit-remaining: 4`, and usage
`prompt_tokens: 569`, `completion_tokens: 27`, `total_tokens: 596`,
`cost_tokens: 0`; 26 of the 27 completion tokens were categorized as
reasoning tokens. This confirms a **single non-stream tool-call turn only**.
Streamed tool calls and a full function-result round trip remain untested.

## Live SSE streaming smoke test (2026-10-17)

Authenticated `POST /v1/chat/completions` with `stream: true` on
`free/deepseek-v4.1-flash` returned HTTP 200 and
`Content-Type: text/event-stream; charset=utf-8`. Incremental
`chat.completion.chunk` SSE deltas formed `1, 2, 3, 4, 5`, followed by
`finish_reason: "stop"`, a final usage-only chunk (`choices: []`), and
`data: [DONE]`. The final usage reported 320 prompt tokens,
13 completion tokens (9 categorized as reasoning tokens), 333 total tokens,
and `cost_tokens: 0`. Inference headers again reported 5 RPM:
`x-ratelimit-limit: 5`, `x-ratelimit-remaining: 4`,
`x-ratelimit-reset: 1792238436`.

This verifies **streaming text**. Streamed tool-call deltas and the
tool-result round trip have not been tested yet.

## Live tool-result round-trip test (2026-10-17)

The client replayed the assistant's prior non-stream `get_weather` tool
call using the same tool-call ID and supplied a `role: "tool"` message
with `{"city":"Almaty","temperature_c":22}`. An authenticated
`POST /v1/chat/completions` on `free/deepseek-v4.1-flash` returned
HTTP 200 with `finish_reason: "stop"` and content
`The current temperature in Almaty is 22°C.`. This completes the
**non-streaming tool-call-to-tool-result dialogue cycle**. The weather
value is synthetic test input, not real-time weather.

Reported usage: `prompt_tokens: 380`, `completion_tokens: 13`,
`total_tokens: 393`, `cost_tokens: 0`; the response also reports
`reasoning_tokens: 2`. Streamed tool-call deltas are still unverified.

## Live streaming tool-call smoke test (2026-10-17)

Authenticated `POST /v1/chat/completions` on `free/deepseek-v4.1-flash`
with `stream: true`, one `get_weather` function and
`tool_choice: "required"` returned streamed `delta.tool_calls` events.
The initial indexed tool fragment carried
`id: "call_50320547fa024aeebc009f15"`, `name: "get_weather"`
and empty arguments; later fragments had `id: ""` and argument
pieces that concatenate to `{"city": "Almaty"}`. The stream ended
with `finish_reason: "tool_calls"`, a usage-only chunk, and
`data: [DONE]`. Usage: 569 prompt tokens, 27 completion tokens,
596 total tokens, `cost_tokens: 0`, 26 reasoning tokens.

The FreeLLMAPI streaming assembler in `server/src/routes/proxy.ts`
already treats empty tool-call IDs as absent (`if (tc.id && !acc.id)`),
accumulates argument fragments by tool-call index, and emits completed calls
with the original ID. No APInex-specific patch is needed for this observed
shape. End-to-end verification **through a running FreeLLMAPI instance**
and other models is still pending.

## Validation required before upstream PR

1. Obtain an account key in APInex's console; never commit a key.
2. Missing Authorization to `GET /v1/models` returned HTTP 401; authenticated
   read-only catalog request returned HTTP 200. Confirm explicitly invalid
   credentials return 401/403, not 200, before relying on key health verdicts.
3. Check free-balance/check-in semantics and its daily reset via an authenticated
   account/usage endpoint. Avoid consuming free tokens in validation polling.
4. Non-streaming chat, a non-stream tool-call plus tool-result round trip,
   SSE text streaming, and streaming tool-call deltas passed on
   `free/deepseek-v4.1-flash`. Verify through a running FreeLLMAPI proxy,
   plus vision **per model**; do not infer other models' abilities.
5. Verify quota errors (429 vs 402), Retry-After, whether inference RPM is shared
   between models, and model multiplier accounting. Confirm wallet is not debited
   for `free/*` calls.
6. Request a separate signed catalog publication for the five smoke-tested free chat IDs. Without that publication, new users must Fetch models or add a model manually. Never promote paid models as free.
7. Run `npm test` and `npm run build` with current Node and dependencies.

Sources:
- https://apinex.bond/
- https://apinex.bond/pricing
- https://apinex.bond/developers/models/chat
- https://github.com/Apinex-AI/APInexGate
- Independent API trial: https://www.habr.com/ (see 2026-09-05 APInex tests)
