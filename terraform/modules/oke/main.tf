# =============================================================================
# OKE Module (Oracle Kubernetes Engine)
# =============================================================================
# Creates an Enhanced OKE cluster with managed node pools.
# Equivalent to the AWS EKS module.
# =============================================================================

terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 8.0"
    }
  }
}

variable "cluster_name" {
  description = "OKE cluster name"
  type        = string
}

variable "compartment_id" {
  description = "OCI compartment OCID"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "v1.35.0"
}

variable "vcn_id" {
  description = "VCN OCID"
  type        = string
}

variable "public_subnet_id" {
  description = "Public subnet OCID (for LBs and for the K8s API endpoint when no dedicated api_endpoint subnet is provided)"
  type        = string
}

variable "api_endpoint_subnet_id" {
  description = "Optional dedicated subnet OCID for the Kubernetes API endpoint. When null (default), the API endpoint is placed in `public_subnet_id`. Set when adopting clusters that were bootstrapped with a separate api-endpoint subnet."
  type        = string
  default     = null
}

variable "private_workers_subnet_id" {
  description = "Private subnet OCID for worker nodes"
  type        = string
}

variable "private_pods_subnet_id" {
  description = "Private subnet OCID for VCN-native pods"
  type        = string
}

variable "api_nsg_id" {
  description = "NSG OCID for the K8s API endpoint. Pass `null` to attach no NSG (relies on subnet security lists instead)."
  type        = string
  default     = null
}

variable "workers_nsg_id" {
  description = "NSG OCID for worker nodes. Pass `null` to attach no NSG to the node pool / pod subnets (relies on subnet security lists instead)."
  type        = string
  default     = null
}

variable "node_shape" {
  description = "Compute shape for worker nodes"
  type        = string
  default     = "VM.Standard.A4.Flex"
}

variable "node_ocpus" {
  description = "OCPUs per worker node"
  type        = number
  default     = 8
}

variable "node_memory_gb" {
  description = "Memory in GB per worker node"
  type        = number
  default     = 32
}

variable "node_pool_size" {
  description = "Number of nodes in the main node pool"
  type        = number
  default     = 3
}

variable "node_pool_min" {
  description = "Minimum nodes for autoscaling"
  type        = number
  default     = 1
}

variable "node_pool_max" {
  description = "Maximum nodes for autoscaling"
  type        = number
  default     = 10
}

variable "boot_volume_gb" {
  # Sized for the warm-pool workload: each node hosts ~15 user workspaces, and a
  # single workspace can pull a multi-GB project image, run `bun install` into
  # node_modules, build, then layer overlayfs deltas. 100 GB was hitting
  # DiskPressure repeatedly on staging (see incident 2026-05-14 — kubelet started
  # evicting pods at 80%+ disk and image GC removed layers other ksvc revisions
  # still referenced, breaking routes). 200 GB gives ~6 GB of working space per
  # co-tenant before pressure kicks in.
  description = "Boot volume size in GB"
  type        = number
  default     = 200
}

variable "enable_workload_pool" {
  description = "Enable a separate node pool for user workloads (project runtimes)"
  type        = bool
  default     = false
}

# --- main node pool overrides for environments that pre-date the
# system-vs-workloads pool split ---------------------------------------------
#
# These vars exist so an environment that was originally provisioned as a
# single-pool cluster can keep its pool's name + density settings under
# terraform management without forcing an in-place "rename" or a node
# replacement just for state hygiene. Production envs use the defaults.

variable "main_node_pool_name_override" {
  description = "Override the main node pool's name. Defaults to \"<cluster_name>-system\". Set to e.g. \"<cluster_name>-arm\" when adopting tf-management of a pre-existing pool that has a different name in OCI."
  type        = string
  default     = null
}

variable "main_node_pool_max_pods" {
  description = "Maximum pods per node on the main pool. OCI ships 110 for fresh pools; older pools may have been created with a lower bound (e.g. 93 on staging). Setting this to match the live value avoids an in-place change that would only take effect on node replacement."
  type        = number
  default     = 110
}

variable "workload_node_shape" {
  description = "Compute shape for workload nodes"
  type        = string
  default     = "VM.Standard.A4.Flex"
}

variable "workload_node_ocpus" {
  description = "OCPUs per workload node"
  type        = number
  default     = 8
}

variable "workload_node_memory_gb" {
  description = "Memory in GB per workload node"
  type        = number
  default     = 64
}

variable "workload_pool_size" {
  description = "Desired number of workload nodes"
  type        = number
  default     = 2
}

variable "workload_pool_min" {
  description = "Minimum workload nodes for autoscaling"
  type        = number
  default     = 1
}

variable "workload_pool_max" {
  description = "Maximum workload nodes for autoscaling"
  type        = number
  default     = 100
}

variable "image_id" {
  description = "Node image OCID (OKE-optimized Oracle Linux). If empty, uses latest OKE image."
  type        = string
  default     = ""
}

variable "placement_ad_names" {
  description = "Availability domain names for node placement. If empty, spreads across all ADs."
  type        = list(string)
  default     = []
}

variable "ssh_public_key" {
  description = "SSH public key for node access (optional)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Freeform tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

# Get the latest OKE-optimized node image if none specified
data "oci_containerengine_node_pool_option" "default" {
  node_pool_option_id = "all"
  compartment_id      = var.compartment_id
}

locals {
  all_ads              = data.oci_identity_availability_domains.ads.availability_domains[*].name
  availability_domains = length(var.placement_ad_names) > 0 ? var.placement_ad_names : local.all_ads
  use_custom_image     = var.image_id != ""
}

# -----------------------------------------------------------------------------
# OKE Cluster (Enhanced)
# -----------------------------------------------------------------------------
resource "oci_containerengine_cluster" "main" {
  compartment_id     = var.compartment_id
  kubernetes_version = var.kubernetes_version
  name               = var.cluster_name
  vcn_id             = var.vcn_id
  type               = "ENHANCED_CLUSTER"

  cluster_pod_network_options {
    cni_type = "OCI_VCN_IP_NATIVE"
  }

  endpoint_config {
    is_public_ip_enabled = true
    subnet_id            = coalesce(var.api_endpoint_subnet_id, var.public_subnet_id)
    nsg_ids              = compact([var.api_nsg_id])
  }

  options {
    service_lb_subnet_ids = [var.public_subnet_id]

    kubernetes_network_config {
      services_cidr = "10.96.0.0/16"
    }

    persistent_volume_config {
      freeform_tags = var.tags
    }

    service_lb_config {
      freeform_tags = var.tags
    }
  }

  freeform_tags = var.tags

  # `endpoint_config` and `options.service_lb_subnet_ids` are immutable
  # in OCI — any difference between config and live forces full cluster
  # replacement (and cascades to node pools). Production-us was
  # bootstrapped with a dedicated /28 api_endpoint subnet that is now
  # plumbed via `api_endpoint_subnet_id`, but other envs may have
  # bootstrap-time differences too (NSG attachments, public-vs-private
  # endpoint, etc.). Lock the whole block out of drift detection so the
  # tf state stays adoptable.
  lifecycle {
    ignore_changes = [
      endpoint_config,
      options[0].service_lb_subnet_ids,
    ]
  }
}

# -----------------------------------------------------------------------------
# Main Node Pool (system workloads: API, web, CNPG, Knative, SigNoz)
# -----------------------------------------------------------------------------
resource "oci_containerengine_node_pool" "main" {
  compartment_id     = var.compartment_id
  cluster_id         = oci_containerengine_cluster.main.id
  kubernetes_version = var.kubernetes_version
  name               = coalesce(var.main_node_pool_name_override, "${var.cluster_name}-system")

  node_shape = var.node_shape
  node_shape_config {
    ocpus         = var.node_ocpus
    memory_in_gbs = var.node_memory_gb
  }

  node_config_details {
    size = var.node_pool_size

    dynamic "placement_configs" {
      for_each = local.availability_domains
      content {
        availability_domain = placement_configs.value
        subnet_id           = var.private_workers_subnet_id
      }
    }

    nsg_ids = compact([var.workers_nsg_id])

    node_pool_pod_network_option_details {
      cni_type          = "OCI_VCN_IP_NATIVE"
      max_pods_per_node = var.main_node_pool_max_pods
      pod_subnet_ids    = [var.private_pods_subnet_id]
      pod_nsg_ids       = compact([var.workers_nsg_id])
    }

    freeform_tags = merge(var.tags, {
      "node-pool" = "system"
    })
  }

  node_source_details {
    source_type             = "IMAGE"
    image_id                = local.use_custom_image ? var.image_id : data.oci_containerengine_node_pool_option.default.sources[0].image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  # Custom OKE images have their own bootstrap — user_data overrides it and
  # causes RegisterTimeOut. Only set user_data for auto-detected OKE images.
  node_metadata = local.use_custom_image ? {} : {
    user_data = base64encode(join("\n", [
      "#!/bin/bash",
      "curl --fail -H \"Authorization: Bearer Oracle\" -L0 http://169.254.169.254/opc/v2/instance/metadata/oke_init_script | base64 --decode >/var/run/oke-init.sh",
      "bash /usr/libexec/oci-growfs -y",
      "bash /var/run/oke-init.sh",
    ]))
  }

  initial_node_labels {
    key   = "node.kubernetes.io/purpose"
    value = "system"
  }

  ssh_public_key = var.ssh_public_key != "" ? var.ssh_public_key : null

  freeform_tags = var.tags

  # The cluster-autoscaler is wired to this node pool's OCID via the
  # GitHub Actions variable NODE_POOL_OCID for the matching environment.
  # If Terraform replaces this resource, the OCID changes and the CA
  # silently sits inert (logs `node pool not found for instance`),
  # because OCID-typed args don't trigger a CA rollout. This caused the
  # staging incident on 2026-05-04 — the deploy workflow's
  # "Verify configured node pool matches running nodes" step fails fast
  # in that case, but the safer fix is to disallow accidental
  # replacement here. To intentionally replace the pool: temporarily
  # remove this lifecycle block, plan/apply, then update the
  # NODE_POOL_OCID GH Actions var BEFORE the next deploy.
  lifecycle {
    prevent_destroy = true

    # `node_metadata` (the cloud-init user_data) only takes effect on new
    # nodes, so a drift between tf and the live setting is invisible until
    # the pool scales out. Pre-existing pools that were provisioned with a
    # custom user_data script will look "drifted" against this module's
    # auto-init script even though existing nodes are healthy; setting
    # `main_node_pool_ignore_node_metadata = true` opts out of that diff
    # so day-to-day applies don't fight the live setting.
    #
    # Terraform doesn't allow dynamic ignore_changes per-instance, so this
    # is implemented as an unconditional ignore (matches every env). Pools
    # that genuinely want the module's user_data emitted still get it on
    # initial create — only subsequent drift is suppressed.
    ignore_changes = [node_metadata]
  }
}

# -----------------------------------------------------------------------------
# Workload Node Pool (user project runtimes — autoscaled)
# Separate pool to allow independent scaling and node sizing.
# -----------------------------------------------------------------------------
resource "oci_containerengine_node_pool" "workloads" {
  count = var.enable_workload_pool ? 1 : 0

  compartment_id     = var.compartment_id
  cluster_id         = oci_containerengine_cluster.main.id
  kubernetes_version = var.kubernetes_version
  name               = "${var.cluster_name}-workloads"

  node_shape = var.workload_node_shape
  node_shape_config {
    ocpus         = var.workload_node_ocpus
    memory_in_gbs = var.workload_node_memory_gb
  }

  node_config_details {
    size = var.workload_pool_size

    dynamic "placement_configs" {
      for_each = local.availability_domains
      content {
        availability_domain = placement_configs.value
        subnet_id           = var.private_workers_subnet_id
      }
    }

    nsg_ids = compact([var.workers_nsg_id])

    node_pool_pod_network_option_details {
      cni_type          = "OCI_VCN_IP_NATIVE"
      max_pods_per_node = 110
      pod_subnet_ids    = [var.private_pods_subnet_id]
      pod_nsg_ids       = compact([var.workers_nsg_id])
    }

    freeform_tags = merge(var.tags, {
      "node-pool" = "workloads"
    })
  }

  node_source_details {
    source_type             = "IMAGE"
    image_id                = local.use_custom_image ? var.image_id : data.oci_containerengine_node_pool_option.default.sources[0].image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  node_metadata = local.use_custom_image ? {} : {
    user_data = base64encode(join("\n", [
      "#!/bin/bash",
      "curl --fail -H \"Authorization: Bearer Oracle\" -L0 http://169.254.169.254/opc/v2/instance/metadata/oke_init_script | base64 --decode >/var/run/oke-init.sh",
      "bash /usr/libexec/oci-growfs -y",
      "bash /var/run/oke-init.sh",
    ]))
  }

  initial_node_labels {
    key   = "node.kubernetes.io/purpose"
    value = "workloads"
  }

  freeform_tags = var.tags

  # See note on `oci_containerengine_node_pool.main.lifecycle`. Same rule:
  # silent CA breakage if the OCID changes, so disallow accidental replace.
  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "cluster_id" {
  description = "OKE cluster OCID"
  value       = oci_containerengine_cluster.main.id
}

output "cluster_name" {
  description = "OKE cluster name"
  value       = oci_containerengine_cluster.main.name
}

output "cluster_kubernetes_version" {
  description = "Kubernetes version"
  value       = oci_containerengine_cluster.main.kubernetes_version
}

output "cluster_endpoint" {
  description = "OKE cluster API endpoint"
  value       = oci_containerengine_cluster.main.endpoints[0].kubernetes
}

output "system_node_pool_id" {
  description = "System node pool OCID"
  value       = oci_containerengine_node_pool.main.id
}

output "workload_node_pool_id" {
  description = "Workload node pool OCID (null if disabled)"
  value       = var.enable_workload_pool ? oci_containerengine_node_pool.workloads[0].id : null
}

# Operator-facing reminder: these are the values that MUST be kept in sync
# with the matching GitHub Actions environment variables. If they ever
# diverge (e.g. you replaced a node pool out-of-band), the cluster-autoscaler
# silently fails to scale and warm-pool admissions wedge. The deploy
# workflow's `Verify configured node pool matches running nodes` step will
# fail fast in that case — but it's much better not to drift in the first
# place. After a `terraform apply` that touches the cluster or pools, copy
# the values below into the matching GitHub Actions environment variables
# (Settings → Environments → <env> → Variables):
#   - OKE_CLUSTER_OCID  ← cluster_id
#   - NODE_POOL_OCID    ← system_node_pool_id (CA scales the system pool today)
output "github_actions_vars" {
  description = "Values that must be mirrored into GitHub Actions env vars"
  value = {
    OKE_CLUSTER_OCID = oci_containerengine_cluster.main.id
    NODE_POOL_OCID   = oci_containerengine_node_pool.main.id
  }
}
