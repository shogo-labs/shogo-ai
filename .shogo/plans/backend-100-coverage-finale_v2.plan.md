# Backend Coverage Sprint v2 — Finale to 100%

**Branch:** `fix(coverage)/backend-unitTests` (this branch ONLY — never `main`)
**Created:** 2026-05-27
**Starting point:** 83.0% backend lines, 80.79% backend functions, 67.82% frontend lines
**Goal:** **100% backend lines, ≥99% backend functions, no regressions**

---

## 0. Methodology

### Aggregate denominator (EXPANDED from v1)
v1 counted only 5 packages. v2 counts **every backend package shipped in the monorepo**:

| Package | In v1 agg? | In v2 agg? | Current % (best estimate) |
|---|---|---|---|
| `apps/api` | ✅ | ✅ | 83.73% |
| `packages/agent-runtime` | ✅ | ✅ | 73.53% |
| `packages/sdk` | ✅ | ✅ | 99.01% |
| `packages/shared-runtime` | ✅ | ✅ | 87.46% |
| `packages/model-catalog` | ✅ | ✅ | 100% |
| `packages/voice` | ❌ | ✅ NEW | ~10% |
| `packages/email` | ❌ | ✅ NEW | ~70% (after smtp.ts at 100%) |
| `packages/agent` | ❌ | ✅ NEW | ~8% |
| `packages/core` | ❌ | ✅ NEW | ~50% (stream-buffer done) |
| `packages/cli` | ❌ | ✅ NEW | ~95% (pkg.ts done) |
| `packages/shogo-worker` | ❌ | ✅ NEW | ~70% (runtime-manager, tunnel done) |

This is the **honest** aggregate. The reason: a package outside the aggregate that ships in production is still uncovered production code. v1's exclusion was a pragmatic shortcut; v2 closes that gap.

### Coverage attribution
- **Lines:** Bun V8 `LF/LH`, post-processed by `scripts/coverage-strip-comments.ts` to remove pure-comment / blank-line noise
- **Functions:** Bun V8 `FNF/FNH`. The known ~5% lcov artifact (anonymous arrow closures the runtime never emits an `FN:` record for) means **≥99% function coverage is the realistic ceiling**, not 100%. Lines is the hard target.

### Dead-code policy
- Unreachable defensive guards (`if (foo) { ... }` where `foo` is provably never falsy) → **DELETE**, note in commit message.
- Pre-V8-instrumentation initializers, double-null-checks, redundant try/catch with no recoverable path → **DELETE**.
- A real production guard that's just hard to test → keep, mark with `/* c8 ignore next */` or its Bun equivalent.

### Pre-existing test breakages
**MUST-FIX before continuing:** the test suite currently has known failures that block accurate measurement:
- `packages/shared-runtime`: ~89 fail (s3-sync, lsp-bin-resolution, platform-pkg, extract-tar env leaks)
- `packages/sdk`: ~12 errors (Playwright tests mis-routed through bun test, missing `@shogo-ai/voice` module)
- `packages/agent-runtime`: preview-manager + warm-pool hang the runner (>15s tests, infinite loops)
- `apps/api`: knative-project-manager.test.ts: 2 fail, isolated runs core-dump

These are **Wave A Day 1's first task**. Until they're fixed, every `bun test --coverage` run is non-reproducible.

---

## 1. Wave A — Stabilize & finish small packages (Days 1-5)

### Day 1: Fix the broken-tests landscape
**Files:** the suite, not single files. Outcome: 0 failures, 0 errors, 0 hangs across all backend packages.

1. **shared-runtime s3-sync / extract-tar / platform-pkg env leaks** — the real SA token mount + `/var/run/secrets/kubernetes.io/...` paths leak into the sandbox. Add `beforeEach` cleanups that wipe `process.env.S3_*` / `KUBERNETES_*` to known values.
2. **shared-runtime lsp-bin-resolution.test.ts** — depends on `PATH` having `tsc` / `eslint` resolvable. Pin via `mock.module('node:child_process')` so resolution is deterministic.
3. **sdk Playwright stray-file detection** — convert `*.spec.ts` Playwright files to a separate Playwright project config so `bun test` doesn't pick them up; add `test:unit` script that scopes to `*.test.ts` only.
4. **sdk missing `@shogo-ai/voice`** — extend `preload-sdk-mocks.ts` with a minimal voice subpath stub, same pattern as the 12 other SDK subpaths already mocked there.
5. **agent-runtime preview-manager / warm-pool hangs** — these are integration tests stranded in the unit folder. Move them to `src/__tests__/integration/` and exclude from the default `bun test` glob.
6. **apps/api knative-project-manager core dump** — likely a circular require triggered by SIGTERM. Add `--bail` to isolated runs and inspect the actual crash with `process.on('SIGTRAP', ...)` logging.

**Commit:** `test(coverage): fix all pre-existing test failures across backend packages`

### Day 2: shared-runtime to 100%
| File | Current | Target | Approach |
|---|---|---|---|
| `s3-sync.ts` | 5.17% (953 uncov) | **100%** | `@aws-sdk/client-s3` mocked at module scope; cover upload/download/list/delete + retry + multipart paths |
| `git-sync.ts` | mid-tier | **100%** | already partial; finish the cleanup-on-failure + auth-cookie paths |
| `lsp-service.ts` | mid-tier | **100%** | finish the in-memory LSP server fixture |
| `diagnostics.ts` | 100% lines done | **keep 100%** | regression-only |

**Commit per file:** `test(coverage): shared-runtime/<file> — <before>% → 100%`

### Day 3: sdk to 100%
- `agent/client.ts` — done at 100% lines, but 4 anonymous closures uncov. Refactor those into named `private close = () => { ... }` instance fields so Bun emits `FN:` records, or accept the 94% func ceiling.
- `memory/store.ts` — already 100%
- `memory/drivers/node.ts` — done at 100%
- `memory/summarizer.ts` (if exists at 0%) — `mock.module('@anthropic-ai/sdk')` minimal stub; cover summarize() / merge-pass / fallback-on-error
- Any remaining `<95%` file in sdk

### Day 4: small packages — `packages/email` to 100%
- `providers/smtp.ts` — done at 100%
- `providers/ses.ts` (8.91%) — `@aws-sdk/client-ses` mocked, mirror smtp.ts test layout
- `providers/oci-email.ts` (if exists) — mock OCI client
- `server.ts` (17.50%) — provider-selection logic, env-driven init
- `templates.ts` — already at 100%

**Commit per file.**

### Day 5: small packages — `packages/agent`, `packages/core`, `packages/cli`, `packages/shogo-worker`
| Package | Files left | Approach |
|---|---|---|
| `agent` | `ai-client.ts` (8%), `tools-client.ts`, `runner.ts` | mock Anthropic/OpenAI; cover retry + streaming + tool-call paths |
| `core` | `instrumentation.ts` (9.38%) — `@opentelemetry/api` already installed | mock NodeSDK; cover init success / init failure / shutdown |
| `cli` | finish `app.ts`, `commands/*.ts` | already mostly done from pkg.ts work |
| `shogo-worker` | finish `cloud-file-transport.ts`, `lib/git-cloner.ts` | already partial — push to 100% |

**Expected aggregate at end of Wave A: ~92-94% backend lines**

---

## 2. Wave B — apps/api routes & libs (Days 6-12)

### Day 6-7: routes — `local-projects.ts` & `voice.ts`
- `routes/local-projects.ts` (27.82%, 397 uncov, 948 LOC, **NO test file**) — build from scratch:
  - Mock `node:fs/promises` (memfs is overkill; bun's `mock.module` is cleaner)
  - Mock `node:child_process` (spawn for git/npm)
  - Mock the prisma client via the existing fixture pattern in `apps/api/src/__tests__/`
  - Cover every Hono route: GET list, POST create, DELETE, GET status, POST/sync, error paths
- `routes/voice.ts` (77.90%, 337 uncov, 2,135 LOC) — partial test exists, finish the ElevenLabs webhook + token derivation paths

### Day 8-10: `apps/api/src/lib/knative-project-manager.ts` (8.32%, 1,700+ uncov, 2,055 LOC)
The biggest single file in the entire backend. Strategy:
1. **Day 8 — fixture infrastructure**: create `__fixtures__/knative-fixtures.ts` with reusable mocks for k8s API client, prisma, and warm-pool controller. Run a smoke test that opens the controller and verifies it idles.
2. **Day 9 — happy paths**: createKnativeProject / deleteKnativeProject / listKnativeProjects / getKnativeProjectStatus
3. **Day 10 — error paths**: retries, k8s API failures, quota errors, image-pull errors, scaling edge cases

### Day 11: remaining `apps/api/src/lib/*`
- `ai-proxy-token.ts` — partial, finish HS256 + RS256 edge cases
- `warm-pool-controller.ts` — already has expanded tests; close remaining branches
- `chat-session-manager.ts` — cover all session lifecycle states

### Day 12: remaining `apps/api/src/routes/*`
- `agents.ts`, `chat.ts`, `projects.ts`, `auth.ts` — sweep for files <95% and bring them up

**Expected aggregate at end of Wave B: ~96-97% backend lines**

---

## 3. Wave C — agent-runtime giants (Days 13-22)

### Day 13-16: `packages/agent-runtime/src/gateway-tools.ts` (6,254 LOC, ~1,800 uncov)
This is the biggest file in the entire backend by line count. 4-day plan:
1. **Day 13 — Playwright handlers**: `browser_*` tools (~600 uncov) — mock `playwright-core` at module scope, cover navigate/click/snapshot/screenshot/extract paths
2. **Day 14 — MCP integration**: `mcp_*` tools (~400 uncov) — mock the MCP client, cover discover / call / error retry
3. **Day 15 — file/shell tools**: `read_file` / `edit_file` / `exec` branches (~500 uncov) — extend existing fixtures
4. **Day 16 — sweep**: web tools, channel tools, memory tools, residual branches (~300 uncov)

### Day 17-18: `packages/agent-runtime/src/gateway.ts` (~500 uncov, 81.38%)
- Cover the SSE dispatcher + turn-state machine + cancellation paths

### Day 19-20: `packages/agent-runtime/src/preview-manager.ts` (~450 uncov, 70.81%)
- The hanging tests need to be moved out first (Day 1 dependency)
- Cover: spawn / restart / rebuild / port-forward / log-streaming

### Day 21: `packages/agent-runtime/src/session-manager.ts` finish-up
- Already at 97.66% — clean the last 2-3 branches

### Day 22: agent-runtime sweep
- Every file in agent-runtime to ≥99% lines

**Expected aggregate at end of Wave C: ~99% backend lines**

---

## 4. Wave D — packages/voice (Days 23-25)

Voice was never in the v1 aggregate. It's a 4-file cluster, all <25%:
- `voice/src/telephony.ts` (407 uncov, 6%)
- `voice/src/server.ts` (346 uncov, 21%)
- `voice/src/elevenlabs.ts` (316 uncov, 11%)
- `voice/src/mock-telephony.ts` (~250 uncov, 1.7%)

**Shared mock layer** for ElevenLabs SDK + WebSocket telephony → all four files testable in one PR per day.

---

## 5. Wave E — Ratchet, enforcement, finalization (Day 26)

### Per-file floor table
Codify a `coverage/thresholds.json` like:
```json
{
  "global": { "lines": 100, "functions": 99 },
  "perFile": {
    "packages/agent-runtime/src/gateway-tools.ts": { "lines": 98 },
    "packages/sdk/src/agent/client.ts": { "lines": 100, "functions": 94 }
  }
}
```
Files we accepted at <100% lines: gateway-tools.ts (≥98%), runtime-manager.ts (95%+), or anything with documented Bun lcov artifacts.

### Ratchet script
`scripts/coverage-ratchet.ts` — runs in CI:
1. Reads previous baseline from `coverage/baselines/_aggregate.gaps.json`
2. Runs fresh coverage
3. Fails the build if **any per-file or aggregate metric regresses**
4. Auto-updates the baseline when a PR raises coverage

### Branch protection requirement
- `coverage` check must pass before merge to main
- Cannot merge a PR that brings any file <100% lines (unless allowlisted in `thresholds.json` with a justification comment)

---

## 6. Anti-patterns to avoid (learned from v1)

1. **Out-of-aggregate work** — every file we cover should be in the aggregate denominator, or the badge doesn't move. Wave A Day 4-5 explicitly *expands* the denominator so this stops being an issue.
2. **`mock.module` factory throwing** — Bun invokes factories eagerly; use Proxy with throwing getters instead (see `packages/sdk/src/memory/drivers/__tests__/node.test.ts`).
3. **`createRequire` cache vs mock.module** — once required, the module is cached. Plan for single-mode-per-test-file when using mock.module against `createRequire` consumers.
4. **Pre-existing failures hiding regressions** — never push a coverage commit if `bun test` introduces *new* failures, even if the count is already non-zero.
5. **Single-decimal badge rounding noise** — 82.97% vs 83.04% reads as 83.0% vs 83.0%. Move at least 100+ lines per task to see a digit change.

---

## 7. Velocity & checkpoints

| Wave | Days | Files completed (est.) | Cumulative aggregate target |
|---|---|---|---|
| A | 1-5 | 15 files | 92% |
| B | 6-12 | 12 files | 96.5% |
| C | 13-22 | 18 files | 99% |
| D | 23-25 | 4 files | 99.5% |
| E | 26 | infra, not files | **100%** (or 99.5% + documented ceiling) |

**Throughput target:** 2-3 files per session minimum. Stretch: a small file + a medium file + a sweep commit per day.

---

## 8. Execution rules (locked in)

- ✅ Work only on `fix(coverage)/backend-unitTests`
- ❌ Never push to `main` or any other branch
- ❌ Never open PRs (the user owns PR control)
- ✅ Every commit pushes immediately
- ✅ Every task ends with: aggregate before → after, next pending task, and pull command for the user's Mac
- ✅ Multi-file batching is encouraged — group related small files into one session/commit if it shrinks the round-trips
