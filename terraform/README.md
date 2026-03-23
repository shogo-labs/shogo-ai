# Shogo Infrastructure - Terraform

This directory contains Terraform modules for deploying Shogo AI platform on OCI (Oracle Cloud Infrastructure).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       OCI (Oracle Cloud)                        │
├─────────────────────────────────────────────────────────────────┤
│  OKE Cluster (per region)                                       │
│  ├── shogo-*-system namespace                                   │
│  │   ├── API (Knative Service)                                  │
│  │   ├── Studio (Knative Service)                               │
│  │   ├── PostgreSQL (CloudNativePG)                             │
│  │   └── Redis                                                  │
│  │                                                              │
│  └── shogo-*-workspaces namespace                               │
│      └── Agent runtime pods (Knative Services per workspace)    │
│                                                                 │
│  Supporting Services:                                           │
│  ├── OCIR (Container Registry)                                  │
│  ├── OCI Object Storage (S3-compatible)                         │
│  ├── Knative Serving + Kourier (ingress)                        │
│  ├── CloudNativePG (PostgreSQL operator)                        │
│  └── SignOz k8s-infra (observability)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Regions

| Region | Cluster | Purpose |
|--------|---------|---------|
| us-ashburn-1 | shogo-staging | Staging environment |
| us-ashburn-1 | shogo-production | Primary production |
| eu-frankfurt-1 | shogo-production-eu | EU production |
| ap-mumbai-1 | shogo-production-india | India production |

## Prerequisites

- [Terraform](https://terraform.io) >= 1.5.0
- [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm) configured
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

## Module Structure

```
terraform/
├── modules/
│   ├── vcn/              # Virtual Cloud Network
│   ├── oke/              # OKE cluster, node pools
│   ├── ocir/             # OCI Container Registry
│   ├── object-storage/   # OCI Object Storage buckets
│   ├── file-storage/     # OCI File Storage
│   ├── cnpg/             # CloudNativePG operator + clusters
│   ├── knative-oci/      # Knative Serving + Kourier
│   ├── signoz/           # SignOz k8s-infra observability
│   ├── publish-hosting-oci/ # Published app hosting
│   ├── oci-region/       # Region-level module (composes above)
│   ├── oci-github-oidc/  # GitHub OIDC for CI/CD
│   ├── oci-autoscaler-iam/ # Cluster autoscaler IAM
│   └── drg-peering/      # Cross-region DRG peering
│
├── environments/
│   ├── staging/          # Staging environment
│   ├── production-us/    # US production
│   ├── production-eu/    # EU production
│   └── production-india/ # India production
│
└── README.md
```

## State Management

Terraform state is stored locally (`backend "local"`). State files are
gitignored. If you need to manage existing infrastructure, use `terraform import`
to bootstrap state from the live resources.

## Configuration

See `environments/*/variables.tf` for configurable options per environment.

Key variables:
- `region` - OCI region
- `cluster_name` - OKE cluster name
- `node_shape` - OCI compute shape for nodes
- `signoz_endpoint` - SignOz Cloud ingestion endpoint
- `signoz_ingestion_key` - SignOz API key

## Related Documentation

- [Production Access Guide](../docs/production-access.md)
- [CNPG Manifests](../k8s/cnpg/README.md)
