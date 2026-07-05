<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Cold-start baseline (Phase 0)

This directory holds the "before-numbers" baseline for the Cloud Firecracker
snapshots work. Every later phase is gated against the percentiles captured
here, so we can prove the microVM snapshot path is actually faster (and no worse
on correctness) than today's Knative warm-pool + app-warmup path.

## Why this exists

Cold start today is dominated by **app warmup, not container boot**: deps
extract, `bun install`, S3/git hydration, Prisma, Vite build, and the agent
gateway (skills/LSP/MCP/session, the long pole at "dist at T+12s vs gateway at
T+88s"). The pilot replaces the runtime substrate with Kata + Firecracker
microVMs on a bare-metal OKE pool (`BM.Standard.E2.64`) so a warmed project can
be **suspended to a snapshot and resumed by memory-mapping** instead of
re-running warmup.

## Harness

[`scripts/coldstart-benchmark.ts`](../scripts/coldstart-benchmark.ts) aggregates
the per-phase timing the runtime already emits via `logTiming`
(`packages/shared-runtime/src/server-framework.ts`) across many assigned pods and
reports P50/P95/P99 per phase, bucketed by tech stack. It is the aggregating
sibling of [`scripts/harvest-coldstart-timing.sh`](../scripts/harvest-coldstart-timing.sh)
(single pod). No redeploy is needed — it only reads existing logs.

```bash
# Auto-discover recently assigned runtime pods on staging.
KUBECONTEXT=oke-staging WORKSPACES_NS=shogo-staging-workspaces \
  bun run scripts/coldstart-benchmark.ts --limit 40 --out benchmarks

# Specific pods.
bun run scripts/coldstart-benchmark.ts --pods pod-a,pod-b,pod-c
```

Output (per run, timestamped):

- `coldstart-baseline-<ISO>.json` — machine-readable percentiles + raw per-pod totals
- `coldstart-baseline-<ISO>.md` — human-readable report

### Phases measured (ms from entrypoint)

| Boundary marker (log) | Meaning |
| --- | --- |
| `Initializing essentials...` | app boot handed to warmup |
| `Workspace files ready` | workspace seeded/symlinked |
| `S3 sync initialized` | source hydrate done |
| `Workspace deps ready` / `Background deps restore ready` | node_modules ready |
| `Essentials complete` | pre-gateway warmup done |
| `Starting agent gateway...` | gateway boot begins |
| `Agent gateway started` | **headline: end-to-end to serving** |

Tech stack is read inline from `Tech stack seeded:` / `Tech stack setup
complete:` log lines, so no DB join is required.

## SLO gates (from the plan)

The snapshot path must beat these, measured against the committed baseline:

1. **Resume-from-snapshot P95 < 2s** to `ready:true` (restore + net + readiness + workspace delta).
2. Free-tier first-open (cold, no snapshot yet) **no worse than today**; second+ open near-instant.
3. **No correctness regressions**: chat/SSE/LSP/preview work after restore (e2e).
4. BM-node density and $/project **competitive** with the Knative warm pool it replaces.

## Workflow

1. Run the harness against staging with a representative sample (`--limit 40+`),
   spanning the common stacks (react-app, expo, etc.).
2. Commit the resulting `coldstart-baseline-<ISO>.{json,md}` as the frozen
   before-numbers.
3. Re-run the same harness (plus the Phase 1 restore-latency benchmark) after
   the microVM path is live and compare against the frozen baseline in the
   Phase 5 gate.

## Phase 5 gate results (2026-07-05, live Latitude `c3.large.x86`, ASH)

Measured on the real host (24c/48t, 256 GB, 2×1.9 TB NVMe, $496/mo). Harnesses:
[`apps/metal-agent/src/e2e-load.ts`](../apps/metal-agent/src/e2e-load.ts) via
[`scripts/metal-agent/run-load-e2e.sh`](../scripts/metal-agent/run-load-e2e.sh) (concurrent-restore
sweep) and the Phase 2b real-image e2e (single-restore + cold boot).

### Concurrent-restore sweep — 24 projects, wake from cold snapshot

Full data: `metal-e2e-load-results-2026-07-05T105851753Z.json`.

| In-flight | ready p50 | ready p95 | ready p99 | throughput | cold-miss | continuity fail |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 38.3 ms | 43.2 ms | 44.7 ms | 26/s | 0 | 0 |
| 4 | 115 ms | 142.6 ms | 162.6 ms | 31/s | 0 | 0 |
| 8 | 165.5 ms | 228.9 ms | 252.1 ms | 34/s | 0 | 0 |
| 16 | 235 ms | 470.5 ms | 475.6 ms | 32/s | 0 | 0 |
| 24 | 361.9 ms | 645.3 ms | 679.5 ms | 35/s | 0 | 0 |

Per-restore continuity (same in-guest boot-id = live RAM never rebooted, counter advanced, project
survived) held for all 120 restores. Host `MemAvailable` returned to ~251 GB after every suspend —
suspended VMs cost disk, not RAM.

### SLO gate vs Phase 0 baseline

| SLO gate | Target | Measured | Verdict |
| --- | --- | --- | --- |
| Resume-from-snapshot P95 | < 2 s | 645 ms @ 24-wide · 71 ms single | **PASS** (3.1×) |
| Cold first-open no worse than today | ≤ ~40–60 s | 12.2 s microVM boot | **PASS** |
| No correctness regression (chat/SSE/LSP/preview) | e2e | needs real-runtime gateway over live mesh | **PENDING** |
| BM density & $/project competitive | competitive | ~820 projects/host, ~$0.60/project-mo | **PASS** |

Density/$ model (tunable): [`metal-firecracker-density-cost.canvas.tsx`](../../.cursor/projects/Users-russell-git-shogo-ai/canvases/metal-firecracker-density-cost.canvas.tsx).

### Rollout ladder (Phase 4 per-project flag; Knative fallback on any miss)

1. **off** — `SHOGO_METAL_ENABLED` unset (default).
2. **canary** — `METAL_PROJECT_ALLOWLIST=<ids>`.
3. **free/micro** — `METAL_ROLLOUT_PERCENT` 5 → 25 (stable per-project hash bucket).
4. **all US** — `METAL_ROLLOUT_PERCENT=100`.
5. **multi-region** — add hosts; each registers over the mesh; existing regions stay on Knative
   until demand justifies a host.

Before flipping stage 1 in prod: live OCI↔Latitude mesh peering, real-runtime quiesce/rehydrate
hooks, and the post-restore correctness e2e (the one open gate).

### Locust over-the-network wake results (2026-07-05, ASH host, real 2 GB runtime)

Where the sweep above drives the pool in-process, [`../apps/metal-agent/load/locustfile.py`](../apps/metal-agent/load/locustfile.py)
(`MetalWakeUser`) drives the node-agent HTTP API over the public network — the same
contract the control plane's `metal` pod-mode uses — so it includes RTT + HTTP + contention.
Client on a laptop → `160.202.128.229:9900` (transcontinental).

Production-like run (heavy ops serialized like the idle reaper, `METAL_HEAVY_CONCURRENCY=1`;
5 users, 3 min): CSV in [`../apps/metal-agent/load/results/`](../apps/metal-agent/load/results/).

| Metric | p50 | p90 | p95 | Fails |
| --- | --- | --- | --- | --- |
| Wake — host-reported restore→ready (`wake_ready_ms`) | 46 ms | 72 ms | 99 ms | 0/50 |
| Wake — end-to-end incl. RTT (`assign(wake)`) | 150 ms | 270 ms | (tail*) | 0/50 |
| Cold first-open (`assign(cold)`) | 10.0 s | — | — | 0/5 |
| Suspend/snapshot (`suspend`) | 2.3 s | 2.7 s | 5.3 s | 1/54 |

Findings:
- **Wake path holds up over the real network**: host-side p95 = 99 ms, matching the in-process
  71 ms; ~150 ms p50 end-to-end across the continent — well under the 2 s SLO.
- **Concurrent *heavy* ops (cold boot + snapshot) of the real 2 GB runtime are fragile**: an
  unthrottled stampede (12 simultaneous cold boots) produced `FC API socket never appeared`
  boot timeouts and ~17% `snapshot` 500s; even serialized, `suspend` still 500s ~2–4% under
  concurrent NVMe pressure (createSnapshot writing a 2 GB mem file while loadSnapshots mmap-read
  others). A failed suspend cascades into a ~10 s tail on the *next* wake for that project.
  - Production doesn't stampede cold boots (warm pool) or snapshots (idle reaper is sequential),
    so this is not on the hot path — but before scale-up the node-agent should add a **snapshot
    concurrency guard + retry** and a longer FC boot-socket timeout under load. Tracked as
    substrate hardening, not a rollout blocker.
- **True "metal in staging" end-to-end is still gated on the mesh**: the node-agent registers
  with staging over the public internet, but assigned guests have private TAP IPs, so the OCI
  control plane can't route real project traffic to a guest until the WireGuard mesh (or public
  per-VM DNAT) is up. Until then, `MetalWakeUser` against the node-agent is the faithful
  wake-path load test; the staging apps/api can only be load-tested at the metal *registry*
  endpoints (`StagingControlPlaneUser`).
