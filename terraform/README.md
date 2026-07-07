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

| Region | Cluster | Environment Dir | Status |
|--------|---------|-----------------|--------|
| us-ashburn-1 | shogo-staging | `staging/` | Reconciled (no-op plan) |
| us-ashburn-1 | shogo-production | `production-us/` | Reconciled (no-op plan) |
| eu-frankfurt-1 | shogo-production-eu | `production-eu/` | Pending reconciliation |
| (global) | — | `production-global/` | Pending reconciliation |

> `ap-mumbai-1` (`shogo-production-india`) was permanently decommissioned on
> 2026-07-07 — all traffic and data ownership migrated to `eu-frankfurt-1`.
> See `docs/runbooks/india-to-eu-migration.md`.

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
│   ├── staging/          # Staging (us-ashburn-1)
│   ├── production-us/    # US production (us-ashburn-1, primary)
│   ├── production-eu/    # EU production (eu-frankfurt-1)
│   └── production-global/# Cross-region Cloudflare LB + global DNS
│
└── README.md
```

> Note: the legacy `environments/production/` directory was the single-region
> production layout that predated the us/eu/india split. It used a local
> backend and was never wired into the `terraform.yml` workflow; it was
> removed in May 2026 once `production-us/` reached a no-op plan.

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

## Plan / Apply Workflow

Production environments are driven by the `terraform.yml` GitHub Actions
workflow (`.github/workflows/terraform.yml`):

```bash
# Dispatch a plan
gh workflow run terraform.yml --ref main \
  -f environment=production-us -f action=plan

# After reviewing the plan, dispatch an apply
gh workflow run terraform.yml --ref main \
  -f environment=production-us -f action=apply
```

The workflow:
1. Configures OCI CLI from `OCI_*` GitHub secrets
2. Configures kubectl context against the env's OKE cluster (used by the
   `kubernetes` + `helm` providers for in-cluster resources like SigNoz
   namespaces, CNPG namespaces, Knative installs)
3. Runs `terraform init` against the OCI S3-compat backend
4. Runs the requested action with `TF_VAR_*` env vars sourced from
   per-environment GitHub variables (`COMPARTMENT_ID`, `NFS_ALLOWED_CIDR`)
   and repo-scoped secrets (`CLOUDFLARE_API_TOKEN`)

## State Reconciliation (adoption pattern)

The `production-us/` env was bootstrapped manually (cluster, VCN, buckets
all created out-of-band) and then partially imported into tf state. To
get to a no-op plan, several module-level changes were made so adopted
infrastructure isn't force-replaced:

- VCN module: `lifecycle.ignore_changes` for `display_name`, `dns_label`,
  `cidr_block` on all subnets (immutable in OCI), and for
  `ingress_security_rules` / `egress_security_rules` on security lists
  (so live rules added out-of-band — e.g. the API endpoint's port 6443
  ingress — aren't pruned).
- OKE module: `ignore_changes` for `endpoint_config`,
  `service_lb_subnet_ids`, `node_metadata`, `node_config_details[0].size`,
  and `node_config_details[0].placement_configs`. Autoscaler owns runtime
  pool size; OCI sometimes rebalances placement; endpoint config is
  immutable.
- New `enable_dedicated_api_subnet` flag on the VCN module so envs with
  a separate /28 API endpoint subnet (production-us) can declare it.
- New `oci_region` composite pass-through variables: `vcn_enable_*`,
  `oke_main_node_pool_*`, `knative_manage_install`, `cnpg_manage_install`,
  `object_storage_*_compartment_id`, `publish_zone`, `ocir_repositories`,
  etc. Defaults match greenfield behavior; adopted envs set them.

The same pattern can be reused when adopting `production-eu` and
`production-global` — follow the iteration loop of plan → diff → set
per-env override → repeat until plan is clean.

## Boot volume remediation

`system_node_boot_volume_gb` must be **200 GB and identical across all
production regions**. EU was bootstrapped at 100 GB, which caused the
2026-06-02 EU DiskPressure incident: ~30 GB of stacked 8 GB runtime images
pushed the busiest 100 GB nodes past the kubelet DiskPressure threshold,
triggering pod eviction + image GC, warm-pool churn, and a stuck `api`
rollout (`ProgressDeadlineExceeded`).

The OKE module **ignores in-place changes** to
`node_source_details[0].boot_volume_size_in_gbs` (a boot-volume change forces
a rolling node replacement; the ignore protects already-bootstrapped pools
from surprise replacement). So bumping `system_node_boot_volume_gb` in an env
will **not** apply on its own. To remediate a region that is below 200 GB:

1. Confirm the live drift (and that CI's parity check is failing):
   `EXPECTED_GB=200 COMPARTMENT_ID=<id> .github/scripts/check-node-disk-parity.sh`
2. Update the node pool's boot volume out-of-band (does not affect running nodes):
   `oci ce node-pool update --node-pool-id <ocid> --node-source-details '{"sourceType":"IMAGE","imageId":"<id>","bootVolumeSizeInGBs":200}'`
3. Cycle nodes so they re-provision at 200 GB — drain + terminate a few at a
   time (cordon, `kubectl drain`, then terminate the instance so the autoscaler
   replaces it), watching `DiskPressure` and warm-pool readiness between batches.
4. Re-run the parity check to confirm green.

Day-to-day disk safety is additionally guarded at deploy time by
`.github/scripts/check-node-disk-headroom.sh` (a pre-rollout gate) and at
runtime by the `DiskPressure` check in `k8s/base/warm-pool-monitor.yaml`.

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
