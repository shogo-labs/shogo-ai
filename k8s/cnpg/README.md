# CloudNativePG Cluster Manifests

PostgreSQL clusters managed by the CloudNativePG operator.

## Architecture

Currently only the **platform-pg** cluster is deployed. A future **projects-pg**
cluster is planned but not yet implemented — dev projects use SQLite and
published-app PostgreSQL provisioning is still on the roadmap.

### Platform Cluster (`platform-pg`) — **active**
- Runs on OCI OKE clusters across all regions
- HA with automated failover (2-3 instances)
- Continuous backup to OCI Object Storage via Barman (S3-compatible API)
- Used by: API, MCP, Auth services

### Projects Cluster (`projects-pg`) — **stub / not deployed**
- Intended to host per-project databases (`project_{uuid}`) on a shared cluster
- Will replace per-project PostgreSQL sidecars once published-app support ships
- Related code stubs: `apps/api/src/services/database.service.ts` (provisioning
  logic), unused imports in `knative-project-manager.ts` and
  `warm-pool-controller.ts`
- No cluster manifest exists yet — will be added when the feature is built

## Services Created

Each cluster creates these Kubernetes Services:
- `{cluster}-rw` - Read-write (points to primary)
- `{cluster}-ro` - Read-only (points to replicas)
- `{cluster}-r` - Read any (points to any instance)

## Connection pooling (PgBouncer) — **active**

Each region also runs a CNPG `Pooler` (`platform-pg-pooler-rw`, defined in
`platform-pooler.yaml`) — a transaction-mode PgBouncer in front of
`platform-pg-rw`. This is the durable fix for the 2026-07-01 `ap-mumbai-1`
outage, where blocking `pg_advisory_lock()` waiters on the shared Prisma pool
pinned every backend until `prisma.invitation.count()` could not get a
connection.

**Conventional connection split (what the app uses):**
- `DATABASE_URL` → `platform-pg-pooler-rw.<ns>.svc:5432` (PgBouncer, txn mode).
  Serves normal app queries; many short client conns multiplex onto a small
  backend pool.
- `DATABASE_DIRECT_URL` → `platform-pg-rw.<ns>.svc:5432` (direct). Used for
  session-scoped work that must pin ONE backend: advisory locks
  (`withAdvisoryLock`, `withGlobalJobLock`) and `prisma migrate deploy`.

Session-scoped advisory locks are **incorrect** over a transaction-mode pooler
(acquire and release can land on different backends), which is exactly why the
lock paths and migrations bypass PgBouncer via the direct URL.

### Rollout / secret repoint (per region, staging FIRST)

`postgres-credentials` is a manually-managed secret (see the
`logical-replication/RUNBOOK.md`). Order matters — do NOT repoint `DATABASE_URL`
before the direct key exists and the pooler is Ready:

```bash
CTX=oke-staging   # then oke-eu, oke-us
NS=shogo-staging-system   # shogo-production-system for prod

# 1. Add the DIRECT url key (= the CURRENT direct platform-pg-rw url, i.e. the
#    value DATABASE_URL has today). This must exist before the new api revision
#    (which references DATABASE_DIRECT_URL) starts.
DIRECT_URL="postgresql://shogo:<password>@platform-pg-rw.${NS}:5432/shogo"
kubectl --context "$CTX" -n "$NS" patch secret postgres-credentials \
  --type merge -p "{\"stringData\":{\"DATABASE_DIRECT_URL\":\"${DIRECT_URL}\"}}"

# 2. Deploy the pooler and wait until it is Ready.
kubectl --context "$CTX" apply -f k8s/cnpg/staging-oci/platform-pooler.yaml
kubectl --context "$CTX" -n "$NS" rollout status deploy/platform-pg-pooler-rw

# 3. Repoint DATABASE_URL at the pooler.
POOLER_URL="postgresql://shogo:<password>@platform-pg-pooler-rw.${NS}:5432/shogo"
kubectl --context "$CTX" -n "$NS" patch secret postgres-credentials \
  --type merge -p "{\"stringData\":{\"DATABASE_URL\":\"${POOLER_URL}\"}}"

# 4. Apply the api overlay (adds the DATABASE_DIRECT_URL / PRISMA_POOL_SIZE /
#    ADVISORY_LOCK_POOL_SIZE env) and roll a fresh api revision so pods pick up
#    the new secret values.
```

### Validation gate (must pass in staging before any prod region)
- `psql "$POOLER_URL" -c "SHOW POOLS;"` — pools active, `cl_active`/`sv_active`
  sane, no growing `cl_waiting`.
- Exercise prepared statements (normal app traffic) — **no**
  `prepared statement "..." does not exist` errors (transaction pooling gotcha;
  `max_prepared_statements` is set on the pooler to handle this).
- `psql "$DIRECT_URL" -c "SELECT count(*) FROM pg_stat_activity;"` stays well
  under `max_connections`; advisory-lock waiters no longer stack up.
- Warm-pool claim + workspace spawn still serialize (logs show the dedicated
  advisory lock acquired/released; no cold-start storms).

## Secrets Created

Each cluster auto-creates:
- `{cluster}-superuser` - Superuser credentials (`username`, `password`, `uri`)
- `{cluster}-app` - App user credentials (`username`, `password`, `dbname`, `uri`)

## Applying

These manifests are applied by Terraform via `null_resource` during environment deployment.
To apply manually:

```bash
# Staging
kubectl apply -f k8s/cnpg/staging-oci/

# Production US
kubectl apply -f k8s/cnpg/production-oci/

# Production EU
kubectl apply -f k8s/cnpg/production-eu-oci/
```

## Storage

- **OCI OKE**: Uses `oci-bv` block volume StorageClass

## Backup

Continuous backup via Barman to OCI Object Storage (S3-compatible):
- WAL archiving for point-in-time recovery (PITR)
- Scheduled base backups
- Uses OCI Customer Secret Keys for S3-compatible access
