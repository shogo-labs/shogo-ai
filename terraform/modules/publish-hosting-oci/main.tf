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
      version = "~> 6.0"
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
  description = "Cloudflare zone ID for the publish domain"
  type        = string
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

# -----------------------------------------------------------------------------
# OCI Object Storage Bucket (already created by object-storage module,
# but we reference it here for the PAR)
# -----------------------------------------------------------------------------

# Pre-authenticated request for Cloudflare to access the bucket
# This creates a read-only URL that doesn't require OCI credentials
resource "oci_objectstorage_preauthrequest" "published_apps" {
  namespace    = data.oci_objectstorage_namespace.current.namespace
  bucket       = "shogo-published-apps-${var.environment}"
  name         = "cloudflare-cdn-access"
  access_type  = "AnyObjectReadWithoutList"
  time_expires = timeadd(timestamp(), "8760h") # 1 year

  lifecycle {
    ignore_changes = [time_expires]
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
  content    = <<-JS
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
  zone_id     = var.cloudflare_zone_id
  pattern     = "*.${var.publish_domain}/*"
  script_name = cloudflare_worker_script.subdomain_router.name
}

# Wildcard DNS record pointing to Cloudflare (proxied for CDN + SSL)
resource "cloudflare_record" "wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*"
  content = "100.64.0.1" # Dummy IP — Worker intercepts all traffic
  type    = "A"
  proxied = true
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
