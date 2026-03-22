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
  description = "Knative Serving version (latest: 1.20.0 as of Jan 2026)"
  type        = string
  default     = "1.20.0"
}

variable "domain" {
  description = "Primary domain for Knative services (e.g., shogo.ai)"
  type        = string
  default     = ""
}

variable "publish_domain" {
  description = "Domain for published apps (e.g., shogo.one)"
  type        = string
  default     = ""
}

variable "scale_to_zero_grace_period" {
  description = "Grace period before scaling to zero"
  type        = string
  default     = "60s"
}

variable "ssl_certificate_arn" {
  description = "Primary ACM certificate ARN for HTTPS termination (e.g., *.shogo.ai)"
  type        = string
  default     = ""
}

variable "ssl_certificate_arn_publish" {
  description = "Secondary ACM certificate ARN for published apps (e.g., *.shogo.one)"
  type        = string
  default     = ""
}

variable "ssl_certificate_arn_preview" {
  description = "Tertiary ACM certificate ARN for preview subdomains (e.g., *.staging.shogo.ai)"
  type        = string
  default     = ""
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
# Configure Kourier LoadBalancer with SSL Certificates via ALB
# Uses AWS Load Balancer Controller for ALB with SNI multi-certificate support
# -----------------------------------------------------------------------------
locals {
  # Combine certificate ARNs if provided (comma-separated for ALB SNI)
  # Supports: primary (*.shogo.ai), publish (*.shogo.one), preview (*.staging.shogo.ai)
  ssl_certs           = compact([var.ssl_certificate_arn, var.ssl_certificate_arn_publish, var.ssl_certificate_arn_preview])
  ssl_cert_annotation = join(",", local.ssl_certs)
  has_ssl             = length(local.ssl_certs) > 0
}

# Configure Kourier to use AWS Load Balancer Controller with ALB
# ALB is used instead of NLB because it:
# 1. Properly sets X-Forwarded-Proto headers for HTTPS detection
# 2. Supports native HTTP to HTTPS redirect rules
# 3. Supports SNI with multiple SSL certificates
resource "null_resource" "kourier_alb" {
  count      = local.has_ssl ? 1 : 0
  depends_on = [null_resource.kourier]

  triggers = {
    ssl_certificate_arn         = var.ssl_certificate_arn
    ssl_certificate_arn_publish = var.ssl_certificate_arn_publish
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for Kourier service to be created
      kubectl wait --for=condition=available deployment/3scale-kourier-gateway -n kourier-system --timeout=300s || sleep 30

      # Patch Kourier service to use AWS Load Balancer Controller with ALB
      # ALB provides proper X-Forwarded-Proto headers and HTTP->HTTPS redirect support
      kubectl annotate service/kourier -n kourier-system --overwrite \
        service.beta.kubernetes.io/aws-load-balancer-type="external" \
        service.beta.kubernetes.io/aws-load-balancer-nlb-target-type="ip" \
        service.beta.kubernetes.io/aws-load-balancer-scheme="internet-facing" \
        service.beta.kubernetes.io/aws-load-balancer-ssl-cert="${local.ssl_cert_annotation}" \
        service.beta.kubernetes.io/aws-load-balancer-ssl-ports="443" \
        service.beta.kubernetes.io/aws-load-balancer-ssl-negotiation-policy="ELBSecurityPolicy-TLS13-1-2-2021-06" \
        service.beta.kubernetes.io/aws-load-balancer-backend-protocol="tcp"

      # NLB terminates TLS, so backend must receive plain HTTP on 8080 (not 8443 which expects TLS)
      kubectl patch service/kourier -n kourier-system --type='json' \
        -p='[{"op":"replace","path":"/spec/ports/1/targetPort","value":8080}]'

      # Force service recreation to pick up new load balancer type
      kubectl patch service/kourier -n kourier-system -p '{"spec":{"type":"LoadBalancer"}}'

      # Wait for the load balancer to be provisioned
      echo "Waiting for load balancer to be provisioned..."
      sleep 60

      # Get the load balancer hostname
      LB_HOSTNAME=$(kubectl get svc kourier -n kourier-system -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
      echo "Kourier LoadBalancer hostname: $LB_HOSTNAME"

      echo "SSL certificates attached to Kourier LoadBalancer"
      echo "Certificates: ${local.ssl_cert_annotation}"
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Knative via kubectl (ConfigMaps)
# -----------------------------------------------------------------------------
variable "ecr_registry" {
  description = "ECR registry URL to skip tag resolution for. Required because the Knative controller lacks ECR auth to resolve tags to digests. The deploy workflow compensates by always using immutable SHA-based image tags."
  type        = string
  default     = ""
}

variable "enable_pvc_support" {
  description = "Enable PVC support for Knative services (requires feature flags)"
  type        = bool
  default     = true
}

resource "null_resource" "knative_config" {
  depends_on = [null_resource.kourier]

  triggers = {
    scale_to_zero_grace_period = var.scale_to_zero_grace_period
    ecr_registry               = var.ecr_registry
    enable_pvc_support         = var.enable_pvc_support
    drain_timeout              = "30s"
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for ConfigMaps to exist
      sleep 30
      
      # Configure Kourier as ingress + drain timeout for graceful deploys
      kubectl patch configmap/config-network \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev","drain-timeout":"30s"}}'
      
      # Configure scale-to-zero
      kubectl patch configmap/config-autoscaler \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"enable-scale-to-zero":"true","scale-to-zero-grace-period":"${var.scale_to_zero_grace_period}","scale-to-zero-pod-retention-period":"0s"}}'
      
      # Skip tag-to-digest resolution for ECR (controller lacks ECR auth).
      # IMPORTANT: Because of this, mutable tags like "staging-latest" will use
      # the node's cached image (imagePullPolicy: IfNotPresent). The deploy
      # workflow must always set SHA-specific immutable tags via kubectl patch.
      %{if var.ecr_registry != ""}
      kubectl patch configmap/config-deployment \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"registries-skipping-tag-resolving":"kind.local,ko.local,dev.local,${var.ecr_registry}"}}'
      %{endif}

      # Enable PVC support and scheduling feature flags
      # See: https://knative.dev/docs/serving/configuration/feature-flags/
      %{if var.enable_pvc_support}
      kubectl patch configmap/config-features \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled","kubernetes.podspec-affinity":"enabled","kubernetes.podspec-fieldref":"enabled"}}'
      %{endif}
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Domains (optional)
# Configures both platform domain (shogo.ai) and publish domain (shogo.one)
# -----------------------------------------------------------------------------
resource "null_resource" "knative_domain" {
  count = var.domain != "" || var.publish_domain != "" ? 1 : 0

  depends_on = [null_resource.knative_config]

  triggers = {
    domain         = var.domain
    publish_domain = var.publish_domain
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Configure primary domain
      %{if var.domain != ""}
      kubectl patch configmap/config-domain \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"${var.domain}":""}}'
      %{endif}

      # Configure publish domain (for user-published apps)
      %{if var.publish_domain != ""}
      kubectl patch configmap/config-domain \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"${var.publish_domain}":""}}'
      %{endif}
    EOT
  }
}

# -----------------------------------------------------------------------------
# Relax PDBs for single-replica deployments
# -----------------------------------------------------------------------------
# Upstream Knative PDBs use minAvailable: 80% which blocks all disruption
# when running single replicas (ceil(0.8 * 1) = 1, so 0 allowed disruptions).
# Switch to maxUnavailable: 1 so Karpenter and node drains can proceed.
variable "relax_pdbs" {
  description = "Patch upstream Knative PDBs to allow disruption of single-replica components"
  type        = bool
  default     = true
}

resource "null_resource" "knative_pdb_patches" {
  count      = var.relax_pdbs ? 1 : 0
  depends_on = [null_resource.kourier]

  triggers = {
    knative_version = var.knative_version
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Scale traffic-critical components to 2 replicas so that
      # maxUnavailable:1 always keeps one pod serving during node drains.
      # Activator has an HPA — patch minReplicas instead of scaling directly.
      kubectl patch hpa activator -n knative-serving --type merge \
        -p '{"spec":{"minReplicas":2}}' || true
      kubectl scale deployment 3scale-kourier-gateway -n kourier-system --replicas=2 || true

      # Relax PDBs from minAvailable:80% to maxUnavailable:1.
      # With 2 replicas this guarantees 1 stays up; with 1 replica it
      # still allows the drain to proceed (non-critical components).
      kubectl patch pdb activator-pdb -n knative-serving --type merge \
        -p '{"spec":{"minAvailable":null,"maxUnavailable":1}}' || true
      kubectl patch pdb webhook-pdb -n knative-serving --type merge \
        -p '{"spec":{"minAvailable":null,"maxUnavailable":1}}' || true
      kubectl patch pdb 3scale-kourier-gateway-pdb -n kourier-system --type merge \
        -p '{"spec":{"minAvailable":null,"maxUnavailable":1}}' || true

      # Scale net-kourier-controller resources for large service counts.
      # Each Knative service creates an ingress route; at 1000+ services the
      # default 500Mi/1 CPU is insufficient and causes OOMKills or liveness failures.
      kubectl set resources -n knative-serving deployment/net-kourier-controller \
        -c controller \
        --limits=cpu=2,memory=2Gi \
        --requests=cpu=500m,memory=512Mi || true

      # Increase liveness probe tolerance so the controller can prime all
      # ingresses before being killed (default 6 failures * 10s = 60s is
      # too short for 1000+ ingresses).
      kubectl patch deployment net-kourier-controller -n knative-serving --type=json \
        -p='[{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/failureThreshold","value":30},{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds","value":30}]' || true
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
