# Technical Specification: Pod-per-Workspace Deployment

**Version:** 1.1  
**Date:** January 2026  
**Status:** Draft for Review  
**Author:** Infrastructure Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Target Architecture](#3-target-architecture)
4. [Data Domain Architecture](#4-data-domain-architecture)
5. [Component Changes](#5-component-changes)
6. [Infrastructure as Code](#6-infrastructure-as-code)
7. [Local Development](#7-local-development)
8. [Deployment Pipeline](#8-deployment-pipeline)
9. [Security Considerations](#9-security-considerations)
10. [Cost Analysis](#10-cost-analysis)
11. [Future Multi-Cloud Support](#11-future-multi-cloud-support)
12. [Appendix](#12-appendix)

---

## 1. Executive Summary

### 1.1 Objective

Deploy Shogo AI platform on AWS EKS with a **hybrid control plane + workspace** architecture:
- **Control Plane** (shared): Organizations, Teams, Auth, Billing, Migrations
- **Per-Workspace**: Feature development sessions, chat history, user schemas
- Automatic scale-to-zero when idle (cost optimization)
- Persistent storage survives pod restarts
- Complete data isolation between workspaces

### 1.2 Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Isolation Model | Control Plane + Pod-per-Workspace | Shared org/team data + isolated workspace state |
| Orchestration | Kubernetes + Knative | Scale-to-zero capability; portable across clouds |
| Storage | PersistentVolumeClaims (EBS) | Preserves filesystem-based persistence pattern |
| Database | Shared RDS with row-level security | Cost-effective; leverages existing PostgreSQL support |
| Authentication | BetterAuth | Self-hostable auth with OAuth support |
| IaC Tool | Terraform | Cloud-agnostic; reusable for future providers |

### 1.3 Estimated Timeline

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| Phase 1: Containerization | 1 week | Dockerfiles, docker-compose.yml |
| Phase 2: EKS Infrastructure | 2 weeks | Terraform modules, base cluster |
| Phase 3: Workspace Operator | 2 weeks | Kubernetes operator, Knative services |
| Phase 4: Integration & Testing | 1 week | E2E tests, load testing |
| **Total** | **6 weeks** | Production-ready deployment |

---

## 2. Current State Analysis

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Current Shogo Architecture                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐│
│  │  @shogo/web  │   │  @shogo/api  │   │      @shogo/mcp          ││
│  │   (React)    │   │   (Hono)     │   │     (FastMCP)            ││
│  │  Port: 3000  │   │  Port: 8002  │   │   Port: 3100 (HTTP)      ││
│  └──────────────┘   └──────────────┘   │   stdio (Claude Code)    ││
│                                         └──────────────────────────┘│
│                                                    │                 │
│                                         ┌──────────┴──────────┐     │
│                                         │  @shogo/state-api   │     │
│                                         │   (Isomorphic)      │     │
│                                         └──────────┬──────────┘     │
│                                                    │                 │
│                    ┌───────────────────────────────┼────────────┐   │
│                    │                               │            │   │
│                    ▼                               ▼            ▼   │
│            ┌─────────────┐               ┌─────────────┐  ┌────────┐│
│            │ PostgreSQL  │               │ .schemas/   │  │ SQLite ││
│            │ (DATABASE_  │               │ (filesystem)│  │(fallbk)││
│            │    URL)     │               │             │  │        ││
│            └─────────────┘               └─────────────┘  └────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 State Management

The MCP server maintains two types of state:

#### 2.2.1 In-Memory State (Node.js Process)

```typescript
// packages/state-api/src/meta/bootstrap.ts

// Singleton meta-store - manages schema metadata
let _metaStore: any = null

export function getMetaStore(env?: IEnvironment) {
  if (!_metaStore) {
    const { createStore } = createMetaStore()
    _metaStore = createStore(_metaStoreEnv)
  }
  return _metaStore
}

// Runtime store cache - keyed by schemaId + workspace
// packages/state-api/src/meta/runtime-store-cache.ts
const runtimeStoreCache = new Map<string, any>()

export function cacheRuntimeStore(schemaId: string, store: any, location?: string) {
  const key = location ? `${schemaId}::${location}` : schemaId
  runtimeStoreCache.set(key, store)
}
```

**Impact:** If pod restarts, all in-memory stores are lost. Must be rebuilt from filesystem.

#### 2.2.2 Filesystem State

```
.schemas/
├── my-app/
│   ├── schema.json          # Schema definition
│   ├── metadata.json        # Views, templates
│   └── data/
│       ├── User/
│       │   ├── user-1.json
│       │   └── user-2.json
│       └── Task/
│           └── Task.json    # Flat collection
└── another-schema/
    └── ...
```

**Impact:** Filesystem must persist across pod restarts. Requires PersistentVolumeClaim.

### 2.3 Existing Multi-Tenancy Support

The codebase already has multi-tenancy concepts:

```typescript
// packages/state-api/src/teams-multi-tenancy/domain.ts

export const TeamsMultiTenancyDomain = scope({
  User: {
    id: "string.uuid",
    email: "string",
    name: "string",
  },
  Tenant: {
    id: "string.uuid",
    name: "string",
    "sso_settings?": "string",
  },
  Workspace: {
    id: "string.uuid",
    name: "string",
    tenant_id: "Tenant",           // Who controls this workspace
    billing_account_id: "BillingAccount", // Who pays
  },
  // ...
})
```

**Impact:** We can leverage this model for workspace provisioning.

### 2.4 Workspace Parameter

Tools already support workspace isolation:

```typescript
// packages/mcp/src/tools/schema.set.ts

const effectiveWorkspace = getEffectiveWorkspace(workspace)
// ...
cacheRuntimeStore(schema.id, runtimeStore, effectiveWorkspace)

// packages/mcp/src/tools/store.create.ts

const runtimeStore = getRuntimeStore(schemaEntity.id, effectiveWorkspace)
```

**Impact:** Minimal changes needed for workspace-scoped operations.

---

## 3. Target Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS Account                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                              VPC                                        │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │                         EKS Cluster                               │  │ │
│  │  │                                                                   │  │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │ │
│  │  │  │                    shogo-system namespace                    │ │  │ │
│  │  │  │  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐  │ │  │ │
│  │  │  │  │  shogo-web    │  │  shogo-api    │  │   workspace     │  │ │  │ │
│  │  │  │  │  (Deployment) │  │  (Deployment) │  │   operator      │  │ │  │ │
│  │  │  │  │  replicas: 2  │  │  replicas: 2  │  │  (Deployment)   │  │ │  │ │
│  │  │  │  └───────────────┘  └───────────────┘  └─────────────────┘  │ │  │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │  │ │
│  │  │                                                                   │  │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │ │
│  │  │  │              shogo-workspaces namespace                      │ │  │ │
│  │  │  │                                                              │ │  │ │
│  │  │  │  ┌─────────────────────┐  ┌─────────────────────┐           │ │  │ │
│  │  │  │  │ Knative Service:    │  │ Knative Service:    │           │ │  │ │
│  │  │  │  │ mcp-workspace-abc   │  │ mcp-workspace-xyz   │  ...      │ │  │ │
│  │  │  │  │ ┌─────────────────┐ │  │ ┌─────────────────┐ │           │ │  │ │
│  │  │  │  │ │ shogo-mcp pod   │ │  │ │ shogo-mcp pod   │ │           │ │  │ │
│  │  │  │  │ │ (or scaled to 0)│ │  │ │ (or scaled to 0)│ │           │ │  │ │
│  │  │  │  │ └─────────────────┘ │  │ └─────────────────┘ │           │ │  │ │
│  │  │  │  │ ┌─────────────────┐ │  │ ┌─────────────────┐ │           │ │  │ │
│  │  │  │  │ │ PVC: 1GB EBS    │ │  │ │ PVC: 1GB EBS    │ │           │ │  │ │
│  │  │  │  │ └─────────────────┘ │  │ └─────────────────┘ │           │ │  │ │
│  │  │  │  └─────────────────────┘  └─────────────────────┘           │ │  │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │  │ │
│  │  │                                                                   │  │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │ │
│  │  │  │                     Knative Serving                         │ │  │ │
│  │  │  │            (Scale-to-zero, revision management)             │ │  │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │  │ │
│  │  │                                                                   │  │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │ │
│  │  │  │                AWS Load Balancer Controller                  │ │  │ │
│  │  │  │    *.workspaces.shogo.io → workspace Knative services       │ │  │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │  │ │
│  │  └──────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                         │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐│ │
│  │  │ RDS PostgreSQL  │  │   ElastiCache   │  │         ECR            ││ │
│  │  │  (shared, RLS)  │  │    (Redis)      │  │  (container images)    ││ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────────┘│ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                            Route 53                                      ││
│  │  *.workspaces.shogo.io → ALB                                            ││
│  │  app.shogo.io → ALB                                                     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Request Flow

```
┌─────────┐     ┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  User   │────▶│  CloudFront │────▶│   ALB Ingress    │────▶│ Knative Service  │
│ Browser │     │    (CDN)    │     │                  │     │ mcp-{workspace}  │
└─────────┘     └─────────────┘     └──────────────────┘     └──────────────────┘
                                             │                        │
                                    ┌────────┴────────┐               │
                                    │                 │               │
                              ┌─────▼─────┐     ┌─────▼─────┐   ┌─────▼─────┐
                              │ shogo-web │     │ shogo-api │   │ shogo-mcp │
                              │ (static)  │     │ (shared)  │   │ (per-ws)  │
                              └───────────┘     └───────────┘   └─────┬─────┘
                                                                      │
                                                              ┌───────┴───────┐
                                                              │               │
                                                        ┌─────▼─────┐  ┌──────▼──────┐
                                                        │   PVC     │  │   RDS       │
                                                        │ (schemas) │  │ (entities)  │
                                                        └───────────┘  └─────────────┘
```

### 3.3 Workspace Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Workspace Lifecycle                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────┐    ┌──────────────────────────────────────────────────────┐   │
│   │  User   │───▶│  1. Create Workspace (via API)                       │   │
│   │ Request │    │     POST /api/workspaces { name: "my-project" }      │   │
│   └─────────┘    └──────────────────────────────────────────────────────┘   │
│                                        │                                     │
│                                        ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  2. Workspace Operator receives event                                 │  │
│   │     - Creates PersistentVolumeClaim (1GB EBS)                        │  │
│   │     - Creates Kubernetes Secret (DB credentials)                      │  │
│   │     - Creates Knative Service (mcp-{workspace_id})                   │  │
│   │     - Creates DNS record (optional, or wildcard)                     │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                        │                                     │
│                                        ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  3. Workspace Ready                                                   │  │
│   │     URL: https://{workspace_id}.workspaces.shogo.io                  │  │
│   │     Status: Scaled to 0 (waiting for first request)                  │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                        │                                     │
│                    ┌───────────────────┴───────────────────┐                │
│                    ▼                                       ▼                │
│   ┌────────────────────────────────┐    ┌────────────────────────────────┐ │
│   │  4a. First Request (Cold Start)│    │  4b. Subsequent Requests       │ │
│   │  - Knative scales pod 0 → 1    │    │  - Pod already running         │ │
│   │  - Pod mounts PVC              │    │  - Request served immediately  │ │
│   │  - MCP loads schemas from disk │    │  - ~10ms latency               │ │
│   │  - ~5-15s latency              │    │                                │ │
│   └────────────────────────────────┘    └────────────────────────────────┘ │
│                                        │                                     │
│                                        ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  5. Idle Timeout (configurable, default 10 minutes)                  │  │
│   │     - Knative scales pod 1 → 0                                       │  │
│   │     - PVC persists (data safe)                                       │  │
│   │     - Cost: ~$0.10/month (storage only)                              │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Domain Architecture

### 4.1 Domain Separation

The platform uses a **two-tier data architecture** that separates control plane data (shared) from workspace data (isolated):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DATA DOMAIN ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      CONTROL PLANE (Shared)                            │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │ │
│  │  │  studio-core     │  │  better-auth     │  │  system-migrations   │ │ │
│  │  │  ────────────    │  │  ──────────      │  │  ─────────────────   │ │ │
│  │  │  Organization    │  │  User            │  │  MigrationRecord     │ │ │
│  │  │  Team            │  │  Session         │  │  (DDL tracking)      │ │ │
│  │  │  Project         │  │  Account         │  │                      │ │ │
│  │  │  Member          │  │  Verification    │  │                      │ │ │
│  │  │  BillingAccount  │  │                  │  │                      │ │ │
│  │  │  Invitation      │  │                  │  │                      │ │ │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────────┘ │ │
│  │                                                                        │ │
│  │  Storage: Shared PostgreSQL (RDS) with RLS by tenant_id               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      PER-WORKSPACE (Isolated)                          │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │ │
│  │  │ platform-features│  │  studio-chat     │  │  user-schemas        │ │ │
│  │  │ ────────────────-│  │  ───────────     │  │  ────────────        │ │ │
│  │  │ FeatureSession   │  │  ChatSession     │  │  (dynamic schemas    │ │ │
│  │  │ Requirement      │  │  ChatMessage     │  │   created by users   │ │ │
│  │  │ DesignDecision   │  │  ToolCallLog     │  │   via schema.set)    │ │ │
│  │  │ AnalysisFinding  │  │                  │  │                      │ │ │
│  │  │ IntegrationPoint │  │                  │  │                      │ │ │
│  │  │ TestCase         │  │                  │  │                      │ │ │
│  │  │ TestSpecification│  │                  │  │                      │ │ │
│  │  │ ImplementationRun│  │                  │  │                      │ │ │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────────┘ │ │
│  │                                                                        │ │
│  │  Storage: PVC (filesystem) + workspace-scoped PostgreSQL rows         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Control Plane Domains

#### 4.2.1 studio-core Domain

Defines the multi-tenant organizational structure:

```typescript
// packages/state-api/src/studio-core/domain.ts

export const StudioCoreDomain = scope({
  Organization: {
    id: "string.uuid",
    name: "string",
    slug: "string",
    plan: "'free' | 'pro' | 'enterprise'",
    created_at: "Date",
  },
  Team: {
    id: "string.uuid",
    organization_id: "Organization",
    name: "string",
    slug: "string",
  },
  Project: {
    id: "string.uuid",
    organization_id: "Organization",
    "team_id?": "Team",
    name: "string",
    slug: "string",
    settings: "object",
  },
  Member: {
    id: "string.uuid",
    user_id: "string.uuid",
    "organization_id?": "Organization",
    "team_id?": "Team",
    "project_id?": "Project",
    role: "'owner' | 'admin' | 'member' | 'viewer'",
  },
  // ...
})
```

**Key Features:**
- Hierarchical permissions: Organization → Team → Project
- Computed `level` view for permission inheritance
- `resolvePermissions` action for RBAC checks

#### 4.2.2 better-auth Domain

Handles authentication via BetterAuth:

```typescript
// apps/api/src/auth.ts
import { betterAuth } from 'better-auth'

export const auth = betterAuth({
  database: /* PostgreSQL adapter */,
  emailAndPassword: { enabled: true },
  socialProviders: {
    github: { clientId, clientSecret },
    google: { clientId, clientSecret },
  },
})
```

**Key Features:**
- Self-hostable authentication
- OAuth provider support
- Session management

#### 4.2.3 system-migrations Domain

Tracks DDL migrations across the platform:

```typescript
// packages/state-api/src/ddl/migration-tracker.ts

export async function recordMigration(migration: {
  schemaId: string
  version: string
  checksum: string
  name: string
  appliedAt: Date
}) {
  // Records migration to system-migrations store
}

export async function isMigrationApplied(
  schemaId: string,
  version: string
): Promise<boolean> {
  // Checks if migration already applied
}
```

### 4.3 Per-Workspace Domains

#### 4.3.1 platform-features Domain

Tracks feature development lifecycle per workspace:

```typescript
// packages/state-api/src/platform-features/domain.ts

export const PlatformFeaturesDomain = scope({
  FeatureSession: {
    id: "string.uuid",
    feature_name: "string",
    description: "string",
    status: "'discovery' | 'spec' | 'design' | 'analysis' | 'implementation' | 'tests' | 'complete'",
  },
  Requirement: {
    id: "string.uuid",
    session_id: "FeatureSession",
    type: "'functional' | 'non-functional' | 'constraint'",
    description: "string",
    priority: "'must' | 'should' | 'could' | 'wont'",
  },
  // ... 10+ entity types for full development lifecycle
})
```

#### 4.3.2 studio-chat Domain

Stores chat history and tool call logs:

```typescript
// packages/state-api/src/studio-chat/domain.ts

export const StudioChatDomain = scope({
  ChatSession: {
    id: "string.uuid",
    feature_context: "string",
    phase: "string",
    title: "string",
    started_at: "Date",
  },
  ChatMessage: {
    id: "string.uuid",
    session_id: "ChatSession",
    role: "'user' | 'assistant' | 'system'",
    content: "string",
    timestamp: "Date",
  },
  ToolCallLog: {
    id: "string.uuid",
    message_id: "ChatMessage",
    tool_name: "string",
    input: "object",
    output: "object",
    status: "'pending' | 'success' | 'error'",
  },
})
```

### 4.4 Seed Initialization

The MCP server automatically seeds control plane data on startup:

```typescript
// packages/mcp/src/seed-init.ts

export async function initializeSeedData(schemasPath: string) {
  // 1. Load studio-core schema
  // 2. Check if "Shogo" organization exists
  // 3. If not, create seed data:
  //    - Organization: "Shogo"
  //    - Project: "Platform" (for core development)
  // 4. Persist to filesystem + PostgreSQL
}
```

This ensures every deployment has:
- A default organization for platform development
- Consistent schema structure across environments

### 4.5 Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REQUEST FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User Request                                                               │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  BetterAuth (apps/api/src/auth.ts)                                  │   │
│  │  - Validates session                                                │   │
│  │  - Extracts user_id, organization_id                                │   │
│  └────────────────────────────────────────────────────────────────────-┘   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Control Plane Check (studio-core)                                  │   │
│  │  - Verify member has access to workspace                            │   │
│  │  - resolvePermissions(user_id, project_id)                          │   │
│  └────────────────────────────────────────────────────────────────────-┘   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Workspace MCP (per-workspace pod)                                  │   │
│  │  - Routes to workspace-specific Knative Service                     │   │
│  │  - WORKSPACE_ID, TENANT_ID env vars set                             │   │
│  │  - All schema/store operations scoped to workspace                  │   │
│  └────────────────────────────────────────────────────────────────────-┘   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Data Access                                                        │   │
│  │  - PVC: /data/schemas/{schema-id}/                                  │   │
│  │  - PostgreSQL: RLS with workspace_id                                │   │
│  └────────────────────────────────────────────────────────────────────-┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Component Changes

### 5.1 New Components to Create

#### 5.1.1 Dockerfiles

**packages/mcp/Dockerfile**
```dockerfile
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package.json bun.lock ./
COPY packages/state-api/package.json ./packages/state-api/
COPY packages/mcp/package.json ./packages/mcp/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY packages/state-api ./packages/state-api
COPY packages/mcp ./packages/mcp
COPY tsconfig.base.json ./

# Build
RUN bun run build --filter=@shogo/mcp

# Production image
FROM oven/bun:1.2-alpine

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/packages/mcp/dist ./dist
COPY --from=builder /app/packages/state-api/dist ./packages/state-api/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/mcp/package.json ./

# Create data directory for schemas
RUN mkdir -p /data/schemas

ENV NODE_ENV=production
ENV SCHEMAS_PATH=/data/schemas

EXPOSE 3100

CMD ["bun", "run", "dist/server-http.js"]
```

**apps/web/Dockerfile**
```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY packages/state-api/package.json ./packages/state-api/

RUN npm install -g bun && bun install --frozen-lockfile

COPY apps/web ./apps/web
COPY packages/state-api ./packages/state-api
COPY tsconfig.base.json ./

WORKDIR /app/apps/web
RUN bun run build

# Nginx for serving static files
FROM nginx:alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
```

**apps/api/Dockerfile**
```dockerfile
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY packages/state-api/package.json ./packages/state-api/

RUN bun install --frozen-lockfile

COPY apps/api ./apps/api
COPY packages/state-api ./packages/state-api
COPY tsconfig.base.json ./

RUN bun run build --filter=@shogo/api

FROM oven/bun:1.2-alpine

WORKDIR /app

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./

ENV NODE_ENV=production
EXPOSE 8002

CMD ["bun", "run", "dist/server.js"]
```

#### 5.1.2 Workspace Operator

**packages/workspace-operator/src/types.ts**
```typescript
/**
 * Workspace Custom Resource Definition
 */
export interface WorkspaceSpec {
  /** Display name for the workspace */
  name: string
  
  /** Owner tenant ID */
  tenantId: string
  
  /** Owner user ID */
  userId: string
  
  /** Storage size (default: 1Gi) */
  storageSize?: string
  
  /** Memory limit (default: 512Mi) */
  memoryLimit?: string
  
  /** CPU limit (default: 500m) */
  cpuLimit?: string
  
  /** Idle timeout before scale-to-zero (default: 10m) */
  idleTimeout?: string
}

export interface WorkspaceStatus {
  /** Current phase: Provisioning, Ready, Hibernating, Failed */
  phase: 'Provisioning' | 'Ready' | 'Hibernating' | 'Failed'
  
  /** Workspace URL when ready */
  url?: string
  
  /** Error message if failed */
  error?: string
  
  /** Last activity timestamp */
  lastActivity?: string
  
  /** Current replica count (0 or 1) */
  replicas?: number
}

export interface Workspace {
  apiVersion: 'shogo.io/v1'
  kind: 'Workspace'
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, string>
  }
  spec: WorkspaceSpec
  status?: WorkspaceStatus
}
```

**packages/workspace-operator/src/controller.ts**
```typescript
import * as k8s from '@kubernetes/client-node'

export class WorkspaceController {
  private k8sApi: k8s.CoreV1Api
  private customApi: k8s.CustomObjectsApi
  private knativeApi: k8s.CustomObjectsApi

  constructor() {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.knativeApi = kc.makeApiClient(k8s.CustomObjectsApi)
  }

  /**
   * Reconcile a Workspace resource
   */
  async reconcile(workspace: Workspace): Promise<void> {
    const { name } = workspace.metadata
    const { tenantId, userId, storageSize, memoryLimit, cpuLimit, idleTimeout } = workspace.spec

    try {
      // 1. Create PersistentVolumeClaim
      await this.ensurePVC(name, storageSize || '1Gi')

      // 2. Create Secret with workspace configuration
      await this.ensureSecret(name, tenantId, userId)

      // 3. Create Knative Service
      await this.ensureKnativeService(name, {
        memoryLimit: memoryLimit || '512Mi',
        cpuLimit: cpuLimit || '500m',
        idleTimeout: idleTimeout || '10m',
      })

      // 4. Update status
      await this.updateStatus(name, {
        phase: 'Ready',
        url: `https://${name}.workspaces.shogo.io`,
        replicas: 0,
      })
    } catch (error: any) {
      await this.updateStatus(name, {
        phase: 'Failed',
        error: error.message,
      })
    }
  }

  private async ensurePVC(name: string, size: string): Promise<void> {
    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: `pvc-${name}`,
        namespace: 'shogo-workspaces',
        labels: {
          'app.kubernetes.io/part-of': 'shogo',
          'shogo.io/workspace': name,
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'gp3',
        resources: {
          requests: { storage: size },
        },
      },
    }

    try {
      await this.k8sApi.createNamespacedPersistentVolumeClaim('shogo-workspaces', pvc)
    } catch (e: any) {
      if (e.statusCode !== 409) throw e // Ignore already exists
    }
  }

  private async ensureKnativeService(name: string, config: any): Promise<void> {
    const service = {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {
        name: `mcp-${name}`,
        namespace: 'shogo-workspaces',
        labels: {
          'app.kubernetes.io/part-of': 'shogo',
          'shogo.io/workspace': name,
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              'autoscaling.knative.dev/scale-to-zero-pod-retention-period': config.idleTimeout,
              'autoscaling.knative.dev/max-scale': '1',
              'autoscaling.knative.dev/min-scale': '0',
            },
          },
          spec: {
            timeoutSeconds: 60,
            containers: [{
              image: process.env.MCP_IMAGE || 'ghcr.io/your-org/shogo-mcp:latest',
              ports: [{ containerPort: 3100 }],
              env: [
                { name: 'WORKSPACE_ID', value: name },
                { name: 'SCHEMAS_PATH', value: '/data/schemas' },
                {
                  name: 'DATABASE_URL',
                  valueFrom: {
                    secretKeyRef: { name: `workspace-${name}`, key: 'database-url' },
                  },
                },
              ],
              volumeMounts: [{
                name: 'workspace-data',
                mountPath: '/data',
              }],
              resources: {
                limits: {
                  memory: config.memoryLimit,
                  cpu: config.cpuLimit,
                },
                requests: {
                  memory: '128Mi',
                  cpu: '100m',
                },
              },
            }],
            volumes: [{
              name: 'workspace-data',
              persistentVolumeClaim: { claimName: `pvc-${name}` },
            }],
          },
        },
      },
    }

    try {
      await this.knativeApi.createNamespacedCustomObject(
        'serving.knative.dev',
        'v1',
        'shogo-workspaces',
        'services',
        service
      )
    } catch (e: any) {
      if (e.statusCode !== 409) throw e
    }
  }

  // ... additional methods
}
```

### 5.2 Code Modifications

#### 5.2.1 MCP Server - Workspace-Aware Startup

**packages/mcp/src/server-workspace.ts** (new file)
```typescript
import { FastMCP } from "fastmcp"
import { join } from "node:path"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend } from "./postgres-init"
import { initializeDomainSchemas } from "./ddl-init"

// Environment configuration
const WORKSPACE_ID = process.env.WORKSPACE_ID
const TENANT_ID = process.env.TENANT_ID
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/data/schemas'

// Validate workspace mode
if (!WORKSPACE_ID) {
  console.log('[mcp] No WORKSPACE_ID set - running in standalone mode')
}

console.log(`[mcp] Starting MCP server`)
console.log(`[mcp] Workspace: ${WORKSPACE_ID || 'standalone'}`)
console.log(`[mcp] Schemas path: ${SCHEMAS_PATH}`)

// Initialize backends
await initializePostgresBackend()
await initializeDomainSchemas(SCHEMAS_PATH)

const server = new FastMCP({
  name: WORKSPACE_ID ? `wavesmith-mcp-${WORKSPACE_ID}` : 'wavesmith-mcp',
  version: "0.0.1",
})

// Health check endpoint
server.addTool({
  name: 'health',
  description: 'Health check',
  parameters: {},
  execute: async () => JSON.stringify({
    status: 'healthy',
    workspace: WORKSPACE_ID || 'standalone',
    uptime: process.uptime(),
    schemas_path: SCHEMAS_PATH,
  }),
})

// Register all tools
registerAllTools(server)

// Start server
server.start({
  transportType: "httpStream",
  httpStream: {
    port: 3100,
    endpoint: "/mcp",
  },
})

console.log(`[mcp] Server ready on http://localhost:3100`)
```

#### 5.2.2 State Module - Configurable Schemas Path

**packages/mcp/src/state.ts** (modify)
```typescript
// Current
const DEFAULT_SCHEMAS_LOCATION = join(import.meta.dir, "../../../.schemas")

// New: Environment-aware default
export function getDefaultSchemasLocation(): string {
  return process.env.SCHEMAS_PATH || join(import.meta.dir, "../../../.schemas")
}

export function getEffectiveWorkspace(workspace?: string): string {
  if (workspace) return workspace
  return getDefaultSchemasLocation()
}
```

### 5.3 Database Changes

#### 5.3.1 Row-Level Security for Multi-Tenancy

```sql
-- Enable RLS on all data tables
ALTER TABLE schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- Create policy for workspace isolation
CREATE POLICY workspace_isolation ON entities
  USING (workspace_id = current_setting('app.workspace_id')::uuid);

-- Function to set workspace context
CREATE OR REPLACE FUNCTION set_workspace_context(workspace_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.workspace_id', workspace_id::text, false);
END;
$$ LANGUAGE plpgsql;
```

#### 5.3.2 Connection Middleware

```typescript
// packages/state-api/src/query/execution/workspace-middleware.ts

export function createWorkspaceMiddleware(workspaceId: string) {
  return async (executor: ISQLExecutor) => {
    await executor.execute(`SELECT set_workspace_context($1)`, [workspaceId])
  }
}
```

---

## 6. Infrastructure as Code

### 6.1 Terraform Module Structure

```
terraform/
├── modules/
│   ├── vpc/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── eks/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── iam.tf
│   ├── rds/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── ecr/
│   │   ├── main.tf
│   │   └── outputs.tf
│   └── knative/
│       ├── main.tf
│       └── variables.tf
├── environments/
│   ├── dev/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── terraform.tfvars
│   ├── staging/
│   │   └── ...
│   └── prod/
│       └── ...
└── README.md
```

### 6.2 Core Terraform Modules

**terraform/modules/eks/main.tf**
```hcl
# EKS Cluster
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = true
    security_group_ids      = [aws_security_group.eks_cluster.id]
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  tags = var.tags
}

# Managed Node Group
resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-main"
  node_role_arn   = aws_iam_role.eks_node.arn
  subnet_ids      = var.subnet_ids

  scaling_config {
    desired_size = var.node_desired_size
    max_size     = var.node_max_size
    min_size     = var.node_min_size
  }

  instance_types = var.node_instance_types

  # Enable spot instances for cost savings
  capacity_type = var.use_spot_instances ? "SPOT" : "ON_DEMAND"

  labels = {
    "node.kubernetes.io/purpose" = "workloads"
  }

  tags = var.tags
}

# EBS CSI Driver for PersistentVolumes
resource "aws_eks_addon" "ebs_csi" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "aws-ebs-csi-driver"
  
  service_account_role_arn = aws_iam_role.ebs_csi.arn
}

# OIDC Provider for IRSA
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
```

**terraform/modules/eks/variables.tf**
```hcl
variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.29"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the cluster"
  type        = list(string)
}

variable "node_instance_types" {
  description = "Instance types for worker nodes"
  type        = list(string)
  default     = ["t3.medium", "t3.large"]
}

variable "node_desired_size" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 10
}

variable "use_spot_instances" {
  description = "Use spot instances for worker nodes"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
```

**terraform/environments/dev/main.tf**
```hcl
terraform {
  required_version = ">= 1.5.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.11"
    }
  }
  
  backend "s3" {
    bucket         = "shogo-terraform-state"
    key            = "dev/terraform.tfstate"
    region         = "us-west-2"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = {
      Environment = "dev"
      Project     = "shogo"
      ManagedBy   = "terraform"
    }
  }
}

# VPC
module "vpc" {
  source = "../../modules/vpc"
  
  name               = "shogo-dev"
  cidr               = "10.0.0.0/16"
  availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c"]
  
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
  
  enable_nat_gateway = true
  single_nat_gateway = true  # Cost optimization for dev
}

# EKS Cluster
module "eks" {
  source = "../../modules/eks"
  
  cluster_name       = "shogo-dev"
  kubernetes_version = "1.29"
  
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids
  
  node_instance_types = ["t3.medium"]
  node_desired_size   = 2
  node_min_size       = 1
  node_max_size       = 5
  use_spot_instances  = true
}

# RDS PostgreSQL
module "rds" {
  source = "../../modules/rds"
  
  identifier = "shogo-dev"
  
  engine_version    = "16.1"
  instance_class    = "db.t3.medium"
  allocated_storage = 20
  
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.private_subnet_ids
  security_group_ids = [module.eks.cluster_security_group_id]
  
  database_name = "shogo"
  username      = "shogo_admin"
  
  # Dev: disable deletion protection
  deletion_protection = false
  skip_final_snapshot = true
}

# ECR Repositories
module "ecr" {
  source = "../../modules/ecr"
  
  repositories = ["shogo-web", "shogo-api", "shogo-mcp", "workspace-operator"]
}

# Install Knative
module "knative" {
  source = "../../modules/knative"
  
  depends_on = [module.eks]
  
  cluster_name = module.eks.cluster_name
}

# Outputs
output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "database_endpoint" {
  value     = module.rds.endpoint
  sensitive = true
}

output "ecr_urls" {
  value = module.ecr.repository_urls
}
```

### 6.3 Knative Installation Module

**terraform/modules/knative/main.tf**
```hcl
# Install Knative Serving via Helm
resource "helm_release" "knative_operator" {
  name       = "knative-operator"
  repository = "https://knative.github.io/operator"
  chart      = "knative-operator"
  version    = "1.12.0"
  namespace  = "knative-operator"
  
  create_namespace = true
  
  wait = true
}

# Knative Serving instance
resource "kubernetes_manifest" "knative_serving" {
  depends_on = [helm_release.knative_operator]
  
  manifest = {
    apiVersion = "operator.knative.dev/v1beta1"
    kind       = "KnativeServing"
    metadata = {
      name      = "knative-serving"
      namespace = "knative-serving"
    }
    spec = {
      config = {
        autoscaler = {
          enable-scale-to-zero = "true"
          scale-to-zero-grace-period = "30s"
          scale-to-zero-pod-retention-period = "0s"
        }
        defaults = {
          container-concurrency = "100"
        }
      }
    }
  }
}

# Create shogo-workspaces namespace
resource "kubernetes_namespace" "shogo_workspaces" {
  metadata {
    name = "shogo-workspaces"
    labels = {
      "app.kubernetes.io/part-of" = "shogo"
    }
  }
}

# StorageClass for workspace PVCs
resource "kubernetes_storage_class" "gp3" {
  metadata {
    name = "gp3"
    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "true"
    }
  }
  
  storage_provisioner = "ebs.csi.aws.com"
  reclaim_policy      = "Retain"
  volume_binding_mode = "WaitForFirstConsumer"
  
  parameters = {
    type      = "gp3"
    encrypted = "true"
  }
}
```

---

## 7. Local Development

### 7.1 Docker Compose

See the `docker-compose.yml` file at the root of the repository for the complete local development setup. Key services:

- **postgres**: PostgreSQL 16 database (shared control plane + workspace data)
- **minio**: S3-compatible storage for future cloud parity
- **redis**: Session cache for BetterAuth
- **mcp**: MCP server with configurable ports and workspace isolation
- **api**: Hono API server with BetterAuth integration
- **web**: React frontend (Vite)

### 7.2 Development Scripts

**scripts/dev.sh**
```bash
#!/bin/bash
set -e

echo "🚀 Starting Shogo development environment..."

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Start services
docker-compose up -d

# Wait for services
echo "⏳ Waiting for services to be ready..."
sleep 5

# Check health
echo "🔍 Checking service health..."

# Postgres
until docker-compose exec -T postgres pg_isready -U shogo; do
  sleep 1
done
echo "✅ PostgreSQL is ready"

# MCP
until curl -s http://localhost:3100/health > /dev/null; do
  sleep 1
done
echo "✅ MCP server is ready"

echo ""
echo "🎉 Shogo is running!"
echo ""
echo "   Web:  http://localhost:3000"
echo "   API:  http://localhost:8002"
echo "   MCP:  http://localhost:3100"
echo ""
echo "To stop: docker-compose down"
```

### 7.3 Local Kubernetes (Optional)

For testing Kubernetes manifests locally:

**scripts/dev-k8s.sh**
```bash
#!/bin/bash
set -e

echo "🚀 Starting local Kubernetes environment..."

# Install k3d if not present
if ! command -v k3d &> /dev/null; then
    echo "Installing k3d..."
    curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
fi

# Create cluster
k3d cluster create shogo-dev \
  --port "3000:80@loadbalancer" \
  --port "8002:8002@loadbalancer" \
  --port "3100:3100@loadbalancer" \
  --agents 2

# Install Knative
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-crds.yaml
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-core.yaml
kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v1.12.0/kourier.yaml

# Configure Knative
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Apply Shogo manifests
kubectl apply -f k8s/

echo "✅ Local Kubernetes ready!"
```

---

## 8. Deployment Pipeline

### 8.1 GitHub Actions

**.github/workflows/deploy.yml**
```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  AWS_REGION: us-west-2

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        
      - name: Install dependencies
        run: bun install --frozen-lockfile
        
      - name: Run tests
        run: bun run test
        
      - name: Build
        run: bun run build

  docker:
    needs: build
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    
    strategy:
      matrix:
        service: [web, api, mcp]
        include:
          - service: web
            context: .
            dockerfile: apps/web/Dockerfile
          - service: api
            context: .
            dockerfile: apps/api/Dockerfile
          - service: mcp
            context: .
            dockerfile: packages/mcp/Dockerfile
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Login to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2
      
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ${{ steps.ecr-login.outputs.registry }}/shogo-${{ matrix.service }}:${{ github.sha }}
            ${{ steps.ecr-login.outputs.registry }}/shogo-${{ matrix.service }}:latest

  deploy:
    needs: docker
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name shogo-dev
      
      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/shogo-web \
            shogo-web=${{ secrets.ECR_REGISTRY }}/shogo-web:${{ github.sha }} \
            -n shogo-system
          
          kubectl set image deployment/shogo-api \
            shogo-api=${{ secrets.ECR_REGISTRY }}/shogo-api:${{ github.sha }} \
            -n shogo-system
          
          # Update workspace operator to use new MCP image
          kubectl set env deployment/workspace-operator \
            MCP_IMAGE=${{ secrets.ECR_REGISTRY }}/shogo-mcp:${{ github.sha }} \
            -n shogo-system
```

---

## 9. Security Considerations

### 9.1 Network Policies

```yaml
# k8s/network-policies.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: workspace-isolation
  namespace: shogo-workspaces
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Only allow traffic from Knative ingress
    - from:
        - namespaceSelector:
            matchLabels:
              app.kubernetes.io/component: net-kourier
      ports:
        - port: 3100
  egress:
    # Allow DNS
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
    # Allow RDS
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8
      ports:
        - port: 5432
```

### 9.2 Pod Security Standards

```yaml
# k8s/pod-security.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shogo-workspaces
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### 9.3 Secrets Management

- Use AWS Secrets Manager for sensitive credentials
- External Secrets Operator to sync to Kubernetes
- Per-workspace database credentials

---

## 10. Cost Analysis

### 10.1 Fixed Infrastructure Costs (Monthly)

| Resource | Configuration | Cost |
|----------|--------------|------|
| EKS Control Plane | 1 cluster | $73 |
| NAT Gateway | 1 (single AZ for dev) | $45 |
| ALB | 1 load balancer | $22 |
| RDS PostgreSQL | db.t3.medium | $50 |
| Route 53 | 1 hosted zone | $0.50 |
| **Fixed Total** | | **~$190/mo** |

### 10.2 Variable Costs (Per Workspace)

| State | Resources | Cost/mo |
|-------|-----------|---------|
| **Active** (pod running) | 0.25 vCPU, 512MB + 1GB EBS | ~$15 |
| **Idle** (scaled to zero) | 1GB EBS only | ~$0.10 |
| **Hibernated** (PVC snapshot) | S3 snapshot | ~$0.02 |

### 10.3 Cost Projections

| Workspaces | Active (10%) | Idle (90%) | Total/mo |
|------------|--------------|------------|----------|
| 10 | $15 | $0.90 | $206 |
| 100 | $150 | $9 | $349 |
| 1,000 | $1,500 | $90 | $1,780 |
| 10,000 | $15,000 | $900 | $16,090 |

---

## 11. Future Multi-Cloud Support

### 11.1 Abstraction Points

The architecture is designed for cloud portability:

| Component | AWS | GCP | Azure | Self-Hosted |
|-----------|-----|-----|-------|-------------|
| Kubernetes | EKS | GKE | AKS | k3s/k0s |
| Storage | EBS | Persistent Disk | Azure Disk | Local PV |
| Database | RDS | Cloud SQL | Azure DB | PostgreSQL |
| Load Balancer | ALB | Cloud LB | Azure LB | Nginx |
| Container Registry | ECR | GCR/Artifact | ACR | Harbor |

### 11.2 Terraform Provider Abstraction

```hcl
# terraform/modules/kubernetes/main.tf

# Generic Kubernetes resources that work across clouds
resource "kubernetes_namespace" "shogo_system" {
  metadata {
    name = "shogo-system"
  }
}

# Cloud-specific storage class (passed in as variable)
resource "kubernetes_storage_class" "default" {
  metadata {
    name = "shogo-storage"
  }
  
  storage_provisioner = var.storage_provisioner
  parameters          = var.storage_parameters
}
```

### 11.3 Version 2 Roadmap

1. **GCP Support** - Terraform modules for GKE
2. **Azure Support** - Terraform modules for AKS
3. **Self-Hosted** - k3s installer script
4. **Helm Chart** - Portable Kubernetes deployment

---

## 12. Appendix

### 12.1 Environment Variables

| Variable | Service | Description | Default |
|----------|---------|-------------|---------|
| `WORKSPACE_ID` | mcp | Workspace identifier | (none - standalone mode) |
| `TENANT_ID` | mcp | Tenant identifier for multi-tenancy | (none) |
| `SCHEMAS_PATH` | mcp | Path to schemas directory | `/data/schemas` |
| `DATABASE_URL` | mcp, api | PostgreSQL connection string | (required) |
| `MCP_PORT` | mcp | HTTP port for MCP server | `3100` |
| `API_PORT` | api | HTTP port for API server | `8002` |
| `VITE_PORT` | web | Dev server port (build-time) | `3000` |
| `VITE_API_URL` | web | API server URL (build-time) | `http://localhost:8002` |
| `VITE_MCP_URL` | web | MCP server URL (build-time) | `http://localhost:3100` |
| `VITE_BETTER_AUTH_URL` | web | BetterAuth URL (build-time) | `http://localhost:8002` |
| `MCP_IMAGE` | operator | Container image for workspace MCP | `ghcr.io/.../shogo-mcp:latest` |

### 12.2 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/workspaces` | Create a new workspace |
| `GET /api/workspaces` | List user's workspaces |
| `GET /api/workspaces/:id` | Get workspace details |
| `DELETE /api/workspaces/:id` | Delete workspace |
| `POST /api/workspaces/:id/hibernate` | Scale to zero |
| `POST /api/workspaces/:id/wake` | Scale to one |

### 12.3 Monitoring Metrics

| Metric | Description |
|--------|-------------|
| `shogo_workspaces_total` | Total workspaces |
| `shogo_workspaces_active` | Currently active (pod running) |
| `shogo_workspace_cold_start_seconds` | Cold start latency |
| `shogo_workspace_requests_total` | Requests per workspace |

### 12.4 References

- [Knative Documentation](https://knative.dev/docs/)
- [AWS EKS Best Practices](https://aws.github.io/aws-eks-best-practices/)
- [Terraform AWS Provider](https://registry.terraform.io/providers/hashicorp/aws/latest)
- [MobX-State-Tree](https://mobx-state-tree.js.org/)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Dec 2025 | Infrastructure Team | Initial draft |
| 1.1 | Jan 2026 | Infrastructure Team | Added Data Domain Architecture (Section 4), updated env vars for MCP_PORT/API_PORT/VITE_PORT, added BetterAuth integration, removed Migration Plan (not deployed yet) |

