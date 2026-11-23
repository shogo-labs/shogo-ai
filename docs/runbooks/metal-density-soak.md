<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Metal density soak — how many VMs one host carries

`METAL_MAX_VMS_PER_HOST` defaults to **80** on a guess: "an s3-large-x86
comfortably runs ~80 ~1 GB microVMs". Prod VMs are 2 vCPU / 2–4 GiB, so 80 VMs
is ~3.3:1 vCPU oversubscription on 48 threads and up to 320 GiB of guest RAM —
and prod hosts' `/etc/metal-agent.env` were raised to **120** on 2026-10-31
(PR #1853). Nothing had measured it under real load.

This runbook is the measurement. It steps a staging host through 40 → 160 VMs on
the prod mix, holds at each step while agent-role VMs loop real turns, runs a
burst, and reports a **CPU knee** and a **RAM knee** separately, then recommends
a `METAL_MAX_VMS_PER_HOST` from the data.

> **Changing prod config is a separate decision.** This runbook produces the
> number; it does not change `config.ts`, the controller default, or any host's
> env. That is Russell's follow-up.

## What it measures, and why from the host

| signal | source | why |
|---|---|---|
| turn-step latency | guest PTY, per step | the thing users feel |
| CPU contention | `/proc/<pid>/task/<tid>/schedstat` `run_delay` per Firecracker vCPU thread | the host-side "steal": in-guest `/proc/stat` steal is only a secondary column because KVM steal-time is not always exposed |
| CPU pressure | `/proc/pressure/cpu` `some avg60` | whole-host contention, including the agent itself |
| RAM headroom | `MemAvailable` / `MemTotal` | the real density signal, not the nominal per-VM figure |
| swap | `/proc/vmstat` `pswpin` as a rate | sustained swap-in is the RAM knee arriving |
| memory pressure | `/proc/pressure/memory` `full avg60` | all tasks stalled on reclaim |
| OOM | kernel ring buffer since start | a hard fail, never a warning |
| per-VM host RAM | `/proc/<pid>/status` `VmRSS` for every `firecracker` process | what idle resident guests actually hold |
| balloon | `fc-api.ts balloonStats` | reported only: today the balloon inflates right before a snapshot and free-page reporting is off, so this says what a reclaim of idle guests *would* free |
| control plane | `/healthz`, `/vms`, `/assign`, `/suspend`→`/assign` | API and resume latency under load |

## The mix

Prod shadow data says a host's resident VMs are overwhelmingly idle. The default
mix is **16% agent / 1% app / 83% idle**. That shape is the point: the RAM knee
is set by the idle tail, not by the turns.

Refresh the ratios from `VmUsageHour` (last 7 days, per host):

```sql
-- Role mix: share of resident VM-seconds spent in a turn, serving app traffic,
-- or idle.
SELECT
  host_id,
  round(100.0 * sum(agent_seconds) / sum(agent_seconds + app_seconds + idle_seconds), 1) AS agent_pct,
  round(100.0 * sum(app_seconds)   / sum(agent_seconds + app_seconds + idle_seconds), 1) AS app_pct,
  round(100.0 * sum(idle_seconds)  / sum(agent_seconds + app_seconds + idle_seconds), 1) AS idle_pct
FROM vm_usage_hours
WHERE hour >= now() - interval '7 days'
GROUP BY host_id
ORDER BY host_id;
```

```sql
-- VMs concurrently in a turn at p95 — this sets the steady agent fraction.
-- Bucket by hour, count the VMs with any agent time in that hour, then take p95.
WITH per_hour AS (
  SELECT host_id, hour, count(*) FILTER (WHERE agent_seconds > 0) AS agent_vms
  FROM vm_usage_hours
  WHERE hour >= now() - interval '7 days'
  GROUP BY host_id, hour
)
SELECT host_id,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY agent_vms) AS p95_agent_vms,
       max(agent_vms) AS max_agent_vms
FROM per_hour
GROUP BY host_id;
```

Pass the result as `--mix agent=0.16,app=0.01,idle=0.83` (fractions or percent
both work).

## Safety — read this before running

The soak deliberately drives a host to its knees. It is **staging only**, and the
runner enforces that:

1. **Staging guard.** The runner refuses to start unless (a) `--host` is in
   `DENSITY_SOAK_STAGING_HOSTS` (default `latitude-dal-1`), (b) the host's
   `METAL_CONTROL_PLANE_URL` is a staging control plane, and (c) that control
   plane's `/api/internal/metal/fleet` lists the host as live. (c) is the one
   that matters: `latitude-dal-1` is the host id in **both** the staging and the
   production baseline (`apps/api/src/config/metal-fleet.ts`), so the name alone
   proves nothing — only the registry it heartbeats to does.
2. **Cordon.** The host is cordoned through the existing admin cordon
   (`POST /api/admin/metal/hosts/:hostId/cordon`) so no real staging project
   lands on it mid-soak. Needs a super-admin session in
   `DENSITY_SOAK_ADMIN_TOKEN`. If you cordon by hand instead, pass
   `--assume-cordoned`.
3. **Resident projects are recorded, never touched.** Preflight lists what is
   already assigned/suspended and the runner only ever acts on
   `soak-<runId>-*` ids.
4. **Env swap.** `/etc/metal-agent.env` is recorded byte-for-byte, then
   `METAL_MAX_VMS_PER_HOST` is raised above the top step and
   `METAL_IDLE_SUSPEND_MS=0` so the reaper and the `idle-policy.ts` host guard
   cannot suspend an idle soak VM. The agent is restarted to pick it up (it
   adopts live VMs on restart, so resident projects survive). A `/touch`
   keep-alive loop is a second line of defence.
5. **Abort guard.** The run stops early if `MemAvailable` falls below 5% or any
   OOM kill appears, and still writes the report with the reason.
6. **Teardown in a `trap`/`finally`, including SIGINT.** Every `soak-` VM is
   suspended then destroyed, the count is verified to be 0, the env file is
   restored byte-for-byte, the agent is restarted, and the host is uncordoned.

## Running it

```bash
# From the repo root, with SSH to the staging host:
SSH_TARGET=root@<staging-host> \
HOST_ID=latitude-dal-1 \
ADMIN_TOKEN=<super-admin session> \
BURST=1 \
  bash scripts/metal-agent/run-density-soak.sh
```

The script stages `apps/metal-agent/{src,load}` to `~/metal-agent` on the host,
runs `load/density-soak.ts` as root, and copies
`load/results/density-<ts>/` back.

Flags (all optional):

| flag | default | meaning |
|---|---|---|
| `--steps` | `40,60,80,100,120,160` | VM counts to hold at |
| `--hold` / `--hold-ms` | `10m` | hold per step |
| `--ramp-concurrency` | `8` | parallel assigns while growing |
| `--mix` | `agent=0.16,app=0.01,idle=0.83` | role mix |
| `--burst` | off | run the burst phase |
| `--burst-window` | `60s` | window to start the burst turns in |
| `--burst-fraction` | `0.25` | share of N started at once |
| `--mem-mib` / `--vcpus` | host's `METAL_MEM_MIB` / `METAL_VCPUS` | VM sizing |
| `--assume-cordoned` | off | you cordoned by hand |
| `--no-restart-agent` | off | do not restart the agent for the env swap |
| `--no-probe-resume` | off | skip the resume-latency probes |
| `--dry-run` | off | preflight only, no cordon/env swap |

Budget about **2 h** of host time: 6 steps × 10 min hold + ramps + burst +
baseline + teardown.

## Reading the report

`load/results/density-<ts>/` holds:

- `report.md` — the table, the burst rows, both knees, the recommendation.
- `steps.csv` — one row per step: N, vCPU oversubscription, RAM committed vs
  physical, p50/p95 per turn step, `run_delay`, PSI, `MemAvailable`, swap-in/s,
  OOM, resume p95, API p95, and the CPU/RAM verdict.
- `samples.csv` — the raw 5 s host series.
- `turns.csv` — every turn, per VM, per step.
- `env.json` — host model, kernel, Firecracker version, sizing env, git sha.

**The knees.** The CPU knee is the highest N where turn-step p95 stayed within
1.5× the N=1 baseline, CPU PSI `some avg60` stayed under 25%, and resume p95 held
the 2 s SLO. The RAM knee is the highest N with zero OOM kills, no sustained
swap-in (≥ 100 pages/s), memory PSI `full avg60` under 1%, and `MemAvailable`
above 10%.

The knee is the **highest N that passed**, not the last unbroken pass from the
smallest N. The first step of a ladder is cold — fresh image, cold page cache,
turn p95 mixing warm-up with steady state — and on the real host it missed a turn
bound that the same bounds then passed at 60 and 80 VMs. Under a
first-failure-closes-the-gate rule that one sample reported a knee of 0. Each step
is a held 10-minute measurement, so a higher pass is evidence; a lower miss is
listed in the report under **Below the knee** rather than extrapolated over it.

The baseline those ratios divide by is the **p95** of 20 lone-VM turns — the same
statistic the steps are compared on. It has to be: with a p50 baseline a host
with no contention fails on its own tail (see defect 5 below). The baseline turns
are written to `turns.csv` as `n=1` rows, so the denominator is auditable.

**Nominal N is not assigned N.** The ramp runs one VM at a time and the hold
starts when the step does, so a step reaches ~80–93% of its nominal N (N=160
assigned 132 over a 10 min hold). Read the `assigned` count in the log and the
RAM-committed column, and treat the recommendation as a nominal cap.

**The recommendation** is `min(CPU knee, RAM knee)`, with the burst result shown
next to it. The report also gives the RAM ceiling at 2 GiB and 4 GiB VMs from the
measured per-VM RSS, because RAM is per-VM and the idle tail dominates.

## What the first live run changed (2026-11-23, `latitude-dal-1`)

Running this on the real host found six defects that neither the unit tests nor
the fake node-agent could, all now fixed on `sho-445-metal-density-soak`:

1. **A guest is not reachable at its `/assign` URL from the host itself.**
   `/assign` returns `METAL_PUBLIC_HOST:<dnat>`, and that DNAT rule lives in
   PREROUTING — a connection the host originates to its own public address never
   matches it and times out. `resolveGuestUrl()` maps the port back through
   `iptables -t nat -S` to the guest's private address, where the runtime answers
   200.
2. **`assign` returns before the in-guest runtime serves `/terminal/sessions`.**
   The first PTY lost the race. `waitForGuest()` polls until it answers (2 min
   ceiling).
3. **A heredoc cannot go through `guestExec`.** It wraps the command as
   `stty -echo; { <cmd> ; } 2>&1; echo <marker>`, so the closing `; }` lands on
   the heredoc's terminator line: the shell never sees a bare marker and reads
   the heredoc until the command times out. The template is now written one file
   per command with `printf %s <b64> | base64 -d > file`.
4. **The staging guard rejected the real staging control plane.** The host
   heartbeats to `api.141.148.27.1.sslip.io` (the staging kourier LB —
   `terraform/environments/staging/main.tf:517`), which was missing from the
   allow-list, and a bare shell does not inherit the host's
   `NODE_TLS_REJECT_UNAUTHORIZED=0`. `run-density-soak.sh` now sources
   `/etc/metal-agent.env` before it runs the runner.
5. **The baseline was measured as p50 and compared as p95.** The first run that
   completed every step (`density-2026-11-23T0707`) reported `CPU knee 0 · RAM
   knee 100 · recommend METAL_MAX_VMS_PER_HOST=0` for a host that had just
   carried 160 VMs. It failed N=40 with `install p95 2.68x baseline` at **CPU PSI
   0.3%** — the step's tail against the baseline's median of the same
   distribution. `computeKnees` closes a gate at the first failure, so that one
   noise sample became a CPU knee of 0 and a recommendation to run nothing.
   `baselineFromTurns()` now uses p95, and a knee of 0 renders as "no
   recommendation / failed measurement" instead of a capacity of zero.
6. **The per-size RAM table priced every size at the measured RSS.** It printed
   `218` for both 2048 MiB and 4096 MiB guests because the observed RSS (2124
   MiB) replaced the configured size in the calculation. Each row now budgets
   `max(configured size, measured RSS)`.

Two operational notes from that attempt:

- **Launch the run under `systemd-run`, not a bare SSH command.** If the SSH
  session dies (or the caller caps long commands) the runner is SIGKILLed, no
  trap fires, and the host is left with `METAL_MAX_VMS_PER_HOST` raised,
  idle-suspend disabled and `soak-` VMs alive — that happened here twice.
  `systemd-run --unit=density-soak --property=Type=exec ...` survives it.
  **After any interrupted run, restore before starting the next one:** remove
  `METAL_MAX_VMS_PER_HOST`, set `METAL_IDLE_SUSPEND_MS=1800000`, destroy every
  `soak-` VM, restart `metal-agent`.
- **The host was not empty, and could not be measured as empty.** On 2026-11-23
  `latitude-dal-1` carried **308 resident staging projects** (86 running, ~202
  suspended, 93–105 Firecracker processes, 295 taps), reported `utilPct 108`
  against the 80 default, and was **not cordoned**. New guest boots began failing
  with `FC API socket never appeared`, so the run aborted at baseline without
  starting a single soak VM. That is a real density result in itself: at 2 vCPU /
  4 GiB this host saturates well before the 160 step — and 160 × 4 GiB = 640 GiB
  cannot fit in 503 GiB of RAM whatever else is resident. The step ladder needs a
  **cordoned, drained** host (and the super-admin session to cordon it) to
  measure the host rather than the tenants already on it.

## Recommendation from the completed run

> **Not yet filled in.** The harness, its unit tests and this runbook are
> complete, but the live run needs SSH to the staging host (and a super-admin
> token for the cordon), which the developer sandbox does not have. The run is
> the one remaining step; see the card thread for exactly what is needed. Do not
> guess a number here — the whole point of the card is that the current 80/120
> are guesses.

When the run lands, replace this section with:

- the recommended `METAL_MAX_VMS_PER_HOST` and which knee set it,
- whether `METAL_MEM_MIB` should change,
- the burst result at the recommended N,
- RAM-overcommit settings worth a follow-up (swappiness, balloon reclaim of idle
  guests / free-page reporting, KSM).

## Related

- [`docs/runbooks/metal-fleet.md`](./metal-fleet.md) — the fleet, cordon and
  release runbooks.
- [`apps/metal-agent/load/README.md`](../../apps/metal-agent/load/README.md) —
  the other load harnesses (wake path, NVMe cache).
- [`apps/metal-agent/src/e2e-load.ts`](../../apps/metal-agent/src/e2e-load.ts) —
  the concurrent-restore SLO this runbook reuses (resume p95 < 2 s).
