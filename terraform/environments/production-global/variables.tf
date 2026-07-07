# =============================================================================
# Variables — Production Global (Cloudflare LB)
# =============================================================================

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_zone_id" {
  type = string
}

variable "cloudflare_account_id" {
  type = string
}

# Kourier LB IPs from each regional environment
variable "us_lb_ip" {
  description = "US Kourier LoadBalancer IP"
  type        = string
}

variable "eu_lb_ip" {
  description = "EU Kourier LoadBalancer IP"
  type        = string
}

variable "india_lb_ip" {
  description = "India Kourier LoadBalancer IP"
  type        = string
}

# 2026-07-06 India→EU migration (permanent decommission of production-india).
# Phase 2 edge drain: flip to `false` and apply to remove the India origin from
# the studio/api/docs latency-steering pools. Cloudflare drains in-flight
# sessions via the studio LB `__cflb` affinity cookie (1800s TTL) and steers
# new requests to the next-lowest-RTT pool (EU), so the cutover is graceful.
# Rollback is instant: set back to `true` and apply. The India pool + regional
# `india.studio` / `india.tunnel` records are intentionally KEPT while this is
# `false` (India stays alive as the data home until the Phase 3 homeRegion flip
# and Phase 4 teardown). See docs/runbooks/india-to-eu-migration.md §2.
variable "india_serving_enabled" {
  description = "Whether ap-mumbai-1 is an active serving origin in the studio/api/docs load balancers. Set false to drain India edge traffic to EU during the India→EU migration."
  type        = bool
  default     = true
}
