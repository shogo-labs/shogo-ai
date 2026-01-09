# Shogo Infrastructure - Terraform

This directory contains Terraform modules for deploying Shogo AI platform on Kubernetes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       AWS (Version 1)                            │
├─────────────────────────────────────────────────────────────────┤
│  EKS Cluster                                                     │
│  ├── shogo-system namespace                                      │
│  │   ├── shogo-web (Deployment)                                  │
│  │   ├── shogo-api (Deployment)                                  │
│  │   └── workspace-operator (Deployment)                         │
│  │                                                               │
│  └── shogo-workspaces namespace                                  │
│      └── mcp-{workspace} (Knative Service per workspace)         │
│          └── PVC (persistent storage)                            │
│                                                                  │
│  Supporting Services:                                            │
│  ├── RDS PostgreSQL (shared database)                            │
│  ├── ALB (ingress)                                               │
│  └── ECR (container images)                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- [Terraform](https://terraform.io) >= 1.5.0
- [AWS CLI](https://aws.amazon.com/cli/) configured
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

### Deploy to Dev

```bash
cd environments/dev
terraform init
terraform plan
terraform apply
```

### Connect to Cluster

```bash
aws eks update-kubeconfig --name shogo-dev --region us-west-2
kubectl get nodes
```

## Module Structure

```
terraform/
├── modules/
│   ├── vpc/           # VPC, subnets, NAT gateway
│   ├── eks/           # EKS cluster, node groups, addons
│   ├── rds/           # PostgreSQL database
│   ├── ecr/           # Container registries
│   └── knative/       # Knative Serving installation
│
├── environments/
│   ├── dev/           # Development environment
│   ├── staging/       # Staging environment
│   └── prod/          # Production environment
│
└── README.md
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `AWS_ACCESS_KEY_ID` | AWS access key | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Yes |
| `AWS_REGION` | AWS region | Yes (default: us-west-2) |

### Terraform Variables

See `environments/dev/variables.tf` for all configurable options.

Key variables:
- `cluster_name` - EKS cluster name
- `node_instance_types` - EC2 instance types for nodes
- `use_spot_instances` - Use spot instances (cost savings)

## Cost Estimates

| Environment | Monthly Cost |
|-------------|--------------|
| Dev (minimal) | ~$200 |
| Staging | ~$400 |
| Production | ~$800+ |

See [TECH_SPEC_POD_PER_WORKSPACE.md](../docs/infrastructure/TECH_SPEC_POD_PER_WORKSPACE.md) for detailed cost analysis.

## Future Cloud Support

This infrastructure is designed to be portable:

| Cloud | Status | Module |
|-------|--------|--------|
| AWS | ✅ v1 | `modules/eks` |
| GCP | 🔜 v2 | `modules/gke` (planned) |
| Azure | 🔜 v2 | `modules/aks` (planned) |
| Self-hosted | 🔜 v2 | `modules/k3s` (planned) |

## Related Documentation

- [Technical Specification](../docs/infrastructure/TECH_SPEC_POD_PER_WORKSPACE.md)
- [Local Development](../docker-compose.yml)
- [Architecture Overview](../docs/ARCHITECTURE.md)

