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
