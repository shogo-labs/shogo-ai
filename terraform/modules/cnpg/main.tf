# =============================================================================
# CloudNativePG Module
# =============================================================================
# Installs the CloudNativePG operator via Helm chart.
# The operator manages PostgreSQL clusters as Kubernetes-native resources.
#
# After installation, create Cluster CRDs to provision PostgreSQL instances.
# Works identically on EKS, k3s, and bare-metal Kubernetes.
# =============================================================================

variable "chart_version" {
  description = "CloudNativePG Helm chart version"
  type        = string
  default     = "0.23.0"
}

variable "namespace" {
  description = "Namespace for the CNPG operator"
  type        = string
  default     = "cnpg-system"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Namespace
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "cnpg" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/part-of"    = "cloudnative-pg"
    }
  }
}

# -----------------------------------------------------------------------------
# Helm Release - CloudNativePG Operator
# -----------------------------------------------------------------------------
resource "helm_release" "cnpg" {
  name       = "cnpg-operator"
  repository = "https://cloudnative-pg.github.io/charts"
  chart      = "cloudnative-pg"
  version    = var.chart_version
  namespace  = var.namespace

  depends_on = [kubernetes_namespace.cnpg]

  # Operator configuration
  set {
    name  = "monitoring.podMonitorEnabled"
    value = "true"
  }

  # Wait for CRDs to be established before marking as complete
  wait = true
  timeout = 300
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "namespace" {
  description = "Namespace where CNPG operator is installed"
  value       = var.namespace
}

output "chart_version" {
  description = "Installed CNPG chart version"
  value       = var.chart_version
}
