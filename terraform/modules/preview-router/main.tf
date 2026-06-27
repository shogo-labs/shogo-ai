# =============================================================================
# Preview Router Module — Cloudflare Worker + KV
# =============================================================================
# Routes per-project preview traffic (`preview--{projectId}.<preview_base_domain>`)
# to the Knative (Kourier) ingress of whichever region actually hosts the
# project, WITHOUT a per-preview DNS record.
#
# Why this exists
# ---------------
# A single flat `*.<preview_base_domain>` wildcard can only point at one region.
# The old approach overrode the wildcard with one proxied A record per live
# preview, which scaled linearly with active previews and hit the zone's
# 200-record quota (CF error 81045 "Record quota exceeded").
#
# This module replaces those N records with:
#   - ONE Workers KV namespace (`PREVIEW_REGIONS`): projectId -> region code.
#     Written by the API in each region when a preview DomainMapping is created,
#     deleted when it's torn down. KV is effectively unlimited, so the
#     200-record ceiling no longer applies.
#   - ONE Worker on `preview--*.<preview_base_domain>/*` that reads the region
#     from KV and `resolveOverride`s the connection to that region's Kourier
#     anchor.
#   - ONE proxied "anchor" A record per region (`kourier-<code>[.<infix>]` in
#     the zone). resolveOverride requires the override host to be proxied in the
#     same zone as the request host (the `*.<preview_base_domain>` wildcard
#     already provides the proxied request host). Same mechanism the publish
#     Worker uses for server-backed `/api/*` (see terraform/environments/
#     production-us: `kourier_us` + resolveOverride).
#
# Fallback: on any KV miss / unparseable host / missing binding the Worker
# targets `default_region`, so previews in that region work with zero KV state
# and the blast radius of a miss is "routed to the default region" rather than a
# hard failure.
#
# Multi-instance / multi-env safety
# ---------------------------------
# Anchor record names and the Worker route are namespaced by `preview_base_domain`
# (e.g. prod `shogo.ai` vs staging `staging.shogo.ai`), so this module can be
# instantiated once per environment against the SAME Cloudflare zone without
# collision. Cloudflare picks the most-specific (longest) matching Worker route,
# so a staging route `preview--*.staging.shogo.ai/*` takes precedence over a
# prod route `preview--*.shogo.ai/*` for staging hostnames.
# =============================================================================

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "environment" {
  description = "Environment name (e.g. production, staging). Used to title the KV namespace and Worker."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (for Workers + KV)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID that hosts `preview_base_domain` and the anchors (e.g. the shogo.ai zone)."
  type        = string
}

variable "zone_name" {
  description = "Cloudflare zone NAME for `cloudflare_zone_id` (e.g. shogo.ai). Used to compute relative anchor record names when `preview_base_domain` is a subdomain of the zone."
  type        = string
}

variable "preview_base_domain" {
  description = "Base domain for preview hostnames (e.g. shogo.ai, or staging.shogo.ai). Preview hosts are `preview--{projectId}.{preview_base_domain}`."
  type        = string
}

variable "region_anchors" {
  description = "Map of region code (the value the API writes to KV, e.g. `us`/`eu`/`in`/`staging`) to that region's Kourier LoadBalancer IP. One proxied anchor record is created per entry."
  type        = map(string)

  validation {
    condition     = length(var.region_anchors) > 0
    error_message = "region_anchors must contain at least one region."
  }
}

variable "default_region" {
  description = "Region code the Worker targets on any KV miss / unparseable host. Must be a key in `region_anchors`."
  type        = string

  validation {
    condition     = length(var.default_region) > 0
    error_message = "default_region must be set."
  }
}

locals {
  # Relative infix below the zone when preview_base_domain is a subdomain of the
  # zone. prod: preview_base_domain == zone_name -> "" -> anchor `kourier-us`.
  # staging: `staging.shogo.ai` under `shogo.ai` -> "staging" -> anchor
  # `kourier-us.staging` (FQDN kourier-us.staging.shogo.ai).
  anchor_infix = (
    var.preview_base_domain == var.zone_name
    ? ""
    : trimsuffix(var.preview_base_domain, ".${var.zone_name}")
  )

  anchor_record_name = {
    for code in keys(var.region_anchors) :
    code => local.anchor_infix == "" ? "kourier-${code}" : "kourier-${code}.${local.anchor_infix}"
  }
}

# -----------------------------------------------------------------------------
# Workers KV — preview region map
# -----------------------------------------------------------------------------
# Maps a project UUID to the short region code of the cluster currently hosting
# its preview DomainMapping. Written by the API (apps/api/src/lib/
# cloudflare-preview-region-kv.ts) on DomainMapping create, deleted on teardown.
# Read by the preview-router Worker below. The namespace id is exported so each
# region's api ksvc env can be wired to it (CF_PREVIEW_REGIONS_KV_NAMESPACE_ID).
resource "cloudflare_workers_kv_namespace" "preview_regions" {
  account_id = var.cloudflare_account_id
  title      = "shogo-preview-regions-${var.environment}"
}

# -----------------------------------------------------------------------------
# Region anchors — proxied A records the Worker resolveOverrides to
# -----------------------------------------------------------------------------
# Proxied because resolveOverride only works when both the request host and the
# override host are orange-clouded in the same zone. They do NOT match this
# module's `preview--*` Worker route, so the Worker's origin-pull subrequest
# never re-enters the Worker (no self-loop) and no bypass route is required.
resource "cloudflare_record" "anchor" {
  for_each = var.region_anchors

  zone_id = var.cloudflare_zone_id
  name    = local.anchor_record_name[each.key]
  content = each.value
  type    = "A"
  proxied = true
  ttl     = 1
  comment = "Preview-router resolveOverride anchor (${var.environment}/${each.key} Kourier LB)"
}

# -----------------------------------------------------------------------------
# Cloudflare Worker — Preview Router
# -----------------------------------------------------------------------------
# NOTE: this content is a Terraform HEREDOC, so `${...}` is TERRAFORM
# interpolation. The JS deliberately avoids template literals (backticks) and
# uses string concatenation so it never collides with Terraform interpolation.
# `ANCHORS` is injected as a JSON object literal (code -> anchor hostname).
resource "cloudflare_worker_script" "preview_router" {
  account_id = var.cloudflare_account_id
  name       = "shogo-preview-router-${var.environment}"
  module     = true

  kv_namespace_binding {
    name         = "PREVIEW_REGIONS"
    namespace_id = cloudflare_workers_kv_namespace.preview_regions.id
  }

  content = <<-JS
    const ANCHORS = ${jsonencode({ for code, r in cloudflare_record.anchor : code => r.hostname })};
    const DEFAULT_REGION = '${var.default_region}';

    function anchorFor(region) {
      if (region && ANCHORS[region]) return ANCHORS[region];
      return ANCHORS[DEFAULT_REGION] || Object.values(ANCHORS)[0];
    }

    // preview--{projectId}.{base} -> projectId. The projectId is a UUID with
    // no dots, so the first label after the `preview--` prefix is the id.
    function projectIdFromHost(hostname) {
      if (hostname.indexOf('preview--') !== 0) return null;
      var rest = hostname.slice('preview--'.length);
      var dot = rest.indexOf('.');
      return dot === -1 ? rest : rest.slice(0, dot);
    }

    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        const projectId = projectIdFromHost(url.hostname);

        // Resolve the hosting region from KV. Any failure (unparseable host,
        // missing binding, KV miss, KV error) falls through to DEFAULT_REGION,
        // which is also where the flat wildcard points — so default-region
        // previews need no KV state and a miss degrades to "routed to the
        // default region" instead of a hard failure.
        let region = null;
        if (projectId && env.PREVIEW_REGIONS) {
          try { region = await env.PREVIEW_REGIONS.get(projectId); } catch (e) {}
        }

        const anchor = anchorFor(region);

        // Keep the original preview host in the URL so Cloudflare sends
        // Host: preview--{projectId}.{base} (which the regional Kourier
        // DomainMapping routes to the project's ksvc) and ONLY override DNS
        // resolution to the regional Kourier anchor. resolveOverride requires
        // both the URL host and the anchor to be proxied in this zone; the
        // anchor host does not match this Worker's `preview--*` route, so the
        // origin-pull subrequest does not re-enter the Worker (no loop).
        return fetch(request, { cf: { resolveOverride: anchor } });
      }
    };
  JS
}

# Route preview--*.{preview_base_domain} traffic through the Worker. The flat
# `*.{preview_base_domain}` wildcard A record (managed elsewhere) supplies the
# proxied request host this route matches against.
resource "cloudflare_worker_route" "preview" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "preview--*.${var.preview_base_domain}/*"
  script_name = cloudflare_worker_script.preview_router.name
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "preview_regions_kv_namespace_id" {
  description = "Workers KV namespace id for the preview region map. Wire into EVERY region's api ksvc as CF_PREVIEW_REGIONS_KV_NAMESPACE_ID so each region records the location of the previews it hosts."
  value       = cloudflare_workers_kv_namespace.preview_regions.id
}

output "worker_name" {
  description = "Cloudflare Worker name for the preview router."
  value       = cloudflare_worker_script.preview_router.name
}

output "anchor_hostnames" {
  description = "The proxied Kourier anchor hostnames the Worker resolveOverrides to, by region code."
  value       = { for code, r in cloudflare_record.anchor : code => r.hostname }
}
