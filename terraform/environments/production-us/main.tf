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

  # System nodes (API, web, CNPG, Knative controllers)
  system_node_ocpus     = 8
  system_node_memory_gb = 64
  system_pool_size      = 3
  system_pool_min       = 2
  system_pool_max       = 15

  # Workload nodes (agent runtimes)
  enable_workload_pool      = true
  workload_node_ocpus       = 8
  workload_node_memory_gb   = 64
  workload_pool_size        = 2
  workload_pool_min         = 1
  workload_pool_max         = 100

  # Autoscaler IAM (tenancy-level — only enable in primary region)
  create_autoscaler_iam = true

  # Observability
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key

  # Cloudflare (for publish-hosting)
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id
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

output "workload_node_pool_id" {
  value = module.us.workload_node_pool_id
}
