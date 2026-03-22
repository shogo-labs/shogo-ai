# =============================================================================
# Object Storage Replication Module
# =============================================================================
# Creates cross-region replication policies for OCI Object Storage buckets.
# Replicates from a source region to a destination region.
#
# Limitations:
#   - Each source bucket supports only ONE replication policy
#   - Destination buckets become read-only
#   - Only objects created AFTER policy creation are replicated
#   - For fan-out to 3+ regions, chain: US → EU, EU → India (not US → both)
#
# Usage:
#   module "replication_us_to_eu" {
#     source             = "../../modules/object-storage-replication"
#     compartment_id     = var.compartment_id
#     environment        = "production"
#     destination_region = "eu-frankfurt-1"
#   }
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

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "destination_region" {
  description = "Destination OCI region for replication"
  type        = string
}

variable "replicate_schemas" {
  description = "Replicate the schemas bucket"
  type        = bool
  default     = true
}

variable "replicate_workspaces" {
  description = "Replicate the workspaces bucket"
  type        = bool
  default     = true
}

variable "replicate_pg_backups" {
  description = "Replicate the PostgreSQL backups bucket"
  type        = bool
  default     = true
}

variable "replicate_published_apps" {
  description = "Replicate the published apps bucket"
  type        = bool
  default     = true
}

data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

locals {
  namespace = data.oci_objectstorage_namespace.current.namespace

  buckets = {
    schemas = {
      name      = "shogo-schemas-${var.environment}"
      dest_name = "shogo-schemas-${var.environment}"
      enabled   = var.replicate_schemas
    }
    workspaces = {
      name      = "shogo-workspaces-${var.environment}"
      dest_name = "shogo-workspaces-${var.environment}"
      enabled   = var.replicate_workspaces
    }
    pg_backups = {
      name      = "shogo-pg-backups-${var.environment}"
      dest_name = "shogo-pg-backups-${var.environment}"
      enabled   = var.replicate_pg_backups
    }
    published_apps = {
      name      = "shogo-published-apps-${var.environment}"
      dest_name = "shogo-published-apps-${var.environment}"
      enabled   = var.replicate_published_apps
    }
  }

  enabled_buckets = { for k, v in local.buckets : k => v if v.enabled }
}

# -----------------------------------------------------------------------------
# Replication Policies
# -----------------------------------------------------------------------------

resource "oci_objectstorage_replication_policy" "main" {
  for_each = local.enabled_buckets

  namespace  = local.namespace
  bucket     = each.value.name
  name       = "${each.key}-to-${var.destination_region}"

  destination_bucket_name = each.value.dest_name
  destination_region_name = var.destination_region
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "replication_policies" {
  description = "Map of bucket key → replication policy details"
  value = {
    for k, v in oci_objectstorage_replication_policy.main : k => {
      id                = v.id
      source_bucket     = local.enabled_buckets[k].name
      destination       = "${var.destination_region}/${local.enabled_buckets[k].dest_name}"
      status            = v.status
    }
  }
}
