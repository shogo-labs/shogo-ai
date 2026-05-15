# =============================================================================
# Object Storage Module (OCI)
# =============================================================================
# Creates OCI Object Storage buckets for all storage needs:
# schemas, workspace sync, PG backups, published apps.
# Equivalent to the AWS S3 / schema-storage modules.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
  }
}

variable "compartment_id" {
  description = "Default OCI compartment OCID for buckets. Per-bucket overrides exist (see below) for cases where individual buckets historically live in a different compartment (e.g. tenancy root or a shared services compartment)."
  type        = string
}

# --- Per-bucket compartment overrides ---------------------------------------
# These exist because some staging buckets were bootstrapped manually into
# compartments other than the staging compartment (`shogo-workspaces-staging`
# in the production compartment, `shogo-pg-backups-staging` in the tenancy
# root). Importing them with a uniform compartment_id would yield a forced
# compartment change on every plan; these per-bucket vars let the tf config
# match the actual live placement so imports are clean. Leave unset to fall
# through to `var.compartment_id`.

variable "schemas_compartment_id" {
  description = "Override compartment for the schemas bucket. Defaults to var.compartment_id."
  type        = string
  default     = null
}

variable "workspaces_compartment_id" {
  description = "Override compartment for the workspaces bucket. Defaults to var.compartment_id."
  type        = string
  default     = null
}

variable "pg_backups_compartment_id" {
  description = "Override compartment for the pg-backups bucket. Defaults to var.compartment_id."
  type        = string
  default     = null
}

variable "published_apps_compartment_id" {
  description = "Override compartment for the published-apps bucket. Defaults to var.compartment_id."
  type        = string
  default     = null
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "region" {
  description = "OCI region (e.g. us-ashburn-1)"
  type        = string
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

locals {
  namespace = data.oci_objectstorage_namespace.current.namespace
}

# -----------------------------------------------------------------------------
# Schema Storage Bucket
# -----------------------------------------------------------------------------
resource "oci_objectstorage_bucket" "schemas" {
  compartment_id = coalesce(var.schemas_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-schemas-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  freeform_tags = merge(var.tags, {
    Purpose = "schema-storage"
  })
}

# -----------------------------------------------------------------------------
# Workspaces Sync Bucket (project file persistence)
# -----------------------------------------------------------------------------
resource "oci_objectstorage_bucket" "workspaces" {
  compartment_id = coalesce(var.workspaces_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-workspaces-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Disabled"

  freeform_tags = merge(var.tags, {
    Purpose = "workspace-file-sync"
  })
}

# -----------------------------------------------------------------------------
# PostgreSQL Backups Bucket (CNPG Barman backups)
# -----------------------------------------------------------------------------
resource "oci_objectstorage_bucket" "pg_backups" {
  compartment_id = coalesce(var.pg_backups_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-pg-backups-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  freeform_tags = merge(var.tags, {
    Purpose = "postgresql-backups"
  })
}

resource "oci_objectstorage_object_lifecycle_policy" "pg_backups_lifecycle" {
  namespace  = local.namespace
  bucket     = oci_objectstorage_bucket.pg_backups.name

  rules {
    name        = "archive-old-backups"
    action      = "INFREQUENT_ACCESS"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"
  }

  rules {
    name        = "delete-old-backups"
    action      = "DELETE"
    time_amount = 90
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"
  }
}

# -----------------------------------------------------------------------------
# Published Apps Bucket (static hosting for *.shogo.one)
# -----------------------------------------------------------------------------
resource "oci_objectstorage_bucket" "published_apps" {
  compartment_id = coalesce(var.published_apps_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-published-apps-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  freeform_tags = merge(var.tags, {
    Purpose = "published-static-sites"
  })
}

resource "oci_objectstorage_object_lifecycle_policy" "published_apps_lifecycle" {
  namespace  = local.namespace
  bucket     = oci_objectstorage_bucket.published_apps.name

  rules {
    name        = "cleanup-old-versions"
    action      = "DELETE"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "namespace" {
  description = "Object Storage namespace"
  value       = local.namespace
}

output "s3_endpoint" {
  description = "S3-compatible API endpoint"
  value       = "https://${local.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
}

output "schemas_bucket" {
  description = "Schema storage bucket name"
  value       = oci_objectstorage_bucket.schemas.name
}

output "workspaces_bucket" {
  description = "Workspaces sync bucket name"
  value       = oci_objectstorage_bucket.workspaces.name
}

output "pg_backups_bucket" {
  description = "PostgreSQL backups bucket name"
  value       = oci_objectstorage_bucket.pg_backups.name
}

output "published_apps_bucket" {
  description = "Published apps bucket name"
  value       = oci_objectstorage_bucket.published_apps.name
}
