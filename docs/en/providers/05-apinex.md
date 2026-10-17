# APInex gateway (2026-10-17, authenticated catalog and chat smoke tests passed)

- Website: https://apinex.bond/
- API base: `https://api.apinex.bond/v1`
- Auth: `Authorization: Bearer <key>` (a working account key used `sk-apx` prefix without requiring a trailing hyphen; never log key values)
- Chat: `POST /v1/chat/completions` (OpenAI-compatible)
- Models: `GET /v1/models` (**authenticated HTTP 200 confirmed 2026-10-17**; omitted authorization returned HTTP 401 `Missing API key`). It returned 43 routes, including 20 `free/*` IDs. A forged *invalid but present* key was not yet tested.
- Free routes use `free/*` IDs. **Paid IDs charge a separate USD wallet** and should not be auto-enabled.

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

## Validation required before upstream PR

1. Obtain an account key in APInex's console; never commit a key.
2. Missing Authorization to `GET /v1/models` returned HTTP 401; authenticated
   read-only catalog request returned HTTP 200. Confirm explicitly invalid
   credentials return 401/403, not 200, before relying on key health verdicts.
3. Check free-balance/check-in semantics and its daily reset via an authenticated
   account/usage endpoint. Avoid consuming free tokens in validation polling.
4. Non-streaming chat and a single non-stream tool-call turn passed on
   `free/deepseek-v4.1-flash`. Verify SSE streaming, streamed tool calls,
   a full tool-result round trip and vision **per model**. Do not infer all
   model abilities from gateway-wide API support.
5. Verify quota errors (429 vs 402), Retry-After, whether inference RPM is shared
   between models, and model multiplier accounting. Confirm wallet is not debited
   for `free/*` calls.
6. Add only live-proven free model IDs to the hosted signed model catalog;
   do not migrate/promote paid models as free.
7. Run `npm test` and `npm run build` with current Node and dependencies.

Sources:
- https://apinex.bond/
- https://apinex.bond/pricing
- https://apinex.bond/developers/models/chat
- https://github.com/Apinex-AI/APInexGate
- Independent API trial: https://www.habr.com/ (see 2026-09-05 APInex tests)
