# =============================================================================
# Variables — Production India (Tier 2)
# =============================================================================

variable "compartment_id" {
  type = string
}

variable "tenancy_id" {
  type    = string
  default = "ocid1.tenancy.oc1..aaaaaaaay4h5nxkmkaz3sjoug4eovmhbzvlbnz2iiwaqgfqjjxclvbcosixq"
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
  description = "Cloudflare API token. India does not manage Cloudflare resources directly, but the `oci-region` composite transitively requires the provider so an api_token is required even though it goes unused."
  type        = string
  sensitive   = true
  default     = ""
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
  description = "CIDR allowed to mount NFS. India is Tier 2 (no FSS), but the composite still requires the variable; kept for signature parity with us/eu."
  type        = string
  default     = "10.0.0.0/8"
}

# These come from production-us outputs
variable "us_rpc_id" {
  description = "RPC OCID from production-us for DRG peering"
  type        = string
  default     = ""
}

variable "us_database_endpoint" {
  description = "US primary database endpoint (CNPG service address or peered IP)"
  type        = string
  default     = ""
}

variable "us_s3_endpoint" {
  description = "US Object Storage S3-compatible endpoint"
  type        = string
  default     = ""
}
