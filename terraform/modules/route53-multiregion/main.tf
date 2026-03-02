# =============================================================================
# Route 53 Multi-Region Latency-Based Routing Module
# =============================================================================
# Configures latency-based DNS routing with health checks for active-active
# multi-region deployments. Traffic is routed to the closest healthy region.
# =============================================================================

variable "domain" {
  description = "Base domain (e.g., shogo.ai)"
  type        = string
}

variable "subdomains" {
  description = "List of subdomains to configure latency routing for (e.g., [\"studio\", \"api\", \"mcp\"])"
  type        = list(string)
}

variable "regions" {
  description = "Map of region identifiers to their configuration"
  type = map(object({
    region            = string
    alb_dns_name      = string
    alb_zone_id       = string
    health_check_path = string
  }))
}

variable "health_check_interval" {
  description = "Health check interval in seconds (10 or 30)"
  type        = number
  default     = 30
}

variable "health_check_failure_threshold" {
  description = "Number of consecutive failures before marking unhealthy"
  type        = number
  default     = 3
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Route 53 Hosted Zone
# -----------------------------------------------------------------------------
data "aws_route53_zone" "main" {
  name         = "${var.domain}."
  private_zone = false
}

# -----------------------------------------------------------------------------
# Health Checks (one per region per subdomain)
# Route 53 health checks are global - they run from multiple AWS regions
# -----------------------------------------------------------------------------
locals {
  # Create a flat map of subdomain+region combinations
  subdomain_region_pairs = {
    for pair in flatten([
      for subdomain in var.subdomains : [
        for region_key, region_config in var.regions : {
          key         = "${subdomain}-${region_key}"
          subdomain   = subdomain
          region_key  = region_key
          region      = region_config.region
          alb_dns     = region_config.alb_dns_name
          alb_zone_id = region_config.alb_zone_id
          health_path = region_config.health_check_path
        }
      ]
    ]) : pair.key => pair
  }
}

resource "aws_route53_health_check" "region" {
  for_each = local.subdomain_region_pairs

  fqdn              = each.value.alb_dns
  port              = 443
  type              = "HTTPS"
  resource_path     = each.value.health_path
  failure_threshold = var.health_check_failure_threshold
  request_interval  = var.health_check_interval

  tags = merge(var.tags, {
    Name      = "${each.value.subdomain}.${var.domain}-${each.value.region_key}"
    Subdomain = each.value.subdomain
    Region    = each.value.region
  })
}

# -----------------------------------------------------------------------------
# Latency-Based Routing Records
# Each subdomain gets one A record per region with latency routing policy
# -----------------------------------------------------------------------------
resource "aws_route53_record" "latency" {
  for_each = local.subdomain_region_pairs

  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "${each.value.subdomain}.${var.domain}"
  type           = "A"
  set_identifier = each.value.region_key

  alias {
    name                   = each.value.alb_dns
    zone_id                = each.value.alb_zone_id
    evaluate_target_health = true
  }

  latency_routing_policy {
    region = each.value.region
  }

  health_check_id = aws_route53_health_check.region[each.key].id
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "health_check_ids" {
  description = "Map of health check IDs"
  value       = { for k, v in aws_route53_health_check.region : k => v.id }
}

output "record_fqdns" {
  description = "List of FQDNs created"
  value       = distinct([for k, v in aws_route53_record.latency : v.fqdn])
}
