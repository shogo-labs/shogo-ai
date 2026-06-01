# Backend → 100% Coverage Finale (v3 — Aggressive Sprint)

**Branch:** `fix(coverage)/backend-unit-test-cases`
**Starting point:** 88.79% lines (66,750 / 75,174), 86.14% functions (5,322 / 6,178), commit `e9dbe48` carried over from prior branch.
**Distance to wall:** 8,424 uncovered lines, 856 uncovered functions.
**Target:** 100% lines & functions across all 11 backend packages.

## 0. Why v3, not v2 continued

v2 closed Wave A (stabilization) and 78% of Wave B (apps/api routes & libs). The PR was merged. This new branch is a clean rebase off `main` to:

1. Pick up post-merge upstream changes (canvas-mode hardening, knative pin, marketplace) that may have shipped new uncovered lines.
2. Reorder Waves by **leverage-per-day**, not original package order — agent-runtime alone is 43.4% of the remaining gap.
3. Compress the schedule: aggressive batching (2-4 files per commit), zero ceremonial commits, dead-code deletion preferred over coverage gymnastics.

## 1. Gap distribution (where the 8,424 uncovered lines live)

| Rank | Package | Uncov lines | % of gap | % of fix-effort |
|------|---------|-------------|----------|------------------|
| 1 | `apps/api` | 3,986 | 47.3% | medium — many small files |
| 2 | `packages/agent-runtime` | 3,676 | 43.6% | high — 3 giant files |
| 3 | `packages/sdk` | 413 | 4.9% | low — already 93.65% |
| 4 | `packages/cli` | 94 | 1.1% | low |
| 5 | All other 7 pkgs | 255 | 3.0% | trivial |

**Sub-ranking — files with > 200 uncov:**

| File | Uncov | Cur L% | Priority |
|------|-------|--------|----------|
| `agent-runtime/src/gateway-tools.ts` | 1875 | 61.76% | **🔥 P0** |
| `agent-runtime/src/gateway.ts` | 516 | 81.38% | P0 |
| `agent-runtime/src/preview-manager.ts` | 449 | 70.81% | P1 |
| `apps/api/src/lib/runtime/manager.ts` | 433 | 64.10% | P1 |
| `apps/api/src/routes/local-projects.ts` | 397 | 27.82% | P1 (blocked: 19 failing tests) |
| `apps/api/src/routes/voice.ts` | 337 | 77.90% | P2 |
| `apps/api/src/routes/project-export-import.ts` | 306 | 67.24% | P2 |
| `apps/api/src/services/analytics.service.ts` | 293 | 77.82% | P2 |
| `apps/api/src/routes/ai-proxy.ts` | 284 | 87.85% | P2 |
| `apps/api/src/routes/meetings.ts` | 251 | 58.99% | P2 |
| `apps/api/src/routes/instances.ts` | 232 | 79.91% | P3 (blocked: SDK subpath resolution) |

The top 11 files = **5,373 uncov** = **63.8% of total gap**. Closing them alone moves the headline 7.1pp → ~95.9%.

## 2. Sprint structure — 5 waves, ~16 working days

### Wave 1 — agent-runtime giants (Days 1-7) — +5.3pp → ~94.1%

| Day | Target | Lines closed | Approach |
|-----|--------|--------------|----------|
| 1-4 | `gateway-tools.ts` (1875 uncov) | +1875 | Per-tool dispatch table tests using fake LLM responses + mock.module for every tool's downstream client (`@anthropic-ai/sdk`, `@shogo-ai/sdk`, fs ops via memfs). Run with `bun test --conditions=development`. Target ≥95% / ≥99% funcs. |
| 5 | `gateway.ts` (516 uncov) | +516 | Drive every error path (auth fail, rate limit, model not found, streaming abort). Use `@opentelemetry/api` no-op mock to silence spans. |
| 6-7 | `preview-manager.ts` (449 uncov) | +449 | Move the **integration** tests in `__tests__/integration/` aside; unit-test by mocking `dockerode`, `node:child_process`, `node:fs/promises`. Lifecycle: build → start → health probe → reap (incl. win32 path). |

### Wave 2 — apps/api hot files (Days 8-12) — +4.0pp → ~98.1%

| Day | Targets | Lines closed |
|-----|---------|--------------|
| 8 | `lib/runtime/manager.ts` (433 uncov) | +433 |
| 9 | `routes/local-projects.ts` — first fix the 19 failing tests, then drive uncov branches. **If tests are unfixable in 1 day, DELETE the stale broken tests and rewrite from scratch** (faster than triaging). | +397 |
| 10 | `routes/voice.ts` (337) + `routes/ai-proxy.ts` (284) batched | +621 |
| 11 | `routes/project-export-import.ts` (306) + `services/analytics.service.ts` (293) batched | +599 |
| 12 | `routes/meetings.ts` (251) + `routes/instances.ts` (232) — instances needs `--conditions=development` fix to `run-tests-isolated.ts` first | +483 |

### Wave 3 — apps/api long tail (Days 13-14) — +1.0pp → ~99.1%

`apps/api` has ~40 more files with 30-100 uncov each. Sweep in batches of 4-6 per commit using a **single generated test harness** that exercises the common patterns (auth middleware, validation errors, 404 paths). Aim for +700-800 lines across 2 days.

### Wave 4 — sdk + cli + small-package finish (Day 15) — +0.6pp → ~99.7%

- `packages/sdk` (413 uncov) → mostly client builder edge cases. Single commit.
- `packages/cli` (94 uncov) → CLI argv parsing branches. Trivial.
- Remaining stragglers in voice/email/agent/core/shogo-worker.

### Wave 5 — ratchet, polish, README (Day 16) — 100% lock-in

1. Re-measure full aggregate with `bun test --coverage` + `scripts/sum-lcov.ts` + `scripts/coverage-strip-comments.ts`.
2. Ratchet `coverage/thresholds.json` to `1.00` for all 11 packages.
3. Update README badge → brightgreen 100%.
4. Add `.github/workflows/coverage-ratchet.yml` blocking PRs below threshold.
5. File final PR → `main`.

## 3. Execution rules (locked)

1. **Branch:** `fix(coverage)/backend-unit-test-cases` only. Never push to `main`. Never open intermediate PRs.
2. **One commit per file (or per batch of small files)** with message `test(coverage): <file> — <before>% → <after>% lines`.
3. **Every commit:** measure with `bun --conditions=development test --coverage` for the affected package; if isolated, use `scripts/run-tests-isolated.ts`. Refuse to commit if any new failure introduced.
4. **Dead-code rule:** if a guard is provably unreachable (e.g. `if (foo)` where TypeScript proves `foo` is never falsy), **delete it** rather than testing it. Note deletion in commit message.
5. **Mock taxonomy:**
   - fs → `memfs`
   - child_process → `mock.module('node:child_process', ...)`
   - sqlite → in-memory `file::memory:?cache=shared`
   - LLM → `mock.module('@anthropic-ai/sdk', ...)` returning canned streams
   - AWS → `mock.module('@aws-sdk/*', ...)`
   - playwright → `mock.module('playwright-core', ...)`
   - opentelemetry → no-op tracer mock
   - elevenlabs → `mock.module('@elevenlabs/*', ...)`
6. **Per-file floor:** ≥95% lines AND ≥99% functions before moving on. If unreachable, document why in the gaps.json `notes` field.
7. **sprintCommits[] updated** in `coverage/baselines/_aggregate.gaps.json` after every push (commit SHA + per-file delta).
8. **Pre-push gate:** run the affected package's full `bun test` once with no `--bail`. Zero new failures.

## 4. Anti-patterns (learned from v1 & v2)

- ❌ Do NOT touch the Frontend badge.
- ❌ Do NOT trust the merged-aggregate lcov for per-file numbers — `--conditions=development` doesn't propagate through `scripts/run-tests-isolated.ts` subprocesses, so SDK subpath imports drop coverage. Always re-measure per file with `bun --conditions=development` on the single test file before claiming done.
- ❌ Do NOT add tests that exercise mocks rather than code. Every test must assert real behavior of the unit under test.
- ❌ Do NOT chase 100% of a file with `// istanbul ignore` pragmas — those are forbidden on this branch. Either test it or delete it.
- ❌ Do NOT batch unrelated packages in one commit. One package per commit minimum.

## 5. Daily checkpoint format

```
== Day N — <Wave> ==
Files closed: X (target Y)
Commits pushed: <sha-list>
Aggregate: A.AA% → B.BB% (+ΔΔpp)
Wave progress: M/N
Next: <day-N+1 target>
Blockers: <none | description>
```

## 6. Success criteria (Wave 5 exit)

- [ ] `bun --conditions=development test --coverage` in every package shows ≥100% lines and ≥100% functions (or files explicitly noted as unreachable dead code in `_aggregate.gaps.json`).
- [ ] `scripts/sum-lcov.ts` + `scripts/coverage-strip-comments.ts` aggregate = 100.00% lines, 100.00% functions.
- [ ] README badge = brightgreen `100%`.
- [ ] `coverage/thresholds.json` ratcheted to `1.00`.
- [ ] PR opened from `fix(coverage)/backend-unit-test-cases` → `main` with full delta report.
- [ ] Frontend badge UNTOUCHED.
