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
  compartment_id = var.compartment_id
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
  compartment_id = var.compartment_id
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
  compartment_id = var.compartment_id
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
  compartment_id = var.compartment_id
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
