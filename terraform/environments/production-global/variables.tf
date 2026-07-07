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

# NOTE: `india_lb_ip` / `india_serving_enabled` were removed 2026-07-07 when
# production-india was decommissioned (India→EU migration). The mesh is now
# two-region (US/EU). See docs/runbooks/india-to-eu-migration.md.
