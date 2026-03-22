# OCI Multi-Region Production Deployment Guide

> Shogo production on Oracle Cloud Infrastructure — tiered multi-region with 2–N regions.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Tier Model](#2-tier-model)
3. [Terraform Module Structure](#3-terraform-module-structure)
4. [Region Selection & CIDRs](#4-region-selection--cidrs)
5. [Adding a New Region (Step by Step)](#5-adding-a-new-region-step-by-step)
6. [Network Foundation](#6-network-foundation)
7. [Database Strategy](#7-database-strategy)
8. [Object Storage](#8-object-storage)
9. [Redis & Session State](#9-redis--session-state)
10. [Container Registry (OCIR)](#10-container-registry-ocir)
11. [DNS & Traffic Routing](#11-dns--traffic-routing)
12. [TLS Certificates](#12-tls-certificates)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Kubernetes Overlay Structure](#14-kubernetes-overlay-structure)
15. [Warm Pool & Autoscaling](#15-warm-pool--autoscaling)
16. [Observability](#16-observability)
17. [Failover & Disaster Recovery](#17-failover--disaster-recovery)
18. [Rollout Plan](#18-rollout-plan)
19. [Cost Considerations](#19-cost-considerations)

---

## 1. Architecture Overview

```
                         ┌───────────────────┐
                         │   Cloudflare LB    │
                         │  (Geo Steering)    │
                         └─────────┬─────────┘
              ┌────────────────────┼──────────────────────┐
              ▼                    ▼                       ▼
   ┌─────────────────┐  ┌─────────────────┐   ┌─────────────────┐
   │  US (Ashburn)    │  │  EU (Frankfurt)  │   │ India (Mumbai)  │
   │  TIER 1 PRIMARY  │  │  TIER 1 REPLICA  │   │  TIER 2 LIGHT   │
   │                  │  │                  │   │                  │
   │  OKE + Knative   │  │  OKE + Knative   │   │  OKE + Knative   │
   │  CNPG (Primary)  │  │  CNPG (Replica)  │   │  (no local DB)   │
   │  Object Storage  │──│  Object Storage  │   │  reads from US   │
   │  Redis           │  │  Redis           │   │  Redis (local)   │
   │  File Storage    │  │  File Storage    │   │  (no file store) │
   └────────┬─────────┘  └────────┬─────────┘   └────────┬────────┘
            │         DRG Peering  │                      │
            └──────────────────────┴──────────────────────┘
```

**Key insight**: Not every region needs a full data layer. Agent runtimes (the latency-sensitive part) run locally in every region. Database and storage can be centralized.

---

## 2. Tier Model

| | Tier 1 (Full) | Tier 2 (Light) |
|---|---|---|
| **Purpose** | Complete region with local data | Compute-only edge region |
| **OKE Cluster** | Yes | Yes |
| **Knative + Kourier** | Yes | Yes |
| **Agent Runtimes** | Yes | Yes |
| **API Pods** | Yes | Yes (connects to Tier 1 DB) |
| **CNPG PostgreSQL** | Yes (primary or replica) | No |
| **Object Storage** | Yes (buckets + lifecycle) | No (reads from Tier 1) |
| **File Storage (NFS)** | Yes | No |
| **Publish Hosting** | Yes (Cloudflare Worker) | No |
| **When to use** | >20% of your traffic | <20% of traffic, latency-sensitive |
| **Monthly cost** | ~$650–1200 | ~$300–500 |

### When to upgrade Tier 2 → Tier 1

Promote a Tier 2 region to Tier 1 when:
- It consistently handles >20% of global traffic
- DB write latency from that region exceeds acceptable limits (>300ms)
- You need data residency in that geography (GDPR, India DPDP Act)

Promotion is a config change: set `tier = "full"` in the environment file and apply.

---

## 3. Terraform Module Structure

### Module hierarchy

```
terraform/
├── modules/
│   ├── oci-region/              ← COMPOSITE: provisions an entire region
│   │   ├── main.tf              (conditionally includes sub-modules based on tier)
│   │   ├── variables.tf
│   │   └── outputs.tf
│   │
│   ├── vcn/                     ← all tiers
│   ├── oke/                     ← all tiers
│   ├── ocir/                    ← all tiers
│   ├── knative-oci/             ← all tiers
│   ├── signoz/                  ← all tiers
│   ├── oci-github-oidc/         ← all tiers
│   │
│   ├── object-storage/          ← Tier 1 only
│   ├── file-storage/            ← Tier 1 only
│   ├── cnpg/                    ← Tier 1 only
│   ├── publish-hosting-oci/     ← Tier 1 only
│   │
│   ├── drg-peering/             ← cross-region networking
│   ├── cloudflare-lb/           ← multi-region traffic routing
│   └── object-storage-replication/  ← Tier 1 → Tier 1 data sync
│
├── environments/
│   ├── staging-oci/             ← existing (single region)
│   ├── production-oci/          ← existing (single region, migration path)
│   │
│   ├── production-us/           ← Tier 1 Primary
│   ├── production-eu/           ← Tier 1 Replica
│   ├── production-india/        ← Tier 2 Light
│   └── production-global/       ← Cloudflare LB (no OCI resources)
```

### The `oci-region` composite module

This is the core abstraction. A single `module` call provisions everything a region needs:

```hcl
# Tier 1 — Full region (US, EU)
module "us" {
  source      = "../../modules/oci-region"
  tier        = "full"
  region      = "us-ashburn-1"
  region_key  = "us"
  environment = "production"
  vcn_cidr    = "10.0.0.0/16"
  # ... node sizing, observability, etc.
}

# Tier 2 — Lightweight region (India)
module "india" {
  source      = "../../modules/oci-region"
  tier        = "light"
  region      = "ap-mumbai-1"
  region_key  = "in"
  environment = "production"
  vcn_cidr    = "10.2.0.0/16"

  # Tier 2 connects to Tier 1 for data
  database_primary_endpoint = "platform-pg-rw.shogo-system:5432"
  s3_primary_endpoint       = "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com"
  s3_primary_region         = "us-ashburn-1"
}
```

Internally, the module uses `count` to conditionally create data-layer resources:

```hcl
locals {
  is_full = var.tier == "full"
}

module "object_storage" {
  count  = local.is_full ? 1 : 0    # only for Tier 1
  source = "../object-storage"
  # ...
}

module "cnpg" {
  count  = local.is_full ? 1 : 0    # only for Tier 1
  source = "../cnpg"
}

# These always deploy:
module "vcn"     { ... }  # all tiers
module "oke"     { ... }  # all tiers
module "ocir"    { ... }  # all tiers
module "knative" { ... }  # all tiers
module "signoz"  { ... }  # all tiers
```

### Adding a 4th region (e.g. Singapore)

Create one file:

```hcl
# terraform/environments/production-singapore/main.tf
module "sg" {
  source      = "../../modules/oci-region"
  tier        = "light"
  region      = "ap-singapore-1"
  region_key  = "sg"
  environment = "production"
  vcn_cidr    = "10.3.0.0/16"
  # ...
}
```

Then add it to `production-global/main.tf` as a new origin in the Cloudflare LB. That's it.

---

## 4. Region Selection & CIDRs

| Region | OCI Identifier | CIDR | Tier | Role |
|--------|---------------|------|------|------|
| US East (Ashburn) | `us-ashburn-1` | `10.0.0.0/16` | 1 | Primary |
| EU Central (Frankfurt) | `eu-frankfurt-1` | `10.1.0.0/16` | 1 | Replica |
| India West (Mumbai) | `ap-mumbai-1` | `10.2.0.0/16` | 2 | Edge |
| *Singapore* | `ap-singapore-1` | `10.3.0.0/16` | 2 | Edge (future) |
| *Brazil* | `sa-saopaulo-1` | `10.4.0.0/16` | 2 | Edge (future) |
| *Japan* | `ap-tokyo-1` | `10.5.0.0/16` | 2 | Edge (future) |

> CIDRs must not overlap for DRG peering. Use `10.{N}.0.0/16` where N is the region index.

---

## 5. Adding a New Region (Step by Step)

### Tier 2 (Light) — ~2 hours

1. **Create environment directory**:
   ```
   terraform/environments/production-{region}/
     ├── main.tf       (copy from production-india, change region/CIDR)
     └── variables.tf
   ```

2. **Create OCI compartment** (or reuse existing):
   ```bash
   oci iam compartment create --name shogo-production-{region} ...
   ```

3. **Terraform apply** the new environment:
   ```bash
   cd terraform/environments/production-{region}
   terraform init && terraform apply
   ```

4. **Create K8s overlay** (`k8s/overlays/production-{region}-oci/`)

5. **Update CI/CD** — add a deploy job for the new region

6. **Update Cloudflare LB** — add the new origin to `production-global`

7. **Deploy secrets** — `api-secrets`, `ocir-pull-secret`, `kourier-tls`

### Tier 1 (Full) — ~1 week

All of the above, plus:

8. **Create CNPG cluster** (replica from US primary via Object Storage WAL)
9. **Set up Object Storage replication** (from US)
10. **Deploy Redis StatefulSet**
11. **Accept DRG peering** from US
12. **Test database failover**

---

## 6. Network Foundation

### Per-region VCN layout

| Subnet | CIDR offset | Purpose |
|--------|-------------|---------|
| Public | `/20` at offset 0 | Load balancers, OKE API |
| Private Workers | `/20` at offset 1 | OKE nodes |
| Private Pods | `/18` at offset 2 | VCN-native pod networking |

### Cross-region peering (DRG + RPC)

Each region gets a DRG. The US region creates RPCs to EU and India. Those regions accept the peering.

```
US DRG ──RPC──► EU DRG     (for DB streaming replication)
US DRG ──RPC──► India DRG  (for private DB access from Tier 2)
```

The `drg-peering` module handles this:

```hcl
# US side (requestor)
module "drg_to_eu" {
  source      = "../../modules/drg-peering"
  vcn_id      = module.us.vcn_id
  peer_region = "eu-frankfurt-1"
}

# EU side (acceptor)
module "drg_from_us" {
  source      = "../../modules/drg-peering"
  vcn_id      = module.eu.vcn_id
  peer_region = "us-ashburn-1"
  peer_rpc_id = var.us_rpc_id    # from US outputs
}
```

> DRG peering is optional for Tier 2. India can reach the US database over the public internet (via the Kourier LB or a dedicated endpoint). Peering gives lower latency and private connectivity.

---

## 7. Database Strategy

Uses CNPG's **Distributed Topology** API (introduced in CNPG 1.24) for the `platform-pg` cluster. This gives declarative switchover — change `primary` in both manifests and CNPG handles demotion/promotion without rebuilding the former primary.

### How Distributed Topology works

Both clusters define the full topology in `externalClusters` and use `.spec.replica` with three fields:

- `self` — this cluster's identity in the topology
- `primary` — which cluster is currently the global primary
- `source` — where to replicate from when acting as a replica

When `primary` matches `self`, the cluster is the primary. Otherwise, it replicates from `source`.

### Tier 1 Primary — US (`k8s/cnpg/production-us-oci/platform-cluster.yaml`)

```yaml
spec:
  instances: 3
  storage: { size: 50Gi, storageClass: oci-bv }

  replica:
    self: platform-pg-us
    primary: platform-pg-us      # self = primary → this IS the primary
    source: platform-pg-eu       # if demoted, replicate from EU

  externalClusters:
    - name: platform-pg-us
      barmanObjectStore:         # US backup location
        endpointURL: https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com
        destinationPath: s3://shogo-pg-backups-production/platform/
    - name: platform-pg-eu
      barmanObjectStore:         # EU backup location (for reading EU WAL after switchover)
        endpointURL: https://ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com
        destinationPath: s3://shogo-pg-backups-production-eu/platform/

  backup:                        # local backup to US object store
    barmanObjectStore:
      destinationPath: s3://shogo-pg-backups-production/platform/
```

### Tier 1 Replica — EU (`k8s/cnpg/production-eu-oci/platform-cluster.yaml`)

```yaml
spec:
  instances: 2

  bootstrap:
    recovery:
      source: platform-pg-us    # initial bootstrap from US backup

  replica:
    self: platform-pg-eu
    primary: platform-pg-us      # US is the primary → this is a replica
    source: platform-pg-us       # replicate WAL from US object store

  externalClusters:
    - name: platform-pg-us       # (same topology as US cluster)
      barmanObjectStore: ...
    - name: platform-pg-eu
      barmanObjectStore: ...

  backup:                        # local backup to EU object store (symmetric)
    barmanObjectStore:
      destinationPath: s3://shogo-pg-backups-production-eu/platform/
```

### Switchover procedure (zero data loss)

To promote EU to primary:

**Step 1 — Demote US** (on US K8s cluster):

```yaml
# Change US cluster's replica stanza
replica:
  self: platform-pg-us
  primary: platform-pg-eu       # ← changed from platform-pg-us
  source: platform-pg-eu
```

CNPG archives the final WAL, generates a `demotionToken` in `.status.demotionToken`.

**Step 2 — Promote EU** (on EU K8s cluster):

```bash
# Get the demotion token from the US cluster
TOKEN=$(kubectl get cluster platform-pg -o jsonpath='{.status.demotionToken}')
```

```yaml
# Change EU cluster's replica stanza
replica:
  self: platform-pg-eu
  primary: platform-pg-eu       # ← changed from platform-pg-us
  promotionToken: <TOKEN>       # ← from US demotionToken
  source: platform-pg-us
```

CNPG waits for EU to replay all WAL up to the demotion LSN, then promotes. The former US primary begins replicating from EU. No rebuild needed.

### Tier 2 (India) — No local database

API pods in India connect directly to the US primary database. Options:

1. **Via DRG peering** (recommended): Private, ~150ms RTT
2. **Via public internet**: Through a dedicated DB proxy endpoint, ~200ms RTT

For most operations (project CRUD, auth), 150–200ms DB latency is acceptable. The latency-critical part (agent runtime I/O, terminal streaming) runs locally and doesn't hit the DB on every keystroke.

### Secrets for Distributed Topology

Both clusters must have identical application user secrets for seamless switchover:

| Secret | US Cluster | EU Cluster |
|--------|-----------|-----------|
| `platform-pg-app` | Auto-created by CNPG | Copy from US, keep in sync |
| `platform-pg-superuser` | Auto-created by CNPG | Copy from US, keep in sync |
| `cnpg-s3-credentials` | Local region S3 keys | Local region S3 keys |
| `cnpg-s3-credentials-us` | (self) | US region S3 keys |
| `cnpg-s3-credentials-eu` | EU region S3 keys | (self) |

---

## 8. Object Storage

### Tier 1 regions: Local buckets + replication

US → EU replication via native OCI replication policies:

```hcl
module "replication_to_eu" {
  source             = "../../modules/object-storage-replication"
  environment        = "production"
  destination_region = "eu-frankfurt-1"
}
```

Replicated buckets: schemas, workspaces, pg-backups, published-apps.

> Destination buckets are read-only. EU writes go to EU-local buckets (not replicated back).

### Tier 2 regions: Use primary region's buckets

India API pods read directly from US Object Storage via the S3-compatible endpoint. The S3_ENDPOINT and S3_REGION env vars point to US:

```yaml
- name: S3_ENDPOINT
  value: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com"
- name: S3_REGION
  value: "us-ashburn-1"
```

---

## 9. Redis & Session State

**Each region runs its own Redis** (independent StatefulSets). No cross-region Redis replication.

Session stickiness is handled by Cloudflare LB cookie affinity (`session_affinity = "cookie"`). A user who authenticates in the US stays routed to the US for the duration of their session.

If a user's region fails, Cloudflare routes them to a healthy region. They'll need to re-authenticate (session is in the failed region's Redis), but their data is safe in the database.

---

## 10. Container Registry (OCIR)

OCIR is regional. Images must exist in each region's registry.

**CI/CD approach**: Build once in US, copy to other regions via `skopeo`:

```yaml
replicate-images:
  runs-on: ubuntu-latest
  strategy:
    matrix:
      target_region: [eu-frankfurt-1, ap-mumbai-1]
  steps:
    - name: Copy images
      run: |
        for IMAGE in shogo-api shogo-web shogo-runtime shogo-docs; do
          skopeo copy --all \
            docker://${US_REGISTRY}/$IMAGE:$TAG \
            docker://${{ matrix.target_region }}.ocir.io/${NAMESPACE}/shogo/$IMAGE:$TAG
        done
```

---

## 11. DNS & Traffic Routing

### Cloudflare Load Balancer with Geo Steering

Managed in `production-global/main.tf`:

```hcl
module "studio_lb" {
  source = "../../modules/cloudflare-lb"

  origins = {
    us = { address = "141.148.27.1" }
    eu = { address = "x.x.x.x" }
    in = { address = "y.y.y.y" }
  }

  geo_routing = {
    WNAM = ["us", "eu"]        # Americas → US
    ENAM = ["us", "eu"]
    WEU  = ["eu", "us"]        # Europe → EU
    EEU  = ["eu", "us"]
    SAS  = ["in", "eu", "us"]  # South Asia → India
    SEAS = ["in", "eu", "us"]  # SE Asia → India
    ME   = ["eu", "in"]        # Middle East → EU
    OC   = ["us", "in"]        # Oceania → US
  }
}
```

Each pool has health monitors hitting `/api/health`. If a region goes down, Cloudflare automatically fails over to the next pool in the list.

---

## 12. TLS Certificates

The existing Cloudflare Origin Certificate covers all regions:

```
SANs: *.shogo.ai, *.staging.shogo.ai, shogo.ai
Valid: 2026–2041
```

Deploy the same `kourier-tls` secret to every region's `kourier-system` namespace. Configure `config-kourier` identically in all clusters.

---

## 13. CI/CD Pipeline

### Updated workflow structure

```
deploy-oci.yml
  ├── detect-changes
  ├── build (images → US OCIR)
  ├── replicate-images (parallel: US → EU, US → India)
  ├── deploy-us (kustomize + autoscaler + prepuller + health check)
  ├── deploy-eu (parallel with India)
  └── deploy-india (parallel with EU)
```

### GitHub Environments

| Environment | OCI_REGION | Tier |
|-------------|-----------|------|
| `production-us` | us-ashburn-1 | 1 |
| `production-eu` | eu-frankfurt-1 | 1 |
| `production-india` | ap-mumbai-1 | 2 |

Each environment has its own `OKE_CLUSTER_OCID`, `NODE_POOL_OCID`, and `OCIR_REGISTRY`.

---

## 14. Kubernetes Overlay Structure

```
k8s/overlays/
  ├── production-us-oci/        ← Tier 1 (api-service has local DB URL)
  ├── production-eu-oci/        ← Tier 1 (api-service has replica DB URL)
  └── production-india-oci/     ← Tier 2 (api-service points to US DB)
```

### Tier 2 api-service.yaml differences

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: postgres-credentials
        key: DATABASE_URL          # points to US primary (via DRG peering IP)
  - name: S3_ENDPOINT
    value: "https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com"
  - name: S3_REGION
    value: "us-ashburn-1"
  - name: RUNTIME_IMAGE
    value: "ap-mumbai-1.ocir.io/ns/shogo/shogo-runtime:production-latest"
```

---

## 15. Warm Pool & Autoscaling

Each region manages its own warm pool and autoscaler independently. No cross-region coordination.

| Setting | US (Tier 1) | EU (Tier 1) | India (Tier 2) |
|---------|------------|------------|----------------|
| System nodes | 3–15 | 3–10 | 2–6 |
| Workload nodes | 2–100 | 2–50 | 1–30 |
| Warm pool agents | 10 | 5 | 3 |
| Warm pool projects | 3 | 2 | 1 |

---

## 16. Observability

All regions export to the same SigNoz Cloud instance with region labels:

```yaml
- name: OTEL_SERVICE_NAME
  value: "shogo-api-production-{region_key}"
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "cloud.region={oci_region},deployment.tier={tier}"
```

### Key dashboards

- Per-region latency (p50/p95/p99)
- Per-region error rates
- DB replication lag (Tier 1 replicas)
- Cross-region traffic distribution (Cloudflare analytics)
- Node count per region

---

## 17. Failover & Disaster Recovery

### Automatic (Cloudflare handles it)

Cloudflare health monitors check `/api/health` every 30 seconds. Failed region → traffic rerouted in ~30 seconds.

### Database switchover (planned, Tier 1 only)

Controlled switchover using CNPG Distributed Topology — see Section 7 for step-by-step. Zero data loss, no rebuild of former primary.

### Database failover (unplanned, Tier 1 only)

If US primary goes down unexpectedly and can't be recovered:

```bash
# On EU cluster — force-promote without demotion token
kubectl patch cluster platform-pg -n shogo-system --type merge -p '{
  "spec": {
    "replica": {
      "primary": "platform-pg-eu"
    }
  }
}'

# Update EU api-service DATABASE_URL if not already pointing to local
kubectl set env ksvc/api DATABASE_URL=<eu-primary-url> -n shogo-system
```

> After unplanned failover, the former US primary must be rebuilt (re-bootstrapped from EU backup) since no demotionToken was exchanged.

### RPO/RTO

| Scenario | RPO | RTO |
|----------|-----|-----|
| Pod crash | 0 | <10s (Knative) |
| Node failure | 0 | 2–5 min (autoscaler) |
| Region failure (traffic) | 0 | ~30s (Cloudflare) |
| Planned DB switchover | 0 | ~2 min (Distributed Topology) |
| Unplanned DB failover | Minutes (WAL lag) | 5–10 min |

---

## 18. Rollout Plan

### Phase 1: EU Tier 1 (Week 1–3)

- [ ] Terraform: `production-eu/` with `tier = "full"`
- [ ] OKE cluster + Knative + Kourier in eu-frankfurt-1
- [ ] CNPG replica from US Object Storage WAL
- [ ] Object Storage replication (US → EU)
- [ ] CI/CD: image replication + EU deploy job
- [ ] Cloudflare LB with geo-steering (US + EU)
- [ ] Test failover: disable US pool → EU serves all traffic

### Phase 2: India Tier 2 (Week 3–4)

- [ ] Terraform: `production-india/` with `tier = "light"`
- [ ] OKE cluster + Knative + Kourier in ap-mumbai-1
- [ ] API pods connect to US database (no local CNPG)
- [ ] CI/CD: add India image replication + deploy job
- [ ] Add India origin to Cloudflare LB
- [ ] Load test from India region

### Phase 3: Hardening (Week 4–5)

- [ ] DRG peering (US ↔ EU, US ↔ India) for private DB access
- [ ] Cross-region observability dashboards
- [ ] Failover runbooks
- [ ] Load tests per region and during simulated failure

### Phase 4: Scale (Ongoing)

- [ ] Add regions as Tier 2 (Singapore, Tokyo, São Paulo) as traffic warrants
- [ ] Promote high-traffic Tier 2 regions to Tier 1
- [ ] Evaluate read/write splitting for Tier 1 replica regions

---

## 19. Cost Considerations

### Per-region cost estimates

| Component | Tier 1 | Tier 2 |
|-----------|--------|--------|
| OKE System Nodes (3×8 OCPU) | ~$300 | ~$150 (2×4 OCPU) |
| OKE Workload Nodes (2×8 OCPU base) | ~$200+ | ~$100+ |
| OCI LB (Kourier) | ~$20 | ~$20 |
| Object Storage | ~$25 | $0 |
| Block Volumes (CNPG) | ~$50 | $0 |
| File Storage (NFS) | ~$20 | $0 |
| NAT Gateway | ~$40 | ~$40 |
| **Subtotal** | **~$650–750** | **~$310–400** |

### Global infrastructure

| Component | Monthly |
|-----------|---------|
| Cloudflare LB | ~$5 + usage |
| DRG Peering | Free (data transfer costs only) |
| Cross-region data transfer | ~$10–50 |
| SigNoz (shared) | Existing cost |

### Total for 3 regions (US + EU + India)

**~$1,600–1,900/mo** before Oracle discounts.

With 1-year Universal Credits: **~$1,100–1,300/mo** (30% savings).

### Adding each additional Tier 2 region: ~$310–400/mo

---

## Quick Reference

### Files created for this architecture

| Path | Purpose |
|------|---------|
| `terraform/modules/oci-region/` | Composite module (tier-aware) |
| `terraform/modules/drg-peering/` | Cross-region DRG + RPC |
| `terraform/modules/cloudflare-lb/` | Multi-region Cloudflare LB |
| `terraform/modules/object-storage-replication/` | Cross-region bucket sync |
| `terraform/environments/production-us/` | Tier 1 Primary |
| `terraform/environments/production-eu/` | Tier 1 Replica |
| `terraform/environments/production-india/` | Tier 2 Light |
| `terraform/environments/production-global/` | Cloudflare LB (no OCI) |
| `k8s/cnpg/production-us-oci/platform-cluster.yaml` | CNPG Distributed Topology primary |
| `k8s/cnpg/production-eu-oci/platform-cluster.yaml` | CNPG Distributed Topology replica |

### CIDR allocation

```
10.0.0.0/16  → US (us-ashburn-1)
10.1.0.0/16  → EU (eu-frankfurt-1)
10.2.0.0/16  → India (ap-mumbai-1)
10.3.0.0/16  → Singapore (future)
10.4.0.0/16  → Brazil (future)
10.5.0.0/16  → Japan (future)
```

### Adding a new Tier 2 region in 30 minutes

```bash
# 1. Copy template
cp -r terraform/environments/production-india terraform/environments/production-singapore
# 2. Edit: change region, region_key, vcn_cidr
# 3. Apply
cd terraform/environments/production-singapore && terraform init && terraform apply
# 4. Add to Cloudflare LB in production-global
# 5. Add deploy job to CI/CD
# Done.
```
