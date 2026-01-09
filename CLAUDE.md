# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Vision

Shogo AI is an **AI-first app builder platform** where Claude orchestrates the entire development lifecycle through natural language. The system captures user intent, generates schemas, creates implementation specs, and produces TDD-ready code.

**Core Philosophy: "Runtime as Projection over Intent"**
- User describes what they need in plain language
- Claude captures intent as queryable Wavesmith entities
- Schema and code are generated from this captured intent
- The runtime is always traceable back to user requirements

**Invoking the Platform Feature Pipeline**

The pipeline has 8 phases defined by `FeatureSession.status` in `.schemas/platform-features/schema.json`:
```
discovery → analysis → classification → design → spec → testing → implementation → complete
```

**Entry points:**

| Context | How to Start | What Happens |
|---------|--------------|--------------|
| **Shogo Studio** (`/app`) | Create/select feature → navigate phases | Full UI: org/project management, feature browser, phase-aware chat |
| Development (CLI) | `/platform-feature-orchestrator` | Orchestrator manages phase transitions via subagents |
| Development (CLI) | `/platform-feature-discovery` | Start specific phase directly |

**When to use what:**
- **Shogo Studio** (`/app`) - Production interface for managing features through the pipeline with visual feedback
- **Skills** (`/platform-feature-*`) - Direct skill invocation for pipeline phases (works in both Studio and CLI)
- **MCP tools** (`mcp__wavesmith__*`) - Direct data operations outside pipeline context

**Note:** Studio organizes work by Organization → Project. The `platform-feature-*` skills are available to projects with `tier: 'internal'` (like the "shogo-platform" project used for platform development).

Each skill documents its own workflow in `.claude/skills/platform-feature-*/SKILL.md`.

---

## How It Works

This CLAUDE.md is read in two contexts:

1. **Shogo Studio** (`/app`) - Backend loads it via `settingSources: ['project', 'local']` when handling `/api/chat`
2. **Development** (CLI) - Claude Code reads it as project instructions

Both contexts invoke the same skills with the same MCP tools. The difference is the interface:

```
Shogo Studio                          Development CLI
     │                                      │
     ▼                                      ▼
ChatPanel → /api/chat              Claude Code CLI
     │                                      │
     └──────────► Skills ◄──────────────────┘
                    │
                    ▼
              Wavesmith MCP
    (studio-core, studio-chat, platform-features)
```

In Studio, the `/api/chat` endpoint receives a `phase` parameter and augments the system prompt with phase-specific context from `apps/api/src/prompts/phase-prompts.ts`.

---

## Build & Development Commands

```bash
# Install dependencies (uses bun workspaces)
bun install

# Build all packages (topologically sorted via turbo)
bun run build

# Run all tests
bun run test

# Type check
bun run typecheck

# Development mode (runs all dev scripts in parallel)
bun run dev
```

### Quick Start (individual services)

```bash
# Start Shogo Studio frontend
bun run web:dev

# Start API server (with watch mode)
bun run api:dev

# Start MCP server (for Claude Code integration)
bun run mcp:http
```

### Package-specific commands

```bash
# Run tests in a specific package
bun test --cwd packages/state-api
bun test --cwd packages/mcp

# Run a single test file
bun test packages/state-api/src/schematic/tests/01-basic-transformation.test.ts

# Type check a specific package
bun run typecheck --filter=@shogo/state-api
```

### MCP Server

```bash
# Development mode with FastMCP inspector
bun run dev --filter=@shogo/mcp

# Start MCP server (stdio transport for Claude Code)
bun run start --filter=@shogo/mcp

# Start HTTP transport server
bun run start:http --filter=@shogo/mcp
```

### Web App

```bash
# Start Vite dev server
bun run dev --filter=@shogo/web

# Build for production
bun run build --filter=@shogo/web
```

### Browser Testing with Chrome DevTools MCP

The project uses [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) for browser-based E2E testing of proof-of-work demo pages.

**Requirements:**
- **Google Chrome** - Must be installed and accessible
- **npx** - Used to run chrome-devtools-mcp (comes with Node.js)

**Setup:**
The MCP server is configured in `.mcp.json`. After restarting Claude Code, the following tools become available:
- Input: `click`, `fill`, `fill_form`, `hover`, `press_key`, `drag`, `upload_file`, `handle_dialog`
- Navigation: `navigate_page`, `new_page`, `close_page`, `select_page`, `list_pages`, `wait_for`
- Debugging: `take_screenshot`, `take_snapshot`, `evaluate_script`, `list_console_messages`
- Performance: `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`
- Network: `list_network_requests`, `get_network_request`

**Usage:**
Browser verification runs during implementation Phase 5 (proof-of-work). See:
- `.claude/skills/platform-feature-implementation/references/08-browser-verification.md`
- `.claude/skills/platform-feature-tests/references/patterns/08-e2e-browser-testing.md`

## Architecture Overview

Shogo AI is a monorepo with schema-first reactive state management. The core idea: define schemas (ArkType or Enhanced JSON Schema) and automatically generate MobX-State-Tree stores with proper types, references, and persistence.

### Packages

**@shogo/state-api** (`packages/state-api/`)
Core library with the schema-to-MST transformation pipeline:
- `schematic/` - Converts ArkType scopes → Enhanced JSON Schema → MST models
- `meta/` - Meta-store system for runtime schema introspection (Schema→Model→Property hierarchy)
- `persistence/` - Isomorphic persistence abstraction (filesystem, null, custom)
- `composition/` - MST mixins for adding behaviors (persistable collections)
- `environment/` - Dependency injection via MST environment

**@shogo/mcp** (`packages/mcp/`)
MCP server exposing Wavesmith tools to Claude:
- `tools/` - 16 tools across 5 namespaces (schema.*, store.*, view.*, data.*, agent.*)
- Uses FastMCP for both stdio (Claude Code) and HTTP transports

**@shogo/web** (`apps/web/`)
**Shogo Studio** - the production interface for AI-driven feature development:
- `/app` - Full platform: org/project management, feature browser, phase-aware chat, 8-phase pipeline visualization
- Demo pages (`/unit-*`) - Integration pattern examples for reference

**@shogo/api** (`apps/api/`)
Backend for Shogo Studio:
- `/api/chat` - AI endpoint using Claude Code provider with project-scoped skills and MCP tools
- `/api/auth/*` - Authentication via Better Auth

### Key Concepts

**Enhanced JSON Schema**: Standard JSON Schema with `x-*` extensions for MST-specific metadata:
- `x-arktype`: Original type name for validation
- `x-reference-type`: "single" or "array" for MST references
- `x-computed`: Marks computed/inverse relationship arrays
- `x-mst-type`: "identifier", "reference", or "maybe-reference"

**Schema Transformation Pipeline**:
```
ArkType Scope → arkTypeToEnhancedJsonSchema() → Enhanced JSON Schema
                                                        ↓
                              enhancedJsonSchemaToMST() → MST Models + Store Factory
```

**Meta-Store**: Self-referential store for runtime schema introspection. A schema defines Schema→Model→Property entities that describe other schemas. Used for dynamic schema management via MCP.

**View System**: Query and template views defined on schemas, executed via `view.execute` or projected to files via `view.project`. Templates use Nunjucks.
