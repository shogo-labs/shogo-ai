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

variable "signoz_endpoint" {
  type    = string
  default = "ingest.us.signoz.cloud:443"
}

variable "signoz_ingestion_key" {
  type      = string
  default   = ""
  sensitive = true
}

# These come from production-us outputs
variable "us_rpc_id" {
  description = "RPC OCID from production-us for DRG peering"
  type        = string
}

variable "us_database_endpoint" {
  description = "US primary database endpoint (CNPG service address or peered IP)"
  type        = string
}

variable "us_s3_endpoint" {
  description = "US Object Storage S3-compatible endpoint"
  type        = string
}
