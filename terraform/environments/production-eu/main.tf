# =============================================================================
# Shogo — Production EU (Tier 1 Replica)
# =============================================================================
# Full region: OKE + CNPG (streaming replica from US) + Object Storage (replicated)
# Region: eu-frankfurt-1 | CIDR: 10.1.0.0/16
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
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

  # Smaller than US — scales up as EU traffic grows
  system_node_ocpus     = 8
  system_node_memory_gb = 64
  system_pool_size      = 3
  system_pool_min       = 2
  system_pool_max       = 10

  enable_workload_pool      = true
  workload_node_ocpus       = 8
  workload_node_memory_gb   = 64
  workload_pool_size        = 2
  workload_pool_min         = 1
  workload_pool_max         = 50

  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id
}

# =============================================================================
# Cross-Region Peering (accept US peering)
# =============================================================================

module "drg_from_us" {
  source = "../../modules/drg-peering"

  name           = "shogo-production-eu"
  compartment_id = var.compartment_id
  vcn_id         = module.eu.vcn_id
  peer_region    = "us-ashburn-1"
  peer_rpc_id    = var.us_rpc_id  # from production-us output
}

# =============================================================================
# Outputs
# =============================================================================

output "cluster_endpoint" { value = module.eu.cluster_endpoint }
output "cluster_id"       { value = module.eu.cluster_id }
output "ocir_prefix"      { value = module.eu.ocir_prefix }
output "s3_endpoint"      { value = module.eu.s3_endpoint }

output "workload_node_pool_id" {
  value = module.eu.workload_node_pool_id
}
