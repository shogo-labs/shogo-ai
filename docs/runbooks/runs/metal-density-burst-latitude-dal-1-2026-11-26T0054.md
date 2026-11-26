# Metal density soak — latitude-dal-1 — 2026-11-26T00:54:14.811Z

**No recommendation:** no measured density met the bounds. That is a failed measurement, not a host that cannot run VMs — inspect the failing steps before setting a cap.

CPU knee **0**, RAM knee **0** — the recommendation is the lower of the two.

## Host

| | |
|---|---|
| host | `latitude-dal-1` (us) |
| model | AMD EPYC 7443P 24-Core Processor |
| kernel | 6.8.0-124-generic |
| firecracker | Firecracker v1.16.1 |
| threads / RAM | 24 / 515643 MiB |
| VM sizing | 2 vCPU / 4096 MiB |
| env at start | METAL_MAX_VMS_PER_HOST=80, METAL_IDLE_SUSPEND_MS=1800000 |
| git sha | `unknown` |
| harness | `61403ca40` · sha256 `fac63fdc366bacc4…` |
| mix | agent 16% / app 1% / idle 83% |

## Baseline (N=1)

| step | p95 ms |
|---|---|
| cpu | 3042.0 |
| install | 353.3 |
| build | 1899.2 |

These are the measured p95s of the lone baseline VM, and they are the denominators of every `× baseline` ratio in this report — including the ones a failing step is reported against. They are not a step row: a step's own p50 is a different statistic and cannot stand in for them.

## Steps

| N | vCPU over | RAM committed | RAM physical (soak) | cpu p95 | install p95 | build p95 | app p95 | run_delay p95 | cpu PSI | MemAvail | swap-in/s | OOM | mem PSI full | resume p95 | API p95 | CPU | RAM |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 80 | 6.67:1 | 327680 MiB | 263804 MiB | 3098.7 ms | 953.3 ms | 3013.7 ms | — | 0.01 | 0.5% | 41.6% | 1.0 | 0 | 1.1% | 625 ms | 12 ms | FAIL | FAIL |

### Why each step failed

- **N=80**: install p95 2.7x baseline (limit 1.5x); build p95 1.59x baseline (limit 1.5x); memory PSI full avg60 1.09% (limit 1%)

## Burst

| N | fraction | window | turns started | cpu p95 | install p95 | build p95 | cpu PSI | MemAvail | swap-in/s | OOM | mem PSI full | resume p95 | pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 80 | 16% | 60s | 13 | 3047.8 ms | 246.8 ms | 1156.3 ms | 0.5% | 41.6% | — | 0 | — | not sampled | FAIL |

### Why each burst failed

- **N=80**: RAM gate: memory PSI full avg60 1.02% at the window's last sample -- the only one harness 61403ca40 recorded; the window's worst sample in samples.csv is 2.53% decaying from 6.59% during the N=80 hold; a burst window has no resume sample

A burst row is scored on the turn latencies, CPU and memory pressure measured in its own window. It is not scored on resume latency: a burst starts turns on guests that are already running, so it never suspends and re-assigns one, and `not sampled` means there was nothing to score — not a 0 ms pass. The PSI columns are the worst sample in the window, and `mem PSI full avg60` is a 60-second rolling average, so in a 60 s burst window it also carries the tail of the hold that preceded it.

## Knees

- **CPU knee: 0** — the highest N whose turn-step p95 stayed within 1.5× the baseline, CPU PSI `some avg60` stayed under the limit, and resume p95 held the 2 s SLO.
- **RAM knee: 0** — the highest N with zero OOM kills, no sustained swap-in, memory PSI `full avg60` under the limit, and MemAvailable above the floor.
- **Recommended `METAL_MAX_VMS_PER_HOST`: none** — a knee of 0 means no measured step passed the bounds; it is not a capacity of zero.

## RAM at each prod VM size

Measured host RSS per resident VM: **3298 MiB**.

| configured VM size | max VMs in host RAM |
|---|---|
| 2048 MiB | 140 |
| 4096 MiB | 113 |

## Notes

- Re-derived from steps.csv and turns.csv of the recorded run (2026-11-26T00:54:14.811Z), not a fresh soak.
- Burst rows: 1.
