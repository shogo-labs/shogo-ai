# Quick Start: Deploy SigNoz to Staging

This guide will get SigNoz monitoring running in your staging cluster in ~5 minutes.

## Your SigNoz Cloud Configuration

You already have a SigNoz Cloud account with:
- **Ingestion URL**: `https://ingest.us.signoz.cloud`
- **Ingestion Key**: `xLFY6djeWtEqZt1eGrYTwKkKeR5kCua-VB1w`

## Step 1: Configure Terraform

Add these lines to your `terraform.tfvars` file:

```hcl
# SigNoz Configuration
enable_signoz        = true
signoz_endpoint      = "ingest.us.signoz.cloud:443"
signoz_ingestion_key = "xLFY6djeWtEqZt1eGrYTwKkKeR5kCua-VB1w"
```

Or use the pre-configured file:

```bash
cd terraform/environments/staging

# Copy your SigNoz config into terraform.tfvars
cat terraform.tfvars.signoz >> terraform.tfvars
```

## Step 2: Deploy

```bash
# Initialize Terraform (if not already done)
terraform init

# Review what will be created
terraform plan

# Deploy SigNoz collectors
terraform apply
```

## Step 3: Verify

```bash
# Check that SigNoz pods are running
kubectl get pods -n signoz

# Expected output:
# NAME                                           READY   STATUS    RESTARTS   AGE
# signoz-k8s-infra-otel-agent-xxxxx             1/1     Running   0          2m
# signoz-k8s-infra-otel-agent-yyyyy             1/1     Running   0          2m
# signoz-k8s-infra-otel-deployment-zzz          1/1     Running   0          2m

# Check logs to verify data is being sent
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra --tail=50 | grep "Exporting"
```

## Step 4: View Data in SigNoz Cloud

1. Go to https://signoz.io/teams/
2. Log in with your credentials
3. Navigate to **Dashboards**
4. You should see:
   - **K8s Node Metrics** - CPU, memory, disk per node
   - **K8s Pod Metrics** - Resource usage per pod
   - **K8s Cluster Overview** - Cluster health

Data should appear within 1-2 minutes of deployment.

## What's Monitored

With the default configuration (logs disabled):

✅ **Node Metrics**:
- CPU usage, load average
- Memory usage
- Disk I/O and space
- Network throughput

✅ **Pod Metrics**:
- CPU/memory per pod
- Container restarts
- Resource requests vs actual

✅ **Kubernetes Events**:
- Pod crashes
- Scheduling issues
- Volume mount failures
- Image pull errors

❌ **Container Logs**: Disabled by default to save costs

## Cost

With logs disabled: **~$12/month** (250m CPU, 320Mi memory)

## Enable Logs (Optional)

If you need container logs for debugging:

```bash
# Quick enable (no Terraform apply needed)
helm upgrade signoz-k8s-infra signoz/k8s-infra \
  --namespace signoz \
  --reuse-values \
  --set enableLogs=true

# Or permanently via Terraform:
# Add to terraform.tfvars:
signoz_enable_logs = true

# Then apply:
terraform apply
```

This adds ~$8/month in costs.

## Troubleshooting

### No pods appearing

Check namespace:
```bash
kubectl get pods -n signoz
kubectl describe pods -n signoz
```

### No data in SigNoz Cloud

1. Verify endpoint and key in ConfigMap:
```bash
kubectl get cm -n signoz -o yaml | grep -A 5 endpoint
```

2. Check collector logs for errors:
```bash
kubectl logs -n signoz -l app.kubernetes.io/name=k8s-infra --all-containers=true
```

Look for:
- `connection refused` - Wrong endpoint
- `unauthorized` - Wrong ingestion key
- `timeout` - Network issue

### Still having issues?

See the detailed troubleshooting guide: [SIGNOZ_SETUP.md](./SIGNOZ_SETUP.md#troubleshooting)

## Next Steps

1. **Set up Alerts**:
   - Go to SigNoz Cloud > Alerts
   - Create alerts for high CPU, memory, pod restarts
   - Add notification channels (Slack, email, PagerDuty)

2. **Create Custom Dashboards**:
   - SigNoz Cloud > Dashboards > New Dashboard
   - Add panels for your specific metrics
   - Share with your team

3. **Instrument Applications** (optional):
   - Add OpenTelemetry SDKs to your apps
   - Send traces to same endpoint
   - Get distributed tracing and APM

## Configuration Reference

Your complete SigNoz configuration:

```hcl
# Enable monitoring
enable_signoz = true

# SigNoz Cloud endpoint (US region)
signoz_endpoint = "ingest.us.signoz.cloud:443"

# Your ingestion key
signoz_ingestion_key = "xLFY6djeWtEqZt1eGrYTwKkKeR5kCua-VB1w"

# Namespace
signoz_namespace = "signoz"

# Feature flags (cost-optimized defaults)
signoz_enable_logs    = false  # Disabled to save costs
signoz_enable_events  = true   # Kubernetes events
signoz_enable_metrics = true   # Node/pod metrics
```

## Support

- SigNoz Documentation: https://signoz.io/docs/
- Community Slack: https://signoz.io/slack
- GitHub Issues: https://github.com/SigNoz/signoz/issues
