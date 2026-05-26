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
```

If any of these fail, **stop and resolve before deploying**. A red
`kubectl top nodes` value is the single best predictor of a roll
that ends in a capacity-famine incident.

## Pre-scale by 1 node

A warm-pool image roll terminates the existing warm pods and lets
the controller recreate them. With ~30 warm pods at ~500 MB each
that's a 15 GB transient memory spike against the system pool.
Pre-scaling absorbs that spike without evicting paying users.

```bash
# Bump min to (current + 1). Autoscaler scales up immediately.
# This is a TEMPORARY change — restore after the roll completes.
kubectl patch nodepool ... # see terraform/environments/production-us/main.tf
```

For OCI/OKE specifically, prefer adjusting via the cluster autoscaler
config (`min-nodes-total`) so the change is stateful and surfaces in
the same dashboards.

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

## Scale back

Once the roll is complete and the warm pool has stabilized for ~10
minutes, restore `system_pool_min` to its declared terraform value
and `terraform apply`. The autoscaler will scale down opportunistically
when load drops; you do not need to drain nodes manually.

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
