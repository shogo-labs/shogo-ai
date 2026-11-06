# Cutover: metal-live published sites → Knative + Postgres

SHO-308 §7. Moves sites whose published runtime is still a `published:{id}`
microVM (SQLite inside the VM, data in `{subdomain}/data.tar.gz`) onto Knative,
with their database in `projects-pg`.

The script is `apps/api/scripts/migrate-published-to-knative.ts`; the two-phase
migration lives in `apps/api/src/services/published-cutover.service.ts`.

## Prerequisites (per region)

Run the deployment steps in this order — **before** running any migration:

1. `docs/runbooks/published-postgres.md` steps 1–5: the `projects-pg` cluster,
   its superuser Secret, and the `projects-pg-pooler-rw` Pooler. The API needs
   `PROJECTS_DB_ADMIN_URL` **and** `PROJECTS_DB_POOLER_HOST` in its env, or every
   site refuses with `database_unavailable`.
2. `docs/runbooks/published-images.md`: the `shogo-builds` namespace, the OCIR
   push Secret and `PUBLISH_BUILD_REGISTRY` / `_NAMESPACE` / `_IMAGE`.
3. The API's ClusterRole needs `get` on `pods/log` (it is in the overlays): the
   build tail and the cutover's failure reasons are read from pod logs.

## What the phases do

**Phase 1 — prepare** (site stays live on metal, no user impact)

- `production` environment row, its Postgres database, the app's schema pushed.
- One image for the published commit (reused if that commit was built before).
- A `published-{id}` ksvc at `min-scale: 1`, created **and waited for**: phase 1
  does not return until the pod answers `/ready`, which is where the image pull
  and the init-container's S3 sync happen. It owns **no traffic** — the edge only
  sends `/api/*` there once the flag flips.
- A trial load of the current `data.tar.gz` into a copy of the database.

If the ksvc is not ready inside `--readiness-timeout` (default 300s) phase 1
fails with `prepare_not_ready` and the site is left alone on metal. That wait is
deliberately generous: nobody is waiting on it, and it is what keeps the cold
start out of the switch.

**Phase 2 — switch** (the only downtime, timed end to end)

1. `published_environments.publish_status = 'switching'`. Two paths honour it:
   the published proxy answers **503 + maintenance page**, and the wake probe
   answers `{ ready: false }` at 503 so the edge keeps showing its loading page.
   Neither resolves the microVM — a wake during the freeze would resume it and
   let it write past the export.
2. Freeze: `stopPublished` suspends the microVM; the host exports the final
   `{subdomain}/data.tar.gz`.
3. Wait for an archive whose `LastModified` is at or after the freeze (5s clock
   slack). An older archive is a **failed** switch — importing it would drop the
   last writes.
4. `TRUNCATE` + reload Postgres from that export, then compare per-table row
   counts.
5. Wait for `/ready` **before** the edge points at the ksvc, bounded by the
   remaining budget. A pod that is cold or crash-looping costs no visitor a
   write, because nothing is routed to it yet.
6. Flip the edge flag, then one confirming probe through the routed path.
7. Re-check the budget, and only then close the window. An over-budget switch
   goes back to metal while visitors are still on the maintenance page.
8. Record the deployment and release the microVM (the archive is kept).

`--max-downtime` is a **bound on the window**, not a verdict on it: it caps the
readiness probes in steps 4–6, each probe's own HTTP timeout is clipped to what
is left of it, and it is evaluated before the maintenance flag comes down. Any
failure after the freeze rolls the site back: the edge flag goes to `metal`, the
microVM resumes from its untouched snapshot, and `publish_status` records
`failed` with the reason.

## Running it

```bash
# 1. Read-only plan. Changes nothing.
bun apps/api/scripts/migrate-published-to-knative.ts --dry-run

# 2. Rehearsal. Phase 1 for real, then the timed switch against copies
#    (a TEMPLATE copy of the database + a published-{id}-rehearsal ksvc).
#    No freeze, no flag flip, no live row written. The rehearsal service is
#    warmed and ready before anything is timed, so the number it prints is the
#    copy, not a cold start.
bun apps/api/scripts/migrate-published-to-knative.ts --rehearse --limit 5

# 3. The real thing, small batch first.
bun apps/api/scripts/migrate-published-to-knative.ts --yes --limit 10 --max-downtime 60

# 4. One site, or the rollback direction.
bun apps/api/scripts/migrate-published-to-knative.ts --yes --project <uuid>
bun apps/api/scripts/migrate-published-to-knative.ts --yes --to metal --project <uuid>
```

`--readiness-timeout <s>` (default 300) is phase 1's wait for the ksvc, outside
the window. `--archive-timeout <s>` (default 90) is how long to wait for the
host's final export after the freeze. `--max-failures <n>` (default 3) stops the
batch once that many sites have failed, so one bad image or a region-wide
database problem cannot walk the whole list.

The report prints site, DB size, prepare time, downtime and outcome, and the
process exits 1 if any site failed or rolled back.

A rehearsal whose template copy is busy fails with `rehearsal_failed` and a
message starting `template_busy:` — the source database still has sessions (the
environment's pod is running). For a metal site that means the microVM is still
up, which is expected while it serves traffic; rehearse on staging first, where
the environment is idle.

## Failure codes

| Code | Meaning | What it leaves behind |
|---|---|---|
| `archive_not_exported` | No fresh `data.tar.gz` after the freeze | Site back on metal, VM resumed |
| `data_load_failed` | The export could not be imported | Site back on metal, VM resumed |
| `row_count_mismatch` | Per-table counts differ | Site back on metal, VM resumed; mismatches printed |
| `edge_flip_failed` | The KV flag would not set | Site back on metal, VM resumed |
| `prepare_not_ready` | Phase 1's ksvc never answered `/ready` | Nothing changed; site still on metal |
| `health_check_failed` | The routed service stopped answering after the flip | Site back on metal, VM resumed; no write served before the flip |
| `over_downtime_budget` | The window hit `--max-downtime` | Site back on metal, VM resumed; window never closed |
| `no_archive` | Nothing to restore from (`--to metal`) | Nothing changed |
| `database_unavailable` | `PROJECTS_DB_*` missing for this region | Nothing changed |
| `rehearsal_failed` | A rehearsal step threw (incl. `template_busy:`) | Nothing changed; the copy is dropped |
| `rehearsal_flipped_edge` | The edge read `knative` after a rehearsal | Nothing changed — investigate before migrating |

A rollback clears the maintenance flag and resumes the microVM; the exported
archive is left in place, and `publish_status` keeps the failure reason.

## Manual steps this runbook cannot do for you

- Applying the `projects-pg` cluster, its superuser Secret and the Pooler.
- Creating the OCIR push Secret and the `shogo-builds` namespace.
- Choosing `--max-downtime` per batch, and deciding when to move from staging to
  production sites. Each batch needs Russell's go.
