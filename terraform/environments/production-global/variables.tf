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
