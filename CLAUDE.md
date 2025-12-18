# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Vision

Shogo AI is an **AI-first app builder platform** where Claude orchestrates the entire development lifecycle through natural language. The system captures user intent, generates schemas, creates implementation specs, and produces TDD-ready code.

**Core Philosophy: "Runtime as Projection over Intent"**
- User describes what they need in plain language
- Claude captures intent as queryable Wavesmith entities
- Schema and code are generated from this captured intent
- The runtime is always traceable back to user requirements

**The App Builder Pipeline** (each phase has a Claude skill in `.claude/skills/`):
1. **Discovery** → Capture problem, artifacts, analysis, requirements
2. **Schema Design** → Generate Enhanced JSON Schema from requirements
3. **Implementation Spec** → Create modules, interfaces, tests
4. **Code Generation** → Produce TDD-ready Python scaffolding
5. **Documentation** → Generate architecture and API docs

The Wavesmith MCP tools (`schema.*`, `store.*`, `view.*`, `data.*`) provide the persistence layer that skills use to capture and query intent across the pipeline.

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
React demo app showing different integration patterns:
- Unit 1: Direct MST store usage with host-defined schemas
- Unit 2: Meta-store system for runtime schema introspection
- Unit 3: Conversational app builder using MCP

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
