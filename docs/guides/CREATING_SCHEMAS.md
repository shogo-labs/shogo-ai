# Creating Schemas

Schemas define domain models that become reactive MST stores. You can define schemas using ArkType (TypeScript DSL) or Enhanced JSON Schema directly.

## Quick Start

### Basic Entity

```typescript
import { scope } from 'arktype'

const SimpleDomain = scope({
  User: {
    id: "string.uuid",
    name: "string"
  }
})
```

### With Constraints

```typescript
const ConstrainedDomain = scope({
  User: {
    id: "string.uuid",
    name: "string >= 2",      // min length 2
    age: "number >= 18"       // min value 18
  }
})
```

## Entity Relationships

### Single References

```typescript
const BusinessDomain = scope({
  User: {
    id: "string.uuid",
    name: "string",
    company: "Company"        // Reference to Company entity
  },
  Company: {
    id: "string.uuid",
    name: "string"
  }
})
```

### Computed Array References (Inverse)

When entity A references B, and B has an array of A, the array is auto-computed:

```typescript
const BusinessDomain = scope({
  User: {
    id: "string.uuid",
    name: "string",
    company: "Company"        // Stored reference
  },
  Company: {
    id: "string.uuid",
    name: "string",
    employees: "User[]"       // Computed: inverse of User.company
  }
})
```

### Optional References

```typescript
User: {
  id: "string.uuid",
  name: "string",
  "company?": "Company"       // Optional (note the ?)
}
```

### Self-References

```typescript
Employee: {
  id: "string.uuid",
  name: "string",
  "manager?": "Employee",     // Parent reference (stored)
  reports: "Employee[]"       // Children (computed)
}
```

## Embedded vs Reference Arrays

### Embedded Primitive Arrays

```typescript
User: {
  id: "string.uuid",
  tags: "string[]",           // Stored in snapshot
  scores: "number[]"
}
```

### Embedded Object Arrays (Value Objects)

```typescript
User: {
  addresses: [{
    street: "string",
    city: "string",
    zip: "string"
  }],
  phoneNumbers: [{
    type: "'home' | 'work' | 'mobile'",
    number: "string"
  }]
}
```

### Constrained Arrays

```typescript
User: {
  tags: "(string >= 2)[]",                    // Each item >= 2 chars
  scores: "(number >= 0 & number <= 100)[]"   // Each 0-100
}
```

## Enums and Literal Types

```typescript
Order: {
  status: "'pending' | 'completed' | 'cancelled'"
}
```

In Enhanced JSON Schema:

```json
"stage": {
  "type": "string",
  "enum": ["lead", "qualified", "proposal", "negotiation", "closed-won", "closed-lost"]
}
```

## Opaque Objects

For flexible configuration or arbitrary JSON, use objects without properties:

```typescript
Step: {
  id: "string.uuid",
  name: "string",
  config: { type: "object" }  // Becomes types.frozen()
}
```

## Multi-Domain Composition

Reference entities across domain boundaries:

```typescript
const OrdersDomain = scope({
  auth: AuthDomain.export(),
  inventory: InventoryDomain.export(),
  Order: {
    customer: "auth.User",          // Cross-domain reference
    product: "inventory.Product"
  }
})
```

## Pattern Quick Reference

| Pattern | ArkType Syntax |
|---------|----------------|
| Required field | `name: "string"` |
| Optional field | `"name?": "string"` |
| Single reference | `company: "Company"` |
| Array reference (computed) | `employees: "User[]"` |
| Embedded array | `tags: "string[]"` |
| Constrained | `age: "number >= 18"` |
| Enum | `status: "'a' \| 'b'"` |

## See Also

- [Enhanced JSON Schema](../api/ENHANCED_JSON_SCHEMA.md) — x-* extensions
- [State API](../api/STATE_API.md) — Transformation functions
- [Concepts](../CONCEPTS.md) — Key abstractions
