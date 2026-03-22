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

variable "signoz_endpoint" {
  type    = string
  default = "ingest.us.signoz.cloud:443"
}

variable "signoz_ingestion_key" {
  type      = string
  default   = ""
  sensitive = true
}
