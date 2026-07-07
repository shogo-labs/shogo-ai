# Runbook: permanent India → EU migration (decommission production-india)

**Author:** platform / on-call
**Last updated:** 2026-07-06
**Scope:** permanently move all `ap-mumbai-1` (India) traffic **and** data
ownership into `eu-frankfurt-1` (EU), then decommission `production-india`.
**Status:** planned. Phases 1–2 have committed diffs (see §1, §2); Phases 3–4
are executed by hand with the commands below.

> **Framing.** "India traffic" is two independent layers and **both** must
> move, in order: the **edge** (Cloudflare latency-steering LB) and **data
> ownership** (`homeRegion` write-pinning, see
> [region-write-ownership.md](./region-write-ownership.md)). Reads are already
> safe to serve from EU today because EU holds a live logical-replication
> replica of all India data (`sub_from_india` streaming, lag ≈ 0). This runbook
> moves ingress + write-ownership with **zero downtime**, then tears India down.

---

## 0. Why this is safe (and the one real hazard)

- **Reads:** EU already replicates every India-homed row via the active-active
  mesh, so EU can serve India reads immediately.
- **Writes / chat:** the `home-region-router` proxies mutations, and
  `chat-region-pin` proxies chat, to the row's `homeRegion`. Until Phase 3 flips
  `homeRegion`, India-homed writes **must** still reach a live India (chat +
  money writes *fail closed* with a 503 if their home region is unreachable).
  **So India stays fully alive until Phase 3 completes — we drain the edge
  first, the data home last.**
- **The one hazard — the flip window:** each region's router reads `homeRegion`
  from its *own* local replica, and the three replicas observe the Phase 3 flip
  a few hundred ms apart. In that sub-second window the same row could be
  written in two regions → an LWW conflict. **We eliminate it with a
  few-seconds write-quiesce** (§3): India-homed writes are held (reads keep
  flowing) while the flip replicates and all three replicas converge, so there
  is never more than one physical writer.

### Scale of the move (verified against the live mesh, 2026-07-06)

| homeRegion | workspaces | users | live steady api pods / nodes |
|---|---|---|---|
| **ap-mumbai-1 (India)** | **3,989** | **3,910** | 7 / 10 |
| eu-frankfurt-1 (EU) | 2,800 | 2,728 | 6 / 5 |
| us-ashburn-1 (US) | 1,994 | 1,970 | 7 / 9 |

India is the **largest** region. EU must be scaled to carry EU+India combined
(~13 steady api pods) **before** any traffic shifts — this is Phase 1 and the
bulk of the risk. Everything after it is fast and reversible until Phase 4.

---

## 1. Phase 1 — Scale EU to absorb combined load  *(committed diffs)*

Do this well ahead; nothing user-facing changes.

**Terraform (`terraform/environments/production-eu/main.tf`, `module.eu`):**
- `system_pool_size` / `system_pool_min` `3 → 12` (warm floor covers combined
  steady-state so India requests never hit a cold node)
- `system_pool_max` `10 → 24` (combined peak headroom)

**Kustomize overlays:**
- `k8s/overlays/production-eu/api-service.yaml` — `max-scale` `10 → 20`
- `k8s/overlays/production-eu/web-service.yaml` — `max-scale` `10 → 20`

**GitHub Actions variables (out-of-band — do NOT skip):** the cluster-autoscaler
is rendered from `vars.NODE_POOL_MIN` / `vars.NODE_POOL_MAX` for environment
`production-eu` (see `deploy.yml`). Set them to match Terraform:
```bash
gh variable set NODE_POOL_MIN --env production-eu --body 12
gh variable set NODE_POOL_MAX --env production-eu --body 24
```

**Apply order:** apply Terraform (grows the OCI node pool) → deploy the overlay
(raises Knative ceilings) → confirm the autoscaler picked up the new min/max.

**Verify — the warm pool is Ready before proceeding:**
```bash
ctx=context-cbbetkypxva   # EU
kubectl --context "$ctx" get nodes --no-headers | wc -l          # → ~12 Ready
kubectl --context "$ctx" -n shogo-production-system get ds image-prepuller  # DESIRED==READY
kubectl --context "$ctx" -n shogo-production-system get ksvc api studio     # Ready
```
Do not advance until every new node is `Ready` and prepulled — a cold node
mid-cutover is the 2026-06-02 failure mode.

---

## 2. Phase 2 — Drain India edge traffic to EU  *(committed diff, one-flip)*

`terraform/environments/production-global/main.tf` now gates the India origin
on `var.india_serving_enabled` (default `true`). To drain:

```bash
cd terraform/environments/production-global
terraform apply -var 'india_serving_enabled=false' \
  -var-file=... # (usual creds/vars)
```

This (a) disables the `kourier-in` origin and (b) removes the India pool from
the `studio` / `api` / `docs` `default_pool_ids` via `compact()`. Cloudflare
drains in-flight sessions through the studio LB `__cflb` affinity cookie
(1800s TTL) and steers new requests to the next-lowest-RTT pool (EU). US stays
the fallback pool.

At this point India-homed users are **served by EU**, and EU proxies their
writes/chat back to a still-live India (one extra cross-region hop, no errors).
This validates EU capacity under real India load before we touch ownership.

**Verify:**
```bash
# EU is now taking India's request volume
kubectl --context context-cbbetkypxva -n shogo-production-system logs -l app=api --since=10m \
  | grep -c 'ChatRegionPin.*proxying to home region ap-mumbai-1'   # non-zero = expected during this phase
# EU error rate + latency flat; no 5xx spike on studio/api
```

**Rollback (instant):** `terraform apply -var 'india_serving_enabled=true'`.

> **Do not** drain the India *pods* or mesh here — India must stay alive as the
> proxy/data target until Phase 3 flips ownership.

---

## 3. Phase 3 — Flip data ownership `ap-mumbai-1 → eu-frankfurt-1` (with write-quiesce)

Re-home the India rows on the **India primary** (the current owner). After the
Phase 2 edge drain, India is the *sole* physical writer of India-homed rows
(EU/US routers proxy every India-homed write to India). We keep it that way
across the flip with a few-seconds **write-quiesce** so no dual-writer window
opens.

**Why this is airtight & zero-read-impact:** we set `default_transaction_read_only`
on the **app login role `shogo`** on the India primary only. App writes to
India-homed rows (all funneled to India) then error and the clients retry —
chat/money already return retryable 503 via the router; other writes surface the
peer error and retry. **Reads keep flowing** (a read-only transaction serves
`SELECT`s fine). The `postgres` superuser (runs the flip) and `logical_replicator`
(applies inbound replication) are *not* the `shogo` role, so neither is blocked.
This is a role-level GUC, so it is **CNPG-safe** (no `ALTER SYSTEM`, which the
operator can revert).

> India primary is `platform-pg-2` as of 2026-07-06 (US=`-2`, EU=`-1`,
> India=`-2`). Confirm before starting: `kubectl --context context-c4w44igvdfa
> -n shogo-production-system get cluster platform-pg -o jsonpath='{.status.currentPrimary}'`.

### 3a. Quiesce India-homed writes
```bash
ctx=context-c4w44igvdfa   # India
IN_PRIMARY=platform-pg-2  # verify per note above
kubectl --context "$ctx" -n shogo-production-system exec "$IN_PRIMARY" -c postgres -- \
  psql -U postgres -d shogo -c "ALTER ROLE shogo SET default_transaction_read_only = on;"
# Recycle pooled server connections so existing sessions adopt read-only immediately.
kubectl --context "$ctx" -n shogo-production-system rollout restart deploy/platform-pg-pooler-rw
kubectl --context "$ctx" -n shogo-production-system rollout status  deploy/platform-pg-pooler-rw --timeout=60s
```

### 3b. Flip ownership (as the `postgres` superuser — unaffected by the role GUC)
```bash
kubectl --context "$ctx" -n shogo-production-system exec -it "$IN_PRIMARY" -c postgres -- \
  psql -U postgres -d shogo
```
```sql
-- Pre-count (should match §0: 3989 / 3910)
SELECT count(*) FROM workspaces WHERE "homeRegion" = 'ap-mumbai-1';
SELECT count(*) FROM users      WHERE "homeRegion" = 'ap-mumbai-1';

BEGIN;
UPDATE workspaces SET "homeRegion" = 'eu-frankfurt-1' WHERE "homeRegion" = 'ap-mumbai-1';
UPDATE users      SET "homeRegion" = 'eu-frankfurt-1' WHERE "homeRegion" = 'ap-mumbai-1';
COMMIT;
```

### 3c. Wait for all three replicas to converge on EU (this is the few seconds)
```bash
for ctx in context-cp7l2tcj76q context-cbbetkypxva context-c4w44igvdfa; do
  echo "== $ctx =="
  kubectl --context "$ctx" -n shogo-production-system exec platform-pg-1 -c postgres -- \
    psql -U postgres -d shogo -tAc \
    'select coalesce("homeRegion",'"'"'<null>'"'"'), count(*) from workspaces group by 1 order by 2 desc;' 2>/dev/null
done
# Do NOT proceed until 0 rows remain on ap-mumbai-1 in EVERY region.
```

### 3d. Release the quiesce
```bash
kubectl --context "$ctx" -n shogo-production-system exec "$IN_PRIMARY" -c postgres -- \
  psql -U postgres -d shogo -c "ALTER ROLE shogo RESET default_transaction_read_only;"
kubectl --context "$ctx" -n shogo-production-system rollout restart deploy/platform-pg-pooler-rw
kubectl --context "$ctx" -n shogo-production-system rollout status  deploy/platform-pg-pooler-rw --timeout=60s
```

### 3e. Verify routers stopped pinning to India
```bash
kubectl --context context-cbbetkypxva -n shogo-production-system logs -l app=api --since=5m \
  | grep -c 'home region ap-mumbai-1'   # → trends to 0
```

> If anything in 3a–3c goes wrong, **release the quiesce (3d) and stop** — India
> is unchanged and still the owner; re-plan. The window with writes held is only
> steps 3b–3c (seconds).

---

## 4. Phase 4 — Decommission production-india (permanent)

Only after Phases 2–3 are stable through a **2-hour soak**. During the soak
watch, on EU: error rate / p99 latency flat, `conflict-watchdog` reporting
"nothing to do", `replication-monitor` exit 0, and **zero** rows re-appearing on
`ap-mumbai-1`. Do not begin 4a until the full 2 hours pass clean — Phase 4 is
irreversible.

### 4a. Object storage — nothing to migrate (verified 2026-07-06)
All three regions point at the **same US object storage** — confirmed identical
in the live api pods and in all three overlays:
`S3_WORKSPACES_BUCKET=shogo-workspaces-production`, `S3_REGION=us-ashburn-1`,
`S3_ENDPOINT=…objectstorage.us-ashburn-1…`, `PUBLISH_BUCKET=shogo-published-apps-production`,
`PUBLISH_DATA_BUCKET=shogo-published-data-production`. India is tier=`light`
(no local `object_storage` module; it uses `us_s3_endpoint`), and even tier=full
EU reuses the US buckets. So **India holds no unique object data** — no bucket
copy/replication is required before teardown.

### 4b. Desktop tunnels & published apps
- `india.tunnel` / `india.studio` A-records point at India's Kourier LB. Let live
  tunnel WebSocket sessions drain, then remove the `cloudflare_record.india_*`
  resources from `production-global`.
- Published-app **static assets + data** are already in the US buckets and served
  by the single US Cloudflare Worker — nothing to repoint. Only **server-backed**
  published apps proxy `/api/*` to the in-region Kourier (`kourier-in`); that
  routing follows the Phase 3 `homeRegion` flip to EU automatically, so no
  separate action is needed beyond confirming no app still resolves to
  `kourier-in` before teardown.

### 4c. Drain the replication mesh (India leaves the 3-way mesh)
```bash
# Drop the subscriptions that pull FROM India on the other two regions
kubectl --context context-cp7l2tcj76q -n shogo-production-system delete -f k8s/cnpg/production-us-oci/sub-from-india.yaml
kubectl --context context-cbbetkypxva -n shogo-production-system delete -f k8s/cnpg/production-eu-oci/sub-from-india.yaml
# Drop India's own subscriptions (from US, from EU) and its publication/slots
kubectl --context context-c4w44igvdfa -n shogo-production-system delete -f k8s/cnpg/production-india-oci/sub-from-us.yaml -f k8s/cnpg/production-india-oci/sub-from-eu.yaml
# Confirm no orphan slots remain on US/EU pointing at India:
#   SELECT slot_name, active FROM pg_replication_slots WHERE slot_name LIKE '%india%';
```

### 4d. Remove India from region config
- Drop `ap-mumbai-1` from `REGION_PEERS` in the US and EU `api-secrets` (so the
  routers stop knowing about a dead peer). Redeploy US + EU api.
- Remove the `india` pool + `india_serving_enabled` gate from `production-global`
  once the pool is gone for good.

### 4e. Tear down infrastructure
```bash
cd terraform/environments/production-india
terraform destroy   # OKE + CNPG + VCN for ap-mumbai-1
```
Delete the `production-india` GitHub environment, its GH env vars/secrets, the
`k8s/overlays/production-india/` + `k8s/cnpg/production-india-oci/` trees, and
the `production-india` deploy stage in `deploy.yml`. Update
`terraform/README.md` and [mesh-durably-healthy-plan.md](./mesh-durably-healthy-plan.md)
to a **two-region (US/EU)** mesh.

---

## Rollback summary

| Phase | Rollback | Reversible? |
|---|---|---|
| 1 — EU scale-up | Revert node-pool / max-scale values | Yes (just capacity) |
| 2 — edge drain | `terraform apply -var 'india_serving_enabled=true'` | Yes, seconds |
| 3 — homeRegion flip | Re-run UPDATE flipping `eu-frankfurt-1 → ap-mumbai-1` (India still alive) | Yes, while India is up |
| 4 — decommission | Rebuild India from Terraform + re-seed via mesh | **No** — gated behind the 2-hour soak |

---

## Gotchas specific to this system

- **Fail-closed pinning:** chat + `billing`/`usage`/`redeem-license` writes 503
  if the owning region is unreachable. Never drain India *pods*/mesh before
  Phase 3 — Phase 2 keeps India alive as the proxy target.
- **US-origin users of India workspaces:** a US-edge request for an India-homed
  workspace proxies US→India (Phase 2 doesn't touch US routing). Phase 3 fixes
  this by making the row EU-owned; no extra action needed.
- **`REGION_PEERS` must include EU on India (and India on EU)** throughout
  Phases 2–3 so cross-region proxying works during the transition.
- **India nodes run K8s v1.34.2** (control plane v1.35.0) — irrelevant since we
  are decommissioning, but don't waste effort upgrading them.
- **Session-affinity cookie** is why Phase 2 is graceful — don't disable
  `session_affinity` on the studio LB during the drain.

## References
- [region-write-ownership.md](./region-write-ownership.md) — the `homeRegion`
  routing model this migration re-points.
- [mesh-durably-healthy-plan.md](./mesh-durably-healthy-plan.md) — mesh health,
  conflict-watchdog, replication-monitor.
- `terraform/environments/production-global/` — Cloudflare LB / pools.
- `terraform/environments/production-eu/` — EU capacity.
