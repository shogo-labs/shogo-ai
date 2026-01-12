# Pod-per-Workspace Architecture - Review Summary

**For:** Development Team Review  
**Date:** January 2026  
**Status:** Ready for Review

---

## TL;DR

We're proposing to deploy Shogo on **AWS EKS** with a **hybrid control plane + workspace** model:

- **Control Plane** (shared): Organizations, Teams, Auth (BetterAuth), Migrations
- **Per-Workspace** (isolated): Feature sessions, chat history, user schemas

Each workspace gets its own MCP server pod that can **scale to zero** when idle.

**Key Benefits:**
- ✅ Shared control plane for org/team management
- ✅ Complete workspace data isolation  
- ✅ Cost-effective (idle workspaces cost ~$0.10/month)
- ✅ Preserves existing stateful MCP architecture
- ✅ Works locally with docker-compose
- ✅ Designed for future multi-cloud support

---

## Data Domain Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE (Shared PostgreSQL)                                  │
│  ├── studio-core: Organization, Team, Project, Member, Billing      │
│  ├── better-auth: User, Session, Account, Verification             │
│  └── system-migrations: DDL migration tracking                      │
├─────────────────────────────────────────────────────────────────────┤
│  PER-WORKSPACE (Isolated PVC + Scoped PostgreSQL)                   │
│  ├── platform-features: FeatureSession, Requirements, Tests, etc.  │
│  ├── studio-chat: ChatSession, ChatMessage, ToolCallLog            │
│  └── user-schemas: Dynamically created via schema.set              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Decision

### Why Pod-per-Workspace?

We considered three options:

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Shared MCP + External State** | True serverless, any pod handles any request | Major code rewrite, latency for state fetch | ❌ Too complex for v1 |
| **Namespace-per-Tenant** | Good isolation, simple | All tenant workspaces share one MCP | ❌ Not enough isolation |
| **Pod-per-Workspace** | Complete isolation, preserves current design | More pods to manage | ✅ **Selected** |

### How It Works

```
User Request → BetterAuth → Control Plane Check → Route to Workspace
                                                        ↓
                                    Knative Service (mcp-{workspace})
                                                        ↓
                                    MCP Pod → PVC + Scoped PostgreSQL
```

1. **BetterAuth** validates user session
2. **Control Plane** verifies workspace membership (studio-core)
3. Request routed to workspace's **Knative Service**
4. Knative scales pods **0 → 1** on first request (cold start: 5-15s)
5. After 10 minutes idle, scales back to **0**
6. **PersistentVolumeClaim** (EBS) stores `.schemas/` data
7. **Shared RDS** with row-level security for entity data

---

## What's Already Done

| Component | Status |
|-----------|--------|
| `studio-core` domain (orgs, teams, projects, members) | ✅ Implemented |
| `studio-chat` domain (chat sessions, messages, tool logs) | ✅ Implemented |
| `platform-features` domain (feature lifecycle) | ✅ Implemented |
| BetterAuth integration | ✅ Implemented in apps/api |
| `ddl.migrate` tool + migration tracking | ✅ Implemented |
| Seed initialization (Shogo org, Platform project) | ✅ Implemented |
| Environment variables (MCP_PORT, API_PORT, etc.) | ✅ Configured |
| `docker-compose.yml` | ✅ Updated with new architecture |

## What Still Needs to Be Done

### Code Changes

| Component | Change | Effort |
|-----------|--------|--------|
| `packages/mcp/Dockerfile` | Container build | 1 hour |
| `apps/web/Dockerfile` | Container build | 1 hour |
| `apps/api/Dockerfile` | Container build | 1 hour |
| `packages/workspace-operator/` | K8s controller for workspace lifecycle | 2-3 days |

### Infrastructure

| Component | Purpose | Status |
|-----------|---------|--------|
| Terraform modules (EKS) | Cluster provisioning | ✅ Skeleton created |
| Terraform modules (VPC, RDS) | Networking + database | 🔲 To do |
| Terraform modules (Knative) | Serverless platform | 🔲 To do |
| GitHub Actions | CI/CD pipeline | 🔲 To do |

---

## Cost Projections

### Fixed Costs (Shared)
- EKS Control Plane: **$73/mo**
- RDS PostgreSQL: **$50/mo**
- NAT + ALB: **$67/mo**
- **Total Fixed: ~$190/mo**

### Per-Workspace Costs
| State | Cost/mo |
|-------|---------|
| Active (pod running) | ~$15 |
| Idle (scaled to zero) | ~$0.10 |

### Example: 100 Workspaces (10% active)
- 10 active × $15 = $150
- 90 idle × $0.10 = $9
- Fixed: $190
- **Total: ~$350/mo**

---

## Timeline

| Week | Milestone |
|------|-----------|
| 1 | Dockerfiles + docker-compose working locally |
| 2-3 | Terraform for EKS + Knative |
| 3-4 | Workspace operator |
| 5 | CI/CD pipeline |
| 6 | Testing + documentation |

---

## Questions for Discussion

1. **Idle timeout**: Default 10 minutes - should it be configurable per tenant?

2. **Cold start latency**: ~5-15 seconds to spin up an idle workspace. Acceptable?

3. **Storage limits**: Default 1GB PVC per workspace. Enough?

4. **Database**: Shared RDS with row-level security, or database-per-workspace?

5. **Custom domains**: Should workspaces support custom domains (`workspace.customer.com`)?

---

## Files to Review

### Infrastructure Docs
1. **Full Technical Spec**: [`docs/infrastructure/TECH_SPEC_POD_PER_WORKSPACE.md`](./TECH_SPEC_POD_PER_WORKSPACE.md)
2. **Terraform Modules**: [`terraform/`](../../terraform/)
3. **Docker Compose**: [`docker-compose.yml`](../../docker-compose.yml)

### New Domain Implementations
4. **Studio Core**: [`packages/state-api/src/studio-core/domain.ts`](../../packages/state-api/src/studio-core/domain.ts)
5. **Studio Chat**: [`packages/state-api/src/studio-chat/domain.ts`](../../packages/state-api/src/studio-chat/domain.ts)
6. **Platform Features**: [`packages/state-api/src/platform-features/domain.ts`](../../packages/state-api/src/platform-features/domain.ts)

### MCP Changes
7. **Seed Init**: [`packages/mcp/src/seed-init.ts`](../../packages/mcp/src/seed-init.ts)
8. **Migration Tracker**: [`packages/state-api/src/ddl/migration-tracker.ts`](../../packages/state-api/src/ddl/migration-tracker.ts)

### API Changes
9. **Auth Integration**: [`apps/api/src/server.ts`](../../apps/api/src/server.ts) - BetterAuth handler, phase-based prompts

---

## Next Steps

1. 📋 Review this document with team
2. 🗣️ Discuss open questions
3. ✅ Approve approach
4. 🚀 Create Dockerfiles for mcp, web, api
5. 🔧 Complete Terraform modules (VPC, RDS, Knative)
6. 🤖 Build workspace operator

---

## Contacts

- **Architecture Questions**: [Your Name]
- **Infrastructure**: [DevOps Lead]
- **Timeline/Priorities**: [PM]

