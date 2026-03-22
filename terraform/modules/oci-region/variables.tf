# =============================================================================
# OCI Region Module — Variables
# =============================================================================
# A single composable module that provisions an entire OCI region.
# Set `tier` to control what gets deployed:
#   - "full"  (Tier 1): VCN + OKE + OCIR + Object Storage + File Storage + CNPG + Knative + SigNoz
#   - "light" (Tier 2): VCN + OKE + OCIR + Knative + SigNoz (no local data layer)
# =============================================================================

# -----------------------------------------------------------------------------
# Region Identity
# -----------------------------------------------------------------------------

variable "region" {
  description = "OCI region identifier (e.g. us-ashburn-1, eu-frankfurt-1, ap-mumbai-1)"
  type        = string
}

variable "region_key" {
  description = "Short region key for naming (e.g. us, eu, in)"
  type        = string
}

variable "tier" {
  description = "Region tier: 'full' (Tier 1 — complete data layer) or 'light' (Tier 2 — compute only)"
  type        = string
  default     = "full"

  validation {
    condition     = contains(["full", "light"], var.tier)
    error_message = "tier must be 'full' or 'light'"
  }
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
}

# -----------------------------------------------------------------------------
# OCI Identity
# -----------------------------------------------------------------------------

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "tenancy_id" {
  description = "OCI tenancy OCID"
  type        = string
}

# -----------------------------------------------------------------------------
# Network
# -----------------------------------------------------------------------------

variable "vcn_cidr" {
  description = "CIDR block for the VCN — must be unique across all regions"
  type        = string
}

# -----------------------------------------------------------------------------
# OKE Cluster
# -----------------------------------------------------------------------------

variable "system_node_ocpus" {
  description = "OCPUs per system node"
  type        = number
  default     = 8
}

variable "system_node_memory_gb" {
  description = "Memory (GB) per system node"
  type        = number
  default     = 64
}

variable "system_pool_size" {
  description = "Desired system node count"
  type        = number
  default     = 3
}

variable "system_pool_min" {
  description = "Minimum system nodes (autoscaler)"
  type        = number
  default     = 2
}

variable "system_pool_max" {
  description = "Maximum system nodes (autoscaler)"
  type        = number
  default     = 15
}

variable "enable_workload_pool" {
  description = "Enable a separate node pool for agent runtimes"
  type        = bool
  default     = true
}

variable "workload_node_ocpus" {
  description = "OCPUs per workload node"
  type        = number
  default     = 8
}

variable "workload_node_memory_gb" {
  description = "Memory (GB) per workload node"
  type        = number
  default     = 64
}

variable "workload_pool_size" {
  description = "Desired workload node count"
  type        = number
  default     = 2
}

variable "workload_pool_min" {
  description = "Minimum workload nodes (autoscaler)"
  type        = number
  default     = 1
}

variable "workload_pool_max" {
  description = "Maximum workload nodes (autoscaler)"
  type        = number
  default     = 100
}

# -----------------------------------------------------------------------------
# Knative / Ingress
# -----------------------------------------------------------------------------

variable "domain" {
  description = "Primary domain (e.g. shogo.ai)"
  type        = string
  default     = "shogo.ai"
}

variable "publish_domain" {
  description = "Published apps domain (e.g. shogo.one)"
  type        = string
  default     = "shogo.one"
}

# -----------------------------------------------------------------------------
# Observability
# -----------------------------------------------------------------------------

variable "signoz_endpoint" {
  description = "SigNoz OTLP endpoint"
  type        = string
  default     = "ingest.us.signoz.cloud:443"
}

variable "signoz_ingestion_key" {
  description = "SigNoz Cloud ingestion key"
  type        = string
  default     = ""
  sensitive   = true
}

# -----------------------------------------------------------------------------
# Tier 1 only — Database write source (for Tier 2 regions)
# -----------------------------------------------------------------------------

variable "database_primary_endpoint" {
  description = "Primary database endpoint for Tier 2 regions to connect to (ignored for Tier 1)"
  type        = string
  default     = ""
}

variable "s3_primary_endpoint" {
  description = "Primary region's S3-compatible endpoint (for Tier 2 regions to read from)"
  type        = string
  default     = ""
}

variable "s3_primary_region" {
  description = "Primary region identifier for S3 access (for Tier 2 regions)"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Cloudflare (for publish-hosting, only Tier 1)
# -----------------------------------------------------------------------------

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID"
  type        = string
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Autoscaler IAM
# -----------------------------------------------------------------------------

variable "create_autoscaler_iam" {
  description = "Create the OCI dynamic group and IAM policy for the cluster autoscaler. Enable in only one region per tenancy (typically the primary)."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}
