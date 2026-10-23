# Deploy to production — runbook

> **Audience**: any engineer rolling a new agent-runtime / API image
> into `oke-production-us` (and friends).
>
> **Why this runbook exists**: the 2026-05-20 b11c65dd publish incident
> happened during a routine warm-pool image roll. The system pool was
> running at 99% memory before the roll started; the roll churned ~30
> warm pods simultaneously; the cluster autoscaler dropped to a
> single node despite `system_pool_min = 2`; and a user's publish
> request piggybacked on the resulting capacity famine.
>
> Pre-scaling and post-roll verification would have prevented all of
> this.
>
> **2026-06-02 update (run 26865807851)**: two of the manual steps below
> are now automated by the deploy pipeline, so this runbook is mostly a
> fallback / verification aid:
>
> 1. **Standing headroom** — the cluster-autoscaler MIN floor is now wired
>    to `vars.NODE_POOL_MIN` per environment (US=4, EU=3, India=3), which
>    includes one warm spare node beyond steady-state. The autoscaler no
>    longer drops to a single node (the old `--nodes=1:10` hardcode is gone;
>    see [`k8s/base/cluster-autoscaler.yaml`](../../k8s/base/cluster-autoscaler.yaml)).
>    Manual "pre-scale by 1" is therefore usually unnecessary.
> 2. **Cold-pull gate** — every region now blocks on the image-prepuller
>    DaemonSet finishing its pull before patching the Knative revisions
>    (see [`.github/scripts/wait-runtime-prepulled.sh`](../../.github/scripts/wait-runtime-prepulled.sh)),
>    so a new revision can no longer race the runtime image pull onto a
>    cold node.

## Pre-roll checklist

Run these against the target context (`oke-production-us`,
`oke-production-eu`, etc).

```bash
# 1. Cluster has its declared minimum nodes.
#    Should match `system_pool_min` in terraform/environments/production-*/main.tf.
kubectl get nodes -o wide

# 2. No pending pods (i.e. cluster has spare capacity to schedule the roll).
kubectl get pods -A --field-selector=status.phase=Pending

# 3. Warm pool is healthy (≥ 3 Running, status=available).
kubectl get pods -n shogo-production-workspaces -l app.kubernetes.io/name=warm-pool

# 4. Per-node memory pressure < 80% (Insufficient memory races appear above this).
kubectl top nodes

# 5. Ingress is redundant: two Kourier gateway pods, ready, on different nodes,
#    and the HPA floor is 2. A region whose ingress is one pod deep is one
#    SIGKILL away from a region-wide 502 (SHO-173, 2026-10-22).
kubectl -n kourier-system get hpa 3scale-kourier-gateway     # MINPODS 2
kubectl -n kourier-system get pods -o wide -l app=3scale-kourier-gateway
kubectl -n kourier-system get pdb 3scale-kourier-gateway-pdb  # MAX UNAVAILABLE 1
```

If any of these fail, **stop and resolve before deploying**. A red
`kubectl top nodes` value is the single best predictor of a roll
that ends in a capacity-famine incident.

## Ingress capacity (Kourier) — a targeted apply must not skip it

Ingress hardening lives in `terraform/modules/knative-oci` as
`null_resource.kourier_gateway_capacity` (HPA floor, CPU/memory, liveness
tolerance, node spread) and the PDB it applies. It is **not** gated on
`manage_install` precisely because every live cluster runs with
`manage_install = false` — which is why #1062's hardening ("harden prod ingress
against 502s", 2026-09-26) sat unapplied in prod for a month while the gateway
crash-looped under a scanner flood on 10-18, 10-21 and 10-22.

Two rules follow from that:

1. **A surgical `-target` apply that touches the ingress must include
   `kourier_gateway_capacity`** (both regions). The resource address differs by
   env because the region module nests it:

   | env | `extra_args` |
   | --- | --- |
   | `production-us` | `-target=module.us.module.knative.null_resource.kourier_gateway_capacity` |
   | `production-eu` | `-target=module.eu.module.knative.null_resource.kourier_gateway_capacity` |
   | `staging` | `-target=module.knative.null_resource.kourier_gateway_capacity` |

   Run it through `terraform.yml` → `workflow_dispatch` (environment, action
   `apply`, that string in `extra_args`), once per region. A targeted apply that
   lists the app resources but not this one leaves prod running whatever the last
   patch happened to be.
2. **Verify live state after the apply, not the plan.** The `null_resource` only
   re-runs when one of its `triggers` changes, so a green apply proves nothing
   about the pods:

```bash
for region in oke-production-us oke-production-eu; do
  echo "== $region"
  kubectl --context $region -n kourier-system get hpa 3scale-kourier-gateway
  kubectl --context $region -n kourier-system get pods -o wide -l app=3scale-kourier-gateway
  kubectl --context $region -n kourier-system get deploy 3scale-kourier-gateway \
    -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources}{"\n"}{end}'
  kubectl --context $region -n kourier-system get deploy 3scale-kourier-gateway \
    -o jsonpath='live: t={.spec.template.spec.containers[0].livenessProbe.timeoutSeconds} f={.spec.template.spec.containers[0].livenessProbe.failureThreshold}{"\n"}'
done
```

Expected, per region (SHO-173):

| Field | Value |
| --- | --- |
| HPA `MINPODS` / `MAXPODS` | `2` / `10`, `TARGETS` reading real CPU (not `<unknown>`) |
| pods | `2/2` Running, **different nodes** (soft hostname anti-affinity, weight 100) |
| memory | requests `512Mi`, limits `2Gi` |
| CPU | requests `500m`, limits `2` |
| liveness | `timeoutSeconds` 5, `failureThreshold` 6 (readiness stays 1/3) |
| PDB | `MAX UNAVAILABLE 1` |

`kubectl -n kourier-system get hpa` showing `<unknown>` in `TARGETS` means
metrics-server is broken in that region and the gateway will never scale above
its floor — fix that first (`terraform/modules/metrics-server`, 2 replicas).

Alerts: `KourierGatewayRestarts` (`terraform/modules/signoz/alerts/kourier-gateway-restarts.yaml`)
pages on 3+ gateway restarts in 10m; `ProdNodeCountBelowMin` covers the node
floor. The `preview--*.shogo.ai` flood that triggered 2026-10-22 is blocked at
the edge by `cloudflare_ruleset.worker_m2m_bot_skip` in
`terraform/environments/edge-global` (`block_retired_preview_hosts` rule).

## How a release ships: promote, don't rebuild

Production never rebuilds images. A `v*` tag promotes the exact digests
staging built for that commit and ran `e2e/staging-critical` against:

1. Every staging deploy (push to `main`) leaves a complete `staging-<sha>`
   tag set for `shogo-api`, `shogo-web`, `shogo-docs` and `shogo-runtime` —
   but only **when its rollout finishes**. Images the run built get the tag
   directly; unchanged ones are re-tagged from what staging already runs
   ("Complete staging release tag set"), minutes later. A tag pushed while
   that rollout is still running is not a broken release (v2.3.7).
2. On the tag push, `promote-images` **waits for that tag set**
   (`scripts/ci/wait-for-staging-images.ts`, up to 60 min, one progress line
   per 30 s poll) and then re-tags it as `production-<sha>` and
   `production-latest` (manifest-only, seconds). `replicate-images` copies
   them to EU, and `deploy-us` / `deploy-eu` roll out once
   `staging-e2e-gate` is green. The runtime only re-rolls when its digest
   differs from what the region already pins.
3. It stops waiting early only when this commit's rollout already finished
   without the tags, or no main-branch rollout for it ever started: then
   `promote-images` fails with "No staging-<sha> image …", naming the run,
   its conclusion and the repos. Re-run that commit's main-branch staging
   deploy, or (escape hatch) dispatch `deploy.yml` with
   `environment=production` and `force_rebuild_production=true`.

The metal fleet's guest image follows the same rule. After both regions
deploy, `metal-runtime-image` asks the rootfs gate (`scripts/ci/metal-rootfs-gate.sh`)
whether hosts need new guest code. If they do, it promotes the newest
`staging-[docker-]multiarch-<C>` image whose runtime chain is identical to
the release (`.github/scripts/promote-metal-runtime-image.sh`) as
`production-[docker-]multiarch-<C>` and `-latest`. The tag keeps the sha
the image was built from, because hosts verify it against the revision
stamped inside. Only when no such image exists (or with
`force_rebuild_production`) does it dispatch `runtime-multiarch.yml` to
build the production image, which takes up to ~90 minutes. When the gate
says no rebuild, no production multi-arch image is made for the release.
So a manual `metal-agent-deploy.yml` rebuild for production must pass
`runtime_image` explicitly.

Because one image serves both environments, **never add an
environment-specific build arg** to the image builds. The studio's
per-environment values (`SHOGO_APP_ENV`, `SHOGO_APP_VERSION`, GA4 and
Facebook Pixel IDs) are ksvc env vars, rendered into `index.html` at
container start by `apps/mobile/docker/shogo-runtime-env.sh`.

## Rolling back

Run **Rollback Production** (`.github/workflows/rollback-production.yml`)
with `release` set to the `v*` tag (or full SHA) to return to, `regions`, and
a `reason`. It re-points studio / api / docs and the pinned runtime image at
that release's `production-<sha>` images through the same
`.github/scripts/apply-release-images.sh` path every deploy uses (prepull
gate, stale studio revision GC, verified `RUNTIME_IMAGE`), US first, then EU.
Nothing is rebuilt, so it takes minutes.

It does **not** revert database migrations. The api container runs
`prisma migrate deploy` on start, which only applies pending migrations, so
the older api must work against the newer schema. That is why migrations
must stay backward-compatible: add columns/tables first, and only drop or
rename them in a later release, once no rollback target still needs them.

Run it with `dry_run` first. A dry run resolves the release, checks its
images exist in each region, and shows current versus target images per
service, the node disk gate, and every applied migration the target release
doesn't have (the older api will run against them). It blocks on unfinished
migrations, because the older api's `prisma migrate deploy` would refuse to
start. It copies, patches and deletes nothing, and it doesn't share a
concurrency group with real rollbacks.

Rollback targets survive image cleanup: `cleanup-ocir.yml` never deletes the
images of the last 10 `v*` releases (`release_keep`), or any digest in use by
any cluster.

To roll forward again, re-run `deploy.yml` for the newer tag, or run the
rollback workflow with the newer release.

### What a rollback does not touch: the metal fleet

The rollback only moves the Kubernetes side. The metal fleet keeps running
whatever it already has:

- **The node agent** stays on the release its channel pointer names. To move
  it back, dispatch `metal-agent-deploy.yml` from the older tag (`--ref vX.Y.Z`)
  with the same environment; hosts converge on their next heartbeat.
- **The guest rootfs** (the runtime code inside each microVM) stays as baked.
  Rolling it back means a rootfs rebuild from the older
  `production-multiarch-<sha>` image (`metal-agent-deploy.yml` with
  `rebuild_rootfs` and `runtime_image`), which invalidates every snapshot on
  every host, so every project cold-starts afterwards. Don't do it as part of
  a routine rollback.

So after a rollback, the older api talks to newer agent and guest code. Keep
the api ↔ agent and api ↔ guest protocols backward-compatible the same way
as migrations: an api must keep working with agents and guests from at
least one release ahead (new fields optional, no removed endpoints or
renamed messages until the release after). If a release breaks that, say so
in its release notes, since rolling back across it also needs an agent
rollback and a rootfs rebuild.

### Who can deploy production

The `production-us` and `production-eu` environments only accept runs from
`main` and `v*` tags (GitHub → Settings → Environments → Deployment branches
and tags). So deploys, dry runs (`deploy.yml` with `dry_run`), rollbacks and
image cleanup must be dispatched from `main` or a release tag. A dry run
from `main` plans `main`'s head.

## Pre-scale by 1 node (now automated — fallback only)

> Normally you do **not** need to do this manually anymore: the standing
> headroom floor (`vars.NODE_POOL_MIN`, which already bakes in a +1 spare)
> keeps a warm node ready. Only follow this if the alert
> `ProdNodeCountBelowMin` is firing or you're rolling something unusually
> large.

A warm-pool image roll terminates the existing warm pods and lets
the controller recreate them. With ~30 warm pods at ~500 MB each
that's a 15 GB transient memory spike against the system pool.
Pre-scaling absorbs that spike without evicting paying users.

The durable lever is the per-environment `NODE_POOL_MIN` GitHub Actions
variable (mirrored from terraform `system_pool_min`). To temporarily add
headroom for an exceptional roll, raise it and re-run the deploy's
"Deploy Cluster Autoscaler" step (it re-applies `--nodes=MIN:MAX:OCID`),
then restore it afterwards:

```bash
# Source of truth lives in terraform/environments/production-*/main.tf
# (system_pool_min) and the matching NODE_POOL_MIN env var. The autoscaler
# enforces it live via --nodes=MIN:MAX:OCID in cluster-autoscaler.yaml.
gh variable set NODE_POOL_MIN --env production-us --body "<current+1>"
```

## Roll

1. CI bumps the runtime image tag in
   [`terraform/modules/warm-pool/main.tf`](../../terraform/modules/warm-pool/main.tf)
   (or wherever the project image lives).
2. `terraform apply` updates the warm-pool template.
3. The warm-pool controller terminates and recreates pods using the
   new template, ~3 at a time.
4. **Watch**:

   ```bash
   kubectl get pods -n shogo-production-workspaces -w
   kubectl get events -n shogo-production-workspaces --sort-by='.lastTimestamp'
   ```

5. The publish-flow dist-files endpoint lives at `/agent/dist-files` on
   the runtime pod and is required before publish can complete. Until
   the roll finishes, `POST /api/projects/:id/publish` returns a
   `download_failed` 404 — this is the expected pre-fix-rollout state.

   Historical note: commit `2f9b326d` originally added this at
   `/api/dist-files`, where it was silently shadowed by the runtime's
   `app.all('/api/*')` user-app proxy and never actually served. Every
   publish from `2f9b326d` until the namespace move would either 404
   (proxy's no-port branch) or return the user app's SPA fallback
   (200 + `index.html`, which the publisher then failed to JSON-parse).
   If you're investigating a publish failure in that window, the
   surface 404 is genuine — but the underlying cause was the proxy
   shadow, not a missing rollout.

## Post-roll verification

```bash
# 1. Warm pool refilled to its target replica count.
kubectl get pods -n shogo-production-workspaces -l app.kubernetes.io/name=warm-pool

# 2. No pods stuck in `ContainerCreating` or `Pending`.
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded

# 3. Smoke-test the publish flow against a known project.
#    (publishes complete in ~30s end-to-end against a healthy cluster.)
curl -X POST https://studio.shogo.ai/api/projects/<id>/publish ...
```

### One-time: workspace chat Slack backfill (first release with workspace chat)

Existing Slack installs and account links are copied into `chat_installations`
/ `chat_identity_links` by a script, not by the migration (the INSERTs would
replicate and conflict between regions). Run it once, in the **US** region,
after both regions have rolled; the rows replicate to EU:

```bash
bun scripts/backfill-chat-installations.ts           # dry run
bun scripts/backfill-chat-installations.ts --apply   # refuses outside us-ashburn-1
```

Until it runs, pre-existing Slack workspaces can't be switched to
Slack-backed team chat. For the first day, also watch for `WATCHDOG_SKIP`
lines and disabled subscriptions on `conversation_*` / `chat_*` tables in both
regions.

## Scale back

Only needed if you temporarily raised the floor above its declared value.
Restore `system_pool_min` (terraform) and `NODE_POOL_MIN` (GitHub var) to
their declared values and re-apply / re-run the autoscaler step. The
autoscaler will scale down opportunistically when load drops; you do not
need to drain nodes manually. The standing-headroom floor (declared value)
stays in place — do not lower it below `system_pool_min`.

## If a publish hangs

Check the new `Project.publishStatus` column (added in commit
`<phase-1-sha>`):

```sql
SELECT id, name, "publishStatus", "publishError", "publishStatusAt"
FROM projects
WHERE "publishStatusAt" > NOW() - INTERVAL '10 minutes'
  AND "publishStatus" NOT IN ('idle', 'live');
```

The most recent non-`live` row tells you which step is wedged.
Cross-reference with the runtime pod's `[Publish]` log lines
(`kubectl logs -n shogo-production-workspaces project-<id>-... -c runtime`).

A row stuck on `building` for more than 60s indicates the runtime
pod is unresponsive — the API will fire a `build_timeout` error
within 60s of the next publish attempt. A row stuck on `configuring`
means Knative service / DomainMapping creation failed; check
`kubectl get events -n shogo-production-workspaces --sort-by='.lastTimestamp'`.

## Metal fleet (bare-metal Firecracker substrate)

The metal substrate (Latitude hosts running `apps/metal-agent`) has its own
runbook — auto-scaling behaviour, enabling burst actuation, provisioning a
baseline host, and triage for the `metal-*` SigNoz alerts
(`MetalFcProcessLeak`, `MetalWakeLatencyHigh`, `MetalHostDiskPressure`,
`MetalNoHostFallback`):

→ [docs/runbooks/metal-fleet.md](./metal-fleet.md)

Quick recovery: cordon a bad host from the super-admin Infrastructure → Metal
Fleet panel (it drains, keeps serving live projects), and
`systemctl restart metal-agent` on the host clears any orphaned firecracker
processes (systemd kills the cgroup; the NVMe snapshot cache survives).
