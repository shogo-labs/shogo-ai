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

Terraform state is stored remotely on **OCI Object Storage** (S3-compat) in the
`shogo-tfstate` bucket (`us-ashburn-1`, versioning enabled). One key per
environment: `<env>/terraform.tfstate`.

The backend is configured via the `s3` backend in each environment's `main.tf`,
with the OCI namespace endpoint passed in at `terraform init` time:

```bash
export AWS_ACCESS_KEY_ID=$OCI_S3_ACCESS_KEY      # GH secret
export AWS_SECRET_ACCESS_KEY=$OCI_S3_SECRET_KEY  # GH secret
export OCI_S3_ENDPOINT=https://idin4oltblww.compat.objectstorage.us-ashburn-1.oraclecloud.com

cd terraform/environments/staging
terraform init -backend-config="endpoint=$OCI_S3_ENDPOINT"
terraform plan
```

The credentials are S3-compatible OCI Customer Secret Keys associated with the
existing `shogo-production-s3` IAM key (also used by the application for
Object Storage access). They are stored in GitHub as repo-level secrets
(`OCI_S3_ACCESS_KEY`, `OCI_S3_SECRET_KEY`) and exposed to CI as the standard
`AWS_*` env vars the `s3` backend expects.

If you need to manage existing infrastructure that isn't yet tracked, use
`terraform import` to bootstrap state from the live resources.

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
