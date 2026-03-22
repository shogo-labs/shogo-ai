# =============================================================================
# OCI Region Module — Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Identifiers
# -----------------------------------------------------------------------------

output "region" {
  description = "OCI region"
  value       = var.region
}

output "region_key" {
  description = "Short region key"
  value       = var.region_key
}

output "tier" {
  description = "Region tier (full or light)"
  value       = var.tier
}

output "cluster_name" {
  description = "OKE cluster name"
  value       = local.cluster_name
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vcn_id" {
  description = "VCN OCID"
  value       = module.vcn.vcn_id
}

output "vcn_cidr" {
  description = "VCN CIDR block"
  value       = var.vcn_cidr
}

# -----------------------------------------------------------------------------
# Kubernetes
# -----------------------------------------------------------------------------

output "cluster_id" {
  description = "OKE cluster OCID"
  value       = module.oke.cluster_id
}

output "cluster_endpoint" {
  description = "OKE cluster API endpoint"
  value       = module.oke.cluster_endpoint
}

output "system_node_pool_id" {
  description = "System node pool OCID"
  value       = module.oke.system_node_pool_id
}

output "workload_node_pool_id" {
  description = "Workload node pool OCID (null if disabled)"
  value       = module.oke.workload_node_pool_id
}

# -----------------------------------------------------------------------------
# Container Registry
# -----------------------------------------------------------------------------

output "registry_namespace" {
  description = "OCIR namespace"
  value       = module.ocir.registry_namespace
}

output "ocir_prefix" {
  description = "Full OCIR image prefix (e.g. us-ashburn-1.ocir.io/namespace/shogo)"
  value       = "${var.region}.ocir.io/${module.ocir.registry_namespace}/shogo"
}

# -----------------------------------------------------------------------------
# Data Layer (Tier 1 only — null for Tier 2)
# -----------------------------------------------------------------------------

output "s3_endpoint" {
  description = "S3-compatible endpoint for Object Storage (null for Tier 2)"
  value       = local.is_full ? module.object_storage[0].s3_endpoint : var.s3_primary_endpoint
}

output "s3_region" {
  description = "Region for S3 access (own region for Tier 1, primary region for Tier 2)"
  value       = local.is_full ? var.region : var.s3_primary_region
}

output "schemas_bucket" {
  description = "Schema storage bucket (null for Tier 2)"
  value       = local.is_full ? module.object_storage[0].schemas_bucket : null
}

output "workspaces_bucket" {
  description = "Workspace sync bucket (null for Tier 2)"
  value       = local.is_full ? module.object_storage[0].workspaces_bucket : null
}

output "pg_backups_bucket" {
  description = "PostgreSQL backups bucket (null for Tier 2)"
  value       = local.is_full ? module.object_storage[0].pg_backups_bucket : null
}

output "published_apps_bucket" {
  description = "Published apps bucket (null for Tier 2)"
  value       = local.is_full ? module.object_storage[0].published_apps_bucket : null
}

output "file_system_export_path" {
  description = "NFS export path (null for Tier 2)"
  value       = local.is_full ? module.file_storage[0].export_path : null
}

# -----------------------------------------------------------------------------
# Database connection info
# For Tier 1: local CNPG (configured separately via K8s manifests)
# For Tier 2: points to the primary region's database
# -----------------------------------------------------------------------------

output "database_endpoint" {
  description = "Database endpoint hint (Tier 1: local CNPG service, Tier 2: primary region)"
  value       = local.is_full ? "platform-pg-rw.shogo-${var.environment}-system:5432" : var.database_primary_endpoint
}

# -----------------------------------------------------------------------------
# CI/CD
# -----------------------------------------------------------------------------

output "github_actions_group" {
  description = "IAM group for GitHub Actions"
  value       = module.github_oidc.group_name
}
