# Extending Shogo AI

Guide for adding new capabilities to the system.

## Extension Points

| Extension | Location | Purpose |
|-----------|----------|---------|
| MCP Tools | `packages/mcp/src/tools/` | AI-accessible operations |
| Persistence Adapters | `packages/state-api/src/persistence/` | Storage backends |
| MST Mixins | `packages/state-api/src/composition/` | Reusable store behavior |
| Claude Skills | `.claude/skills/` | Claude Code capabilities |

---

## Adding MCP Tools

### Tool Structure

```typescript
// packages/mcp/src/tools/myns.operation.ts
import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { getMetaStore, getRuntimeStore } from "@shogo/state-api"

const Params = t({
  schema: "string",
  model: "string",
  "workspace?": "string"
})

export function registerMyOperation(server: FastMCP) {
  server.addTool({
    name: "myns.operation",
    description: "What this tool does",
    parameters: Params,
    execute: async (args: any) => {
      const metaStore = getMetaStore()
      const store = getRuntimeStore(args.schema, args.workspace)

      // Perform operation

      return JSON.stringify({ ok: true, result: "..." })
    }
  })
}
```

### Registration

Add to `packages/mcp/src/tools/registry.ts`:

```typescript
import { registerMyOperation } from "./myns.operation"

export function registerAllTools(server: FastMCP) {
  // ... existing tools
  registerMyOperation(server)
}
```

---

## Adding Persistence Adapters

### Interface

```typescript
interface IPersistenceService {
  saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void>
  loadCollection(ctx: PersistenceContext): Promise<any | null>
  saveEntity(ctx: EntityContext, snapshot: any): Promise<void>
  loadEntity(ctx: EntityContext): Promise<any | null>

  // Optional
  loadSchema?(name: string, location?: string): Promise<any | null>
  listSchemas?(location?: string): Promise<string[]>
}

type PersistenceContext = {
  schemaName: string
  modelName: string
  location?: string
}

type EntityContext = PersistenceContext & { entityId: string }
```

### Implementation

```typescript
export class MyPersistence implements IPersistenceService {
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const key = `${ctx.location}:${ctx.schemaName}:${ctx.modelName}`
    // Store snapshot using your backend
  }

  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    // Return { items: { [id]: entitySnapshot } } or null
  }

  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    const collection = await this.loadCollection(ctx) || { items: {} }
    collection.items[ctx.entityId] = snapshot
    await this.saveCollection(ctx, collection)
  }

  async loadEntity(ctx: EntityContext): Promise<any | null> {
    const collection = await this.loadCollection(ctx)
    return collection?.items?.[ctx.entityId] || null
  }
}
```

---

## Adding MST Mixins

### Mixin Pattern

```typescript
import { types, getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'

export const MyMixin = types.model()
  .views(self => ({
    get derivedValue(): string {
      const env = getEnv<IEnvironment>(self)
      return env.context.schemaName
    }
  }))
  .actions(self => ({
    async myAction() {
      const env = getEnv<IEnvironment>(self)
      await env.services.persistence.saveCollection(...)
    }
  }))
```

### Composing

```typescript
const MyCollection = types.compose(
  BaseCollection,
  MyMixin
).named('MyCollection')
```

---

## Creating Claude Skills

### Directory Structure

```
.claude/skills/my-skill/
├── SKILL.md          # Required
└── references/       # Optional
    └── examples.md
```

### SKILL.md Format

```markdown
---
name: my-skill
description: One-line description for Claude to match on.
---

# Skill Title

## Overview
What this skill does and when to use it.

## Workflow
Step-by-step process.

## Wavesmith Patterns
Entity CRUD examples.
```

Key frontmatter:
- `name`: kebab-case identifier
- `description`: Trigger phrase for Claude

---

## See Also

- [Architecture](ARCHITECTURE.md) — System design
- [MCP Tools Reference](api/MCP_TOOLS.md) — Existing tools
- [State API Reference](api/STATE_API.md) — Core functions
