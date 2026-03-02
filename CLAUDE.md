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
```

### Running the Full Stack Locally

```bash
# 1. Start infrastructure (Postgres, Redis, MinIO) — requires Docker
bun run docker:infra

# 2. Run database migrations (first time or after schema changes)
bun run db:migrate:deploy

# 3. Start all services (MCP :3100, API :8002, Web :8081)
bun run dev:all
```

Open **http://localhost:8081** to use the app. The API runs on `:8002` and the
MCP server on `:3100`. Agent runtimes are spawned by the API on ports starting
at `:5200`.

Logs are written to `logs/api.log`, `logs/mcp.log`, and `logs/web.log`. To
check service output or debug issues:

```bash
tail -f logs/api.log          # API + agent runtime logs
tail -f logs/mcp.log          # MCP server logs
grep '\[Composio\]' logs/api.log  # Filter for Composio integration logs
```

### Package-Specific Development

```bash
# Start all 3 services concurrently (MCP + API + Expo Web)
bun run dev:all

# Start only backend services (MCP + API, no frontend)
bun run dev:backend

# Individual services:
bun run web:dev        # Expo web on http://localhost:8081
bun run api:dev        # API server on http://localhost:8002 (with --watch)
bun run mcp:http       # MCP HTTP server on http://localhost:3100

# Mobile development:
bun run mobile:ios     # Expo iOS simulator
bun run mobile:android # Expo Android emulator

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
       ├── @shogo/mobile (Universal Expo app - Web, iOS, Android)
       │   ├── @shogo/shared-ui (Gluestack v3 universal components)
       │   ├── @shogo/shared-app (shared hooks, domain logic, auth)
       │   └── @shogo/ui-kit (theme, routing utilities)
       ├── @shogo/project-runtime (isolated project pods)
       └── @shogo-ai/sdk (Vite + Hono SDK, publishable)
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

### apps/mobile/ (Universal Expo App — Web, iOS, Android)
- `app/` — Expo Router file-based routes
- `app/(app)/` — Authenticated app routes (home, projects, settings, etc.)
- `app/(auth)/` — Auth routes (sign-in, sign-up)
- `app/(admin)/` — Admin routes (dashboard, users, workspaces, analytics)
- `components/chat/` — Chat panel and message rendering
- `components/dynamic-app/` — Dynamic app renderer (canvas)
- `components/layout/` — Responsive app shell (sidebar, header)
- `components/ui/` — Gluestack v3 universal components
- `contexts/` — Auth and domain providers

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
