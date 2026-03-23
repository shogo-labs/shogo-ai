# Production Access Guide

Quick reference for connecting to Shogo production infrastructure.

---

## Prerequisites

| Tool | Install |
|------|---------|
| `kubectl` | `brew install kubectl` |
| `oci` (OCI CLI) | `brew install oci-cli` |
| `skopeo` | `brew install skopeo` (image replication) |

### OCI CLI Setup

```bash
oci setup config
```

Config lives at `~/.oci/config`. You need:
- User OCID, tenancy OCID, region, API key fingerprint
- Private key at `~/.oci/oci_api_key.pem`

---

## Kubeconfig Files

Each cluster has a dedicated kubeconfig file to avoid context-switching mistakes:

| File | Cluster | Region | Purpose |
|------|---------|--------|---------|
| `~/.kube/config-oke-us` | OCI OKE US | us-ashburn-1 | **Primary** production |
| `~/.kube/config-oke-eu` | OCI OKE EU | eu-frankfurt-1 | Tier 1 production |
| `~/.kube/config-oke-india` | OCI OKE India | ap-mumbai-1 | Tier 2 production |
| `~/.kube/config-oke-staging` | OCI OKE Staging | us-ashburn-1 | Staging |

### Generating Kubeconfigs

If you need to regenerate an OKE kubeconfig:

```bash
# US production
oci ce cluster create-kubeconfig \
  --cluster-id <cluster-ocid> \
  --file ~/.kube/config-oke-us \
  --region us-ashburn-1 \
  --token-version 2.0.0 \
  --kube-endpoint PUBLIC_ENDPOINT

# EU production
oci ce cluster create-kubeconfig \
  --cluster-id <cluster-ocid> \
  --file ~/.kube/config-oke-eu \
  --region eu-frankfurt-1 \
  --token-version 2.0.0 \
  --kube-endpoint PUBLIC_ENDPOINT

# India production
oci ce cluster create-kubeconfig \
  --cluster-id <cluster-ocid> \
  --file ~/.kube/config-oke-india \
  --region ap-mumbai-1 \
  --token-version 2.0.0 \
  --kube-endpoint PUBLIC_ENDPOINT
```

---

## Connecting to Clusters

Always use `KUBECONFIG=` to target a specific cluster. Never rely on the default context.

```bash
# US production
KUBECONFIG=~/.kube/config-oke-us kubectl get pods -n shogo-production-system

# EU production
KUBECONFIG=~/.kube/config-oke-eu kubectl get pods -n shogo-production-system

# India production
KUBECONFIG=~/.kube/config-oke-india kubectl get pods -n shogo-production-system

# Staging
KUBECONFIG=~/.kube/config-oke-staging kubectl get pods -n shogo-staging-system
```

### Shell Aliases (optional)

Add to `~/.zshrc` for convenience:

```bash
alias kus='KUBECONFIG=~/.kube/config-oke-us kubectl'
alias keu='KUBECONFIG=~/.kube/config-oke-eu kubectl'
alias kin='KUBECONFIG=~/.kube/config-oke-india kubectl'
alias kst='KUBECONFIG=~/.kube/config-oke-staging kubectl'
```

Then: `kus get pods -n shogo-production-system`

---

## Namespaces

| Namespace | Contents |
|-----------|----------|
| `shogo-production-system` | API, Studio (web), Redis, PostgreSQL (CNPG), image prepuller |
| `shogo-production-workspaces` | Agent runtime pods (per-user workspaces) |
| `shogo-staging-system` | Staging API, Studio, Redis, PostgreSQL |
| `shogo-staging-workspaces` | Staging agent runtime pods |
| `cnpg-system` | CloudNativePG operator |
| `knative-serving` | Knative Serving control plane |
| `kourier-system` | Kourier ingress controller |

---

## Common Operations

### View running services

```bash
KUBECONFIG=~/.kube/config-oke-us kubectl get ksvc -n shogo-production-system
```

### Check pod health across all regions

```bash
for region in us eu india; do
  echo "=== $region ===" && \
  KUBECONFIG=~/.kube/config-oke-$region kubectl get pods -n shogo-production-system -l 'serving.knative.dev/service'
done
```

### View API logs

```bash
# Follow logs on US production
KUBECONFIG=~/.kube/config-oke-us kubectl logs -f -n shogo-production-system \
  -l serving.knative.dev/service=api -c api --tail=100

# Logs from a specific pod
KUBECONFIG=~/.kube/config-oke-us kubectl logs -n shogo-production-system <pod-name> -c api
```

### Restart API (rolling)

Force a new Knative revision to trigger a rolling restart:

```bash
KUBECONFIG=~/.kube/config-oke-us kubectl patch ksvc api -n shogo-production-system \
  --type merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"client.knative.dev/updateTimestamp\":\"$(date +%s)\"}}}}}"
```

### Check database

```bash
# CNPG cluster status
KUBECONFIG=~/.kube/config-oke-us kubectl get cluster -n shogo-production-system

# Connect to PostgreSQL
KUBECONFIG=~/.kube/config-oke-us kubectl exec -it -n shogo-production-system platform-pg-1 -- psql -U shogo -d shogo
```

### Check Redis

```bash
KUBECONFIG=~/.kube/config-oke-us kubectl exec -it -n shogo-production-system redis-master-0 -- redis-cli info server
```

### View secrets (keys only)

```bash
KUBECONFIG=~/.kube/config-oke-us kubectl get secret api-secrets -n shogo-production-system \
  -o jsonpath='{.data}' | python3 -c "import json,sys; [print(k) for k in sorted(json.load(sys.stdin))]"
```

### Image replication (manual)

If images need to be manually replicated to EU or India:

```bash
# Login to all registries first
skopeo login us-ashburn-1.ocir.io
skopeo login eu-frankfurt-1.ocir.io
skopeo login ap-mumbai-1.ocir.io
# Username: idin4oltblww/info@shogo.ai
# Password: <OCIR auth token>

# Copy image
skopeo copy \
  docker://us-ashburn-1.ocir.io/idin4oltblww/shogo/shogo-api:<tag> \
  docker://eu-frankfurt-1.ocir.io/idin4oltblww/shogo/shogo-api:<tag>
```

---

## Infrastructure Overview

### OCI Container Registry (OCIR)

| Region | Registry |
|--------|----------|
| US | `us-ashburn-1.ocir.io/idin4oltblww/shogo/` |
| EU | `eu-frankfurt-1.ocir.io/idin4oltblww/shogo/` |
| India | `ap-mumbai-1.ocir.io/idin4oltblww/shogo/` |

Images: `shogo-api`, `shogo-web`, `shogo-runtime`, `shogo-runtime-base`, `agent-runtime`

### DNS & Traffic Routing

- **Domain**: `studio.shogo.ai` → Cloudflare Load Balancer
- **Steering**: Dynamic latency-based routing across US, EU, India origin pools
- **SSL**: Cloudflare Full mode with Origin Certificate on OCI Load Balancers
- **Health checks**: HTTPS to each region's OCI Load Balancer

### Database (CNPG)

Cross-region streaming replication from US primary:

| Region | Instances | Role |
|--------|-----------|------|
| US | 2 (primary + replica) | **Primary** write region |
| EU | 1 | Streaming replica of US (read-only) |
| India | 1 | Streaming replica of US (read-only) |

The US primary is exposed externally via a LoadBalancer service (`platform-pg-external`) at `129.158.209.173:5432` for cross-region streaming replication. EU and India replicas connect via TLS using the US cluster's CA and replication certificates.

### Object Storage (OCI S3-compatible)

All regions use OCI Object Storage in US (Ashburn) as the centralized store:

| Bucket | Purpose |
|--------|---------|
| `shogo-workspaces-production` | Workspace file storage |
| `shogo-published-apps-production` | Published app assets (public read) |

S3-compatible access uses OCI Customer Secret Keys stored in the `s3-credentials` secret (in both `shogo-production-system` and `shogo-production-workspaces` namespaces).

### CI/CD

Deployments are triggered via GitHub Actions (`.github/workflows/deploy.yml`) on pushes to:
- `main` branch → staging
- `production` branch → all production regions

The workflow builds images in US OCIR, replicates to EU/India with `skopeo`, and deploys via `kubectl apply -k` to each region's kustomize overlay.

---

## Troubleshooting

### Pods stuck in ImagePullBackOff

1. Check the pull secret matches the regional OCIR endpoint:
   ```bash
   KUBECONFIG=~/.kube/config-oke-eu kubectl get secret ocir-pull-secret -n shogo-production-system \
     -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | python3 -m json.tool
   ```
2. Verify the image exists in the regional OCIR (use `skopeo` to replicate if missing)
3. Ensure `imagePullSecrets` is set on the service accounts:
   ```bash
   kubectl get sa default -n shogo-production-system -o jsonpath='{.imagePullSecrets}'
   kubectl get sa api-service-account -n shogo-production-system -o jsonpath='{.imagePullSecrets}'
   ```

### API pods in CrashLoopBackOff

Check logs for the crash reason:
```bash
KUBECONFIG=~/.kube/config-oke-us kubectl logs -n shogo-production-system \
  -l serving.knative.dev/service=api -c api --tail=50
```

Common causes:
- Database unreachable (`P1001: Can't reach database server`) — check CNPG is running and `postgres-credentials` secret is correct
- Missing secrets — check `api-secrets` exists and has all required keys
- Redis unreachable — check Redis StatefulSet is running

### Knative service stuck in RevisionMissing

Force a new revision:
```bash
kubectl patch ksvc <name> -n shogo-production-system \
  --type merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"client.knative.dev/updateTimestamp\":\"$(date +%s)\"}}}}}"
```

### Cloudflare returning 525 (SSL Handshake Failed)

The OCI Load Balancer terminates TLS using a Cloudflare Origin Certificate. Check:
1. Cloudflare SSL mode is set to **Full** (not Flexible)
2. OCI LB has an HTTPS listener on port 443 with the origin certificate
3. The backend set points to Kourier's HTTP NodePort
