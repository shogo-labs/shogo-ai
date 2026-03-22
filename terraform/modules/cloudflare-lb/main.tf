# =============================================================================
# Cloudflare Load Balancer Module
# =============================================================================
# Creates a Cloudflare Load Balancer with geo-steering across multiple
# origin pools. Supports N regions with health monitoring and automatic
# failover.
#
# Usage:
#   module "lb" {
#     source = "../../modules/cloudflare-lb"
#     origins = {
#       us = { address = "141.148.27.1", latitude = 39.0, longitude = -77.5 }
#       eu = { address = "1.2.3.4",      latitude = 50.1, longitude = 8.7  }
#       in = { address = "5.6.7.8",      latitude = 19.1, longitude = 72.9 }
#     }
#     geo_routing = {
#       WNAM = ["us", "eu"]      # Western N. America → US, fallback EU
#       ENAM = ["us", "eu"]      # Eastern N. America → US, fallback EU
#       WEU  = ["eu", "us"]      # Western Europe → EU, fallback US
#       EEU  = ["eu", "us"]      # Eastern Europe → EU, fallback US
#       ME   = ["eu", "in"]      # Middle East → EU, fallback India
#       AF   = ["eu", "us"]      # Africa → EU, fallback US
#       SAS  = ["in", "eu"]      # South Asia → India, fallback EU
#       SEAS = ["in", "eu"]      # SE Asia → India, fallback EU
#       OC   = ["us", "in"]      # Oceania → US, fallback India
#     }
#     ...
#   }
# =============================================================================

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain"
  type        = string
}

variable "hostname" {
  description = "Hostname for the LB (e.g. studio.shogo.ai)"
  type        = string
}

variable "pool_name_prefix" {
  description = "Prefix for pool names to avoid collisions across LBs"
  type        = string
  default     = ""
}

variable "origins" {
  description = "Map of region_key → origin config"
  type = map(object({
    address   = string
    latitude  = optional(number)
    longitude = optional(number)
    weight    = optional(number, 1)
    enabled   = optional(bool, true)
  }))
}

variable "health_check_path" {
  description = "Path for health check"
  type        = string
  default     = "/api/health"
}

variable "health_check_host" {
  description = "Host header for health checks"
  type        = string
  default     = ""
}

variable "health_check_interval" {
  description = "Health check interval in seconds (Pro: 60-3600, Enterprise: 5-3600)"
  type        = number
  default     = 60
}

variable "steering_policy" {
  description = "Traffic steering policy: geo, dynamic_latency, proximity, random, off"
  type        = string
  default     = "geo"
}

variable "geo_routing" {
  description = "Map of Cloudflare region code → ordered list of origin region_keys"
  type        = map(list(string))
  default     = {}
}

variable "default_pool_order" {
  description = "Default pool failover order (list of region_keys)"
  type        = list(string)
}

variable "session_affinity" {
  description = "Session affinity type: none, cookie, ip_cookie, header"
  type        = string
  default     = "cookie"
}

variable "session_affinity_ttl" {
  description = "Session affinity TTL in seconds"
  type        = number
  default     = 1800
}

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Health Monitor
# -----------------------------------------------------------------------------

resource "cloudflare_load_balancer_monitor" "health" {
  account_id     = var.cloudflare_account_id
  type           = "https"
  path           = var.health_check_path
  expected_codes = "200"
  interval       = var.health_check_interval
  timeout        = 10
  retries        = 2
  method         = "GET"
  follow_redirects = true
  allow_insecure   = false

  dynamic "header" {
    for_each = var.health_check_host != "" ? [var.health_check_host] : []
    content {
      header = "Host"
      values = [header.value]
    }
  }
}

# -----------------------------------------------------------------------------
# Origin Pools (one per region)
# -----------------------------------------------------------------------------

resource "cloudflare_load_balancer_pool" "region" {
  for_each = var.origins

  account_id = var.cloudflare_account_id
  name       = var.pool_name_prefix != "" ? "${var.pool_name_prefix}-${each.key}" : "shogo-${each.key}"
  enabled    = each.value.enabled
  monitor    = cloudflare_load_balancer_monitor.health.id

  origins {
    name    = "kourier-${each.key}"
    address = each.value.address
    weight  = each.value.weight
    enabled = each.value.enabled
  }

  dynamic "origin_steering" {
    for_each = each.value.latitude != null ? [1] : []
    content {
      policy = "random"
    }
  }

  latitude  = each.value.latitude
  longitude = each.value.longitude
}

# -----------------------------------------------------------------------------
# Load Balancer
# -----------------------------------------------------------------------------

resource "cloudflare_load_balancer" "main" {
  zone_id     = var.cloudflare_zone_id
  name        = var.hostname
  description = "Multi-region LB for ${var.hostname}"
  proxied     = true

  steering_policy = var.steering_policy

  default_pool_ids = [for k in var.default_pool_order : cloudflare_load_balancer_pool.region[k].id]
  fallback_pool_id = cloudflare_load_balancer_pool.region[var.default_pool_order[0]].id

  session_affinity     = var.session_affinity
  session_affinity_ttl = var.session_affinity_ttl

  dynamic "pop_pools" {
    for_each = var.geo_routing
    content {
      pop      = pop_pools.key
      pool_ids = [for k in pop_pools.value : cloudflare_load_balancer_pool.region[k].id]
    }
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "load_balancer_id" {
  description = "Cloudflare Load Balancer ID"
  value       = cloudflare_load_balancer.main.id
}

output "monitor_id" {
  description = "Health monitor ID"
  value       = cloudflare_load_balancer_monitor.health.id
}

output "pool_ids" {
  description = "Map of region_key → pool ID"
  value       = { for k, v in cloudflare_load_balancer_pool.region : k => v.id }
}
