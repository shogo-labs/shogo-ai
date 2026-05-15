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
  system_node_ocpus     = 4
  system_node_memory_gb = 24
  system_pool_size      = 2
  system_pool_min       = 2
  system_pool_max       = 15

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
}

# =============================================================================
# Cross-Region Peering (DRG)
# US is the requestor — EU and India accept using this RPC ID
# =============================================================================

module "drg_to_eu" {
  source = "../../modules/drg-peering"

  name           = "shogo-production-us"
  compartment_id = var.compartment_id
  vcn_id         = module.us.vcn_id
  peer_region    = "eu-frankfurt-1"
}

module "drg_to_india" {
  source = "../../modules/drg-peering"

  name           = "shogo-production-us"
  compartment_id = var.compartment_id
  vcn_id         = module.us.vcn_id
  peer_region    = "ap-mumbai-1"
}

# =============================================================================
# Object Storage Replication (US → EU)
# EU is the only Tier 1 replica; India (Tier 2) reads from US directly
# =============================================================================

module "replication_to_eu" {
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
output "rpc_eu_id"        { value = module.drg_to_eu.rpc_id }
output "rpc_india_id"     { value = module.drg_to_india.rpc_id }
