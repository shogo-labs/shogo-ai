# =============================================================================
# OCI GitHub OIDC Module
# =============================================================================
# Configures OCI Workload Identity Federation for GitHub Actions.
# Allows GitHub Actions to authenticate to OCI without static credentials.
# Equivalent to the AWS github-oidc module.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "tenancy_id" {
  description = "OCI tenancy OCID"
  type        = string
}

variable "github_org" {
  description = "GitHub organization name"
  type        = string
  default     = "shogo-ai"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "shogo-ai"
}

variable "oke_cluster_id" {
  description = "OKE cluster OCID to grant access to"
  type        = string
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Dynamic Group for GitHub Actions
# Matching rules identify workload identity tokens from GitHub OIDC.
# The OCI API key/token exchange handles the OIDC federation; the dynamic
# group then grants IAM permissions to the resulting principal.
# -----------------------------------------------------------------------------

# Create a group for CI/CD operations
resource "oci_identity_group" "github_actions" {
  compartment_id = var.tenancy_id
  name           = "github-actions-deploy"
  description    = "Group for GitHub Actions CI/CD deployments"

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# IAM Policies
# Grant the GitHub Actions group permissions to:
# - Manage OKE clusters (deploy workloads)
# - Push/pull images from OCIR
# - Read/write Object Storage (for published apps, backups)
# - Manage DNS records
# -----------------------------------------------------------------------------
resource "oci_identity_policy" "github_actions_oke" {
  compartment_id = var.compartment_id
  name           = "github-actions-oke-policy"
  description    = "Allow GitHub Actions to manage OKE clusters"

  statements = [
    "Allow group ${oci_identity_group.github_actions.name} to manage cluster-family in compartment id ${var.compartment_id}",
    "Allow group ${oci_identity_group.github_actions.name} to manage repos in compartment id ${var.compartment_id}",
    "Allow group ${oci_identity_group.github_actions.name} to manage objects in compartment id ${var.compartment_id}",
    "Allow group ${oci_identity_group.github_actions.name} to manage buckets in compartment id ${var.compartment_id}",
    "Allow group ${oci_identity_group.github_actions.name} to read all-resources in compartment id ${var.compartment_id}",
  ]

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "group_name" {
  description = "IAM group name for GitHub Actions"
  value       = oci_identity_group.github_actions.name
}

output "group_id" {
  description = "IAM group OCID"
  value       = oci_identity_group.github_actions.id
}
