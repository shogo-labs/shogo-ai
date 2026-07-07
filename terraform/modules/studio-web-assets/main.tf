# =============================================================================
# Studio Web Assets Module - shared immutable asset origin (OCI + Cloudflare)
# =============================================================================
# Serves the studio web app's immutable, content-hashed Expo output
# (`/_expo/*`) from a shared, append-only OCI Object Storage bucket, fronted
# same-origin by a Cloudflare Worker on `studio.<env>.shogo.ai/_expo/*`.
#
# WHY THIS EXISTS
# ---------------
# The studio web app is an Expo "single"-output SPA whose hashed assets were
# previously baked into each nginx pod image. Knative keeps multiple studio
# revisions alive (min-scale + the `studio-direct` broad selector), so a page
# load could get `index.html` from build A and then 404 on A's
# `/_expo/.../index-<hashA>.js` because the asset request was load-balanced to
# build B's pod, which only has B's hashes.
#
# Because the filenames are content-hashed they are globally unique, so
# uploading every build's `_expo/*` into ONE append-only bucket lets
# `index-<hashA>.js` and `index-<hashB>.js` coexist forever. This Worker serves
# `/_expo/*` from that bucket regardless of which revision served the HTML,
# which makes the multi-revision asset-404 class of bug impossible. It also
# makes rollbacks and mid-deploy loads safe for free.
#
# CI (.github/workflows/deploy.yml, "Upload web static assets to CDN bucket")
# uploads `dist/_expo` to this bucket BEFORE the ksvc is patched, using
# `aws s3 cp --recursive` (re-PUTs the full current asset set each deploy) so
# the age-based lifecycle GC below never reaps a still-referenced asset.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "compartment_id" {
  description = "OCI compartment OCID for the assets bucket."
  type        = string
}

variable "environment" {
  description = "Environment name (staging, production). Used in the bucket name and Worker name."
  type        = string
}

variable "oci_region" {
  description = "OCI region (e.g. us-ashburn-1). Used to build the PAR base URL."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id that hosts `studio_host` (the shogo.ai zone). The Worker route attaches here; the tf token needs Workers Routes:Edit on this zone. No DNS record is created - `studio_host` is managed out-of-band and only needs to be proxied for the route to match."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id (for the Worker script)."
  type        = string
}

variable "studio_host" {
  description = "Fully-qualified studio hostname whose `/_expo/*` requests the Worker serves from the bucket (e.g. studio.staging.shogo.ai). Must be a proxied (orange-cloud) record in `cloudflare_zone_id`."
  type        = string
}

variable "asset_max_age_days" {
  description = "Age (days since object creation) after which an asset is deleted by the bucket lifecycle policy. Because CI re-PUTs the full current asset set each deploy, this reaps only assets no deploy has referenced for this many days. Keep comfortably larger than the longest expected gap between studio web deploys."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Freeform tags applied to the bucket."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Data sources
# -----------------------------------------------------------------------------
data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

locals {
  namespace   = data.oci_objectstorage_namespace.current.namespace
  bucket_name = "shogo-web-assets-${var.environment}"

  # PAR access_uri ends in `/o/`; strip trailing slashes in the Worker before
  # concatenating the object key so we never emit a double slash (a leading `//`
  # makes OCI parse the object name with a leading slash and 404 every asset).
  par_base_url = "https://objectstorage.${var.oci_region}.oraclecloud.com${oci_objectstorage_preauthrequest.assets.access_uri}"
}

# -----------------------------------------------------------------------------
# OCI Object Storage bucket - append-only, content-hashed studio assets
# -----------------------------------------------------------------------------
# Versioning is Disabled on purpose: keys are content-hashed, so a given key is
# never meaningfully overwritten with different bytes (CI re-PUTs identical
# bytes to refresh the object timestamp for lifecycle GC). New builds add new
# keys; the lifecycle rule below bounds growth.
resource "oci_objectstorage_bucket" "assets" {
  compartment_id = var.compartment_id
  namespace      = local.namespace
  name           = local.bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Disabled"

  freeform_tags = merge(var.tags, {
    Purpose = "studio-web-immutable-assets"
  })
}

# Reap assets no deploy has referenced for `asset_max_age_days`. Relies on the
# tenancy-scoped `Allow service objectstorage-<region> to manage object-family`
# IAM policy created by the object-storage module; wire this module with
# `depends_on = [module.object_storage]` so that policy exists first.
resource "oci_objectstorage_object_lifecycle_policy" "assets_lifecycle" {
  namespace = local.namespace
  bucket    = oci_objectstorage_bucket.assets.name

  rules {
    name        = "reap-unreferenced-assets"
    action      = "DELETE"
    time_amount = var.asset_max_age_days
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"
  }
}

# -----------------------------------------------------------------------------
# Pre-authenticated request - read-only, non-listable bucket access for the edge
# -----------------------------------------------------------------------------
# Mirrors terraform/modules/publish-hosting-oci: AnyObjectRead + listing Deny is
# equivalent to the old AnyObjectReadWithoutList. create_before_destroy keeps a
# valid PAR referenced at all times (the Worker embeds this access_uri), and the
# ignore_changes pins state against the provider's Read never repopulating
# bucket_listing_action / the rolling time_expires.
resource "oci_objectstorage_preauthrequest" "assets" {
  namespace             = local.namespace
  bucket                = oci_objectstorage_bucket.assets.name
  name                  = "cloudflare-cdn-access"
  access_type           = "AnyObjectRead"
  bucket_listing_action = "Deny"
  time_expires          = timeadd(timestamp(), "8760h") # 1 year

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [time_expires, bucket_listing_action]
  }
}

# -----------------------------------------------------------------------------
# Cloudflare Worker - serve /_expo/* from the bucket, fall back to origin
# -----------------------------------------------------------------------------
resource "cloudflare_worker_script" "studio_assets" {
  account_id = var.cloudflare_account_id
  name       = "shogo-studio-assets-${var.environment}"
  # ES-modules syntax (export default { fetch }). Without module=true the
  # runtime rejects `export` with a SyntaxError at deploy time.
  module = true

  # NOTE: this HEREDOC is processed by Terraform, so the JS uses string
  # concatenation and avoids JS template literals (which use ${...}).
  content = <<-JS
    // Trailing slashes trimmed so ORIGIN_BASE ends at `/o` and we join with a
    // single `/` (a `//` would make OCI 404 the object).
    const ORIGIN_BASE = '${local.par_base_url}'.replace(/\/+$/, '');

    // Fall back to the studio origin for anything the bucket can't serve. This
    // is a same-zone subrequest, so it BYPASSES this Worker (no self-loop) and
    // hits Kourier -> the current studio pod, which still has this build's
    // assets baked into its image. Tagged so we can see fallbacks in responses.
    async function originFallback(request) {
      const fallback = await fetch(request);
      const headers = new Headers(fallback.headers);
      headers.set('X-Shogo-Asset-Origin', 'origin-fallback');
      return new Response(fallback.body, { status: fallback.status, headers: headers });
    }

    export default {
      async fetch(request, env) {
        // SAFETY: any unexpected error must fall back to the origin rather than
        // surfacing a Worker 1101 — this Worker sits in the live path for every
        // studio /_expo asset, so a throw here would blank the whole app.
        try {
          // Only GET/HEAD are cacheable static asset reads.
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return await originFallback(request);
          }

          const url = new URL(request.url);
          // Object key mirrors the request path without its leading slash:
          // `/_expo/static/js/web/index-x.js` -> `_expo/static/js/web/index-x.js`.
          const key = url.pathname.replace(/^\/+/, '');
          const originUrl = ORIGIN_BASE + '/' + key;

          // Serve from the shared bucket, edge-cached aggressively (assets are
          // content-hashed / immutable).
          const fromBucket = await fetch(originUrl, {
            headers: { 'User-Agent': 'Cloudflare-Worker-StudioAssets' },
            cf: { cacheEverything: true, cacheTtl: 31536000 },
          });

          if (fromBucket.ok) {
            const headers = new Headers(fromBucket.headers);
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            headers.set('X-Shogo-Asset-Origin', 'bucket');
            return new Response(fromBucket.body, {
              status: fromBucket.status,
              headers: headers,
            });
          }

          // Bucket miss (e.g. an upload that lagged the ksvc patch).
          return await originFallback(request);
        } catch (e) {
          // Network error / unexpected throw: never break the asset path.
          try {
            return await originFallback(request);
          } catch (e2) {
            return new Response('studio asset worker error', { status: 502 });
          }
        }
      },
    };
  JS
}

# Route only `/_expo/*` on the studio host through the Worker. Everything else
# (`/`, `/api/*`, WebSockets, `/vs/*`, favicon) keeps flowing to Kourier as
# before. The route attaches to the zone regardless of who manages the DNS
# record, as long as `studio_host` is proxied.
resource "cloudflare_worker_route" "studio_assets" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "${var.studio_host}/_expo/*"
  script_name = cloudflare_worker_script.studio_assets.name
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "bucket_name" {
  description = "Name of the studio web assets bucket. Use as the `aws s3 cp` target in CI (s3://<bucket_name>/_expo/)."
  value       = oci_objectstorage_bucket.assets.name
}

output "worker_name" {
  description = "Cloudflare Worker script name serving studio /_expo/*."
  value       = cloudflare_worker_script.studio_assets.name
}

output "worker_route_pattern" {
  description = "Cloudflare Worker route pattern."
  value       = cloudflare_worker_route.studio_assets.pattern
}
