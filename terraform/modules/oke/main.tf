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
      version = "~> 6.0"
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
  default     = "v1.31.1"
}

variable "vcn_id" {
  description = "VCN OCID"
  type        = string
}

variable "public_subnet_id" {
  description = "Public subnet OCID (for K8s API endpoint and LBs)"
  type        = string
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
  description = "NSG OCID for the K8s API endpoint"
  type        = string
}

variable "workers_nsg_id" {
  description = "NSG OCID for worker nodes"
  type        = string
}

variable "node_shape" {
  description = "Compute shape for worker nodes"
  type        = string
  default     = "VM.Standard.E4.Flex"
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
  description = "Boot volume size in GB"
  type        = number
  default     = 100
}

variable "enable_workload_pool" {
  description = "Enable a separate node pool for user workloads (project runtimes)"
  type        = bool
  default     = false
}

variable "workload_node_shape" {
  description = "Compute shape for workload nodes"
  type        = string
  default     = "VM.Standard.E4.Flex"
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
  # Use first AD for single-AD regions, spread across ADs for multi-AD
  availability_domains = data.oci_identity_availability_domains.ads.availability_domains[*].name
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
    subnet_id            = var.public_subnet_id
    nsg_ids              = [var.api_nsg_id]
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
}

# -----------------------------------------------------------------------------
# Main Node Pool (system workloads: API, web, CNPG, Knative, SigNoz)
# -----------------------------------------------------------------------------
resource "oci_containerengine_node_pool" "main" {
  compartment_id     = var.compartment_id
  cluster_id         = oci_containerengine_cluster.main.id
  kubernetes_version = var.kubernetes_version
  name               = "${var.cluster_name}-system"

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

    nsg_ids = [var.workers_nsg_id]

    node_pool_pod_network_option_details {
      cni_type          = "OCI_VCN_IP_NATIVE"
      max_pods_per_node = 110
      pod_subnet_ids    = [var.private_pods_subnet_id]
      pod_nsg_ids       = [var.workers_nsg_id]
    }

    freeform_tags = merge(var.tags, {
      "node-pool" = "system"
    })
  }

  node_source_details {
    source_type             = "IMAGE"
    image_id                = var.image_id != "" ? var.image_id : data.oci_containerengine_node_pool_option.default.sources[0].image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  node_metadata = {
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

    nsg_ids = [var.workers_nsg_id]

    node_pool_pod_network_option_details {
      cni_type          = "OCI_VCN_IP_NATIVE"
      max_pods_per_node = 110
      pod_subnet_ids    = [var.private_pods_subnet_id]
      pod_nsg_ids       = [var.workers_nsg_id]
    }

    freeform_tags = merge(var.tags, {
      "node-pool" = "workloads"
    })
  }

  node_source_details {
    source_type             = "IMAGE"
    image_id                = var.image_id != "" ? var.image_id : data.oci_containerengine_node_pool_option.default.sources[0].image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  node_metadata = {
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
