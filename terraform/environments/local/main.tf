# =============================================================================
# Shogo AI - Local k3d Development Environment
# =============================================================================
# Sets up a local Kubernetes cluster for development/testing.
# Uses k3d (k3s in Docker) for lightweight local clusters.
#
# This configuration mirrors the production EKS setup but uses:
# - MinIO instead of AWS S3
# - Local PostgreSQL instead of RDS
# - nginx-ingress instead of ALB
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------
variable "cluster_name" {
  description = "Name of the k3d cluster"
  type        = string
  default     = "shogo-dev"
}

variable "registry_port" {
  description = "Port for local container registry"
  type        = number
  default     = 5050
}

variable "api_port" {
  description = "Host port for API access (via port-forward)"
  type        = number
  default     = 8002
}

variable "web_port" {
  description = "Host port for web access (via port-forward)"
  type        = number
  default     = 3000
}

variable "mcp_port" {
  description = "Host port for MCP access (via port-forward)"
  type        = number
  default     = 3100
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude"
  type        = string
  sensitive   = true
  default     = ""
}

variable "better_auth_secret" {
  description = "BetterAuth secret (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
  default     = "local-dev-secret-change-in-production"
}

# -----------------------------------------------------------------------------
# k3d Cluster Setup
# -----------------------------------------------------------------------------
resource "null_resource" "k3d_cluster" {
  triggers = {
    cluster_name  = var.cluster_name
    registry_port = var.registry_port
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Create registry if not exists
      if ! k3d registry list | grep -q "shogo-registry"; then
        k3d registry create shogo-registry --port ${var.registry_port}
      fi

      # Create cluster if not exists
      if k3d cluster list | grep -q "${var.cluster_name}"; then
        echo "Cluster ${var.cluster_name} already exists"
        k3d cluster start ${var.cluster_name} || true
      else
        echo "Creating k3d cluster ${var.cluster_name}..."
        k3d cluster create ${var.cluster_name} \
          --registry-use k3d-shogo-registry:${var.registry_port} \
          --port "80:80@loadbalancer" \
          --port "443:443@loadbalancer" \
          --agents 2 \
          --k3s-arg "--disable=traefik@server:0" \
          --wait
      fi
      
      # Set kubectl context
      kubectl config use-context k3d-${var.cluster_name}
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = "k3d cluster delete ${self.triggers.cluster_name} || true"
  }
}

# -----------------------------------------------------------------------------
# Kubernetes Provider
# -----------------------------------------------------------------------------
provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = "k3d-${var.cluster_name}"
}

provider "helm" {
  kubernetes {
    config_path    = "~/.kube/config"
    config_context = "k3d-${var.cluster_name}"
  }
}

# -----------------------------------------------------------------------------
# nginx-ingress Controller
# -----------------------------------------------------------------------------
resource "null_resource" "nginx_ingress" {
  depends_on = [null_resource.k3d_cluster]

  provisioner "local-exec" {
    command = <<-EOT
      kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.2/deploy/static/provider/cloud/deploy.yaml
      
      # Wait for controller
      kubectl wait --namespace ingress-nginx \
        --for=condition=ready pod \
        --selector=app.kubernetes.io/component=controller \
        --timeout=120s || true
    EOT
  }
}

# -----------------------------------------------------------------------------
# Shogo Namespace
# -----------------------------------------------------------------------------
resource "kubernetes_namespace" "shogo_system" {
  depends_on = [null_resource.k3d_cluster]

  metadata {
    name = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
      "environment"               = "local"
    }
  }
}

# -----------------------------------------------------------------------------
# Shared ConfigMap
# -----------------------------------------------------------------------------
resource "kubernetes_config_map" "shogo_config" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "shogo-config"
    namespace = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }

  data = {
    "s3-endpoint"         = "http://minio.shogo-system.svc.cluster.local:9000"
    "s3-bucket"           = "shogo-schemas"
    "s3-workspace-bucket" = "shogo-workspaces"
    "s3-force-path-style" = "true"
  }
}

# -----------------------------------------------------------------------------
# Shared Secrets
# -----------------------------------------------------------------------------
resource "kubernetes_secret" "shogo_secrets" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "shogo-secrets"
    namespace = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }

  # Use stringData instead of data to avoid double-encoding
  data = {
    "database-url"  = "postgres://shogo:shogo_k8s_dev@postgres.shogo-system.svc.cluster.local:5432/shogo"
    "s3-access-key" = "minioadmin"
    "s3-secret-key" = "minioadmin"
  }
}

resource "kubernetes_secret" "api_secrets" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "api-secrets"
    namespace = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }

  data = {
    "BETTER_AUTH_SECRET" = base64encode(var.better_auth_secret)
    "ANTHROPIC_API_KEY"  = base64encode(var.anthropic_api_key != "" ? var.anthropic_api_key : "placeholder-set-via-kubectl")
  }
}

resource "kubernetes_secret" "postgres_credentials" {
  depends_on = [kubernetes_namespace.shogo_system]

  metadata {
    name      = "postgres-credentials"
    namespace = "shogo-system"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }

  data = {
    "POSTGRES_USER"     = base64encode("shogo")
    "POSTGRES_PASSWORD" = base64encode("shogo_k8s_dev")
    "POSTGRES_DB"       = base64encode("shogo")
    "DATABASE_URL"      = base64encode("postgres://shogo:shogo_k8s_dev@postgres.shogo-system.svc.cluster.local:5432/shogo")
  }
}

# -----------------------------------------------------------------------------
# Apply k8s manifests
# -----------------------------------------------------------------------------
resource "null_resource" "apply_manifests" {
  depends_on = [
    kubernetes_namespace.shogo_system,
    kubernetes_config_map.shogo_config,
    kubernetes_secret.shogo_secrets,
    kubernetes_secret.api_secrets,
    kubernetes_secret.postgres_credentials,
  ]

  triggers = {
    # Re-apply when manifests change
    manifest_hash = sha256(join("", [
      file("${path.module}/../../../k8s/base/postgres.yaml"),
      file("${path.module}/../../../k8s/base/redis.yaml"),
      file("${path.module}/../../../k8s/base/minio.yaml"),
      file("${path.module}/../../../k8s/base/platform-mcp.yaml"),
      file("${path.module}/../../../k8s/base/api.yaml"),
      file("${path.module}/../../../k8s/base/web.yaml"),
    ]))
  }

  provisioner "local-exec" {
    command = <<-EOT
      cd ${path.module}/../../..
      
      # Apply infrastructure
      kubectl apply -f k8s/base/postgres.yaml
      kubectl apply -f k8s/base/redis.yaml
      kubectl apply -f k8s/base/minio.yaml
      
      # Wait for infrastructure
      kubectl wait --for=condition=Ready pod -l app=postgres -n shogo-system --timeout=120s || true
      kubectl wait --for=condition=Ready pod -l app=redis -n shogo-system --timeout=60s || true
      kubectl wait --for=condition=Ready pod -l app=minio -n shogo-system --timeout=60s || true
      
      # Apply application services (with k3d registry substitution)
      # Note: k3d pods use k3d-shogo-registry:PORT as the internal registry name
      sed 's|ghcr.io/shogo-ai/shogo-mcp|k3d-shogo-registry:${var.registry_port}/shogo-mcp|g' k8s/base/platform-mcp.yaml | kubectl apply -f -
      sed 's|k3d-shogo-registry:5000|k3d-shogo-registry:${var.registry_port}|g' k8s/base/api.yaml | kubectl apply -f -
      sed 's|k3d-shogo-registry:5000|k3d-shogo-registry:${var.registry_port}|g' k8s/base/web.yaml | kubectl apply -f -
    EOT
  }
}

# -----------------------------------------------------------------------------
# MinIO Initialization (create buckets)
# -----------------------------------------------------------------------------
resource "null_resource" "minio_init" {
  depends_on = [null_resource.apply_manifests]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for MinIO
      kubectl wait --for=condition=Ready pod -l app=minio -n shogo-system --timeout=120s
      
      # Create init job
      cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-init-$${RANDOM}
  namespace: shogo-system
spec:
  ttlSecondsAfterFinished: 60
  template:
    spec:
      containers:
        - name: mc
          image: minio/mc:latest
          imagePullPolicy: IfNotPresent
          command:
            - /bin/sh
            - -c
            - |
              mc alias set minio http://minio:9000 minioadmin minioadmin --api S3v4
              mc mb minio/shogo-schemas --ignore-existing
              mc mb minio/shogo-workspaces --ignore-existing
              echo "MinIO buckets created"
      restartPolicy: Never
  backoffLimit: 3
EOF
      
      # Wait for job
      sleep 5
      kubectl wait --for=condition=complete job -l job-name -n shogo-system --timeout=60s || true
    EOT
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "cluster_name" {
  value = var.cluster_name
}

output "kubectl_context" {
  value = "k3d-${var.cluster_name}"
}

output "registry_url" {
  value = "localhost:${var.registry_port}"
}

output "port_forward_commands" {
  value = <<-EOT
    # Run these commands to access services:
    kubectl -n shogo-system port-forward svc/shogo-web ${var.web_port}:80 &
    kubectl -n shogo-system port-forward svc/shogo-api ${var.api_port}:8002 &
    kubectl -n shogo-system port-forward svc/platform-mcp ${var.mcp_port}:3100 &
  EOT
}

output "service_urls" {
  value = {
    web = "http://localhost:${var.web_port}"
    api = "http://localhost:${var.api_port}"
    mcp = "http://localhost:${var.mcp_port}"
  }
}

output "set_anthropic_key" {
  value = "kubectl -n shogo-system patch secret api-secrets -p '{\"stringData\":{\"ANTHROPIC_API_KEY\":\"sk-ant-...\"}}''"
}
