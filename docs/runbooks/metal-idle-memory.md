<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Cheaper idle metal VMs in host RAM

How to cut the host RAM an **idle** metal VM costs — with the balloon, free page
reporting and (optionally) host KSM — how to measure it on staging, and what has
to be true before it goes anywhere near production.

Prod metal VMs are 2 vCPU / 4 GiB and sit at **~2.4 GiB resident on the host**
(dal-1: 56 VMs = 139 GiB). The fleet is ~96% idle by VM-hours and CPU is nearly
unused (p95 ≈ 6 VMs mid-turn per host), so **RAM per idle VM is the ceiling on
density**, not CPU. Until this card the balloon was only ever inflated right
before a snapshot: a VM that stayed loaded and idle — in the relaxed window, or
always-on and never suspended at all — kept its whole footprint, and KSM was off
on all five prod hosts (`/sys/kernel/mm/ksm/run = 0`).

> **Nothing here changes prod on its own.** Every new flag defaults off, and this
> runbook ends with the numbers the prod decision needs, not a prod change.

## What ships (SHO-534)

| piece | where | default |
|---|---|---|
| Idle reclaim: inflate the balloon on a VM nobody is using | `pool.reclaimIdleVms()` (reaper tick, before `reapIdle`) → `FirecrackerVMManager.reclaimIdle()` | `METAL_IDLE_RECLAIM=0` |
| Idle window + hysteresis | `METAL_IDLE_RECLAIM_MS` (5 min) — also how long after a deflate before the VM can be reclaimed again | `300000` |
| Guest headroom left while idle | `METAL_IDLE_RECLAIM_FLOOR_MB`, defaults to the snapshot floor | `256` |
| Free page reporting on the balloon (pre-boot) | `fc-api.machineConfig()` → `PUT /balloon` | `METAL_BALLOON_FREE_PAGE_REPORTING=0` |
| KSM behind a host flag: tmpfiles.d + `MemoryKSM=` on the unit | `scripts/metal-agent/host-bootstrap.sh` | `METAL_KSM=0` |
| Metrics | `metrics.ts` → `/metrics`, the heartbeat `gauges` block, and `status()` per VM | always |

**One inflate implementation.** `reclaimBeforeSnapshot()` (the snapshot path) and
`reclaimIdle()` (the idle path) are the same code; the snapshot path passes a
long `maxWaitMs` because the pause follows, the reaper passes `0` because a tick
must never sit through GiB-scale inflation. `reclaimIdle()` never lowers a target
a VM already has, so a VM being topped up before its snapshot is not deflated and
re-inflated first.

**Who is eligible.** "Idle" is `vmLiveness()` — the one classifier the reaper,
the meter and the fleet gauges already share (SHO-533) — plus `vmBusy()` false.
So a live stream, an agent turn, app traffic or a background task all keep the
VM's RAM; only a VM doing nothing for a full `METAL_IDLE_RECLAIM_MS` is
reclaimed. **Always-on VMs are included**: they are never idle-suspended, so this
is the only pass that ever makes them cheaper.

**Getting the RAM back.** `touch()` (every proxied request), the activity poll
(when liveness stops being `idle`, or the guest reports busy), and the next
inflation-free path all call `deflateReclaimed()`, which clears the accounting
synchronously and fires the PATCH without awaiting it — no request ever waits on
(or fails because of) a balloon PATCH. `deflate_on_oom: true` is the backstop if
the PATCH is lost.

## Verified from the code and upstream, before any measurement

**Guest kernel has `CONFIG_PAGE_REPORTING`.** The kernel the bootstrap installs
is Firecracker CI's `vmlinux-6.1.102`
(`https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/`). Its
build config, published next to the image, has:

```
CONFIG_PAGE_REPORTING=y
CONFIG_VIRTIO_BALLOON=y
CONFIG_KSM=y
```

So free page reporting is available to the guest; no kernel change is needed
(changing the kernel is out of scope for this card).

**Firecracker 1.16.1 accepts the field.** In the v1.16.1 swagger
(`src/firecracker/swagger/firecracker.yaml`), `Balloon` (the pre-boot
`PUT /balloon`) has `free_page_reporting: boolean`, while `BalloonUpdate` (the
`PATCH /balloon` we use for inflate/deflate) has `amount_mib` only. That is why
it is a **pre-boot** flag: a VM already running cannot be switched over, and the
field is omitted entirely when the flag is off, so an older FC's `PUT` body is
byte-identical to today's.

**`MemoryKSM=` needs systemd ≥ 254** (hosts run 255 on Ubuntu 24.04). The
bootstrap gates on `systemctl --version` and warns instead of writing the key on
an older systemd. Firecracker does not `madvise(MADV_MERGEABLE)` its guest
memory itself, so KSM without `MemoryKSM=` would scan nothing — the flag is
inherited by the FC children across fork+exec, which is what makes their
mappings mergeable without patching FC. Confirm it took with:

```bash
grep -c . /proc/<fc pid>/ksm_merging_pages   # > 0 after pages have merged
cat /proc/<fc pid>/status | grep -i mergeable
```

If a host's systemd is older, the fallback is a two-line launcher that calls
`prctl(PR_SET_MEMORY_MERGE, 1)` and then `exec`s Firecracker — **do not patch
Firecracker**; that was deliberately not built because every current host can use
`MemoryKSM=`.

## Knobs

Set in `/etc/metal-agent.env` (the agent restarts and re-adopts live VMs), except
`METAL_KSM`, which is a **bootstrap** variable: re-run
`bash scripts/metal-agent/host-bootstrap.sh` with it in the environment.

| variable | default | meaning |
|---|---|---|
| `METAL_IDLE_RECLAIM` | `0` | turn the idle pass on |
| `METAL_IDLE_RECLAIM_MS` | `300000` | idle time before a VM is reclaimed, and the re-deflate hysteresis |
| `METAL_IDLE_RECLAIM_FLOOR_MB` | `METAL_SNAP_BALLOON_FLOOR_MB` (`256`) | guest headroom left while idle |
| `METAL_BALLOON_FREE_PAGE_REPORTING` | `0` | ask the guest to report freed pages continuously (pre-boot; a VM already running keeps its old config until it is recycled) |
| `METAL_KSM` | `0` | host KSM via tmpfiles.d + `MemoryKSM=yes` |

`METAL_IDLE_RECLAIM_MS` must stay **below** `METAL_IDLE_SUSPEND_MS` (15 min on a
bootstrapped host) or reclaim would only ever run on a VM about to be
snapshotted anyway. It does not depend on the reaper being enabled: reclaim still
works with `METAL_IDLE_SUSPEND_MS=0`, which is how the density soak runs.

## Metrics

Per host (gauges, through `/metrics` and the heartbeat's `gauges` block):

| gauge | what it tells you |
|---|---|
| `metal_idle_reclaimed_vms` | assigned VMs currently holding reclaimed RAM |
| `metal_balloon_reclaimed_mib_total` | MiB the balloon has taken out of idle guests (sum) |
| `metal_balloon_deflated_total` | deflates (one per wake-up that had RAM to give back) |
| `metal_idle_reclaim_deflate_ms` | last deflate latency — a slow PATCH is why the first request after an idle spell feels sluggish |
| `metal_host_mem_used_mib` / `metal_host_mem_available_mib` | MemTotal − MemAvailable / MemAvailable |
| `metal_ksm_pages_sharing` / `metal_ksm_pages_shared` / `metal_ksm_full_scans` | the dedup gain and whether ksmd is keeping up |
| `metal_ksmd_cpu_pct` | ksmd CPU as a % of one core — the 10%-of-one-thread budget is read from here |

Per VM (debug only, in `GET /vms` under `assigned[]` — VM ids are not metric
labels): `balloonedMiB`, `balloonUnsupported`, `deflatedIdleMs`.

**Measure host memory, not FC RSS.** A restored VM's guest memory is a
`MAP_PRIVATE` file mapping, so `VmRSS` per Firecracker process under-counts the
page cache the host is really holding. `MemAvailable`/used is the density signal;
RSS is a per-VM cross-check.

## Staging measurement (the A/B/C)

Run on the staging density host (`72.46.85.83` — the host the SHO-445 soak
runbook targets) with the harness from that card
(`scripts/metal-agent/run-density-soak.sh` → `apps/metal-agent/load/density-soak.ts`,
#2081), same mix, same ladder. **Three runs**, each 30 min of hold so the 10- and
30-minute idle marks are both observable:

| run | host env | what it isolates |
|---|---|---|
| **A** | `METAL_IDLE_RECLAIM=0`, `METAL_BALLOON_FREE_PAGE_REPORTING=0`, `METAL_KSM=0` | baseline (today's behaviour) |
| **B** | `METAL_IDLE_RECLAIM=1`, `METAL_BALLOON_FREE_PAGE_REPORTING=1`, `METAL_KSM=0` | balloon reclaim + free page reporting |
| **C** | B **plus** `METAL_KSM=1` (bootstrap) | what KSM adds on top |

```bash
# B and C: on the host, in the agent's env, then restart so it re-adopts live VMs.
sed -i 's/^METAL_IDLE_RECLAIM=.*/METAL_IDLE_RECLAIM=1/' /etc/metal-agent.env   # add if absent
echo 'METAL_BALLOON_FREE_PAGE_REPORTING=1' >> /etc/metal-agent.env
systemctl restart metal-agent

# C only: provision KSM (idempotent; also survives reboot) and confirm it took.
METAL_KSM=1 bash /root/host-bootstrap.sh
cat /etc/tmpfiles.d/metal-ksm.conf
grep -q '^MemoryKSM=yes' /etc/systemd/system/metal-agent.service && echo "unit OK"
systemctl restart metal-agent
grep -c . /proc/$(pgrep -x firecracker | head -1)/ksm_merging_pages   # > 0 once warmed

# Sampling that the soak report does not carry (KSM): run alongside the soak.
while sleep 5; do
  printf '%s ' "$(date +%s)"
  awk '/^ksmd /{print "cpu_ticks=" $14+$15}' /proc/stat 2>/dev/null
  cat /sys/kernel/mm/ksm/{pages_sharing,pages_shared,full_scans,run} | tr '\n' ' '
  awk '/^MemAvailable|^MemTotal/{printf "%s=%s ", $1, $2}' /proc/meminfo; echo
done >> /root/ksm-sample-<run>.log
```

Restore the host between runs: `METAL_IDLE_RECLAIM=0`,
`METAL_BALLOON_FREE_PAGE_REPORTING=0`, `METAL_KSM=0 bash host-bootstrap.sh`,
`systemctl restart metal-agent`, and follow the soak runbook's own
restore-after-an-interrupted-run list (`METAL_MAX_VMS_PER_HOST`,
`METAL_IDLE_SUSPEND_MS=1800000`, destroy every `soak-` VM).

### Record for each run

- **per idle VM, host RAM** at 10 min and 30 min idle: `(MemTotal − MemAvailable) / N`, plus the per-VM `VmRSS` cross-check.
- **VMs-per-host RAM knee** from the step ladder (highest N with no OOM, no sustained swap-in, memory PSI `full avg60` < 1%, `MemAvailable` > 10%).
- **ksmd CPU**: average of `metal_ksmd_cpu_pct` over the hold — budget **≤ 10% of one thread**.
- **resume latency**: time to the first proxied request after an idle period, A vs B, p50/p95. Budget **≤ +100 ms p95**. The soak's resume probe already measures this.
- **agent turn times under the burst**: must not regress (the soak's `turns.csv`).
- **snap/restore with free page reporting on**: snapshot a B-run VM, restore it, confirm the guest boots and its balloon config still reads back (the config lives in the vmstate). Also restore a snapshot taken **before** the change (free page reporting off) to prove the two coexist.

Write the numbers into the table below and into the soak's results directory
next to its density run.

### Results

| | A (baseline) | B (reclaim + FPR) | C (B + KSM) |
|---|---|---|---|
| host RAM per idle VM @10 min (MiB) | | | |
| host RAM per idle VM @30 min (MiB) | | | |
| VMs per host at the RAM knee | | | |
| ksmd CPU (% of one core) | n/a | n/a | |
| resume latency p50 / p95 (ms) | | | |
| agent turn p95 under burst (ms) | | | |

> **Not yet measured.** The harness, the code and this procedure are complete,
> but the run needs SSH to the staging host plus a super-admin token for the
> cordon, and the developer sandbox has neither (the same blocker SHO-445's
> runbook records). **Do not estimate these numbers — the whole point is that the
> current settings are guesses.** Whoever has host access runs the three runs and
> fills the table.

## KSM: the security decision record

KSM merges **byte-identical pages across VMs**. Our tenants run arbitrary code,
and that combination is the reason most multi-tenant clouds leave KSM off:

1. **Dedup timing side channel.** A guest that controls its own page contents and
   can measure the cost of writing/faulting them can infer whether another tenant
   holds the same page. Low-entropy secrets and library/version fingerprints are
   the classic targets (the "Dedup Est Machina" attack reads a victim's
   screenshots and text through it).
2. **Rowhammer.** Sharing makes cross-tenant bit flips effective — flipping a
   page mapped into several VMs ("Flip Feng Shui" can be used to corrupt a shared
   page deliberately, e.g. to weaken a key or a runtime fingerprint).
3. **Kernel-side mitigation is not available to us.** `use_zero_pages=1` merges
   only the shared zero page, which is safe; anything beyond that shares live
   tenant data. `merge_across_nodes` and SMEP/SMAP do not help.

What is being proposed, and what is not:

- **Prod stays at `METAL_KSM=0`** (all five hosts today). Nothing in this card
  changes that.
- Staging runs C to measure the gain *on top of* B, so the decision has a number
  attached: if KSM buys < ~10% host RAM per idle VM over B, it is not worth a
  cross-tenant side channel at all.
- If the gain is material, the decision is **Russell's**, and it needs an
  explicit yes recorded here with the numbers and the residual risk accepted.

**Decision:** _pending — needs the C-vs-B number and Russell's call._

| question | answer |
|---|---|
| measured gain of C over B (host RAM per idle VM) | pending |
| ksmd CPU at that gain | pending |
| risk accepted by | pending |

## Prod rollout (only after the decision above)

1. Ship the agent release (all flags off). Nothing changes on any host; verify
   that the new gauges appear and `metal_idle_reclaimed_vms` stays 0.
2. One host (dal-1): `METAL_IDLE_RECLAIM=1`, `METAL_BALLOON_FREE_PAGE_REPORTING=1`
   in `/etc/metal-agent.env`, restart. VMs already running keep the old balloon
   config (free page reporting is pre-boot), so the effect arrives as VMs
   recycle — do **not** read the first hour as the steady state.
3. Watch for a day: `metal_idle_reclaimed_vms` rising toward the idle tail,
   `metal_host_mem_available_mib` up, `metal_balloon_deflated_total` tracking
   wakes, `metal_idle_reclaim_deflate_ms` stable, and no rise in turn latency or
   `502`s after idle spells.
4. Then roll the rest of the fleet with `deploy-fleet.sh`, one host at a time.
5. KSM: only with a recorded yes, and then one staging-like host first.

**Rollback** is a flag: `METAL_IDLE_RECLAIM=0` (and/or
`METAL_BALLOON_FREE_PAGE_REPORTING=0`) plus a restart. Already-ballooned VMs are
deflated on their next request, and `deflate_on_oom` covers pressure in between;
no VM needs to be restarted or snapshotted to roll back.

## Out of scope

Raising `METAL_MAX_VMS_PER_HOST` or the control-plane cap (SHO-445 recommends it
from its own data), retiring fra-3, VM size, the guest kernel, free page
**hinting**, and any schema/API/agent-tool change.
