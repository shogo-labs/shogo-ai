# CloudNativePG Cluster Manifests

PostgreSQL clusters managed by the CloudNativePG operator.

## Architecture

Currently only the **platform-pg** cluster is deployed. A future **projects-pg**
cluster is planned but not yet implemented — dev projects use SQLite and
published-app PostgreSQL provisioning is still on the roadmap.

### Platform Cluster (`platform-pg`) — **active**
- Replaces AWS RDS for the platform database
- HA with automated failover (2-3 instances)
- Continuous backup to S3/MinIO via Barman
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

## Secrets Created

Each cluster auto-creates:
- `{cluster}-superuser` - Superuser credentials (`username`, `password`, `uri`)
- `{cluster}-app` - App user credentials (`username`, `password`, `dbname`, `uri`)

## Applying

These manifests are applied by Terraform via `null_resource` during environment deployment.
To apply manually:

```bash
# Staging
kubectl apply -f k8s/cnpg/staging/

# Production
kubectl apply -f k8s/cnpg/production/
```

## Storage

- **EKS**: Uses `gp3` EBS volumes (StorageClass: `ebs-sc`)
- **Bare metal**: Uses `local-path` or `openebs-hostpath`

## Backup

Continuous backup via Barman to S3-compatible storage:
- WAL archiving for point-in-time recovery (PITR)
- Scheduled base backups
- Works with both AWS S3 and self-hosted MinIO
