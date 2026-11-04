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
| Pooler (prod-US / prod-EU) | `k8s/cnpg/production-{us,eu}-oci/projects-pooler.yaml` |
| Cluster (prod, **not written yet**) | — the region needs one before its pooler is applied |
| API wiring | `k8s/overlays/<region>/api-service.yaml` → `PROJECTS_DB_*` |

Staging is the one to exercise first: AC 1 and AC 2 (seed present, rows survive a
republish, destructive change refused) are proved there before a prod region is
touched.

## Deploy order (staging)

The CNPG manifests are applied **by hand** — `.github/workflows/deploy.yml` only
applies the production publication manifests — so these are console steps, in
this order. Skipping one produces a specific, confusing failure, noted below.

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
5. **API env** — `PROJECTS_DB_ADMIN_URL` reads the CNPG-created
   `projects-pg-superuser` Secret (`key: uri`), plus
   `PROJECTS_DB_HOST`/`PROJECTS_DB_POOLER_HOST` are set literally in the staging
   overlay. Roll the API after the pooler is Ready.

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
2. **Push the schema** (`prepareEnvironmentDatabase` → the project runtime's
   `/agent/published-schema`) — converts the app's SQLite schema to Postgres,
   classifies it against the schema the database already has
   (`PublishedEnvironment.dbSchema`), and refuses a destructive change unless the
   caller passed `allow_data_loss: true`. The push runs against the **primary**
   (`directUrl`), never the pooler: DDL in transaction mode is unsafe.
3. **Seed — first deploy of an environment only** — `prisma/dev.db` is loaded in
   foreign-key order, with `Int @id @default(autoincrement())` sequences moved
   past the inserted rows. Staging is seeded from `dev.db` (Q4); production data
   is never copied into staging, and a republish never overwrites live rows.
4. **Expose** — writes the `DATABASE_URL` Secret, so the pod that boots next
   reads Postgres.

## Known limits (deliberate for this slice)

- **No prod cluster manifest yet.** The prod poolers are in the repo but the
  region's `projects-cluster.yaml` is not, so `PROJECTS_DB_POOLER_HOST` is
  deliberately unset there and a prod publish refuses `database_unavailable`
  rather than pointing at a Service with no endpoints. Deploy the cluster, then
  set the variable in the same change.
- **Connection budget is per-env, not per-project.** With `poolMode:
  transaction` and `default_pool_size: 25`, the staging pooler holds 2 × 25 = 50
  backend connections against `max_connections: 400`. That is ample for staging's
  traffic; a prod region should be sized from measured replica counts before its
  first load test.
- **Uploads are still pod-local** (§3). `maxReplicas > 1` therefore lifts for
  Postgres-backed environments on the database half of AC 6 only; object-backed
  uploads land with §3.
