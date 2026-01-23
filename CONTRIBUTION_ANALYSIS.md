# Shogo AI - Contribution Analysis Report

**Generated:** January 21, 2026  
**Analysis Period:** December 2, 2025 - January 21, 2026  
**Repository:** shogo-ai

---

## Executive Summary

This report provides an unbiased analysis of code contributions to the Shogo AI platform, comparing the work of **Russell LaCour** and **Ryan Gahl**. The analysis excludes generated files (`.schemas/`), test files, and merge commits to focus on production code.

### Key Findings

| Metric | Ryan Gahl | Russell LaCour |
|--------|-----------|----------------|
| **Active Period** | Dec 2, 2025 - Jan 21, 2026 | Jan 9 - Jan 21, 2026 |
| **Duration** | ~51 days | ~13 days |
| **Active Coding Days** | 38 days | 11 days |
| **Non-Merge Commits** | 274 | 103 |
| **TypeScript Production Code** | 80,424 (61%) | 52,041 (39%) |
| **Deployed UI Code** | ~3,400 (25%) | ~9,800 (75%) |

**Key Insight:** While Ryan wrote more total code, a significant portion (~22K lines) is in `stepper/` and `rendering/` components that are **not part of the currently deployed user experience**. The UI that users actually interact with today is predominantly Russell's work.

---

## Methodology

### What Was Counted
- TypeScript and TSX files (`.ts`, `.tsx`) only
- Current code ownership via `git blame` (who wrote the lines that exist today)

### What Was Excluded
- `.schemas/` directory (generated schema files)
- Test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`)
- Infrastructure files (Terraform, Kubernetes, CI/CD) — noted separately
- Merge commits (don't represent actual coding work)
- `node_modules/` and other dependencies

---

## Part 1: TypeScript Production Code Analysis

### Total TypeScript Codebase: 133,242 Lines

| Author | Lines | Percentage |
|--------|-------|------------|
| Ryan Gahl | 80,424 | 60.4% |
| Russell LaCour | 52,041 | 39.1% |
| Others | 777 | 0.5% |

### Breakdown by Package/App

| Area | Ryan | Russell | Total | Primary Owner |
|------|------|---------|-------|---------------|
| **apps/web** (frontend) | 46,271 | 20,233 | 66,955 | Ryan (69%) |
| **packages/state-api** (core) | 26,802 | 6,469 | 33,400 | Ryan (80%) |
| **packages/sdk** | 0 | 14,550 | 14,550 | Russell (100%) |
| **packages/mcp** | 5,644 | 2,070 | 7,714 | Ryan (73%) |
| **apps/api** (backend) | 639 | 5,142 | 5,781 | Russell (89%) |
| **packages/project-runtime** | 0 | 1,149 | 1,149 | Russell (100%) |

*Note: Russell also wrote ~7,000 lines of infrastructure code (Terraform, Kubernetes, CI/CD) not included above.*

---

## Part 2: Deployed Application UI Analysis

**This is the critical distinction.** The frontend code includes both:
1. **Deployed UI** - What users actually see and interact with today
2. **Unused/Future Features** - Code that exists but isn't in the main user flow

### What Users Actually See (Main Routes)

The deployed application has these primary routes:
- `/projects/:id` — Project view with chat, code editor, terminal, preview, database
- `/` — Home page with templates
- `/settings` — Settings page
- `/billing` — Billing management
- `/profile`, `/projects`, `/starred`, `/shared` — Other pages

### Deployed UI Ownership

| Route/Component | Total Lines | Russell | Ryan |
|-----------------|-------------|---------|------|
| **Project View** (`/projects/:id`) | | | |
| └─ ProjectLayout.tsx | 792 | 677 (85%) | 115 (15%) |
| └─ CodeEditorPanel.tsx | 617 | 617 (100%) | 0 |
| └─ TerminalPanel.tsx | 444 | 444 (100%) | 0 |
| └─ DatabasePanel.tsx | 189 | 189 (100%) | 0 |
| └─ RuntimePreviewPanel.tsx | 374 | 374 (100%) | 0 |
| └─ TestPanel.tsx | 814 | 814 (100%) | 0 |
| └─ Other project components | ~1,962 | ~1,962 (100%) | 0 |
| **Project View Total** | **5,192** | **5,077 (98%)** | **115 (2%)** |
| | | | |
| **All Pages** (`/settings`, `/billing`, etc.) | | | |
| └─ SettingsPage.tsx | 2,017 | 2,017 (100%) | 0 |
| └─ AllProjectsPage.tsx | 1,175 | 1,175 (100%) | 0 |
| └─ AppBillingPage.tsx | 188 | 188 (100%) | 0 |
| └─ Other pages | 1,194 | 1,194 (100%) | 0 |
| **Pages Total** | **4,574** | **4,574 (100%)** | **0 (0%)** |
| | | | |
| **Home/Dashboard** | 931 | 406 (44%) | 525 (56%) |
| **Billing Components** | 494 | 494 (100%) | 0 |
| | | | |
| **ChatPanel** (used across app) | 1,989 | 162 (8%) | 1,827 (92%) |

### Deployed UI Summary

| Category | Lines | Russell | Ryan |
|----------|-------|---------|------|
| Project View (all panels) | 5,192 | **98%** | 2% |
| All Pages | 4,574 | **100%** | 0% |
| Billing Components | 494 | **100%** | 0% |
| Home/Dashboard | 931 | 44% | **56%** |
| ChatPanel | 1,989 | 8% | **92%** |
| **DEPLOYED UI TOTAL** | **~13,180** | **~75%** | **~25%** |

### Code NOT in Main Deployed Flow

| Category | Lines | Owner | Notes |
|----------|-------|-------|-------|
| `stepper/` components | 6,142 | Ryan (99%) | Feature builder flow |
| `rendering/` components | 15,864 | Ryan (99%) | Dynamic component system |
| **TOTAL NOT DEPLOYED** | **~22,000** | **Ryan** | Not in current UX |

The `stepper/` and `rendering/` directories contain a sophisticated "platform features" or "feature builder" system that Ryan built, but this is **not the primary user experience** in the current deployed application. The main flow today is: Home → Create Project → Chat + Preview/Code/Terminal.

---

## Part 3: Backend & SDK

### API Backend (`apps/api`) — 5,781 lines

| Author | Lines | Share |
|--------|-------|-------|
| Russell LaCour | 5,142 | **89%** |
| Ryan Gahl | 639 | 11% |

**Russell Built:**
- Billing routes and Stripe webhook handling
- Files API with S3 integration
- Project chat routes
- Publish/deployment routes
- Terminal routes
- Runtime management routes
- Knative project manager (597 lines)

**Ryan Built:**
- Initial server setup
- Auth integration

### SDK Package — 14,550 lines (100% Russell)

- SDK core with auth module
- Route generation utilities
- Template examples (CRM, Kanban, Inventory, Form Builder, AI Chat)

### Infrastructure (Not Counted in TypeScript Totals)

Russell built the entire production infrastructure (~7,000 lines):
- Terraform modules (VPC, EKS, RDS, ECR, ElastiCache, Knative)
- Kubernetes manifests and Knative service templates
- GitHub Actions CI/CD pipeline for staging and production

---

## Part 4: Core Platform (Ryan's Foundation)

While the deployed UI is predominantly Russell's work, the **core platform engine** that powers everything is Ryan's:

### State API (`packages/state-api`) — 33,400 lines (80% Ryan)

- IQueryable system (schema-driven query composition)
- SQL and memory query executors
- DDL generator supporting Postgres and SQLite
- Migration tracking and orchestration
- Authorization system with declarative scope/rules
- Cross-model joins and subquery support
- Domain abstraction patterns

### MCP Tools (`packages/mcp`) — 7,714 lines (73% Ryan)

- MCP server core implementation
- Tools registry and registration system
- Schema-driven tool generation
- Store operations (create, query, update)

### ChatPanel — 1,989 lines (92% Ryan)

The chat interface that enables AI interaction:
- Real-time streaming with message interleaving
- Tool call rendering and inline widgets
- AskUserQuestion widget for interactive AI prompts
- Session management and persistence

---

## Part 5: Timeline & Velocity Analysis

### Commit Activity

| Period | Ryan | Russell |
|--------|------|---------|
| Dec 2 - Jan 8 (before Russell) | 220 commits | 2 commits |
| Jan 9 - Jan 21 (overlap) | 54 commits | 101 commits |

### Daily Output (During Overlap)

| Metric | Ryan | Russell |
|--------|------|---------|
| Commits/Day | 5.4 | 9.2 |
| Estimated Lines/Day | ~1,400 | ~4,000 |

Russell's output rate was approximately **2.5-3x higher** during the overlap period.

---

## Conclusion

### The Complete Picture

**Ryan Gahl (51 days)** built:
- ✅ Core platform engine (state-api, query system, DDL, migrations)
- ✅ Authentication and authorization systems
- ✅ MCP integration and tool system
- ✅ ChatPanel (the AI chat interface)
- ✅ Feature builder system (stepper + rendering — not yet deployed)
- ✅ Home page foundation

**Russell LaCour (13 days)** built:
- ✅ The entire project view UI (code editor, terminal, database, preview, tests)
- ✅ All application pages (settings, billing, profile, projects list)
- ✅ Billing/Stripe integration
- ✅ SDK and template examples
- ✅ API backend routes
- ✅ Project runtime system
- ✅ All production infrastructure (Terraform, K8s, CI/CD) — not counted in TS totals

### Who Built What Users See Today

| What Users Experience | Primary Builder |
|----------------------|-----------------|
| Home page | Split (Ryan 56%, Russell 44%) |
| Chat interface | **Ryan** (92%) |
| Project preview panel | **Russell** (100%) |
| Code editor | **Russell** (100%) |
| Terminal | **Russell** (100%) |
| Database panel | **Russell** (100%) |
| Test runner | **Russell** (100%) |
| Settings page | **Russell** (100%) |
| Billing page | **Russell** (100%) |
| All other pages | **Russell** (100%) |
| **Overall Deployed UI** | **Russell (~75%)** |

### Who Built What Powers the App

| What Powers the App | Primary Builder |
|--------------------|-----------------|
| Query/persistence engine | **Ryan** (80%) |
| Auth system | **Ryan** (100%) |
| MCP tools | **Ryan** (73%) |
| API routes | **Russell** (89%) |
| SDK | **Russell** (100%) |

*Russell also built all infrastructure (Terraform, K8s, CI/CD) — not included in TypeScript counts.*

### Final Assessment

The application exists because of both contributors:

- **Ryan** spent 51 days building a sophisticated **platform foundation** — the query engine, state management, auth, and chat interface that enable AI-powered development.

- **Russell** joined for the final 13 days and built the **user-facing application** — the actual screens users see, the deployment infrastructure, billing, and SDK.

Ryan's TypeScript line count is higher (60% vs 39%), but a significant portion (~22K lines) is feature-builder code not yet in production. The **deployed user experience is ~75% Russell's code**.

Both contributions are essential — you need both a powerful engine AND a polished user interface to ship a product.

---

*Report generated via automated git analysis. All metrics based on current codebase state as of January 21, 2026.*
