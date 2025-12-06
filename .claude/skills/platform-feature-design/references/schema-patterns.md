# Enhanced JSON Schema Patterns

## Basic Structure

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "schema-name",
  "title": "Schema Title",
  "description": "What this schema models",
  "$defs": {
    "EntityName": { ... }
  }
}
```

## Entity Definition

```json
"User": {
  "type": "object",
  "description": "A platform user",
  "properties": {
    "id": { "type": "string", "x-mst-type": "identifier" },
    "email": { "type": "string", "format": "email" },
    "createdAt": { "type": "number" }
  },
  "required": ["id", "email", "createdAt"]
}
```

## MST Extensions

| Extension | Values | Purpose |
|-----------|--------|---------|
| `x-mst-type` | `"identifier"`, `"reference"`, `"maybe-reference"` | MST type mapping |
| `x-reference-type` | `"single"`, `"array"` | Reference cardinality |
| `x-reference-target` | Entity name | Target of reference |
| `x-computed` | `true` | Marks computed/inverse fields |

## Reference Patterns

**Single reference (N:1)**:
```json
"user": {
  "type": "string",
  "x-mst-type": "reference",
  "x-reference-type": "single",
  "x-reference-target": "User"
}
```

**Optional reference**:
```json
"reviewer": {
  "type": "string",
  "x-mst-type": "maybe-reference",
  "x-reference-type": "single",
  "x-reference-target": "User"
}
```

**Array reference (1:N)**:
```json
"apiKeys": {
  "type": "array",
  "items": { "type": "string" },
  "x-mst-type": "reference",
  "x-reference-type": "array",
  "x-reference-target": "ApiKey"
}
```

## Value Objects (Embedded)

```json
"address": {
  "type": "object",
  "properties": {
    "street": { "type": "string" },
    "city": { "type": "string" },
    "zipCode": { "type": "string" }
  },
  "required": ["street", "city"]
}
```

## Enums

```json
"status": {
  "type": "string",
  "enum": ["active", "suspended", "deleted"],
  "default": "active"
}
```

## Common Field Patterns

**Timestamps**:
```json
"createdAt": { "type": "number" },
"updatedAt": { "type": "number" },
"expiresAt": { "type": "number" }
```

**Status tracking**:
```json
"status": {
  "type": "string",
  "enum": ["pending", "active", "completed", "failed"]
}
```

**Error tracking**:
```json
"errorMessage": { "type": "string" },
"lastError": { "type": "string" }
```

## Decision Framework: Reference vs Embedded

| Choose Reference When | Choose Embedded When |
|----------------------|---------------------|
| Entity has independent lifecycle | Data belongs to parent only |
| Entity is queried independently | Data is always accessed via parent |
| Many-to-many relationship | One-to-one, tightly coupled |
| Entity is shared across parents | Data is unique to each parent |

## Reference vs String ID Decision

When relating entities, always prefer MST references over string IDs within the same schema.

| Scenario | Use | ArkType Syntax | JSON Schema |
|----------|-----|----------------|-------------|
| Entity in same schema, queried together | MST Reference | `product: 'Product'` | `x-reference-type: single` |
| Optional relationship | Maybe Reference | `manager?: 'Employee'` | `x-mst-type: maybe-reference` |
| Array of related entities | Reference Array | `items: 'LineItem[]'` | `x-reference-type: array` |
| Cross-schema reference (external) | String ID | `externalOrderId: 'string'` | Plain `type: string` |
| External system ID (Stripe, etc.) | String ID | `stripeCustomerId: 'string'` | Plain `type: string` |

**Key insight**: The schematic system auto-detects references by checking if the type name exists in the scope. Use entity names directly—no `.id` suffix needed.

**Anti-pattern to avoid:**
```typescript
// ❌ WRONG: String IDs lose MST's automatic resolution
const OrderDomain = scope({
  Order: { id: 'string', customerId: 'string' },  // customerId is just a string
  Customer: { id: 'string', name: 'string' }
})

// ✅ CORRECT: MST references with auto-resolution
const OrderDomain = scope({
  Order: { id: 'string', customer: 'Customer' },  // customer auto-resolves to instance
  Customer: { id: 'string', name: 'string' }
})
```

With proper references, `order.customer.name` works directly—no manual lookup required.

## Domain Purity Checklist

Before finalizing schema, verify each field passes these tests:

**Include if ANY is true:**
- [ ] This is domain/business data (not UI concern)
- [ ] This will be persisted to storage
- [ ] MCP tools need to read/write this
- [ ] This represents a relationship between entities

**Exclude if ALL are true:**
- [ ] This is transient state (loading, error, selection)
- [ ] This is only needed by React components
- [ ] This would never be persisted
- [ ] MCP would never use this

**Fields that do NOT belong in schema:**
- `isLoading: boolean` → React useState
- `error: string | null` → React useState
- `isSelected: boolean` → React useState
- `isExpanded: boolean` → React useState
- `draftValue: string` → React useState or useRef
- `currentPage: number` → React useState

**Fields that DO belong in schema:**
- `status: 'pending' | 'active' | 'completed'` → Business state
- `createdAt: number` → Domain event timestamp
- `customer: 'Customer'` → Entity relationship
- `items: 'LineItem[]'` → Entity relationship

## Naming Conventions

- **Entities**: PascalCase (`User`, `ApiKey`, `AuditLog`)
- **Fields**: camelCase (`createdAt`, `passwordHash`)
- **Enums**: lowercase with underscores or camelCase
- **Schema names**: kebab-case (`auth-layer`, `platform-features`)
