# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Build all packages (uses Turbo for caching and topological ordering)
bun run build

# Run all tests
bun run test

# Type check all packages
bun run typecheck

# Lint all packages
bun run lint

# Run all dev servers simultaneously
bun run dev
```

### Package-Specific Development

```bash
# Web app development (React, http://localhost:3001)
bun run web:dev

# API server development
bun run api:dev

# MCP server - HTTP transport (for browser/web clients)
bun run mcp:http

# MCP server - Stdio transport (for Claude Code integration)
bun run mcp:stdio

# MCP server with FastMCP inspector UI (interactive debugging)
bun run mcp:dev
```

### Database Commands

```bash
# Start infrastructure (postgres, redis, minio)
bun run docker:infra

# Run Prisma migrations
bun run db:migrate

# Push schema changes to database
bun run db:push

# Open Prisma Studio
bun run db:studio

# Generate Prisma client
bun run db:generate
```

### Running Single Tests

```bash
# Run a single test file
bun test packages/state-api/src/meta/__tests__/bootstrap.test.ts

# Run tests with pattern matching
bun test --filter "meta-store"

# Run tests in watch mode
bun test --watch
```

### E2E Tests

```bash
# Web app E2E tests (uses Playwright)
cd apps/web && bun run test:e2e

# E2E with UI mode
cd apps/web && bun run test:e2e:ui

# SDK E2E tests
cd packages/sdk && bun run test:e2e
```

## Architecture Overview

### Package Dependency Graph

```
@shogo/state-api (isomorphic core - no external runtime deps)
       ↑
       ├── @shogo/mcp (MCP server, FastMCP, Node.js)
       ├── @shogo/api (Hono API server, Better Auth, Prisma)
       ├── @shogo/web (React app, Vite, MobX)
       ├── @shogo/project-runtime (isolated project pods)
       └── @shogo-ai/sdk (TanStack Start SDK, publishable)
```

### Transformation Pipeline

The core value is schema-to-store transformation. Schemas flow through three stages:

1. **ArkType Scope** → `arkTypeToEnhancedJsonSchema()` → **Enhanced JSON Schema**
2. **Enhanced JSON Schema** → `enhancedJsonSchemaToMST()` → **MST Models + Collections**
3. **MST Models** → `createStore(environment)` → **Runtime Store**

Key extensions in Enhanced JSON Schema:
- `x-original-name` — preserves model names
- `x-reference-type` — "single" or "array" cardinality
- `x-mst-type` — "identifier", "reference", "maybe-reference"
- `x-computed` — inverse relationship arrays
- `x-renderer-config` — UI rendering hints

### Two-Layer Store Architecture

**Meta-Store** (singleton): Manages schema definitions as queryable entities. Access via `getMetaStore()` or `createMetaStoreInstance(env)` for isolated testing.

**Runtime Stores** (per-schema): Dynamically-generated MST stores for application data, keyed by workspace. Access via `getRuntimeStore(schemaId, location)`.

```typescript
// Meta-store for schema management
const metaStore = getMetaStore()
metaStore.ingestEnhancedJsonSchema(schema)

// Runtime store for data operations
const store = getRuntimeStore(schemaId, workspace)
store.userCollection.add({ name: 'Alice' })
```

### Isomorphic Execution

Same state-api code runs in three environments with different persistence adapters:

| Environment | Persistence Adapter | Data Location |
|-------------|---------------------|---------------|
| Node.js (MCP) | `FileSystemPersistence` | `.schemas/{name}/` |
| Browser | `MCPPersistence` | HTTP to MCP server |
| Sandpack | `MCPPersistence` | HTTP (same as browser) |

### Environment Injection Pattern

Services are injected at store creation, enabling the same model code to work across environments:

```typescript
const store = RootStoreModel.create({}, {
  services: { persistence: new FileSystemPersistence() },
  context: { schemaName: 'my-app' }
})
```

## Key Source Locations

### packages/state-api/src/
- `schematic/` — Transformation pipeline (arktype-to-json-schema, enhanced-json-schema-to-mst)
- `meta/` — Meta-store system (bootstrap.ts, meta-store.ts, meta-registry.ts)
- `persistence/` — Storage adapters (filesystem.ts, null.ts, s3-sqlite.ts)
- `composition/` — MST mixins (persistable.ts, queryable.ts, mutatable.ts)
- `ddl/` — SQL DDL generation from schemas
- `query/` — Query execution backends (memory, sql)
- `domain/` — Domain model generation

### packages/mcp/src/
- `server.ts` — FastMCP entry point (stdio transport)
- `server-http.ts` — HTTP transport for browser clients
- `tools/` — MCP tool implementations (schema.*, store.*, view.*, data.*, agent.*)

### apps/web/src/
- `persistence/MCPPersistence.ts` — Browser HTTP adapter
- `components/app/` — Main application components

### apps/api/src/
- `server.ts` — Hono API server
- `routes/` — API route handlers
- `auth/` — Better Auth integration

## MCP Tool Namespaces

| Namespace | Purpose |
|-----------|---------|
| `schema.*` | Schema management (set, get, load, list) |
| `store.*` | Entity CRUD (models, create, get, list, update) |
| `view.*` | Query & templates (execute, define, delete, project) |
| `data.*` | Bulk data loading (load, loadAll) |
| `agent.*` | Conversational interface (chat) |

## Claude Skills

AI skills are defined in `.claude/skills/`. Key skills:
- `view-builder` — Guide through view/component building flows
- `view-builder-spec` — Capture component specifications
- `view-builder-implementation` — Implement components from approved specs
- `component-builder-evolution` — UI evolution via dynamic renderer binding

## Testing Patterns

Tests use Bun's test runner. Most tests are colocated in `__tests__/` directories.

```bash
# Run all state-api tests
bun test packages/state-api

# Run specific test file
bun test packages/state-api/src/meta/__tests__/bootstrap.test.ts

# Watch mode
bun test --watch packages/state-api
```

For isolated meta-store testing, use `createMetaStoreInstance()` instead of the singleton `getMetaStore()`.
