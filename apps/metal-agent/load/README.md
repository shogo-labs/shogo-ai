<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Metal substrate — Locust load tests (Phase 5)

Network-level load tests for the Firecracker microVM substrate. Complements
[`apps/metal-agent/src/e2e-load.ts`](../src/e2e-load.ts) (which drives the pool
in-process on the host): this drives the node-agent HTTP API over the real
network, so it measures the wake path including RTT + HTTP + concurrency, the
same contract the control plane's `metal` pod-mode uses.

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Substrate wake path (against a live node-agent)

`MetalWakeUser` gives each virtual user its own project and repeats
assign(=resume-else-assign) → suspend — the real sleep/wake cycle. It records a
separate `wake_ready_ms(host)` sample (the host-reported restore→ready ms) so you
can split host wake cost from client↔host network RTT.

```bash
locust -f locustfile.py MetalWakeUser \
  --host http://<host-ip>:9900 \
  -u 20 -r 5 -t 2m --headless --csv results/metal-wake
```

## Staging control-plane endpoints

`StagingControlPlaneUser` load-tests the apps/api metal registry
(`/api/internal/metal/{register,status}`) with a bearer token.

```bash
METAL_TOKEN=<METAL_REGISTER_TOKEN or SHOGO_INTERNAL_SECRET> \
  locust -f locustfile.py StagingControlPlaneUser \
  --host https://<staging-api-base> \
  -u 50 -r 10 -t 1m --headless --csv results/metal-cp
```

## Notes

- End-to-end project traffic through a metal guest from the OCI control plane
  requires the WireGuard mesh (private TAP guest IPs are not otherwise routable).
  Until that is up, `MetalWakeUser` is the faithful wake-path load test and
  should target the node-agent directly.
- `-u` users / `-r` ramp / `-t` duration. Keep `-u` under host RAM ÷ per-VM RAM
  (≈120 on a 256 GB host at 2 GB/VM) since a wake briefly holds a VM before it
  re-suspends.
