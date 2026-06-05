# Custom domains for published apps (Cloudflare for SaaS)

Status: **implemented**, gated behind a terraform flag + config — inert until
a dedicated custom-domains zone is provisioned and the env vars below are set,
so staging / local dev are unaffected by default.

## Why

Published apps are served at `{subdomain}.shogo.one` by the
`shogo-subdomain-router` Worker, which reads static files from OCI Object
Storage (see `terraform/modules/publish-hosting-oci`). Users want to serve
those apps from a domain they own (e.g. `app.acme.com`).

`*.shogo.one` Universal SSL only covers one label, so it cannot terminate
TLS for an arbitrary customer hostname. Cloudflare for SaaS (Custom
Hostnames) solves exactly this: the customer CNAMEs their hostname at our
fallback origin, Cloudflare issues + auto-renews a per-hostname DV cert, and
the same Worker serves the content once it can map the hostname to the right
object-storage prefix.

## How it works

```
Browser ── app.acme.com (CNAME → cname.<custom-domains-zone>) ──▶ Cloudflare edge
   │                                                              (Custom Hostname TLS)
   ▼
shogo-subdomain-router Worker  (runs via a */* route on the DEDICATED zone)
   │  hostname under the publish domain?  → first label is the subdomain
   │  otherwise (custom domain)           → CUSTOM_DOMAINS KV: hostname → subdomain
   ▼
OCI Object Storage: <subdomain>/index.html
```

### Dedicated zone (important)

Cloudflare for SaaS lives in its **own dedicated zone**, *separate from the
publish zone* (`shogo.one`). This is not optional:

- The SaaS **fallback origin** and the **`*/*` Worker route** that catches
  custom-hostname traffic are **per-zone singletons**.
- The publish zone `shogo.one` is **shared**: staging owns `*.staging.shogo.one`
  and production owns `*.shogo.one` against the same zone. A `*/*` route there
  would (a) collide between the two environments' terraform states and (b) make
  one environment's Worker intercept the other's traffic — including production
  published apps.

So each environment that enables custom domains points `custom_domains_zone` at
a zone it solely owns (e.g. a separate domain for staging), and the module
creates the fallback origin + `*/*` route + KV binding there. The same
per-environment Worker (already bound to that env's Object Storage bucket) runs
on both the publish-zone `*.<publish_domain>/*` route and the dedicated zone's
`*/*` route, so a custom domain serves that environment's bucket.

The Worker runs on a **`*/*`** route in the dedicated zone — per Cloudflare's
routing matrix, only `*/*` matches SaaS custom hostnames regardless of the
customer's orange/grey cloud setting (a narrow fallback-origin route only
matches orange-cloud).

Because the Worker intercepts every path, custom-hostname certs use **TXT**
(DNS) DV validation (`CF_CUSTOM_HOSTNAME_SSL_METHOD` defaults to `txt`) — HTTP
validation would rely on a `.well-known` challenge the Worker would swallow.
So the user adds two records: a CNAME (routing) and a TXT (cert validation),
both surfaced by the add/verify endpoints.

Control plane (all in `apps/api`):

- **Helper**: `apps/api/src/lib/cloudflare-custom-hostnames.ts` — create /
  get / find / delete a Cloudflare custom hostname, and put / delete the
  `hostname → subdomain` entry in the Worker's KV namespace.
- **Routes**: `apps/api/src/routes/publish.ts` (forwarded from
  `apps/api/src/server.ts`):
  - `GET    /api/projects/:id/domains` — list + `{ enabled, fallbackOrigin }`
  - `POST   /api/projects/:id/domains` — `{ hostname }`, registers the CF
    custom hostname, returns the DNS records to add
  - `POST   /api/projects/:id/domains/:domainId/verify` — re-polls CF, and
    once active writes the KV map
  - `DELETE /api/projects/:id/domains/:domainId` — removes CF hostname + KV +
    row
- **Data**: `CustomDomain` model (`prisma/schema.prisma` +
  `schema.local.prisma`); migration `20260605010501_add_custom_domains`.
- **UI**: `apps/mobile/components/project/CustomDomainsSection.tsx`, embedded
  in `PublishDropdown` once a project is published.

Lifecycle: publish/republish re-point active domains' KV entries at the
current subdomain; unpublish removes the KV entries (CF hostnames + rows kept
so republish restores routing); project delete tears down CF hostnames + KV
(`KnativeProjectManager.deleteProject`).

## Configuration

Set on the `apps/api` deployment. The feature is a no-op unless
`CF_API_TOKEN`/`CF_CUSTOM_HOSTNAMES_TOKEN` **and** `CF_CUSTOM_DOMAIN_ZONE_ID`
are present; KV writes additionally require `CF_ACCOUNT_ID` +
`CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID`.

| Env var | Required | Source |
| --- | --- | --- |
| `CF_API_TOKEN` (or `CF_CUSTOM_HOSTNAMES_TOKEN`) | yes | CF token with `SSL and Certificates:Edit` on the **dedicated custom-domains zone** + `Workers KV Storage:Edit` on the account. |
| `CF_CUSTOM_DOMAIN_ZONE_ID` | yes | Zone id of the **dedicated custom-domains zone** — `terraform output custom_domains_zone_id`. NOT the publish zone (`shogo.one`) and NOT `CF_ZONE_ID` (`shogo.ai`). |
| `CF_ACCOUNT_ID` | for KV | Cloudflare account id. |
| `CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID` | for KV | `terraform output custom_domains_kv_namespace_id` from `publish-hosting-oci`. |
| `CUSTOM_DOMAIN_FALLBACK_ORIGIN` | yes (effectively) | `terraform output custom_domain_fallback_origin` (e.g. `cname.<custom-domains-zone>`). Shown to users as the CNAME target. The `cname.${PUBLISH_DOMAIN}` default is wrong for the dedicated-zone model, so always set this explicitly. |
| `CF_CUSTOM_HOSTNAME_SSL_METHOD` | optional | `txt` (default) or `http`. Keep `txt` — the `*/*` Worker route swallows HTTP `.well-known` challenges. |

Staging already has these wired as **optional** `secretKeyRef`s against a
`custom-domains-config` secret (`k8s/overlays/staging/api-service.yaml`), so the
manifest is committed but inert until that secret exists. Create it from the
terraform outputs after enabling the feature:

```bash
kubectl create secret generic custom-domains-config \
  -n shogo-staging-system \
  --from-literal=CF_CUSTOM_HOSTNAMES_TOKEN="<saas+kv-scoped token>" \
  --from-literal=CF_CUSTOM_DOMAIN_ZONE_ID="$(terraform output -raw custom_domains_zone_id)" \
  --from-literal=CF_ACCOUNT_ID="<cloudflare account id>" \
  --from-literal=CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID="$(terraform output -raw custom_domains_kv_namespace_id)" \
  --from-literal=CUSTOM_DOMAIN_FALLBACK_ORIGIN="$(terraform output -raw custom_domain_fallback_origin)"
```

## Rollout (staging)

The application layer (DB migration, API, UI) ships inert by default. Turning
the feature on for staging:

1. **Provision a dedicated zone.** Add a domain you control to the Cloudflare
   account (e.g. `shogo-staging-apps.<tld>`) — it must be a *different* zone
   than `shogo.one`. This is where staging custom hostnames + their fallback
   origin + `*/*` route live (see "Dedicated zone" above).
2. **Apply terraform** for the staging env with the feature enabled:
   ```hcl
   # terraform/environments/staging (tfvars / CI)
   enable_custom_domains = true
   custom_domains_zone   = "shogo-staging-apps.<tld>"
   ```
   The terraform token needs `Zone:Read` + `SSL and Certificates:Edit` +
   `Workers Routes:Edit` on the new zone. This creates the KV namespace
   (`shogo-custom-domains-staging`), binds it to the staging Worker, and adds
   the fallback-origin record + `cloudflare_custom_hostname_fallback_origin` +
   `*/*` route **in the dedicated zone**. Note the outputs
   (`custom_domains_zone_id`, `custom_domains_kv_namespace_id`,
   `custom_domain_fallback_origin`).
3. **Create the `custom-domains-config` secret** (token + the three outputs +
   account id) — see the `kubectl create secret` snippet above. The API token
   needs `SSL and Certificates:Edit` on the dedicated zone +
   `Workers KV Storage:Edit` on the account.
4. **Redeploy / restart** the staging api so it picks up the secret. Confirm
   `GET /api/projects/:id/domains` now returns `{ "enabled": true, ... }`.
5. **Verify** end to end with a throwaway domain:
   - `POST /api/projects/:id/domains` → returns a CNAME (`→ cname.<dedicated-zone>`)
     and a TXT record (cert validation).
   - Add those records at the domain's DNS provider.
   - `POST .../verify` until `status: "active"`.
   - `curl -sI https://app.example.com` → 200 with a valid cert.

### Production

Production owns `shogo.one` outright, but the same per-zone-singleton rule
applies — and the module precondition **rejects** `custom_domains_zone ==
shogo.one`, because a `*/*` route there would hijack every `*.shogo.one`
published app plus the apex. So production also needs a dedicated zone.

`production-us` is wired (gated, off by default): the `oci-region` composite
forwards `enable_custom_domains` + `custom_domains_zone` to the publish
submodule, and `k8s/overlays/production-us/api-service.yaml` carries the same
inert `custom-domains-config` env block. To enable:

1. Add a dedicated production custom-domains zone to Cloudflare.
2. Set `enable_custom_domains = true` + `custom_domains_zone = "<that zone>"`
   on the `production-us` env (tfvars / `TF_VAR_*` GH vars) and run
   `terraform apply` for `production-us` via the Terraform workflow
   (`workflow_dispatch`, prod approval required). Terraform is NOT applied by
   the tag/deploy pipeline.
3. Create the `custom-domains-config` secret in `shogo-production-system` from
   the env outputs (`terraform output custom_domains_zone_id`,
   `custom_domains_kv_namespace_id`, `custom_domain_fallback_origin`) + a
   SaaS-scoped token, then restart the api.

A `v*` tag only ships the (inert) code and runs the `custom_domains` migration;
it does not enable the feature. EU/India serve published apps via the US
worker, so custom domains run through production-us only.

## Notes & limits

- Apex domains (`acme.com`) cannot CNAME at a provider that lacks CNAME
  flattening / ALIAS; prefer a subdomain (`app.acme.com`) or use the
  provider's flattening.
- Access control (`accessLevel` anyone/authenticated/private) is **not**
  enforced on the static Worker path today; custom domains inherit that.
- Cloudflare for SaaS custom hostnames have per-plan quotas; monitor usage if
  custom-domain adoption grows.
- Shogo-operated zones (`shogo.ai`, `shogo.one`, ...) are rejected as custom
  hostnames (`validateCustomHostname`).
