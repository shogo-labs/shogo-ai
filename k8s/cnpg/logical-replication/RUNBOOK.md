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

On each region's primary, grant the `logical_replicator` role SELECT on all tables:

```bash
for ctx in oke-us oke-eu oke-india; do
  kubectl --context $ctx exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -d shogo -c "
    GRANT USAGE ON SCHEMA public TO logical_replicator;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO logical_replicator;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO logical_replicator;
  "
done
```

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

### Step 9: Enable PG 18 Conflict Resolution

After subscriptions are created and initial sync completes, enable `INSERT_EXISTS_ACTION`:

```bash
for ctx in oke-us oke-eu oke-india; do
  for sub in sub_from_us sub_from_eu sub_from_india; do
    kubectl --context $ctx exec -n shogo-production-system platform-pg-1 -c postgres -- psql -U postgres -d shogo -c "
      ALTER SUBSCRIPTION $sub SET (INSERT_EXISTS_ACTION = last_update_wins);
    " 2>/dev/null || true
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
