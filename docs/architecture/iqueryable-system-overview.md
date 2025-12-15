# IQueryable System Architecture Overview

**Version**: 1.0
**Date**: 2025-12-15
**Status**: Implemented
**Branch**: `feat/iqueryable-and-persistence-as-projection`

---

## Executive Summary

The IQueryable system implements **"Persistence as Projection"**—extending Shogo AI's core philosophy of "Runtime as Projection over Intent" to the data access layer. It provides a unified, backend-agnostic query comprehension layer that transforms declarative MongoDB-style queries into backend-specific operations, enabling the same query logic to execute against PostgreSQL databases, in-memory MST collections, or future backends—all while maintaining full type safety and MST reactivity.

**Key Achievements**:
- ✅ Backend-agnostic query abstraction with pluggable execution strategies
- ✅ MongoDB-style query operators (comparison, logical, custom)
- ✅ Schema-driven validation via meta-store integration
- ✅ Isomorphic execution (browser + server)
- ✅ MST integration with environment dependency injection
- ✅ 231 passing tests validating all patterns and integrations

---

## 1. Vision & Philosophy

### 1.1 Persistence as Projection

Where the view system projects intent (schemas) into files, the **persistence layer projects MST state into queryable backends**. This creates a unified abstraction where:

```
Schema Intent → Query Expression → Backend-Specific Execution
                 (the AST)         (the projection)
```

### 1.2 Core Principles

**Separation of Concerns**
- **Write Path** (`IPersistenceService`): CRUD operations, collection/entity persistence
- **Read Path** (`IQueryable`): Query comprehension, filtering, ordering, pagination

**Isomorphic by Design**
- Same query API works in browser and server contexts
- Backend binding resolved at runtime via environment DI
- No abstraction leakage between contexts

**Schema-Driven Everything**
- Query capabilities derived from Enhanced JSON Schema metadata
- Operators validated against property types at query-building time
- Backend selection configured via `x-persistence` extensions

**MST Reactivity Preserved**
- Queries return MST model instances, not plain objects
- Changes to queried data trigger MST observers
- Integration via collection mixins maintains composability

**Pragmatic Over Pure**
- MongoDB-style query syntax (familiar, expressive, proven)
- Build what's unique (query comprehension, MST integration)
- Leverage ecosystem where it fits (discovered through PoC)

### 1.3 Why This Architecture?

**Problem**: Naive persistence implementations tightly couple storage mechanics with query logic, making it difficult to:
- Switch between backends (filesystem → database)
- Test queries without real storage
- Share query logic between client and server
- Validate queries against schema at build time

**Solution**: Separate query **comprehension** (what to query) from query **execution** (how to query), with schema-driven validation bridging the two.

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  (Collections with .query() method via mixin composition)    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   IQueryable Interface                       │
│  Chainable query builder: .where() .orderBy() .skip()       │
│  Terminal operations: .toArray() .first() .count()          │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌─────────┐    ┌─────────┐   ┌──────────┐
    │ Parser  │    │Validator│   │ Registry │
    │ (AST)   │    │(Schema) │   │(Resolve) │
    └────┬────┘    └────┬────┘   └────┬─────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              ┌──────────────────┐
              │  IBackend        │
              │  Interface       │
              └─────────┬────────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
    ┌───────────┐ ┌─────────┐ ┌──────────┐
    │  Memory   │ │   SQL   │ │  Future  │
    │  Backend  │ │ Backend │ │ Backends │
    └───────────┘ └─────────┘ └──────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility | Location |
|-----------|----------------|----------|
| **Query AST** | Parse MongoDB-style filters into canonical AST | `packages/state-api/src/query/ast/` |
| **Validation Layer** | Validate operators against schema property types | `packages/state-api/src/query/validation/` |
| **Backend Abstraction** | Define `IBackend` interface and capability model | `packages/state-api/src/query/backends/types.ts` |
| **Memory Backend** | In-memory execution using @ucast/js | `packages/state-api/src/query/backends/memory.ts` |
| **SQL Backend** | SQL compilation using @ucast/sql | `packages/state-api/src/query/backends/sql.ts` |
| **Backend Registry** | Schema-driven backend resolution with cascade | `packages/state-api/src/query/registry.ts` |
| **Collection Mixin** | MST integration via `CollectionQueryable` | `packages/state-api/src/composition/queryable.ts` |

### 2.3 Module Dependencies

```
query/ast/           ← No dependencies (foundation)
     ↓
query/validation/    ← Depends on: ast, meta-store
     ↓
query/backends/      ← Depends on: ast, validation
     ↓
query/registry.ts    ← Depends on: backends
     ↓
composition/         ← Depends on: registry, all query modules
queryable.ts
```

**Build Order**: Bottom-up (AST → Validation → Backends → Registry → Mixin)

---

## 3. Core Components

### 3.1 Query AST System

**Purpose**: Parse MongoDB-style queries into a canonical, type-safe AST.

**Implementation**: Uses `@ucast` ecosystem for parse-compile separation
- **Library**: `@ucast/core` for AST types (`Condition`, `FieldCondition`, `CompoundCondition`)
- **Parser**: `@ucast/mongo` for MongoDB query parsing
- **Extensibility**: Custom operators (e.g., `$contains`) via parsing instructions

**Key Files**:
- `query/ast/types.ts` - TypeScript types and re-exports from @ucast/core
- `query/ast/parser.ts` - MongoDB query parser with custom operator support
- `query/ast/serialization.ts` - JSON serialization for MCP transport (handles RegExp)
- `query/ast/operators.ts` - Custom operator definitions and extensibility

**Supported Operators**:
- **Comparison**: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
- **Pattern Matching**: `$regex`, `$contains` (custom)
- **Logical**: `$and`, `$or`, `$not`

**Example**:
```typescript
import { parseQuery } from '@shogo/state-api/query'

const ast = parseQuery({
  status: 'active',
  age: { $gte: 18 },
  role: { $in: ['admin', 'moderator'] }
})

// AST can be serialized for MCP transport
const json = serializeCondition(ast)
const restored = deserializeCondition(json)
```

**Design Decision**: @ucast chosen after PoC demonstrated:
- Battle-tested parse-compile separation
- Extensible for custom operators
- Pairs with @ucast/js (memory) and @ucast/sql (SQL)
- MongoDB API already JSON-serializable

### 3.2 Validation Layer

**Purpose**: Validate query operators against schema property types at query-building time.

**Implementation**: Integrates with meta-store for runtime schema introspection
- Derives valid operators from JSON Schema property types
- Lazy memoization for performance (cleared on schema reload)
- Actionable error messages with property path context

**Operator-Type Compatibility Matrix**:
```typescript
OPERATOR_BY_TYPE = {
  string: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
  integer: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
  boolean: ['eq', 'ne'],
  array: ['in', 'nin', 'contains'],
  object: ['eq', 'ne'],
  reference: ['eq', 'ne', 'in', 'nin'],
  'date-time': ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']
}
```

**Key Files**:
- `query/validation/types.ts` - `IQueryValidator` interface, `OPERATOR_BY_TYPE`
- `query/validation/validator.ts` - `QueryValidator` class with lazy memoization

**Usage**:
```typescript
const validator = new QueryValidator(metaStore)
const result = validator.validateQuery(ast, 'my-schema', 'User')

if (!result.valid) {
  result.errors.forEach(err => {
    console.error(`${err.code} at ${err.path}: ${err.message}`)
    // e.g., "INVALID_OPERATOR at age: Operator '$regex' not valid for type 'integer'"
  })
}
```

**Two-Tier Validation**:
1. **@ucast Parse-Time**: Catches JavaScript type errors (e.g., `$gt` on boolean)
2. **Our Validation**: Catches schema-semantic errors (property existence, operator-type compatibility)

### 3.3 Backend Abstraction Layer

**Purpose**: Define unified interface for query execution across different storage engines.

**IBackend Interface**:
```typescript
interface IBackend {
  capabilities: BackendCapabilities  // Declare supported operators/features

  execute<T>(
    ast: Condition,
    collection: T[],
    options?: QueryOptions
  ): Promise<QueryResult<T>>
}

type BackendCapabilities = {
  operators: string[]  // e.g., ['eq', 'ne', 'gt', 'regex']
  features: {
    sorting: boolean
    pagination: boolean
    relations: boolean
    aggregation: boolean
  }
}

type QueryOptions = {
  orderBy?: OrderByClause[]
  skip?: number
  take?: number
  include?: string[]
}
```

**Key Files**:
- `query/backends/types.ts` - Core interfaces and types

**Design Pattern**: Backends declare capabilities, allowing queries to be validated before execution.

### 3.4 Memory Backend

**Purpose**: Execute queries against in-memory MST collections.

**Implementation**: Uses `@ucast/js` for filtering
- Custom `applyOrderBy()` for multi-field sorting
- `slice()` for skip/take pagination
- Custom `$contains` interpreter for string/array inclusion
- Returns **same MST references** (no cloning for reactivity)

**Key Pattern**:
```typescript
// CORRECT: interpret(ast, item)
result.filter(item => interpret(ast, item))

// WRONG: interpret(ast)(item)  ← Will fail with "Unable to get field X"
result.filter(interpret(ast))
```

**Performance**: 10k items filter + sort + paginate < 200ms

**Key Files**:
- `query/backends/memory.ts` - `MemoryBackend` class

**Capabilities**:
```typescript
{
  operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains'],
  features: {
    sorting: true,
    pagination: true,
    relations: false,
    aggregation: false
  }
}
```

### 3.5 SQL Backend

**Purpose**: Compile queries to SQL for execution against PostgreSQL/SQLite databases.

**Implementation**: Uses `@ucast/sql` for WHERE clause compilation
- PostgreSQL dialect with parameterized queries (`$1`, `$2` placeholders)
- Custom `$contains` LIKE interpreter
- Manual ORDER BY/LIMIT/OFFSET generation
- Returns `[sql, params, joins]` tuple (does **not** execute)

**Methods**:
- `compileSelect(ast, tableName, options)` - Full SELECT with WHERE/ORDER BY/LIMIT/OFFSET
- `compileCount(ast, tableName)` - COUNT(*) optimization
- `compileExists(ast, tableName)` - EXISTS check with LIMIT 1

**Key Files**:
- `query/backends/sql.ts` - `SqlBackend` class

**Known Limitations**:
- `$eq: null` generates `= NULL` instead of `IS NULL` (upstream @ucast/sql limitation)
- Auto-joins not supported—consumer adds JOINs
- Only generates WHERE clause, not full query execution

**Example**:
```typescript
const backend = new SqlBackend()
const [sql, params] = backend.compileSelect(
  parseQuery({ status: 'active', age: { $gte: 18 } }),
  'users',
  { orderBy: [{ field: 'createdAt', direction: 'desc' }], take: 10 }
)

// sql: "SELECT * FROM users WHERE status = $1 AND age >= $2 ORDER BY createdAt DESC LIMIT 10"
// params: ['active', 18]
```

### 3.6 Backend Registry

**Purpose**: Resolve backend for a given schema + model using cascade fallback.

**Resolution Cascade**:
1. **Model-level**: Check `model.xPersistence.backend` in meta-store
2. **Schema-level**: Check `schema.xPersistence.backend` (reserved for future)
3. **Default**: Use registry's default backend
4. **Error**: Throw descriptive error if none found

**Key Files**:
- `query/registry.ts` - `BackendRegistry` class and factory

**Usage**:
```typescript
const registry = createBackendRegistry({
  default: 'memory',
  backends: {
    memory: new MemoryBackend(),
    sql: new SqlBackend()
  }
})

// Later:
const backend = registry.resolve('users-schema', 'User')
const results = await backend.execute(ast, collection)
```

**Pattern**: Per-environment instance (not global singleton)
- Enables test isolation (no shared state)
- Matches MST environment DI pattern
- Supports different backends per environment

### 3.7 IQueryable Collection Mixin

**Purpose**: Add LINQ-style chainable query builder to MST collections.

**IQueryable Interface**:
```typescript
interface IQueryable<T> {
  where(filter: QueryFilter): IQueryable<T>
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryable<T>
  skip(count: number): IQueryable<T>
  take(count: number): IQueryable<T>

  // Terminal operations
  toArray(): Promise<T[]>
  first(): Promise<T | undefined>
  count(): Promise<number>
  any(): Promise<boolean>
}
```

**Implementation**:
- **Immutable builder pattern**: Each method returns new instance
- Uses `QueryBuilder` internal class with `QueryBuilderState`
- Multiple `where()` calls combined with `$and`
- Terminal operations resolve backend via registry and execute
- Optimizations: `first()` and `any()` use `take(1)`

**Key Files**:
- `composition/queryable.ts` - `CollectionQueryable` mixin

**MST Collection Enhancement**:
```typescript
const MyCollection = types.compose(
  BaseCollection,
  CollectionPersistable,  // Adds loadAll/saveAll
  CollectionQueryable     // Adds .query()
).named('MyCollection')
```

**Usage Example**:
```typescript
const results = await collection.query()
  .where({ status: 'active' })
  .where({ age: { $gte: 21 } })  // Multiple where = $and
  .orderBy('createdAt', 'desc')
  .orderBy('name', 'asc')  // Multi-field sort
  .skip(20)
  .take(10)
  .toArray()
```

---

## 4. Integration Patterns

### 4.1 Environment Dependency Injection

MST environment provides services for persistence and querying:

```typescript
// Environment definition
interface IEnvironment {
  services: {
    persistence: IPersistenceService      // CRUD operations
    backendRegistry: IBackendRegistry     // Query backend resolution
    queryValidator?: IQueryValidator      // Optional validation
  }
  context: {
    schemaName: string
    location?: string
  }
}

// Store creation with DI
const store = RootStore.create({}, {
  services: {
    persistence: new FileSystemPersistence(),
    backendRegistry: createBackendRegistry({ default: 'memory' })
  },
  context: {
    schemaName: 'my-app'
  }
})

// Access in collection models
const { backendRegistry } = getEnv(self).services
```

### 4.2 Collection Mixin Composition

Collections enhanced via composable mixins:

```typescript
// Composition pipeline
const MyCollection = types.compose(
  BaseCollection,          // Basic map storage
  CollectionPersistable,   // Adds loadAll/saveAll (write path)
  CollectionQueryable      // Adds .query() (read path)
).named('MyCollection')

// Auto-composition via buildEnhanceCollections()
const enhanceCollections = buildEnhanceCollections({
  enablePersistence: true,
  enableQueryable: true,
  userEnhance: (models) => ({
    ...models,
    UserCollection: types.compose(models.UserCollection, CustomMixin)
  })
})
```

**Integration Point**: `packages/state-api/src/composition/enhance-collections.ts`

### 4.3 Schema-Driven Configuration

Backend selection via `x-persistence` extension:

```json
{
  "$defs": {
    "User": {
      "type": "object",
      "x-persistence": {
        "backend": "postgres",
        "table": "users",
        "strategy": "flat"
      },
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "email": { "type": "string" }
      }
    }
  }
}
```

**Resolution**: Registry checks model metadata → schema metadata → default

---

## 5. Isomorphic Execution

### 5.1 Browser Execution Path

**Scenario**: React app querying data in browser

```typescript
// Browser environment setup
const store = RootStore.create({}, {
  services: {
    persistence: new MCPPersistence({ endpoint: '/mcp' }),
    backendRegistry: createBackendRegistry({ default: 'memory' })
  }
})

// Query execution (in-memory)
const users = await store.users.query()
  .where({ status: 'active' })
  .toArray()

// Flow:
// 1. Validate query against meta-store
// 2. Resolve backend: "memory" (default)
// 3. MemoryBackend executes against in-memory MST collection
// 4. Returns MST instances (no network call)
```

### 5.2 Server Execution Path

**Scenario**: Node.js service querying PostgreSQL

```typescript
// Server environment setup
const postgresBackend = createPostgresBackend({
  connectionString: process.env.DATABASE_URL
})

const store = RootStore.create({}, {
  services: {
    persistence: new FileSystemPersistence(),
    backendRegistry: createBackendRegistry({
      default: 'postgres',
      backends: { postgres: postgresBackend }
    })
  }
})

// Query execution (database)
const users = await store.users.query()
  .where({ status: 'active' })
  .toArray()

// Flow:
// 1. Validate query against meta-store
// 2. Resolve backend: "postgres" (from x-persistence or default)
// 3. PostgresBackend translates to SQL and executes
// 4. Materializes results as MST instances
// 5. Returns instances (added to store)
```

### 5.3 Meta-Store Loading

**Browser**: Load via MCP
```typescript
const metaStore = await loadMetaStoreViaMCP('/mcp')
```

**Server**: Load from filesystem
```typescript
const metaStore = loadMetaStoreFromFilesystem('./schemas')
```

**Same Meta-Store Instance**: Used for validation in both contexts

---

## 6. Design Decisions & Tradeoffs

### 6.1 MongoDB-Style Query Syntax

**Decision**: Use MongoDB query operators as canonical format

**Rationale**:
- ✅ JSON-serializable (MCP transport friendly)
- ✅ Familiar to developers (proven syntax)
- ✅ Expressive (handles 95% of query patterns)
- ✅ Ecosystem tooling available (@ucast)

**Tradeoffs**:
- ❌ Not SQL-native (requires translation layer)
- ❌ Different from GraphQL/OData
- ✅ But: Consistent API across all backends

### 6.2 Parse-Compile Separation (@ucast)

**Decision**: Use @ucast ecosystem for AST and execution

**Rationale**:
- ✅ Battle-tested parse-compile separation
- ✅ Extensible for custom operators
- ✅ Pairs naturally: @ucast/mongo → @ucast/js → @ucast/sql
- ✅ TypeScript support

**Tradeoffs**:
- ❌ External dependency (adds ~50KB gzipped)
- ✅ But: Saves months of maintenance and edge cases

**Alternatives Considered**:
- `sift.js`: Only in-memory, no SQL compilation
- `mingo`: Full MongoDB implementation (overkill)
- Custom: Full control but high maintenance

### 6.3 Backend Abstraction Granularity

**Decision**: Schema/model-level backend selection (not CQRS)

**Rationale**:
- ✅ Simple mental model (one backend per model)
- ✅ Covers 90% of use cases
- ✅ Extensible to CQRS if needed later

**Tradeoffs**:
- ❌ No read-write split by default
- ✅ But: Can add later without breaking changes

### 6.4 Validation Integration

**Decision**: Integrate validation via isomorphic meta-store

**Rationale**:
- ✅ Schema-driven (operators derived from types)
- ✅ Runtime validation (catches errors early)
- ✅ Same code browser + server
- ✅ Rich error messages

**Tradeoffs**:
- ❌ Runtime overhead (lazy memoization mitigates)
- ✅ But: Catches errors before backend execution

### 6.5 MST Result Materialization

**Decision**: Return MST instances, not plain objects

**Rationale**:
- ✅ Preserves reactivity (MobX observers work)
- ✅ Consistent with rest of system
- ✅ Enables computed properties

**Tradeoffs**:
- ❌ Cannot query across store instances
- ✅ But: Matches MST's single-store philosophy

---

## 7. Implementation Status

### 7.1 Completed Components

| Component | Status | Tests | Location |
|-----------|--------|-------|----------|
| Query AST Parser | ✅ Complete | 30 | `query/ast/` |
| Validation Layer | ✅ Complete | 23 | `query/validation/` |
| Memory Backend | ✅ Complete | 50 | `query/backends/memory.ts` |
| SQL Backend | ✅ Complete | 39 | `query/backends/sql.ts` |
| Backend Registry | ✅ Complete | 22 | `query/registry.ts` |
| Collection Mixin | ✅ Complete | 49 | `composition/queryable.ts` |
| Integration Tests | ✅ Complete | 18 | `query/discovery/` |

**Total**: 231 passing tests across 8 PoC files

### 7.2 Integration Points

All 18 integration points documented in Wavesmith:
- ✅ 5 new modules created (`query/ast/`, `query/validation/`, etc.)
- ✅ 3 existing modules modified (`composition/`, `environment/`)
- ✅ Full type definitions and exports

### 7.3 Remaining Work

**DDL Generation** (In Progress):
- Evaluating Knex vs Kysely vs native approaches
- Goal: Transform Enhanced JSON Schema → CREATE TABLE DDL
- Location: `packages/state-api/src/query/discovery/ddl-*.test.ts`

**Future Enhancements** (Deferred):
- Observable queries (reactive auto-refresh)
- Advanced operators (`select()`, `groupBy()`, `join()`)
- Additional backends (S3, Redis, Elasticsearch)
- Query optimization and caching

---

## 8. Usage Patterns

### 8.1 Basic Queries

```typescript
// Simple equality
const active = await collection.query()
  .where({ status: 'active' })
  .toArray()

// Comparison operators
const adults = await collection.query()
  .where({ age: { $gte: 18 } })
  .toArray()

// Multiple conditions (implicit $and)
const results = await collection.query()
  .where({ status: 'active', age: { $gte: 18 } })
  .toArray()
```

### 8.2 Logical Operators

```typescript
// Explicit $or
const results = await collection.query()
  .where({
    $or: [
      { status: 'active' },
      { featured: true }
    ]
  })
  .toArray()

// Nested logic
const results = await collection.query()
  .where({
    $and: [
      { category: 'electronics' },
      {
        $or: [
          { price: { $lt: 100 } },
          { onSale: true }
        ]
      }
    ]
  })
  .toArray()
```

### 8.3 Sorting and Pagination

```typescript
// Single sort
const recent = await collection.query()
  .where({ status: 'active' })
  .orderBy('createdAt', 'desc')
  .toArray()

// Multi-field sort
const sorted = await collection.query()
  .orderBy('priority', 'desc')
  .orderBy('createdAt', 'asc')
  .toArray()

// Pagination (page 3, 20 per page)
const page3 = await collection.query()
  .where({ status: 'active' })
  .orderBy('id', 'asc')
  .skip(40)
  .take(20)
  .toArray()
```

### 8.4 Terminal Operations

```typescript
// Get all results
const all = await collection.query()
  .where(filter)
  .toArray()

// Get first match (or undefined)
const first = await collection.query()
  .where({ email: 'user@example.com' })
  .first()

// Count matches
const count = await collection.query()
  .where({ status: 'active' })
  .count()

// Check existence
const hasActive = await collection.query()
  .where({ status: 'active' })
  .any()
```

---

## 9. Key Learnings & Gotchas

### 9.1 Critical API Patterns

**@ucast/js interpret() API**:
```typescript
// CORRECT
items.filter(item => interpret(ast, item))

// WRONG - Will fail
items.filter(interpret(ast))
```

**@ucast/sql null equality bug**:
```typescript
// Generates wrong SQL
{ deletedAt: { $eq: null } }
// → "deletedAt = $1" with params [null]
// Should be: "deletedAt IS NULL"

// Workaround: Document limitation or custom operator
```

### 9.2 Performance Considerations

**Memory Backend**:
- 10k items: < 200ms for filter + sort + paginate
- No cloning overhead (returns same MST references)
- Multi-field sorting is fast (JavaScript native sort)

**SQL Backend**:
- Compile-only (no execution overhead)
- Parameterized queries prevent SQL injection
- Consumer responsible for connection pooling

**Validation**:
- Lazy memoization caches operator validity
- Cleared on schema reload
- Negligible runtime overhead after first query

---

## 10. Future Directions

### 10.1 Observable Queries (Phase 2)

Enable reactive query execution:

```typescript
const activeUsersQuery = collection.query()
  .where({ status: 'active' })
  .asObservable()

autorun(() => {
  console.log('Active users:', activeUsersQuery.value)
})

// When user.status changes, query auto-refreshes
```

### 10.2 Advanced Query Features (Phase 3)

- `select()` for projection (return subset of fields)
- `groupBy()` for aggregation
- `join()` for cross-collection queries

### 10.3 Additional Backends

- **S3Backend**: Document storage with partition keys
- **RedisBackend**: Caching layer with TTL
- **ElasticsearchBackend**: Full-text search

### 10.4 Performance Optimizations

- Query plan analysis and optimization
- Index recommendations based on query patterns
- Streaming results for large datasets
- Connection pooling and prepared statements

---

## 11. References

### 11.1 Related Documents

- **Vision Document**: `_analysis/.../design-alignment-rev1.md`
- **Spec Overview**: `_analysis/.../spec/_overview.md`
- **Wavesmith Feature**: `.schemas/platform-features/data/FeatureSession/iqueryable-persistence-projection/`

### 11.2 Code Locations

- **Query System**: `packages/state-api/src/query/`
- **Collection Mixin**: `packages/state-api/src/composition/queryable.ts`
- **Tests**: `packages/state-api/src/query/discovery/`

### 11.3 External Dependencies

- `@ucast/core` - AST types and base classes
- `@ucast/mongo` - MongoDB query parser
- `@ucast/js` - In-memory interpreter
- `@ucast/sql` - SQL compilation

---

## Appendix: Complete Example

```typescript
// 1. Define schema with persistence config
const userSchema = {
  "$defs": {
    "User": {
      "type": "object",
      "x-persistence": {
        "backend": "postgres",
        "table": "users"
      },
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "email": { "type": "string" },
        "status": { "type": "string", "enum": ["active", "inactive"] },
        "role": { "type": "string" },
        "createdAt": { "type": "string", "format": "date-time" }
      }
    }
  }
}

// 2. Create store with environment
const store = RootStore.create({}, {
  services: {
    persistence: createPersistenceService(),
    backendRegistry: createBackendRegistry({ default: 'memory' })
  }
})

// 3. Query examples
// Simple query
const activeUsers = await store.users.query()
  .where({ status: 'active' })
  .toArray()

// Complex query
const recentAdmins = await store.users.query()
  .where({
    $and: [
      { role: 'admin' },
      { createdAt: { $gte: '2025-01-01' } }
    ]
  })
  .orderBy('createdAt', 'desc')
  .toArray()

// Pagination
const page2 = await store.users.query()
  .where({ status: 'active' })
  .orderBy('email', 'asc')
  .skip(20)
  .take(10)
  .toArray()

// Terminal operations
const count = await store.users.query()
  .where({ role: 'admin' })
  .count()

const firstUser = await store.users.query()
  .where({ email: 'admin@example.com' })
  .first()

const hasActive = await store.users.query()
  .where({ status: 'active' })
  .any()
```

---

**Document Status**: Complete
**Last Updated**: 2025-12-15
**Maintainer**: Shogo AI Platform Team
