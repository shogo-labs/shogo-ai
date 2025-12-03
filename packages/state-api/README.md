# @shogo/state-api

> Schema-first reactive state management bridging ArkType to MST with isomorphic execution

Transforms Enhanced JSON Schemas into reactive MobX-State-Tree models. Single source of truth for entity definitions, validation rules, and runtime behavior.

## Quick Start

```typescript
import { createStoreFromScope } from '@shogo/state-api'
import { scope } from 'arktype'

const myScope = scope({
  User: { id: 'string.uuid', name: 'string' }
})

const { createStore } = createStoreFromScope(myScope)
const store = createStore()
```

## Scripts

```bash
bun run build      # Build to dist/
bun run dev        # Watch mode
bun run test       # Run tests
bun run typecheck  # Type check
```

## Modules

| Module | Purpose |
|--------|---------|
| `schematic/` | ArkType → Enhanced JSON Schema → MST pipeline |
| `meta/` | Meta-store for schema introspection |
| `persistence/` | Pluggable storage (FileSystem, Null) |
| `composition/` | MST mixins (CollectionPersistable) |
| `environment/` | Dependency injection types |
| `core/` | Type helpers and utilities |

## Dependencies

- **arktype** — Schema definition
- **mobx-state-tree** — Reactive state
- **nunjucks** — Template rendering

## Documentation

- [State API Reference](../../docs/api/STATE_API.md)
- [Enhanced JSON Schema](../../docs/api/ENHANCED_JSON_SCHEMA.md)
- [Architecture](../../docs/ARCHITECTURE.md)
