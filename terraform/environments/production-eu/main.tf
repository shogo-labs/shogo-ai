# =============================================================================
# Shogo — Production EU (Tier 1 Replica)
# =============================================================================
# Full region: OKE + CNPG (replica) + Knative + SigNoz
# Region: eu-frankfurt-1 | CIDR: 10.1.0.0/16
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
    key    = "production-eu/terraform.tfstate"
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
  region           = "eu-frankfurt-1"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "oci_containerengine_cluster_kube_config" "main" {
  cluster_id = module.eu.cluster_id
}

provider "kubernetes" {
  host                   = module.eu.cluster_endpoint
  cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "oci"
    args        = ["ce", "cluster", "generate-token", "--cluster-id", module.eu.cluster_id, "--region", "eu-frankfurt-1"]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eu.cluster_endpoint
    cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "oci"
      args        = ["ce", "cluster", "generate-token", "--cluster-id", module.eu.cluster_id, "--region", "eu-frankfurt-1"]
    }
  }
}

# =============================================================================
# Region Module — Tier 1 (Full)
# =============================================================================

module "eu" {
  source = "../../modules/oci-region"

  tier        = "full"
  region      = "eu-frankfurt-1"
  region_key  = "eu"
  environment = "production"
  vcn_cidr    = "10.1.0.0/16"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id

  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  nfs_allowed_cidr      = var.nfs_allowed_cidr

  # ARM64 custom OKE image (A2 Flex) — EU region
  image_id           = "ocid1.image.oc1.eu-frankfurt-1.aaaaaaaaiufb7tfc5olbaeerhukwj72ppir3yzigxp26cp2hqqzjtugf2sbq"
  placement_ad_names = ["XYpk:EU-FRANKFURT-1-AD-1"]

  # EU uses A2.Flex (A4 not available in this region)
  #
  # 2026-06-02 rollout-headroom bump (run 26865807851): `min`/`size` 2 -> 3
  # so there is always one warm, already-prepulled spare node beyond
  # steady-state. A new revision's `min-scale: 2` api pods then land on that
  # warm node instead of forcing the autoscaler to provision a COLD node
  # mid-rollout (EU's warm pool never reached Ready in that run). MUST match
  # the live floor: GitHub Actions variable NODE_POOL_MIN for environment
  # production-eu (consumed by deploy.yml "Deploy Cluster Autoscaler").
  system_node_shape     = "VM.Standard.A2.Flex"
  system_node_ocpus     = 4
  system_node_memory_gb = 24
  system_pool_size      = 3
  system_pool_min       = 3
  system_pool_max       = 10

  # 200 GB to match production-us. EU was bootstrapped at 100 GB, which
  # caused the 2026-06-02 DiskPressure incident (stacked 8 GB runtime images
  # filled the disk -> kubelet eviction/image-GC -> warm-pool churn -> the
  # api rollout could not reach initial scale). The oke module ignores
  # in-place boot-volume changes, so applying this requires a one-time
  # controlled node-pool replacement (see terraform/README.md "Boot volume
  # remediation"). Until that cycle runs, the live value stays 100 GB.
  system_node_boot_volume_gb = 200

  enable_workload_pool = false

  # Observability
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  # Cloudflare (for publish-hosting — kept for signature parity even though
  # EU does not own a publish wildcard; production-us owns `*.shogo.one`).
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id

  # =============================================================
  # Live-state overrides (production-eu reconciliation, 2026-05)
  # =============================================================

  # Live node pool was bootstrapped as `shogo-prod-eu-arm-4ocpu` at
  # max_pods_per_node = 93 (not the module's default 110). Same pattern
  # as production-us. Without these, tf would force-update the pool name
  # and try to bump max pods, which OCI may refuse on existing pools.
  oke_main_node_pool_name_override = "shogo-prod-eu-arm-4ocpu"
  oke_main_node_pool_max_pods      = 93

  # Live cluster endpoint shows `nsg-ids: []`. State has NSG resources
  # but they're not attached. Disabling matches live and avoids churn.
  vcn_enable_oke_nsgs = false

  # VCN security lists already in state — keep enabled.
  vcn_enable_security_lists = true

  # EU was bootstrapped with a dedicated /28 subnet for the OKE API
  # endpoint (live cidr 10.1.0.0/28). Already in state as
  # `oci_core_subnet.api_endpoint[0]` — disabling would destroy it and
  # force a cluster replacement.
  vcn_enable_dedicated_api_subnet = true
  vcn_api_endpoint_cidr           = "10.1.0.0/28"

  # OCIR has 5 repos live (module's 4-repo default would destroy
  # `shogo-runtime-base`).
  ocir_repositories = [
    "shogo-api",
    "shogo-docs",
    "shogo-runtime",
    "shogo-runtime-base",
    "shogo-web",
  ]

  # Knative + Kourier + CNPG are all installed live in eu-frankfurt-1
  # (kubectl shows knative-serving, kourier-system, cnpg-system
  # namespaces, all 55+ days old). Skip the installer null_resources.
  knative_manage_install = false
  cnpg_manage_install    = false

  # The Object Storage lifecycle service-principal IAM policy is
  # region-scoped (the statement names `objectstorage-eu-frankfurt-1`).
  # Staging's policy only covers us-ashburn-1. EU's policy must be
  # created out-of-band against the tenancy home region (us-ashburn-1
  # / IAD) — the OCI Identity service only accepts policy CREATE
  # against the home region, and EU's provider is pinned to
  # eu-frankfurt-1. The policy already exists as
  # `objectstorage-lifecycle-service-principal-production-eu-frankfurt-1`
  # (created via `oci iam policy create --region us-ashburn-1`). Skip
  # tf management here; refactor the object-storage module to accept a
  # home-region provider alias in a follow-up.
  object_storage_lifecycle_service_policy_compartment_id = null

  # The tenancy-scoped `github-actions-deploy` IAM group + policy is
  # owned by production-us (created during its reconciliation). Disable
  # here to avoid a tenancy-level name collision.
  enable_github_oidc = false

  # EU does NOT own a publish-hosting wildcard. Production-us owns
  # `*.shogo.one`; staging owns `*.staging.shogo.one`. EU could later
  # gain `*.eu.shogo.one` as a regional publish target but that's a
  # follow-up.
  enable_publish_hosting = false
}

# =============================================================================
# Cross-Region Peering (accept US peering)
#
# DEFERRED until production-us flips `enable_drg_peering_to_eu = true` and
# emits a non-null `rpc_eu_id` output. Until then the DRG/RPC pair would
# create a regional DRG with no peer to accept, which is wasted state.
# =============================================================================

variable "enable_drg_peering_from_us" {
  description = "Create the DRG + VCN attachment that accepts the US-side RPC. Defaults to false until production-us has been flipped to publish its RPC."
  type        = bool
  default     = false
}

module "drg_from_us" {
  count  = var.enable_drg_peering_from_us ? 1 : 0
  source = "../../modules/drg-peering"

  name           = "shogo-production-eu"
  compartment_id = var.compartment_id
  vcn_id         = module.eu.vcn_id
  peer_region    = "us-ashburn-1"
  peer_rpc_id    = var.us_rpc_id
}

# =============================================================================
# Outputs
# =============================================================================

output "cluster_endpoint" { value = module.eu.cluster_endpoint }
output "cluster_id"       { value = module.eu.cluster_id }
output "ocir_prefix"      { value = module.eu.ocir_prefix }
