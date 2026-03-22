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
      version = "~> 6.0"
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

  backend "local" {
    path = "terraform.tfstate"
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

  tier        = "light"                # <-- the key difference
  region      = "ap-mumbai-1"
  region_key  = "in"
  environment = "production"
  vcn_cidr    = "10.2.0.0/16"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id

  # Active-active node with local DB — matches US/EU sizing
  system_node_ocpus     = 8
  system_node_memory_gb = 32
  system_pool_size      = 3
  system_pool_min       = 2
  system_pool_max       = 10

  enable_workload_pool      = true
  workload_node_ocpus       = 8
  workload_node_memory_gb   = 64
  workload_pool_size        = 1
  workload_pool_min         = 1
  workload_pool_max         = 30

  # Data layer points to US primary
  database_primary_endpoint = var.us_database_endpoint
  s3_primary_endpoint       = var.us_s3_endpoint
  s3_primary_region         = "us-ashburn-1"

  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  # No Cloudflare publish-hosting in Tier 2
  # cloudflare_zone_id and cloudflare_account_id left empty
}

# =============================================================================
# Cross-Region Peering (accept US peering — optional, for private DB access)
# =============================================================================

module "drg_from_us" {
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
output "cluster_id"       { value = module.india.cluster_id }
output "ocir_prefix"      { value = module.india.ocir_prefix }

output "workload_node_pool_id" {
  value = module.india.workload_node_pool_id
}
