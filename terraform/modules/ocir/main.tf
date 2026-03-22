# =============================================================================
# OCIR Module (OCI Container Registry)
# =============================================================================
# Creates container image repositories in OCI Container Registry.
# Equivalent to the AWS ECR module.
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

variable "repositories" {
  description = "List of repository names to create (e.g. shogo-api, shogo-web)"
  type        = list(string)
}

variable "is_public" {
  description = "Whether repositories are publicly accessible"
  type        = bool
  default     = false
}

variable "is_immutable" {
  description = "Whether image tags are immutable"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# OCIR uses the tenancy's Object Storage namespace as the registry namespace.
data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

# -----------------------------------------------------------------------------
# Container Repositories
# -----------------------------------------------------------------------------
resource "oci_artifacts_container_repository" "main" {
  for_each = toset(var.repositories)

  compartment_id = var.compartment_id
  display_name   = "shogo/${each.value}"
  is_public      = var.is_public
  is_immutable   = var.is_immutable

  freeform_tags = var.tags
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "repository_paths" {
  description = "Map of repository names to full OCIR paths"
  value = {
    for k, v in oci_artifacts_container_repository.main :
    k => v.display_name
  }
}

output "registry_namespace" {
  description = "OCIR namespace (Object Storage namespace)"
  value       = data.oci_objectstorage_namespace.current.namespace
}
