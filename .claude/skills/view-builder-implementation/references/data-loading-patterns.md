# Data Loading Patterns

Section components access data from Wavesmith domains. Understanding sync vs async data access is critical for correct implementation.

## Two Data Paths

### Synchronous (MST Views)

**What**: Direct access to MobX-State-Tree store views. Data is already loaded in memory.

**Methods**:
- `collection.all()` → `T[]`
- `collection.where(filter)` → `T[]`
- `collection.findBySession(id)` → `T[]`

**Characteristics**:
- Reactive - MobX observes and re-renders on change
- Immediate - No loading state needed
- Local only - Only sees data in MST store

**When to use**:
- Data was hydrated at app startup
- Working within a feature session context
- Real-time reactivity needed

### Asynchronous (Query Builder)

**What**: Database queries via Wavesmith query builder. Fetches from PostgreSQL.

**Methods**:
- `collection.query().toArray()` → `Promise<T[]>`
- `collection.query().first()` → `Promise<T | undefined>`
- `collection.query().count()` → `Promise<number>`

**Characteristics**:
- Async - Requires Promise handling (useEffect, async/await)
- Loading state - Must show loading indicator
- Full access - Queries entire database, not just MST store

**When to use**:
- Data not in local MST store
- Need filtering, sorting, pagination
- Cross-session or global queries
- Large datasets

## Decision Criteria

| Scenario | Path | Rationale |
|----------|------|-----------|
| Feature-scoped data (requirements, tasks) | Sync | Data hydrated with feature session |
| Cross-feature queries (all sessions) | Async | Data not in local store |
| User requests filtering/sorting | Async | Query builder handles efficiently |
| Pagination needed | Async | Query builder supports skip/take |
| Real-time updates critical | Sync | MobX reactivity |
| Config includes `query` object | Async | Explicit async request |

## Config Pattern

For generic sections that support both paths, use config to signal intent:

```typescript
interface SectionConfig {
  schema: string
  model: string

  // Sync path options
  sessionFilter?: boolean  // Use findBySession(feature.id)
  staticFilter?: object    // Use collection.where()

  // Async path (presence triggers async)
  query?: {
    filter?: object
    orderBy?: { field: string; direction: 'asc' | 'desc' }[]
    skip?: number
    take?: number
  }
}
```

**Rule**: If `config.query` is present, use async path. Otherwise, use sync path.

## Implementation Considerations

### Sync Path

```typescript
// Reactive - MobX handles updates
const data = collection.findBySession(feature.id) ?? []
// Can use directly in render - no useEffect needed
```

### Async Path

```typescript
// Must handle loading state
const [data, setData] = useState<T[]>([])
const [loading, setLoading] = useState(true)

// Must use useEffect for async
useEffect(() => {
  let cancelled = false
  async function load() {
    const results = await collection.query().where(filter).toArray()
    if (!cancelled) {
      setData(results)
      setLoading(false)
    }
  }
  load()
  return () => { cancelled = true }
}, [dependencies])
```

### Error Handling

Both paths should handle:
- Missing collection (schema not loaded)
- Empty results (no data matches)
- Query errors (async path)

```typescript
// Always provide graceful empty state
if (data.length === 0) {
  return <EmptyState message="No data available" />
}
```

## Anti-Patterns

**DON'T**: Mix sync and async in confusing ways
```typescript
// BAD: Sync call inside async function
async function loadData() {
  return collection.all() // This is sync, why async wrapper?
}
```

**DON'T**: Forget loading states for async
```typescript
// BAD: No loading indicator
const data = await collection.query().toArray()
return <List items={data} /> // Flash of empty content
```

**DON'T**: Use async when sync suffices
```typescript
// BAD: Unnecessary async for session data
const data = await collection.query()
  .where({ sessionId: feature.id })
  .toArray()
// GOOD: Sync is simpler and reactive
const data = collection.findBySession(feature.id)
```

## Future Direction

The platform is moving toward unified reactive store access where components declaratively specify data needs and the system handles sync/async transparently. Current patterns should:

- Keep data access logic isolated (easy to refactor)
- Prefer reactive patterns where possible
- Use config to express intent, not implementation details
