# Terraform — plan, apply and drift runbook

> **Audience**: anyone changing `terraform/**` or applying infra for
> `staging`, `production-us` or `production-eu`.
>
> **Why this runbook exists (SHO-515)**: PR #2145 (a new project bucket) merged
> on 11-21 and was never applied. When the next full plan finally picked it up,
> it wanted to **replace** the `studio_web_assets` bucket and its PAR, the
> `*.shogo.one` / staging wildcard records, the published-apps and
> custom-domains Worker routes and the custom-hostname fallback origin — i.e.
> every published site would have gone offline had anyone applied it. Two
> separate defects stacked up: infra could merge without ever being applied,
> and a single pending object-storage change poisoned every plan.

## 1. The rule that keeps plans honest: no module-level `depends_on`

A module-level `depends_on` makes terraform **defer every data source inside
that module** as soon as the module it depends on has *any* pending change. The
data source's attributes then read `(known after apply)` at plan time, so every
resource keyed on them (`zone_id`, `namespace`) shows a forced replacement.

That is exactly what happened: `module "publish_hosting"` and
`module "studio_web_assets"` carried `depends_on = [module.object_storage]`, so
adding **one** resource to object storage (SHO-491's project bucket) made both
modules' plans claim they needed to replace the wildcard DNS record, the Worker
routes, the PAR and the assets bucket.

**Therefore:**

- Never add a module-level `depends_on` to a module that contains a data source.
- Express ordering as a **value dependency** instead: pass the thing you depend
  on as an input and let the resource reference it. Examples in the tree:
  - `module.publish_hosting.published_apps_bucket = module.object_storage.published_apps_bucket`
    (the PAR waits for the bucket because it uses its name);
  - `module.studio_web_assets.lifecycle_service_policy_id = module.object_storage.lifecycle_service_policy_id`
    (the lifecycle policy waits for the IAM policy via `depends_on` on that
    resource, not on the module).
- Do not pass a value you already hold through a data source. `oci_objectstorage_namespace`
  and the publish `zone_id` are passed in / resolved from inputs. Note that the
  repo-level `CLOUDFLARE_ZONE_ID` is the **`shogo.ai`** zone (the preview-router
  route lives there) — it is *not* the `shogo.one` publish zone, which is why
  the publish-hosting module still looks its zone up by name.

### Protect what must never be replaced

`prevent_destroy = true` is set on the resources whose replacement is an outage
or data loss, so a future forced replacement **fails the plan** instead of being
one click away:

| Resource | Why |
| --- | --- |
| `oci_objectstorage_bucket.{workspaces,pg_backups,published_apps,published_data,project_buckets}` | data loss |
| `oci_objectstorage_bucket.assets` (studio web assets) | every deployed studio build 404s its `/_expo/*` |
| `cloudflare_record.wildcard` | `*.shogo.one` / `*.staging.shogo.one` resolution |
| `cloudflare_record.custom_domain_fallback` | every bring-your-own domain's CNAME target |
| `cloudflare_custom_hostname_fallback_origin.publish` | Cloudflare-for-SaaS routing |
| `cloudflare_worker_route.{published_apps,custom_domains}` | published/custom-domain traffic is unrouted |

`.github/scripts/check-terraform-plan-protected.sh` fails CI on a
replace/delete of any of those types (deposed-object cleanup excluded) before
anyone can merge or apply it. If a replacement is genuinely intended, it needs
a human decision *and* the `prevent_destroy` lifted in the same change.

## 2. What runs when

| Trigger | What happens |
| --- | --- |
| PR touching `terraform/**` | fmt + releases-worker unit test + cross-region disk parity; `terraform validate` for **every** env; full **staging** plan posted on the PR; protected-replacement guard fails the check |
| Push to `main` touching `terraform/**` | **staging is applied automatically**; `production-us` and `production-eu` are planned (not applied) |
| Daily 06:23 UTC | plan all three envs; the job **fails** when an env has pending changes (drift alarm) |
| `workflow_dispatch` | plan or apply any one env — the only path to a production apply |

Production plans cannot run on PR branches: the `production-us` / `production-eu`
GitHub environments' branch policy allows only `main`, `hotfix/*` and `v*`.
That is why a PR plans staging and only *validates* production.

## 3. Reading the three plans

Every plan job writes a summary to the run's **Summary** tab (and, on a PR, a
comment with the full plan). Read them in this order:

1. **staging** — the canary. Its plan must show only the change you made. If it
   shows a replacement in object storage, Cloudflare DNS or the Worker routes,
   stop: the change re-introduced the module-level `depends_on` trap (§1).
2. **production-us / production-eu** — posted by the `main` run and by the daily
   drift run. Check for anything in the protected list; CI already fails on
   those, but read *why* if it does.

## 4. Applying

### staging

Automatic on merge to `main`. To force it:

```bash
gh workflow run terraform.yml -f environment=staging -f action=apply
```

### production

Production applies are **manual** on purpose. `production-us` and
`production-eu` are branch-protected but currently have **no required
reviewer**, so an apply queued from `main` would reach production with nobody
looking at it. Until a required reviewer is added to those environments
(Settings → Environments → `production-us`/`production-eu` → Required reviewers),
the approval step is the human running the dispatch:

```bash
# 1. Look at the plan first (this is the same job the daily drift run uses).
gh workflow run terraform.yml -f environment=production-us -f action=plan
# 2. Then apply. Repeat for production-eu.
gh workflow run terraform.yml -f environment=production-us -f action=apply
```

Before applying a production plan, confirm:

- the plan contains **no** replacement of a protected resource (CI fails on it,
  but a `-target` run bypasses the module graph's ordering);
- for a PAR replacement, the live `subdomain_router` Worker is not still
  pointing at the old PAR's `access_uri` (published sites must keep serving);
- afterwards, re-plan: it must say `No changes`.

Verify published traffic is still healthy:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<a-published-subdomain>.shogo.one/
curl -sS -o /dev/null -w '%{http_code}\n' https://studio.shogo.ai/
```

## 5. When the drift alarm fires

A red scheduled run means terraform state and the config on `main` disagree for
longer than a day. Two causes worth checking first:

1. **Merged but never applied** — the reason this runbook exists. Read the plan
   in the failed run and apply the environment.
2. **Out-of-band change** — someone edited the console/CLI. Either import it
   (`terraform import`) or revert it; do not leave it to be re-diagnosed daily.
