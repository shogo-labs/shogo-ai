# =============================================================================
# Shogo — Staging Environment (OCI)
# =============================================================================
# OKE-based staging environment in Oracle Cloud Infrastructure.
# Cluster: shogo-staging | Region: us-ashburn-1
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }

  # Remote state on OCI Object Storage (S3-compat).
  # Endpoint is supplied via -backend-config at `terraform init` time:
  #   terraform init -backend-config="endpoint=$OCI_S3_ENDPOINT"
  # Credentials come from $AWS_ACCESS_KEY_ID / $AWS_SECRET_ACCESS_KEY env vars
  # (see GH secrets OCI_S3_ACCESS_KEY / OCI_S3_SECRET_KEY).
  backend "s3" {
    bucket = "shogo-tfstate"
    key    = "staging/terraform.tfstate"
    region = "us-ashburn-1"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    force_path_style            = true
  }
}

# =============================================================================
# Providers
# =============================================================================

provider "oci" {
  tenancy_ocid     = var.tenancy_id
  user_ocid        = var.oci_user_ocid
  fingerprint      = var.oci_fingerprint
  private_key_path = var.oci_private_key_path
  region           = var.region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "oci_containerengine_cluster_kube_config" "main" {
  cluster_id = module.oke.cluster_id
}

provider "kubernetes" {
  host                   = module.oke.cluster_endpoint
  cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "oci"
    args        = ["ce", "cluster", "generate-token", "--cluster-id", module.oke.cluster_id, "--region", var.region]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.oke.cluster_endpoint
    cluster_ca_certificate = base64decode(yamldecode(data.oci_containerengine_cluster_kube_config.main.content)["clusters"][0]["cluster"]["certificate-authority-data"])
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "oci"
      args        = ["ce", "cluster", "generate-token", "--cluster-id", module.oke.cluster_id, "--region", var.region]
    }
  }
}

locals {
  environment  = "staging"
  cluster_name = "shogo-staging"
  domain       = "staging.shogo.ai"

  tags = {
    Environment = "staging"
    ManagedBy   = "terraform"
    Project     = "shogo"
  }
}

# =============================================================================
# Availability Domain (needed by file-storage)
# =============================================================================

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

# =============================================================================
# Networking — VCN
# =============================================================================

module "vcn" {
  source = "../../modules/vcn"

  name                  = local.cluster_name
  compartment_id        = var.compartment_id
  cidr                  = "10.0.0.0/16"
  single_nat_gateway    = true
  oke_api_allowed_cidrs = var.oke_api_allowed_cidrs
  tags                  = local.tags

  # Staging was bootstrapped without module-owned security lists or NSGs.
  # The live VCN uses OCI's default security list for all three subnets and
  # the OKE cluster + node pool have no NSGs attached. Flipping these to
  # `true` for staging would re-attach security lists (replacing the
  # defaults, which changes the effective network policy) and create NSGs
  # the cluster doesn't reference. Keep them off here; production envs
  # leave the defaults (`true`) and get the full network surface.
  enable_security_lists = false
  enable_oke_nsgs       = false
}

# =============================================================================
# Kubernetes — OKE
# =============================================================================

module "oke" {
  source = "../../modules/oke"

  cluster_name              = local.cluster_name
  compartment_id            = var.compartment_id
  vcn_id                    = module.vcn.vcn_id
  public_subnet_id          = module.vcn.public_subnet_id
  private_workers_subnet_id = module.vcn.private_workers_subnet_id
  private_pods_subnet_id    = module.vcn.private_pods_subnet_id
  api_nsg_id                = module.vcn.oke_api_nsg_id
  workers_nsg_id            = module.vcn.oke_workers_nsg_id

  image_id           = "ocid1.image.oc1.iad.aaaaaaaaxlqapo7gpvnvfndkhfnixrnvlumdgaexjvakamdmhiegulsypa5a"
  placement_ad_names = ["XYpk:US-ASHBURN-AD-2"]

  # Match production node specs (4 OCPUs / 24GB → 93 pods/node instead of 31)
  node_ocpus     = 4
  node_memory_gb = 24
  node_pool_size = 2
  node_pool_min  = 1
  node_pool_max  = 6

  # Staging was provisioned before the system-vs-workloads pool split landed.
  # The live pool is named `shogo-staging-arm` (not `-system`) and runs at
  # max_pods_per_node = 93 (not the OCI default 110). These overrides keep
  # tf-managed state in sync with the live pool so day-to-day plans don't
  # show cosmetic drift; the workloads pool is left disabled because every
  # workload currently runs on the main pool. Reconciling staging to the
  # production split is a separate migration.
  main_node_pool_name_override = "${local.cluster_name}-arm"
  main_node_pool_max_pods      = 93
  enable_workload_pool         = false

  tags = local.tags
}

# =============================================================================
# Container Registry — OCIR
# =============================================================================
#
# OCIR repositories (shogo/shogo-api, shogo/shogo-web, shogo/agent-runtime,
# shogo/shogo-docs) are tenancy-shared and live in the tenancy root
# compartment, NOT the staging compartment. They serve images for every
# environment (staging + the three production regions) so they're owned by
# whatever bootstrap created the tenancy and intentionally not managed from
# any env-specific terraform.
#
# The active production environments (production-us, -eu, -india) already
# don't declare an ocir module for the same reason. Staging previously did,
# which produced a 4-resource "to be created" entry in every plan that would
# have failed at apply time (the registries already exist by display name).
# Removed in 2026-05 along with the rest of the state reconciliation work.

# =============================================================================
# Object Storage
# =============================================================================

module "object_storage" {
  source = "../../modules/object-storage"

  compartment_id = var.compartment_id
  environment    = local.environment
  region         = var.region
  tags           = local.tags

  # Per-bucket compartment overrides — see module doc for why these exist.
  # Two of the four staging buckets were bootstrapped outside the staging
  # compartment, and these overrides let the tf config match the live
  # placement so the buckets can be imported without an enforced compartment
  # move on the next plan.
  #   shogo-workspaces-staging  -> production compartment
  #   shogo-pg-backups-staging  -> tenancy root
  # shogo-schemas-staging and shogo-published-apps-staging do not exist
  # live yet; they fall through to var.compartment_id and will be created
  # in the staging compartment on the next apply.
  workspaces_compartment_id = "ocid1.compartment.oc1..aaaaaaaaalshoan7geg7q32jpr5dbwbvrnu3vqjfqvtqkgyc6ydznxqigbza"
  pg_backups_compartment_id = var.tenancy_id

  # Create the tenancy-scoped IAM policy that grants
  # objectstorage-<region> permission to enact lifecycle rules. Only
  # needs to live in one env (this one); production envs leave the
  # default (null) and re-use this same policy.
  lifecycle_service_policy_compartment_id = var.tenancy_id
  lifecycle_service_policy_scope          = "tenancy"
}

# =============================================================================
# File Storage (NFS)
# =============================================================================

module "file_storage" {
  source = "../../modules/file-storage"

  name                = "${local.cluster_name}-workspace-fs"
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  subnet_id           = module.vcn.private_workers_subnet_id
  nsg_ids             = compact([module.vcn.oke_workers_nsg_id])
  nfs_allowed_cidr    = var.nfs_allowed_cidr
  tags                = local.tags
}

# =============================================================================
# CloudNativePG Operator
# =============================================================================

module "cnpg" {
  source = "../../modules/cnpg"

  # CNPG operator was installed manually before tf adopted it. Skip the
  # kubectl-apply provisioner so plans don't show a perpetual "to be
  # created" null_resource. The namespace (cnpg-system) is still imported
  # and managed for label drift.
  manage_install = false

  tags = local.tags
}

# =============================================================================
# Knative Serving
# =============================================================================

module "knative" {
  source = "../../modules/knative-oci"

  # Staging's Knative + Kourier install was bootstrapped manually and the
  # kourier-toleration fix was hand-applied during the disk-pressure outage.
  # Live state already matches what these null_resources would install, so we
  # set `manage_install = false` to keep them out of state and keep plans
  # quiet. If we ever need to bump the Knative version or re-apply the
  # toleration strip, flip this back to true.
  manage_install = false

  domain             = local.domain
  publish_domain     = "shogo.one"
  enable_pvc_support = true
}

# =============================================================================
# SigNoz Observability
# =============================================================================

module "signoz" {
  source = "../../modules/signoz"

  cluster_name         = local.cluster_name
  environment          = local.environment
  signoz_endpoint      = var.signoz_endpoint
  signoz_ingestion_key = var.signoz_ingestion_key
  tags                 = local.tags
}

# =============================================================================
# GitHub OIDC (CI/CD Authentication)
# =============================================================================
#
# Staging's CI auth uses OCI user creds (OCI_USER_OCID + OCI_PRIVATE_KEY),
# not workload-identity-style OIDC federation. The
# `modules/oci-github-oidc` group + policy don't exist in staging's OCI
# tenancy and creating them wouldn't migrate any workflow automatically.
# Removed in 2026-05 as part of the live-state reconciliation. Re-add this
# block (and run terraform apply) if/when we wire up OIDC federation for
# CI workflows targeting staging.

# =============================================================================
# Autoscaler IAM (dynamic group + policy for OKE instance principal)
# =============================================================================

module "autoscaler_iam" {
  source = "../../modules/oci-autoscaler-iam"

  compartment_id = var.compartment_id
  tenancy_id     = var.tenancy_id
  environment    = local.environment
  tags           = local.tags
}

# =============================================================================
# DNS (Cloudflare)
# =============================================================================

module "dns" {
  source = "../../modules/dns"

  cloudflare_zone_id = var.cloudflare_zone_id
  domain             = local.domain
  subdomain          = "staging"
  lb_ip_or_hostname  = "0.0.0.0" # Unused: staging.shogo.ai records are owned out-of-band.
  additional_records = []

  # staging.shogo.ai's `studio.*` and `docs.*` records resolve to proxied
  # Cloudflare IPs that chain back to studio-staging.shogo.ai (which itself
  # points at a multi-region AWS ELB). They're owned by external-dns / the
  # legacy AWS deploy, not by this terraform. Don't let the module recreate
  # them with a placeholder 0.0.0.0 content.
  manage_platform_records = false
}

# =============================================================================
# Publish Hosting (OCI Object Storage + Cloudflare Worker)
# =============================================================================

module "publish_hosting" {
  source = "../../modules/publish-hosting-oci"

  compartment_id        = var.compartment_id
  environment           = local.environment
  publish_domain        = "staging.shogo.one"
  publish_zone          = "shogo.one"
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id
  oci_region            = var.region
  tags                  = local.tags

  # Bring-your-own custom hostnames (Cloudflare for SaaS). Disabled until a
  # dedicated zone (separate from the shared `shogo.one` publish zone) is
  # supplied — see variables.tf for the zone-collision rationale.
  enable_custom_domains = var.enable_custom_domains
  custom_domains_zone   = var.custom_domains_zone

  # Server-backed published apps (run server.tsx in production) are always on.
  # Proxying is live once kourier_origin points at the staging cluster's
  # Knative ingress; until then server-backed apps fall back to static serving.
  kourier_origin = var.kourier_origin

  # The PAR (pre-authenticated request) created inside this module is
  # scoped to `shogo-published-apps-${env}`, which the object_storage
  # module creates. Without this depends_on, terraform parallelizes the
  # bucket creation and the PAR creation, and OCI's PAR API returns 404
  # before object storage replication has propagated the new bucket.
  depends_on = [module.object_storage]
}

# =============================================================================
# Preview Router — preview routing without per-preview DNS records
# =============================================================================
# Staging mirror of the production-global preview-router so the Worker + KV +
# resolveOverride mechanism can be exercised here before the production cutover.
# Staging is single-region (us-ashburn-1, REGION_ID=staging), so there is one
# anchor (`kourier-staging.staging.shogo.ai`) pointing at the staging Kourier
# LB; `default_region = staging` means previews route correctly even with an
# empty KV (the wildcard `*.staging.shogo.ai` already targets the same LB).
#
# The staging route `preview--*.staging.shogo.ai/*` is MORE SPECIFIC than the
# production route `preview--*.shogo.ai/*` (both live in the shogo.ai zone), so
# Cloudflare routes staging preview hostnames here — this also shields staging
# from the production Worker once it is applied. See docs/preview-router.md.
locals {
  # Stable OCI-assigned address of the long-lived `kourier` Service in the
  # staging cluster's kourier-system namespace (not terraform-managed here).
  staging_kourier_lb_ip = "141.148.27.1"
}

module "preview_router" {
  source = "../../modules/preview-router"

  environment           = local.environment
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  zone_name             = "shogo.ai"
  preview_base_domain   = local.domain # staging.shogo.ai

  # REGION_ID=staging (see k8s/overlays/staging/api-service.yaml) maps to the
  # `staging` region code in cloudflare-preview-region-kv.ts.
  region_anchors = {
    staging = local.staging_kourier_lb_ip
  }
  default_region = "staging"
}

# =============================================================================
# Outputs
# =============================================================================

# Wire into the staging api ksvc as CF_PREVIEW_REGIONS_KV_NAMESPACE_ID (via the
# custom-domains-config secret) so new staging previews self-register.
output "preview_regions_kv_namespace_id" {
  description = "Workers KV namespace id for the staging preview region map."
  value       = module.preview_router.preview_regions_kv_namespace_id
}
output "preview_router_worker_name" { value = module.preview_router.worker_name }
output "preview_router_anchors" { value = module.preview_router.anchor_hostnames }

output "cluster_endpoint" {
  description = "OKE cluster API endpoint"
  value       = module.oke.cluster_endpoint
}

output "cluster_id" {
  description = "OKE cluster OCID"
  value       = module.oke.cluster_id
}

output "registry_namespace" {
  description = "OCIR namespace (derived from the object-storage namespace, which is identical tenancy-wide)"
  value       = module.object_storage.namespace
}

output "schemas_bucket" {
  description = "Schema storage bucket"
  value       = module.object_storage.schemas_bucket
}

output "workspaces_bucket" {
  description = "Workspace sync bucket"
  value       = module.object_storage.workspaces_bucket
}

output "pg_backups_bucket" {
  description = "PostgreSQL backups bucket"
  value       = module.object_storage.pg_backups_bucket
}

output "published_apps_bucket" {
  description = "Published apps bucket"
  value       = module.object_storage.published_apps_bucket
}

output "published_data_bucket" {
  description = "Published-app writable-state bucket (server-backed apps). Wire into the api ksvc as PUBLISH_DATA_BUCKET."
  value       = module.object_storage.published_data_bucket
}

output "server_backed_kv_namespace_id" {
  description = "Workers KV namespace id flagging server-backed published subdomains (null when disabled). Wire into the api ksvc/custom-domains-config secret as CF_SERVER_BACKED_KV_NAMESPACE_ID."
  value       = module.publish_hosting.server_backed_kv_namespace_id
}

output "file_system_export_path" {
  description = "NFS export path for workspace filesystem"
  value       = module.file_storage.export_path
}

# github_actions_group output removed alongside module.github_oidc.
