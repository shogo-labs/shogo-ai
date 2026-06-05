# =============================================================================
# Variables — Staging OCI Environment
# =============================================================================

# -----------------------------------------------------------------------------
# OCI Core
# -----------------------------------------------------------------------------

variable "compartment_id" {
  description = "OCI compartment OCID for all resources"
  type        = string
}

variable "tenancy_id" {
  description = "OCI tenancy OCID"
  type        = string
  default     = "ocid1.tenancy.oc1..aaaaaaaay4h5nxkmkaz3sjoug4eovmhbzvlbnz2iiwaqgfqjjxclvbcosixq"
}

variable "region" {
  description = "OCI region"
  type        = string
  default     = "us-ashburn-1"
}

# -----------------------------------------------------------------------------
# OCI Authentication (API Key)
# -----------------------------------------------------------------------------

variable "oci_user_ocid" {
  description = "OCI user OCID for API key authentication"
  type        = string
}

variable "oci_fingerprint" {
  description = "Fingerprint of the OCI API signing key"
  type        = string
}

variable "oci_private_key_path" {
  description = "Path to the OCI API signing private key PEM file"
  type        = string
}

# -----------------------------------------------------------------------------
# Cloudflare
# -----------------------------------------------------------------------------

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS and Workers permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the primary domain"
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (for Workers)"
  type        = string
}

# -----------------------------------------------------------------------------
# Custom domains (Cloudflare for SaaS) — bring-your-own hostnames
# -----------------------------------------------------------------------------
# Staging shares the `shogo.one` publish zone with production (staging owns
# `*.staging.shogo.one`, prod owns `*.shogo.one`). Cloudflare for SaaS's
# fallback origin + `*/*` worker route are per-zone singletons, so staging
# CANNOT host custom domains on `shogo.one` without colliding with prod.
# Instead, point `custom_domains_zone` at a SEPARATE zone dedicated to staging
# custom hostnames, then flip `enable_custom_domains` on. Left off by default
# so a plain `terraform apply` is a no-op until the dedicated zone exists.
variable "enable_custom_domains" {
  description = "Enable Cloudflare for SaaS custom hostnames for staging. Requires `custom_domains_zone` to be set to a dedicated zone (NOT shogo.one). Defaults to false."
  type        = bool
  default     = false
}

variable "custom_domains_zone" {
  description = "Dedicated Cloudflare zone NAME for staging custom hostnames (e.g. `staging-apps.example`). MUST be a different zone than the shared `shogo.one` publish zone. Required when `enable_custom_domains` is true."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# SigNoz (Observability)
# -----------------------------------------------------------------------------

variable "signoz_endpoint" {
  description = "SigNoz OTLP endpoint (gRPC)"
  type        = string
  default     = "ingest.us.signoz.cloud:443"
}

variable "signoz_ingestion_key" {
  description = "SigNoz Cloud ingestion key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "oke_api_allowed_cidrs" {
  description = "CIDRs allowed to reach the OKE API endpoint (port 6443). Restrict to VPN/bastion ranges."
  type        = list(string)
}

variable "nfs_allowed_cidr" {
  description = "CIDR block allowed to mount NFS (typically worker node subnet)"
  type        = string
}
