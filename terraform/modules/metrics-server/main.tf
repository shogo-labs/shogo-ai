# =============================================================================
# Kubernetes Metrics Server Module
# =============================================================================
# OKE does not ship metrics-server by default. Without it the
# `metrics.k8s.io` API is missing, every CPU-based HPA reports
# `cpu: <unknown>` and never scales, and `kubectl top` fails.
# =============================================================================

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }
}

variable "chart_version" {
  description = "metrics-server Helm chart version"
  type        = string
  default     = "3.14.0"
}

variable "replicas" {
  description = "metrics-server replicas (2 keeps the metrics API up through a node drain)"
  type        = number
  default     = 2
}

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = var.chart_version
  namespace  = "kube-system"

  timeout = 300

  values = [yamlencode({
    replicas = var.replicas
    podDisruptionBudget = {
      enabled        = true
      maxUnavailable = 1
    }
    resources = {
      requests = { cpu = "100m", memory = "200Mi" }
      limits   = { memory = "500Mi" }
    }
  })]
}

output "release_status" {
  description = "Status of the Helm release"
  value       = helm_release.metrics_server.status
}
