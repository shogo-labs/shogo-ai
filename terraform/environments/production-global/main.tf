# =============================================================================
# Shogo — Production Global (Cloudflare Traffic Routing)
# =============================================================================
# Manages Cloudflare Load Balancers for studio.shogo.ai and docs.shogo.ai
# with shared origin pools (Pro plan: 3 pool limit).
#
# Uses dynamic_latency steering: Cloudflare measures RTT to each origin
# and routes traffic to the fastest healthy pool automatically.
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# =============================================================================
# Shared Health Monitor
# =============================================================================

resource "cloudflare_load_balancer_monitor" "health" {
  account_id       = var.cloudflare_account_id
  type             = "https"
  path             = "/api/health"
  expected_codes   = "200"
  interval         = 60
  timeout          = 10
  retries          = 2
  method           = "GET"
  follow_redirects = true
  allow_insecure   = false

  header {
    header = "Host"
    values = ["studio.shogo.ai"]
  }
}

# =============================================================================
# Shared Origin Pools (3 pools — Pro plan limit)
# =============================================================================

resource "cloudflare_load_balancer_pool" "us" {
  account_id    = var.cloudflare_account_id
  name          = "shogo-us"
  enabled       = true
  monitor       = cloudflare_load_balancer_monitor.health.id
  latitude      = 39.0
  longitude     = -77.5
  check_regions = ["ENAM", "WNAM"]

  origins {
    name    = "kourier-us"
    address = var.us_lb_ip
    weight  = 1
    enabled = true
  }
}

resource "cloudflare_load_balancer_pool" "eu" {
  account_id    = var.cloudflare_account_id
  name          = "shogo-eu"
  enabled       = true
  monitor       = cloudflare_load_balancer_monitor.health.id
  latitude      = 50.1
  longitude     = 8.7
  check_regions = ["WEU", "EEU"]

  origins {
    name    = "kourier-eu"
    address = var.eu_lb_ip
    weight  = 1
    enabled = true
  }
}

resource "cloudflare_load_balancer_pool" "india" {
  account_id    = var.cloudflare_account_id
  name          = "shogo-in"
  enabled       = true
  monitor       = cloudflare_load_balancer_monitor.health.id
  latitude      = 19.1
  longitude     = 72.9
  check_regions = ["IN", "SEAS"]

  # India→EU migration: the origin is disabled (health-drained) when
  # var.india_serving_enabled = false so no new traffic lands on ap-mumbai-1.
  origins {
    name    = "kourier-in"
    address = var.india_lb_ip
    weight  = 1
    enabled = var.india_serving_enabled
  }
}

locals {
  # `compact` drops the empty string so the India pool leaves the steering set
  # entirely when var.india_serving_enabled = false (Phase 2 edge drain). US +
  # EU remain; US stays the fallback pool below.
  pool_ids = compact([
    cloudflare_load_balancer_pool.us.id,
    cloudflare_load_balancer_pool.eu.id,
    var.india_serving_enabled ? cloudflare_load_balancer_pool.india.id : "",
  ])
}

# =============================================================================
# Load Balancer — studio.shogo.ai
# =============================================================================

resource "cloudflare_load_balancer" "studio" {
  zone_id     = var.cloudflare_zone_id
  name        = "studio.shogo.ai"
  description = "Multi-region LB for studio.shogo.ai"
  proxied     = true

  steering_policy      = "dynamic_latency"
  default_pool_ids     = local.pool_ids
  fallback_pool_id     = cloudflare_load_balancer_pool.us.id
  session_affinity     = "cookie"
  session_affinity_ttl = 1800
}

# =============================================================================
# Load Balancer — api.shogo.ai (public OpenAI-compatible API)
# =============================================================================
# The docs/blog advertise `https://api.shogo.ai/v1` as the OpenAI-compatible
# base URL for the Hoshi models. Serve it from the same three regional Kourier
# origins as studio/docs with latency steering.
#
# History: `api.shogo.ai` was previously a STALE Cloudflare CNAME (from the
# retired AWS EKS deployment) pointing at a now-deleted ELB
# `k8s-kouriers-kourier-9a7244743d-...elb.us-east-1.amazonaws.com`; that target
# NXDOMAIN'd, so clients hit `Could not resolve host: api.shogo.ai`. That record
# has since been deleted. `api.shogo.ai` now falls through the proxied
# `*.shogo.ai` wildcard to the US Kourier LB, and the k8s `api-public` Ingress
# (k8s/overlays/production-*/api-public-ingress.yaml, applied in all three
# regions) routes the host straight to the api ksvc — so the endpoint is
# already live, US-origin only.
#
# This Load Balancer is the resilience upgrade: it overrides the wildcard for
# this exact host with geo latency-steering + health failover across all three
# regional Kourier LBs (matching studio/docs). Requires an account-scoped token
# with Load Balancing:Edit. Applying it is non-disruptive — the more-specific LB
# hostname simply supersedes the wildcard fallback.
resource "cloudflare_load_balancer" "api" {
  zone_id     = var.cloudflare_zone_id
  name        = "api.shogo.ai"
  description = "Multi-region LB for api.shogo.ai (public OpenAI-compatible API)"
  proxied     = true

  steering_policy  = "dynamic_latency"
  default_pool_ids = local.pool_ids
  fallback_pool_id = cloudflare_load_balancer_pool.us.id
  session_affinity = "none"
}

# =============================================================================
# Load Balancer — docs.shogo.ai
# =============================================================================

resource "cloudflare_load_balancer" "docs" {
  zone_id     = var.cloudflare_zone_id
  name        = "docs.shogo.ai"
  description = "Multi-region LB for docs.shogo.ai"
  proxied     = true

  steering_policy  = "dynamic_latency"
  default_pool_ids = local.pool_ids
  fallback_pool_id = cloudflare_load_balancer_pool.us.id
  session_affinity = "none"
}

# =============================================================================
# Region-specific DNS records for load testing and direct access
# =============================================================================

resource "cloudflare_record" "eu_studio" {
  zone_id = var.cloudflare_zone_id
  name    = "eu.studio"
  content = var.eu_lb_ip
  type    = "A"
  proxied = true
}

resource "cloudflare_record" "india_studio" {
  zone_id = var.cloudflare_zone_id
  name    = "india.studio"
  content = var.india_lb_ip
  type    = "A"
  proxied = true
}

# =============================================================================
# Desktop Tunnel WebSocket — regional A records (NOT load-balanced)
# =============================================================================
# The desktop tunnel WebSocket must stay in the same region whose API
# issued its heartbeat, so each region gets a direct A record to its own
# OCI LB. Cloudflare proxying is kept on for TLS termination + WS
# passthrough; the Knative Ingress (api-tunnel) inside each cluster routes
# to the api revision pods' queue-proxy port 8012 and bypasses the
# DomainMapping loopback that drops WS Upgrade.

resource "cloudflare_record" "us_tunnel" {
  zone_id = var.cloudflare_zone_id
  name    = "tunnel"
  content = var.us_lb_ip
  type    = "A"
  proxied = true
}

resource "cloudflare_record" "eu_tunnel" {
  zone_id = var.cloudflare_zone_id
  name    = "eu.tunnel"
  content = var.eu_lb_ip
  type    = "A"
  proxied = true
}

resource "cloudflare_record" "india_tunnel" {
  zone_id = var.cloudflare_zone_id
  name    = "india.tunnel"
  content = var.india_lb_ip
  type    = "A"
  proxied = true
}

# =============================================================================
# Preview Router
# =============================================================================
# NOTE: The per-project preview router (Worker + KV for `*.preview.shogo.ai`)
# lives in the `edge-global` environment, NOT here. It was moved there so it can
# be applied via the standard terraform.yml CI flow on the S3 backend, without
# first migrating production-global's existing LOCAL state (which owns
# studio/docs LBs + tunnel records). See terraform/environments/edge-global and
# docs/preview-router.md.

# =============================================================================
# Outputs
# =============================================================================

output "studio_lb_id" { value = cloudflare_load_balancer.studio.id }
output "api_lb_id" { value = cloudflare_load_balancer.api.id }
output "docs_lb_id" { value = cloudflare_load_balancer.docs.id }
output "eu_studio_record" { value = cloudflare_record.eu_studio.hostname }
output "india_studio_record" { value = cloudflare_record.india_studio.hostname }
output "us_tunnel_record" { value = cloudflare_record.us_tunnel.hostname }
output "eu_tunnel_record" { value = cloudflare_record.eu_tunnel.hostname }
output "india_tunnel_record" { value = cloudflare_record.india_tunnel.hostname }
output "pool_ids" {
  value = {
    us = cloudflare_load_balancer_pool.us.id
    eu = cloudflare_load_balancer_pool.eu.id
    in = cloudflare_load_balancer_pool.india.id
  }
}

