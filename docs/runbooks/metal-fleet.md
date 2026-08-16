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
- **Host logs**: the metal-agent is dependency-free and logs to journald; a
  host-local `otelcol-metal.service` (installed by `host-bootstrap.sh`, gated on
  `OTEL_EXPORTER_OTLP_ENDPOINT`) tails that journal and ships it to SigNoz as
  `service.name=metal-agent` (`service.namespace=metal-fleet`, tagged with
  `metal.host.id`/`metal.region`). This is the bare-metal analogue of the
  in-cluster k8s-infra stdout scraper. Burst hosts get the SigNoz creds from
  cloud-init automatically; for a pre-existing host, populate the two vars in
  `/etc/metal-agent.env` and re-run `host-bootstrap.sh`. Verify with
  `systemctl status otelcol-metal` and `journalctl -u otelcol-metal`.
- **Admin panel**: super-admin → Infrastructure → Metal Fleet (view drift,
  cordon/drain hosts). Each live host row now shows `agent <sha>` / `rootfs
  <sha>` — the node-agent code version (`DEPLOYED_SHA`) and the release the
  guest rootfs was last rebuilt from (`ROOTFS_SHA`), both carried on the
  heartbeat (`register.ts` → `POST /api/internal/metal/register`). These are
  two independent axes (see self-update.ts): a host can self-update its own
  code without rebuilding the guest rootfs, and vice versa. Before this, the
  only way to check either was `ssh root@<host> cat /opt/metal-agent/DEPLOYED_SHA
  /opt/metal-agent/ROOTFS_SHA` one host at a time.
- **Per-host version check**: `curl -H "Authorization: Bearer $TOKEN"
  http://<host>:9900/version` returns `{hostId, agentVersion, rootfsSha}`
  directly from the host, for when you don't want to wait for the next
  heartbeat (up to `METAL_REGISTER_INTERVAL_MS`, default 30s) or the control
  plane is down. Still needs a symbol-level check if you need to confirm a
  *specific* commit landed inside the guest rootfs (a version string only
  proves which release was requested, not that the rebuild succeeded) — see
  `.github/runtime-image-baseline` for that verification method.

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

## Control-plane auth (`METAL_AUTH_MODE`)

The agent API on `:9900` is bound to `0.0.0.0` on hosts with public IPs, so
every control route is reachable from the internet. `METAL_AUTH_MODE` decides
what happens to a request that does not present the control-plane bearer:

| Mode | Behaviour |
| --- | --- |
| `observe` (default) | Serve it, but count it. Deploying this changes nothing. |
| `enforce` | `401`. |
| `off` | Do not check. Escape hatch only. |

The token is `METAL_REGISTER_TOKEN` in `/etc/metal-agent.env` — the same value
the agent already uses for its heartbeat, and the same value the API sends as
`SHOGO_INTERNAL_SECRET`.

**Loopback is exempt**, so everything in this runbook that runs on the host
(`curl localhost:9900/...`) keeps working under `enforce`. Calling an agent
across the network needs the header:

```bash
TOKEN=$(ssh root@<host> 'grep ^METAL_REGISTER_TOKEN= /etc/metal-agent.env | cut -d= -f2-')
curl -s -H "Authorization: Bearer $TOKEN" http://<host>:9900/vms
```

`/healthz` is always open (it is the liveness probe), and guest hydrate pulls
carry their own single-use token, so neither is affected.

### Before flipping a host to `enforce`

Check that nothing is still calling without a credential. Non-zero means a
caller would start getting 401s — find it before enforcing, do not enforce and
wait for the pager:

```bash
ssh root@<host> 'curl -s localhost:9900/metrics | grep metal_control_unauthenticated_total'
```

Expect no output at all once every caller is credentialed. The `reason` label
separates the cases: `missing` (no header — most likely a caller we forgot),
`mismatch` (wrong token — a version skew or a stale env file), `unconfigured`
(this host has no token and would refuse everyone).

### Flipping, and rolling back

```bash
ssh root@<host> "sed -i '/^METAL_AUTH_MODE=/d' /etc/metal-agent.env && \
  echo 'METAL_AUTH_MODE=enforce' >> /etc/metal-agent.env && systemctl restart metal-agent"
```

Rollback is the same command with `observe`, and it is the first thing to try
if control-plane calls start failing after a flip. A restart keeps assigned VMs
alive (`KillMode=process`), so this costs no user-visible resumes. Verify:

```bash
ssh root@<host> 'journalctl -u metal-agent -n 5 | grep "control auth"'
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:9900/vms   # 401 once enforcing
```

### Packet filter (`METAL_CTRL_ALLOW_CIDR`)

Underneath the bearer. Set it to the control-plane egress IPs, comma-separated,
and the agent installs a `SHOGO-CTRL` chain on restart. Empty (the default)
means no filter.

```bash
ssh root@<host> "sed -i '/^METAL_CTRL_ALLOW_CIDR=/d' /etc/metal-agent.env && \
  echo 'METAL_CTRL_ALLOW_CIDR=129.80.99.116/32,92.5.64.210/32' >> /etc/metal-agent.env && \
  systemctl restart metal-agent"
ssh root@<host> 'iptables -L SHOGO-CTRL -n -v'
```

List **both** regions on every host: project deletion calls `/destroy` on every
host holding the project, so a US-only rule on a Frankfurt host silently breaks
cleanup. Loopback and the guest TAP supernet are added automatically and are
not configurable — the guest rule is what keeps `/hydrate-stream` working, and
omitting it breaks every cold boot on the host.

Only port 9900 is filtered; SSH is untouched, so a bad allowlist is recoverable.
Rollback is to clear the variable and restart, which removes the chain:

```bash
ssh root@<host> "sed -i 's|^METAL_CTRL_ALLOW_CIDR=.*|METAL_CTRL_ALLOW_CIDR=|' /etc/metal-agent.env && \
  systemctl restart metal-agent"
```

Per-rule packet counts are the fastest way to see what the filter is doing —
a climbing count on the final `DROP` with a legitimate source is the signal
that an allowlist entry is missing:

```bash
ssh root@<host> 'iptables -L SHOGO-CTRL -n -v --line-numbers'
```

### Production rollout (staging is already enforcing + filtered)

Staging (`72.46.85.83`) runs `enforce` with the filter on. Production is still
open: as of this writing all four hosts predate the auth code, and the
production API sends no `Authorization` header at all, because `agentHeaders()`
used to read only `METAL_REGISTER_TOKEN` and the pods set only
`SHOGO_INTERNAL_SECRET`. Enforcing before the callers are fixed would 401 one
hundred percent of control traffic, so the order below is not optional.

1. **Agent code to production.** Run the `Metal node-agent release` workflow
   with `environment=production-us`, then `production-eu` (each region has its
   own control plane and channel pointer). Hosts self-update on heartbeat and
   keep their microVMs across the restart. `METAL_AUTH_MODE` defaults to
   `observe`, so this refuses nothing — it only starts counting.

2. **Make the control plane send the token.** The code fix is already on `main`
   and ships with the next release train. To start the soak sooner without one,
   set `METAL_REGISTER_TOKEN` (to the same value as `SHOGO_INTERNAL_SECRET`) on
   the production API pods: the currently deployed code reads that name and
   will credential every control call except `/touch`, which hardcoded its
   headers and needs the code change. Once the release lands the env var is
   redundant and can be dropped.

3. **Soak.** Watch the counter on every host until it reads zero for 24h. It
   must cover the slow callers — a project delete fanning `/destroy` across
   regions, an admin panel listing `/vms`. `/touch` staying non-zero means
   step 2's code fix has not landed yet.

   ```bash
   for h in 152.236.12.71 67.213.118.79 103.219.171.29 109.94.96.189; do
     echo "== $h"; ssh root@$h 'curl -s localhost:9900/metrics | grep control_unauthenticated'
   done
   ```

4. **Enforce, one host at a time**, using the flip above. Verify a real project
   open against that host before moving to the next.

5. **Filter, one host at a time.** Both egress IPs on *every* host:

   ```
   METAL_CTRL_ALLOW_CIDR=129.80.99.116/32,92.5.64.210/32
   ```

   Then watch a real cold boot on that host before continuing. This is the one
   thing staging could not prove: its cold boots have been failing since a
   rootfs rebuild left every local snapshot stale, so no guest ever reached
   `/hydrate-stream` there to exercise the guest-subnet rule end-to-end.

## Incident triage

### `MetalFcProcessLeak` — untracked firecracker processes climbing
The churn process-leak (2026-07 staging incident). The kill-on-failure + orphan
reaper should prevent it; if it recurs:

1. On the host: `curl -s localhost:9900/vms | jq '.fcProcs,(.assigned|length),.available'`
   and `pgrep -c firecracker`.
2. Cordon it from the admin panel (drains, keeps serving live projects).
3. Recover: `systemctl restart metal-agent` — systemd kills the whole cgroup,
   clearing every orphan. Cache (suspended snapshots) survives the restart.

### `MetalTapLeak` / `MetalTapExhaustion` — a host's /30 space filling up
Each microVM takes a `/30` out of `172.16.0.0/16`, so a host has 16384 slots and
each is held by an `fctap<n>` device. This is the 2026-07 US-region outage: taps
leaked (removed VMs whose device was never deleted), the allocator ran off the end
of the `/16`, and `deriveNet` produced `172.16.8282.225/30` — `ip addr add`
rejected it, every `/assign` 500'd, and project runtimes hung on "starting up…".

Two mechanisms now stand between a leak and that outage: the allocator wraps and
skips devices present on the host (never returns an out-of-range index), and the
GC sweep reclaims taps that belong to no VM. So this should only ever be a graph
to watch, not an incident. If it climbs anyway:

1. Separate a leak from legitimate growth first, because both end at the same
   cliff. Fleet-wide, `metal.host.taps_in_use` minus
   (`available` + `assigned` + `suspended`) is the leaked count (`MetalTapLeak`),
   while `metal.host.tap_used_pct` is how close the host is to having no blocks
   left at all (`MetalTapExhaustion`). Note that a big local snapshot cache is
   not a leak: suspended VMs keep their tap on purpose, and a DAL host healthily
   carries ~3500 of them. On the host itself,
   `curl -s localhost:9900/metrics | grep metal_tap` plus a rising
   `metal_gc_taps_reclaimed_total` tells you whether the GC is keeping up.
2. Count the devices nothing has open — the sweep's own candidates:
   `ip -o link show | grep -c 'fctap.*NO-CARRIER'`. Devices WITHOUT `NO-CARRIER`
   have a live firecracker attached and are never touched.
3. Reclaim is deliberately slow: two consecutive sweeps must agree, and each takes
   at most 200. A large backlog drains over several `gcIntervalMs` periods.
4. Only if you must reclaim by hand, and only for an index with no live VM:
   `ip link del fctap<n>`. Deleting a device a running guest holds cuts its
   networking (`Failed to write to tap: File descriptor in bad state`) and the
   project must be recycled.

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
