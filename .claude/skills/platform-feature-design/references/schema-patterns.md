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
    "id": { "type": "string", "format": "uuid", "x-mst-type": "identifier" },
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
| `x-reference-type` | `"single"`, `"array"` | Reference cardinality - activates reference detection |
| `x-arktype` | Entity name (e.g., `"User"`, `"User[]"`) | Target model for MST reference resolution |
| `x-reference-target` | Entity name (e.g., `"User"`) | Target entity for DDL foreign key generation |
| `x-computed` | `true` | Marks computed/inverse fields (not persisted) |
| `x-inverse` | Property name | Source field for computed inverse arrays |

## Reference Patterns

**CRITICAL**: Every reference field MUST have these extensions for MST transformation to work.

### Required X-Extensions for References

| Extension | Required? | Purpose |
|-----------|-----------|---------|
| `type: "string"` | YES | MST stores references as string IDs |
| `x-arktype` | YES | Target entity name - used by MST schematic pipeline |
| `x-reference-target` | YES | Target entity name - used by DDL generator for foreign keys |
| `x-reference-type` | YES | `"single"` or `"array"` - activates reference detection |
| `x-mst-type` | YES | `"reference"` or `"maybe-reference"` for optional refs |

### Single Reference (N:1) - All Required Fields

```json
"user": {
  "type": "string",
  "x-arktype": "User",
  "x-reference-target": "User",
  "x-mst-type": "reference",
  "x-reference-type": "single"
}
```

### Optional Reference - All Required Fields

```json
"reviewer": {
  "type": "string",
  "x-arktype": "User",
  "x-reference-target": "User",
  "x-mst-type": "maybe-reference",
  "x-reference-type": "single"
}
```

### Array Reference (1:N) - All Required Fields

```json
"tags": {
  "type": "array",
  "items": { "type": "string" },
  "x-arktype": "Tag[]",
  "x-reference-target": "Tag",
  "x-mst-type": "reference",
  "x-reference-type": "array"
}
```

### Computed Inverse Array (Auto-Populated)

Computed arrays are populated automatically from the inverse side of a relationship. They are NOT persisted.

```json
"orders": {
  "type": "array",
  "items": { "$ref": "#/$defs/Order" },
  "x-arktype": "Order[]",
  "x-reference-type": "array",
  "x-computed": true,
  "x-inverse": "customer"
}
```

**Note**: Computed arrays use `items.$ref` for type documentation but `x-arktype` for runtime resolution.

### Reference Field Checklist

Before finalizing schema, verify EVERY reference field has:

- [ ] `"type": "string"` (or `"type": "array"` with `"items": { "type": "string" }` for arrays)
- [ ] `"x-arktype": "EntityName"` (or `"EntityName[]"` for arrays) - for MST
- [ ] `"x-reference-target": "EntityName"` - for DDL foreign key generation
- [ ] `"x-reference-type": "single"` or `"array"`
- [ ] `"x-mst-type": "reference"` or `"maybe-reference"` (for optional refs)
- [ ] NO spurious `"enum": []` - remove if present
- [ ] NO `"$ref"` as primary target - `x-arktype` is used for resolution

**Anti-patterns to avoid:**
```json
// ❌ WRONG - missing required extensions
"organization": {
  "$ref": "#/$defs/Organization",
  "x-reference-type": "single"
}

// ✅ CORRECT - all required extensions present
"organization": {
  "type": "string",
  "x-arktype": "Organization",
  "x-reference-target": "Organization",
  "x-mst-type": "reference",
  "x-reference-type": "single"
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

**Correct pattern:**
```typescript
// ✅ MST references with auto-resolution
const OrderDomain = scope({
  Order: { id: 'string.uuid', customer: 'Customer' },  // customer auto-resolves to instance
  Customer: { id: 'string.uuid', name: 'string' }
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

## Identifier Format Standard

**All entity identifiers MUST use UUID format:**

```json
"id": {
  "type": "string",
  "format": "uuid",
  "x-mst-type": "identifier"
}
```

This ensures:
- Proper MST reference resolution
- UUID validation at runtime
- Consistency with ArkType `string.uuid` type

---

## Persistence Configuration (x-persistence)

The `x-persistence` extension configures the SQL backend for entity storage.

### Backend Configuration

**All schemas use a simple backend declaration at the schema root level:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "inventory",
  "x-persistence": {
    "backend": "postgres"
  },
  "$defs": {
    "Product": { ... },
    "Warehouse": { ... }
  }
}
```

**Note**: The system automatically handles fallback: postgres → sqlite (durable) → sqlite (memory). You don't need to configure fallback behavior.

### What You Don't Need to Configure

The SQL backend handles these concerns automatically:
- Table creation (via DDL execution)
- Entity storage and retrieval
- Reference resolution
- Query filtering and ordering

**No entity-level persistence config is needed.** The old `strategy`, `displayKey`, `nested`, and `partitionKey` options are no longer used.

---

## Complete Entity Example

This example demonstrates ALL required patterns correctly applied:

```json
"Order": {
  "type": "object",
  "description": "A customer order",
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid",
      "x-mst-type": "identifier"
    },
    "orderNumber": {
      "type": "string",
      "description": "Human-readable order number"
    },
    "customer": {
      "type": "string",
      "x-arktype": "Customer",
      "x-reference-target": "Customer",
      "x-mst-type": "reference",
      "x-reference-type": "single"
    },
    "assignee": {
      "type": "string",
      "description": "Optional staff member handling this order",
      "x-arktype": "User",
      "x-reference-target": "User",
      "x-mst-type": "maybe-reference",
      "x-reference-type": "single"
    },
    "status": {
      "type": "string",
      "enum": ["pending", "processing", "shipped", "delivered"]
    },
    "createdAt": {
      "type": "number"
    },
    "lineItems": {
      "type": "array",
      "items": { "$ref": "#/$defs/LineItem" },
      "x-arktype": "LineItem[]",
      "x-reference-type": "array",
      "x-computed": true,
      "x-inverse": "order"
    }
  },
  "required": ["id", "orderNumber", "customer", "status", "createdAt"],
  "x-original-name": "Order"
}
```

**Key patterns demonstrated:**
- `id` with `x-mst-type: "identifier"` and `format: "uuid"`
- Required reference (`customer`) with all 5 required extensions (including `x-reference-target` for DDL)
- Optional reference (`assignee`) with `x-mst-type: "maybe-reference"` and `x-reference-target`
- Enum field (`status`) with actual values, NOT empty `enum: []`
- Computed inverse array (`lineItems`) with `x-arktype`, `x-computed`, and `x-inverse`
- No spurious `enum: []` on any property
