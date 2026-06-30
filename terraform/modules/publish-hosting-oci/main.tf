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

variable "publish_zone" {
  description = "Cloudflare zone name that hosts `publish_domain`. Defaults to `publish_domain`. Set explicitly when `publish_domain` is a subdomain of the actual CF zone (e.g. `publish_domain = staging.shogo.one`, `publish_zone = shogo.one`). The zone is then looked up by name via `data.cloudflare_zone.publish` and used as the zone_id on both the worker_route and the wildcard A record."
  type        = string
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (for Workers)"
  type        = string
}

variable "enable_custom_domains" {
  description = "Turn on Cloudflare for SaaS (bring-your-own custom hostnames). Defaults to false. When true, the module creates the KV map, fallback origin, fallback DNS record and a `*/*` worker route IN `custom_domains_zone` (NOT the publish zone). These are zone-level singletons, so exactly one environment may own a given zone — see `custom_domains_zone`."
  type        = bool
  default     = false
}

variable "custom_domains_zone" {
  description = "Cloudflare zone NAME that hosts bring-your-own custom hostnames (Cloudflare for SaaS). MUST be distinct from the shared publish zone when multiple environments share it: the SaaS fallback origin and the `*/*` worker route are per-zone singletons, so e.g. staging (`*.staging.shogo.one`) and production (`*.shogo.one`) — which share the `shogo.one` publish zone — each need their own dedicated custom-domains zone. Defaults to null, which falls back to the publish zone (only safe for the single env that solely owns that zone). Ignored unless `enable_custom_domains`."
  type        = string
  default     = null
}

variable "custom_domain_fallback_hostname" {
  description = "Cloudflare for SaaS fallback-origin hostname that bring-your-own custom domains CNAME at. Defaults to `cname.<custom_domains_zone>`. Must resolve within `custom_domains_zone`."
  type        = string
  default     = null
}

# Server-backed published apps are always on: the `SERVER_BACKED` Workers KV map
# and its worker binding are created unconditionally (an empty KV map is free),
# and the API auto-detects which apps need a backend at publish time. The only
# input is `kourier_origin` — the Knative ingress the Worker proxies `/api/*`
# to. When it's unset the Worker can't proxy (no origin), so server-backed apps
# fall back to static serving until the ingress host is configured.
variable "kourier_origin" {
  description = "Origin URL whose HOSTNAME the subdomain-router Worker uses as a `resolveOverride` target for server-backed `/api/*` traffic. The hostname must be an ORANGE-CLOUDED (proxied) record in the publish zone whose origin is the cluster's Knative (Kourier) ingress LB serving the `{subdomain}.shogo.one` DomainMappings. The Worker keeps the published host in the request URL (so Cloudflare sends `Host: {subdomain}.{publish_domain}`, which the DomainMapping routes to `published-{projectId}`) and only overrides DNS resolution to this host — Cloudflare ignores a manually-set Host header, and resolveOverride requires both hosts to be proxied in the same zone. The scheme is ignored (the Worker reuses the inbound request scheme). Leave null to disable server-backed proxying even when the KV map exists."
  type        = string
  default     = null
}

variable "site_auth_secret" {
  description = "HMAC signing secret used by the subdomain-router Worker to mint/verify the password-gate cookie (shogo_site_auth) for password-protected published sites. Bound to the Worker as SITE_AUTH_SECRET. Leave null/empty to disable the password gate even when the SITE_AUTH KV map has entries (the Worker guards on `env.SITE_AUTH_SECRET`). Use a long random value; rotating it invalidates all outstanding visitor sessions."
  type        = string
  default     = null
  sensitive   = true
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

# Look up the publish zone by name. The token used for tf needs `Zone:Read`
# on this zone in addition to `Workers Routes:Edit` and `Zone DNS:Edit`.
# Sourcing by name keeps callers from having to thread a second zone-id
# variable through every env.
#
# When `publish_domain` is itself a CF zone (e.g. `shogo.one`), the default
# null `publish_zone` falls through to `publish_domain`. When `publish_domain`
# is a subdomain (e.g. `staging.shogo.one`), set `publish_zone = "shogo.one"`
# so the lookup resolves and the wildcard A record + worker_route still land
# in the correct zone.
data "cloudflare_zone" "publish" {
  name = coalesce(var.publish_zone, var.publish_domain)
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
    # Create the replacement PAR before destroying the old one. A PAR can be
    # force-replaced for reasons outside a real config change (e.g. the
    # `namespace` data source resolving to "known after apply" on a stale
    # plan). The Worker's static origin (`local.par_base_url`) embeds this
    # PAR's `access_uri`, so a destroy-before-create replacement would leave
    # the live Worker pointing at a deleted PAR — 404ing static assets for
    # EVERY published app until the new PAR + Worker update propagate.
    # create_before_destroy keeps a valid PAR referenced at all times.
    create_before_destroy = true

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

  # Cloudflare for SaaS lives in its OWN zone, distinct from the publish zone.
  # The SaaS primitives below (fallback origin + the `*/*` worker route that
  # catches custom-hostname traffic) are zone-level SINGLETONS. The publish
  # zone (`shogo.one`) is shared — staging owns `*.staging.shogo.one` and
  # production owns `*.shogo.one` against the same zone — so putting a `*/*`
  # route or fallback origin there would collide across environments and one
  # env's Worker would intercept the other's traffic. Each env that enables
  # custom domains therefore points `custom_domains_zone` at a dedicated zone
  # (falling back to the publish zone only for an env that solely owns it).
  custom_domains_zone_name = var.enable_custom_domains ? coalesce(
    var.custom_domains_zone,
    var.publish_zone,
    var.publish_domain,
  ) : null

  # Fallback-origin hostname that bring-your-own custom domains CNAME at
  # (Cloudflare for SaaS). Defaults to `cname.<custom_domains_zone>`. The API
  # surfaces this to users as the CNAME target (CUSTOM_DOMAIN_FALLBACK_ORIGIN),
  # so keep them in sync.
  custom_domain_fallback_hostname = var.enable_custom_domains ? coalesce(
    var.custom_domain_fallback_hostname,
    "cname.${local.custom_domains_zone_name}",
  ) : null

  # Relative record name for the fallback origin within the custom-domains
  # zone. The default fallback hostname is `cname.<zone>`, so this resolves to
  # `cname`; trimsuffix keeps it correct if the hostname is overridden to a
  # deeper label under the same zone.
  fallback_record_name = var.enable_custom_domains ? trimsuffix(
    local.custom_domain_fallback_hostname,
    ".${local.custom_domains_zone_name}",
  ) : null
}

# The dedicated Cloudflare zone that hosts bring-your-own custom hostnames.
# See the locals note above for why this is kept separate from the publish
# zone. Only looked up when custom domains are enabled. The tf token needs
# `Zone:Read` + `SSL and Certificates:Edit` + `Workers Routes:Edit` here.
data "cloudflare_zone" "custom_domains" {
  count = var.enable_custom_domains ? 1 : 0
  name  = local.custom_domains_zone_name

  lifecycle {
    # Hard stop against the shared-zone footgun: enabling custom domains
    # without an explicit dedicated zone would fall back to the publish zone
    # (`shogo.one`) and put a `*/*` route + fallback origin on a zone shared
    # with other environments. Force the operator to name a dedicated zone.
    # NOTE: `coalesce` (see local.custom_domains_zone_name) skips empty strings
    # AND nulls, so an empty `custom_domains_zone` (e.g. an unset GH var passed
    # as "" by the Terraform CI workflow) would silently fall through to the
    # publish zone. Reject empty explicitly, and reject the resolved publish
    # zone (publish_zone, else publish_domain) — not just publish_domain — so a
    # subdomain env (staging owns `staging.shogo.one` on the shared `shogo.one`
    # zone) can't point custom domains at the shared zone either.
    precondition {
      condition = (
        var.custom_domains_zone != null &&
        trimspace(var.custom_domains_zone) != "" &&
        var.custom_domains_zone != var.publish_domain &&
        var.custom_domains_zone != coalesce(var.publish_zone, var.publish_domain)
      )
      error_message = "enable_custom_domains=true requires custom_domains_zone to be set to a DEDICATED Cloudflare zone: non-empty and distinct from BOTH publish_domain and the publish zone (publish_zone, else publish_domain). The SaaS fallback origin + `*/*` worker route are per-zone singletons and the publish zone is shared across environments. See docs/custom-domains.md."
    }
  }
}

# -----------------------------------------------------------------------------
# Workers KV — custom-domain routing map
# -----------------------------------------------------------------------------
# Maps a bring-your-own hostname (e.g. `app.acme.com`) to the published
# subdomain prefix it should serve from Object Storage. Written by the API
# (apps/api/src/lib/cloudflare-custom-hostnames.ts) once a custom hostname's
# cert goes active, read by the subdomain-router Worker below. The namespace
# id is exported so the api ksvc env can be wired to it.
resource "cloudflare_workers_kv_namespace" "custom_domains" {
  count      = var.enable_custom_domains ? 1 : 0
  account_id = var.cloudflare_account_id
  title      = "shogo-custom-domains-${var.environment}"
}

# -----------------------------------------------------------------------------
# Workers KV — server-backed publish map
# -----------------------------------------------------------------------------
# Maps a published subdomain (e.g. `august-29th-celebration-portal`) to a flag
# marking it as SERVER-BACKED. Written by the API (apps/api/src/routes/
# publish.ts) when it publishes an app whose backend (server.tsx) must run in
# production, deleted on unpublish / static republish. Read by the
# subdomain-router Worker below to decide whether to proxy `/api/*` to the
# Knative ingress (`kourier_origin`) instead of serving it from Object Storage.
resource "cloudflare_workers_kv_namespace" "server_backed" {
  account_id = var.cloudflare_account_id
  title      = "shogo-server-backed-${var.environment}"
}

# -----------------------------------------------------------------------------
# Workers KV — published-site password gate (SITE_AUTH)
# -----------------------------------------------------------------------------
# Maps a published subdomain to the SHA-256 hash (hex) of
# `${subdomain}:${password}`. Written by the API (apps/api/src/lib/
# cloudflare-site-auth-kv.ts) when a project is published/updated with
# accessLevel == `password`, deleted when the access level changes away from
# `password` or on unpublish. Read by the subdomain-router Worker below to
# gate every request for that subdomain behind a shared-password prompt (the
# raw password is never stored). The namespace id is exported so the api ksvc
# env can be wired to it (CF_SITE_AUTH_KV_NAMESPACE_ID).
resource "cloudflare_workers_kv_namespace" "site_auth" {
  account_id = var.cloudflare_account_id
  title      = "shogo-site-auth-${var.environment}"
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
  module = true

  # Bind the custom-domain KV map so the Worker can resolve a bring-your-own
  # hostname to its published subdomain prefix. Only present when custom
  # domains are enabled; the Worker guards on `env.CUSTOM_DOMAINS` so the
  # script content is identical whether or not the binding exists.
  dynamic "kv_namespace_binding" {
    for_each = var.enable_custom_domains ? [1] : []
    content {
      name         = "CUSTOM_DOMAINS"
      namespace_id = cloudflare_workers_kv_namespace.custom_domains[0].id
    }
  }

  # Bind the server-backed publish map so the Worker can tell which subdomains
  # run a backend. Always bound; the Worker still guards on the per-subdomain
  # flag + `env.KOURIER_ORIGIN`, so an empty map / unset origin is a no-op.
  kv_namespace_binding {
    name         = "SERVER_BACKED"
    namespace_id = cloudflare_workers_kv_namespace.server_backed.id
  }

  # Bind the password-gate map so the Worker can tell which subdomains require a
  # shared-password prompt. Always bound; the Worker still guards on the
  # per-subdomain hash + `env.SITE_AUTH_SECRET`, so an empty map / unset secret
  # is a no-op (sites serve publicly).
  kv_namespace_binding {
    name         = "SITE_AUTH"
    namespace_id = cloudflare_workers_kv_namespace.site_auth.id
  }

  # HMAC secret for signing/verifying the password-gate cookie. Only bound when
  # configured; the Worker guards on `env.SITE_AUTH_SECRET` presence so the
  # gate is disabled (fails open to public) when unset.
  dynamic "secret_text_binding" {
    for_each = var.site_auth_secret != null && var.site_auth_secret != "" ? [1] : []
    content {
      name = "SITE_AUTH_SECRET"
      text = var.site_auth_secret
    }
  }

  # The Knative ingress origin for server-backed `/api/*`. Only bound when
  # configured; the Worker guards on `env.KOURIER_ORIGIN` presence.
  dynamic "plain_text_binding" {
    for_each = var.kourier_origin != null && var.kourier_origin != "" ? [1] : []
    content {
      name = "KOURIER_ORIGIN"
      text = var.kourier_origin
    }
  }
  # The OCI PAR `access_uri` returned by the provider ends in `/o/`
  # (verified via OCI CLI on the live PAR; matches OCI docs). The
  # original implementation built `originUrl = par_base_url + path`
  # where `path` was `/${subdomain}/index.html`, producing
  # `…/o//credits-usage-dashboard/index.html` — a literal double
  # slash. OCI then parses the object name as everything after `/o/`,
  # i.e. `/credits-usage-dashboard/index.html` (with leading slash),
  # which does not match the actual stored key
  # `credits-usage-dashboard/index.html`. Result: 100% of requests
  # 404'd and the SPA fallback (also broken the same way) returned
  # the OCI ObjectNotFound JSON wrapped in HTTP 200, masking the
  # failure as a "successful but bogus" response. Fix here:
  #   1. Trim trailing slashes from the PAR base before concatenating.
  #   2. Always normalise the request path to start with exactly one `/`.
  #   3. If the SPA fallback itself 404s, return the upstream status
  #      instead of pretending it was 200, so debugging surfaces the
  #      real problem next time.
  content = <<-JS
    const ORIGIN_BASE = '${local.par_base_url}'.replace(/\/+$/, '');

    function buildOriginUrl(subdomain, requestPath) {
      // Ensure path starts with exactly one '/' (no leading-slash
      // duplication, no missing slash if the URL is malformed).
      const cleanPath =
        requestPath === '' || requestPath === '/'
          ? '/' + subdomain + '/index.html'
          : '/' + subdomain + (requestPath.startsWith('/') ? '' : '/') + requestPath;
      return ORIGIN_BASE + cleanPath;
    }

    const PUBLISH_DOMAIN = '${var.publish_domain}';

    // Apps published under the platform domain serve from their first DNS
    // label (`myapp.shogo.one` -> `myapp`). Returns null for anything else
    // (a bring-your-own custom domain), which we then resolve via KV.
    function platformSubdomain(hostname) {
      if (hostname === PUBLISH_DOMAIN || hostname.endsWith('.' + PUBLISH_DOMAIN)) {
        return hostname.split('.')[0];
      }
      return null;
    }

    // A custom-domain KV entry. New writes are JSON
    // { "s": "<publishedSubdomain>", "c": "<canonicalHostname>" }; `c` is the
    // primary hostname of an apex/www pair (a visitor on the non-canonical
    // host is 308-redirected to it). Legacy entries are a bare subdomain
    // string with no canonical (no redirect) — kept for backward compat.
    function parseCustomDomain(raw) {
      if (!raw) return null;
      if (raw.charAt(0) === '{') {
        try {
          const o = JSON.parse(raw);
          if (o && o.s) return { subdomain: o.s, canonical: o.c || null };
        } catch (e) {}
        return null;
      }
      return { subdomain: raw, canonical: null };
    }

    // Path prefixes that must hit the project's live backend (server.tsx)
    // for SERVER-BACKED published apps, rather than Object Storage. Anything
    // not matched here keeps serving as a static asset (with SPA fallback).
    const DYNAMIC_PREFIXES = ['/api/'];
    function isDynamicPath(p) {
      return DYNAMIC_PREFIXES.some(function (pre) {
        return p === pre.slice(0, -1) || p.indexOf(pre) === 0;
      });
    }

    // -----------------------------------------------------------------------
    // Password gate (accessLevel == 'password').
    //
    // A subdomain with an entry in the SITE_AUTH KV namespace is served only
    // after the visitor proves knowledge of a shared password. The KV value is
    // sha256hex(subdomain + ':' + password) (matches apps/api/src/lib/
    // cloudflare-site-auth-kv.ts). On success we set an HttpOnly cookie whose
    // value is <expMs>.<hmacHex(SITE_AUTH_SECRET, subdomain + '|' + expMs)>, so
    // the edge can re-validate without another KV/DB round trip. This is a soft
    // shared-secret gate, not per-user authentication. NOTE: this HEREDOC is
    // processed by Terraform, so the JS deliberately avoids JS template-literal
    // interpolation and uses string concatenation throughout.
    // -----------------------------------------------------------------------
    const SITE_AUTH_COOKIE = 'shogo_site_auth';
    const SITE_AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const SITE_AUTH_ACTION = '/__shogo_auth';
    const SITE_AUTH_ENCODER = new TextEncoder();

    function siteAuthToHex(buf) {
      const bytes = new Uint8Array(buf);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    }

    async function siteAuthSha256Hex(str) {
      const digest = await crypto.subtle.digest('SHA-256', SITE_AUTH_ENCODER.encode(str));
      return siteAuthToHex(digest);
    }

    async function siteAuthHmacHex(secret, message) {
      const key = await crypto.subtle.importKey(
        'raw', SITE_AUTH_ENCODER.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, SITE_AUTH_ENCODER.encode(message));
      return siteAuthToHex(sig);
    }

    // Length-checked, branch-light string compare (avoids early-exit timing
    // leaks on the hash/HMAC comparison).
    function siteAuthSafeEqual(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      if (a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    }

    function siteAuthGetCookie(request, name) {
      const header = request.headers.get('Cookie') || '';
      const parts = header.split(';');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim();
        const eq = p.indexOf('=');
        if (eq > -1 && p.slice(0, eq) === name) return p.slice(eq + 1);
      }
      return null;
    }

    async function siteAuthVerifyCookie(secret, subdomain, value) {
      if (!value) return false;
      const dot = value.indexOf('.');
      if (dot < 0) return false;
      const expMs = value.slice(0, dot);
      const sig = value.slice(dot + 1);
      const expNum = parseInt(expMs, 10);
      if (!expNum || expNum < Date.now()) return false;
      const expected = await siteAuthHmacHex(secret, subdomain + '|' + expMs);
      return siteAuthSafeEqual(sig, expected);
    }

    function siteAuthEscapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Only allow same-origin absolute paths as the post-unlock redirect target
    // (blocks open-redirects via `//evil.com` or absolute URLs).
    function siteAuthSafeNext(raw) {
      if (!raw || raw.charAt(0) !== '/' || raw.charAt(1) === '/') return '/';
      return raw;
    }

    function siteAuthLoginHtml(error, next) {
      const msg = error ? '<p class="err">' + siteAuthEscapeHtml(error) + '</p>' : '';
      return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>Password required</title><style>'
        + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea}'
        + '.card{width:100%;max-width:340px;padding:32px;background:#16161c;border:1px solid #26262e;border-radius:14px;box-sizing:border-box}'
        + 'h1{font-size:18px;margin:0 0 6px}p{font-size:13px;color:#9a9aa5;margin:0 0 18px}'
        + 'p.err{color:#ff6b6b;margin:0 0 12px}'
        + 'input{width:100%;padding:11px 12px;font-size:14px;border-radius:9px;border:1px solid #33333d;'
        + 'background:#0e0e13;color:#fff;box-sizing:border-box;margin-bottom:12px}'
        + 'button{width:100%;padding:11px;font-size:14px;font-weight:600;border:0;border-radius:9px;'
        + 'background:#6d5cff;color:#fff;cursor:pointer}button:hover{background:#5b4bf0}'
        + '</style></head><body><form class="card" method="POST" action="' + SITE_AUTH_ACTION + '">'
        + '<h1>This site is password protected</h1>'
        + '<p>Enter the password to continue.</p>'
        + msg
        + '<input type="password" name="password" placeholder="Password" autofocus required>'
        + '<input type="hidden" name="next" value="' + siteAuthEscapeHtml(next) + '">'
        + '<button type="submit">Unlock</button>'
        + '</form></body></html>';
    }

    function siteAuthLoginResponse(error, next) {
      return new Response(siteAuthLoginHtml(error, next), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Returns a Response when the request should be intercepted (login page,
    // failed/successful auth submission), or null when the visitor is already
    // authenticated and the request should proceed to normal serving.
    async function siteAuthGate(request, env, url, subdomain) {
      if (!env.SITE_AUTH || !env.SITE_AUTH_SECRET) return null;
      const pwHash = await env.SITE_AUTH.get(subdomain);
      if (!pwHash) return null;
      const secret = env.SITE_AUTH_SECRET;

      if (request.method === 'POST' && url.pathname === SITE_AUTH_ACTION) {
        let form = null;
        try { form = await request.formData(); } catch (e) { form = null; }
        const submitted = form ? (form.get('password') || '') : '';
        const next = siteAuthSafeNext(form ? (form.get('next') || '/') : '/');
        const ok = submitted
          ? siteAuthSafeEqual(await siteAuthSha256Hex(subdomain + ':' + submitted), pwHash)
          : false;
        if (!ok) return siteAuthLoginResponse('Incorrect password. Try again.', next);
        const expMs = Date.now() + SITE_AUTH_TTL_MS;
        const cookieVal = expMs + '.' + (await siteAuthHmacHex(secret, subdomain + '|' + expMs));
        const headers = new Headers();
        headers.set('Location', next);
        headers.set('Cache-Control', 'no-store');
        headers.append(
          'Set-Cookie',
          SITE_AUTH_COOKIE + '=' + cookieVal + '; Path=/; Max-Age='
            + Math.floor(SITE_AUTH_TTL_MS / 1000) + '; HttpOnly; Secure; SameSite=Lax'
        );
        return new Response(null, { status: 303, headers: headers });
      }

      const cookie = siteAuthGetCookie(request, SITE_AUTH_COOKIE);
      if (await siteAuthVerifyCookie(secret, subdomain, cookie)) return null;
      return siteAuthLoginResponse('', siteAuthSafeNext(url.pathname + url.search));
    }

    // -----------------------------------------------------------------------
    // Wake-on-visit (server-backed apps).
    //
    // Server-backed published apps scale to zero when idle. The static shell
    // loads from Object Storage even while the pod is asleep, so its first
    // client-side /api/* call hits a cold backend whose cold start can exceed
    // the edge timeout — the visitor just sees an error. For server-backed
    // subdomains we instead detect a cold backend on the document request and
    // serve a small loading page that polls /__shogo/wake until the pod answers
    // /ready, then reloads. The probe itself routes through the Knative
    // activator, which scales the pod up from zero. Static apps never sleep
    // (served from the edge) so this path is skipped for them.
    // -----------------------------------------------------------------------
    const WAKE_PATHS = ['/__shogo/wake', '/__shogo/ready'];

    async function isServerBacked(env, subdomain) {
      if (!env.SERVER_BACKED) return false;
      try { return !!(await env.SERVER_BACKED.get(subdomain)); } catch (e) { return false; }
    }

    // Probe published-{id}/ready via the Kourier ingress (same routing as the
    // /api/* proxy: keep the published host in the URL so the DomainMapping
    // resolves to published-{id}, only override DNS to Kourier). Same-zone
    // subrequests skip this Worker, so there is no self-loop. Returns true when
    // the pod answers /ready 2xx; a short timeout keeps the loading page polling
    // rather than holding one request open across a long cold start.
    async function probePublishedReady(env, subdomain, url, timeoutMs) {
      const KOURIER_ORIGIN = (env.KOURIER_ORIGIN || '').replace(/\/+$/, '');
      if (!KOURIER_ORIGIN) return false;
      const kourierHost = KOURIER_ORIGIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const publishedHost = subdomain + '.' + PUBLISH_DOMAIN;
      const probeUrl = url.protocol + '//' + publishedHost + '/ready';
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      try {
        const resp = await fetch(probeUrl, {
          cf: { resolveOverride: kourierHost },
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Cloudflare-Worker-Wake' },
        });
        return resp.ok;
      } catch (e) {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }

    function wakeJsonResponse(ready) {
      return new Response(JSON.stringify({ ready: !!ready }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
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

    function shogoLoadingHtml(label) {
      const safe = siteAuthEscapeHtml(label || 'your app');
      return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
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
        + '<p>This app went to sleep after sitting idle. It is starting back up &mdash; this usually takes a few seconds.</p>'
        + '<div class="host">' + safe + '</div>'
        + '</div>'
        + '<script>(function(){function poll(){'
        + 'fetch("/__shogo/wake",{cache:"no-store"})'
        + '.then(function(r){return r.ok?r.json():{ready:false};})'
        + '.then(function(d){if(d&&d.ready){location.reload();return;}setTimeout(poll,2000);})'
        + '.catch(function(){setTimeout(poll,2500);});}'
        + 'setTimeout(poll,800);})();</script>'
        + '</body></html>';
    }

    function shogoLoadingResponse(label) {
      return new Response(shogoLoadingHtml(label), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        // Strip an optional leading `www.` so `www.<app>.shogo.one`
        // serves the same app as `<app>.shogo.one`. NOTE: this only
        // fixes *routing* — the edge still needs a TLS cert that covers
        // the `www.<app>` hostname. Universal SSL's `*.shogo.one`
        // wildcard is one label deep, so `www.<app>.shogo.one` requires
        // a separately-provisioned cert (advanced cert at
        // `*.<app>.shogo.one`, or Total TLS over a proxied `www.<app>`
        // DNS record). Without that cert the TLS handshake fails before
        // this Worker ever runs.
        const rawHost = url.hostname;
        const hostname = rawHost.replace(/^www\./, '');

        // Platform subdomain first; otherwise treat the host as a custom
        // domain and look up its published prefix in the KV map the API
        // writes when the hostname's cert goes active. Custom domains are
        // registered verbatim (a user may add `www.acme.com`), so try the
        // exact host first, then the www-stripped form. Unknown hosts 404
        // rather than guessing a (wrong) prefix from the first label.
        let subdomain = platformSubdomain(hostname);
        let canonical = null;
        if (!subdomain && env.CUSTOM_DOMAINS) {
          let entry = parseCustomDomain(await env.CUSTOM_DOMAINS.get(rawHost));
          if (!entry && rawHost !== hostname) {
            entry = parseCustomDomain(await env.CUSTOM_DOMAINS.get(hostname));
          }
          if (entry) {
            subdomain = entry.subdomain;
            canonical = entry.canonical;
          }
        }
        if (!subdomain) {
          return new Response('Not found: no published app for ' + rawHost, { status: 404 });
        }

        // Canonical (apex<->www) redirect: if this custom domain belongs to a
        // pair and the visitor is on the non-primary host, 308 them to the
        // primary, preserving path + query. Same content, one canonical URL
        // (keeps SEO/auth origins consistent — see custom-domains docs).
        if (canonical && rawHost !== canonical) {
          return Response.redirect(
            'https://' + canonical + url.pathname + url.search,
            308,
          );
        }

        // Password gate: when this subdomain is password-protected, require a
        // valid signed cookie before serving ANY path (static OR server-backed
        // /api/*). Runs before the SERVER_BACKED proxy so the backend is gated
        // too. No-op (returns null) for public sites or when the gate is
        // unconfigured (fails open to public).
        const gated = await siteAuthGate(request, env, url, subdomain);
        if (gated) return gated;

        // Wake control endpoint, polled by the loading page below. For
        // server-backed apps this probes published-{id}/ready (waking the pod
        // via the activator) and reports readiness; static apps are always
        // "ready" (served from the edge).
        if (WAKE_PATHS.indexOf(url.pathname) !== -1) {
          if (!(await isServerBacked(env, subdomain))) return wakeJsonResponse(true);
          return wakeJsonResponse(await probePublishedReady(env, subdomain, url, 5000));
        }

        // SERVER-BACKED apps: proxy dynamic `/api/*` to the project's running
        // server.tsx via the Knative ingress instead of Object Storage. The
        // backend is reached at KOURIER_ORIGIN (a DNS-only host that lands on
        // Kourier); we rewrite the Host header to the published hostname so the
        // `{subdomain}.PUBLISH_DOMAIN` DomainMapping routes to published-{id}.
        // Static assets keep serving from OCI below (CDN-fast, scale-to-zero
        // safe). Falls through to static when the app isn't server-backed, the
        // origin is unconfigured, or the path isn't dynamic.
        const KOURIER_ORIGIN = (env.KOURIER_ORIGIN || '').replace(/\/+$/, '');
        if (KOURIER_ORIGIN && env.SERVER_BACKED && isDynamicPath(url.pathname)) {
          const flag = await env.SERVER_BACKED.get(subdomain);
          if (flag) {
            const publishedHost = subdomain + '.' + PUBLISH_DOMAIN;
            // Kourier routes by Host to the `{subdomain}.PUBLISH_DOMAIN`
            // DomainMapping (→ published-{projectId}). Cloudflare derives the
            // upstream Host from the subrequest URL and IGNORES a manually-set
            // Host header, so we keep the published host IN THE URL (correct
            // Host) and use `resolveOverride` to send the connection to the
            // Kourier ingress host instead of the published host's own (dummy
            // wildcard) origin. resolveOverride requires both the URL host and
            // the override host to be orange-clouded in this zone; same-zone
            // subrequests skip the Worker, so there is no self-loop.
            const kourierHost = KOURIER_ORIGIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            const backendUrl = url.protocol + '//' + publishedHost + url.pathname + url.search;
            const backendReq = new Request(backendUrl, request);
            backendReq.headers.set('X-Forwarded-Host', publishedHost);
            backendReq.headers.set('X-Forwarded-Proto', 'https');
            return fetch(backendReq, { cf: { resolveOverride: kourierHost } });
          }
        }

        // Server-backed app + top-level navigation: if the backend is asleep,
        // serve a loading page that wakes it instead of the static shell (whose
        // /api/* calls would fail against a scaled-to-zero pod). The probe nudges
        // the activator so the pod is already cold-starting while the visitor
        // waits. Skipped for static apps (no backend to wake).
        if (isDocumentRequest(request, url) && (await isServerBacked(env, subdomain))) {
          const ready = await probePublishedReady(env, subdomain, url, 3000);
          if (!ready) return shogoLoadingResponse(subdomain + '.' + PUBLISH_DOMAIN);
        }

        const originUrl = buildOriginUrl(subdomain, url.pathname);
        const response = await fetch(originUrl, {
          headers: { 'User-Agent': 'Cloudflare-Worker' },
        });

        if (response.status === 404 || response.status === 403) {
          // SPA client-side routing fallback.
          const fallbackUrl = buildOriginUrl(subdomain, '/');
          const fallback = await fetch(fallbackUrl);
          // Surface fallback failures honestly (don't pretend 200
          // when the index.html itself is missing — that's how the
          // 2026-05-26 publish bug stayed undiagnosed for hours).
          if (!fallback.ok) {
            return new Response(fallback.body, {
              status: fallback.status,
              headers: fallback.headers,
            });
          }
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

# -----------------------------------------------------------------------------
# Cloudflare for SaaS — bring-your-own custom domains (DEDICATED zone)
# -----------------------------------------------------------------------------
# Everything below lives in `custom_domains_zone`, NOT the publish zone, and is
# created only when `enable_custom_domains` is set. Customer domains (e.g.
# app.acme.com) CNAME at the fallback origin. Like the publish wildcard it
# points at a documentation IP because the Worker intercepts before any origin
# fetch.
resource "cloudflare_record" "custom_domain_fallback" {
  count           = var.enable_custom_domains ? 1 : 0
  zone_id         = data.cloudflare_zone.custom_domains[0].id
  name            = local.fallback_record_name
  content         = "192.0.2.1"
  type            = "A"
  proxied         = true
  allow_overwrite = true
}

# Designate the record above as the Cloudflare for SaaS fallback origin: all
# custom-hostname traffic enters the custom-domains zone and is routed per this
# origin. Each customer hostname is registered as a custom_hostname by the API
# (cloudflare-custom-hostnames.ts), which also issues + auto-renews its cert.
resource "cloudflare_custom_hostname_fallback_origin" "publish" {
  count   = var.enable_custom_domains ? 1 : 0
  zone_id = data.cloudflare_zone.custom_domains[0].id
  origin  = local.custom_domain_fallback_hostname

  depends_on = [cloudflare_record.custom_domain_fallback]
}

# Run the subdomain-router Worker for ALL traffic in the DEDICATED custom-domains
# zone. A `*/*` pattern is REQUIRED for Cloudflare for SaaS: per Cloudflare's
# routing matrix only `*/*` matches custom hostnames regardless of the
# customer's orange/grey cloud setting (a narrow fallback-origin route only
# matches orange-cloud). This is safe precisely because the zone is dedicated
# to custom hostnames — it does not overlap the publish zone's
# `*.${var.publish_domain}/*` route (a different zone), so platform subdomains
# and other environments sharing the publish zone are untouched. The Worker
# sees the original custom hostname and resolves it via the CUSTOM_DOMAINS KV
# map. See docs/custom-domains.md.
#
# NOTE: because the Worker intercepts every path, custom-hostname certs use
# TXT (DNS) DV validation (CF_CUSTOM_HOSTNAME_SSL_METHOD defaults to `txt`) so
# issuance does not depend on an HTTP `.well-known` challenge the Worker would
# otherwise swallow.
resource "cloudflare_worker_route" "custom_domains" {
  count       = var.enable_custom_domains ? 1 : 0
  zone_id     = data.cloudflare_zone.custom_domains[0].id
  pattern     = "*/*"
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
locals {
  # Compute the relative record name so that the FQDN ends up as
  # `*.${publish_domain}` regardless of zone depth.
  #   publish_domain == zone        -> "*"           (FQDN = *.shogo.one)
  #   publish_domain  = sub.zone    -> "*.sub"       (FQDN = *.sub.shogo.one)
  #   publish_domain  = a.b.zone    -> "*.a.b"       (FQDN = *.a.b.shogo.one)
  # Cloudflare appends the zone for non-FQDN-looking names, so this
  # is the canonical form.
  wildcard_record_name = (
    var.publish_domain == data.cloudflare_zone.publish.name
    ? "*"
    : "*.${trimsuffix(var.publish_domain, ".${data.cloudflare_zone.publish.name}")}"
  )
}

resource "cloudflare_record" "wildcard" {
  zone_id = data.cloudflare_zone.publish.id
  name    = local.wildcard_record_name
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

output "custom_domains_enabled" {
  description = "Whether Cloudflare for SaaS custom domains are provisioned for this environment."
  value       = var.enable_custom_domains
}

output "custom_domains_zone_id" {
  description = "Zone id of the dedicated custom-domains zone (null when disabled). Wire into the api ksvc as CF_CUSTOM_DOMAIN_ZONE_ID."
  value       = var.enable_custom_domains ? data.cloudflare_zone.custom_domains[0].id : null
}

output "custom_domains_kv_namespace_id" {
  description = "Workers KV namespace id for the custom-domain routing map (null when disabled). Wire this into the api ksvc as CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID."
  value       = var.enable_custom_domains ? cloudflare_workers_kv_namespace.custom_domains[0].id : null
}

output "custom_domain_fallback_origin" {
  description = "Fallback-origin hostname that customers CNAME their domains at (null when disabled). Wire into the api ksvc as CUSTOM_DOMAIN_FALLBACK_ORIGIN."
  value       = local.custom_domain_fallback_hostname
}

output "server_backed_kv_namespace_id" {
  description = "Workers KV namespace id for the server-backed publish map. Wire into the api ksvc as CF_SERVER_BACKED_KV_NAMESPACE_ID so publish.ts can flag/unflag server-backed subdomains."
  value       = cloudflare_workers_kv_namespace.server_backed.id
}

output "site_auth_kv_namespace_id" {
  description = "Workers KV namespace id for the published-site password gate. Wire into the api ksvc as CF_SITE_AUTH_KV_NAMESPACE_ID so publish.ts can set/clear the per-subdomain password hash."
  value       = cloudflare_workers_kv_namespace.site_auth.id
}
