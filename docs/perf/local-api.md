# Local API profile and workspace-runtime performance

Measurements are from `bun scripts/bench/api-import-cost.ts` on the development
macOS host used for this worktree. RSS is sampled after `/api/health` becomes
ready; it includes Bun/JIT/Prisma/native mappings but no spawned project
runtime.

* Baseline monolithic `server.ts`: 442.7 MiB API RSS.
* Earlier local-composer measurement: 388.0 MiB API RSS.
* Final local composer measurement: 292.4 MiB API RSS.

The local entrypoint imports four lifecycle/composer modules directly; the
route composition lives in `apps/api/src/app/create-local-app.ts` and mounts
44 local-safe route/service modules. Cloud-only route and service modules are
not evaluated by the local entrypoint.

The local desktop bundle guardrail is:

```text
bun run check:api-local-bundle
Local API bundle passed (5731 KiB)
```

The final verification measured a 5,731 KiB bundle and a single API process
with no descendants at the health checkpoint.

The check verifies that the local composer has no direct cloud route/Redis
imports and keeps the API bundle below 18 MiB. The local route-parity test
also covers the desktop profile, agent proxy, PTY terminal, preview,
diagnostics, thumbnails, heartbeat, workspace, and metadata endpoints.
RSS and lifecycle benchmarks should be rerun on Windows 8 GB and Intel macOS
before tightening the budget.

## Many agents

With many agents running on one computer, chats were slow to open and app
navigation slowed down or stopped responding (SHO-277). Two load tests
reproduce it, and both are **opt-in** — too slow for the required
`Lint, Typecheck, Test` lane.

### A1 — the API (bun, real SQLite, real routes)

```text
bun run test:load:local
```

`apps/api/src/__tests__/local-load/many-agents.load.test.ts` builds the real
desktop API (`setupChannelsTestDb` → the shipped migration history on
bun:sqlite, then `createLocalApp`), seeds a database shaped like a machine that
has run many agents (30 projects, 200 sessions, sessions whose assistant turns
are ~350 KB of `dynamic-tool` parts, one 10 MB inline file part), and runs
N concurrent turns through the **real** relay persistence path
(`trackUsageFromStream`, fed by `app/api/src/__tests__/helpers/fake-runtime-stream.ts`).
While they stream it probes the routes a person waits on — first page of a
chat's messages, the chat-sessions list, the projects list, `active-chats`,
`agent-tasks` and the one-row message tail — and records the event loop's delay
histogram and how many snapshot writes each turn performs.

Matrix: N = 0, 4, 8, 16. Results: `test-results/local-load/many-agents.json`.
Scale knobs: `SHOGO_LOAD_LEVELS`, `SHOGO_LOAD_TOOL_COUNT`, `SHOGO_LOAD_TURN_MS`,
`SHOGO_LOAD_PROJECTS`, `SHOGO_LOAD_SESSIONS`, `SHOGO_LOAD_HEAVY_SESSIONS`,
`SHOGO_LOAD_HEAVY_MESSAGE_BYTES`.

The sweep is gated on `SHOGO_LOAD_TESTS=1` (the `test:load:local` script sets
it), so `bun test` in `apps/api` skips it. Its budgets are wall-clock budgets
for a real machine: on a 2-vCPU CI runner sixteen concurrent turns saturate the
CPU and the same code reports 180–285 ms of event-loop p99 regardless of what
the relay does. What runs everywhere is `snapshot-write-budget.test.ts` — the
deterministic half (writes and bytes per turn, and the persisted turn matching
the streamed one byte for byte).

Budgets (the test fails above them, at N=16):

| Metric | Budget |
| --- | --- |
| Event loop delay p99 | ≤ 50 ms |
| `GET` a chat's messages p95 | ≤ 300 ms |
| Every other list/poll route p95 | ≤ 150 ms |
| Any route vs its own N=0 p95 | ≤ 2.5× |
| Snapshot writes per turn | ≤ 1 per second of stream + 2 |

Before the fix, on the same machine: **111** snapshot writes per turn, 70 MB of
serialised parts per turn, event loop p99 80 ms. After: 4 writes, 3.3 MB,
p99 30 ms.

### A2 — the renderer (Playwright, opt-in)

```text
bun run test:e2e:load
```

Starts N tool-heavy background turns across four projects plus three restored
chat tabs, then performs ten navigations (switch chat, open another project,
open a team channel, go home and come back). Per navigation it records
time-to-composer, long tasks, dropped frames and the longest
`requestStart → responseStart` gap — a navigation queued behind a streaming SSE
shows up there, which is how the HTTP/1.1 socket question gets settled rather
than assumed. Report: `test-results/streaming-e2e/nav-under-load-n<N>.json`.

Opt-in, advisory, and calibrated on the machine that recorded the baseline;
override its budgets with `SHOGO_E2E_LOAD_*` rather than loosening them.
