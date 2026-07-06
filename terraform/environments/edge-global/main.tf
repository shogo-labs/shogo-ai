# =============================================================================
# Shogo — Edge Global (Cloudflare-only)
# =============================================================================
# Cloudflare edge resources that don't belong to any single OCI region and
# don't share state with the regional LB topology in production-global.
# Currently:
#
#   install.shogo.ai     -> serves packages/shogo-worker/install.{sh,ps1}
#   releases.shogo.ai    -> resolves /cli/<channel>/shogo-<target>.<ext>(.sha256)?
#                           to the matching v* GitHub Release asset
#
# Kept separate from production-global so the install/releases Workers
# can be applied via the standard terraform.yml CI flow (S3 backend)
# without needing to first migrate production-global's existing local
# state (which already owns studio.shogo.ai / docs.shogo.ai / the tunnel
# A records) into OCI Object Storage.
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  # Remote state on OCI Object Storage (S3-compat), same bucket as the
  # OCI envs. Endpoint is supplied via -backend-config at init time:
  #   terraform init -backend-config="endpoint=$OCI_S3_ENDPOINT"
  # Credentials come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY
  # (GH secrets OCI_S3_ACCESS_KEY / OCI_S3_SECRET_KEY).
  backend "s3" {
    bucket = "shogo-tfstate"
    key    = "edge-global/terraform.tfstate"
    region = "us-ashburn-1"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    force_path_style            = true
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

module "install_shogo_ai" {
  source = "../../modules/install-shogo-ai"

  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  domain                = "shogo.ai"
  github_token          = var.github_token
  environment           = "production"
}

# =============================================================================
# Preview Router — per-project preview routing without per-preview DNS records
# =============================================================================
# Replaces the per-preview `preview--{id}.shogo.ai` A records (which hit the
# zone's 200-record quota, CF error 81045) with a Worker + KV that
# resolveOverrides each preview (`{projectId}.preview.shogo.ai`) to its hosting
# region's Kourier LB. Lives here (not production-global) so it can be applied
# via the standard terraform.yml CI flow on the S3 backend. See
# modules/preview-router and docs/preview-router.md.
module "preview_router" {
  source = "../../modules/preview-router"

  environment           = "production"
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  zone_name             = "shogo.ai"
  preview_base_domain   = "preview.shogo.ai"

  # Region code (the value the API writes to KV from REGION_ID) -> Kourier LB IP.
  region_anchors = {
    us = var.us_lb_ip
    eu = var.eu_lb_ip
    in = var.india_lb_ip
  }
  default_region = "us"

  # Wake-on-visit: a preview's Knative DomainMapping + pod are created lazily by
  # the API (getProjectPodUrl), so a preview that was never opened in Studio — or
  # one that has since scaled to zero — has nothing for Kourier to route to.
  # Pointing the Worker at the production API makes it serve a loading
  # interstitial on first navigation that polls `GET /api/preview/{projectId}/wake`
  # and reloads once the pod is ready, instead of erroring.
  api_wake_origin = "https://studio.shogo.ai"
}

# =============================================================================
# Worker M2M API — bot-mitigation exception (issue #783)
# =============================================================================
# `shogo worker start` runs headless on cloud/datacenter hosts (Oracle Cloud,
# AWS, GCP, …). Those source ASNs are categorized as "Hosting" by Cloudflare's
# bot heuristics, and the worker's requests are non-browser (Node/Bun `fetch`,
# no cookies/JS), so Browser Integrity Check, Security Level (IP reputation)
# challenges, and Super Bot Fight Mode can challenge/deny them at the edge —
# even with a valid device key. Our docs explicitly position manual API keys
# for "CI, scripting, or headless environments", so this traffic must be
# supported from any IP, not just residential ones.
#
# Cloudflare's canonical fix for legitimate machine-to-machine clients is a
# WAF custom rule with the `skip` action in the http_request_firewall_custom
# phase (which runs BEFORE Super Bot Fight Mode / the http_request_sbfm phase).
# See https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/
# and https://developers.cloudflare.com/waf/custom-rules/skip/.
#
# Scope is by auth TYPE, not auth presence: this covers the machine-to-machine
# / API-key (`shogo_sk_*`) surface — the endpoints the codebase itself treats
# as key-authenticated and session-exempt (see the `publicPrefixes` list in
# apps/api/src/server.ts and `PUBLIC_PREFIXES` in middleware/auth.ts). These
# carry programmatic traffic authenticated by an `x-api-key` / `Authorization:
# Bearer shogo_sk_*` key at the origin (apps/api resolveApiKey) and rate-limited
# there, so bot/IP challenges add false positives with no security benefit:
#   - /api/instances/*            worker heartbeat + tunnel WebSocket
#   - /api/api-keys/validate      key validation (shogo login --api-key)
#   - /api/api-keys/heartbeat     key heartbeat
#   - /api/cli/login/*            device-code login
#   - /api/ai/*                   AI proxy (agent-runtime, CI)
#   - /v1/*, /api/v1/*            public OpenAI-compatible API (docs: CI/scripting)
#   - /api/tools/*                key-authenticated tool passthrough
# plus the dedicated `api.shogo.ai` M2M host.
#
# Deliberately EXCLUDED so they keep full bot protection (highest-value bot
# targets — credential stuffing, signup/billing fraud): /api/auth/*,
# /api/billing/*, /api/admin/*, /api/me, /api/onboarding/*. Dual-mode paths
# that accept BOTH a session cookie and an API key (/api/chat/*, /api/voice/*,
# /api/projects/*) are also excluded here; if programmatic clients get blocked
# there, gate a skip on the presence of a `shogo_sk_*` key header rather than
# opening the path for browser traffic too. We also do NOT skip Cloudflare
# rate-limiting (http_ratelimit) so edge abuse protection stays intact, and the
# browser-facing studio UI is untouched.
#
# This is IP/ASN-agnostic — it fixes every headless client, not a single IP —
# and matches on path (all CLI versions), while newer workers also send a
# `User-Agent: shogo-cli/<version>` for observability (packages/shogo-worker).
resource "cloudflare_ruleset" "worker_m2m_bot_skip" {
  zone_id     = var.cloudflare_zone_id
  name        = "Worker M2M API bot-mitigation exception"
  description = "Skip bot/IP challenges for authenticated shogo M2M / API-key endpoints (issue #783)"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    ref         = "skip_bot_mitigation_m2m_api"
    description = "Skip SBFM + managed WAF + BIC/UA/security-level challenges for shogo_sk_-authenticated API paths"
    expression  = "(http.host in {\"studio.shogo.ai\" \"api.shogo.ai\" \"tunnel.shogo.ai\" \"eu.tunnel.shogo.ai\" \"india.tunnel.shogo.ai\"}) and (starts_with(http.request.uri.path, \"/api/instances/\") or http.request.uri.path eq \"/api/api-keys/validate\" or http.request.uri.path eq \"/api/api-keys/heartbeat\" or starts_with(http.request.uri.path, \"/api/cli/login/\") or starts_with(http.request.uri.path, \"/api/ai/\") or starts_with(http.request.uri.path, \"/api/v1/\") or starts_with(http.request.uri.path, \"/v1/\") or starts_with(http.request.uri.path, \"/api/tools/\"))"
    action      = "skip"
    enabled     = true

    action_parameters {
      phases   = ["http_request_sbfm", "http_request_firewall_managed"]
      products = ["bic", "securityLevel", "uablock"]
    }

    logging {
      enabled = true
    }
  }
}

output "worker_m2m_bot_skip_ruleset_id" {
  description = "Zone ruleset id for the worker M2M bot-mitigation exception (issue #783)."
  value       = cloudflare_ruleset.worker_m2m_bot_skip.id
}

output "install_url" { value = module.install_shogo_ai.install_url }
output "releases_url" { value = module.install_shogo_ai.releases_url }

# Wire this into EVERY region's api ksvc as CF_PREVIEW_REGIONS_KV_NAMESPACE_ID
# (via the custom-domains-config secret) so each region records the location of
# the previews it hosts.
output "preview_regions_kv_namespace_id" {
  description = "Workers KV namespace id for the preview region map."
  value       = module.preview_router.preview_regions_kv_namespace_id
}
output "preview_router_worker_name" { value = module.preview_router.worker_name }
output "preview_router_anchors" { value = module.preview_router.anchor_hostnames }
output "preview_wildcard_hostname" { value = module.preview_router.preview_wildcard_hostname }
output "preview_certificate_pack_id" { value = module.preview_router.certificate_pack_id }
