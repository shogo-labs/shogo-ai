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
