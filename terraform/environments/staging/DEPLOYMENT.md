# Staging Environment Deployment Guide

## Quick Start

### Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Terraform** >= 1.5.0
3. **kubectl** for cluster access
4. **SigNoz endpoint** (see SIGNOZ_SETUP.md for options)

### Initial Deployment

```bash
# 1. Navigate to staging environment
cd terraform/environments/staging

# 2. Copy and configure variables
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars with your values:
# - better_auth_secret (required)
# - signoz_endpoint (required if enable_signoz=true)
# - anthropic_api_key (optional)
# - domain names (optional)

# 3. Initialize Terraform
terraform init

# 4. Review planned changes
terraform plan

# 5. Deploy infrastructure
terraform apply

# 6. Configure kubectl
eval $(terraform output -raw kubeconfig_command)

# 7. Verify deployment
kubectl get nodes
kubectl get pods -n shogo-staging-system
kubectl get pods -n shogo-staging-workspaces
kubectl get pods -n signoz  # If SigNoz enabled
```

## SigNoz Monitoring Setup

### Option 1: SigNoz Cloud (Recommended)

1. Sign up at https://signoz.io/teams/
2. Get your OTLP endpoint (e.g., `ingest.us.signoz.cloud:443`)
3. Update `terraform.tfvars`:
   ```hcl
   enable_signoz = true
   signoz_endpoint = "ingest.us.signoz.cloud:443"
   ```
4. Apply changes: `terraform apply`

### Option 2: Self-Hosted in Cluster

1. Deploy SigNoz backend:
   ```bash
   helm repo add signoz https://charts.signoz.io
   helm repo update

   kubectl create namespace signoz-backend

   helm install signoz signoz/signoz \
     --namespace signoz-backend \
     --set clickhouse.persistence.size=10Gi
   ```

2. Update `terraform.tfvars`:
   ```hcl
   enable_signoz = true
   signoz_endpoint = "http://signoz-otel-collector.signoz-backend.svc.cluster.local:4317"
   ```

3. Apply changes: `terraform apply`

### Verify SigNoz Deployment

```bash
# Check collector pods
kubectl get pods -n signoz

# Check logs
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra --tail=50

# Verify data export
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra | grep "Exporting"

# Access SigNoz dashboard
# SigNoz Cloud: https://signoz.io/teams/
# Self-hosted:  kubectl port-forward -n signoz-backend svc/signoz-frontend 3301:3301
```

## Post-Deployment

### Access Services

```bash
# Get service URLs
terraform output domains

# Port-forward for local testing
kubectl port-forward -n shogo-staging-system svc/studio 3000:80
kubectl port-forward -n shogo-staging-system svc/api 8002:8002
```

### Deploy Applications

Application deployment happens via GitHub Actions or kubectl. The Terraform infrastructure is ready.

### Monitor Resources

```bash
# Check cluster resources
kubectl top nodes
kubectl top pods -n shogo-staging-system
kubectl top pods -n shogo-staging-workspaces

# Check SigNoz collectors
kubectl top pods -n signoz
```

## Updates

### Updating SigNoz

```bash
# Update chart version in terraform.tfvars or use latest
terraform apply

# Or manually update Helm release
helm upgrade signoz-k8s-infra signoz/k8s-infra \
  --namespace signoz \
  --reuse-values
```

### Updating Infrastructure

```bash
# Pull latest Terraform code
git pull

# Review changes
terraform plan

# Apply updates
terraform apply
```

## Troubleshooting

### SigNoz Not Collecting Data

See detailed troubleshooting in [SIGNOZ_SETUP.md](./SIGNOZ_SETUP.md#troubleshooting)

### EKS Access Issues

```bash
# Update kubeconfig
aws eks update-kubeconfig --region us-east-1 --name shogo-staging

# Verify access
kubectl auth can-i '*' '*'
```

### High Costs

```bash
# Check node count
kubectl get nodes

# Scale down if needed
terraform apply -var="node_desired_size=1" -var="node_min_size=1"

# Disable SigNoz to save ~$15/month
terraform apply -var="enable_signoz=false"
```

## Cost Estimate

| Resource | Type | Monthly Cost |
|----------|------|--------------|
| EKS Control Plane | - | $73 |
| EC2 Nodes (2x t3.medium) | On-Demand | $60 |
| RDS (db.t3.micro) | Single-AZ | $15 |
| ElastiCache (cache.t3.micro) | Single-AZ | $15 |
| NAT Gateway | Single | $45 |
| SigNoz Collectors | Pods (logs disabled) | $12 |
| **Total** | | **~$220/month** |

> **Note**: SigNoz cost is with logs disabled (default). Add ~$8/month if logs are enabled.

## Cleanup

To destroy all infrastructure:

```bash
# WARNING: This will delete everything!
terraform destroy

# If you want to keep data, backup RDS first:
aws rds create-db-snapshot \
  --db-instance-identifier shogo-staging \
  --db-snapshot-identifier shogo-staging-final-snapshot
```

## References

- [Main README](../../../README.md)
- [SigNoz Setup Guide](./SIGNOZ_SETUP.md)
- [Production Deployment](../production/README.md)
- [Terraform Documentation](https://www.terraform.io/docs)
