# Testing & Coverage Harness

This is the canonical reference for **how we write backend tests in this
repo** and **how coverage is measured and enforced**. If you're adding
tests as part of the 100%-coverage roadmap
(`.shogo/plans/backend-100-coverage-roadmap_2xmw8qd1.plan.md`), start
here.

---

## TL;DR

- **Runner:** `bun test` per-package. The repo-level entry is `bun run test` (which calls `scripts/run-all-tests.ts`).
- **Coverage:** `bun run test:coverage` (soft floors) or `bun run test:coverage:check` (strict — fails CI on regression).
- **One file = one suite.** Co-locate `foo.test.ts` next to `foo.ts` (or under `__tests__/`).
- **Mock at module boundaries, not inside.** Use `mock.module()` for IO; keep the unit pure.
- **Hard-isolated runs for `apps/api`.** That package uses `scripts/run-tests-isolated.ts` (one bun process per test file) to avoid `mock.module()` contamination — don't try to consolidate it back.

---

## Coverage gates

| Script | Mode | Use |
|---|---|---|
| `bun run test:coverage` | Soft — `[WARN]` on breach, exits 0 | Local dev. Iterate until green. |
| `bun run test:coverage:check` | Strict (`SHOGO_COVERAGE_STRICT=1`) — exits non-zero on breach | CI. Every PR runs this. |

**Current floors** (from `scripts/run-all-tests.ts`, ratcheted up each
phase — never down):

```
aggregate                    line 0.71  func 0.78
apps/api                     0.72
packages/agent-runtime       0.68   (Phase 2: was 0.67; Phase 1: was 0.64)
packages/shared-runtime      0.63   (Phase 1 surfaced git-sync.ts; Phase 6 will cover)
packages/sdk                 0.86
packages/model-catalog       1.00
```

When a phase merges, the engineer **must** bump the floor for the
package(s) it touched to the new measured value. Floors only move up.

---

## Three canonical test shapes

Every test in the repo should fall into one of these three shapes. If
yours doesn't, the design is probably wrong — ask before writing 200
lines of scaffolding.

### 1. Pure unit (preferred; ~80% of tests)

The function under test has no IO and no global side effects. Just
call it with inputs, assert on outputs.

```ts
// packages/shared-runtime/src/preview-token.test.ts
import { describe, it, expect } from 'bun:test'
import { signPreviewToken, verifyPreviewToken } from './preview-token'

describe('preview-token', () => {
  it('round-trips a valid token', () => {
    const token = signPreviewToken({ projectId: 'p1', exp: 9999999999 }, 'secret')
    expect(verifyPreviewToken(token, 'secret')).toMatchObject({ projectId: 'p1' })
  })

  it('rejects a tampered token', () => {
    const token = signPreviewToken({ projectId: 'p1', exp: 9999999999 }, 'secret')
    const tampered = token.slice(0, -2) + 'xx'
    expect(() => verifyPreviewToken(tampered, 'secret')).toThrow(/signature/i)
  })
})
```

### 2. Mocked-IO unit (~15% of tests)

The unit calls out to the filesystem, a network client, or a child
process. Mock the **module boundary**, not internals of the unit.

```ts
// packages/agent-runtime/src/mcp-client.test.ts
import { describe, it, expect, mock, beforeEach } from 'bun:test'

const send = mock(() => Promise.resolve({ result: { tools: [] } }))
mock.module('./mcp-transport-stdio', () => ({
  createStdioTransport: () => ({ send, close: mock(() => {}) }),
}))

import { McpClient } from './mcp-client'

describe('McpClient.listTools', () => {
  beforeEach(() => send.mockClear())

  it('sends a tools/list JSON-RPC request', async () => {
    const client = new McpClient({ transport: 'stdio', command: 'whatever' })
    await client.listTools()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'tools/list' })
    )
  })
})
```

Rules of thumb for mocked-IO:

- Mock **once per file**, at the top. Don't toggle mocks mid-test.
- **Never** mock the unit under test. If you're tempted to, the unit is doing too much.
- Reset call history in `beforeEach`, not implementation.

### 3. In-process integration (~5% of tests)

The test boots a real route handler / runtime piece against SQLite +
local FS and asserts on observable behavior end-to-end. Lives in
`/e2e/` (NOT `__tests__/`) and is wired via `IN_PROCESS_E2E_SUITES` in
`scripts/run-all-tests.ts`.

```ts
// e2e/project-export-import.test.ts (excerpt)
import { describe, it, expect, beforeAll } from 'bun:test'
import { createTestApp } from '../apps/api/src/test-helpers'

let app: ReturnType<typeof createTestApp>
beforeAll(() => { app = createTestApp() })

it('exports then re-imports a project with identical schema hash', async () => {
  const exp = await app.request('/projects/p1/export')
  expect(exp.status).toBe(200)
  const tar = await exp.arrayBuffer()
  const imp = await app.request('/projects/import', { method: 'POST', body: tar })
  expect(imp.status).toBe(200)
})
```

Required env (set automatically by the runner):

```
SHOGO_LOCAL_MODE=true
DATABASE_URL=file:./shogo.db
```

---

## File layout

```
packages/<pkg>/
  src/
    foo.ts
    foo.test.ts          ← preferred: co-located
    __tests__/
      bar.test.ts        ← acceptable: only when foo.ts has many test files
  bunfig.toml            ← per-package coverage config (include/exclude paths)
  package.json           ← must export `test` and `test:coverage`
```

`bunfig.toml` for a package typically looks like:

```toml
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coveragePathIgnorePatterns = [
  "src/generated/",
  "**/*.d.ts",
  "**/__fixtures__/",
]
```

---

## Mocking pitfalls (read before your first PR)

1. **`mock.module()` is process-global.** Two test files in the same bun
   process that mock the same module will leak into each other. This is
   why `apps/api` runs process-per-file via `scripts/run-tests-isolated.ts`.
2. **AI_PROXY_URL / SHOGO_LOCAL_MODE / DATABASE_URL** are stripped from
   the test environment by the runner (see `runPackage()` in
   `scripts/run-all-tests.ts`). If a module FATALs at import time
   because of a missing proxy token, that's the cause — mock the
   proxy in your test, don't re-add the env var.
3. **Time / randomness:** use `mock(() => fixedValue)` on `Date.now`
   and `Math.random` at module scope; don't sprinkle `vi.useFakeTimers`-
   style helpers — Bun's `mock` is enough.

---

## Adding a new floor / new package

When a previously-untracked package gets tested for the first time
(Phase 7):

1. Add `test` + `test:coverage` scripts to its `package.json`.
2. Create `bunfig.toml` with the snippet above.
3. Write at least one passing test so `coverage/lcov.info` is generated.
4. Run `bun run test:coverage` and note the measured line percentage.
5. Open a PR that:
   - Adds the package to `BACKEND_PACKAGES` in `scripts/run-all-tests.ts`.
   - Adds a `--per-package-floor` entry at the measured value.
   - Updates `COVERAGE_EXCLUSIONS.md` (move from "Phase 7 onboarding" to "currently tracked").

---

## CI

GitHub Actions runs `bun run test:coverage:check` on every PR. A breach
of any per-package floor or the aggregate threshold **fails the build**.
There is no override flag — if your PR drops coverage, write the missing
test or move the floor down in the same PR (with reviewer approval and
a rationale in the PR body).

---

## Phase-by-phase progress

See the live dashboard in `src/App.tsx` (the canvas) and the plan at
`.shogo/plans/backend-100-coverage-roadmap_2xmw8qd1.plan.md`.
