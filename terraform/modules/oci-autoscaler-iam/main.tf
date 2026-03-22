# =============================================================================
# OCI Autoscaler IAM Module
# =============================================================================
# Creates the dynamic group and IAM policy required for the OKE cluster
# autoscaler to manage node pools via instance principal authentication.
#
# OCI dynamic groups are tenancy-level resources. This module should only be
# instantiated once per tenancy/compartment pair (e.g. from the primary region).
# The resulting policy applies to all OKE worker nodes across all regions that
# share the same compartment.
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
  description = "OCI tenancy OCID (dynamic groups are tenancy-level)"
  type        = string
}

variable "environment" {
  description = "Environment name used in resource naming (e.g. production, staging)"
  type        = string
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Dynamic Group
# Matches all compute instances in the compartment. Since only OKE worker
# nodes run in these compartments, this is equivalent to "all OKE workers".
# -----------------------------------------------------------------------------

resource "oci_identity_dynamic_group" "oke_workers" {
  compartment_id = var.tenancy_id
  name           = "oke-autoscaler-${var.environment}"
  description    = "OKE worker node instances for cluster autoscaler (${var.environment})"

  matching_rule = "All {instance.compartment.id = '${var.compartment_id}'}"

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# IAM Policy
# Grants the dynamic group the permissions required by the OCI cluster
# autoscaler to discover, scale, and manage OKE node pools.
# -----------------------------------------------------------------------------

resource "oci_identity_policy" "oke_autoscaler" {
  compartment_id = var.compartment_id
  name           = "oke-autoscaler-${var.environment}-policy"
  description    = "Allow OKE worker nodes to manage node pools for cluster autoscaling (${var.environment})"

  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to manage cluster-node-pools in compartment id ${var.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to manage instance-family in compartment id ${var.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to use subnets in compartment id ${var.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to read virtual-network-family in compartment id ${var.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to use vnics in compartment id ${var.compartment_id}",
    "Allow dynamic-group ${oci_identity_dynamic_group.oke_workers.name} to inspect compartments in compartment id ${var.compartment_id}",
  ]

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "dynamic_group_name" {
  description = "Dynamic group name"
  value       = oci_identity_dynamic_group.oke_workers.name
}

output "dynamic_group_id" {
  description = "Dynamic group OCID"
  value       = oci_identity_dynamic_group.oke_workers.id
}

output "policy_name" {
  description = "IAM policy name"
  value       = oci_identity_policy.oke_autoscaler.name
}
