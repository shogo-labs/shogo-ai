# =============================================================================
# Shogo — Production India (Tier 2 Lightweight)
# =============================================================================
# Compute only: OKE + Knative. No local database or object storage.
# Connects to US primary for all data operations.
# Region: ap-mumbai-1 | CIDR: 10.2.0.0/16
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
    # India doesn't manage any Cloudflare resources directly (tier=light,
    # no publish-hosting), but the `oci-region` composite transitively
    # requires the provider so a config block is required.
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
    key    = "production-india/terraform.tfstate"
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
  region           = "ap-mumbai-1"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "oci_containerengine_cluster_kube_config" "main" {
  cluster_id = module.india.cluster_id
}

provider "kubernetes" {
  host                   = module.india.cluster_endpoint
  cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "oci"
    args        = ["ce", "cluster", "generate-token", "--cluster-id", module.india.cluster_id, "--region", "ap-mumbai-1"]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.india.cluster_endpoint
    cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "oci"
      args        = ["ce", "cluster", "generate-token", "--cluster-id", module.india.cluster_id, "--region", "ap-mumbai-1"]
    }
  }
}

# =============================================================================
# Region Module — Tier 2 (Light)
# =============================================================================
# No CNPG, no Object Storage, no File Storage, no publish-hosting.
# API pods connect to US primary database via public internet or DRG peering.
# =============================================================================

module "india" {
  source = "../../modules/oci-region"

  tier        = "light" # <-- the key difference
  region      = "ap-mumbai-1"
  region_key  = "in"
  environment = "production"
  vcn_cidr    = "10.2.0.0/16"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id

  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  nfs_allowed_cidr      = var.nfs_allowed_cidr

  # ARM64 custom OKE image (A4 Flex)
  image_id           = "ocid1.image.oc1.ap-mumbai-1.aaaaaaaaifagpks5y3kwx4ks6vjmhb5tfexqvrznf4uq44pnaduyqlysogkq"
  placement_ad_names = ["XYpk:AP-MUMBAI-1-AD-1"]

  # Live pool runs on the older Ampere A1 shape (cluster was bootstrapped
  # before A4 was generally available in ap-mumbai-1). The OCI 8.x
  # provider refuses a shape change from A1 -> A4 against the existing
  # node image with "Invalid nodeShape: Node shape and image are not
  # compatible." Keep India on A1 until a deliberate image swap.
  system_node_shape     = "VM.Standard.A1.Flex"
  system_node_ocpus     = 4
  system_node_memory_gb = 24
  # 2026-06-02 rollout-headroom bump (run 26865807851): `min` 2 -> 3 so
  # there is always one warm, already-prepulled spare node beyond
  # steady-state. A new revision's `min-scale: 2` api pods then land on that
  # warm node instead of forcing the autoscaler to provision a COLD node
  # mid-rollout — India's api revision never achieved initial scale
  # (ProgressDeadlineExceeded) in that run. `size` already 4 (>= min). MUST
  # match the live floor: GitHub Actions variable NODE_POOL_MIN for
  # environment production-india (consumed by deploy.yml "Deploy Cluster
  # Autoscaler").
  system_pool_size = 4
  system_pool_min  = 3
  system_pool_max  = 10

  # 200 GB to match production-us. India is currently LIVE at 100 GB — the
  # same latent exposure that caused the EU 2026-06-02 DiskPressure incident;
  # India simply hasn't tipped over yet (lower workspace load). As with EU,
  # the oke module ignores in-place boot-volume changes, so this needs a
  # one-time controlled node-pool replacement to take effect (see
  # terraform/README.md "Boot volume remediation").
  system_node_boot_volume_gb = 200

  enable_workload_pool = false

  # Data layer points to US primary
  database_primary_endpoint = var.us_database_endpoint
  s3_primary_endpoint       = var.us_s3_endpoint
  s3_primary_region         = "us-ashburn-1"

  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  # No Cloudflare publish-hosting in Tier 2
  # cloudflare_zone_id and cloudflare_account_id left empty

  # =============================================================
  # Live-state overrides (production-india reconciliation, 2026-05)
  # =============================================================

  # Live node pool was bootstrapped as `shogo-prod-india-arm-4ocpu` at
  # max_pods_per_node = 93.
  oke_main_node_pool_name_override = "shogo-prod-india-arm-4ocpu"
  oke_main_node_pool_max_pods      = 93

  # Live cluster has no NSGs attached (endpoint nsg-ids: []).
  vcn_enable_oke_nsgs = false

  # VCN security lists already in state — keep enabled.
  vcn_enable_security_lists = true

  # India was bootstrapped with a dedicated /28 subnet for the OKE API
  # endpoint (live cidr 10.2.0.0/28).
  vcn_enable_dedicated_api_subnet = true
  vcn_api_endpoint_cidr           = "10.2.0.0/28"

  # OCIR has 5 repos live (module default would destroy
  # `shogo-runtime-base`). shogo-buildcache mirrors the US build-cache repo
  # for symmetry; builds run against the US registry, so this stays empty
  # here unless per-region builds are introduced later.
  ocir_repositories = [
    "shogo-api",
    "shogo-buildcache",
    "shogo-docs",
    "shogo-runtime",
    "shogo-runtime-base",
    "shogo-web",
  ]

  # Knative + Kourier installed live (kubectl shows knative-serving,
  # kourier-system namespaces 55+ days old). Skip the installer.
  knative_manage_install = false

  # The tenancy-scoped `github-actions-deploy` IAM group + policy is
  # owned by production-us. Disable here to avoid a name collision.
  enable_github_oidc = false

  # India is tier="light" — module.cnpg, module.object_storage,
  # module.file_storage, module.publish_hosting are not instantiated by
  # the composite, so no flags needed for those.
}

# =============================================================================
# Cross-Region Peering (accept US peering — optional, for private DB access)
#
# DEFERRED until production-us flips `enable_drg_peering_to_india = true`
# and emits a non-null `rpc_india_id` output.
# =============================================================================

variable "enable_drg_peering_from_us" {
  description = "Create the DRG + VCN attachment that accepts the US-side RPC. Defaults to false until production-us has been flipped to publish its RPC."
  type        = bool
  default     = false
}

module "drg_from_us" {
  count  = var.enable_drg_peering_from_us ? 1 : 0
  source = "../../modules/drg-peering"

  name           = "shogo-production-in"
  compartment_id = var.compartment_id
  vcn_id         = module.india.vcn_id
  peer_region    = "us-ashburn-1"
  peer_rpc_id    = var.us_rpc_id
}

# =============================================================================
# Outputs
# =============================================================================

output "cluster_endpoint" { value = module.india.cluster_endpoint }
output "cluster_id" { value = module.india.cluster_id }
output "ocir_prefix" { value = module.india.ocir_prefix }
