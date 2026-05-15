# =============================================================================
# Publish Hosting Module — OCI Object Storage + Cloudflare
# =============================================================================
# Serves published static apps at *.shogo.one using:
# - OCI Object Storage for static content
# - Cloudflare CDN for edge caching and SSL
# - Cloudflare Worker for subdomain-to-path routing
#
# Replaces: S3 + CloudFront + CloudFront Function
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
  description = "OCI compartment OCID"
  type        = string
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

variable "publish_domain" {
  description = "Base domain for published apps (e.g. shogo.one)"
  type        = string
  default     = "shogo.one"
}

variable "cloudflare_zone_id" {
  description = "DEPRECATED: this module now looks up the publish zone by name via `data.cloudflare_zone.publish`, so this variable is unused. Kept for backwards-compat with the production envs' module call signature; remove next time those envs get touched."
  type        = string
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (for Workers)"
  type        = string
}

variable "oci_region" {
  description = "OCI region (e.g. us-ashburn-1)"
  type        = string
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------
data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

# Look up the publish zone (e.g. shogo.one) by name. The token used for tf
# needs `Zone:Read` on this zone in addition to `Workers Routes:Edit` and
# `Zone DNS:Edit`. Sourcing by name keeps callers from having to thread a
# second zone-id variable through every env.
data "cloudflare_zone" "publish" {
  name = var.publish_domain
}

# -----------------------------------------------------------------------------
# OCI Object Storage Bucket (already created by object-storage module,
# but we reference it here for the PAR)
# -----------------------------------------------------------------------------

# Pre-authenticated request for Cloudflare to access the bucket.
# This creates a read-only URL that doesn't require OCI credentials.
#
# `access_type = "AnyObjectRead"` lets the Worker GET any key it knows;
# `bucket_listing_action = "Deny"` prevents enumeration of the bucket
# contents via that same PAR. Together they're equivalent to the old
# `AnyObjectReadWithoutList` (which was not a real OCI API value and
# fails provider validation — see commit history).
resource "oci_objectstorage_preauthrequest" "published_apps" {
  namespace             = data.oci_objectstorage_namespace.current.namespace
  bucket                = "shogo-published-apps-${var.environment}"
  name                  = "cloudflare-cdn-access"
  access_type           = "AnyObjectRead"
  bucket_listing_action = "Deny"
  time_expires          = timeadd(timestamp(), "8760h") # 1 year

  lifecycle {
    # `bucket_listing_action` is set correctly on create (verified via the
    # OCI CLI) but the provider's Read implementation never populates it
    # back into state, so every subsequent plan sees `null -> "Deny"` and
    # flags it as a force-new replacement. Ignoring it pins state to
    # whatever was set on the original create.
    # `time_expires` is set to `timestamp() + 1y` which would also drift
    # every plan.
    ignore_changes = [time_expires, bucket_listing_action]
  }
}

locals {
  # The PAR gives us a base URL that Cloudflare Worker can use as origin
  par_base_url = "https://objectstorage.${var.oci_region}.oraclecloud.com${oci_objectstorage_preauthrequest.published_apps.access_uri}"
}

# -----------------------------------------------------------------------------
# Cloudflare Worker — Subdomain Router
# Routes *.shogo.one requests to the correct path in Object Storage.
# Equivalent to the CloudFront Function in the AWS module.
# -----------------------------------------------------------------------------
resource "cloudflare_worker_script" "subdomain_router" {
  account_id = var.cloudflare_account_id
  name       = "shogo-subdomain-router-${var.environment}"
  # `module = true` switches the Worker runtime to ES Modules syntax
  # (the `export default { fetch(...) }` form below). Without it, the
  # Worker runtime treats the content as a legacy service-worker script
  # and rejects the file with "Uncaught SyntaxError: Unexpected token
  # 'export'" at deploy time.
  module  = true
  content = <<-JS
    export default {
      async fetch(request) {
        const url = new URL(request.url);
        const host = url.hostname;
        const subdomain = host.split('.')[0];

        // Rewrite path: /index.html → /subdomain/index.html
        let path = url.pathname;
        if (path === '/' || path === '') {
          path = '/' + subdomain + '/index.html';
        } else {
          path = '/' + subdomain + path;
        }

        // Fetch from OCI Object Storage via pre-authenticated request
        const originUrl = '${local.par_base_url}' + path;

        const response = await fetch(originUrl, {
          headers: {
            'User-Agent': 'Cloudflare-Worker',
          },
        });

        if (response.status === 404 || response.status === 403) {
          // SPA fallback: serve index.html for client-side routing
          const fallbackUrl = '${local.par_base_url}/' + subdomain + '/index.html';
          const fallback = await fetch(fallbackUrl);
          return new Response(fallback.body, {
            status: 200,
            headers: fallback.headers,
          });
        }

        return response;
      }
    };
  JS
}

# Route *.shogo.one traffic through the Worker
resource "cloudflare_worker_route" "published_apps" {
  zone_id     = data.cloudflare_zone.publish.id
  pattern     = "*.${var.publish_domain}/*"
  script_name = cloudflare_worker_script.subdomain_router.name
}

# Wildcard DNS record pointing to Cloudflare (proxied for CDN + SSL).
#
# Cloudflare rejects proxied records that target reserved CIDRs
# (RFC 1918, CGNAT 100.64.0.0/10, etc) with API error 9003. The actual
# routing is handled by the Worker (`cloudflare_worker_route` above)
# which intercepts every request that matches `*.${publish_domain}/*`
# *before* the proxy ever attempts a fetch against this origin, so the
# IP itself never resolves — it just needs to be a syntactically valid
# A record that CF will accept. `192.0.2.1` (RFC 5737 TEST-NET-1
# documentation range) is the standard "this IP intentionally
# unreachable" choice that CF accepts for proxied records.
resource "cloudflare_record" "wildcard" {
  zone_id = data.cloudflare_zone.publish.id
  name    = "*"
  content = "192.0.2.1"
  type    = "A"
  proxied = true

  # The `*.shogo.one` record was created manually before this module
  # adopted it. Without `allow_overwrite`, the cloudflare provider's
  # Create errors with "expected DNS record to not already be present
  # but already exists" instead of taking ownership of the existing
  # record. Flipping this on lets tf adopt the live record on first
  # apply, after which subsequent plans reconcile normally.
  allow_overwrite = true
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "publish_domain" {
  description = "Base domain for published apps"
  value       = var.publish_domain
}

output "worker_name" {
  description = "Cloudflare Worker name"
  value       = cloudflare_worker_script.subdomain_router.name
}
