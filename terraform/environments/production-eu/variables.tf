# =============================================================================
# Variables — Production EU
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
  type      = string
  sensitive = true
}

variable "cloudflare_zone_id" {
  type = string
}

variable "cloudflare_account_id" {
  type = string
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

variable "us_rpc_id" {
  description = "RPC OCID from production-us to accept peering"
  type        = string
}
