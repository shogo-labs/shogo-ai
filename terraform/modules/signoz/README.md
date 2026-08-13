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

- `alerts/publish-failure-rate.yaml` — pages on-call on 3+ fatal
  (error-level) publish failures within 5 minutes.
- `alerts/prod-node-count-low.yaml` — pages when prod-us has fewer ready
  nodes than the terraform-declared `system_pool_min`.
- `alerts/warm-pool-starvation.yaml` — pages when warm-pool depth
  stays below 3 for 10+ minutes (every new project hitting cold start).
- `alerts/metal-fc-process-leak.yaml` — pages when a metal host carries
  20+ firecracker processes beyond its tracked warm+assigned VMs for
  10+ minutes (the churn process-leak fingerprint; 2026-07 incident).
- `alerts/metal-tap-leak.yaml` — warns when a metal host sustains 250+ tap
  devices beyond its warm+assigned+suspended VMs, i.e. leaked /30 blocks are
  outrunning the node-agent GC (2026-07 US-region outage).
- `alerts/metal-tap-exhaustion.yaml` — pages when a metal host passes 80% of
  its 16384 /30 blocks for any reason, leak or legitimate cache growth. At
  100% the host cannot start a microVM and every /assign there fails.
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

### Applying alerts

```bash
export SIGNOZ_URL=https://<workspace>.us.signoz.cloud
export SIGNOZ_API_KEY=...            # an API key, NOT the ingestion key
bun run scripts/signoz-apply-alerts.ts             # dry run: create/update plan
bun run scripts/signoz-apply-alerts.ts --validate   # server-check every file
bun run scripts/signoz-apply-alerts.ts --apply
```

The script matches on alert name, so re-running updates in place. Dashboards and
the log pipeline are still manual (`Dashboards` → `Import`, `Logs` → `Pipelines`
→ `New Pipeline`, or `POST /api/v1/dashboards` / `POST /api/v1/logs/pipelines`).

`--validate` POSTs each rule with its channels stripped, which SigNoz rejects
after validating everything else, so it type-checks the whole directory against
the live API without creating anything. Run it after editing any file here.

### None of these alerts had ever been applied

A `GET /api/v2/rules` on the production workspace returned **zero rules**:
Terraform never reads this directory, so every file here was documentation, and
"import it by hand" is what let all twelve rot unnoticed. They were rewritten in
2026-08 against the live v0.137 API; each query below was checked with
`/api/v5/query_range` before being wired up. The traps, if you add or edit one:

- **Metric names keep their dots.** SigNoz stores OTel names verbatim:
  `metal.host.fc_procs`, not `metal_host_fc_procs`. The underscored names these
  files used had never matched a series.
- **PromQL cannot read these metrics on this version at all** — not even
  `{__name__="metal.host.fc_procs"}`. Use `queryType: builder` with the dotted
  name; multi-series math goes in a `builder_formula` query.
- **There is no kube-state-metrics on these clusters**, only the OTel k8s-infra
  collector, so `kube_pod_status_phase`, `kube_node_info`,
  `kube_daemonset_status_number_ready` and `kube_cronjob_status_last_successful_time`
  do not exist. Five alerts were querying them. Use the `k8s.*` series the
  collector does emit (`k8s.daemonset.ready_nodes`, `k8s.node.condition_ready`),
  or better, the app's own gauge — `WarmPoolStarvation` now reads
  `warm_pool.available` instead of joining two kube-state series.
- **Job/CronJob freshness has no metric.** `k8s.job.successful_pods` keeps
  reporting `1` for as long as a completed Job is retained, so it stays green
  after a CronJob stops running. `ReplicationMonitorFailing` and
  `ConflictWatchdogFailing` therefore count each script's own success marker in
  the logs; see those files for why the watchdog needs two markers.
- **Use `POST /api/v2/rules` with `schemaVersion: v2alpha1`** (SigNoz ≥ v0.133):
  a `queries` **array** of `{type, spec}` envelopes rather than a `builderQueries`
  map, `thresholds`/`evaluation` as `kind` + `spec` envelopes, durations with
  units (`60s`, not `60`), and a required `notificationSettings`. `thresholds`
  and `selectedQueryName` sit on `condition`, NOT inside `compositeQuery`.
  `matchType` is one of `at_least_once`/`all_the_times`/`on_average`/`in_total`/
  `last`, and `op` one of `above`/`below`/`equal`/`not_equal`/`above_or_equal`/
  `below_or_equal`. Unknown fields are silently ignored, so a typo'd key is
  dropped rather than reported — `--validate` won't catch that.
- **A "below" threshold never fires on a series that disappears.** For anything
  where "stopped reporting" is the failure (the log agent being deleted, a
  region's CronJob not running), set `alertOnAbsent: true` and `absentFor: <minutes>`
  on `condition`.
- **Every threshold needs a real notification channel.** An empty `channels` list
  fails with "at least one channel is required", and the name must match a
  channel configured under `Settings` → `Alert Channels` — so an alert cannot be
  created before its destination exists. **This workspace currently has no
  channels at all**, which is the one thing still standing between these files
  and live alerts; the applier checks it up front and names what's missing. The
  files all reference `platform-oncall`.

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
