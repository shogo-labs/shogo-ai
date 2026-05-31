# Multi-Region Bidirectional Logical Replication — Rollout Runbook

## Prerequisites

- `kubectl` configured for all 3 OKE clusters (US, EU, India)
- CNPG operator v1.25+ installed on all clusters
- `logical-replicator-credentials` K8s Secret created in `shogo-production-system` namespace in all 3 regions with the same password
- OCI Object Storage buckets created for India (`shogo-pg-backups-production-india`)

## Rollout Procedure

### Step 1: Delete EU and India Replica Clusters

Since production is not live, we destroy the old physical replicas.

```bash
# EU
kubectl --context oke-eu delete cluster platform-pg -n shogo-production-system

# India (if exists)
kubectl --context oke-india delete cluster platform-pg -n shogo-production-system
```

Wait for pods to terminate:

```bash
kubectl --context oke-eu wait --for=delete pod -l cnpg.io/cluster=platform-pg -n shogo-production-system --timeout=120s
kubectl --context oke-india wait --for=delete pod -l cnpg.io/cluster=platform-pg -n shogo-production-system --timeout=120s
```

### Step 2: Upgrade US Cluster to PG 18

Apply the updated US manifest. CNPG will perform a rolling `pg_upgrade`.

```bash
kubectl --context oke-us apply -f k8s/cnpg/production-us/platform-cluster.yaml
```

Monitor the upgrade:

```bash
kubectl --context oke-us get cluster platform-pg -n shogo-production-system -w
```

Wait until all instances report `ready` and PG version shows 18.x:

```bash
kubectl --context oke-us exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -c "SELECT version();"
```

Verify logical replication parameters:

```bash
kubectl --context oke-us exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -c "SHOW wal_level; SHOW track_commit_timestamp;"
```

### Step 3: Create LoadBalancer Services for EU and India

```bash
kubectl --context oke-eu apply -f k8s/cnpg/production-eu/platform-pg-external.yaml
kubectl --context oke-india apply -f k8s/cnpg/production-india/platform-pg-external.yaml
```

Wait for external IPs and note them:

```bash
kubectl --context oke-eu get svc platform-pg-external -n shogo-production-system -w
kubectl --context oke-india get svc platform-pg-external -n shogo-production-system -w
```

**Update the placeholder IPs** in the cluster manifests:

- In `production-us/platform-cluster.yaml`: replace `EU_LB_IP_PLACEHOLDER` and `INDIA_LB_IP_PLACEHOLDER`
- In `production-eu/platform-cluster.yaml`: replace `INDIA_LB_IP_PLACEHOLDER`
- In `production-india/platform-cluster.yaml`: replace `EU_LB_IP_PLACEHOLDER`

Re-apply the US manifest after updating IPs:

```bash
kubectl --context oke-us apply -f k8s/cnpg/production-us/platform-cluster.yaml
```

### Step 4: Create EU and India Standalone PG 18 Clusters

```bash
kubectl --context oke-eu apply -f k8s/cnpg/production-eu/platform-cluster.yaml
kubectl --context oke-india apply -f k8s/cnpg/production-india/platform-cluster.yaml
```

Wait for clusters to be ready:

```bash
kubectl --context oke-eu get cluster platform-pg -n shogo-production-system -w
kubectl --context oke-india get cluster platform-pg -n shogo-production-system -w
```

### Step 5: Run Prisma Migrations on EU and India

```bash
# Port-forward to each cluster's primary
kubectl --context oke-eu port-forward svc/platform-pg-rw 5433:5432 -n shogo-production-system &
kubectl --context oke-india port-forward svc/platform-pg-rw 5434:5432 -n shogo-production-system &

# Run migrations
DATABASE_URL="postgresql://shogo:<password>@localhost:5433/shogo" bunx prisma migrate deploy
DATABASE_URL="postgresql://shogo:<password>@localhost:5434/shogo" bunx prisma migrate deploy

# Kill port-forwards
kill %1 %2
```

### Step 6: Grant Replication Permissions

The GRANT contract is automated. `.github/workflows/deploy.yml` runs
`k8s/cnpg/logical-replication/grants.sql` on every deploy via a
`Reconcile logical replication GRANTs` step in each regional job, then
asserts the contract holds via a follow-up `Verify GRANT contract` step
that fails the deploy if any table in `public` is missing SELECT for
`logical_replicator`. The script installs:

1. A one-time sweep (`GRANT SELECT ON ALL TABLES`) for current state.
2. `ALTER DEFAULT PRIVILEGES FOR ROLE shogo` and `FOR ROLE postgres` so
   future tables created by either role auto-grant on `CREATE TABLE`.
3. An event trigger (`auto_grant_replicator_select`) that fires on every
   `CREATE TABLE` / `CREATE TABLE AS` / `SELECT INTO` in `public`,
   regardless of which role issued the DDL. The GRANT inside the trigger
   is wrapped in `BEGIN/EXCEPTION` so a GRANT failure cannot abort the
   migration.

The regression test in `.github/workflows/ci-cnpg.yml` verifies all three
properties on every PR.

#### The ownership contract (`enforce-table-ownership.sql`)

Migrations run as the unprivileged role `shogo`, and `ALTER TABLE` requires
the issuing role to **own** the table. DDL is not replicated, so each region
creates its own schema locally — normally as `shogo` via
`prisma migrate deploy`, which makes `shogo` the owner. But any ad-hoc
`CREATE TABLE` run as `postgres` on a secondary (e.g. an operator manually
creating a table to unblock a crash-looping apply worker) leaves a
`postgres`-owned table behind. The next migration that `ALTER`s it then fails
with `ERROR: must be owner of table <name>` (SQLSTATE `42501`), marks the
migration failed, and wedges every later deploy with P3009. This happened on
2026-05-31: `affiliate_commission_tiers` and 9 sibling tables were
`postgres`-owned on EU and India.

`k8s/cnpg/logical-replication/enforce-table-ownership.sql` closes that gap the
same way `grants.sql` closes the GRANT gap:

1. A sweep that reassigns every table/sequence in `public` not owned by
   `shogo` back to `shogo` (surgical — never `REASSIGN OWNED BY postgres`).
2. An event trigger (`enforce_table_owner_shogo_trg`, `SECURITY DEFINER`)
   that fires on every `CREATE TABLE` in `public` and reassigns the new table
   to `shogo`, regardless of which role issued the DDL. The reassignment is
   wrapped in `BEGIN/EXCEPTION` so a failure can never abort the migration.

Unlike the GRANT reconcile (which runs *after* migrations), the deploy
workflow runs ownership reconcile + a `Verify ownership contract` assertion
**before** `Run Prisma migrations` in every regional job — the migration
itself needs the ownership to already be correct. CI assertions D/E/F in
`ci-cnpg.yml` verify the sweep, the trigger, and the load-bearing EXCEPTION
handler on every PR.

**For bootstrap of a brand-new cluster** (first time, before the
deploy.yml step has ever run on that cluster), apply both contract SQL files
once manually so they exist before the first migration lands:

```bash
for ctx in oke-us oke-eu oke-india; do
  PRIMARY=$(kubectl --context $ctx get pods -n shogo-production-system \
      -l "cnpg.io/cluster=platform-pg,cnpg.io/instanceRole=primary" \
      -o jsonpath='{.items[0].metadata.name}')
  for sql in enforce-table-ownership grants; do
    kubectl --context $ctx exec -i -n shogo-production-system "$PRIMARY" \
      -c postgres -- psql -U postgres -d shogo \
      < k8s/cnpg/logical-replication/${sql}.sql
  done
done
```

**For incident response** when an existing cluster is in the failure mode
(missing GRANT → tablesync respawn → slot pool saturation), see issue
[#533](https://github.com/shogo-labs/shogo-ai/issues/533) for the full
three-step remediation (GRANT sweep + drop leaked slots + REFRESH
PUBLICATION).

### Step 7: Apply Publication CRDs

```bash
kubectl --context oke-us apply -f k8s/cnpg/production-us/platform-publication.yaml
kubectl --context oke-eu apply -f k8s/cnpg/production-eu/platform-publication.yaml
kubectl --context oke-india apply -f k8s/cnpg/production-india/platform-publication.yaml
```

Verify publications:

```bash
for ctx in oke-us oke-eu oke-india; do
  kubectl --context $ctx exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -d shogo -c "SELECT * FROM pg_publication;"
done
```

### Step 8: Apply Subscription CRDs

```bash
# US subscriptions
kubectl --context oke-us apply -f k8s/cnpg/production-us/sub-from-eu.yaml
kubectl --context oke-us apply -f k8s/cnpg/production-us/sub-from-india.yaml

# EU subscriptions
kubectl --context oke-eu apply -f k8s/cnpg/production-eu/sub-from-us.yaml
kubectl --context oke-eu apply -f k8s/cnpg/production-eu/sub-from-india.yaml

# India subscriptions
kubectl --context oke-india apply -f k8s/cnpg/production-india/sub-from-us.yaml
kubectl --context oke-india apply -f k8s/cnpg/production-india/sub-from-eu.yaml
```

### Step 9: Conflict handling

PostgreSQL 18.3 mainline does **not** ship automatic per-row conflict
resolution for logical replication on the subscriber side. The
`INSERT_EXISTS_ACTION = last_update_wins` parameter that prior versions
of this runbook recommended does not exist (`ALTER SUBSCRIPTION ... SET
(insert_exists_action = ...)` returns `unrecognized subscription
parameter`). When a `conflict=insert_exists`, `update_origin_differs`,
or `update_exists` row arrives, the apply worker logs `ERROR` and
exits — Postgres restarts it ~3s later, it hits the same row, exits,
repeat. This crash-loop pins the slot and stalls every later
transaction in the WAL behind it (incident 2026-05-26 saw 3 GB of
backlog accumulate this way over 15 hours). The choices are:

1. **Resolve the underlying duplicate** (preferred when feasible —
   delete the older/wrong row on the subscriber so the apply succeeds),
   or
2. **Skip the offending transaction** with the LSN reported in the
   error message:

   ```sql
   -- LSN comes from the "finished at <X/Y>" suffix in the apply
   -- worker's ERROR log line.
   ALTER SUBSCRIPTION <sub> SKIP (lsn = '<X/Y>');
   ```

   Each `SKIP` advances the apply worker past exactly one transaction
   and discards every change in it. For tables like `storage_usage`
   where both regions independently write the same workspace ID, this
   is the documented unblock path.

A fast skip-loop using the most recent LSN from `pg_log` is in the
2026-05-26 incident notes; do not extract it into a tool until the
underlying `storage_usage`-style multi-master conflicts are addressed
at the application layer (mark those tables region-local so they don't
ride logical replication at all).

`disable_on_error = true` flips the apply worker from "crash-restart
loop" to "stop on first error and stay disabled until an operator
runs `ALTER SUBSCRIPTION ... ENABLE`". This is the correct default for
production: a stopped subscription is loud (the
`replication-monitor` CronJob alerts on it), a crash-looping one is
silent. Apply once per subscription:

```bash
for ctx in oke-production-us oke-production-eu oke-production-india; do
  PRIMARY=$(kubectl --context "$ctx" get pods -n shogo-production-system \
    -l "cnpg.io/cluster=platform-pg,cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}')
  for sub in sub_from_us sub_from_eu sub_from_india; do
    kubectl --context "$ctx" exec -n shogo-production-system "$PRIMARY" \
      -c postgres -- psql -U postgres -d shogo -c \
      "ALTER SUBSCRIPTION $sub SET (disable_on_error = true);" 2>/dev/null || true
  done
done
```

### Step 10: Verify Subscription Health

```bash
for ctx in oke-us oke-eu oke-india; do
  echo "=== $ctx ==="
  kubectl --context $ctx exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -d shogo -c "
    SELECT subname, pid, received_lsn, latest_end_time
    FROM pg_stat_subscription
    WHERE subname LIKE 'sub_from_%';
  "
done
```

All subscriptions should show a non-null `pid` (streaming).

### Step 11: Update EU/India Secrets to Point to Local DB

```bash
# EU — update postgres-credentials secret
kubectl --context oke-eu -n shogo-production-system create secret generic postgres-credentials \
  --from-literal=DATABASE_URL="postgresql://shogo:<password>@platform-pg-rw.shogo-production-system:5432/shogo" \
  --from-literal=username=shogo \
  --from-literal=password=<password> \
  --dry-run=client -o yaml | kubectl --context oke-eu apply -f -

# India — same pattern
kubectl --context oke-india -n shogo-production-system create secret generic postgres-credentials \
  --from-literal=DATABASE_URL="postgresql://shogo:<password>@platform-pg-rw.shogo-production-system:5432/shogo" \
  --from-literal=username=shogo \
  --from-literal=password=<password> \
  --dry-run=client -o yaml | kubectl --context oke-india apply -f -
```

Restart API pods to pick up new secrets:

```bash
kubectl --context oke-eu rollout restart ksvc/api -n shogo-production-system 2>/dev/null || \
  kubectl --context oke-eu delete pods -l serving.knative.dev/service=api -n shogo-production-system

kubectl --context oke-india rollout restart ksvc/api -n shogo-production-system 2>/dev/null || \
  kubectl --context oke-india delete pods -l serving.knative.dev/service=api -n shogo-production-system
```

### Step 12: Deploy Monitoring

```bash
for ctx in oke-us oke-eu oke-india; do
  kubectl --context $ctx apply -f k8s/cnpg/logical-replication/replication-monitor.yaml
done
```

### Step 13: Run Integration Tests

```bash
DB_URL_US="postgresql://shogo:<pw>@<US_DB_IP>:5432/shogo?sslmode=require" \
DB_URL_EU="postgresql://shogo:<pw>@<EU_LB_IP>:5432/shogo?sslmode=require" \
DB_URL_INDIA="postgresql://shogo:<pw>@<INDIA_LB_IP>:5432/shogo?sslmode=require" \
bun test e2e/replication/
```

All tests should pass. Pay attention to:
- Write propagation tests (< 10s timeout)
- Replication lag test (< 5s)
- Subscription health (all 6 subs streaming)

---

## Rollback Procedure

### Quick Rollback: Re-point APIs to US Primary

If replication is broken but US primary is healthy:

```bash
# EU — revert DATABASE_URL to US primary
kubectl --context oke-eu -n shogo-production-system create secret generic postgres-credentials \
  --from-literal=DATABASE_URL="postgresql://shogo:<password>@<US_DB_IP>:5432/shogo?sslmode=require" \
  --from-literal=username=shogo \
  --from-literal=password=<password> \
  --dry-run=client -o yaml | kubectl --context oke-eu apply -f -

# India — same
kubectl --context oke-india -n shogo-production-system create secret generic postgres-credentials \
  --from-literal=DATABASE_URL="postgresql://shogo:<password>@<US_DB_IP>:5432/shogo?sslmode=require" \
  --from-literal=username=shogo \
  --from-literal=password=<password> \
  --dry-run=client -o yaml | kubectl --context oke-india apply -f -

# Restart pods
kubectl --context oke-eu delete pods -l serving.knative.dev/service=api -n shogo-production-system
kubectl --context oke-india delete pods -l serving.knative.dev/service=api -n shogo-production-system
```

### Full Rollback: Recreate Physical Replicas

If bidirectional replication needs to be completely removed:

1. Drop all subscriptions:

```bash
for ctx in oke-us oke-eu oke-india; do
  for sub in sub_from_us sub_from_eu sub_from_india; do
    kubectl --context $ctx exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -d shogo -c "
      DROP SUBSCRIPTION IF EXISTS $sub;
    " 2>/dev/null || true
  done
done
```

2. Delete EU/India standalone clusters
3. Recreate as physical replicas of US (revert to original manifests)
4. Re-point APIs back to US primary

---

## Schema Evolution: Adding a New Table

The publication is **self-maintaining** — it uses
`CREATE PUBLICATION ... FOR TABLES IN SCHEMA public` (driven by
`tablesInSchema: public` in the CNPG `Publication` CR), so any table created
in the `public` schema is automatically part of the publication on the
publisher side. There is **no per-region YAML to update** when migrations
add a new table.

What still has to happen:

1. `prisma migrate deploy` runs in every region (handled automatically by
   the deploy workflow — US via the API pod entrypoint, EU/India via
   `kubectl run prisma-migrate-*` jobs in `.github/workflows/deploy.yml`).
   These migrations must succeed in **every** region before any region's API
   ksvc rolls forward; the deploy workflow now treats EU/India migration
   failure as a hard error (was a silent `::warning::` until incident
   2026-05-26).
2. Each subscriber must `ALTER SUBSCRIPTION <name> REFRESH PUBLICATION`
   once after the publisher has applied the migration, so the new table is
   added to its subscription's table set. The deploy workflow does this
   automatically at the end of each region's deploy job
   (`Refresh logical replication subscriptions`).

### Why migrations cannot be skipped on subscribers

Replicating `_prisma_migrations` would let one region's migration row leak
to a peer that hasn't applied the DDL locally yet. Two failure modes
follow:

1. The publisher's seed-DML for the new table (e.g.
   `INSERT INTO affiliate_commission_tiers VALUES ...`) reaches the
   subscriber, finds the table missing locally, and crash-loops the apply
   worker — pinning the slot and stalling every other write in WAL behind
   it.
2. Even without seed-DML, the subscriber's own `prisma migrate deploy`
   sees a `_prisma_migrations` row with `finished_at` filled in (replicated
   from the publisher's UPDATE) and **skips applying the DDL locally**.
   The subscriber is then silently a schema behind, with a "successful"
   tracking row covering it up.

The fix in `k8s/cnpg/logical-replication/skip-replicated-migrations.sql`
installs a `BEFORE INSERT/UPDATE/DELETE` trigger on `_prisma_migrations`
in `ENABLE REPLICA TRIGGER` mode. It returns NULL — discarding any change
that arrives via the apply worker — while leaving local
`prisma migrate deploy` writes untouched. Each region's
`_prisma_migrations` then reflects only that region's own migration
history, which is what Prisma assumes. Applied on every deploy alongside
`grants.sql`.

If a region's deploy fails between migration and refresh, or two regions'
parallel deploys race so a refresh runs before the peer's migration, the
hourly `replication-monitor` CronJob will log a `Subscription Refresh
Staleness` warning. The fix is one command per stale subscription:

```bash
kubectl --context <ctx> exec -n shogo-production-system platform-pg-1 -c postgres -- \
  psql -U postgres -d shogo -c "ALTER SUBSCRIPTION <subname> REFRESH PUBLICATION;"
```

### Do not revert the publication to a hand-listed table set

The CI guard `bun run check:publication` rejects any PR that puts
`- table: { name: ... }` entries back into the publication YAML. The
hand-list is what caused incident #501 (api_keys + 25 other tables silently
absent from EU/India for weeks). The shape is intentionally non-negotiable.

## Monitoring Queries

Run these on any region to check health:

```sql
-- Subscription status
SELECT subname, pid, received_lsn, latest_end_time
FROM pg_stat_subscription
WHERE subname LIKE 'sub_from_%';

-- Conflict stats (PG 18)
SELECT subname, apply_error_count, sync_error_count
FROM pg_stat_subscription_stats
WHERE subname LIKE 'sub_from_%';

-- Replication slot health
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_lag
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- Table row counts (sanity check across regions)
SELECT 'users' AS tbl, count(*) FROM users
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'projects', count(*) FROM projects
UNION ALL SELECT 'workspaces', count(*) FROM workspaces;
```
