# =============================================================================
# SigNoz K8s Infrastructure Monitoring Module
# =============================================================================
# Deploys SigNoz K8s Infra chart for comprehensive cluster observability:
# - Node metrics (CPU, memory, disk, network)
# - Pod metrics and resource usage
# - Cluster events and logs
# - OpenTelemetry collector integration
# =============================================================================

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
}

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------

variable "namespace" {
  description = "Namespace for SigNoz K8s Infra components"
  type        = string
  default     = "signoz"
}

variable "create_namespace" {
  description = "Whether to create the namespace"
  type        = bool
  default     = true
}

variable "signoz_endpoint" {
  description = "SigNoz backend OTLP endpoint (gRPC) - e.g., http://signoz-otel-collector.signoz.svc.cluster.local:4317 or ingest.us.signoz.cloud:443"
  type        = string
}

variable "signoz_ingestion_key" {
  description = "SigNoz Cloud ingestion key (required for SigNoz Cloud, leave empty for self-hosted)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "cluster_name" {
  description = "Kubernetes cluster name for resource identification"
  type        = string
}

variable "environment" {
  description = "Environment name (staging, production)"
  type        = string
  default     = "staging"
}

variable "enable_logs" {
  description = "Enable log collection"
  type        = bool
  default     = true
}

variable "enable_events" {
  description = "Enable Kubernetes event collection"
  type        = bool
  default     = true
}

variable "enable_metrics" {
  description = "Enable metrics collection"
  type        = bool
  default     = true
}

variable "chart_version" {
  description = "Version of SigNoz K8s Infra chart (leave empty/null to use latest)"
  type        = string
  default     = null # null = use latest available version
  nullable    = true
}

variable "resource_limits" {
  description = "Resource limits for collectors"
  type = object({
    cpu    = string
    memory = string
  })
  default = {
    cpu    = "500m"
    memory = "512Mi"
  }
}

variable "resource_requests" {
  description = "Resource requests for collectors"
  type = object({
    cpu    = string
    memory = string
  })
  default = {
    cpu    = "100m"
    memory = "128Mi"
  }
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Namespace
# -----------------------------------------------------------------------------

resource "kubernetes_namespace" "signoz" {
  count = var.create_namespace ? 1 : 0

  metadata {
    name = var.namespace
    labels = merge(var.tags, {
      "app.kubernetes.io/name"    = "signoz"
      "app.kubernetes.io/part-of" = "observability"
      "environment"               = var.environment
    })
  }
}

# -----------------------------------------------------------------------------
# Helm Release: SigNoz K8s Infra
# -----------------------------------------------------------------------------

resource "helm_release" "signoz_k8s_infra" {
  name       = "signoz-k8s-infra"
  repository = "https://charts.signoz.io"
  chart      = "k8s-infra"
  # Omit version to use latest available, or specify a version
  version   = var.chart_version
  namespace = var.namespace

  # Wait for namespace to be created (Terraform handles this gracefully even if count=0)
  depends_on = [kubernetes_namespace.signoz]

  # Timeout for installation (metrics collection can take time to initialize)
  timeout = 600

  # Automatically create namespace if it doesn't exist (fallback)
  create_namespace = !var.create_namespace

  # =============================================================================
  # Core Configuration
  # =============================================================================

  # Cluster identification
  set {
    name  = "otelCollectorEndpoint"
    value = var.signoz_endpoint
  }

  set {
    name  = "clusterName"
    value = var.cluster_name
  }

  # SigNoz Cloud authentication (if ingestion key provided)
  dynamic "set" {
    for_each = var.signoz_ingestion_key != "" ? [1] : []
    content {
      name  = "otelInsecure"
      value = "false"
    }
  }

  dynamic "set_sensitive" {
    for_each = var.signoz_ingestion_key != "" ? [1] : []
    content {
      name  = "signozApiKey"
      value = var.signoz_ingestion_key
    }
  }

  # =============================================================================
  # Feature Flags
  # =============================================================================

  set {
    name  = "enableLogs"
    value = var.enable_logs
  }

  set {
    name  = "enableEvents"
    value = var.enable_events
  }

  set {
    name  = "enableMetrics"
    value = var.enable_metrics
  }

  # =============================================================================
  # Resource Configuration
  # =============================================================================

  # DaemonSet collector (runs on each node)
  set {
    name  = "otelAgent.resources.limits.cpu"
    value = var.resource_limits.cpu
  }

  set {
    name  = "otelAgent.resources.limits.memory"
    value = var.resource_limits.memory
  }

  set {
    name  = "otelAgent.resources.requests.cpu"
    value = var.resource_requests.cpu
  }

  set {
    name  = "otelAgent.resources.requests.memory"
    value = var.resource_requests.memory
  }

  # Deployment collector (cluster-level metrics)
  set {
    name  = "otelDeployment.resources.limits.cpu"
    value = var.resource_limits.cpu
  }

  set {
    name  = "otelDeployment.resources.limits.memory"
    value = var.resource_limits.memory
  }

  set {
    name  = "otelDeployment.resources.requests.cpu"
    value = var.resource_requests.cpu
  }

  set {
    name  = "otelDeployment.resources.requests.memory"
    value = var.resource_requests.memory
  }

  # =============================================================================
  # Collection Configuration
  # =============================================================================

  # Log collection settings
  set {
    name  = "otelAgent.logLevel"
    value = "info"
  }

  # Kubelet metrics (cAdvisor)
  set {
    name  = "otelAgent.kubeletMetrics.enabled"
    value = "true"
  }

  # Node metrics
  set {
    name  = "otelAgent.hostMetrics.enabled"
    value = "true"
  }

  # =============================================================================
  # Labels and Annotations
  # =============================================================================

  # Add environment label to all resources
  dynamic "set" {
    for_each = var.tags
    content {
      name  = "commonLabels.${set.key}"
      value = set.value
    }
  }

  # =============================================================================
  # Tolerations (for specialized nodes)
  # =============================================================================

  # Allow DaemonSet to run on all nodes (including Karpenter-provisioned)
  set {
    name  = "otelAgent.tolerations[0].operator"
    value = "Exists"
  }

  set {
    name  = "otelAgent.tolerations[0].effect"
    value = "NoSchedule"
  }

  # =============================================================================
  # Additional Configuration (optional)
  # =============================================================================

  # Container logs - exclude noisy namespaces
  set {
    name  = "otelAgent.containerLogs.excludeNamespaces[0]"
    value = "kube-system"
  }

  set {
    name  = "otelAgent.containerLogs.excludeNamespaces[1]"
    value = "kube-public"
  }

  set {
    name  = "otelAgent.containerLogs.excludeNamespaces[2]"
    value = "kube-node-lease"
  }

  # Performance tuning
  set {
    name  = "otelAgent.priorityClassName"
    value = "system-node-critical"
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "namespace" {
  description = "Namespace where SigNoz K8s Infra is deployed"
  value       = var.namespace
}

output "chart_version" {
  description = "Version of SigNoz K8s Infra chart deployed"
  value       = var.chart_version
}

output "release_name" {
  description = "Helm release name"
  value       = helm_release.signoz_k8s_infra.name
}

output "release_status" {
  description = "Status of the Helm release"
  value       = helm_release.signoz_k8s_infra.status
}
