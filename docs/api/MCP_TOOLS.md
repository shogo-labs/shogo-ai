# Wavesmith MCP Tools Reference

Complete reference for all 15 MCP tools across 6 namespaces.

## Overview

| Namespace | Tools | Purpose |
|-----------|-------|---------|
| `schema.*` | 3 | Schema lifecycle management |
| `store.*` | 5 | Entity CRUD and query operations |
| `view.*` | 4 | Queries and template projection |
| `data.*` | 1 | Bootstrap initial data |
| `ddl.*` | 1 | Database schema generation |
| `agent.*` | 1 | Conversational interface |

**Server**: `wavesmith-mcp` v0.0.1 via FastMCP

**Tool naming**: In Claude Code, tools are prefixed `mcp__wavesmith__`. Example: `schema.set` → `mcp__wavesmith__schema_set`

---

## Schema Namespace

### schema.set

Set the active schema and rebuild in-memory models.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Schema name |
| `format` | `'enhanced-json-schema'` \| `'arktype'` | Yes | Schema format |
| `payload` | object | Yes | The schema definition |
| `workspace` | string | No | Custom workspace directory |
| `views` | `Record<string, unknown>` | No | View definitions |
| `templates` | `Record<string, string>` | No | Nunjucks templates |
| `options.validateReferences` | boolean | No | Enable reference validation |

**Returns**: `{ ok: true, schemaId, path, models }` or error

### schema.load

Load a saved schema from disk and create/reuse runtime store.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, schemaId, models, reloaded }` or error

### schema.list

List all saved schemas.

**Parameters**: None

**Returns**: `{ ok: true, schemas }` or error

---

## Store Namespace

### store.create

Create entity instances. Supports single and batch operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | string | Yes | Schema name |
| `model` | string | Yes | Model name |
| `data` | object \| object[] | Yes | Single object or array for batch |
| `workspace` | string | No | Workspace directory |

**Returns**:
- Single: `{ ok: true, id, data }`
- Batch: `{ ok: true, count, items }`

### store.get

Retrieve an entity by ID.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `id` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, data }` or error

### store.query

Query entities with MongoDB-style filters. Supports operators like `$gt`, `$lt`, `$in`, `$and`, `$or`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | string | Yes | Schema name |
| `model` | string | Yes | Model name |
| `filter` | object | No | MongoDB-style filter object |
| `ast` | object | No | Serialized AST condition (advanced) |
| `orderBy` | `{ field, direction }` | No | Sort order |
| `skip` | number | No | Pagination offset |
| `take` | number | No | Pagination limit |
| `terminal` | `'toArray'` \| `'first'` \| `'count'` \| `'any'` | No | Terminal operation (default: toArray) |
| `workspace` | string | No | Workspace directory |

**Returns**: `{ ok: true, count, items }` or error

### store.update

Update entity instances. Supports single and batch operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | string | Yes | Schema name |
| `model` | string | Yes | Model name |
| `id` | string | No | Entity ID (single mode) |
| `filter` | object | No | Filter for batch mode |
| `changes` | object | Yes | Properties to update |
| `workspace` | string | No | Workspace directory |

**Returns**:
- Single: `{ ok: true, data }`
- Batch: `{ ok: true, count }`

### store.delete

Delete entity instances. Supports single and batch operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | string | Yes | Schema name |
| `model` | string | Yes | Model name |
| `id` | string | No | Entity ID (single mode) |
| `filter` | object | No | Filter for batch mode |
| `workspace` | string | No | Workspace directory |

**Returns**:
- Single: `{ ok: true, data }`
- Batch: `{ ok: true, count }`

---

## View Namespace

### view.execute

Execute a named view (query or template).

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `view` | string | Yes |
| `params` | unknown | No |

**Returns**: `{ ok: true, view: { schema, name, type }, result, metadata }` or error

### view.define

Add or update a view definition.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `name` | string | Yes |
| `definition.type` | `'query'` \| `'template'` | Yes |
| `definition.collection` | string | No |
| `definition.filter` | unknown | No |
| `definition.select` | string[] | No |
| `definition.dataSource` | string | No |
| `definition.template` | string | No |

**Returns**: `{ ok: true, view: { id, schema, name, type }, operation }` or error

### view.delete

Remove a view definition.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `name` | string | Yes |

**Returns**: `{ ok: true, view, operation: 'deleted' }` or error

### view.project

Execute a view and write result to file.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `view` | string | Yes |
| `output_path` | string | Yes |
| `params` | unknown | No |
| `ensure_directory` | boolean | No |

**Returns**: `{ ok: true, view, projection: { output_path, bytes_written, format, preview }, metadata }` or error

---

## Data Namespace

### data.bootstrap

Bootstrap studio-core with initial data (organization, project, member).

| Parameter | Type | Required |
|-----------|------|----------|
| `userId` | string | No |
| `workspace` | string | No |
| `linkFeatureSessions` | boolean | No |

**Returns**: `{ ok: true, ... }` or error

---

## DDL Namespace

### ddl.execute

Generate and execute DDL (CREATE TABLE) statements from a schema.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | Yes | Schema to generate DDL for |
| `dryRun` | boolean | No | Preview SQL without executing |

**Returns**: `{ ok: true, statements, executed }` or error

---

## Agent Namespace

### agent.chat

Multi-turn conversational agent for app building.

| Parameter | Type | Required |
|-----------|------|----------|
| `message` | string | Yes |
| `sessionId` | string | No |

**Returns**: `{ ok: true, sessionId, toolCalls }` or error

Pass `sessionId` from previous response to continue conversations.

---

## Error Codes

| Code | Description |
|------|-------------|
| `SCHEMA_NOT_FOUND` | Schema doesn't exist |
| `MODEL_NOT_FOUND` | Model not in schema |
| `RUNTIME_STORE_NOT_FOUND` | Call `schema.load` first |
| `COLLECTION_NOT_FOUND` | Collection not in store |
| `NOT_FOUND` | Entity ID not found |
| `VALIDATION_ERROR` | Data failed MST validation |
| `SCHEMA_PARSE_ERROR` | Invalid schema payload |
| `VIEW_EXECUTION_ERROR` | View failed to execute |
| `QUERY_EXECUTION_ERROR` | Query failed to execute |

---

## Example Usage

```typescript
// 1. Set schema
mcp__wavesmith__schema_set({
  name: "my-app",
  format: "enhanced-json-schema",
  payload: {
    $defs: {
      Task: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          title: { type: "string" }
        }
      }
    }
  }
})

// 2. Create entity
mcp__wavesmith__store_create({
  schema: "my-app",
  model: "Task",
  data: { title: "My first task" }
})

// 3. Query entities
mcp__wavesmith__store_query({
  schema: "my-app",
  model: "Task",
  filter: { title: { $regex: "first" } }
})
```

---

## See Also

- [Concepts](../CONCEPTS.md) — Key abstractions
- [Enhanced JSON Schema](ENHANCED_JSON_SCHEMA.md) — Schema format specification
- [State API Reference](STATE_API.md) — Core library functions
