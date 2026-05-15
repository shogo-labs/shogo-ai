# =============================================================================
# install-shogo-ai — inputs
# =============================================================================

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Workers"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the apex domain (shogo.ai)"
  type        = string
}

variable "domain" {
  description = "Apex domain to host install.<domain> and releases.<domain> on"
  type        = string
  default     = "shogo.ai"
}

variable "github_owner" {
  description = "GitHub org/owner that publishes shogo-worker releases"
  type        = string
  default     = "shogo-labs"
}

variable "github_repo" {
  description = "GitHub repo that publishes shogo-worker releases"
  type        = string
  default     = "shogo-ai"
}

variable "github_token" {
  description = "Optional GitHub token (fine-grained, repo:contents:read) for the releases resolver. Without it the Worker uses the 60/hr anonymous GitHub API quota; with it the quota jumps to 5000/hr."
  type        = string
  default     = null
  sensitive   = true
}

variable "environment" {
  description = "Suffix appended to the Worker script names to keep staging/prod distinct in the Cloudflare dashboard"
  type        = string
  default     = "production"
}
