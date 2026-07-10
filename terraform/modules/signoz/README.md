# SigNoz K8s Infrastructure Monitoring Module

This module deploys the SigNoz K8s Infra Helm chart for comprehensive Kubernetes cluster observability.

## Logs: stdout scraping is the authoritative path ("Option B")

Logs reach SigNoz via the **`k8s-infra` `otelAgent` DaemonSet** (`enableLogs =
true`), which tails every pod's stdout/stderr independently of the app process.
This is the only reliable path: the app-level OTLP log export proved unreliable
under Bun event-loop pressure — batches were silently dropped when the
wall-clock export deadline elapsed, which is what made `[MetalPool]` /
`[metal-fleet]` logs vanish from SigNoz. The app therefore **does not export
logs over OTLP** (traces and metrics still do).

Trace correlation is preserved without depending on that export:

1. **Structured, trace-stamped stdout (app side).** In prod/staging the API
   writes each `console.*` line as a structured JSON record carrying the active
   `trace_id`/`span_id` (`apps/api/src/lib/structured-console.ts`, installed from
   `apps/api/src/instrumentation.ts`; toggle with `OTEL_LOGS_CONSOLE_BRIDGE`).
   Runtime services get the same via `createLogger` (`@shogo-ai/core/logger`),
   whose entries are stamped by a trace-context provider registered in
   `packages/core/src/instrumentation.ts`. The trace context comes from the
   in-process active span and is valid even when the trace *export* is dropped,
   so logs are always groupable by request.
2. **Log pipeline (SigNoz side).** The `pipelines/api-trace-correlation.yaml`
   pipeline JSON-parses the stdout line and promotes `trace_id`/`span_id`,
   severity, and the human message into first-class log fields — giving
   clickable log↔trace links. Applied manually (see below), it is
   chart-version-independent.

The `[Publish]` string-based alerts/dashboards continue to work: the substring
still lives in the log body (inside `msg`, and after the pipeline runs, as the
body itself).

### Bare-metal fleet (outside k8s)

The metal Firecracker hosts run outside Kubernetes, so the k8s-infra DaemonSet
can't scrape them. The dependency-free `metal-agent` logs to journald, and a
host-local `otelcol-contrib` (`otelcol-metal.service`, installed by
`scripts/metal-agent/host-bootstrap.sh`) tails that journal and ships it to this
same SigNoz endpoint over OTLP/HTTP — the bare-metal analogue of the DaemonSet.
Logs land as `service.name=metal-agent` / `service.namespace=metal-fleet`,
tagged with `metal.host.id` and `metal.region`. It's gated on
`OTEL_EXPORTER_OTLP_ENDPOINT` (+ `SIGNOZ_INGESTION_KEY`) being present in
`/etc/metal-agent.env`; burst hosts receive those from cloud-init automatically
(`apps/api/src/lib/metal-cloud-init.ts`). See `docs/runbooks/metal-fleet.md`.

## Alerts and dashboards (manual sync)

The Terraform module deploys the **collector** only — alert rules and
dashboards are content that lives in SigNoz, not in the Helm chart, so
they're managed separately as YAML/JSON files under this directory:

- `alerts/publish-failure-rate.yaml` — pages on-call when publish
  failures sustain >1/min for 5 minutes.
- `alerts/prod-node-count-low.yaml` — pages when prod-us drops below
  the terraform-declared `system_pool_min`.
- `alerts/warm-pool-starvation.yaml` — pages when warm-pool depth
  stays below 3 for 10+ minutes (every new project hitting cold start).
- `alerts/metal-fc-process-leak.yaml` — pages when a metal host carries
  20+ firecracker processes beyond its tracked warm+assigned VMs for
  10+ minutes (the churn process-leak fingerprint; 2026-07 incident).
- `alerts/metal-wake-latency-high.yaml` — warns when metal wake p95
  exceeds 15s for 10+ minutes (sleep/wake degraded to cold-start feel).
- `alerts/metal-host-disk-pressure.yaml` — warns when a metal host's
  NVMe cache stays above 85% for 10+ minutes (GC not keeping up; wakes
  degrade to slower S3 pulls).
- `alerts/metal-no-host-fallback.yaml` — pages when metal routing finds
  no live host (5+ fallbacks in 5m: fleet down, mesh broken, or all
  cordoned; slow Knative fallback, or 503s in metal-only).
- `alerts/log-agent-down.yaml` — pages when the `otelAgent` DaemonSet has
  zero ready pods for 15+ minutes (logs silently stop reaching SigNoz).
  Catches the 2026-07 staging drift where the agent was parked via an
  out-of-band `nodeSelector` while the app-level OTLP export was also
  failing, so all API logs vanished with nothing to signal it.
- `pipelines/api-trace-correlation.yaml` — logs pipeline that parses the
  API/runtime structured JSON stdout and promotes `trace_id`/`span_id`,
  severity, and the human message into first-class log fields (clickable
  log↔trace links) without relying on the app's OTLP log export.
- `dashboards/publish-funnel.json` — per-step counters for the publish
  pipeline so we can spot exactly where publishes are dying.
- `dashboards/metal-fleet.json` — live fleet state + health: per-host
  warm/assigned/suspended, FC-process leak guard, utilization, NVMe
  used%, wake-latency quantiles, assignment source mix, hit-rate, and
  host-error/no-host rates. Feeds off the `metal.*` OTel series from the
  API plus the per-host gauges folded from each agent heartbeat.

To apply, either import via the SigNoz UI (`Alert Rules` /
`Dashboards` → `Import`, or `Logs` → `Pipelines` → `New Pipeline` for
the pipeline) or POST the file body to `POST /api/v1/rules` /
`POST /api/v1/dashboards` / `POST /api/v1/logs/pipelines`. Re-run after
every change to a YAML/JSON file in this directory.

These were introduced in the post-2026-05-20 publish-pipeline-hardening
PR; see `docs/runbooks/deploy-prod.md` for triage steps each one
points to.

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
