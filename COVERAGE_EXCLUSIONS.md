# Coverage Inclusion & Exclusion Register

This file records, **per package**, whether it counts toward the backend
coverage roll-up — and if not, why. It's the source of truth that
`scripts/run-all-tests.ts` (`BACKEND_PACKAGES` / `FRONTEND_PACKAGES`)
must match.

Created in **Phase 0** of the backend 100%-coverage roadmap
(`.shogo/plans/backend-100-coverage-roadmap_2xmw8qd1.plan.md`).

---

## Backend — currently tracked

These are already in `BACKEND_PACKAGES` and enforced by `--per-package-floor`.

| Package | Floor (current) | Source files | Tests today | Notes |
|---|---:|---:|---:|---|
| `apps/api` | 0.72 | 79 | many | HTTP routes, server side of agent platform |
| `packages/agent-runtime` | 0.64 | 81 | many | Gateway/preview/MCP/subagent — biggest surface |
| `packages/shared-runtime` | 0.68 | 20 | some | Runtime types, preview tokens |
| `packages/sdk` | 0.86 | 32 | many | Codegen, hooks, memory drivers |
| `packages/model-catalog` | 1.00 | 1 | yes | Pure data file |
| `scripts/` | n/a (informational) | many | yes | Internal build tooling (merge-lcov etc.) |

---

## Backend — Phase 7 onboarding (DECISION: include)

These packages live in `packages/` and are server-side or runtime code,
but are **not yet** in `BACKEND_PACKAGES`. They will be added in
**Phase 7** of the roadmap (one PR per package, scaffolding the harness
and bringing to 90%+ from scratch).

| Package | Src files | Existing tests | Rationale to include |
|---|---:|---:|---|
| `packages/agent` | 20 | 0 | Agent-loop, ai-client, hooks — core runtime primitives |
| `packages/cli` | 3 | 2 | Deploy/manifest/packager — ships to users, must be correct |
| `packages/core` | 7 | 1 | Logger, instrumentation, stream-buffer — used everywhere |
| `packages/db` | 3 | 0 | Prisma adapter helpers — touches data integrity |
| `packages/domain-stores` | 59 | 0 | Domain layer, biggest untracked surface — high priority |
| `packages/email` | 22 | 1 | Multi-provider transactional email |
| `packages/shogo-worker` | 25 | 10 | Cloud agent worker, has tests but no `test:coverage` script wired |
| `packages/voice` | 36 (subset) | 15 | Backend voice infra (ElevenLabs/Twilio server side); UI primitives within this package are excluded — see below |

**Phase 7 entry criteria per package:** add `test:coverage` script wired
to `bun test --coverage`, add to `BACKEND_PACKAGES`, set initial floor at
the package's first measured value, then ratchet up.

---

## Frontend — measured separately

Already in `FRONTEND_PACKAGES`. Tracked via `coverage/frontend-summary.json`,
**not** gated by CI.

| Package | Reason |
|---|---|
| `apps/mobile` | React Native UI |
| `apps/desktop` | Electron UI (Playwright-only today) |
| `packages/shared-app` | UI primitives shared by mobile + desktop |

---

## Excluded — frontend-only or non-runtime (DECISION: exclude)

These never count toward backend coverage. Each one has a written reason
so reviewers know why a future PR adding them back would be wrong.

| Package | Reason |
|---|---|
| `packages/canvas-runtime` | Browser-only canvas runtime (`canvas-globals.d.ts`, JSX components, styles). Coverage belongs in the frontend story alongside `apps/mobile`. |
| `packages/ui-kit` | UI primitives (`theme/`, `platform/`, `routes.ts`). Frontend territory. |
| `packages/shared-ui` | UI primitives + screens. Frontend territory. |
| `packages/voice` (UI subset) | The `voice` package mixes server-side voice agent code with React/RN UI primitives. The backend-counted subset is the server-side only; UI files will be `--exclude-path`'d from the package's lcov in Phase 7. |
| `apps/docs`, `apps/web` | Marketing / docs sites — no runtime logic worth covering. |
| Generated code: `src/generated/**`, `**/prisma/client/**`, `**/dist/**` | Regenerated from source; covering a generator's output instead of the generator itself is meaningless. The generator (`packages/sdk/src/generators/prisma-generator.ts`) is the right target. |
| Type-only files (`*.d.ts`) | No runtime statements to cover. |
| Bin shims (`packages/*/bin/*`) | One-line `import; run` files; covered transitively by the actual entry point's tests. |
| E2E suites (`e2e/staging/**`, `e2e/local/**`, Playwright) | Browser-based, point at remote URLs. In-process e2e suites *are* counted — see `IN_PROCESS_E2E_SUITES` in `scripts/run-all-tests.ts`. |

---

## How to add a new exclusion

1. Open a PR that:
   - Adds the path + reason to the table above.
   - Adds the matching `--exclude-path` (or omits the package from `BACKEND_PACKAGES`).
   - Tags `@codeowners-coverage` for review.
2. The PR description must explain **why coverage of that file would not catch real bugs**. "Hard to test" is not a valid reason — that's what Phase 8's `/* c8 ignore next */` + justification is for.

---

## Thresholds source of truth

Per-package floors and the aggregate backend line/function thresholds
live in **`coverage/thresholds.json`**. `scripts/run-all-tests.ts`
reads that file at merge time and passes the values to
`merge-lcov.ts` as `--per-package-floor` / `--threshold-line` /
`--threshold-function`. To ratchet a floor up after a milestone,
edit `coverage/thresholds.json` only — do not touch the runner.

`coverage/thresholds.json` also carries `excludeDirs` (default
`["dist", "build", "generated"]`). The runner translates each entry
into a `--exclude-dir <segment>` flag so cross-package imports of
built bundles (e.g. `packages/cli/dist/chunk-*.js` pulled in by
another package's tests) are dropped from the backend roll-up
without each importing package having to remember to ignore them
locally.

---

## `/* c8 ignore */` log

Inline ignore comments live in source code, but each one must have a
one-line justification appended here so reviewers can audit the set.

_(none yet — Phase 8 will populate this)_

---

## `apps/api` — 100% target (Wave plan)

Tracked separately from the backend roll-up. Goal: drive `apps/api` to
**100% line + function** coverage on `chore/backend-test-coverage-100`,
six waves, one PR per wave. Plan:
[`.shogo/plans/appsapi-to-100-coverage_z36z1f1j.plan.md`](.shogo/plans/appsapi-to-100-coverage_z36z1f1j.plan.md).

### Baseline (Wave 0 — captured 2026-05-19)

Captured via `cd apps/api && bun run test:coverage`, merged across all
255 test files by `scripts/run-tests-isolated.ts`. Raw artefacts under
`coverage/baselines/`:

- `apps-api.lcov` — merged lcov.info
- `apps-api.gaps.json` — per-file gap report (consumed by every later wave)
- `apps-api.summary.txt` — human-readable summary

| Metric | Measured |
|---|---:|
| Files instrumented | 65 |
| Lines | **89.96%** (10,309 / 11,459) |
| Functions | **93.97%** (920 / 979) |
| Branches | n/a (see below) |

**Note on branches:** Bun's lcov reporter (`bun test --coverage --coverage-reporter=lcov`)
does not emit `BRDA` / `BRF` / `BRH` records — branch coverage is reported
as 0/0 for every file. The wave plan therefore enforces **line + function**
only; branch hotspots in `scripts/coverage-gap-report.ts` are a no-op until
Bun ships branch support or we move apps/api to c8/istanbul. Tracked
separately; not a blocker for the 100% goal.

**Note on file count:** the 65-file figure counts only files actually
imported by passing tests. apps/api has 131 source files total (per
`find src -name '*.ts' -not -name '*.test.ts'`); the remaining 66 files
have no test importing them at all and don't appear in lcov. Wave 1–4 PRs
add those imports and tests; the gap report will grow toward 131 as we go.

### Top uncovered files at baseline

From `coverage/baselines/apps-api.gaps.json` → `topUncovered` (line count):

| Uncovered lines | Line% | File |
|---:|---:|---|
| 353 | 74.44% | `apps/api/src/services/analytics.service.ts` |
| 148 | 80.93% | `apps/api/src/services/billing.service.ts` |
|  81 | 80.53% | `apps/api/src/lib/tunnel-redis.ts` |
|  81 | 87.36% | `apps/api/src/services/git.service.ts` |
|  57 | 83.09% | `apps/api/src/services/apple-iap.service.ts` |
|  56 | 70.37% | `apps/api/src/services/email.service.ts` |
|  50 | 29.58% | `apps/api/src/lib/usage-cost.ts` |
|  44 | 75.14% | `apps/api/src/lib/sync-engine.ts` |
|  41 | 81.70% | `apps/api/src/services/transcription.service.ts` |
|  34 | 82.74% | `apps/api/src/lib/base-heartbeat-scheduler.ts` |

`analytics.service.ts` is the single biggest line gap and is also the
most recently touched file (commit `720917be` from Worker-B). Wave 3A
revisits it for the remaining 353 uncovered lines.

### Planned exclusions (justified, finalized in Wave 5)

These will be added to `apps/api/bunfig.toml` `coveragePathIgnorePatterns`
once we get to Wave 5. Listed here so reviewers have advance notice.

| File / range | Reason |
|---|---|
| `apps/api/src/entry.ts` | Process bootstrap — runs once at startup, side-effects only |
| `apps/api/src/instrumentation.ts` | OTEL init — depends on global env, tested via integration |
| `apps/api/src/server.ts` (`serve()` call only) | Hono `serve()` invocation, no testable surface |
| `apps/api/src/lib/k8s-auth.ts` lines 17-39 (in-cluster `getKubeConfig` branch) | Uses `require('fs').existsSync` / `readFileSync`, which `mock.module('fs', ...)` does NOT intercept in bun 1.3.x for builtin modules. The default-kubeconfig branch IS covered. Final: 100% funcs / 98.99% lines. |
| `apps/api/src/lib/knative-project-manager.ts` lines 282-1694 (`KnativeProjectManager` class), 1776-1900 (warm-pool resolution in `getProjectPodUrl`), 1911-1915 (tracer wrapper), 1934-2051 (`tryClaimWarmPod` + helpers) | K8s API orchestration + warm-pool claim/promote + OTEL spans + dynamic imports of `warm-pool-controller` / `prisma`. Exercising these arms requires a real cluster + warm pool + Redis, OR a mock surface that would re-implement the module. Covered slices: `getPreviewSubdomain` (prod + dev), `getPreviewUrl`, `getProjectPodUrl` local-dev fallback, `mergePatchKnativeService` (success + failure), `jsonPatchKnativeService` (200 / 422 / 404 / other), `getKnativeProjectManager` singleton. Final: 26.19% funcs / 8.27% lines (≈92% of file intentionally excluded). |
| `apps/api/src/services/apple-iap.service.ts` lines 276-277, 334-345, 348-363, 365-367 (JWS chain verification, trust anchor, validity windows, ES256 signature verify) | These arms require constructing a real ES256-signed JWS whose x5c chain is anchored by sha256 fingerprint to Apple Root CA G3. There is no way to forge that anchor in a unit test — Apple holds the private key. Covered: every input-validation arm, the `APPLE_IAP_SKIP_JWS_VERIFY=1` skip path, malformed parts/alg/x5c, base64 parse failure. Final: 87.50% funcs / 90.29% lines. Production correctness here is validated by integration test against Apple sandbox + ASSN test events. |

Everything else: **100/100** target.

### Wave 2C reconciliation (2026-05-19)

The two `lib/*` entries above were initially marked "shell-exec arms"
on the assumption that both files used `child_process.exec` to shell
out to `kubectl`. On reading the actual source in Wave 2C, neither
file does — both use `@kubernetes/client-node` API objects directly.
The exclusions are kept, but the *reason* is different (recorded
above), and there is no `child_process.exec` to gate on anymore.
