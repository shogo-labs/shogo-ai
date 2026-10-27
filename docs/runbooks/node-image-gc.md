# Node image GC — runbook

> **Audience**: anyone whose deploy just failed the pre-rollout disk gate, or
> who is looking at a node that keeps filling up.
>
> **Why this runbook exists**: every deploy pins a new
> `shogo-runtime:<env>-<sha>` / `shogo-api` digest and nothing used to remove
> the old ones. A long-lived node accumulated ~10 GB of dead runtime layers per
> deploy. The deploy gate
> ([`check-node-disk-headroom.sh`](../../.github/scripts/check-node-disk-headroom.sh))
> refuses to roll out at 80%, and the kubelet's own image GC does not start
> until 85% (`imageGCHighThresholdPercent`), so a node parked between those two
> numbers was reclaimed by **nothing** — it just blocked deploys until someone
> ssh'd in.
>
> That is the 2026-10-26 staging incident (SHO-233): `10.0.24.140` sat at 80.6%
> holding 193 GB of images (50 images, 13 runtime + 12 api digests) on a 202 GB
> boot volume for 13 h and failed four `Build, Test, and Deploy` runs.

## What runs automatically

Every deploy applies the GC DaemonSet **before** anything samples disk
(`.github/workflows/deploy-staging.yml` and both region blocks of
`.github/workflows/deploy.yml`, step *"Apply node image GC"*):

1. `kubectl create configmap node-image-gc` from
   [`scripts/node-image-gc.sh`](../../scripts/node-image-gc.sh) — the script is
   the single source of truth, the ConfigMap is generated from it.
2. `kubectl apply -f k8s/base/node-image-gc.yaml` — the DaemonSet, one pod per
   node in `kube-system`.
3. `kubectl rollout status daemonset/node-image-gc --timeout=600s` — the pod's
   `startupProbe` waits for `/run/shogo-node-image-gc-state/last-pass`, which
   the script writes only after a **completed pass**. So this blocks until the
   node has actually been looked at, not merely until the container started.
   The step is deliberately non-fatal: a slow pass must not fail the deploy,
   because the gate re-samples disk right after it.

The pod is privileged and `chroot /host`s into the node's own root, so it uses
the node's `crictl`, `df` and `jq` instead of shipping copies. It then loops
one pass every `INTERVAL_S` (default 600 s).

## What it removes (and what it never touches)

A pass only reclaims when the worst of nodefs/imagefs is **at or above**
`RECLAIM_PCT` (default **65**). When it reclaims, it removes an image only if
**all** of these hold:

- its repo matches `IMAGE_REPOS` —
  `shogo/(shogo-runtime|agent-runtime|shogo-api|shogo-web|shogo-docs)`;
- no container on the node uses it (`crictl ps -a`, so exited containers count)
  and cri-o has not pinned it;
- it is outside the newest `KEEP_PER_REPO` (default 2) of its repo, so a
  rollback stays warm and an image the prepuller is pulling right now is never
  dropped;
- its age is known — an image with no readable timestamp is never removed,
  because it cannot be shown to be older than the ones being kept.

Postgres, Knative and OKE system images are never passed to `crictl rmi`.

## Symptom → action

### "Refusing to deploy: node X is at 8x% used"

```sh
export KUBECONFIG=$HOME/.kube/config-shogo-staging   # or -production-us
kubectl -n kube-system get pods -l app.kubernetes.io/name=node-image-gc -o wide
kubectl -n kube-system logs -l app.kubernetes.io/name=node-image-gc --tail=50
```

The log line you want is the pass summary — `disk NN% … removed=N skipped=M`.
If the DaemonSet is missing (a deploy never ran since this landed), apply it
by hand:

```sh
kubectl create configmap node-image-gc --namespace=kube-system \
  --from-file=node-image-gc.sh=scripts/node-image-gc.sh \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/base/node-image-gc.yaml
kubectl -n kube-system rollout status daemonset/node-image-gc --timeout=600s
```

### "It says `disk 78% < 65% — nothing to reclaim` but the node is full"

The 65% is the *gate to act*, not the disk level. If the node is above 65% and
still reports nothing to reclaim, the images it holds are all in use, pinned,
inside `KEEP_PER_REPO`, or outside `IMAGE_REPOS`. Check what is actually there
before lowering anything:

```sh
kubectl debug node/<node> -it --profile=sysadmin --image=busybox:1.36 -- \
  chroot /host crictl images
```

Raising `KEEP_PER_REPO` down (to 1) or lowering `RECLAIM_PCT` is a deliberate
trade against rollback headroom — change it in `k8s/base/node-image-gc.yaml`
with a comment saying why, not with an ad-hoc `kubectl set env`.

### Run it by hand on one node

The script lives in the DaemonSet pod, not on the host: the ConfigMap is
mounted into the pod's view of the host root, so a `kubectl debug node/...`
shell finds an empty `/run/shogo-node-image-gc/`. Exec into the GC pod for that
node instead — it already has `chroot /host` wired up.

```sh
POD=$(kubectl -n kube-system get pod -l app.kubernetes.io/name=node-image-gc \
        --field-selector spec.nodeName=<node> -o name)
```

Dry run first — this prints candidates and removes nothing:

```sh
kubectl -n kube-system exec -it "$POD" -- \
  chroot /host /usr/bin/env RECLAIM_PCT=0 DRY_RUN=1 ONESHOT=1 \
  /bin/sh /run/shogo-node-image-gc/node-image-gc.sh
```

Then for real (drop `DRY_RUN`, keep `ONESHOT=1` so it exits after one pass):

```sh
kubectl -n kube-system exec -it "$POD" -- \
  chroot /host /usr/bin/env RECLAIM_PCT=0 ONESHOT=1 \
  /bin/sh /run/shogo-node-image-gc/node-image-gc.sh
```

A dry run on `10.0.29.201` looks like this:

```
[node-image-gc] 10.0.29.201 disk 38% >= 0% — reclaiming superseded Shogo digests (keep newest 2 per repo)
  .../shogo/shogo-api: 3 image(s)   .../shogo/shogo-runtime: 6 image(s)
  in use: 1  pinned: 1  unknown age (kept): 0  newest kept: 8
[node-image-gc] 10.0.29.201 would remove .../shogo/shogo-api c50c6a3f...
[node-image-gc] 10.0.29.201 done before=38% after=38% removed=3 skipped=0 dry_run=1
```

`RECLAIM_PCT=0` forces the pass to consider reclaiming regardless of current
usage — useful when you know the node is full but the sampled number disagrees.

### The first deploy onto a full node may still fail the gate once

A node as full as `10.0.24.140` was has ~25 removal candidates at roughly 30 s
each. Both of the deploy's own windows can expire mid-pass:

- the GC step's `kubectl rollout status … --timeout=600s` (non-fatal by design),
- the gate's re-sampling, up to 5 × 30 s.

So on a genuinely full node the first deploy after this lands can still report
no headroom while the reclaim is running. Re-run the job; the second attempt
samples a node that has already been reclaimed. Do not raise the gate threshold
to work around it.

## Env reference

| Var | Default | Meaning |
| --- | --- | --- |
| `RECLAIM_PCT` | `65` | Reclaim at/above this used% (deploy gate is 80) |
| `KEEP_PER_REPO` | `2` | Newest digests kept per repo |
| `INTERVAL_S` | `600` | Seconds between passes in the DaemonSet |
| `IMAGE_REPOS` | `shogo/(shogo-runtime\|agent-runtime\|shogo-api\|shogo-web\|shogo-docs)` | ERE of repos eligible for removal |
| `IMAGE_DIR` | `/var/lib/containers` | Filesystem measured for used% |
| `IMAGE_STORE_DIR` | `/var/lib/containers/storage/overlay-images` | cri-o image store |
| `CRICTL` | `crictl` | crictl binary |
| `CRICTL_TIMEOUT` | `10m` | crictl's own default is 2 s, which a busy cri-o blows through mid-removal |
| `NODE_NAME` | hostname | Node this pass is about (downward API in the DaemonSet) |
| `STATE_DIR` | `/run/shogo-node-image-gc-state` | Where the completed-pass marker goes |
| `DRY_RUN` | `0` | Log candidates, remove nothing |
| `ONESHOT` | `0` | One pass then exit (tests + manual runs) |

## Monitoring

`k8s/base/warm-pool-monitor.yaml` cross-checks the same thresholds, so a node
does not have to fail a deploy before anyone hears about it:

- **CRITICAL** — a schedulable node at/above `DISK_CRIT_PCT` (78%).
- **CRITICAL** — a node at/above `RECLAIM_PCT` (65%) still holding more than 4
  runtime digests.
- **WARNING** — more than 4 runtime digests below 65% (reported, not paged;
  the GC will get it once the node crosses 65%).
- **WARNING** — a node at/above 70%, the level the kubelet starts reclaiming at.

The monitor reads nodefs/imagefs from
`/api/v1/nodes/<n>/proxy/stats/summary`, which needs `get` on `nodes/proxy` —
`nodes` get/list alone returns 403 and the disk line is silently skipped. That
gap was found while verifying SHO-233: the first staging run printed the digest
line and no percentages at all.

## Rollback

The GC is additive and stateless — removing it never makes a node *worse*:

```sh
kubectl -n kube-system delete daemonset node-image-gc
kubectl -n kube-system delete configmap node-image-gc
```

That only means nodes stop being reclaimed; no image that is in use, pinned, or
within `KEEP_PER_REPO` was ever removed, so no workload is affected by stopping
it. To stop it from coming back, remove the *"Apply node image GC"* step from
the three deploy workflow blocks.
