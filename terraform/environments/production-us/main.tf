# =============================================================================
# Shogo — Production US (Tier 1 Primary)
# =============================================================================
# Full region: OKE + CNPG (primary) + Object Storage + File Storage
# Region: us-ashburn-1 | CIDR: 10.0.0.0/16
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }

  # Remote state on OCI Object Storage (S3-compat).
  # Endpoint is supplied via -backend-config at `terraform init` time:
  #   terraform init -backend-config="endpoint=$OCI_S3_ENDPOINT"
  # Credentials come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY env vars
  # (see GH secrets OCI_S3_ACCESS_KEY / OCI_S3_SECRET_KEY).
  backend "s3" {
    bucket = "shogo-tfstate"
    key    = "production-us/terraform.tfstate"
    region = "us-ashburn-1"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    force_path_style            = true
  }
}

# =============================================================================
# Providers
# =============================================================================

provider "oci" {
  tenancy_ocid     = var.tenancy_id
  user_ocid        = var.oci_user_ocid
  fingerprint      = var.oci_fingerprint
  private_key_path = var.oci_private_key_path
  region           = "us-ashburn-1"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "oci_containerengine_cluster_kube_config" "main" {
  cluster_id = module.us.cluster_id
}

provider "kubernetes" {
  host                   = module.us.cluster_endpoint
  cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "oci"
    args        = ["ce", "cluster", "generate-token", "--cluster-id", module.us.cluster_id, "--region", "us-ashburn-1"]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.us.cluster_endpoint
    cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "oci"
      args        = ["ce", "cluster", "generate-token", "--cluster-id", module.us.cluster_id, "--region", "us-ashburn-1"]
    }
  }
}

# =============================================================================
# Region Module — Tier 1 (Full)
# =============================================================================

module "us" {
  source = "../../modules/oci-region"

  tier        = "full"
  region      = "us-ashburn-1"
  region_key  = "us"
  environment = "production"
  vcn_cidr    = "10.0.0.0/16"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id

  # Network access controls — sourced from GH env vars
  # (TF_VAR_oke_api_allowed_cidrs, TF_VAR_nfs_allowed_cidr).
  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  nfs_allowed_cidr      = var.nfs_allowed_cidr

  # ARM64 custom OKE image (A4 Flex) — AD-1 to match existing PVs
  image_id           = "ocid1.image.oc1.iad.aaaaaaaaxlqapo7gpvnvfndkhfnixrnvlumdgaexjvakamdmhiegulsypa5a"
  placement_ad_names = ["XYpk:US-ASHBURN-AD-1"]

  # System nodes (API, web, CNPG, Knative controllers)
  #
  # 2026-05-20 production-us reconciliation:
  #
  # The b11c65dd publish incident traced back to the cluster running
  # on a SINGLE node (kubectl --context oke-production-us get nodes)
  # despite this terraform declaring `system_pool_min = 2`. The result
  # was 99% memory utilization, a Knative pod scaled-to-zero waiting
  # 60+ seconds for a memory window, and the warm-pool GC simultaneously
  # deleting in-flight publish ksvcs. See docs/runbooks/deploy-prod.md.
  #
  # Two changes here:
  #   1. `system_pool_min` 2 -> 3. A deploy churns ~30 warm-pool pods
  #      simultaneously; the system pool needs spare capacity to absorb
  #      that churn without `Insufficient memory` for paying users.
  #   2. `system_pool_size` 2 -> 3 to match `min`. (terraform `size` is
  #      the desired count, autoscaler manages above this floor.)
  #
  # 2026-06-02 rollout-headroom bump (run 26865807851): `min` 3 -> 4 (and
  # `size` to match) so there is always one warm, already-prepulled spare
  # node beyond steady-state. A new revision's `min-scale: 2` api pods then
  # land on that warm node instead of forcing the autoscaler to provision a
  # COLD node mid-rollout (the cold-pull-mid-rollout failure class). This
  # value MUST match the live floor: GitHub Actions variable NODE_POOL_MIN
  # for environment production-us (consumed by deploy.yml "Deploy Cluster
  # Autoscaler"). terraform `min`/`max` here are the source of truth for
  # that var; the autoscaler `--nodes` flag is what enforces it live.
  system_node_ocpus     = 4
  system_node_memory_gb = 24
  system_pool_size      = 4
  system_pool_min       = 4
  system_pool_max       = 15

  # Live US nodes are already 200 GB (matches the module default). Stated
  # explicitly so the cross-region parity check has a US baseline to compare
  # EU/India against (see .github/scripts/check-node-disk-parity.sh).
  system_node_boot_volume_gb = 200

  enable_workload_pool = false

  # Autoscaler IAM (tenancy-level — only enable in primary region)
  create_autoscaler_iam = true

  # Observability
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  # Cloudflare (for publish-hosting)
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id

  # =============================================================
  # Live-state overrides (production-us reconciliation, 2026-05)
  # =============================================================

  # Live node pool was bootstrapped as `shogo-prod-us-arm-4ocpu`
  # at max_pods_per_node = 93 (not the module's default 110), and
  # without NSGs attached (live cluster endpoint shows `nsg-ids: []`).
  # See the staging reconciliation for the equivalent pattern.
  oke_main_node_pool_name_override = "shogo-prod-us-arm-4ocpu"
  oke_main_node_pool_max_pods      = 93

  # Cluster + node pool live without NSGs; keep tf from trying to
  # attach the module-default NSGs (which would replace nothing in
  # practice since OKE security comes from subnet security lists,
  # but the empty-to-default switch would still cause plan churn).
  vcn_enable_oke_nsgs = false

  # VCN has module-owned security lists already in state (`public`
  # and `private`) — keep them enabled to match the existing imports.
  vcn_enable_security_lists = true

  # Production-us was bootstrapped with a separate /28 subnet for the
  # OKE Kubernetes API endpoint (live cidr 10.0.0.0/28). That subnet
  # is already in state as `oci_core_subnet.api_endpoint[0]`. Without
  # this flag, the module would not declare the resource and tf would
  # destroy it (which would also force the OKE cluster to be replaced
  # because its endpoint_config.subnet_id points at this subnet).
  vcn_enable_dedicated_api_subnet = true
  vcn_api_endpoint_cidr           = "10.0.0.0/28"

  # OCIR has 7 repos live (the module's 4-repo default would destroy 3).
  ocir_repositories = [
    "agent-runtime",
    "project-runtime",
    "shogo-api",
    "shogo-docs",
    "shogo-runtime",
    "shogo-runtime-base",
    "shogo-web",
  ]

  # Knative + Kourier + CNPG are all installed live in the
  # us-ashburn-1 cluster (kubectl shows knative-serving,
  # kourier-system, cnpg-system namespaces, all 55+ days old). Skip
  # the installer null_resources so plans stay quiet.
  knative_manage_install = false
  cnpg_manage_install    = false

  # The tenancy-scoped `objectstorage-<region> manage object-family`
  # IAM policy is owned by the staging env's tf state. Don't
  # recreate it here.
  object_storage_lifecycle_service_policy_compartment_id = null

  # Production-us owns the bare `*.shogo.one` wildcard (staging
  # migrates to `*.staging.shogo.one` as part of the same change).
  # Enable publish-hosting explicitly; the data source resolves the
  # publish zone by name so no explicit zone_id is needed.
  enable_publish_hosting = true
  publish_zone           = null # defaults to publish_domain="shogo.one"

  # Bring-your-own custom hostnames (Cloudflare for SaaS). Off until a
  # DEDICATED zone (separate from shogo.one) is supplied — see variables.tf.
  enable_custom_domains = var.enable_custom_domains
  custom_domains_zone   = var.custom_domains_zone
}

# =============================================================================
# Cross-Region Peering (DRG)
# US is the requestor — EU and India accept using this RPC ID
# =============================================================================

# =============================================================================
# Cross-region peering and replication
#
# DEFERRED to the EU / India reconciliation follow-up sessions. The DRG
# resources are regionally local and could be created standalone, but
# `object-storage-replication` needs destination buckets in
# eu-frankfurt-1 to exist first, and there's no value in creating the
# DRG + RPC half-attachments without a peer to accept them. Each module
# is gated behind a flag so the EU session can flip a single bool when
# the time comes.
# =============================================================================

variable "enable_drg_peering_to_eu" {
  description = "Create the DRG + VCN attachment + RPC for peering to production-eu. Defaults to false until production-eu is brought up."
  type        = bool
  default     = false
}

variable "enable_drg_peering_to_india" {
  description = "Create the DRG + VCN attachment + RPC for peering to production-india. Defaults to false until production-india is brought up."
  type        = bool
  default     = false
}

variable "enable_replication_to_eu" {
  description = "Create cross-region Object Storage replication policies (US -> EU). Requires destination buckets to exist in eu-frankfurt-1. Defaults to false."
  type        = bool
  default     = false
}

module "drg_to_eu" {
  count  = var.enable_drg_peering_to_eu ? 1 : 0
  source = "../../modules/drg-peering"

  name           = "shogo-production-us"
  compartment_id = var.compartment_id
  vcn_id         = module.us.vcn_id
  peer_region    = "eu-frankfurt-1"
}

module "drg_to_india" {
  count  = var.enable_drg_peering_to_india ? 1 : 0
  source = "../../modules/drg-peering"

  name           = "shogo-production-us"
  compartment_id = var.compartment_id
  vcn_id         = module.us.vcn_id
  peer_region    = "ap-mumbai-1"
}

module "replication_to_eu" {
  count  = var.enable_replication_to_eu ? 1 : 0
  source = "../../modules/object-storage-replication"

  compartment_id     = var.compartment_id
  environment        = "production"
  destination_region = "eu-frankfurt-1"
}

# =============================================================================
# Outputs
# =============================================================================

output "cluster_endpoint" { value = module.us.cluster_endpoint }
output "cluster_id"       { value = module.us.cluster_id }
output "ocir_prefix"      { value = module.us.ocir_prefix }
output "s3_endpoint"      { value = module.us.s3_endpoint }
output "rpc_eu_id" {
  value = var.enable_drg_peering_to_eu ? module.drg_to_eu[0].rpc_id : null
}
output "rpc_india_id" {
  value = var.enable_drg_peering_to_india ? module.drg_to_india[0].rpc_id : null
}

# Custom domains (null unless enable_custom_domains=true). Feed these into the
# `custom-domains-config` secret for the production-us api namespace.
output "custom_domains_zone_id" { value = module.us.custom_domains_zone_id }
output "custom_domains_kv_namespace_id" { value = module.us.custom_domains_kv_namespace_id }
output "custom_domain_fallback_origin" { value = module.us.custom_domain_fallback_origin }
