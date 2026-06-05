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

variable "oke_api_allowed_cidrs" {
  description = "CIDRs allowed to reach the OKE API endpoint (port 6443). Restrict to VPN/bastion ranges."
  type        = list(string)
}

variable "nfs_allowed_cidr" {
  description = "CIDR block allowed to mount NFS (typically worker node subnet)"
  type        = string
}

# -----------------------------------------------------------------------------
# OKE Cluster
# -----------------------------------------------------------------------------

variable "system_node_shape" {
  description = "Compute shape for system nodes"
  type        = string
  default     = "VM.Standard.A4.Flex"
}

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

variable "system_node_boot_volume_gb" {
  # Set explicitly per environment so the value is auditable and a
  # cross-region drift (e.g. EU bootstrapped at 100 GB while US is 200 GB)
  # is visible in code, not hidden behind a module default. The EU
  # 2026-06-02 incident was caused by EU nodes running 100 GB boot volumes:
  # ~30 GB of stacked 8 GB runtime images pushed them past the kubelet
  # DiskPressure threshold, triggering eviction/image-GC and warm-pool churn.
  #
  # NOTE: the oke module ignores in-place changes to this attribute
  # (boot volume changes force a rolling node replacement). Raising it on an
  # already-bootstrapped pool therefore requires a deliberate node-pool
  # replacement — see terraform/README.md ("Boot volume remediation").
  description = "Boot volume size (GB) for system nodes. Must match across regions."
  type        = number
  default     = 200
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

variable "image_id" {
  description = "Custom OKE node image OCID. If empty, auto-detects latest OKE image."
  type        = string
  default     = ""
}

variable "placement_ad_names" {
  description = "Availability domain names for node placement. If empty, spreads across all ADs."
  type        = list(string)
  default     = []
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
  description = "Cloudflare zone ID. DEPRECATED in this composite — the publish-hosting submodule now looks up the zone by name. Kept here for backwards compatibility with existing env wiring. Reading this var is what gates `enable_publish_hosting`'s default (empty string => disabled)."
  type        = string
  default     = ""
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
  default     = ""
}

variable "publish_zone" {
  description = "Cloudflare zone name that hosts `publish_domain`. Forwarded to `publish-hosting-oci` so subdomain publish_domains (e.g. `staging.shogo.one`) can still resolve their zone lookup against the parent (e.g. `shogo.one`). Defaults to null which makes the submodule fall back to `publish_domain`."
  type        = string
  default     = null
}

variable "enable_publish_hosting" {
  description = "Enable the publish-hosting submodule (Cloudflare Worker + Route + wildcard DNS + bucket PAR). Defaults to `null` which preserves the legacy `cloudflare_zone_id != \"\"` gate. Set explicitly to `false` to disable on environments where publish-hosting is owned elsewhere (e.g. EU/India, which use US for publish_apps)."
  type        = bool
  default     = null
}

variable "enable_custom_domains" {
  description = "Forwarded to `publish-hosting-oci`: enable Cloudflare for SaaS bring-your-own custom hostnames. Defaults to false. Requires `custom_domains_zone` to be a DEDICATED zone (distinct from the publish zone, which is shared across environments). Only effective when publish-hosting is enabled for this region."
  type        = bool
  default     = false
}

variable "custom_domains_zone" {
  description = "Forwarded to `publish-hosting-oci`: dedicated Cloudflare zone NAME for custom hostnames (e.g. a separate domain). MUST differ from the publish domain — the SaaS fallback origin + `*/*` worker route are per-zone singletons and the publish zone is shared. Ignored unless `enable_custom_domains`."
  type        = string
  default     = null
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
# Network module options (VCN)
# -----------------------------------------------------------------------------

variable "vcn_enable_security_lists" {
  description = "Create module-owned security lists and attach them to subnets. Default true (greenfield production). Set false for environments where the VCN was bootstrapped against OCI's default security list and a network-rule rewrite would be disruptive."
  type        = bool
  default     = true
}

variable "vcn_enable_oke_nsgs" {
  description = "Create the OKE API + worker NSGs (and their rules). Default true. Set false for environments where the cluster was bootstrapped without NSGs."
  type        = bool
  default     = true
}

variable "vcn_enable_dedicated_api_subnet" {
  description = "Create a small dedicated subnet for the OKE API endpoint (instead of placing it on the public subnet). Forwarded to vcn submodule and used as `api_endpoint_subnet_id` on the OKE cluster. Defaults to false."
  type        = bool
  default     = false
}

variable "vcn_api_endpoint_cidr" {
  description = "CIDR for the dedicated API endpoint subnet when `vcn_enable_dedicated_api_subnet = true`. Defaults to null (= first /28 in the VCN range)."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# OKE module options
# -----------------------------------------------------------------------------

variable "oke_main_node_pool_name_override" {
  description = "Override the main (system) node pool name. Defaults to null which uses the module's standard <cluster_name>-system naming. Set when adopting a live pool that was named differently (e.g. shogo-prod-us-arm-4ocpu in production-us)."
  type        = string
  default     = null
}

variable "oke_main_node_pool_max_pods" {
  description = "Override `max_pods_per_node` on the main node pool. Defaults to 110 (OCI default for VCN-native CNI). Live production pools were bootstrapped at 93."
  type        = number
  default     = 110
}

# -----------------------------------------------------------------------------
# Operator install gating (Knative / CNPG)
# -----------------------------------------------------------------------------

variable "knative_manage_install" {
  description = "Run the Knative + Kourier install/patch null_resources. Set false for environments where Knative was bootstrapped out-of-band so tf doesn't re-run kubectl on every apply. Idempotent either way."
  type        = bool
  default     = true
}

variable "cnpg_manage_install" {
  description = "Run the CNPG operator install null_resource. Set false for environments where the operator was bootstrapped out-of-band."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Object Storage compartment + lifecycle overrides
# -----------------------------------------------------------------------------

variable "object_storage_workspaces_compartment_id" {
  description = "Override compartment for the workspaces bucket. Defaults to `var.compartment_id`."
  type        = string
  default     = null
}

variable "object_storage_pg_backups_compartment_id" {
  description = "Override compartment for the pg-backups bucket. Defaults to `var.compartment_id`."
  type        = string
  default     = null
}

variable "object_storage_schemas_compartment_id" {
  description = "Override compartment for the schemas bucket. Defaults to `var.compartment_id`."
  type        = string
  default     = null
}

variable "object_storage_published_apps_compartment_id" {
  description = "Override compartment for the published-apps bucket. Defaults to `var.compartment_id`."
  type        = string
  default     = null
}

variable "object_storage_lifecycle_service_policy_compartment_id" {
  description = "Compartment for the tenancy-scoped `Allow service objectstorage-<region> to manage object-family ...` IAM policy that lifecycle rules require. Set to `var.tenancy_id` on one env per tenancy; null on the rest. The staging env already owns this policy at tenancy scope so production envs default to null."
  type        = string
  default     = null
}

variable "object_storage_lifecycle_service_policy_scope" {
  description = "Compartment scope for the lifecycle service-principal IAM policy. `\"tenancy\"` or a compartment name."
  type        = string
  default     = "tenancy"
}

# -----------------------------------------------------------------------------
# GitHub OIDC gating
# -----------------------------------------------------------------------------

variable "enable_github_oidc" {
  description = "Create the OCI identity group + policy that lets GH Actions assume role via OIDC. Default true matches the historical behavior."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# OCIR repositories
# -----------------------------------------------------------------------------

variable "ocir_repositories" {
  description = "List of OCIR repository names to create under `shogo/`. Default tracks the canonical greenfield set; envs with additional live repos (e.g. agent-runtime, shogo-runtime-base) should override to include them so tf doesn't try to destroy them."
  type        = list(string)
  default     = ["shogo-api", "shogo-web", "shogo-runtime", "shogo-docs"]
}

# -----------------------------------------------------------------------------
# Tags
# -----------------------------------------------------------------------------

variable "tags" {
  description = "Freeform tags"
  type        = map(string)
  default     = {}
}
