# Per-preview Cloudflare DNS for multi-region previews

Status: **implemented**, ready to roll out per region.

## Why

Preview hostnames look like `preview--<projectId>.shogo.ai`. A single flat
`*.shogo.ai` A record in Cloudflare can only point at one origin IP, which
is fine while all preview pods live in `production-us`. Once we start
placing pods in `production-eu` or `production-india`, a hostname whose pod
runs in Frankfurt must still resolve to Frankfurt's Kourier LB — the US
wildcard would terminate TLS correctly but route traffic to the wrong
cluster where no DomainMapping exists for that hostname.

Fix: whichever region's API creates the `DomainMapping` also upserts a
proxied A record for that exact hostname pointing at its local Kourier
LB IP. When the pod is evicted from the warm pool, the record is deleted.
The flat `*.shogo.ai` wildcard stays in place as a fallback.

## What runs where

- **Code**: `apps/api/src/lib/cloudflare-dns.ts` — idempotent
  `upsertPreviewDnsRecord` / `deletePreviewDnsRecord`. Called from
  `KnativeProjectManager.createPreviewDomainMapping` and
  `deletePreviewDomainMapping`. Failures are logged and swallowed so
  pod lifecycle never depends on Cloudflare.
- **LB IP discovery**: `apps/api/src/lib/kourier-lb-discovery.ts` —
  reads `Service kourier/kourier-system` on first call and returns
  `.status.loadBalancer.ingress[0].ip`. The result is cached for the
  lifetime of the API pod. RBAC: each production overlay grants the
  api ServiceAccount a `shogo-api-kourier-lb-reader` Role scoped to
  the single named Service.
- **Tests**: `apps/api/src/lib/__tests__/cloudflare-dns.test.ts` and
  `apps/api/src/__tests__/cloudflare-dns.test.ts` — cover no-op mode,
  create, idempotent no-write, patch on drift, delete, error
  swallowing, **and** the LB IP discovery fallback (env override,
  cache reuse, concurrent first-call coalescing, RBAC denial → safe
  no-op, missing-ingress → safe no-op).
- **Config** (per overlay): `CF_ZONE_ID` + `CF_API_TOKEN` (via the
  `cloudflare-dns` secret). `KOURIER_LB_IP` is **optional**: when
  unset, the helper auto-discovers it from the Kourier Service.
  Helper is inert when either `CF_*` value is missing, so staging /
  local dev are unaffected.

Zone ID (same for every region): `c2d56140e7de85a4ac5ab5bea8e7434f`.

### Region → LB IP reference

These are reported for ops convenience — they are no longer the source
of truth for the helper, which reads them at startup directly from
each cluster's `kourier-system/kourier` Service.

| Region | Kourier LB IP |
| --- | --- |
| `production-us` (us-ashburn-1) | `152.70.192.220` |
| `production-eu` (eu-frankfurt-1) | `79.76.126.115` |
| `production-india` (ap-mumbai-1) | `161.118.170.159` |

## Rollout

Do this per region. The API image change is safe to deploy before the
secret exists — the helper becomes active only once `CF_API_TOKEN` is
populated.

### 1. Create a scoped Cloudflare API token

In the Cloudflare dashboard → *My Profile* → *API Tokens* → *Create Token*
→ *Create Custom Token*:

- **Permissions**: `Zone.DNS: Edit`
- **Zone Resources**: `Include — Specific zone — shogo.ai`
- **TTL**: indefinite (or as per your policy)

Copy the token value — it's shown once.

### 2. Create the `cloudflare-dns` Secret in each cluster

Run against each of the three production clusters:

```bash
# Switch to the target cluster context first.
kubectl create secret generic cloudflare-dns \
  --namespace shogo-production-system \
  --from-literal=CF_API_TOKEN='<token from step 1>'
```

Repeat for `production-us`, `production-eu`, `production-india`.

### 3. Deploy the new API image

Standard deploy; the overlays already reference the secret
(`optional: true`), so the pod starts either way.

### 4. Verify

After deploy, create or load a project and confirm logs:

```
[cloudflare-dns] Discovered Kourier LB IP: <region LB IP>
[cloudflare-dns] Created preview--<id>.shogo.ai -> <region LB IP> (proxied)
```

(The first line appears once per pod, on first preview claim. If you
see `[cloudflare-dns] Kourier LB discovery failed` instead, the
api ServiceAccount likely doesn't have the
`shogo-api-kourier-lb-reader` Role in `kourier-system` — re-apply the
overlay.)

Then confirm DNS resolution through Cloudflare's proxy:

```bash
dig +short preview--<id>.shogo.ai
# → Cloudflare edge IPs (104.x / 172.67.x), not the OCI LB IP
curl -sI https://preview--<id>.shogo.ai
# → 200 / 302 with valid cert chain (Google Trust Services)
```

### 5. (Optional) Back-fill existing previews

If any preview DomainMappings already exist in EU or India before the
token is deployed, they won't have explicit DNS records yet. After the
API comes up with the new config, the next project interaction will
trigger `createPreviewDomainMapping` which is idempotent and will
upsert the record. If you want to back-fill eagerly, iterate the
DomainMappings and touch each one (or wait — warm-pool eviction will
clean up the stale mapping and the next claim will recreate it with
correct DNS).

## Operational notes

- **Record hard cap**: Cloudflare Pro allows 3,500 DNS records per
  zone. Preview DomainMappings are tied to warm-pool pods which are
  aggressively reclaimed, so record count tracks *concurrent live
  previews* — not cumulative. We are far from the limit today and
  have headroom.
- **Drift correction**: `upsertPreviewDnsRecord` will PATCH an
  existing record whose `content` or `proxied` state has drifted,
  which is useful if someone edits a record manually.
- **Failure mode**: if the token is revoked or the API returns 403,
  the helper logs and returns; DomainMapping create/delete still
  succeeds. The flat `*.shogo.ai` wildcard keeps single-region
  traffic working.
- **Rotating the token**: `kubectl create secret generic cloudflare-dns
  --from-literal=CF_API_TOKEN=<new> -o yaml --dry-run=client | kubectl apply -f -`
  and restart the API deployment.
