# APInex gateway (2026-10-17, pending authenticated smoke test)

- Website: https://apinex.bond/
- API base: `https://api.apinex.bond/v1`
- Auth: `Authorization: Bearer sk-apx-...`
- Chat: `POST /v1/chat/completions` (OpenAI-compatible)
- Models: `GET /v1/models` (published, **authenticated key validation is NOT yet proven**)
- Free routes use `free/*` IDs. **Paid IDs charge a separate USD wallet** and should not be auto-enabled.

## Recurring allowance and observed rate limits

APInex advertises a recurring daily free token allowance, but its public sources
disagree on the size: 1M/day with check-in in social announcements, 3M/day on
the homepage, and 10M/day on the pricing page. Weekend bonus grants and promo
codes are promotional, not guaranteed baseline renewals. Some free models
consume 2x/3x of the shared free-token allowance. Therefore the integration
does **not** seed per-model quota numbers or hard-code a daily cap.

An independent September 5, 2026 test observed a *shared* 30 RPM counter across
different free models using `x-ratelimit-limit`, `x-ratelimit-remaining`, and
`x-ratelimit-reset`. The quota collector records actual header values when
present; 30 RPM is **not** a hardcoded limit. Daily reset at 00:00 UTC was
reported independently but remains unverified via authenticated API response.
Published RPD, TPM, and per-model contexts are unknown.

## Validation required before upstream PR

1. Obtain an account key in APInex's console; never commit a key.
2. Verify that invalid or missing auth to `GET /v1/models` actually returns
   401/403. If it returns 200 publicly, use a **read-only authenticated endpoint**
   for `validateUrl` before enabling unattended health checks.
3. Check free-balance/check-in semantics and its daily reset via an authenticated
   account/usage endpoint. Avoid consuming free tokens in validation polling.
4. Run non-streaming and streaming chat, tool calls, and vision **per model**.
   Do not infer all model abilities from gateway-wide API support.
5. Verify quota errors (429 vs 402), Retry-After, shared RPM, and model multiplier
   accounting. Confirm wallet is not debited for `free/*` calls.
6. Add only live-proven free model IDs to the hosted signed model catalog;
   do not migrate/promote paid models as free.
7. Run `npm test` and `npm run build` with current Node and dependencies.

Sources:
- https://apinex.bond/
- https://apinex.bond/pricing
- https://apinex.bond/developers/models/chat
- https://github.com/Apinex-AI/APInexGate
- Independent API trial: https://www.habr.com/ (see 2026-09-05 APInex tests)
