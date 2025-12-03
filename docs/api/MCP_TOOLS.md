# Wavesmith MCP Tools Reference

Complete reference for all 16 MCP tools across 5 namespaces.

## Overview

| Namespace | Tools | Purpose |
|-----------|-------|---------|
| `schema.*` | 4 | Schema lifecycle management |
| `store.*` | 5 | Entity CRUD operations |
| `view.*` | 4 | Queries and template projection |
| `data.*` | 2 | Bulk data loading |
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

### schema.get

Get a schema by name.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | Yes |

**Returns**: `{ ok: true, format, payload }` or error

### schema.load

Load a saved schema from disk and create/reuse runtime store.

| Parameter | Type | Required |
|-----------|------|----------|
| `name` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, schemaId, models, loadedCollections, cached }` or error

### schema.list

List all saved schemas.

**Parameters**: None

**Returns**: `{ ok: true, schemas }` or error

---

## Store Namespace

### store.models

List model descriptors for a schema.

| Parameter | Type | Required |
|-----------|------|----------|
| `schemaName` | string | Yes |

**Returns**: `{ ok: true, models }` or error

### store.create

Create a new entity instance.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `data` | object | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, id, data }` or error

### store.get

Retrieve an entity by ID.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `id` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, data }` or error

### store.list

List all entities of a model type.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `filter` | object | No |
| `workspace` | string | No |

**Returns**: `{ ok: true, count, items }` or error

### store.update

Update an entity's properties.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `id` | string | Yes |
| `changes` | object | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, data }` or error

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

### data.load

Load a single collection from disk.

| Parameter | Type | Required |
|-----------|------|----------|
| `schema` | string | Yes |
| `model` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, model, collectionName, count, message }` or error

### data.loadAll

Load all collections for a schema.

| Parameter | Type | Required |
|-----------|------|----------|
| `schemaName` | string | Yes |
| `workspace` | string | No |

**Returns**: `{ ok: true, schemaName, collections, totalEntities, summary, message }` or error

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

// 3. List entities
mcp__wavesmith__store_list({ schema: "my-app", model: "Task" })
```

---

## See Also

- [Concepts](../CONCEPTS.md) — Key abstractions
- [Enhanced JSON Schema](ENHANCED_JSON_SCHEMA.md) — Schema format specification
- [State API Reference](STATE_API.md) — Core library functions
