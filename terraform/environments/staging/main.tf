# =============================================================================
# Shogo — Staging Environment (OCI)
# =============================================================================
# OKE-based staging environment in Oracle Cloud Infrastructure.
# Cluster: shogo-staging | Region: us-ashburn-1
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
  region           = var.region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "oci_containerengine_cluster_kube_config" "main" {
  cluster_id = module.oke.cluster_id
}

provider "kubernetes" {
  host                   = module.oke.cluster_endpoint
  cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "oci"
    args        = ["ce", "cluster", "generate-token", "--cluster-id", module.oke.cluster_id, "--region", var.region]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.oke.cluster_endpoint
    cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "oci"
      args        = ["ce", "cluster", "generate-token", "--cluster-id", module.oke.cluster_id, "--region", var.region]
    }
  }
}

locals {
  environment  = "staging"
  cluster_name = "shogo-staging"
  domain       = "staging.shogo.ai"

  tags = {
    Environment = "staging"
    ManagedBy   = "terraform"
    Project     = "shogo"
  }
}

# =============================================================================
# Availability Domain (needed by file-storage)
# =============================================================================

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

# =============================================================================
# Networking — VCN
# =============================================================================

module "vcn" {
  source = "../../modules/vcn"

  name                  = local.cluster_name
  compartment_id        = var.compartment_id
  cidr                  = "10.0.0.0/16"
  single_nat_gateway    = true
  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  tags                  = local.tags
}

# =============================================================================
# Kubernetes — OKE
# =============================================================================

module "oke" {
  source = "../../modules/oke"

  cluster_name              = local.cluster_name
  compartment_id            = var.compartment_id
  vcn_id                    = module.vcn.vcn_id
  public_subnet_id          = module.vcn.public_subnet_id
  private_workers_subnet_id = module.vcn.private_workers_subnet_id
  private_pods_subnet_id    = module.vcn.private_pods_subnet_id
  api_nsg_id                = module.vcn.oke_api_nsg_id
  workers_nsg_id            = module.vcn.oke_workers_nsg_id

  image_id           = "ocid1.image.oc1.iad.aaaaaaaaxlqapo7gpvnvfndkhfnixrnvlumdgaexjvakamdmhiegulsypa5a"
  placement_ad_names = ["XYpk:US-ASHBURN-AD-2"]

  # Match production node specs (4 OCPUs / 24GB → 93 pods/node instead of 31)
  node_ocpus     = 4
  node_memory_gb = 24
  node_pool_size = 2
  node_pool_min  = 1
  node_pool_max  = 6

  enable_workload_pool      = true
  workload_node_ocpus       = 4
  workload_node_memory_gb   = 24
  workload_pool_size        = 1
  workload_pool_min         = 1
  workload_pool_max         = 10

  tags = local.tags
}

# =============================================================================
# Container Registry — OCIR
# =============================================================================

module "ocir" {
  source = "../../modules/ocir"

  compartment_id = var.compartment_id
  repositories   = ["shogo-api", "shogo-web", "agent-runtime", "project-runtime", "shogo-docs"]
  tags           = local.tags
}

# =============================================================================
# Object Storage
# =============================================================================

module "object_storage" {
  source = "../../modules/object-storage"

  compartment_id = var.compartment_id
  environment    = local.environment
  region         = var.region
  tags           = local.tags
}

# =============================================================================
# File Storage (NFS)
# =============================================================================

module "file_storage" {
  source = "../../modules/file-storage"

  name                = "${local.cluster_name}-workspace-fs"
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  subnet_id           = module.vcn.private_workers_subnet_id
  nsg_ids             = [module.vcn.oke_workers_nsg_id]
  nfs_allowed_cidr    = var.nfs_allowed_cidr
  tags                = local.tags
}

# =============================================================================
# CloudNativePG Operator
# =============================================================================

module "cnpg" {
  source = "../../modules/cnpg"

  tags = local.tags
}

# =============================================================================
# Knative Serving
# =============================================================================

module "knative" {
  source = "../../modules/knative-oci"

  domain          = local.domain
  publish_domain  = "shogo.one"
  enable_pvc_support = true
}

# =============================================================================
# SigNoz Observability
# =============================================================================

module "signoz" {
  source = "../../modules/signoz"

  cluster_name      = local.cluster_name
  environment       = local.environment
  signoz_endpoint   = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key
  tags              = local.tags
}

# =============================================================================
# GitHub OIDC (CI/CD Authentication)
# =============================================================================

module "github_oidc" {
  source = "../../modules/oci-github-oidc"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id
  oke_cluster_id = module.oke.cluster_id
  tags           = local.tags
}

# =============================================================================
# Autoscaler IAM (dynamic group + policy for OKE instance principal)
# =============================================================================

module "autoscaler_iam" {
  source = "../../modules/oci-autoscaler-iam"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id
  environment    = local.environment
  tags           = local.tags
}

# =============================================================================
# DNS (Cloudflare)
# =============================================================================

module "dns" {
  source = "../../modules/dns"

  cloudflare_zone_id = var.cloudflare_zone_id
  domain             = local.domain
  subdomain          = "staging"
  lb_ip_or_hostname  = "0.0.0.0" # Populated after initial apply via kubectl get svc
  additional_records = []
}

# =============================================================================
# Publish Hosting (OCI Object Storage + Cloudflare Worker)
# =============================================================================

module "publish_hosting" {
  source = "../../modules/publish-hosting-oci"

  compartment_id        = var.compartment_id
  environment           = local.environment
  publish_domain        = "shogo.one"
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id
  oci_region            = var.region
  tags                  = local.tags
}

# =============================================================================
# Outputs
# =============================================================================

output "cluster_endpoint" {
  description = "OKE cluster API endpoint"
  value       = module.oke.cluster_endpoint
}

output "cluster_id" {
  description = "OKE cluster OCID"
  value       = module.oke.cluster_id
}

output "registry_namespace" {
  description = "OCIR namespace"
  value       = module.ocir.registry_namespace
}

output "schemas_bucket" {
  description = "Schema storage bucket"
  value       = module.object_storage.schemas_bucket
}

output "workspaces_bucket" {
  description = "Workspace sync bucket"
  value       = module.object_storage.workspaces_bucket
}

output "pg_backups_bucket" {
  description = "PostgreSQL backups bucket"
  value       = module.object_storage.pg_backups_bucket
}

output "published_apps_bucket" {
  description = "Published apps bucket"
  value       = module.object_storage.published_apps_bucket
}

output "file_system_export_path" {
  description = "NFS export path for workspace filesystem"
  value       = module.file_storage.export_path
}

output "github_actions_group" {
  description = "IAM group for GitHub Actions CI/CD"
  value       = module.github_oidc.group_name
}
