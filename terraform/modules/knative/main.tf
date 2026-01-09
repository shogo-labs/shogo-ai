# =============================================================================
# Knative Serving Module
# =============================================================================
# Installs Knative Serving with Kourier ingress for scale-to-zero workspaces
# Uses null_resource with local-exec to apply manifests (avoids for_each issues)
# =============================================================================

terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }
}

variable "knative_version" {
  description = "Knative Serving version (latest: 1.16.0 as of Jan 2026)"
  type        = string
  default     = "1.16.0"
}

variable "domain" {
  description = "Domain for Knative services"
  type        = string
  default     = ""
}

variable "scale_to_zero_grace_period" {
  description = "Grace period before scaling to zero"
  type        = string
  default     = "60s"
}

# -----------------------------------------------------------------------------
# Knative Serving Installation via kubectl
# -----------------------------------------------------------------------------
resource "null_resource" "knative_serving" {
  triggers = {
    knative_version = var.knative_version
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Install Knative Serving CRDs
      kubectl apply -f https://github.com/knative/serving/releases/download/knative-v${var.knative_version}/serving-crds.yaml
      
      # Wait for CRDs
      sleep 10
      
      # Install Knative Serving Core
      kubectl apply -f https://github.com/knative/serving/releases/download/knative-v${var.knative_version}/serving-core.yaml
      
      # Wait for Knative to be ready
      kubectl wait --for=condition=Available deployment/controller -n knative-serving --timeout=300s || true
      kubectl wait --for=condition=Available deployment/webhook -n knative-serving --timeout=300s || true
    EOT
  }
}

# -----------------------------------------------------------------------------
# Kourier Ingress Installation
# -----------------------------------------------------------------------------
resource "null_resource" "kourier" {
  depends_on = [null_resource.knative_serving]

  triggers = {
    knative_version = var.knative_version
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Install Kourier
      kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v${var.knative_version}/kourier.yaml
      
      # Wait for Kourier
      kubectl wait --for=condition=Available deployment/3scale-kourier-gateway -n kourier-system --timeout=300s || true
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Knative via kubectl (ConfigMaps)
# -----------------------------------------------------------------------------
resource "null_resource" "knative_config" {
  depends_on = [null_resource.kourier]

  triggers = {
    scale_to_zero_grace_period = var.scale_to_zero_grace_period
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for ConfigMaps to exist
      sleep 30
      
      # Configure Kourier as ingress
      kubectl patch configmap/config-network \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
      
      # Configure scale-to-zero
      kubectl patch configmap/config-autoscaler \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"enable-scale-to-zero":"true","scale-to-zero-grace-period":"${var.scale_to_zero_grace_period}","scale-to-zero-pod-retention-period":"0s"}}'
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Domain (optional)
# -----------------------------------------------------------------------------
resource "null_resource" "knative_domain" {
  count = var.domain != "" ? 1 : 0

  depends_on = [null_resource.knative_config]

  triggers = {
    domain = var.domain
  }

  provisioner "local-exec" {
    command = <<-EOT
      kubectl patch configmap/config-domain \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"${var.domain}":""}}'
    EOT
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "knative_version" {
  description = "Installed Knative version"
  value       = var.knative_version
}

output "ingress_class" {
  description = "Knative ingress class"
  value       = "kourier.ingress.networking.knative.dev"
}
