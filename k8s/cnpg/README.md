# CloudNativePG Cluster Manifests

PostgreSQL clusters managed by the CloudNativePG operator.

## Architecture

Two separate clusters provide isolation between platform and project data:

- **platform-pg**: Platform database (users, workspaces, sessions, billing)
- **projects-pg**: All user project databases (one database per project)

## Clusters

### Platform Cluster (`platform-pg`)
- Replaces AWS RDS for the platform database
- HA with automated failover (2-3 instances)
- Continuous backup to S3/MinIO via Barman
- Used by: API, MCP, Auth services

### Projects Cluster (`projects-pg`)
- Replaces per-project PostgreSQL sidecars
- One database per project (`project_{uuid}`)
- Connection pooling via PgBouncer (built-in)
- Used by: Project runtime pods, published apps

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
