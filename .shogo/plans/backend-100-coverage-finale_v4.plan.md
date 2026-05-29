# Backend → 100% Coverage Finale (v4 — Concentrated Demolition)

**Branch:** `fix(coverage)/backend-unit-test-cases`
**Starting point (2026-05-28 11:30 Sync):** 82.16% lines (73,593 / 89,571), 80.16% functions (5,778 / 7,208).
**Distance to wall:** 15,978 uncovered lines, 1,430 uncovered functions.
**Target:** 90% by end of day, 95% by end of week, 100% by sprint close.

## 0. Why v4, not v3 continued

v3 set the right targets but the EXECUTION pattern produced scrap deltas (+47 lines/session avg). The plan was right; the *cadence* was wrong. Six concrete fixes this revision enforces:

1. **Sessions land ≥+200 lines OR they don't ship.** Below that, hold the work and continue in the next session — don't fragment.
2. **Attack the giants head-on.** `gateway-tools.ts` (1,129 uncov) and `manager.ts doStart()` (578 uncov) ARE the sprint. Multi-session harness work is fine — session N can be "build mock harness, zero coverage delta," session N+1 lands the win.
3. **Delete unreachable code without ceremony.** TypeScript-guaranteed-non-null defensive guards, unreachable default branches, redundant `if (!x) return` on values typed as `NonNullable<T>` — all targets for deletion, not testing.
4. **Fix pre-existing failures before routing around them.** `meetings.ts` (16 fails, 251 uncov) and `project-export-import.ts` (1 fail, 306 uncov) get triaged in a single session, then closed in the next.
5. **One Sync per 3+ source commits.** No-op Syncs are banned. Re-measure when there's real delta to capture.
6. **Per-package sweep mode.** When tackling 20-200 uncov stragglers, batch 3-5 files per commit using one shared test harness.

## 1. Where the gap is (fresh 2026-05-28 measurement)

**Total: 15,978 uncov across 11 packages. 6,206 of those live in 41 files with ≥20 uncov each — that's 39% of the gap concentrated in <5% of files.**

### Top 10 files by uncov (own-package measurement)

| Rank | File | Uncov | % | Strategy |
|---|---|---|---|---|
| 1 | `agent-runtime/src/gateway-tools.ts` | 1,129 | 77.47 | **Crush Giant** — 3 sessions |
| 2 | `apps/api/src/lib/runtime/manager.ts` | 578 | 52.55 | **Crush Giant** — 2 sessions |
| 3 | `agent-runtime/src/preview-manager.ts` | 483 | 68.60 | **Crush Giant** — 2 sessions |
| 4 | `agent-runtime/src/gateway.ts` | 408 | 85.31 | Single session |
| 5 | `apps/api/src/routes/project-export-import.ts` | 306 | 67.24 | **Fix & Close** (1 fail) |
| 6 | `apps/api/src/services/analytics.service.ts` | 293 | 77.82 | **Delete Dead** — SQL template lines |
| 7 | `apps/api/src/routes/meetings.ts` | 251 | 58.99 | **Fix & Close** (16 fails) |
| 8 | `apps/api/src/routes/instances.ts` | 232 | 79.91 | Single session |
| 9 | `apps/api/src/lib/knative-project-manager.ts` | 226 | 83.58 | Single session |
| 10 | `agent-runtime/src/response-transforms.ts` | 178 | 27.05 | Single session |

## 2. Wave structure — 10 concentrated sessions

### Wave 1 — agent-runtime giants (3-4 sessions) → +2.25 pp

| Session | Target | Approach | Expected delta |
|---|---|---|---|
| 1 | `gateway-tools.ts` mock harness | Build mock factories for every downstream client (`@anthropic-ai/sdk`, `@shogo-ai/sdk/voice`, `memfs`, `child_process`, in-memory LSP). Ship the harness as a `__tests__/fixtures/gateway-tools-harness.ts` even if zero coverage delta this session. | 0 |
| 2 | `gateway-tools.ts` per-tool sweep | Drive every tool's happy path + 2-3 error paths using the harness. Target +600 lines. | +600 |
| 3 | `gateway-tools.ts` close-out + `gateway.ts` start | Finish gateway-tools to ≥95%, begin gateway error-path sweep. | +500 |
| 4 | `gateway.ts` + `preview-manager.ts` lifecycle | Auth fail, rate limit, model not found, streaming abort + dockerode mocks. | +600 |

### Wave 2 — apps/api manager.ts giant (2 sessions) → +0.65 pp

| Session | Target | Approach | Delta |
|---|---|---|---|
| 5 | `manager.ts doStart()` mock harness | Mock `child_process.spawn`, `net.createServer`, `fs/promises`, `globalThis.fetch` health poll, `IProjectInfoStore`. Cover happy path. | +250 |
| 6 | `manager.ts` close-out | Worker crash, health timeout, port collision, missing-primary, Expo branch. Push to ≥95%. | +330 |

### Wave 3 — apps/api Fix-and-Close pair (2 sessions) → +0.60 pp

| Session | Target | Delta |
|---|---|---|
| 7 | `meetings.ts` — triage 16 fails, then close to ≥90% | +200 |
| 8 | `project-export-import.ts` — fix the 1 fail, then close to ≥90% | +280 |

### Wave 4 — Delete Dead + apps/api sweep (2 sessions) → +1.20 pp

| Session | Target | Delta |
|---|---|---|
| 9 | `analytics.service.ts` SQL-template defensive guards — DELETE unreachable branches (saves ~80 LF); cover remaining business logic (~150 LH) | +230 effective |
| 10 | Apps/api mid-tier sweep: `instances.ts` + `knative-project-manager.ts` + `auth.ts` + `security.ts` in one commit | +650 |

### Wave 5 — agent-runtime mid-tier + tail (2 sessions) → +0.90 pp

| Session | Target | Delta |
|---|---|---|
| 11 | agent-runtime sweep: `response-transforms.ts` + `index-engine.ts` + `workspace-graph.ts` | +400 |
| 12 | agent-runtime tail sweep: `skills.ts` + `quick-commands.ts` + 4 small files | +200 |

### Wave 6 — Closing the long tail → 95%+

After Waves 1-5: ~89.2%. Then mop-up:
- 16 small apps/api files (~30-100 uncov each) → batched +700
- ~10 small agent-runtime files → batched +250
- packages/shared-runtime mid-tier (s3-sync, server-framework — actually need to check standalone, may already be 100%)
- packages/cli + shogo-worker tails

### Wave 7 — Ratchet and 100% lock-in

1. Re-measure full aggregate.
2. Fix `packages/model-catalog` test infra bug (excluded from every Sync so far).
3. Ratchet `coverage/thresholds.json` to per-package floors.
4. Update README badge → ≥95% (yellow/brightgreen).
5. Add `.github/workflows/coverage-ratchet.yml` blocking PRs below threshold.

## 3. Hard rules

- **No `// istanbul ignore`** — delete or test.
- **No single-test files** under 100 lines unless they're sweeping multiple targets — the overhead isn't worth it.
- **Cross-file mock pollution check** — every new test runs aggregated with siblings before committing. If aggregate fails, drop the polluting tests and note in commit body (we've done this twice; it's fine).
- **One Sync per ≥3 source commits.** Sync sessions that find `git log <last-sync>..HEAD` shorter than 3 commits exit immediately with status report.
- **Failed harness session is OK.** If you spend a session building mocks and ship zero coverage, that's expected. Commit the harness with `chore(coverage): harness for X` and the next session uses it.

## 4. Success criteria

| Milestone | Aggregate | Sessions |
|---|---|---|
| **89% headline** | 73,593 + 6,000 hit / 89,571 = 88.86% | Waves 1-4 (10 sessions) |
| **95% headline** | 73,593 + 11,500 hit / 89,571 = 94.99% | Waves 1-6 (15 sessions) |
| **100% lock-in** | 89,571 / 89,571 | Waves 1-7 (~18 sessions) |

Stop fighting the symptom (small deltas) — attack the disease (small targets).
