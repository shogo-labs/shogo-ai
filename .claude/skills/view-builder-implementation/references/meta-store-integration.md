# Meta-Store Integration

The meta-store provides runtime schema introspection - information about schemas, models, and properties that components can use for dynamic rendering.

## What Meta-Store Provides

### Schema → Model → Property Hierarchy

```
Schema (e.g., "platform-features")
  └── Model (e.g., "Requirement")
        └── Property (e.g., "status", "priority", "description")
```

### Property Metadata

Each Property entity contains fields useful for rendering:

| Field | Purpose | Example |
|-------|---------|---------|
| `name` | Property identifier | `"status"` |
| `type` | JSON Schema type | `"string"`, `"number"`, `"array"` |
| `format` | Type refinement | `"date-time"`, `"email"`, `"uri"` |
| `enum` | Allowed values | `["pending", "accepted", "rejected"]` |
| `xReferenceType` | MST reference type | `"single"`, `"array"` |
| `xReferenceTarget` | Referenced model | `"ImplementationTask"` |
| `xComputed` | Derived property flag | `true` |
| `xRenderer` | Explicit renderer hint | `"priority-badge"` |
| `required` | Required field flag | `true` |

### PropertyRenderer Compatibility

Meta-store Property entities are directly compatible with PropertyRenderer. No transformation needed - pass Property as `property` prop.

```typescript
<PropertyRenderer
  property={propertyFromMetaStore}  // Works directly
  value={entity[property.name]}
  entity={entity}
/>
```

## Accessing Meta-Store

### Schema Lookup

```typescript
const metaStore = useWavesmithMetaStore()

// Sync lookup (schema already loaded)
const schema = metaStore.findSchemaByName("platform-features")

// Async loading (schema not yet loaded)
await metaStore.loadSchema("platform-features")
```

### Model and Property Access

```typescript
const schema = metaStore.findSchemaByName(schemaName)
const model = schema?.models?.find(m => m.name === modelName)
const properties = model?.properties ?? []

// Get specific property
const statusProp = properties.find(p => p.name === "status")
```

### Collection Name

Models have a `collectionName` field for accessing the MST collection:

```typescript
const collectionName = model.collectionName  // e.g., "requirementCollection"
const collection = domainStore[collectionName]
```

## Use Cases

### Dynamic Column Detection

For grid/table components, auto-detect columns from model properties:

```typescript
const columns = properties
  .filter(p => !p.name.startsWith('$'))  // Exclude internal
  .filter(p => p.name !== 'toJSON')       // Exclude methods
  .map(p => p.name)
```

### Type-Aware Rendering

Use property metadata to select appropriate rendering:

```typescript
// PropertyRenderer handles this automatically via RendererBinding system
// But you can also make decisions based on metadata:

if (property.xRenderer === 'priority-badge') {
  // Use domain-specific renderer
}

if (property.type === 'array' && property.xReferenceType === 'array') {
  // Reference array - render as links
}

if (property.format === 'date-time') {
  // Format as relative time
}
```

### Schema-Driven Forms

Build forms dynamically from property metadata:

```typescript
properties
  .filter(p => !p.xComputed)  // Exclude computed (read-only)
  .filter(p => p.required || showOptional)
  .map(p => renderFieldForProperty(p))
```

## Loading Patterns

### Sync-First with Async Fallback

Schema may or may not be loaded when component mounts:

```typescript
// 1. Try sync lookup
let schema = metaStore.findSchemaByName(schemaName)

// 2. If not found, load async
if (!schema) {
  await metaStore.loadSchema(schemaName)
  schema = metaStore.findSchemaByName(schemaName)
}

// 3. Handle still not found
if (!schema) {
  return <Error message={`Schema not found: ${schemaName}`} />
}
```

### Handling Loading State

Components should handle the async loading window:

```typescript
if (metaLoading) {
  return <LoadingState />
}

if (metaError) {
  return <ErrorState message={metaError} />
}

// Safe to render with metadata
```

## Anti-Patterns

**DON'T**: Infer types from values when metadata available
```typescript
// BAD: Guessing type from value
const type = typeof value === 'number' ? 'number' : 'string'

// GOOD: Use property metadata
const type = property.type
```

**DON'T**: Hardcode property lists
```typescript
// BAD: Hardcoded columns
const columns = ['id', 'name', 'status']

// GOOD: Derive from metadata (with config override)
const columns = config?.columns ?? properties.map(p => p.name)
```

**DON'T**: Forget async schema loading
```typescript
// BAD: Assumes schema is loaded
const schema = metaStore.findSchemaByName(name)  // May be null!

// GOOD: Handle loading
const schema = metaStore.findSchemaByName(name)
if (!schema) {
  // Either load async or show loading state
}
```

## Integration with PropertyRenderer

The RendererBinding system uses property metadata to select components:

1. **Priority 200**: Explicit `xRenderer` match (e.g., `priority-badge`)
2. **Priority 100**: Metadata match (`xComputed`, `xReferenceType`)
3. **Priority 50**: Schema match (`enum` present)
4. **Priority 30**: Format match (`date-time`, `email`, `uri`)
5. **Priority 10**: Type match (`string`, `number`, `boolean`)

Components should leverage this system rather than reimplementing type-based rendering.
