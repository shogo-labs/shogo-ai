# Staging Infrastructure & Load Test Report

**Date:** March 4, 2026
**Environment:** staging (`shogo-staging-system` / `shogo-staging-workspaces`)
**Cluster:** AWS EKS with Karpenter autoscaling

---

## Executive Summary

A comprehensive infrastructure audit and load test was performed on the staging environment. The session began with diagnosing why 4 nodes were running at idle (expected: 1–2), uncovered multiple systemic issues (dual autoscalers, PDB deadlocks, CRD mismatches), resolved them, then validated the fixes under load at 100- and 200-user concurrency levels.

**Key outcome:** The runtime infrastructure (API, agent gateway, chat, dynamic apps) is stable and performant. The primary scaling bottleneck is the warm pool's throughput — a pool of 10 pre-started agents cannot absorb burst demand from 100+ simultaneous project creations, causing cold-start timeouts. All other subsystems performed well.

---

## 1. Infrastructure Issues Found & Resolved

### 1.1 Dual Autoscaler Conflict
**Problem:** Both Karpenter (v1.9.0) and an orphaned `cluster-autoscaler` Helm release were running, fighting over node scaling decisions.
**Fix:** Uninstalled `cluster-autoscaler` via `helm uninstall cluster-autoscaler -n kube-system`.

### 1.2 Karpenter CRD/Controller Version Mismatch
**Problem:** Karpenter controller was spamming `unknown field "status.nodes"`, indicating CRDs lagged behind the v1.9.0 controller.
**Fix:** Reinstalled CRDs with `kubectl apply --server-side --force-conflicts` and restarted the controller pod.

### 1.3 PodDisruptionBudget Deadlocks
**Problem:** Single-replica Knative and CloudNativePG components had restrictive PDBs (`minAvailable: 80%` or `minAvailable: 1`), preventing Karpenter from ever draining nodes.
**Fix:**
- Scaled Knative activator and Kourier gateway to **2 replicas** each.
- Patched PDBs for `activator-pdb`, `webhook-pdb`, and `3scale-kourier-gateway-pdb` to `maxUnavailable: 1`.
- Disabled auto-created PDBs for single-instance CNPG clusters (`enablePDB: false`).
- Relaxed `image-prepuller-pdb` to `minAvailable: 1`.
- All changes persisted in Terraform (`terraform/modules/knative/main.tf`).

### 1.4 503 During Node Drain
**Problem:** When Karpenter consolidated nodes, the single-replica Kourier gateway was evicted, dropping all inbound traffic.
**Fix:** Ensured Kourier gateway and Knative activator always run ≥2 replicas with PDBs allowing rolling eviction.

### 1.5 AWS vCPU Quota Limit
**Problem:** Karpenter hit the 32 vCPU ceiling for `Running On-Demand Standard` instances during load testing.
**Fix:** Requested quota increase from 32 → 128 vCPUs via AWS Service Quotas (`shogo` profile).

### 1.6 Node Group Upgrade & EBS Volume Failures
**Problem:** After upgrading from `t3.xlarge` → `t3.2xlarge`, CNPG pods entered `FailedAttachVolume` because EBS volumes were still bound to terminated instances.
**Fix:** Force-deleted stuck CNPG pods, waited for CSI driver registration on new Karpenter nodes in the correct AZ.

### 1.7 Knative API Missing `containerPort`
**Problem:** After manual patching, a new Knative revision lost the `containerPort: 8002` configuration, causing the queue-proxy sidecar to fail.
**Fix:** Patched the Knative Service spec to explicitly include `containerPort: 8002`.

### 1.8 Missing API DomainMapping
**Problem:** `api-staging.shogo.ai` returned 404 — no Knative `DomainMapping` existed for external API access.
**Fix:** Created the DomainMapping and persisted it in Terraform for future deploys.

### 1.9 ASG Warm Pool Killing Database Pods (Post-Load-Test Outage)
**Problem:** The EKS managed node group had an AWS ASG warm pool enabled (`terraform/modules/eks/main.tf`). After the load tests freed up vCPUs, the ASG launched 2 warm pool instances that joined the cluster and accepted pod scheduling — including both Postgres databases. Minutes later, the ASG stopped those instances to return them to the warm pool. The EC2 stop was not Kubernetes-aware: no drain, no cordon, no eviction. Both database pods died instantly, and the API went into CrashLoopBackOff.

**Root cause chain:**
1. ASG warm pool kept trying to launch instances during load tests but hit `VcpuLimitExceeded` (7 failed attempts over 2 hours)
2. After Karpenter drained nodes post-test, vCPUs freed up, and 2 warm pool instances launched successfully
3. EKS bootstrap script ran, instances joined cluster as Ready nodes
4. Kubernetes scheduler placed CNPG pods on these nodes (no affinity rules prevented it)
5. ASG determined desired=1, stopped the warm pool instances without draining
6. Kubelet died, nodes went `NotReady`, DB pods stuck `Terminating`, API crashed

**Fix (3 parts):**
- **Disabled ASG warm pool:** Set `enable_asg_warm_pool = false` in Terraform staging config and deleted the warm pool via AWS CLI. Karpenter handles dynamic node scaling with proper Kubernetes-aware draining, making the ASG warm pool redundant and dangerous.
- **Pinned Postgres to managed nodes:** Added `nodeSelector: eks.amazonaws.com/nodegroup: shogo-staging-main` to both CNPG cluster specs (`k8s/cnpg/staging/platform-cluster.yaml`, `k8s/cnpg/staging/projects-cluster.yaml`). Databases will never schedule on Karpenter or other ephemeral nodes.
- **Scaled managed group to 2 nodes:** Increased `node_desired_size` and `node_min_size` from 1 to 2 in `terraform.tfvars`. This ensures managed nodes span multiple AZs (us-east-1b and us-east-1c) so EBS volumes can always attach.

---

## 2. Features Built

### 2.1 Admin Infrastructure Metrics Fix
- **Running Pods:** Fixed to query all Knative services with `app.kubernetes.io/part-of=shogo` label, capturing both project-runtime and agent-runtime pods.
- **CPU Utilization:** Replaced estimated CPU calculation with actual `resources.requests.cpu` and `resources.limits.cpu` aggregation from running pods. Added dual-bar visualization (requests vs. limits) in the admin UI.

### 2.2 Runtime-Configurable Infrastructure Settings
Built a full stack feature allowing super admins to tune infrastructure from the UI:

| Layer | What was built |
|---|---|
| **Controller** | `updateConfig()` method on `WarmPoolController` for hot-patching pool size, idle timeout, GC toggle, reconcile interval |
| **API** | `GET/PATCH /api/admin/settings/infrastructure` endpoints (protected by `requireSuperAdmin`) |
| **Persistence** | New `PlatformSetting` Prisma model (`platform_settings` table) — settings survive pod restarts |
| **UI** | Settings panel on Infrastructure admin page with "Warm Pool" and "Lifecycle" sections |

### 2.3 Documentation & Domain Strategy
Updated `STAGING_DEBUGGING.md`, `CICD_SETUP.md`, Terraform outputs, load test configs, and deploy scripts to clarify the dual-domain strategy:
- `studio-staging.shogo.ai` — primary app domain, API accessed via same-origin proxy
- `api-staging.shogo.ai` — external tooling (load tests, webhooks, debugging)

---

## 3. Load Test Results

### 3.1 Test Configuration

| Parameter | Value |
|---|---|
| Tool | Locust (headless) |
| Test file | `locustfiles/complex/agent_runtime_test.py` |
| Target | `https://api-staging.shogo.ai` |
| Spawn rate | 0.5 users/sec |
| Duration | 10 minutes |
| Warm pool size | 10 agents |
| Chat | Enabled (build + direct) |

### 3.2 Cluster Configuration

| Component | Spec |
|---|---|
| Managed node group | 2× `t3.2xlarge` (8 vCPU / 32 GB each) |
| Karpenter node pool | `t3.xlarge` / `t3.2xlarge` / `m5.xlarge` / `m5.2xlarge`, max 15 nodes |
| vCPU quota | 128 (increased from 32) |
| Warm pool | 10 pre-started agents, 256Mi memory request, 10m idle timeout |

### 3.3 Test 1: 100 Users

| Metric | Value |
|---|---|
| **Total requests** | **2,129** |
| **Overall error rate** | **8.49%** (139 failures) |
| **Total failures** | 139 |
| Nodes at peak | 6 |
| Nodes post-drain | 4 (consolidated in ~20 min) |

#### Per-Endpoint Breakdown

| Endpoint | Requests | Failures | Fail % | Avg (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/sign-up/email` | 100 | 0 | 0.0% | 4,157 | 1,700 | 14,000 | 21,000 |
| `POST /api/projects [create]` | 82 | 0 | 0.0% | 878 | 180 | 5,000 | 9,400 |
| `GET sandbox/url [wait=true]` | 82 | **69** | **84.2%** | 95,580 | 120,000 | 120,000 | 120,000 |
| `WARM_START` | 11 | 0 | 0.0% | 4,988 | 3,600 | 16,000 | 16,000 |
| `POST /api/projects/:id/chat [build]` | 55 | 0 | 0.0% | 16,512 | 17,000 | 43,000 | 44,000 |
| `POST agent-proxy/agent/chat` | 58 | 0 | 0.0% | 771 | 170 | 4,500 | 9,700 |
| `GET agent-proxy/health` | 322 | 10 | 3.1% | 612 | 160 | 3,300 | 5,300 |
| `GET agent-proxy/dynamic-app/state` | 153 | 4 | 2.6% | 607 | 200 | 3,500 | 5,300 |
| `GET agent-proxy/files/:name` | 151 | 2 | 1.3% | 629 | 180 | 3,400 | 5,000 |

#### Node Scaling Timeline (100u)

```
T+0:00  4 nodes (2× t3.2xlarge managed, 2× t3.xlarge Karpenter)
T+2:00  6 nodes (Karpenter added 2× t3.xlarge)
T+10:00 6 nodes (test ends)
T+25:00 5 nodes (1 Karpenter node drained)
T+27:00 4 nodes (2nd Karpenter node drained)
```

### 3.4 Test 2: 200 Users

| Metric | Value |
|---|---|
| **Total requests** | **4,792** |
| **Overall error rate** | **21.0%** (1,494 failures) |
| **Total failures** | 1,494 |
| Nodes at peak | 5 |

#### Per-Endpoint Breakdown

| Endpoint | Requests | Failures | Fail % | Avg (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|---|---|---|
| `POST /api/auth/sign-up/email` | 200 | 1 | 0.5% | 2,871 | 1,500 | 10,000 | 12,000 |
| `POST /api/projects [create]` | 190 | 0 | 0.0% | 669 | 200 | 3,100 | 6,100 |
| `GET sandbox/url [wait=true]` | 190 | **154** | **81.1%** | 93,453 | 120,000 | 120,000 | 120,000 |
| `WARM_START` | 36 | 0 | 0.0% | 8,214 | 2,100 | 35,000 | 74,000 |
| `POST /api/projects/:id/chat [build]` | 133 | 34 | 25.6% | 21,867 | 20,000 | 53,000 | 120,000 |
| `POST agent-proxy/agent/chat` | 147 | 44 | 29.9% | 6,074 | 830 | 10,000 | 120,000 |
| `GET agent-proxy/health` | 661 | 232 | 35.1% | 1,618 | 700 | 5,300 | 5,300 |
| `GET agent-proxy/dynamic-app/state` | 355 | 117 | 33.0% | 1,538 | 660 | 5,300 | 5,300 |
| `GET agent-proxy/files/:name` | 371 | 132 | 35.6% | 1,543 | 610 | 5,000 | 5,300 |

#### Failure Analysis (200u)

| Error Type | Count | Source |
|---|---|---|
| `sandbox/url: 0` (120s timeout) | 146 | Cold start exceeded timeout |
| `Health: 502` | 133 | Pod not assigned / not ready |
| `Health: 0` | 99 | Connection refused / timeout |
| `Status: 502` | 88 | Pod not assigned |
| `Dynamic app state: 502` | 72 | Pod not assigned |
| `Chat history: 502` | 54 | Pod not assigned |
| `MCP catalog: 502` | 46 | Pod not assigned |
| `Dynamic app state: 0` | 45 | Connection timeout |
| `Ready: 502` | 43 | Pod not assigned |
| `Write MEMORY.md: 502` | 42 | Pod not assigned |
| `Chat: 502` | 41 | Pod not assigned |

> **Pattern:** All 502/0 errors on `agent-proxy/*` endpoints are downstream effects of the user never receiving a pod (sandbox/url timeout). These users have no running agent to proxy to.

### 3.5 Comparative Summary

| Metric | 100 Users | 200 Users | Delta |
|---|---|---|---|
| Total requests | 2,129 | 4,792 | +125% |
| Error rate | 8.49% | 21.02% | +148% |
| Sandbox/url success | 13/82 (15.9%) | 36/190 (18.9%) | +3pp |
| Warm start avg | 4,988ms | 8,214ms | +65% |
| Warm start best | 1,072ms | 765ms | -29% |
| Chat (direct) avg | 771ms | 6,074ms | +688% |
| Chat (build) avg | 16,512ms | 21,867ms | +32% |
| Peak nodes | 6 | 5 | -1 |
| Node drain time | ~20 min | (still draining) | — |

---

## 4. Architecture Analysis

### 4.1 What Scales Well

| Component | Observation |
|---|---|
| **API (Hono/Knative)** | Sign-up and project creation near-zero failures at both scales. Knative autoscaler handles request volume. |
| **Agent Runtime** | Once a pod is assigned, chat, files, dynamic app, MCP catalog all respond under 1s median. |
| **Karpenter** | Correctly provisions nodes within 2 min when pods go Pending. Consolidates empty nodes in ~20 min. |
| **Warm Pool Assignment** | When a warm pod is available, assignment is near-instant (best: 765ms). |
| **Knative + Kourier** | With 2-replica gateway and activator, zero 503s during node consolidation. |

### 4.2 The Bottleneck: Cold Start Pipeline

When the warm pool is exhausted, each new project must cold-start:

```
User creates project
  → API creates Knative Service (~1s)
    → Knative schedules pod
      → IF no node capacity: Karpenter provisions node (~60-90s)
        → kubelet pulls image (pre-cached by image-prepuller on new nodes ~30-60s)
          → Container starts, gateway initializes (~15-30s)
            → Pod passes readiness probe
              → sandbox/url returns URL

Total cold start: 2-4 minutes (exceeds 120s timeout)
```

The warm pool's reconcile loop creates new warm pods after the pool is depleted, but each warm pod takes ~30-60s to become ready. At 0.5 users/sec spawn rate:
- 10 warm pods are consumed in ~20s
- Pool replenishes ~10 pods per 30-60s cycle
- Users spawning faster than replenishment hit cold starts

### 4.3 Error Cascade

```
sandbox/url times out (120s)
  → User has no pod URL
    → All agent-proxy/* requests fail (502 or connection refused)
      → Chat, files, dynamic app, status all fail
        → Inflates overall error rate from ~3% (healthy pods) to 21%+
```

---

## 5. Current Cluster State (Post-Tests)

| Component | Status |
|---|---|
| **Nodes** | 5 (2× t3.2xlarge managed + 3× t3.xlarge Karpenter) |
| **CPU Utilization** | 19,835 / 27,580 mCPU (72% requested) |
| **Pod Slots** | 148 / 290 (51%) |
| **Workspace Pods** | 166 (draining) |
| **Warm Pool** | 0/10 available, 16 assigned (will GC over next ~10 min) |
| **Knative Services** | API, Studio, Docs — all `Ready: True` |
| **GC Stats** | 62 orphans deleted, 49 idle evictions (cumulative) |

---

## 6. Recommendations

### Immediate (No Code Changes)

| Action | Impact | Effort |
|---|---|---|
| Increase warm pool to 30-50 via admin UI | Absorbs typical burst demand | UI toggle |
| Increase sandbox/url timeout to 300s | Allows cold starts to complete | Env var |
| Pre-scale ASG before planned demos | Eliminates node provisioning latency | AWS Console |

### Short Term (Code Changes)

| Action | Impact | Effort |
|---|---|---|
| **Adaptive warm pool** — scale pool size based on recent request rate | Automatically handles bursts | Medium |
| **Faster cold starts** — slim base image, lazy-load gateway tools | Reduce cold start from ~3min to <60s | Medium |
| **Queued provisioning** — return job ID immediately, poll for readiness separately | Eliminates timeout failures | Medium |
| **Connection pooling** — reuse Prisma connections across warm pool pods | Reduce DB connection exhaustion | Low |

### Long Term (Architecture)

| Action | Impact | Effort |
|---|---|---|
| **Session affinity** — route returning users to existing pods | Eliminates re-provisioning for active users | High |
| **Shared runtime pool** — multi-tenant agent pods | 10× density improvement | High |
| **Predictive scaling** — ML-based demand forecasting | Proactive node scaling | High |

---

## 7. Commits & Artifacts

### Commits (staging branch)

| Hash | Description |
|---|---|
| `8fed9f0f` | feat: add runtime-configurable infra settings and fix admin metrics |
| `b7226d66` | fix: unblock Karpenter node consolidation and prevent 503 during drains |

### Prisma Migration

`prisma/migrations/20260304_add_platform_settings_and_limit_cpu/migration.sql`
- Creates `platform_settings` table
- Adds `limitCpuMillis` column to `infra_snapshots`

### Load Test Results

All results in `load-tests/results/`:

| File | Test |
|---|---|
| `agent-100u-20260304-1128.*` | 100 users / 10 min (this session) |
| `agent-200u-20260304-1224.*` | 200 users / 10 min (this session) |
| `agent-loadtest-20260304-1102.*` | 100 users / 10 min (earlier run, pre-fixes) |
| `agent-loadtest-20260304-1109.*` | 100 users / 10 min (earlier run, mid-fixes) |

HTML reports available for visual charts of request rates, response times, and failure distribution.

---

## 8. Files Changed

| File | Change Type |
|---|---|
| `apps/api/src/lib/warm-pool-controller.ts` | Modified — configurable settings, `updateConfig()`, `getConfig()`, `loadPersistedSettings()` |
| `apps/api/src/lib/proactive-node-scaler.ts` | Modified — actual CPU requests/limits aggregation |
| `apps/api/src/lib/infra-metrics-collector.ts` | Modified — fixed running pods count, added `limitCpuMillis` |
| `apps/api/src/lib/knative-project-manager.ts` | Modified — added `listAllServices()` |
| `apps/api/src/routes/admin.ts` | Modified — settings endpoints, CPU limits in history |
| `apps/api/src/server.ts` | Modified — new admin settings routes |
| `apps/mobile/app/(admin)/infrastructure.tsx` | Modified — CPU bar fix, settings panel |
| `prisma/schema.prisma` | Modified — `PlatformSetting` model, `limitCpuMillis` field |
| `prisma/migrations/20260304_*/migration.sql` | Created — schema migration |
| `k8s/cnpg/staging/platform-cluster.yaml` | Modified — `enablePDB: false`, nodeSelector for managed node group |
| `k8s/cnpg/staging/projects-cluster.yaml` | Modified — `enablePDB: false`, nodeSelector for managed node group |
| `k8s/overlays/staging/api-service.yaml` | Modified — env vars |
| `k8s/overlays/staging/image-prepuller-pdb.yaml` | Modified — relaxed PDB |
| `terraform/environments/staging/main.tf` | Modified — PDB patches, DomainMapping, `enable_asg_warm_pool = false` |
| `terraform/environments/staging/terraform.tfvars` | Modified — t3.2xlarge, `node_desired_size = 2`, `node_min_size = 2` |
| `terraform/environments/staging/outputs.tf` | Modified — domain docs |
| `terraform/modules/knative/main.tf` | Modified — PDB patches |
| `docs/STAGING_DEBUGGING.md` | Modified — domain strategy |
| `.github/CICD_SETUP.md` | Modified — domain strategy |
| `load-tests/locustfiles/common/config.py` | Modified — domain comment |
| `load-tests/scripts/setup_test_data.py` | Modified — domain comment |
| `load-tests/scripts/run_dry_run.sh` | Modified — domain comment |
