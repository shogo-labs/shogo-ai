# SigNoz K8s Infrastructure Monitoring Module

This module deploys the SigNoz K8s Infra Helm chart for comprehensive Kubernetes cluster observability.

## What It Monitors

### Node-Level Metrics
- CPU usage, load average
- Memory usage and pressure
- Disk I/O and space
- Network throughput
- Filesystem metrics

### Pod-Level Metrics
- Resource requests and limits
- Actual CPU/memory usage
- Container restarts
- Pod phase and conditions

### Cluster-Level
- Kubernetes events
- API server metrics
- Control plane health
- Deployment/StatefulSet status

### Logs
- Container logs from all pods
- Structured log collection
- Filtered by namespace

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Each Node                                               │
│  ├── otelAgent DaemonSet (collects node + pod metrics)  │
│  │   ├── Host metrics receiver                          │
│  │   ├── Kubelet metrics (cAdvisor)                     │
│  │   └── Container log collector                        │
│  └── Sends to: SigNoz OTLP Endpoint                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Cluster                                                 │
│  ├── otelDeployment (cluster-level metrics)             │
│  │   ├── K8s cluster receiver                           │
│  │   ├── K8s events receiver                            │
│  │   └── Sends to: SigNoz OTLP Endpoint                 │
└─────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **SigNoz Backend**: Must be deployed first
   - SigNoz OTLP collector endpoint accessible from cluster
   - Can be in-cluster or external (SigNoz Cloud)

2. **Cluster Requirements**:
   - Kubernetes 1.21+
   - Helm 3.8+
   - Nodes with kubelet metrics enabled (default)

## Usage

### Basic (SigNoz Cloud)

```hcl
module "signoz" {
  source = "../../modules/signoz"

  cluster_name         = "example-staging"
  signoz_endpoint      = "ingest.us.signoz.cloud:443"
  signoz_ingestion_key = "your-ingestion-key-here"  # Required for SigNoz Cloud
  environment          = "staging"
}
```

### In-Cluster SigNoz

```hcl
module "signoz" {
  source = "../../modules/signoz"

  cluster_name    = "example-staging"
  signoz_endpoint = "http://signoz-otel-collector.signoz.svc.cluster.local:4317"
  environment     = "staging"

  # Custom namespace
  namespace        = "observability"
  create_namespace = true
}
```

### Production (Higher Resources)

```hcl
module "signoz" {
  source = "../../modules/signoz"

  cluster_name    = "example-production"
  signoz_endpoint = "http://signoz-otel-collector.signoz.svc.cluster.local:4317"
  environment     = "production"

  # Higher resource limits for production load
  resource_limits = {
    cpu    = "1000m"
    memory = "1Gi"
  }

  resource_requests = {
    cpu    = "200m"
    memory = "256Mi"
  }

  tags = {
    Team       = "platform"
    CostCenter = "engineering"
  }
}
```

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| cluster_name | Kubernetes cluster name | string | - | yes |
| signoz_endpoint | SigNoz OTLP endpoint (gRPC) | string | - | yes |
| signoz_ingestion_key | SigNoz Cloud ingestion key (required for Cloud) | string | "" | no |
| namespace | Namespace for SigNoz components | string | "signoz" | no |
| create_namespace | Create namespace | bool | true | no |
| environment | Environment name | string | "staging" | no |
| enable_logs | Enable log collection | bool | true | no |
| enable_events | Enable event collection | bool | true | no |
| enable_metrics | Enable metrics collection | bool | true | no |
| chart_version | SigNoz K8s Infra chart version | string | "0.98.5" | no |
| resource_limits | Resource limits | object | See below | no |
| resource_requests | Resource requests | object | See below | no |

**Default resource_limits:**
```hcl
{
  cpu    = "500m"
  memory = "512Mi"
}
```

**Default resource_requests:**
```hcl
{
  cpu    = "100m"
  memory = "128Mi"
}
```

## Outputs

| Name | Description |
|------|-------------|
| namespace | Namespace where SigNoz is deployed |
| chart_version | Deployed chart version |
| release_name | Helm release name |
| release_status | Helm release status |

## What You'll See in SigNoz

After deployment, you'll have access to:

### Dashboards
- **K8s Node Metrics**: CPU, memory, disk, network per node
- **K8s Pod Metrics**: Resource usage per pod/container
- **K8s Cluster Overview**: Deployments, StatefulSets, nodes status
- **K8s Events**: Recent cluster events with severity

### Logs
- All container logs with metadata:
  - Namespace, pod name, container name
  - Node name, labels
  - Structured fields (if JSON logs)

### Traces (if apps instrumented)
- Service-to-service communication
- Database queries
- External API calls

## Verification

After deployment, verify the collectors are running:

```bash
# Check DaemonSet (should have 1 pod per node)
kubectl get daemonset -n signoz

# Check Deployment
kubectl get deployment -n signoz

# Check logs
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra --tail=50

# Verify metrics are being sent
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra | grep "Exporting"
```

## Cost

Typical resource usage per cluster:

| Component | Pods | CPU | Memory | Total/Month |
|-----------|------|-----|--------|-------------|
| DaemonSet (3 nodes) | 3 | 300m | 384Mi | ~$15 |
| Deployment | 1 | 100m | 128Mi | ~$5 |
| **Total** | 4 | 400m | 512Mi | **~$20** |

Note: Actual cost depends on node count and data volume.

## Troubleshooting

### Collectors not starting

```bash
# Check events
kubectl get events -n signoz --sort-by='.lastTimestamp'

# Check pod status
kubectl describe pod -n signoz -l app.kubernetes.io/name=k8s-infra
```

### No metrics in SigNoz

1. Verify endpoint is correct:
   ```bash
   kubectl get cm -n signoz signoz-k8s-infra-otel-agent -o yaml | grep endpoint
   ```

2. Test connectivity from pod:
   ```bash
   kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
     curl -v http://signoz-otel-collector.signoz.svc.cluster.local:4317
   ```

3. Check collector logs for errors:
   ```bash
   kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra | grep -i error
   ```

### High resource usage

Reduce collection frequency or disable features:

```hcl
module "signoz" {
  # ... other config

  enable_logs = false  # Disable logs if too verbose

  # Lower resource limits
  resource_limits = {
    cpu    = "250m"
    memory = "256Mi"
  }
}
```

## References

- [SigNoz K8s Infra Documentation](https://signoz.io/docs/opentelemetry-collection-agents/k8s/k8s-infra/)
- [Helm Chart Repository](https://github.com/SigNoz/charts/tree/main/charts/k8s-infra)
- [OpenTelemetry Kubernetes Receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/k8sclusterreceiver)
