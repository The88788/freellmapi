# Stage 4 checkpoint: Ready-fallback and legacy RPM/TPM/cooldown wait

**Date:** 2026-10-11. **Branch:** `feature/provider-pacing-queue`.

**Status:** Stage 4 incremental integration code committed; feature remains **OFF and activation-blocked**. No deployment, SSH, production database edits, or service restarts.

## Changes

1. **Temporary legacy limiter readiness:** `ratelimit.ts` now exposes read-only `getTemporaryPacingReadiness()` for cooldown, per-key concurrency, provider-minute request cap, per-model RPM and TPM, including provisional active leases. The minute-window next-eligible timestamp is determined by old usage entries; unknown stream completion is not converted into a fictitious TTL. Local `subscribeLeaseRelease()` allows event-driven wake-up without 100ms polling.
2. **Candidate classification:** `router.ts` `preview` distinguishes hard daily/monthly/identity/capability denials from short-lived RPM/TPM/cooldown/concurrency blockages. Only **preview** can return a temporarily blocked candidate (`pacingTemporarilyBlocked` + `pacingReadyAtMs`); `commit` still enforces original legacy guards before taking the existing monthly budget reservation and key lease. Ready candidates are preferred across the allowed chain before deferring a blocked candidate. A precise re-preview can be restricted to the same model DB ID and key ID.
3. **Admission readiness:** `provider-pacing-core.ts` accepts optional synchronous, side-effect-free readiness callback per waiter. Scheduler's local min-start/RPM/TPM/concurrency reservations occur only when this callback confirms the legacy limiter is ready; the callback is rechecked at wake. The next known timestamp or lease-release signal wakes waiters. The scheduled `maxWaitMs` still terminates permanently blocked requests. No full request body or credential stored in the queue.
4. **Bridge:** `provider-pacing-routing.ts` re-previews the exact key before grant and subscribes to existing lease-release notifications when installed; releases are cleaned up when uninstalled. No scheduler is installed by default, so legacy routing is untouched.
5. **Tests:** `provider-pacing-readiness.test.ts` (five fake-clock cases), `provider-pacing-legacy-limits.test.ts` (RPM, TPM, cooldown, long stream lease release), bridge integration test extended to cover waiting for legacy availability and updated to avoid asserting fragile preview call counts.

## Verified in the isolated local test environment

- The 13 original core tests and five new readiness checks rerun **together against the same modified Stage 4 core**: **18 PASS / 0 FAIL**, using Node 22 type stripping and a local deterministic test harness.
- `tsc --noEmit --strict` on that modified standalone core: **PASS**.
- 2 isolated SQLite sliding-window SQL tests: **2 PASS**.
- Repository-wide Vitest tests, TypeScript server/client build, pre/post-commit real SSE, and GitHub CI status: **not confirmed**. New repository tests were added but have not been executed as part of the repository suite.
- No real provider requests were sent; no current quota or key data accessed.

## Safety and unresolved hard gates

- The Stage 2 bridge obtains a scheduler grant **before** running the existing synchronous `routeRequest(commit)` reservation. This prevents leasing while queued but is **not a cross-resource SQLite/legacy-reservation transaction**. If legacy commit fails after a granted start, the start interval may be consumed without dispatch. Needs transactional/rollback test and an admission callback design before activation.
- Temporary long-range provider-authoritative cooldowns currently occupy a bounded waiter and may timeout; it never overrides a provider Retry-After, but policy should reject/skip waits whose deadline is beyond the max allowed budget.
- Active profile/route changed while waiting: committed model row/key/status/capability rechecked, but named auto-chain/profile revision must still be freshly resolved. Current frozen caller prefetchedChain is insufficient.
- Account/pool identity must be explicitly verified; `keyId` does not prove quota independence and inferred labels alone cannot prove physical ownership.
- End-to-end retry-after-429 fallback handling, full request deadline, Caddy/Harness/Codex timeout verification, long-stream cleanup, multi-worker guard, other upstream paths (fusion/embeddings/media/rerank/health) and ALL 22 AT cases still require verification/implementation.
- GitHub Actions branch workflow exists but success cannot be inferred without actual workflow results.

**NO-GO for production or enabling config.enabled.** Next milestone is atomic scheduler/legacy claim, fresh profile/chain re-resolution, fallback/deadline and independent CI/E2E verification.
