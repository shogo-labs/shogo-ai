# Published apps on Postgres — cluster, pooler and the publish path

`projects-pg` is the database cluster that **published** server apps run on
(SHO-308 §1). It is not `platform-pg`: published apps are untrusted workloads
with their own DDL, connection counts and blast radius, so they get their own
cluster, their own backups and their own pooler.

Every published environment gets its own database and role:

| Environment | Database | Secret |
|---|---|---|
| production | `project_<uuid>` | `published-db-<projectId>-production` |
| staging | `project_<uuid>_staging` | `published-db-<projectId>-staging` |

The ksvc mounts that Secret as `DATABASE_URL` (`optional: true`), so **writing
the Secret is what moves a pod off SQLite**. The publish pipeline only writes it
after the app's schema is on the database (`prepareEnvironmentDatabase`).

## What is in the repo, and where

| Piece | File |
|---|---|
| Cluster (staging, **deployed**) | `k8s/cnpg/staging-oci/projects-cluster.yaml` |
| Pooler (staging, **deployed**) | `k8s/cnpg/staging-oci/projects-pooler.yaml` |
| Cluster (prod-US / prod-EU, **deployed by `deploy.yml`**) | `k8s/cnpg/production-{us,eu}-oci/projects-cluster.yaml` |
| Pooler (prod-US / prod-EU) | `k8s/cnpg/production-{us,eu}-oci/projects-pooler.yaml` |
| Daily base backup (staging + prod) | `ScheduledBackup` in each `projects-cluster.yaml` |
| API wiring | `k8s/overlays/<region>/api-service.yaml` → `PROJECTS_DB_*` |

Staging is the one to exercise first: AC 1 and AC 2 (seed present, rows survive a
republish, destructive change refused) are proved there before a prod region is
touched.

## Deploy order (staging)

The staging CNPG manifests are applied **by hand** — `.github/workflows/deploy.yml`
applies the production clusters (see below) — so these are console steps, in this
order. Skipping one produces a specific, confusing failure, noted below.

1. **Backup credentials** — `cnpg-s3-credentials` (`ACCESS_KEY_ID`,
   `SECRET_ACCESS_KEY`, `REGION`) must already exist in `shogo-staging-system`
   (the platform cluster uses the same Secret). Without it the cluster sits in
   `Setting up primary` and never becomes Ready — the backup stanza is evaluated
   at bootstrap.
2. **PriorityClass** — `shogo-db-critical` from
   `k8s/overlays/staging/priority-classes.yaml`.
3. **Cluster** — `kubectl apply -f k8s/cnpg/staging-oci/projects-cluster.yaml`,
   then wait: `kubectl -n shogo-staging-system wait --for=condition=Ready cluster/projects-pg --timeout=15m`.
4. **Pooler** — `kubectl apply -f k8s/cnpg/staging-oci/projects-pooler.yaml`.
   The pooler before the cluster gives the API a hostname with no endpoints,
   which is exactly the failure `PROJECTS_DB_POOLER_HOST` being required (not
   defaulted) exists to prevent.
5. **API env** — the cluster must have `enableSuperuserAccess: true` (CNPG
   does not write `projects-pg-superuser` otherwise, and the API then silently
   keeps every publish on SQLite). Its `uri` ends in `/*`; the API maps that
   to the `postgres` maintenance database. `PROJECTS_DB_ADMIN_URL` reads the CNPG-created
   `projects-pg-superuser` Secret (`key: uri`), plus
   `PROJECTS_DB_HOST`/`PROJECTS_DB_POOLER_HOST` are set literally in the staging
   overlay. Roll the API after the pooler is Ready.

**This step is the switch.** Publishing moves an app onto Postgres only when the
publish is going to Knative *and* `PROJECTS_DB_ADMIN_URL` is set
(`shouldProvisionPublishedDatabase`), so the cluster coming up above is what turns
the feature on for the region — before it, a publish behaves exactly as it does
today and the site keeps its SQLite archive. `PUBLISH_POSTGRES=on` forces it
(useful to make a half-configured cluster fail as `database_unavailable` instead
of silently staying on SQLite), and `PUBLISH_POSTGRES=off` takes publishes back
off Postgres without unsetting the URLs.

Confirm before publishing:

```bash
kubectl -n shogo-staging-system get cluster projects-pg -o wide      # Ready
kubectl -n shogo-staging-system get pooler projects-pg-pooler-rw     # Ready
kubectl -n shogo-staging-system get secret projects-pg-superuser     # exists
```

Then publish a server app to staging and check:

```bash
# The database exists and is the app's own
kubectl -n shogo-staging-system exec projects-pg-1 -- \
  psql -U postgres -c '\l' | grep project_

# The pod took the pooled URL (not the primary, not SQLite)
kubectl -n shogo-staging-system exec <published-pod> -c user-container -- \
  printenv DATABASE_URL | sed 's/:[^:@]*@/:***@/'
# → postgres://...@projects-pg-pooler-rw...?...pgbouncer=true&connection_limit=5
```

A publish with a destructive schema change must return
`409 destructive_schema_change` with the affected fields, and either
`staging` or `production` must keep serving its old rows.

## What the publish path does, in order

1. **Provision** (`ensureEnvironmentDatabase`) — creates the role/database if
   absent. Idempotent: a republish reuses both, which is what keeps rows (AC 2).
2. **Push the schema** (`prepareEnvironmentDatabase`) — the project runtime's
   `/agent/published-schema` exports the app's schema converted to Postgres (and,
   on a first deploy, `dev.db` as seed SQL); the API then runs `prisma db push` /
   `db execute` itself (`published-schema-push.ts`), inside the cluster. The
   runtime never gets the database URL: it may run on a metal host outside the
   cluster network, and it runs user code. The API first
   classifies the schema against the one the database already has
   (`PublishedEnvironment.dbSchema`), and refuses a destructive change unless the
   caller passed `allow_data_loss: true`. The push runs against the **primary**
   (`directUrl`), never the pooler: DDL in transaction mode is unsafe.
3. **Seed — first deploy of an environment only** — the rows come from the
   environment's **live SQLite archive** when it has one (`{subdomain}/data.tar.gz`,
   see *Switchover* below), otherwise from `dev.db`. Either way they are loaded in
   foreign-key order, with `Int @id @default(autoincrement())` sequences moved
   past the inserted rows. Staging is seeded from `dev.db` (Q4); production data
   is never copied into staging, and a republish never overwrites live rows.
4. **Expose** — writes the `DATABASE_URL` Secret, so the pod that boots next
   reads Postgres.

## Switchover: an environment that is already live on SQLite

Every app published before its region had a `projects-pg` has `dbSchema: null`
and real rows — sign-ups, runs, uploaded records — in its published-data
archive, which the 30 s `/data.tar.gz` sync keeps current. Seeding such an
environment from the builder's `prisma/dev.db` would create a Postgres database
holding the **builder's** rows and orphan everything the live site accumulated.

So a first deploy reads the archive instead:

1. `readLiveSeedArchive(subdomain)` (`apps/api/src/services/published-live-seed.ts`)
   downloads `{subdomain}/data.tar.gz`, extracts **only** `prisma/dev.db` (plus
   its `-wal`/`-shm`) and re-tars that as the seed archive. Uploads are not part
   of a database seed.
2. The runtime (`published-schema-export.ts`) converts that SQLite file to seed
   SQL — the same converter `dev.db` goes through, so the SQLite→Postgres rules
   still live in exactly one place, and the runtime is still never handed a
   database URL.
3. The API pushes the schema and loads the seed, then exposes the Secret.

The archive is **read, never modified or deleted**: it is what
`PUBLISH_POSTGRES=off` restores from, so the switch stays reversible.

What it refuses, and why each refusal is a publish failure rather than a
fallback:

| Condition | Result |
|---|---|
| Archive > 64 MB | `413 live_seed_too_large` — raise the cap deliberately, or reduce live data |
| Archive present but unreadable | `413 live_seed_unreadable` — falling back to `dev.db` here would silently ship builder rows over live data |
| The archive check fails at all (403, timeout, 5xx, missing bucket) | `413 live_seed_unreadable` — only a 404/`NotFound`/`NoSuchKey` means "no archive yet"; anything else is "we could not find out", and guessing wrong orphans the live rows |
| Archive has no database | **not** an error: a static app has nothing to carry over, so it seeds from `dev.db` |

`PreparedEnvironmentDatabase.seededFrom` reports `live-archive` or `dev.db`, and
the publish log says which one was used. Both are visible in the publish output,
so a switchover can be confirmed from the run that performed it.

## Starting a database empty (`data: 'empty'`)

A builder database can be too big to seed — Nada App's is 91 MB of SQL, past the
64 MB cap — and then no amount of retrying gets the app onto Postgres. Publishing
with `{"data":"empty"}` pushes the app's schema and **no rows**: the export runs
with `seed: false`, so `prisma/dev.db` is never opened and `seed_too_large` cannot
happen.

It is deliberately narrow, because "start empty" is one typo away from "throw away
the live site":

| Environment state | Result |
|---|---|
| No Postgres schema, no `{subdomain}/data.tar.gz` | starts empty — schema pushed, `seeded: false` |
| Already has a Postgres schema | `400 data_empty_not_allowed` — it never wipes an existing database |
| Live on SQLite (archive present) | `400 data_empty_not_allowed` — starting empty would abandon every row that site wrote |
| Archive probe fails (403, timeout, 5xx, missing bucket) | `413 live_seed_unreadable` — "we could not find out" is never read as "nothing to lose" |

`data` takes that one value; anything else is `400 invalid_data_option`, so a typo
fails loudly instead of being read as "no option" and seeding the database the
caller wanted empty. On an app that is already live, the fix for a
too-large builder database is the archive path above (`live_seed_too_large`),
not `data: 'empty'`.

## Backups gate the switch

No `projects-pg` cluster is trusted with a published app until a backup has been
**demonstrated working on staging**. Each cluster manifest therefore carries the
backup configuration (WAL archiving to `shogo-pg-backups-<environment>`) plus a
`ScheduledBackup` that takes a base backup on a schedule, because WAL alone
cannot restore a cluster that never had a base backup.

Prove it on staging before prod carries real data:

```bash
kubectl -n shogo-staging-system get scheduledbackup
kubectl -n shogo-staging-system get backup                       # last backup Completed
kubectl -n shogo-staging-system get cluster projects-pg -o jsonpath='{.status.firstRecoverabilityPoint}'
```

**Verified on staging 2026-11-22** (SHO-514): `ContinuousArchiving=True`
("Continuous archiving is working"), and a one-off base backup `sho514-verify`
reached `phase: completed` in 11 s to
`s3://shogo-pg-backups-staging/projects/` (backupId `20261122T094151`). Nothing
extra was needed for barman to upload: the `AWS_REQUEST_CHECKSUM_*` workaround
that prod-us `platform-pg` needs was not required here, so the prod manifests use
the same plain `barmanObjectStore` config. Re-enabling prod-us `platform-pg`
backups is still its own change.

The operator logs `Native support for Barman Cloud backups and recovery is
deprecated` on every apply. It is a warning, not a failure, and it applies
cleanly on 1.29 — but it is the reason a future change moves to the plugin-based
path.

## Deploying prod clusters (`deploy.yml`)

`deploy-us` / `deploy-eu` apply `k8s/cnpg/production-<region>-oci/projects-cluster.yaml`
and its pooler **before** the API overlay, then wait for `cluster/projects-pg`
Ready and the pooler rollout. Two ordering facts are load-bearing:

- `priority-classes.yaml` is applied before any pod that references
  `shogo-db-critical`, or the cluster's pods are rejected on admission.
- `cnpg-s3-credentials` must exist in the region's `shogo-<env>-system`
  namespace first; without it the cluster sits in `Setting up primary` forever
  because the backup stanza is evaluated at bootstrap. The workflow checks for
  it and fails with that message rather than waiting 15 minutes.

The prod clusters shipping is also what makes `PROJECTS_DB_POOLER_HOST` correct
in the prod overlays: a pooler applied before its cluster gives the API a
hostname with no endpoints.

## Object storage must exist, or the deploy fails

`/api/health` carries a `storage` field: the API HEADs each configured bucket
(`S3_PROJECT_BUCKET`, `PUBLISH_DATA_BUCKET`, `PUBLISH_BUCKET`) and reports the
env vars whose bucket returns 404. A bucket that was merged but never applied
made every upload fail `NoSuchBucket` at users while a green deploy watched an
API that answered 200 — the API does not need a bucket to serve a page.

- `ok` on `/api/health` stays about **this pod** (Redis reachable, tunnel
  publisher not degraded). A missing bucket does not drain the fleet out of the
  load balancer; it is reported, not fatal to liveness.
- The deploy gate is `.github/scripts/verify-storage-health.sh` (one script, so
  staging and both prod regions cannot drift), called by `deploy-staging.yml`
  and by `deploy-us`/`deploy-eu` after a `?storage=refresh` fetch. On a missing
  bucket it **fails the rollout**, naming the env var and pointing at
  `terraform.yml`. Staging fails first, which is the point.
- A 403, a timeout or any other non-404 is logged and *not* reported missing: the
  field fails deploys, so it must not turn a transient network error into "the
  bucket is gone".


## Known limits (deliberate for this slice)

- **Prod clusters are applied by CI, not exercised.** They are new clusters with
  no data yet; the first prod publish to each region is the change that proves
  them, and the backup gate above is what has to be satisfied first.
- **Connection budget is per-env, not per-project.** With `poolMode:
  transaction` and `default_pool_size: 25`, the staging pooler holds 2 × 25 = 50
  backend connections against `max_connections: 400`. That is ample for staging's
  traffic; a prod region should be sized from measured replica counts before its
  first load test.
- **Uploads are still pod-local** (§3). `maxReplicas > 1` therefore lifts for
  Postgres-backed environments on the database half of AC 6 only; object-backed
  uploads land with §3.
- **The 64 MB seed cap counts the whole writable-state archive**, uploads
  included, so a live site with more than 64 MB of media is refused even when its
  database is a few MB. Follow-up: stream the `GetObject` body through gunzip/tar
  and cap the extracted database instead, so uploads stop counting against the
  seed.
- **`.dockerignore` only removes paths.** A published build context honours the
  project's own `.dockerignore`, but it can never re-add `.env*`, `.git/`,
  `node_modules`, `-wal`/`-shm` files or the files the image boots from
  (`package.json`, the lockfile, `prisma/schema.prisma`, `prisma/dev.db`), and
  `.dockerignore` itself never ships (BuildKit would apply it twice). The publish
  output logs how many paths it left out.
