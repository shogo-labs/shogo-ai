<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Metal fleet — runbook

> **Audience**: engineers operating the bare-metal Firecracker substrate
> (Latitude.sh hosts running `apps/metal-agent`, routed by the API's
> `metal-warm-pool-controller`).
>
> Desired fleet is declared in
> [`apps/api/src/config/metal-fleet.ts`](../../apps/api/src/config/metal-fleet.ts).
> The reconciler ([`metal-fleet-reconciler.ts`](../../apps/api/src/lib/metal-fleet-reconciler.ts))
> diffs it against the live registry each minute.

## Fleet at a glance

- **Baseline** hosts are monthly commitments. The reconciler **never** buys
  these — it only surfaces drift (a desired host that isn't live). Provisioning
  baseline capacity is a human step (see "Provision a baseline host").
- **Burst** hosts are hourly, created/destroyed automatically on load when
  `burst.enabled` is true for the environment.
- **Observability**: `metal.*` router metrics + per-host `metal.host.*` gauges in
  SigNoz; dashboard `terraform/modules/signoz/dashboards/metal-fleet.json`;
  alerts under `terraform/modules/signoz/alerts/metal-*.yaml`.
- **Admin panel**: super-admin → Infrastructure → Metal Fleet (view drift,
  cordon/drain hosts).

## Auto-scaling (burst) — how it works

Each tick the reconciler computes per-region utilization (`assigned/poolSize`)
and:

- **scale up** when util ≥ `scaleUpUtilPct` and active burst < `maxPerRegion`
  and the region cooldown has elapsed → creates an hourly Latitude host with
  generated cloud-init that self-bootstraps and joins the fleet;
- **scale down** when util ≤ `scaleDownUtilPct` → **cordon** the newest burst
  host (drains as projects idle), then **destroy** it on a later tick once it
  reports 0 assigned. Two-phase so live projects are never killed.

Only reconciler-created burst hosts (tracked in the registry) are ever
destroyed — baseline hosts are untouchable by the actuator.

## Safety gates (why nothing spends money by accident)

Actuation is OFF by default and layered — ALL must hold to make a provider call:

1. `METAL_FLEET_RECONCILER_ENABLED=true` — runs the loop (else fully off).
2. `METAL_FLEET_ACTUATE=true` — else OBSERVE mode: logs the plan it *would*
   run + emits `metal.fleet.*` metrics, no provider calls.
3. `LATITUDESH_AUTH_TOKEN` present — else observe-only regardless of the flag.
4. Redis leader lease — exactly one API replica actuates per tick.

Staging runs ENABLED + OBSERVE (burst disabled anyway). Verify with:

```
kubectl --context oke-staging -n shogo-staging-system logs deploy/api -c api \
  | grep metal-fleet
# [metal-fleet] reconciler starting (OBSERVE, every 60000ms)
# [metal-fleet] region=us util=4% live=1 burst=0
```

## Enabling burst actuation (production)

Prerequisites (once):

1. **Latitude cap** raised to fit baseline + burst (see the procurement email).
2. **Publish the fleet bundle** (scripts + node-agent source; the ~11 GB rootfs
   is built on-box from the OCIR image, not shipped):

   ```
   bash scripts/metal-agent/publish-fleet-artifacts.sh
   # prints: METAL_FLEET_BUNDLE_URL=<pre-authenticated URL>
   ```

3. **Set the provisioning env** on the API (secrets via the sealed-secret /
   env-sync path, non-secrets in the overlay):

   | var | value |
   |-----|-------|
   | `METAL_FLEET_ACTUATE` | `true` (flip LAST) |
   | `LATITUDESH_AUTH_TOKEN` | Latitude API token (secret) |
   | `LATITUDESH_PROJECT_ID` | `proj_LqG158bE40BOg` |
   | `LATITUDESH_SSH_KEY_ID` | `ssh_XDO7NYqJvNPgw` |
   | `METAL_FLEET_BUNDLE_URL` | from step 2 |
   | `METAL_FLEET_RUNTIME_IMAGE` | amd64-resolvable runtime image tag (e.g. `…:production-multiarch-latest`) |
   | `METAL_FLEET_OCIR_CONFIG_B64` | base64 of the OCIR pull `config.json` (secret) |
   | `METAL_FLEET_CONTROL_PLANE_URL` | API URL agents heartbeat to |
   | `METAL_REGISTER_TOKEN` / `SHOGO_INTERNAL_SECRET` | register/assign token (secret) |
   | `METAL_FLEET_FWD_ALLOW_CIDR` | control-plane egress `IP/32` |
   | `METAL_FLEET_S3_*` (opt, `_EU` suffix) | region S3 for **EU data residency** |

   If any required var is missing, `scale_up` throws and **no server is
   created** — safe by construction.

4. Roll the API, confirm `[metal-fleet] reconciler starting (ACTUATE …)`, then
   watch a scale event end-to-end on the dashboard before trusting it under load.

To pause actuation instantly: set `METAL_FLEET_ACTUATE=false` (observe-only) —
existing burst hosts keep serving; none are added/removed.

## Provision a baseline host (manual)

Baseline is a monthly commitment, so it's deliberate:

1. Create the server (Latitude API, `billing=monthly`) — or let a future
   guarded path do it. Record the `serverId` + public IP in `metal-fleet.ts`.
2. It bootstraps via the same cloud-init path (or run
   `scripts/metal-agent/provision-burst-host.sh` after
   `host-bootstrap.sh`) with `METAL_HOST_ID` set to the baseline id.
3. Confirm it registers (admin panel drift clears; `metal.host.up` shows it).

## Incident triage

### `MetalFcProcessLeak` — untracked firecracker processes climbing
The churn process-leak (2026-07 staging incident). The kill-on-failure + orphan
reaper should prevent it; if it recurs:

1. On the host: `curl -s localhost:9900/vms | jq '.fcProcs,(.assigned|length),.available'`
   and `pgrep -c firecracker`.
2. Cordon it from the admin panel (drains, keeps serving live projects).
3. Recover: `systemctl restart metal-agent` — systemd kills the whole cgroup,
   clearing every orphan. Cache (suspended snapshots) survives the restart.

### `MetalHostDiskPressure` — NVMe > 85%
GC evicting to S3 can't keep up. Cordon the hot host so it stops taking new cold
placements; burst/siblings absorb; disk recovers as idle projects evict. If
fleet-wide, add baseline capacity or raise `maxPerRegion`.

### `MetalWakeLatencyHigh` — wake p95 > 15s
Check `metal.host.disk_used_pct` (local cache cold → S3 pulls), the assignment
`source` mix, and `metal.cold_miss` (a burst of brand-new projects legitimately
inflates p95). Cordon a saturated host.

### `MetalNoHostFallback` — no live host for metal projects
Fleet (partly) down. Check admin panel live-vs-desired; agent `register`
warnings; that not every host is cordoned; `systemctl status metal-agent` on the
hosts.
