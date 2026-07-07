# =============================================================================
# edge-global — variables
# =============================================================================

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for shogo.ai"
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "github_token" {
  description = "Optional fine-grained GitHub token (repo:contents:read) wired into the releases.shogo.ai resolver Worker. Without it the Worker uses the 60/hr anonymous GitHub API quota; with it the quota jumps to 5000/hr."
  type        = string
  default     = null
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Preview-router region anchors — each region's Kourier LoadBalancer IP.
# -----------------------------------------------------------------------------
# Stable per-region OCI LB IPs (same values the production-global tunnel A
# records use). Defaulted here so the standard terraform.yml CI apply, which
# only passes the cloudflare_* vars to edge-global, needs no extra inputs.
# Override via TF_VAR_* if a region's LB IP ever changes.
variable "us_lb_ip" {
  description = "US (us-ashburn-1) Kourier LoadBalancer IP"
  type        = string
  default     = "152.70.192.220"
}

variable "eu_lb_ip" {
  description = "EU (eu-frankfurt-1) Kourier LoadBalancer IP"
  type        = string
  default     = "79.76.126.115"
}
