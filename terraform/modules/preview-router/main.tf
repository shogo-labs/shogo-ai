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

variable "api_wake_origin" {
  description = "Base origin of the Shogo API (e.g. https://api.shogo.ai) that the preview-router Worker calls to provision + wake a preview pod on visit. Unlike published apps, a preview's Knative DomainMapping + pod are created lazily by the API (getProjectPodUrl), so a preview that was never opened in Studio has nothing for Kourier to route to. When set, the Worker serves a loading page on first navigation that polls `GET {api_wake_origin}/api/preview/{projectId}/wake` (an anonymous endpoint) and reloads once the pod is ready. Leave null to disable the wake/loading behavior (the Worker then proxies transparently as before)."
  type        = string
  default     = null
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

  # allow_custom_ports lets the Worker fetch() a grey-clouded origin on a
  # non-standard port. Metal projects are served over the box's PUBLIC DNAT
  # ports (20000-20999) — without this flag the port is silently dropped to
  # 80/443 and the metal proxy fails. Only affects grey-clouded (non-Cloudflare)
  # origins; orange-clouded hosts (the Kourier anchors) are unaffected.
  compatibility_date  = "2024-11-01"
  compatibility_flags = ["allow_custom_ports"]

  kv_namespace_binding {
    name         = "PREVIEW_REGIONS"
    namespace_id = cloudflare_workers_kv_namespace.preview_regions.id
  }

  # Origin of the Shogo API the Worker calls to provision + wake a preview pod
  # on visit. Only bound when configured; the Worker guards on
  # `env.API_WAKE_ORIGIN` and falls back to transparent proxying when unset.
  dynamic "plain_text_binding" {
    for_each = var.api_wake_origin != null && var.api_wake_origin != "" ? [1] : []
    content {
      name = "API_WAKE_ORIGIN"
      text = var.api_wake_origin
    }
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

    // A top-level HTML navigation (not an asset, /api/* call, or control path).
    function isDocumentRequest(request, url) {
      if (request.method !== 'GET') return false;
      const accept = request.headers.get('Accept') || '';
      if (accept.indexOf('text/html') === -1) return false;
      const p = url.pathname;
      if (p === '/api' || p.indexOf('/api/') === 0) return false;
      if (p.indexOf('/__shogo/') === 0) return false;
      const last = p.split('/').pop() || '';
      const dot = last.lastIndexOf('.');
      if (dot > -1) {
        const ext = last.slice(dot + 1).toLowerCase();
        if (ext && ext !== 'html' && ext !== 'htm') return false;
      }
      return true;
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Ask the API to provision + wake this project's preview backend and report
    // readiness. Returns { ready, url }:
    //   - url set   -> project runs on the METAL substrate; `url` is the box's
    //                  PUBLIC runtime origin (http://host:PORT). Proxy straight
    //                  there (needs allow_custom_ports for the high port). Metal
    //                  projects have no Knative route, so this is the ONLY path.
    //   - url null  -> Knative project (or nothing resolved yet); use the region
    //                  anchor as before.
    // Degrades to { ready:false, url:null } (keep polling / transparent proxy)
    // when no API origin is configured or the call fails.
    async function previewWake(env, projectId, timeoutMs) {
      if (!env.API_WAKE_ORIGIN || !projectId) return { ready: false, url: null };
      const base = env.API_WAKE_ORIGIN.replace(/\/+$/, '');
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      try {
        const resp = await fetch(base + '/api/preview/' + projectId + '/wake', {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Cloudflare-Worker-Wake' },
        });
        if (!resp.ok) return { ready: false, url: null };
        const data = await resp.json();
        return { ready: !!(data && data.ready), url: (data && data.url) || null };
      } catch (e) {
        return { ready: false, url: null };
      } finally {
        clearTimeout(timer);
      }
    }

    // --- Metal direct-proxy helpers ------------------------------------------
    // A metal project's public runtime origin is dynamic (host + per-project
    // DNAT port) and can move across a resume/reassign, so we cache the resolved
    // url in KV with a short TTL keyed distinctly from the region map (which is
    // keyed by bare projectId). On a proxy failure we invalidate and re-resolve.
    function metalKey(projectId) { return 'murl:' + projectId; }

    async function getCachedMetalUrl(env, projectId) {
      if (!env.PREVIEW_REGIONS || !projectId) return null;
      try { return await env.PREVIEW_REGIONS.get(metalKey(projectId)); } catch (e) { return null; }
    }
    async function setCachedMetalUrl(env, projectId, u) {
      if (!env.PREVIEW_REGIONS || !projectId || !u) return;
      try { await env.PREVIEW_REGIONS.put(metalKey(projectId), u, { expirationTtl: 120 }); } catch (e) {}
    }
    async function clearCachedMetalUrl(env, projectId) {
      if (!env.PREVIEW_REGIONS || !projectId) return;
      try { await env.PREVIEW_REGIONS.delete(metalKey(projectId)); } catch (e) {}
    }

    // Proxy the request straight to a metal box origin, preserving path + query.
    // The metal box serves the built SPA at `/` (same as Kourier→ksvc did), so
    // no path rewrite is needed. Host header is dropped so fetch derives it from
    // the metal origin. Non-GET bodies are buffered (preview POSTs are small);
    // GET/HEAD carry no body so a failed attempt can be safely re-resolved.
    async function proxyToMetal(request, metalBase, url) {
      const target = metalBase.replace(/\/+$/, '') + url.pathname + url.search;
      const headers = new Headers(request.headers);
      headers.delete('host');
      const init = { method: request.method, headers: headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
      }
      return fetch(target, init);
    }

    // GET fast-path against a cached metal url. Returns the response, or null if
    // the cached url is stale/dead (connection error, or an infra 404/5xx that
    // the runtime itself did not stamp) — the caller then re-resolves via wake.
    async function proxyCachedMetalGet(request, env, projectId, metalBase, url) {
      let resp;
      try {
        resp = await proxyToMetal(request, metalBase, url);
      } catch (e) {
        await clearCachedMetalUrl(env, projectId);
        return null;
      }
      if (INFRA_ERROR_STATUSES[resp.status] && !isRuntimeResponse(resp)) {
        await clearCachedMetalUrl(env, projectId);
        return null;
      }
      return resp;
    }

    function wakeJsonResponse(ready) {
      return new Response(JSON.stringify({ ready: !!ready }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    function shogoLoadingResponse(label) {
      const safe = escapeHtml(label || 'your app');
      const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>Waking up</title><style>'
        + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea}'
        + '.card{width:100%;max-width:360px;padding:40px 32px;text-align:center;box-sizing:border-box}'
        + '.spin{width:38px;height:38px;margin:0 auto 22px;border:3px solid #2a2a33;border-top-color:#6d5cff;'
        + 'border-radius:50%;animation:s 0.9s linear infinite}'
        + '@keyframes s{to{transform:rotate(360deg)}}'
        + 'h1{font-size:17px;margin:0 0 8px;font-weight:600}'
        + 'p{font-size:13px;color:#9a9aa5;margin:0;line-height:1.5}'
        + '.host{margin-top:14px;font-size:11px;color:#6f6f7a;font-family:ui-monospace,monospace}'
        + '</style></head><body><div class="card">'
        + '<div class="spin"></div>'
        + '<h1>Waking things up</h1>'
        + '<p>This preview went to sleep after sitting idle. It is starting back up &mdash; this usually takes a few seconds.</p>'
        + '<div class="host">' + safe + '</div>'
        + '</div>'
        + '<script>(function(){function poll(){'
        + 'fetch("/__shogo/wake",{cache:"no-store"})'
        + '.then(function(r){return r.ok?r.json():{ready:false};})'
        + '.then(function(d){if(d&&d.ready){location.reload();return;}setTimeout(poll,2000);})'
        + '.catch(function(){setTimeout(poll,2500);});}'
        + 'setTimeout(poll,800);})();</script>'
        + '</body></html>';
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Infra-level error statuses. When one of these comes back WITHOUT the
    // runtime marker header (see isRuntimeResponse) it originated at the edge /
    // ingress (Kourier "no healthy upstream" 404, activator/pod 503) rather
    // than the user's app — so we never surface it raw.
    var INFRA_ERROR_STATUSES = { 404: true, 502: true, 503: true, 504: true };
    // Transient statuses worth one automatic retry (pod warming, endpoint not
    // yet propagated into Kourier). 404 is excluded — it doesn't self-heal on
    // an immediate retry and is handled by the interstitial for documents.
    var TRANSIENT_STATUSES = { 502: true, 503: true, 504: true };

    // A response the agent-runtime itself produced stamps this marker header
    // (packages/agent-runtime/src/server.ts). Its presence means the status —
    // even a 404 — is the app's own response and must pass through untouched
    // (never masked, never reload-looped). Its absence on an error status means
    // the failure came from the ingress/activator, which we can safely swap for
    // the loading interstitial.
    function isRuntimeResponse(resp) {
      return !!(resp && resp.headers && resp.headers.get('x-shogo-runtime'));
    }

    // Proxy to the regional Kourier anchor. Keeps the original preview host in
    // the URL so Cloudflare sends Host: {projectId}.preview.<base> (which the
    // regional Kourier DomainMapping routes to the project's ksvc) and ONLY
    // overrides DNS resolution to the anchor. resolveOverride requires both the
    // URL host and the anchor to be proxied in this zone; the anchor host does
    // not match this Worker's route, so the origin-pull subrequest does not
    // re-enter the Worker (no loop).
    function proxyToAnchor(request, anchor) {
      return fetch(request, { cf: { resolveOverride: anchor } });
    }

    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        const projectId = projectIdFromHost(url.hostname);
        const isDoc = isDocumentRequest(request, url);

        // Wake control endpoint, polled by the loading page below. Also refreshes
        // the metal-url cache so the reload lands on the fast path. Always
        // available (returns {ready:false} when no API origin is configured).
        if (url.pathname === '/__shogo/wake' || url.pathname === '/__shogo/ready') {
          const w = await previewWake(env, projectId, 8000);
          if (w.url) await setCachedMetalUrl(env, projectId, w.url);
          return wakeJsonResponse(w.ready);
        }

        // ---- Metal fast path -------------------------------------------------
        // If we've already resolved this project to a metal box, proxy GETs
        // straight there (its public DNAT origin). Only GETs use the cache: they
        // carry no body, so a stale-url miss can be safely re-resolved below.
        if (projectId && request.method === 'GET') {
          const cached = await getCachedMetalUrl(env, projectId);
          if (cached) {
            const resp = await proxyCachedMetalGet(request, env, projectId, cached, url);
            if (resp) return resp;
            // stale/dead cache -> fall through to re-resolve via wake
          }
        }

        // ---- Resolve the backend (metal url or Knative) via the API ----------
        // A metal project has no Knative route; the API resolves its public url
        // and we proxy directly. A Knative project returns {ready} with no url,
        // and we use the region anchor path below (unchanged behavior).
        if (env.API_WAKE_ORIGIN && projectId) {
          const w = await previewWake(env, projectId, 8000);
          if (w.url) {
            await setCachedMetalUrl(env, projectId, w.url);
            // Not up yet: for a top-level navigation show the loading page (it
            // keeps polling /__shogo/wake, which re-runs the wake + reload).
            if (!w.ready && isDoc) return shogoLoadingResponse(url.hostname);
            const resp = await proxyToMetal(request, w.url, url);
            if (isDoc && INFRA_ERROR_STATUSES[resp.status] && !isRuntimeResponse(resp)) {
              await clearCachedMetalUrl(env, projectId);
              return shogoLoadingResponse(url.hostname);
            }
            return resp;
          }
          // Knative project: gate document navigations on readiness so a cold /
          // never-opened preview shows the loading page instead of a raw 404.
          if (isDoc && !w.ready) return shogoLoadingResponse(url.hostname);
        }

        // ---- Knative region-anchor path (unchanged) --------------------------
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

        // Only GET requests are safe to retry or re-render. Anything with a
        // body (POST/PUT/PATCH/DELETE) proxies straight through — retrying or
        // swapping it for an interstitial could duplicate or drop a mutation.
        if (request.method !== 'GET') {
          return proxyToAnchor(request, anchor);
        }

        let resp = await proxyToAnchor(request, anchor);

        // Transient ingress/activator error (pod still warming, endpoint not
        // yet propagated into Kourier). Retry once after a short delay — the
        // absent marker confirms it isn't the app's own 5xx.
        if (TRANSIENT_STATUSES[resp.status] && !isRuntimeResponse(resp)) {
          await new Promise(function (r) { setTimeout(r, 600); });
          resp = await proxyToAnchor(request, anchor);
        }

        // Still an infra-level error the app did not produce: never surface the
        // raw 404/503. For a document navigation, serve the interstitial (it
        // provisions + wakes the pod and reloads once ready) — but only when a
        // wake origin is configured, otherwise the poll can't make progress and
        // we'd spin forever, so fall back to returning the response. Sub-resource
        // GETs have nothing to render, so they pass through unchanged.
        if (
          isDoc &&
          env.API_WAKE_ORIGIN &&
          INFRA_ERROR_STATUSES[resp.status] &&
          !isRuntimeResponse(resp)
        ) {
          return shogoLoadingResponse(url.hostname);
        }

        return resp;
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
