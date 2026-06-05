# =============================================================================
# Variables — Production US
# =============================================================================

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "tenancy_id" {
  description = "OCI tenancy OCID"
  type        = string
  default     = "ocid1.tenancy.oc1..aaaaaaaay4h5nxkmkaz3sjoug4eovmhbzvlbnz2iiwaqgfqjjxclvbcosixq"
}

variable "oci_user_ocid" {
  type = string
}

variable "oci_fingerprint" {
  type = string
}

variable "oci_private_key_path" {
  type = string
}

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

# Custom domains (Cloudflare for SaaS). Left off by default: production owns
# `shogo.one`, but the SaaS fallback origin + `*/*` worker route are per-zone
# singletons and a `*/*` route on `shogo.one` would intercept every published
# app + the apex. Enabling requires a DEDICATED zone (the module precondition
# rejects `custom_domains_zone == shogo.one`). Set both, `terraform apply`, then
# create the `custom-domains-config` secret from the outputs.
variable "enable_custom_domains" {
  description = "Enable Cloudflare for SaaS custom hostnames for production-us. Requires `custom_domains_zone` set to a dedicated zone (NOT shogo.one). Defaults to false."
  type        = bool
  default     = false
}

variable "custom_domains_zone" {
  description = "Dedicated Cloudflare zone NAME for production custom hostnames. MUST differ from the shared `shogo.one` publish zone. Required when `enable_custom_domains` is true."
  type        = string
  default     = null
}

variable "signoz_endpoint" {
  type    = string
  default = "ingest.us.signoz.cloud:443"
}

variable "signoz_ingestion_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "oke_api_allowed_cidrs" {
  description = "CIDRs allowed to reach the OKE API endpoint. Wired from GH variable OKE_API_ALLOWED_CIDRS via TF_VAR_oke_api_allowed_cidrs."
  type        = list(string)
}

variable "nfs_allowed_cidr" {
  description = "CIDR allowed to mount NFS (typically the private workers subnet). Wired from GH variable NFS_ALLOWED_CIDR via TF_VAR_nfs_allowed_cidr."
  type        = string
}
