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

variable "lifecycle_service_policy_compartment_id" {
  description = "Compartment OCID where the `Allow service objectstorage-<region> to manage object-family ...` IAM policy is created. Required when any bucket in this module has a lifecycle policy, because the OCI service principal needs explicit permission to enact lifecycle rules against the bucket. Recommended value: tenancy root OCID, with policy scope=tenancy, so a single policy covers buckets in any compartment. Pass null to skip policy creation (e.g. when the policy already exists in the tenancy)."
  type        = string
  default     = null
}

variable "lifecycle_service_policy_scope" {
  description = "Compartment scope for the service-principal lifecycle policy. Use `\"tenancy\"` to cover every bucket in the tenancy regardless of compartment, or a compartment name (e.g. `\"shogo-staging\"`) to scope tighter. Only used when `lifecycle_service_policy_compartment_id != null`."
  type        = string
  default     = "tenancy"
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
# NOTE (Git LFS): git_only-mode pods store Git LFS objects in THIS bucket
# under `<projectId>/lfs/objects/<oid>` (content-addressed
# sha256), alongside repo.git.tar.gz and the legacy assets/ namespace. LFS
# objects are immutable and never overwritten, so usage grows monotonically:
# a reachability-based GC job (enumerate live pointer oids per project, delete
# unreferenced objects) is a required follow-up before this is load-bearing.
# Set S3_LFS_BUCKET on the app to split LFS into a dedicated bucket instead.
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

# -----------------------------------------------------------------------------
# IAM policy granting the Object Storage service principal permission to
# execute lifecycle policy actions (transition to infrequent access, delete
# expired objects, etc) across the tenancy.
#
# Without this policy, `oci_objectstorage_object_lifecycle_policy.*` resources
# return `400-InsufficientServicePermissions` at PutObjectLifecyclePolicy
# time, because the service principal `objectstorage-<region>` has no
# default rights against the bucket. One tenancy-scoped policy covers every
# bucket in every compartment, so it's safe to set this once on the first
# env that needs it and leave the rest with `lifecycle_service_policy_compartment_id = null`.
# -----------------------------------------------------------------------------
resource "oci_identity_policy" "lifecycle_service_principal" {
  count = var.lifecycle_service_policy_compartment_id != null ? 1 : 0

  compartment_id = var.lifecycle_service_policy_compartment_id
  # The policy is per-region because the statement names the region-scoped
  # service principal (`objectstorage-<region>`). Include region in the
  # policy name so multiple regions can coexist at the tenancy level
  # without a name collision.
  name        = "objectstorage-lifecycle-service-principal-${var.environment}-${var.region}"
  description = "Grant the Object Storage service principal permission to execute lifecycle rules against buckets in this ${var.lifecycle_service_policy_scope}. Required for oci_objectstorage_object_lifecycle_policy resources."

  statements = [
    "Allow service objectstorage-${var.region} to manage object-family in ${var.lifecycle_service_policy_scope}",
  ]
}

resource "oci_objectstorage_object_lifecycle_policy" "pg_backups_lifecycle" {
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.pg_backups.name

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
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.published_apps.name

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
# Published Data Bucket (writable runtime state for SERVER-BACKED *.shogo.one)
# -----------------------------------------------------------------------------
# Server-backed published apps run their server.tsx in production and persist
# end-user writes (the SQLite DB + upload dirs) here, keyed by published
# subdomain (`{subdomain}/data.tar.gz`). Restored on pod boot and flushed
# periodically + at shutdown by PublishedDataSync (packages/shared-runtime).
# Kept separate from the static `published_apps` bucket so the CDN PAR (read-
# only, public-edge) never has any path to mutable user data. Accessed only by
# the runtime pods' S3 credentials (same `s3-credentials` secret as workspaces).
resource "oci_objectstorage_bucket" "published_data" {
  compartment_id = coalesce(var.published_apps_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-published-data-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  freeform_tags = merge(var.tags, {
    Purpose = "published-app-writable-state"
  })
}

resource "oci_objectstorage_object_lifecycle_policy" "published_data_lifecycle" {
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.published_data.name

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

output "published_data_bucket" {
  description = "Published-app writable-state bucket name (server-backed apps' SQLite DB + uploads)"
  value       = oci_objectstorage_bucket.published_data.name
}
