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

Running this on the real host found eight defects that neither the unit tests nor
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
7. **"RAM physical" was every Firecracker process on the host**, tenants
   included, so the per-VM RSS and the whole RAM-ceiling table were derived from
   other projects' memory: a step with 160 GiB committed by the soak reported
   258 GiB "physical". The column is now the delta over the FC RSS measured
   before the soak's first VM.
8. **The burst ran on unprimed guests.** It took the first N VMs regardless of
   role, and 83% of the mix is idle — a guest that was never primed has no
   template, so its turn died at the first step (`cd: /app/workspace/... no such
   file`) and recorded nothing. 15 of 20 burst turns on 2026-11-23 were empty;
   the burst now targets primed agent VMs only.
9. **The app role was never seeded either.** Only `role === 'agent'` guests got
   the template, so `startAppRoles` started `app-server.ts` in a directory that
   did not exist (`exit 7`, `cd: /app/workspace/density/tpl: No such file or
   directory`) and the app-response column of every report was empty — in all
   three runs, not just the burst. `planSeeding` now decides per guest: agent
   guests get the full prime (template + warm cache + git), app guests get the
   template files alone, idle guests stay cold.

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

### Cold-boot blocker: resolved (SHO-549)

Part of that `FC API socket never appeared` window was not density: from 12:58Z
the host's golden rootfs had no `/usr/local/bin/fc-init`, so every cold boot
panicked before userspace, and the boot failures made the host look saturated.
`runtime.ext4` was rebuilt from the same `718a651` image with the fixed
`build-runtime-rootfs.sh`; a `POST /assign` cold boot then reached healthy in
2.3 s, with `[fc-init] workspace drive /dev/vdb mounted at /data` in the guest
serial log. The build, the agent's build step and activation now all refuse an
image without its guest init (`docs/runbooks/metal-fleet.md` → "A staged image
without its guest init is never activated"), so a rebuild cannot silently
reintroduce it. The host still needs a cordon + drain before the ladder can
measure density rather than its tenants.

## Recommendation from the completed run

**Hold prod at `METAL_MAX_VMS_PER_HOST=80`; do not raise it to 120.** Two runs
completed on `latitude-dal-1`: `density-2026-11-23T0707` (67 tenant projects
resident) and `density-2026-11-23T1106` (120 resident). The binding constraints
are memory pressure and restore latency, and they land at 80–100 VMs.

From `density-2026-11-23T1106/report.md` (2 vCPU / 4096 MiB guests, EPYC 7443P,
24 threads, 503 GiB):

| signal | limit | 40 | 60 | 80 | 100 | 120 | 160 |
|---|---|---|---|---|---|---|---|
| CPU PSI `some avg60` | 25% | 0.3 | 0.3 | 0.3 | 0.3 | 1.1 | 3.3 |
| `MemAvailable` | ≥ 10% | 44.0 | 34.3 | 25.2 | 26.3 | 34.9 | 14.2 |
| swap-in pages/s | < 100 | 2.1 | 5.8 | 8.3 | 33.7 | 39.9 | **136.2** |
| memory PSI `full avg60` | < 1% | 0.0 | 0.0 | 0.0 | **1.38** | **1.76** | **4.92** |
| resume p95 | < 2000 ms | 651 | 918 | 1239 | 604 | 634 | **3954** |
| OOM kills | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| turn p95 `install` vs baseline | ≤ 1.5× | **2.78×** | **2.79×** | **1.93×** | **2.95×** | **1.72×** | **3.73×** |

**RAM knee = 80.** memory PSI `full avg60` is 0.0% through 80 and crosses the 1%
limit at 100; swap-in climbs from 8 to 34 pages/s between 80 and 100 and reaches
136 at 160; `MemAvailable` falls to 14.2% at 160. There were no OOM kills at any
step, so the RAM knee arrives as pressure, not as a crash.

**The CPU knee is 0, and that is a statement about the bound, not the host.** No
step met the 1.5× turn-p95 bound — including N=40, at 3.33:1 vCPU
oversubscription with CPU PSI **0.3%** and 44% of RAM free. `install` p95 goes
2.78× → 2.79× → 1.93× → 2.95× → 1.72× → 3.73× as density rises monotonically:
latency *improves* from 60 to 80 and from 100 to 120. A fleet-wide p95 over N
guests is not the same statistic as the p95 of one warm guest — more guests means
more unlucky samples, and each step's p95 is set by a handful of pathological
turns. So `min(CPU knee, RAM knee)` is 0 and the report says **no
recommendation**, which is honest but not actionable on its own; the number above
comes from the RAM knee and the restore SLO.

**No bound was changed to make this pass.** Moving a limit because a run
disagrees with it is how this number becomes fiction. The open follow-up, for the
planner to decide:

- compare fleet **p50** against baseline p50 (both "the typical turn"), keeping
  the absolute p95 as its own SLO, or
- re-measure the baseline VM **during** each step so both sides of the ratio see
  the same interference, or
- set the ratio limit from the bound's own measured noise floor instead of 1.5×.

**CPU is not what runs out first.** At 160 VMs (13.3:1) CPU PSI is 3.3% against a
25% limit and API p95 stays at 6–10 ms through 120. What fails is memory
pressure, and then restore latency.

**The burst at 80 is measured: 13 simultaneous turns, and turn latency does not
degrade.** Run 1106's burst turns were driven at idle guests that had never run a
turn, so 15 of its 20 failed to start at all; the two figures this section used to
carry (`install` 2360 ms, `build` 3613 ms) were the max of the 5 that did run, and
are no longer reported as a burst result. The re-run on the fixed harness
(`density-2026-11-26T0054`, `--steps 80 --burst`) primed the guests first and
fired **13 turns — every agent guest at the prod mix — at once inside a 60 s
window, and all 13 completed**:

| burst @ N=80 | p95 | vs baseline |
|---|---|---|
| cpu | 3047.8 ms | 1.00× |
| install | 246.8 ms | **0.58×** |
| build | 1156.3 ms | **0.58×** |
| CPU PSI `some avg60` | 0.46% | limit 25% |
| MemAvailable | 41.6% | floor 10% |
| OOM kills | 0 | — |

Two things to read carefully. A 25%-of-N burst (20 concurrent) is **not
expressible at the prod mix** at N=80: 16% of 80 is 13 agent guests, so 13 is the
most turns the mix can start at once, and the run says so (`turns_started: 13` in
`burst.csv`). And the row still prints `pass = FAIL` even though every turn
latency bound passed: `pass` is `cpuPass && ramPass`, and the **RAM** gate carried
the step window's memory PSI (1.09% against a 1% limit) into the burst row's
window. The burst failed on 0.09 points of memory PSI, not on turn latency — which
is the opposite of what the withdrawn claim said. A burst that starts more turns
than there are agent guests needs a higher agent share in `--mix`; that is worth a
follow-up if the 25% case matters.

The single-step ladder this run used also prints **CPU knee 0 · RAM knee 0 ·
recommend none**, and that is a property of the print, not a new capacity result:
one step that misses any bound leaves no passing step, so `computeKnees` has
nothing to recommend. The steady-state number in this section still comes from the
full 40→160 ladder.

**`METAL_MEM_MIB` should not change** on this host: the RAM knee arrives as
pressure at 4 GiB guests (memory PSI crossing 1% between 80 and 100), with
`MemAvailable` still at 14.2% of 503 GiB when the ladder ended at 160 — so host
RAM is not what runs out, the tail is. A per-size ceiling cannot be quoted until
a run measures RSS per soak VM (see below); the ceilings are not what set the
number above.

**Measured host RSS is attributable only to the soak.** Run 1106 recorded every
Firecracker process on the host in its RAM column, so its 258 941 MiB over 40 soak
VMs was 6473 MiB per VM against 4096 MiB guests — it counted the 120 resident
tenants too, and the 111-VM-per-size table that came from it was that number
divided by a configured size. `steps.csv` now carries `ram_physical_basis`, the
report labels an unattributed column as host-wide instead of soak RAM, and per-VM
RSS and the per-size ceiling are derived only from `soak-delta` steps. Run 1106
predates the column, so its artifact says "not measured" rather than repeating the
old figure.

Follow-ups worth their own cards: swap pressure above 100 VMs (swappiness, balloon
reclaim of idle guests, free-page reporting, KSM), and the turn-latency bound
above.

The run itself — report and per-step table, as recorded and then re-derived by
the rules in this branch — is committed at
[`runs/metal-density-latitude-dal-1-2026-11-23T1106.md`](./runs/metal-density-latitude-dal-1-2026-11-23T1106.md)
(and `.steps.csv`). `apps/metal-agent/load/results/` is gitignored, so the raw
`samples.csv` / `turns.csv` were kept on the host at
`/root/metal-agent/load/results/density-2026-11-23T1106/`; staging self-updated
its runtime image at 12:58Z and the staging harness staging step re-creates
`/root/metal-agent`, so the host copy is gone. A working copy of the four CSVs is
in the project's `.tmp-results/` on the machine that ran the soak, and the
committed `.steps.csv` is the part the numbers above come from.

The burst re-run is committed the same way, at
[`runs/metal-density-burst-latitude-dal-1-2026-11-26T0054.md`](./runs/metal-density-burst-latitude-dal-1-2026-11-26T0054.md)
(criteria 5's burst), with `.burst.csv`, `.steps.csv` and `.env.json` beside it.
That run took 00:54–01:15Z on a host carrying **36 metered VMs (449 GiB of 503
free)**: the serialized ramp (`--ramp-concurrency 1`, because the host still runs
the pre-SHO-545 boot path) reached N=80 with **0 failed assigns**, held 5 min, and
tore down 83 soak VMs to 0 with the env restored. Its `turns.csv` has 46 rows —
33 steady agent turns and 13 burst turns — and **all 46 succeeded**.

**The 2026-11-23T13:15Z burst blocker — resolved (SHO-549, and the burst is
measured above).** Staging release `718a651`
rebuilt the golden rootfs from
`shogo-runtime:staging-multiarch-718a651fc7b4352876b4b13510138c63377746b9` and
activated it at 12:58Z. That image has no `/usr/local/bin/fc-init`, which is what
`METAL_GUEST_INIT` points at, so every cold boot now dies before userspace:

```
[    0.438396] Kernel panic - not syncing: Requested init /usr/local/bin/fc-init failed (error -2).
```

Mounting the image confirms it: `/opt/fc-spike/img/runtime.ext4` has no
`fc-init`, while `img/docker-runtime.ext4` does. Warm boots from the pre-update
snapshots keep working, which is why existing workspace traffic survives; new
assigns fail host-wide (`VM … exited before healthy` / `FC API socket never
appeared` in the metal-agent journal). The soak's baseline VM was one of them, so
the run stops before its first step and restores the host. Nothing in the harness
can work around a missing guest init, and the run must not be retried against a
different image than the one measured — those numbers would not be comparable to
the ladder above.

## Related

- [`docs/runbooks/metal-fleet.md`](./metal-fleet.md) — the fleet, cordon and
  release runbooks.
- [`apps/metal-agent/load/README.md`](../../apps/metal-agent/load/README.md) —
  the other load harnesses (wake path, NVMe cache).
- [`apps/metal-agent/src/e2e-load.ts`](../../apps/metal-agent/src/e2e-load.ts) —
  the concurrent-restore SLO this runbook reuses (resume p95 < 2 s).
