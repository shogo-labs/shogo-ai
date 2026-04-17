# =============================================================================
# Knative Serving Module (OCI)
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
# Configure Kourier LoadBalancer with OCI Flexible Load Balancer
# OCI LB Controller provisions a public flexible LB from service annotations
# -----------------------------------------------------------------------------
resource "null_resource" "kourier_oci_lb" {
  depends_on = [null_resource.kourier]

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for Kourier service to be created
      kubectl wait --for=condition=available deployment/3scale-kourier-gateway -n kourier-system --timeout=300s || sleep 30

      # Patch Kourier service to use OCI Flexible Load Balancer
      kubectl annotate service/kourier -n kourier-system --overwrite \
        service.beta.kubernetes.io/oci-load-balancer-shape="flexible" \
        service.beta.kubernetes.io/oci-load-balancer-shape-flex-min="10" \
        service.beta.kubernetes.io/oci-load-balancer-shape-flex-max="100" \
        service.beta.kubernetes.io/oci-load-balancer-internal="false"

      # Ensure service type is LoadBalancer
      kubectl patch service/kourier -n kourier-system -p '{"spec":{"type":"LoadBalancer"}}'

      # Wait for the load balancer to be provisioned
      echo "Waiting for OCI load balancer to be provisioned..."
      sleep 60

      # Get the load balancer IP (OCI uses IP, not hostname)
      LB_IP=$(kubectl get svc kourier -n kourier-system -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
      echo "Kourier LoadBalancer IP: $LB_IP"
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Knative via kubectl (ConfigMaps)
# -----------------------------------------------------------------------------
variable "enable_pvc_support" {
  description = "Enable PVC support for Knative services (requires feature flags)"
  type        = bool
  default     = true
}

resource "null_resource" "knative_config" {
  depends_on = [null_resource.kourier]

  triggers = {
    scale_to_zero_grace_period = var.scale_to_zero_grace_period
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

      # Enable PVC support and scheduling feature flags
      # See: https://knative.dev/docs/serving/configuration/feature-flags/
      %{if var.enable_pvc_support}
      kubectl patch configmap/config-features \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled","kubernetes.podspec-affinity":"enabled","kubernetes.podspec-fieldref":"enabled"}}'
      %{endif}

      # Enable HTTPS on Kourier (port 8443) using the kourier-tls secret.
      # Cloudflare connects to origin on 443 -> OCI LB -> Kourier 8443 (TLS).
      # drain-time-seconds lets Envoy drain in-flight connections before closing
      # during pod lifecycle changes, preventing status-0 / connection-dropped errors.
      kubectl apply -f - <<'YAML'
      apiVersion: v1
      kind: ConfigMap
      metadata:
        name: config-kourier
        namespace: knative-serving
      data:
        enable-service-access-logging: "true"
        drain-time-seconds: "15"
      YAML

      # Aggressive revision GC to prevent stale pods/images from accumulating.
      # Keep at most 2 inactive revisions per service, GC after 30m idle.
      kubectl patch configmap/config-gc \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"max-non-active-revisions":"2","retain-since-create-time":"48h","retain-since-last-active-time":"30m","min-non-active-revisions":"1"}}'
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
# Switch to maxUnavailable: 1 so node drains can proceed.
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

      # Configure Kourier external TLS so Envoy terminates HTTPS on port 8443.
      # The kourier-tls secret (Cloudflare origin cert) must exist in kourier-system.
      # These env vars tell net-kourier-controller where to find the TLS cert.
      kubectl set env deployment/net-kourier-controller -n knative-serving \
        CERTS_SECRET_NAMESPACE=kourier-system \
        CERTS_SECRET_NAME=kourier-tls || true
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
