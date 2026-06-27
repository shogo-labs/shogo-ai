# =============================================================================
# Preview Router Module — Cloudflare Worker + KV
# =============================================================================
# Routes per-project preview traffic (`{projectId}.<preview_base_domain>`, e.g.
# `{projectId}.preview.shogo.ai`) to the Knative (Kourier) ingress of whichever
# region actually hosts the project, WITHOUT a per-preview DNS record.
#
# Why this exists
# ---------------
# A single flat `*.shogo.ai` wildcard can only point at one region. The old
# approach overrode the wildcard with one proxied A record per live preview
# (`preview--{id}.shogo.ai`), which scaled linearly with active previews and hit
# the zone's 200-record quota (CF error 81045 "Record quota exceeded").
#
# Why a dedicated `*.preview.<base>` subtree
# ------------------------------------------
# Cloudflare Worker routes only allow a wildcard at the START of the hostname
# (CF error 10022 rejects `preview--*.shogo.ai/*`). So a single Worker route
# cannot target the old `preview--{id}.shogo.ai` scheme. Instead, previews live
# under a dedicated `*.preview.<base>` subtree that the Worker owns entirely via
# the valid leading-wildcard route `*.preview.<base>/*` — the same way the
# publish Worker owns the dedicated `*.shogo.one` zone.
#
# This module provisions:
#   - ONE Workers KV namespace (`PREVIEW_REGIONS`): projectId -> region code.
#     Written by the API in each region on DomainMapping create/delete. KV is
#     effectively unlimited, so the 200-record ceiling no longer applies.
#   - ONE proxied wildcard A record `*.preview.<base>` — the request host the
#     route matches against and the resolveOverride source. Points at the
#     default region's Kourier LB so previews work even with empty KV.
#   - ONE advanced certificate pack covering `*.preview.<base>`. Universal SSL
#     only covers the apex + a single `*.<zone>` level, so the 2nd-level
#     wildcard needs an ACM advanced cert (mirrors the zone's existing
#     `*.studio.shogo.ai` advanced cert). Total TLS only issues per-hostname
#     certs for records that exist, so it cannot cover a wildcard-only subtree.
#   - ONE proxied "anchor" A record per region (`kourier-preview-<code>`).
#     resolveOverride requires the override host to be proxied in the same zone.
#     Distinct from the publish Worker's `kourier-<code>` records (owned by the
#     per-region states) to avoid cross-state ownership collisions.
#   - ONE Worker on `*.preview.<base>/*` that reads the region from KV and
#     `resolveOverride`s the connection to that region's anchor.
#
# Fallback: on any KV miss / unparseable host / missing binding the Worker
# targets `default_region`, which is also where the wildcard points — so
# default-region previews need zero KV state and a miss degrades to "routed to
# the default region" rather than a hard failure.
#
# Multi-instance / multi-env safety
# ---------------------------------
# The wildcard, cert, anchors and route are all derived from `preview_base_domain`
# (prod `preview.shogo.ai` vs staging `preview.staging.shogo.ai`), so this module
# can be instantiated once per environment against the SAME Cloudflare zone
# without collision. Cloudflare picks the most-specific (longest) matching Worker
# route, so the staging route `*.preview.staging.shogo.ai/*` takes precedence over
# the prod route `*.preview.shogo.ai/*` for staging hostnames.
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
  description = "Cloudflare zone NAME for `cloudflare_zone_id` (e.g. shogo.ai). Used to compute record names relative to the zone."
  type        = string
}

variable "preview_base_domain" {
  description = "Parent domain for preview hostnames (e.g. preview.shogo.ai, or preview.staging.shogo.ai). Preview hosts are `{projectId}.{preview_base_domain}`. MUST be `zone_name` or a subdomain of it (used to derive record names relative to the zone)."
  type        = string
}

variable "region_anchors" {
  description = "Map of region code (the value the API writes to KV, e.g. `us`/`eu`/`in`/`staging`) to that region's Kourier LoadBalancer IP. One proxied anchor record (`kourier-preview-<code>`) is created per entry."
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
  # preview_base_domain relative to the zone. prod: `preview.shogo.ai` under
  # `shogo.ai` -> `preview`. staging: `preview.staging.shogo.ai` -> `preview.staging`.
  preview_relative = (
    var.preview_base_domain == var.zone_name
    ? "@"
    : trimsuffix(var.preview_base_domain, ".${var.zone_name}")
  )

  # Proxied wildcard request host: `*.preview.shogo.ai` -> record name `*.preview`.
  wildcard_record_name = "*.${local.preview_relative}"

  # Anchor records are namespaced (`kourier-preview-<code>`) to avoid colliding
  # with the publish Worker's `kourier-<code>` records owned by per-region states.
  anchor_record_name = {
    for code in keys(var.region_anchors) :
    code => "kourier-preview-${code}"
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
# override host are orange-clouded in the same zone. Their names do NOT match
# this module's `*.preview.<base>` Worker route, so the Worker's origin-pull
# subrequest never re-enters the Worker (no self-loop) and no bypass route is
# required.
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
# Proxied wildcard request host — `*.preview.<base>`
# -----------------------------------------------------------------------------
# This is the host the Worker route matches against and the resolveOverride
# source (resolveOverride requires the request host to be proxied in the zone).
# Points at the default region's LB so a preview resolves correctly even when
# the Worker is bypassed or KV is empty.
resource "cloudflare_record" "preview_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = local.wildcard_record_name
  content = var.region_anchors[var.default_region]
  type    = "A"
  proxied = true
  ttl     = 1
  comment = "Preview-router wildcard request host (${var.environment}); Worker resolveOverrides per-project"
}

# -----------------------------------------------------------------------------
# Advanced certificate pack — wildcard TLS for `*.preview.<base>`
# -----------------------------------------------------------------------------
# Universal SSL covers the apex + a single `*.<zone>` level only, so the
# 2nd-level (or deeper) wildcard `*.preview.<base>` needs an ACM advanced cert.
# Mirrors the zone's existing `*.studio.shogo.ai` advanced cert. DCV is handled
# automatically by Cloudflare for a zone using CF nameservers.
resource "cloudflare_certificate_pack" "preview" {
  zone_id               = var.cloudflare_zone_id
  type                  = "advanced"
  hosts                 = [var.preview_base_domain, "*.${var.preview_base_domain}"]
  validation_method     = "txt"
  validity_days         = 90
  certificate_authority = "google"
  cloudflare_branding   = false

  lifecycle {
    create_before_destroy = true
  }
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

    // {projectId}.preview.<base> -> projectId. The projectId is the first DNS
    // label (a UUID with no dots), which the `*.preview.<base>` route captures.
    function projectIdFromHost(hostname) {
      var dot = hostname.indexOf('.');
      if (dot <= 0) return null;
      return hostname.slice(0, dot);
    }

    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        const projectId = projectIdFromHost(url.hostname);

        // Resolve the hosting region from KV. Any failure (unparseable host,
        // missing binding, KV miss, KV error) falls through to DEFAULT_REGION,
        // which is also where the wildcard points — so default-region previews
        // need no KV state and a miss degrades to "routed to the default
        // region" instead of a hard failure.
        let region = null;
        if (projectId && env.PREVIEW_REGIONS) {
          try { region = await env.PREVIEW_REGIONS.get(projectId); } catch (e) {}
        }

        const anchor = anchorFor(region);

        // Keep the original preview host in the URL so Cloudflare sends
        // Host: {projectId}.preview.<base> (which the regional Kourier
        // DomainMapping routes to the project's ksvc) and ONLY override DNS
        // resolution to the regional Kourier anchor. resolveOverride requires
        // both the URL host and the anchor to be proxied in this zone; the
        // anchor host does not match this Worker's `*.preview.<base>` route, so
        // the origin-pull subrequest does not re-enter the Worker (no loop).
        return fetch(request, { cf: { resolveOverride: anchor } });
      }
    };
  JS
}

# Route all `*.preview.<base>` traffic through the Worker. The proxied wildcard
# record above supplies the request host this route matches against.
resource "cloudflare_worker_route" "preview" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "*.${var.preview_base_domain}/*"
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

output "preview_wildcard_hostname" {
  description = "The proxied wildcard request host (`*.preview.<base>`) the Worker route matches."
  value       = cloudflare_record.preview_wildcard.hostname
}

output "certificate_pack_id" {
  description = "Advanced certificate pack id covering `*.preview.<base>`."
  value       = cloudflare_certificate_pack.preview.id
}
