# Provider Pacing & Queue: Stage 3 development checkpoint

**Status:** operator configuration and SQLite persistence committed on `feature/provider-pacing-queue`. Not deployable as an active scheduler. **Production VPS was not accessed or changed.**

## What changed

- `server/src/db/migrations/20261011_000001_provider_pacing.ts` and `server/src/db/migrate/defaults.ts`: reversible, repeatable SQLite schema for a revisioned singleton policy document and durable per-bucket next-start timestamps.
- `server/src/services/provider-pacing-store.ts`: typed strict Zod config validation, cross-field scope validation from the core, optimistic revision compare-and-swap, short synchronous SQLite transactions and fail-closed next-start persistence. It stores NO requests, keys, proxy URLs, tool payloads or prompts.
- `server/src/routes/settings.ts`: admin-only policy GET, draft PUT and dry-run POST.
- `server/src/routes/provider-pacing.ts`, `server/src/app.ts`: dashboard-session-protected queue status; no inference API key grants access.
- `server/src/services/provider-pacing-routing.ts`: sanitized live status (installed=false by default), and **critical correction** to passing `preview/commit` as the **12th argument, index 11**, of `routeRequest`.
- `client/src/components/provider-pacing-settings.tsx` and `client/src/components/settings-dialog.tsx`: Settings > LLM Queue, draft JSON editor, a scoped Pollinations model+key rule builder, validation, revision-safe save, status counters and a clear "not active" safety notice. The model ID/key ID are never guessed.
- `server/src/__tests__/services/provider-pacing-store.test.ts`: seven tests for config/default/revision/rollback/validation/start-deadline persistence (source added, execution pending).
- `.github/workflows/provider-pacing-dev-ci.yml`: branch-only push workflow using Node 22, migration roundtrip, full tests, lint and build; never deploys.

## API contract in this stage

All endpoints **require existing dashboard administrator authentication**.

| Endpoint | Behavior |
|---|---|
| `GET /api/settings/provider-pacing` | `schemaVersion`, `revision`, `config`, `updatedAtMs`, `updatedBy`, `runtimeEnabled:false` |
| `POST /api/settings/provider-pacing/validate` | Request `{ "config": {...} }`; returns `valid` and `activatable:false` without writes |
| `PUT /api/settings/provider-pacing` | Request `{ "revision":N, "config": {...} }`; atomic CAS save; stale revision -> HTTP 409 / `revision_conflict` |
| `GET /api/provider-pacing/status` | `revision`, `installed`, `enabled`, `status`, `counters`; no key or payload content |

### Intentional activation gate

To save a draft, keep `config.enabled = false`. Attempting to save `enabled:true` returns **HTTP 409** `pacing_not_ready`. This is deliberate: the existing readiness, timeout and end-to-end safety gaps must be solved first. A successfully saved rule has **no effect on any live requests**.

Sample **draft** rule (replace values with actual route metadata; example keyId 123 is fictional):

```json
{
  "enabled": false,
  "maxPendingGlobal": 200,
  "maxPendingPerClient": 10,
  "rules": [{
    "id": "pollinations-model-key-123",
    "enabled": true,
    "scope": "model-key",
    "match": {
      "platform": "pollinations",
      "modelId": "REPLACE_WITH_ACTUAL_ROUTE_RESULT_MODEL_ID",
      "keyId": 123
    },
    "limits": { "minStartIntervalMs": 65000, "maxConcurrent": 1 },
    "queue": { "maxWaitMs": 180000, "maxPendingPerBucket": 20 }
  }]
}
```

The 65-second rule is an illustration of an inactive draft, **not** a ready-to-use deployment configuration. Confirm `RouteResult.modelId`, `keyId`, account vs independent keys and actual client/Caddy timeouts before activation.

## Test evidence, do not overstate

- Independent Node 22 fake-clock Stage 1 harness: **13/13 passed**, rerun.
- Isolated Stage 1 TypeScript core check: passed.
- Isolated Node 22 `node:sqlite` SQL smoke: passed (schema idempotence, revision CAS, atomic rollback and persisted deadline). **This is NOT a run of the repository's new Vitest suite.**
- Stage 2/3 Vitest tests, full server/client build, migration roundtrip in the checkout, HTTP/SSE protocols, Harness + Codex end-to-end: **not yet confirmed passed**.
- A branch-scoped GitHub Actions workflow has been committed. Its execution/results have **not been confirmed**.

## Remaining hard blockers

1. Preview must distinguish temporary cooldown/RPM/TPM/concurrency gates from permanent model/credential failures and defer only when a real deadline exists. Currently it can exhaust before queue registration on saturated legacy limiter.
2. Auto routing must consider an allowed *ready* fallback before queueing a slow candidate; strictly pinned requests must remain pinned.
3. Queue wait over multiple provider candidates and upstream 429 retries must share a bounded total request deadline, separate from the fallback hedge clock, with real reverse proxy/client timeout validation.
4. Verify exact-account/pool identities; key count does not establish quota independence.
5. Stage 2 route preview/commit + SQLite persistent interval transaction + legacy lease/budget must pass deterministic cross-resource concurrency and rollback tests. Existing synchronous bridge is a step toward, not proof of, complete atomicity.
6. Verify complete upstream traffic inventory for fusion, rerank, embeddings, media and health; do not silently let these bypass a configured provider-account cap.
7. Full AT-01 through AT-22 matrix, CI, dev-only local mock E2E and safe startup/shutdown guard for accidental multiple Node writers. Add operator fast rollback.
8. Optional UI enrichment: richer rule matching, effective-policy display, explicit minute-rate-derived safety margin; the current section is a draft editor, not final UI.

**Decision: NO-GO for active scheduler or production rollout.** Nothing has been deployed. The main branch and Cloudflare Vision PR branch remain untouched.
