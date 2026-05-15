# =============================================================================
# CloudNativePG Module
# =============================================================================
# Installs the CloudNativePG operator from the upstream release manifest via
# `kubectl apply`. The operator manages PostgreSQL clusters as Kubernetes
# native resources.
#
# Why kubectl/null_resource and not helm_release: the live installs in every
# environment were bootstrapped from the upstream raw manifest (per
# https://cloudnative-pg.io/documentation/current/installation_upgrade/),
# which lays the operator down at `cnpg-system` namespace + creates all CRDs
# and the controller deployment. A helm_release would create a parallel
# helm-managed install conflicting with the existing one, so this module
# matches the live install pattern exactly. Same approach used for Knative.
#
# After installation, create Cluster CRDs to provision PostgreSQL instances.
# =============================================================================

terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
}

variable "operator_version" {
  description = "CloudNativePG operator version (matches the GitHub release tag, e.g. \"1.25.0\")"
  type        = string
  default     = "1.25.0"
}

variable "namespace" {
  description = "Namespace for the CNPG operator (created by the upstream manifest)"
  type        = string
  default     = "cnpg-system"
}

variable "tags" {
  description = "Tags to apply to resources (unused for kubectl-installed components, kept for API compatibility)"
  type        = map(string)
  default     = {}
}

locals {
  # Release branch follows MAJOR.MINOR of the version (e.g. 1.25.0 -> release-1.25).
  release_branch  = "release-${join(".", slice(split(".", var.operator_version), 0, 2))}"
  manifest_url    = "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/${local.release_branch}/releases/cnpg-${var.operator_version}.yaml"
}

# -----------------------------------------------------------------------------
# Namespace
# -----------------------------------------------------------------------------
#
# The upstream manifest creates `cnpg-system` if it doesn't exist, but having
# the namespace declared explicitly in terraform too keeps the existing state
# entry valid and lets us set our own labels (`managed-by = terraform`).
# `kubectl apply --server-side` against an already-existing namespace is a
# no-op so there's no conflict.
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
# Operator install
# -----------------------------------------------------------------------------
#
# `kubectl apply` is idempotent: re-running it against an existing install at
# the same version is a no-op, and re-running with a newer manifest URL
# performs an in-place upgrade. The `triggers` field re-runs the provisioner
# only when the version changes, so day-to-day applies don't churn.
resource "null_resource" "operator" {
  depends_on = [kubernetes_namespace.cnpg]

  triggers = {
    operator_version = var.operator_version
    manifest_url     = local.manifest_url
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      kubectl apply --server-side -f ${local.manifest_url}
    EOT
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "namespace" {
  description = "Namespace where CNPG operator is installed"
  value       = var.namespace
}

output "operator_version" {
  description = "Installed CNPG operator version"
  value       = var.operator_version
}
