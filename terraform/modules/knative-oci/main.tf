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

variable "manage_install" {
  description = "When true, run the Knative + Kourier install/patch null_resources. Set to false for environments where Knative was bootstrapped out-of-band and we don't want tf to re-run kubectl on every apply. The install is idempotent (kubectl apply), so flipping this back to true later is safe but will re-execute the full install sequence."
  type        = bool
  default     = true
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
  count = var.manage_install ? 1 : 0

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
  count      = var.manage_install ? 1 : 0
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

# Strips the upstream `node.kubernetes.io/disk-pressure:NoSchedule:Exists`
# toleration from the Kourier gateway. Upstream ships this toleration on the
# theory that it keeps the ingress available during disk pressure, but the
# kubelet auto-applies the disk-pressure taint specifically to keep pods OFF
# those nodes, so the tolerated gateway pod just lands on a doomed node and
# gets evicted within seconds. Staging accumulated ~9,959 Evicted gateway
# pods over ~13 days (zero Running replicas, complete ingress outage —
# Cloudflare 525 to all users) before this was caught.
#
# Why this is a separate `null_resource` from `null_resource.kourier`:
#
#   `null_resource.kourier`'s only `triggers` value is `knative_version`, so
#   its provisioner only re-runs when the Knative version is bumped. If we
#   inlined the patch there, any out-of-band reapply of the upstream
#   `kourier.yaml` (manual ops, drift, accidental `kubectl apply`) would
#   reintroduce the toleration and Terraform would not detect it until the
#   next Knative upgrade.
#
#   `triggers.always_run = timestamp()` forces this resource to re-run on
#   every `terraform apply`. The `kubectl patch` is idempotent (replacing
#   `tolerations` with `[]` is a no-op when it's already `[]`), so the cost
#   of running every time is negligible and the benefit is that drift is
#   continuously corrected. The trade-off is that `terraform plan` will
#   always show 1 pending change for this resource — that is intentional.
resource "null_resource" "kourier_toleration_strip" {
  count      = var.manage_install ? 1 : 0
  depends_on = [null_resource.kourier]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = <<-EOT
      kubectl patch deployment 3scale-kourier-gateway -n kourier-system \
        --type=json \
        -p='[{"op":"replace","path":"/spec/template/spec/tolerations","value":[]}]'
    EOT
  }
}

# -----------------------------------------------------------------------------
# Configure Kourier LoadBalancer with OCI Flexible Load Balancer
# OCI LB Controller provisions a public flexible LB from service annotations
# -----------------------------------------------------------------------------
resource "null_resource" "kourier_oci_lb" {
  count      = var.manage_install ? 1 : 0
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
  count      = var.manage_install ? 1 : 0
  depends_on = [null_resource.kourier]

  triggers = {
    scale_to_zero_grace_period = var.scale_to_zero_grace_period
    enable_pvc_support         = var.enable_pvc_support
    drain_timeout              = "30s"
    # Bump this whenever the inline kubectl patches below change. The
    # other triggers are typed inputs that don't move with patch-string
    # edits, which is why earlier additions to the config-features patch
    # (pvc / pv-write etc.) silently failed to re-apply on already-
    # provisioned clusters and left production drifting. Form is
    # `<YYYY-MM-DD>-<short-reason>`; only the value matters, not the
    # shape. See the post-2026-05-26 incident note in
    # docs/runbooks/deploy-prod.md for context.
    feature_flags_revision = "2026-05-26-init-containers"
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
      #
      # `kubernetes.podspec-init-containers` is required by the publish
      # flow's nginx + S3-sync pod (apps/api/src/lib/knative-project-
      # manager.ts createPublishedService). Without it, every Studio
      # Publish 400s at admission with `pod spec support for init-
      # containers is off, but found 1 init containers`.
      %{if var.enable_pvc_support}
      kubectl patch configmap/config-features \
        --namespace knative-serving \
        --type merge \
        --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled","kubernetes.podspec-affinity":"enabled","kubernetes.podspec-fieldref":"enabled","kubernetes.podspec-init-containers":"enabled"}}'
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
  count = var.manage_install && (var.domain != "" || var.publish_domain != "") ? 1 : 0

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
  count      = var.manage_install && var.relax_pdbs ? 1 : 0
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
# Kourier gateway capacity
# -----------------------------------------------------------------------------
# The gateway (Envoy) is on the request path for every API/studio request, and
# its memory grows with the number of Knative routes it holds. At the upstream
# 800Mi limit it was OOM-killed ~daily in prod-us (73 restarts in 78 days), and
# as a single replica each kill was a full-region 502 until it restarted.
#
# Every replica holds the full route table, so the memory limit is what stops
# the OOMs; the replica floor and PDB are what keep a single kill (or a node
# drain) from taking the region's ingress down.
#
# The 2026-10-22 incident (SHO-173) was the other half of the same failure. A
# distributed scanner sent 13k-41k req/min at dead `preview--<uuid>.shogo.ai`
# hosts for 10 minutes; Envoy got slow enough that its liveness probe (`/ready`,
# `timeoutSeconds: 1`) timed out, kubelet SIGKILLed the only gateway pod, and
# the region 502'd until it restarted — 6 times in a row. So this resource also
# owns the CPU sizing (200m request / 1 CPU limit starved a flooded Envoy), a
# probe deadline a busy-but-alive Envoy can still meet, and the node spread that
# keeps a second replica somewhere else.
#
# Unlike `knative_pdb_patches` this is NOT gated on `manage_install`: all live
# clusters run with manage_install = false, which is why those patches never
# reached prod. When `cluster_id` is set, kubectl is pointed at that cluster
# explicitly instead of trusting the operator's ambient KUBECONFIG.
variable "manage_ingress_capacity" {
  description = "Apply the Kourier gateway replica floor, CPU/memory sizing, liveness tolerance, node spread, and PDB (independent of manage_install)"
  type        = bool
  default     = true
}

variable "cluster_id" {
  description = "OKE cluster OCID that kubectl should target for ingress capacity patches. Empty = ambient KUBECONFIG."
  type        = string
  default     = ""
}

variable "region" {
  description = "OCI region of cluster_id (required when cluster_id is set)"
  type        = string
  default     = ""
}

variable "kourier_gateway_min_replicas" {
  description = "HPA minReplicas for 3scale-kourier-gateway"
  type        = number
  default     = 2
}

variable "kourier_gateway_memory_request" {
  description = "Memory request for the kourier-gateway container"
  type        = string
  default     = "512Mi"
}

variable "kourier_gateway_memory_limit" {
  description = "Memory limit for the kourier-gateway container"
  type        = string
  default     = "2Gi"
}

# 200m/1 was the upstream sizing. Under the 2026-10-22 scanner flood that left
# Envoy too little CPU to answer its own /ready probe, which is how a load spike
# turned into a SIGKILL. 500m request also raises the HPA's 100%-of-request
# target, so it scales on real load instead of immediately.
variable "kourier_gateway_cpu_request" {
  description = "CPU request for the kourier-gateway container"
  type        = string
  default     = "500m"
}

variable "kourier_gateway_cpu_limit" {
  description = "CPU limit for the kourier-gateway container"
  type        = string
  default     = "2"
}

# A deadline a busy-but-alive Envoy can still meet. At timeoutSeconds 1 a single
# probe that took 1.1s counted as a failure, and 3 in a row killed the pod.
variable "kourier_gateway_liveness_timeout_seconds" {
  description = "livenessProbe.timeoutSeconds for the kourier-gateway container"
  type        = number
  default     = 5
}

variable "kourier_gateway_liveness_failure_threshold" {
  description = "livenessProbe.failureThreshold for the kourier-gateway container"
  type        = number
  default     = 6
}

resource "null_resource" "kourier_gateway_capacity" {
  count = var.manage_ingress_capacity ? 1 : 0

  triggers = {
    cluster_id                 = var.cluster_id
    min_replicas               = var.kourier_gateway_min_replicas
    cpu_request                = var.kourier_gateway_cpu_request
    cpu_limit                  = var.kourier_gateway_cpu_limit
    memory_request             = var.kourier_gateway_memory_request
    memory_limit               = var.kourier_gateway_memory_limit
    liveness_timeout_seconds   = var.kourier_gateway_liveness_timeout_seconds
    liveness_failure_threshold = var.kourier_gateway_liveness_failure_threshold
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail

      %{if var.cluster_id != ""}
      export KUBECONFIG="$(mktemp)"
      trap 'rm -f "$KUBECONFIG"' EXIT
      oci ce cluster create-kubeconfig \
        --cluster-id ${var.cluster_id} \
        --region ${var.region} \
        --file "$KUBECONFIG" \
        --token-version 2.0.0 \
        --kube-endpoint PUBLIC_ENDPOINT >/dev/null
      %{endif}

      # Raise the floor before resizing so the resize rolls with a second
      # replica already serving.
      kubectl patch hpa 3scale-kourier-gateway -n kourier-system --type merge \
        -p '{"spec":{"minReplicas":${var.kourier_gateway_min_replicas}}}'
      current=$(kubectl get deployment 3scale-kourier-gateway -n kourier-system -o jsonpath='{.spec.replicas}')
      if [ "$current" -lt ${var.kourier_gateway_min_replicas} ]; then
        kubectl scale deployment 3scale-kourier-gateway -n kourier-system --replicas=${var.kourier_gateway_min_replicas}
      fi
      kubectl rollout status deployment/3scale-kourier-gateway -n kourier-system --timeout=300s

      # One strategic patch for sizing, liveness deadline and node spread, so a
      # change rolls the gateway once instead of once per field.
      #
      # - CPU 500m/2: at 200m/1 a flooded Envoy could not answer /ready inside a
      #   second and was killed for it. Memory stays 512Mi/2Gi (the route table
      #   is per replica; the limit is what stopped the OOM kills).
      # - livenessProbe timeoutSeconds 5 / failureThreshold 6: the pod is only
      #   killed when six probes in a row get no answer, not when one probe is
      #   slower than a second. Readiness still gates traffic, so a wedged Envoy
      #   is pulled out of rotation instead of killed mid-flood.
      # - podAntiAffinity preferred (NOT required) on kubernetes.io/hostname: a
      #   hard rule would leave replicas Pending whenever the pool has fewer free
      #   nodes than the HPA wants (max 10) and would strand the second pod
      #   through a node drain — i.e. it would recreate the single-pod region
      #   this resource exists to prevent. Weight 100 makes an empty node always
      #   beat one already running a gateway, so 2/2 on distinct nodes is the
      #   scheduler's choice by rule, not by luck.
      kubectl patch deployment 3scale-kourier-gateway -n kourier-system --type strategic \
        -p '{"spec":{"template":{"spec":{
          "affinity":{"podAntiAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"podAffinityTerm":{"topologyKey":"kubernetes.io/hostname","labelSelector":{"matchLabels":{"app":"3scale-kourier-gateway"}}}}]}},
          "containers":[{"name":"kourier-gateway",
            "resources":{"requests":{"cpu":"${var.kourier_gateway_cpu_request}","memory":"${var.kourier_gateway_memory_request}"},"limits":{"cpu":"${var.kourier_gateway_cpu_limit}","memory":"${var.kourier_gateway_memory_limit}"}},
            "livenessProbe":{"timeoutSeconds":${var.kourier_gateway_liveness_timeout_seconds},"failureThreshold":${var.kourier_gateway_liveness_failure_threshold}}}]
        }}}}'
      kubectl rollout status deployment/3scale-kourier-gateway -n kourier-system --timeout=300s

      kubectl apply -f - <<'YAML'
      apiVersion: policy/v1
      kind: PodDisruptionBudget
      metadata:
        name: 3scale-kourier-gateway-pdb
        namespace: kourier-system
      spec:
        maxUnavailable: 1
        selector:
          matchLabels:
            app: 3scale-kourier-gateway
      YAML
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
