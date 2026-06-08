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
Browser ── acme.com / www.acme.com (CNAME → cname.<custom-domains-zone>) ──▶ Cloudflare edge
   │                                                                         (Custom Hostname TLS)
   ▼
shogo-subdomain-router Worker  (runs via a */* route on the DEDICATED zone)
   │  hostname under the publish domain?  → first label is the subdomain
   │  otherwise (custom domain)           → CUSTOM_DOMAINS KV: hostname → { s: subdomain, c: canonical }
   │      host !== canonical (c)?         → 308 redirect to https://<canonical><path>
   │      else                            → serve subdomain (s)
   ▼
OCI Object Storage: <subdomain>/index.html
```

### Apex / www pairing + canonical redirect

A user only enters their domain (`acme.com`). The add endpoint registers
**both** `acme.com` and `www.acme.com` as Cloudflare custom hostnames and
links the two `CustomDomain` rows with a shared `groupId`. One row is
`primary` (canonical) — `www` by default; the user can flip it. The KV value
is JSON `{ "s": "<subdomain>", "c": "<canonicalHostname>" }`; when a visitor's
host differs from `c` the Worker issues a 308 to the canonical, preserving
path + query. This keeps a single canonical URL (SEO + auth origin
consistency) without needing Cloudflare apex proxying — apex still rides the
user's CNAME flattening / ALIAS, and `www` is the reliable default.

Legacy KV entries (a bare subdomain string) are still understood by the
Worker and serve with no redirect, so the JSON change is backward compatible.

Deeper subdomains (`app.acme.com`) are added standalone (no `www` companion).

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
  `hostname → { s, c }` JSON entry in the Worker's KV namespace.
- **Service**: `apps/api/src/services/custom-domain.service.ts` — shared
  apex/www pairing (`domainCompanion`), canonical resolution
  (`canonicalForRow`), CF→DB status mapping, and the `refreshCustomDomain`
  poll-and-activate routine used by **both** the verify route and the
  reconciler cron.
- **Routes**: `apps/api/src/routes/publish.ts` (forwarded from
  `apps/api/src/server.ts`):
  - `GET    /api/projects/:id/domains` — list + `{ enabled, fallbackOrigin }`;
    each domain carries `groupId`, `primary`, `canonicalHostname`
  - `POST   /api/projects/:id/domains` — `{ hostname }`; registers the CF
    custom hostname **and** its apex/www companion, returns
    `{ domains: [...] }` (the group) with the DNS records to add
  - `POST   /api/projects/:id/domains/:domainId/verify` — re-polls the whole
    group, writes the KV map for active members, returns `{ domains: [...] }`
  - `POST   /api/projects/:id/domains/:domainId/retrigger` — manual re-kick of
    DV validation / issuance for a **stalled** domain (DNS correct, past the
    30m threshold, outside cooldown). Gated server-side; returns 409
    (`already_active`/`dns_not_ready`/`too_early`), 429 (`cooldown`), or 502
    (`cloudflare_error`). See "Status lifecycle" below
  - `PATCH  /api/projects/:id/domains/:domainId/primary` — make this hostname
    canonical; rewrites the group's KV so the redirect flips
  - `DELETE /api/projects/:id/domains/:domainId` — removes the whole group's
    CF hostnames + KV + rows; returns `{ success, removedIds }`
- **Reconciler cron**: `apps/api/src/jobs/poll-custom-domains.ts` — every 60s
  (`withGlobalJobLock('poll-custom-domains')`) polls every non-active hostname,
  persists status + the server-side DNS verdict, writes KV on activation,
  notifies the project owner (`custom_domain_live` notification), and
  **auto-heals stalled domains** (re-triggers issuance when DNS is correct but
  the cert has stalled past the threshold — see "Status lifecycle" below).
  This is what makes a domain go live without the user pressing anything. The
  mobile UI also auto-polls verify every 30s while the panel is open.
  **Poll backoff** (`isDueForPoll`): a domain is polled every tick (~60s) for
  its first ~30 checks (`CUSTOM_DOMAIN_SLOW_POLL_AFTER_MS`, 30m), then drops to
  one poll per `CUSTOM_DOMAIN_SLOW_POLL_INTERVAL_MS` (10m) — by then it's
  almost always a slow CA we're already auto-retriggering, so a CF GET every
  minute adds nothing. Rows are ordered `updatedAt asc` so recently-checked
  (not-yet-due) rows never starve due rows out of the batch.
- **DNS check**: `apps/api/src/lib/custom-domain-dns-check.ts` — an
  independent, authoritative resolve of the routing CNAME (+ apex flattening)
  and the `_acme-challenge` DCV TXT, so we can tell the user precisely what's
  missing and gate re-triggers on "DNS is actually correct".
- **Data**: `CustomDomain` model (`prisma/schema.prisma` +
  `schema.local.prisma`) with `groupId` + `primary`, plus the retrigger/status
  bookkeeping (`certAuthority`, `lastCheckedAt`, `lastRetriggerAt`,
  `retriggerCount`, `dnsOk`, `diagnostics`); migrations
  `20260605010501_add_custom_domains`, `20260608221528_add_custom_domain_grouping`,
  and `20260608224146_add_custom_domain_retrigger_state`.
- **UI**: `apps/mobile/components/project/CustomDomainsSection.tsx`, embedded
  in `PublishDropdown` once a project is published. Renders apex/www as one
  grouped card with a primary toggle and per-hostname DNS records.

Lifecycle: publish/republish re-point active domains' KV entries (with their
canonical) at the current subdomain; unpublish removes the KV entries (CF
hostnames + rows kept so republish restores routing); project delete tears
down CF hostnames + KV (`KnativeProjectManager.deleteProject`).

## Status lifecycle, auto-heal & manual re-trigger

The panel and API surface a coarse, user-facing **stage** (`deriveStage` in
`custom-domain.service.ts`) derived from the CF status + the server-side DNS
verdict + the row's age:

```
awaiting_dns ─▶ validating ─▶ issuing (CA) ─▶ active
       │             │             │
       └─────────────┴─────────────┴─▶ stalled (DNS correct, past 30m)
                     │
                     └─▶ failed (bad records / CF error)
```

- **awaiting_dns** — records not yet detected. The panel shows the CNAME + TXT
  with per-record "Found / Not detected yet / Wrong target" ticks driven by
  the DNS check.
- **validating / issuing** — records found; CF is validating DV and minting
  the cert. We surface the issuing **CA** (`certAuthority`: `google` /
  `lets_encrypt` / `ssl_com`) because it explains timing.
- **stalled** — `pending`/`verifying` with **correct DNS** but past
  `CUSTOM_DOMAIN_STALL_THRESHOLD_MS` (default 30m). This is the only state
  where a re-trigger is offered. The common cause is a slow CA — **SSL.com has
  been observed wedged in `processing` for >30m**; a non-destructive PATCH of
  the SSL block (same DV method, tokens preserved) re-queues issuance.
- **active** — hostname + cert live; KV written; owner notified.
- **failed** — surfaced with the CF error; the user fixes DNS and the next
  poll recovers automatically.

**Re-trigger** (`retriggerCustomHostname`) PATCHes
`/custom_hostnames/:id` with just the `ssl` block — it does **not** send
`hostname`, so Cloudflare keeps the existing `_acme-challenge` tokens and the
user never touches DNS again. Two paths use it:

- **Auto-heal (reconciler, leader-only):** `shouldAutoRetrigger` fires when a
  row is `pending`/`verifying`, `dnsOk`, past the stall threshold, under
  `CUSTOM_DOMAIN_MAX_RETRIGGERS` (default 6), and beyond
  `CUSTOM_DOMAIN_AUTO_RETRIGGER_INTERVAL_MS` (default 30m) since the last
  retrigger — i.e. capped exponential-ish backoff. Leader-only via the
  existing advisory lock so two regions never double-kick.
- **Manual button (`POST .../retrigger`):** same gate via `evaluateRetrigger`
  with a tighter `CUSTOM_DOMAIN_RETRIGGER_COOLDOWN_MS` (default 5m) cooldown.
  Works from **any** region (CF is global). The panel only shows the button
  when the server reports `canRetrigger`.

Reads are DB-only but always informative: `refreshCustomDomain` persists a
compact `diagnostics` JSON snapshot (DNS instructions + per-record validation
+ DNS verdict + CA) so `GET /domains` can render the full status without
re-hitting Cloudflare. `GET /domains` also opportunistically refreshes a
non-active row whose `lastCheckedAt` is stale (>`CUSTOM_DOMAIN_STALE_READ_MS`,
default 20s) so the panel is live between cron ticks.

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
| `CUSTOM_DOMAIN_STALL_THRESHOLD_MS` | optional | When a DNS-correct domain is considered "stalled" and eligible for re-trigger / auto-heal. Default `1800000` (30m). |
| `CUSTOM_DOMAIN_RETRIGGER_COOLDOWN_MS` | optional | Min gap between **manual** re-triggers. Default `300000` (5m). |
| `CUSTOM_DOMAIN_AUTO_RETRIGGER_INTERVAL_MS` | optional | Min gap between **auto** re-triggers in the reconciler (backoff). Default `1800000` (30m). |
| `CUSTOM_DOMAIN_MAX_RETRIGGERS` | optional | Hard cap on auto re-triggers per domain. Default `6`. |
| `CUSTOM_DOMAIN_STALE_READ_MS` | optional | Age after which `GET /domains` opportunistically refreshes a non-active row. Default `20000` (20s). |
| `CUSTOM_DOMAIN_SLOW_POLL_AFTER_MS` | optional | Age after which the reconciler backs off from per-tick (~60s) polling to the slow cadence below (~30 checks). Default `1800000` (30m). |
| `CUSTOM_DOMAIN_SLOW_POLL_INTERVAL_MS` | optional | Slow-cadence poll interval once a domain is past the backoff age. Default `600000` (10m). |

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
2. Set the `ENABLE_CUSTOM_DOMAINS` (`true`) + `CUSTOM_DOMAINS_ZONE`
   (`<that zone>`) variables on the **`production-us` GitHub Environment**. The
   Terraform workflow forwards these as `TF_VAR_enable_custom_domains` /
   `TF_VAR_custom_domains_zone` (unset `ENABLE_CUSTOM_DOMAINS` resolves to
   `false`, so other envs are unaffected). Then run `terraform apply` for
   `production-us` via the Terraform workflow (`workflow_dispatch`, prod
   approval required). Terraform is NOT applied by the tag/deploy pipeline.
   Leaving `CUSTOM_DOMAINS_ZONE` empty while enabled fails the module
   precondition by design — it must name a dedicated zone, never `shogo.one`.
3. Create the `custom-domains-config` secret in `shogo-production-system` from
   the env outputs (`terraform output custom_domains_zone_id`,
   `custom_domains_kv_namespace_id`, `custom_domain_fallback_origin`) + a
   SaaS-scoped token, then restart the api.

A `v*` tag only ships the (inert) code and runs the `custom_domains` migrations;
it does not enable the feature. EU/India serve published-app *traffic* via the
US worker + dedicated zone, but the **control plane** (add / verify / manual
retrigger) is enabled in every region that carries the `custom-domains-config`
secret — Cloudflare's API is global, so a manual retrigger works from any
region. The **auto-heal** reconciler stays leader-only (one region per tick)
via `withGlobalJobLock('poll-custom-domains')`, so the multiple regions never
double-kick or double-notify.

## Notes & limits

- Apex domains (`acme.com`) cannot CNAME at a provider that lacks CNAME
  flattening / ALIAS. The UI/docs lead with `www` as the canonical default
  (which always works) and treat direct-apex via flattening as an advanced
  option, rather than asking the user to invent a subdomain. True bare-apex
  via an `A` record would require Cloudflare Enterprise "apex proxying"
  (dedicated IPs) — not used here.
- Access control (`accessLevel` anyone/authenticated/private) is **not**
  enforced on the static Worker path today; custom domains inherit that.
- Cloudflare for SaaS custom hostnames have per-plan quotas; monitor usage if
  custom-domain adoption grows.
- Shogo-operated zones (`shogo.ai`, `shogo.one`, ...) are rejected as custom
  hostnames (`validateCustomHostname`).
