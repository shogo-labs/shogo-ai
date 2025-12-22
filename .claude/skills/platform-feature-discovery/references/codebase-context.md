# Shogo AI Codebase Context

## Package Structure

```
shogo-ai/
├── packages/
│   ├── state-api/        # Core library
│   └── mcp/              # MCP server
├── apps/
│   └── web/              # React demo
├── .claude/
│   └── skills/           # Claude skills
└── .schemas/             # Schema definitions
```

## Package Details

### packages/state-api

**Purpose**: Schema-first reactive state management

**Key Areas**:
- `src/schematic/` - ArkType → Enhanced JSON Schema → MST transformation
- `src/meta/` - Meta-store system (Schema, Model, Property entities) and runtime introspection
- `src/query/` - Query execution layer with pluggable backends (Memory, SQL/PostgreSQL)
- `src/ddl/` - SQL DDL generation from Enhanced JSON Schema with dialect support
- `src/composition/` - MST mixins for collections (queryable, persistable, mutatable)
- `src/persistence/` - File-system persistence adapters (used for local dev/testing)
- `src/domain/` - Domain-driven design utilities and domain definitions

**When Affected**: New entity types, schema extensions, persistence changes, store behaviors

### packages/mcp

**Purpose**: MCP server exposing Wavesmith tools to Claude

**Key Areas**:
- `src/tools/` - 16 tools across 5 namespaces (schema.*, store.*, view.*, data.*, agent.*)
- `src/server.ts` - Server setup (stdio + HTTP transports)

**When Affected**: New tools, tool modifications, server middleware, auth

### apps/web

**Purpose**: React demo showing integration patterns

**Key Areas**:
- `src/components/Unit1*/` - Direct MST store usage
- `src/components/Unit2*/` - Meta-store with Sandpack
- `src/components/Unit3*/` - Conversational app builder
- `src/hooks/` - useAgentChat, useSchemaPreview, etc.
- `src/services/mcpService.ts` - HTTP MCP client

**When Affected**: UI features, new demo units, visualization

### .claude/skills

**Purpose**: Claude skills for app-builder pipeline

**Current Skills**:
- `app-builder-discovery` - Capture requirements
- `app-builder-schema-designer` - Generate schemas
- `app-builder-implementation-spec` - Create module specs
- `app-builder-implementation-code-generator` - Python scaffolding
- `app-builder-documentor` - Generate docs

**When Affected**: New skills, skill modifications, pipeline changes

### .schemas

**Purpose**: Schema definitions (Enhanced JSON Schema)

**Structure**:
```
.schemas/{name}/
└── schema.json           # Schema definition (Enhanced JSON Schema)
```

**Note**: Data is persisted to SQL backends (postgres/sqlite), not as JSON files. The `.schemas/` directory contains only schema definitions.

**When Affected**: New domain schemas, schema modifications

## Common Integration Patterns

### Adding an MCP Tool

1. Create `packages/mcp/src/tools/{namespace}.{name}.ts`
2. Register in `packages/mcp/src/tools/registry.ts`
3. Add to tool permissions if needed

### Adding a Skill

1. Create `.claude/skills/{skill-name}/SKILL.md`
2. Add `references/` if needed
3. Skill is auto-discovered by Claude Code

### Creating a New Schema

1. Define via `mcp__wavesmith__schema_set` or manually in `.schemas/`
2. Schema available for store operations immediately
3. Use views for projections if needed
