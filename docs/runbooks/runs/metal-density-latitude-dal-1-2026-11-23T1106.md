# Metal density soak — latitude-dal-1 — 2026-11-23T11:06:25.840Z

**No recommendation:** no measured density met the bounds. That is a failed measurement, not a host that cannot run VMs — inspect the failing steps before setting a cap.

CPU knee **0**, RAM knee **80** — the recommendation is the lower of the two.

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
| mix | agent 16% / app 1% / idle 83% |

## Baseline (N=1)

| step | p95 ms |
|---|---|
| cpu | 3033.9 |
| install | 209.1 |
| build | 1052.1 |

## Steps

| N | vCPU over | RAM committed | RAM physical (host FC, not soak) | cpu p95 | install p95 | build p95 | run_delay p95 | cpu PSI | MemAvail | swap-in/s | OOM | mem PSI full | resume p95 | API p95 | CPU | RAM |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 40 | 3.33:1 | 163840 MiB | 258941 MiB | 3027.6 ms | 580.5 ms | 1479.4 ms | 0.67 | 0.3% | 44.0% | 2.1 | 0 | 0.0% | 651 ms | 6 ms | FAIL | pass |
| 60 | 5.00:1 | 245760 MiB | 307975 MiB | 3117.2 ms | 583.1 ms | 3880.0 ms | 1.03 | 0.3% | 34.3% | 5.8 | 0 | 0.0% | 918 ms | 6 ms | FAIL | pass |
| 80 | 6.67:1 | 327680 MiB | 354610 MiB | 3047.0 ms | 402.6 ms | 2399.5 ms | 1.06 | 0.3% | 25.2% | 8.3 | 0 | 0.0% | 1239 ms | 6 ms | FAIL | pass |
| 100 | 8.33:1 | 409600 MiB | 367006 MiB | 3053.6 ms | 617.4 ms | 3179.4 ms | 0.00 | 0.3% | 26.3% | 33.7 | 0 | 1.4% | 604 ms | 7 ms | FAIL | FAIL |
| 120 | 10.00:1 | 491520 MiB | 322710 MiB | 3037.3 ms | 360.6 ms | 1839.5 ms | 0.18 | 1.1% | 34.9% | 39.9 | 0 | 1.8% | 634 ms | 10 ms | FAIL | FAIL |
| 160 | 13.33:1 | 655360 MiB | 395224 MiB | 3113.1 ms | 779.7 ms | 3603.6 ms | 0.19 | 3.3% | 14.2% | 136.2 | 0 | 4.9% | 3954 ms | 1367 ms | FAIL | FAIL |

> The RAM physical column in this run is the host's whole Firecracker RSS, tenants included — it was recorded before the harness attributed RSS to the soak, so it cannot be read per VM. Use the committed run that carries `ram_physical_basis=soak-delta` for host RSS per VM.

### Why each step failed

- **N=40**: install p95 2.78x baseline (limit 1.5x)
- **N=60**: install p95 2.79x baseline (limit 1.5x); build p95 3.69x baseline (limit 1.5x)
- **N=80**: install p95 1.93x baseline (limit 1.5x); build p95 2.28x baseline (limit 1.5x)
- **N=100**: install p95 2.95x baseline (limit 1.5x); build p95 3.02x baseline (limit 1.5x); memory PSI full avg60 1.38% (limit 1%)
- **N=120**: install p95 1.72x baseline (limit 1.5x); build p95 1.75x baseline (limit 1.5x); memory PSI full avg60 1.76% (limit 1%)
- **N=160**: install p95 3.73x baseline (limit 1.5x); build p95 3.43x baseline (limit 1.5x); resume p95 3954ms (limit 2000ms); swap-in 136.2 pages/s (limit 100); memory PSI full avg60 4.92% (limit 1%)

## Knees

- **CPU knee: 0** — the highest N whose turn-step p95 stayed within 1.5× the baseline, CPU PSI `some avg60` stayed under the limit, and resume p95 held the 2 s SLO.
- **RAM knee: 80** — the highest N with zero OOM kills, no sustained swap-in, memory PSI `full avg60` under the limit, and MemAvailable above the floor.
- **Recommended `METAL_MAX_VMS_PER_HOST`: none** — a knee of 0 means no measured step passed the bounds; it is not a capacity of zero.

## RAM at each prod VM size

Not measured in this run: no step carries host RSS attributed to the soak, and host-wide Firecracker RSS cannot be divided by N while tenants are resident. The per-size table comes from a run that records `ram_physical_basis=soak-delta`.

## Notes

- Re-derived from steps.csv and turns.csv of the recorded run (2026-11-23T11:06:25.840Z), not a fresh soak.
- This run recorded no burst rows, so none are claimed here. Its `turns.csv` does carry 20 burst turns recorded before the primed-guest fix, 15 of which never started a turn — a harness result, not a burst result, so it is not reported as one.
- RAM physical is the host's whole Firecracker RSS in this run (the step column predates soak attribution), so no per-VM RSS and no per-size ceiling are derived from it. They are measured only by a run that records `ram_physical_basis=soak-delta`, and the first attempt at that run stopped at its baseline because staging could not cold-boot a VM (see the runbook's blocker note).
- The ladder numbers above are unaffected by either defect: every RAM bound (OOM, swap-in, memory PSI, MemAvailable) is a host signal, which is why the RAM knee of 80 stands.
