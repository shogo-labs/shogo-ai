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

variable "llm_captures_compartment_id" {
  description = "Override compartment for the LLM capture bucket. Defaults to var.compartment_id."
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

variable "llm_capture_retention_days" {
  description = "Number of days to retain raw LLM proxy captures (3 years by default). Keep in sync with PROXY_CAPTURE_RETENTION_DAYS in the api, which prunes proxy_turns."
  type        = number
  default     = 1095
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
#
# Versioning is ENABLED so an overwrite of `<projectId>/project-src.tar.gz`
# never permanently destroys the prior source. This is the durability backstop
# for the write-side clobber class of bug (a VM that came up as the bare
# template packing ~337 KB over a multi-MB/GB real backup): with versioning on,
# the clobbered content survives as a noncurrent version and is recoverable,
# turning "permanent data loss" into "restore the previous version". The
# metal-agent's lineage guard (apps/metal-agent/src/workspace-archive.ts) now
# prevents the clobber in the first place; versioning is the safety net for any
# future bug in that class. Noncurrent versions are reaped after 30 days by the
# lifecycle policy below so this doesn't grow unbounded.
resource "oci_objectstorage_bucket" "workspaces" {
  compartment_id = coalesce(var.workspaces_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-workspaces-${var.environment}"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"

  freeform_tags = merge(var.tags, {
    Purpose = "workspace-file-sync"
  })

  lifecycle {
    # Project files live here (incl. Git LFS objects and repo.git.tar.gz).
    # A replace would orphan every workspace archive. Fail the plan instead.
    prevent_destroy = true
  }
}

resource "oci_objectstorage_object_lifecycle_policy" "workspaces_lifecycle" {
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.workspaces.name

  # Keep noncurrent versions for 30 days — a comfortable recovery window for a
  # clobbered `project-src.tar.gz` — then reclaim them so versioning doesn't
  # accumulate cost. Only PREVIOUS versions are deleted; the current object is
  # never touched by this rule.
  rules {
    name        = "cleanup-old-versions"
    action      = "DELETE"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"
  }

  # Reap quarantined exports. When the metal-agent's lineage guard refuses to
  # overwrite a real backup (a template/stale/losing-racer write), it diverts
  # the bytes to `conflict/<projectId>/<ts>-<rand>.tar.gz` rather than clobber.
  # Those are recoverable-but-orphaned workspaces; keep them 30 days for
  # investigation/recovery, then delete so the quarantine area can't grow
  # unbounded. Scoped by prefix so ONLY the quarantine namespace is affected —
  # never `<projectId>/project-src.tar.gz` or any live source.
  rules {
    name        = "cleanup-quarantined-exports"
    action      = "DELETE"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"

    object_name_filter {
      inclusion_prefixes = ["conflict/"]
    }
  }

  # Writable-state archives (`<projectId>/project-data.tar.gz`, the SQLite
  # database + uploads) are overwritten every ~2 minutes while a database is
  # changing, so the global 30-day rule above would keep thousands of full
  # copies per project. Keep replaced versions for one day only: that is the
  # "undo the last few minutes/hours" window. Longer-range recovery comes from
  # the daily restore points below. When rules overlap, the shorter one wins.
  rules {
    name        = "cleanup-project-data-versions"
    action      = "DELETE"
    time_amount = 1
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"

    object_name_filter {
      inclusion_patterns = ["*/project-data.tar.gz"]
    }
  }

  # End-of-day restore points (`<projectId>/project-data/daily/<date>.tar.gz`),
  # server-side copied by the metal-agent before the first overwrite of each
  # UTC day. Keep 30 days of daily history.
  rules {
    name        = "cleanup-project-data-daily"
    action      = "DELETE"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"

    object_name_filter {
      inclusion_patterns = ["*/project-data/daily/*"]
    }
  }

  # ── Rules that were live but only in the OCI console ──────────────────────
  # Both of these run on `shogo-workspaces-production` today and existed
  # nowhere in this module, so every environment that DOES manage this bucket
  # (staging directly, prod-us and prod-eu through `modules/oci-region`) had
  # drifted from it in silence. Recorded here exactly as they are live
  # (SHO-584).
  #
  # OVERLAP: when two rules match the same object, OCI applies the SHORTER
  # period. `expire-previous-versions-14d` therefore EXCLUDES
  # `metal-snapshots/*`, or its 14 days would win over the 1-day rule below.

  # A VM snapshot is rewritten on every suspend of its project, so the
  # superseded versions are only useful for one same-host resume. Keep a day.
  rules {
    name        = "expire-previous-snapshot-versions-1d"
    action      = "DELETE"
    time_amount = 1
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"

    object_name_filter {
      inclusion_prefixes = ["metal-snapshots/"]
    }
  }

  # Everything else — live source, writable state, home, `.git`, published
  # data — keeps a replaced version for 14 days, except snapshots above.
  rules {
    name        = "expire-previous-versions-14d"
    action      = "DELETE"
    time_amount = 14
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"

    object_name_filter {
      exclusion_patterns = ["metal-snapshots/*"]
    }
  }
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

  lifecycle {
    # Last line of defence for the database: a replaced bucket silently drops
    # every backup. Fail the plan instead.
    prevent_destroy = true
  }
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

  lifecycle {
    # Every published static site's objects live here. A replace takes all of
    # them offline. Fail the plan instead.
    prevent_destroy = true
  }
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

  lifecycle {
    # Server-backed published apps keep their SQLite DB + uploads here.
    prevent_destroy = true
  }
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
# LLM Proxy Capture Bucket (raw training and analysis archive)
# -----------------------------------------------------------------------------
resource "oci_objectstorage_bucket" "llm_captures" {
  compartment_id = coalesce(var.llm_captures_compartment_id, var.compartment_id)
  namespace      = local.namespace
  name           = "shogo-llm-captures-${var.environment}"
  access_type    = "NoPublicAccess"

  freeform_tags = merge(var.tags, {
    Purpose = "llm-proxy-captures"
  })
}

resource "oci_objectstorage_object_lifecycle_policy" "llm_captures_lifecycle" {
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.llm_captures.name

  rules {
    name        = "delete-expired-captures"
    action      = "DELETE"
    time_amount = var.llm_capture_retention_days
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"
  }
}

# -----------------------------------------------------------------------------
# Project Buckets (per-project object storage + CDN — SHO-491)
# -----------------------------------------------------------------------------
# Every project owns a prefix of this bucket: `p/<projectId>/<visibility>/<key>`.
# The agent puts big media in it from its shell (`shogo bucket put|offload`) and
# the app it builds puts it in through the SDK (`shogo.bucket`), so a project
# stops committing gigabytes to git or `public/`.
#
# Access is presigned (S3 API, same `s3-credentials` as every other bucket), and
# PUBLIC objects are served by the subdomain-router Worker at
# `cdn.<publish_domain>/<projectId>/<key>` through the read-only PAR below. The
# PAR is bucket-wide because OCI pre-authenticated requests cannot be scoped to
# a prefix — the Worker's guard (only `p/<id>/public/<key>`) is what keeps
# private objects off the CDN, and it is covered by a unit test in
# apps/api/src/__tests__/project-bucket-cdn.test.ts.
resource "oci_objectstorage_bucket" "project_buckets" {
  compartment_id = var.compartment_id
  namespace      = local.namespace
  name           = "shogo-project-buckets-${var.environment}"
  access_type    = "NoPublicAccess"
  # Versioning off: these are user-managed media objects with their own
  # `overwrite` semantics, and a per-version copy of a 500 MB video is a bill
  # nobody asked for. The index row (`ProjectBucketObject`) is the source of
  # truth for what exists.
  versioning = "Disabled"

  freeform_tags = merge(var.tags, {
    Purpose = "project-object-storage"
  })

  lifecycle {
    # User-uploaded project media (SHO-491). A replace loses user data with no
    # second copy anywhere. Fail the plan instead.
    prevent_destroy = true
  }
}

resource "oci_objectstorage_object_lifecycle_policy" "project_buckets_lifecycle" {
  depends_on = [oci_identity_policy.lifecycle_service_principal]

  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.project_buckets.name

  # An agent that dies mid-upload leaves a multipart upload holding parts. Reap
  # them after 3 days so an abandoned 5 GB upload does not sit in the bucket
  # (and in the workspace's storage bill) forever.
  rules {
    name        = "abort-incomplete-multipart-uploads"
    action      = "ABORT"
    time_amount = 3
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "multipart-uploads"
  }
}

resource "oci_objectstorage_preauthrequest" "project_buckets" {
  namespace             = local.namespace
  bucket                = oci_objectstorage_bucket.project_buckets.name
  name                  = "cloudflare-cdn-access"
  access_type           = "AnyObjectRead"
  bucket_listing_action = "Deny"
  time_expires          = timeadd(timestamp(), "8760h") # 1 year

  lifecycle {
    # Same reasoning as the published-apps PAR: the Worker embeds this PAR's
    # `access_uri`, so the replacement must exist before the old one is
    # destroyed, or the CDN 404s every project object until the Worker update
    # propagates.
    create_before_destroy = true
    ignore_changes        = [time_expires, bucket_listing_action]
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

output "llm_captures_bucket" {
  description = "Raw LLM proxy capture archive bucket name"
  value       = oci_objectstorage_bucket.llm_captures.name
}

output "project_buckets_bucket" {
  description = "Per-project object storage bucket name (SHO-491). Wire into the API as S3_PROJECT_BUCKET."
  value       = oci_objectstorage_bucket.project_buckets.name
}

output "project_buckets_par_base_url" {
  description = "Read-only PAR base URL the subdomain-router Worker uses as the CDN origin for public project objects. Wire into module.publish_hosting.project_bucket_origin."
  value       = "https://objectstorage.${var.region}.oraclecloud.com${oci_objectstorage_preauthrequest.project_buckets.access_uri}"
}

output "lifecycle_service_policy_id" {
  description = "OCID of the tenancy-scoped `objectstorage-<region>` service-principal IAM policy, or null when this region does not own it. Pass to any module whose lifecycle policies must be created after it (e.g. module.studio_web_assets.lifecycle_service_policy_id) so the ordering is a value dependency instead of a module-level depends_on."
  value       = one(oci_identity_policy.lifecycle_service_principal[*].id)
}
