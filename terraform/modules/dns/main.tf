# =============================================================================
# DNS Module (Cloudflare)
# =============================================================================
# Manages DNS records for Shogo domains via Cloudflare.
# Cloudflare provides DNS + CDN + Workers (for published apps).
# Replaces the AWS route53-multiregion module.
# =============================================================================

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the primary domain"
  type        = string
}

variable "domain" {
  description = "Primary domain (e.g. shogo.ai)"
  type        = string
}

variable "lb_ip_or_hostname" {
  description = "OCI Load Balancer IP or hostname for Knative/Kourier"
  type        = string
}

variable "additional_records" {
  description = "Additional DNS records to create"
  type = list(object({
    name    = string
    type    = string
    value   = string
    proxied = bool
  }))
  default = []
}

# -----------------------------------------------------------------------------
# Platform DNS Records
# -----------------------------------------------------------------------------

# studio.shogo.ai → OKE Load Balancer (Kourier)
resource "cloudflare_record" "studio" {
  zone_id = var.cloudflare_zone_id
  name    = "studio"
  content = var.lb_ip_or_hostname
  type    = "A"
  proxied = true
}

# docs.shogo.ai → OKE Load Balancer (Kourier)
resource "cloudflare_record" "docs" {
  zone_id = var.cloudflare_zone_id
  name    = "docs"
  content = var.lb_ip_or_hostname
  type    = "A"
  proxied = true
}

# Additional records (flexible)
resource "cloudflare_record" "additional" {
  for_each = { for idx, r in var.additional_records : idx => r }

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  content = each.value.value
  type    = each.value.type
  proxied = each.value.proxied
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "studio_record" {
  description = "Studio DNS record hostname"
  value       = cloudflare_record.studio.hostname
}

output "docs_record" {
  description = "Docs DNS record hostname"
  value       = cloudflare_record.docs.hostname
}

