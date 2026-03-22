# =============================================================================
# OCI Region Module — Composite
# =============================================================================
# Provisions an entire OCI region for Shogo. The `tier` variable controls
# which components are deployed:
#
#   Tier 1 ("full"):  Everything — networking, compute, data layer, ingress
#   Tier 2 ("light"): Networking, compute, ingress only — no local database,
#                      no object storage, no file storage. Connects to a
#                      Tier 1 region for data.
#
# Usage:
#   module "us" {
#     source     = "../../modules/oci-region"
#     tier       = "full"
#     region     = "us-ashburn-1"
#     region_key = "us"
#     vcn_cidr   = "10.0.0.0/16"
#     ...
#   }
#
#   module "india" {
#     source     = "../../modules/oci-region"
#     tier       = "light"
#     region     = "ap-mumbai-1"
#     region_key = "in"
#     vcn_cidr   = "10.2.0.0/16"
#     database_primary_endpoint = module.us.database_endpoint
#     s3_primary_endpoint       = module.us.s3_endpoint
#     s3_primary_region         = "us-ashburn-1"
#     ...
#   }
# =============================================================================

terraform {
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
}

locals {
  cluster_name = "shogo-${var.environment}${var.region_key == "us" ? "" : "-${var.region_key}"}"
  is_full      = var.tier == "full"

  region_tags = merge(var.tags, {
    Environment = var.environment
    Region      = var.region
    RegionKey   = var.region_key
    Tier        = var.tier
    ManagedBy   = "terraform"
    Project     = "shogo"
  })
}

# =============================================================================
# Availability Domains
# =============================================================================

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

# =============================================================================
# Networking — VCN (all tiers)
# =============================================================================

module "vcn" {
  source = "../vcn"

  name                  = local.cluster_name
  compartment_id        = var.compartment_id
  cidr                  = var.vcn_cidr
  single_nat_gateway    = true
  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  tags                  = local.region_tags
}

# =============================================================================
# Kubernetes — OKE (all tiers)
# =============================================================================

module "oke" {
  source = "../oke"

  cluster_name              = local.cluster_name
  compartment_id            = var.compartment_id
  vcn_id                    = module.vcn.vcn_id
  public_subnet_id          = module.vcn.public_subnet_id
  private_workers_subnet_id = module.vcn.private_workers_subnet_id
  private_pods_subnet_id    = module.vcn.private_pods_subnet_id
  api_nsg_id                = module.vcn.oke_api_nsg_id
  workers_nsg_id            = module.vcn.oke_workers_nsg_id

  node_ocpus     = var.system_node_ocpus
  node_memory_gb = var.system_node_memory_gb
  node_pool_size = var.system_pool_size
  node_pool_min  = var.system_pool_min
  node_pool_max  = var.system_pool_max

  enable_workload_pool      = var.enable_workload_pool
  workload_node_ocpus       = var.workload_node_ocpus
  workload_node_memory_gb   = var.workload_node_memory_gb
  workload_pool_size        = var.workload_pool_size
  workload_pool_min         = var.workload_pool_min
  workload_pool_max         = var.workload_pool_max

  tags = local.region_tags
}

# =============================================================================
# Container Registry — OCIR (all tiers)
# =============================================================================

module "ocir" {
  source = "../ocir"

  compartment_id = var.compartment_id
  repositories   = ["shogo-api", "shogo-web", "shogo-runtime", "shogo-docs"]
  tags           = local.region_tags
}

# =============================================================================
# Object Storage (Tier 1 only)
# =============================================================================

module "object_storage" {
  count  = local.is_full ? 1 : 0
  source = "../object-storage"

  compartment_id = var.compartment_id
  environment    = var.environment
  region         = var.region
  tags           = local.region_tags
}

# =============================================================================
# File Storage / NFS (Tier 1 only)
# =============================================================================

module "file_storage" {
  count  = local.is_full ? 1 : 0
  source = "../file-storage"

  name                = "${local.cluster_name}-workspace-fs"
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  subnet_id           = module.vcn.private_workers_subnet_id
  nsg_ids             = [module.vcn.oke_workers_nsg_id]
  nfs_allowed_cidr    = var.nfs_allowed_cidr
  tags                = local.region_tags
}

# =============================================================================
# CloudNativePG Operator (Tier 1 only)
# =============================================================================

module "cnpg" {
  count  = local.is_full ? 1 : 0
  source = "../cnpg"

  tags = local.region_tags
}

# =============================================================================
# Knative Serving + Kourier (all tiers)
# =============================================================================

module "knative" {
  source = "../knative-oci"

  domain             = var.domain
  publish_domain     = var.publish_domain
  enable_pvc_support = true
}

# =============================================================================
# Publish Hosting (Tier 1 only — requires Cloudflare Worker)
# =============================================================================

module "publish_hosting" {
  count  = local.is_full && var.cloudflare_zone_id != "" ? 1 : 0
  source = "../publish-hosting-oci"

  compartment_id        = var.compartment_id
  environment           = var.environment
  publish_domain        = var.publish_domain
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id
  oci_region            = var.region
  tags                  = local.region_tags
}

# =============================================================================
# SigNoz Observability (all tiers)
# =============================================================================

module "signoz" {
  source = "../signoz"

  cluster_name         = local.cluster_name
  environment          = var.environment
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key
  tags                 = local.region_tags
}

# =============================================================================
# GitHub OIDC for CI/CD (all tiers)
# =============================================================================

module "github_oidc" {
  source = "../oci-github-oidc"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id
  oke_cluster_id = module.oke.cluster_id
  tags           = local.region_tags
}

# =============================================================================
# Autoscaler IAM (primary region only)
# =============================================================================
# Dynamic groups are tenancy-level — enable in exactly one region per tenancy.

module "autoscaler_iam" {
  count  = var.create_autoscaler_iam ? 1 : 0
  source = "../oci-autoscaler-iam"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id
  environment    = var.environment
  tags           = local.region_tags
}
