# Enhanced JSON Schema Specification

Enhanced JSON Schema is standard JSON Schema 2020-12 with `x-*` extensions that enable MST model generation. ArkType definitions are converted to this format, which then generates MobX-State-Tree models.

## Extension Reference

### Property-Level Extensions

#### x-arktype

Preserves the original ArkType constraint expression.

```json
"id": {
  "type": "string",
  "format": "uuid",
  "x-arktype": "string.uuid"
}
```

**Values**: Any ArkType string (`"string.uuid"`, `"number >= 18"`, `"User[]"`)

#### x-mst-type

Explicit MST type hint for identifiers and references.

```json
"id": {
  "type": "string",
  "x-mst-type": "identifier"
}
```

**Values**: `"identifier"` | `"reference"` | `"maybe-reference"`

**MST Effect**:
- `"identifier"` → `types.identifier` (primary key)
- `"reference"` → `types.reference(Model)`
- `"maybe-reference"` → `types.maybe(types.reference(Model))`

#### x-reference-type

Indicates entity relationship cardinality.

```json
"company": {
  "$ref": "#/$defs/Company",
  "x-reference-type": "single"
}
```

**Values**: `"single"` | `"array"`

**MST Effect**:
- `"single"` → `types.maybe(types.reference(...))`
- `"array"` → `types.array(types.reference(...))`

#### x-computed

Marks inverse relationships as computed views (not stored).

```json
"employees": {
  "type": "array",
  "items": { "$ref": "#/$defs/User" },
  "x-computed": true,
  "x-inverse": "company"
}
```

**Values**: `true`

**MST Effect**: Property becomes a getter view that filters the related collection.

#### x-inverse

Names the property on the related entity establishing the relationship.

**Values**: Property name string (e.g., `"company"`)

Used with `x-computed` to build the filter query.

### Definition-Level Extensions

#### x-original-name

Preserves entity name through transformations.

```json
"$defs": {
  "User": {
    "type": "object",
    "x-original-name": "User",
    "properties": { ... }
  }
}
```

**Values**: Entity name string

#### x-domain

Namespace for multi-domain schemas.

```json
"$defs": {
  "auth.User": {
    "type": "object",
    "x-original-name": "User",
    "x-domain": "auth"
  }
}
```

**Values**: Domain name string

**MST Effect**: Creates nested store structure with domain-prefixed collections.

---

## Complete Example

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "User": {
      "type": "object",
      "x-original-name": "User",
      "required": ["id", "name"],
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid",
          "x-arktype": "string.uuid",
          "x-mst-type": "identifier"
        },
        "name": {
          "type": "string",
          "minLength": 2,
          "x-arktype": "string >= 2"
        },
        "company": {
          "$ref": "#/$defs/Company",
          "x-reference-type": "single",
          "x-arktype": "Company"
        }
      }
    },
    "Company": {
      "type": "object",
      "x-original-name": "Company",
      "required": ["id", "name"],
      "properties": {
        "id": {
          "type": "string",
          "format": "uuid",
          "x-arktype": "string.uuid",
          "x-mst-type": "identifier"
        },
        "name": {
          "type": "string"
        },
        "employees": {
          "type": "array",
          "items": { "$ref": "#/$defs/User" },
          "x-reference-type": "array",
          "x-computed": true,
          "x-inverse": "company"
        }
      }
    }
  }
}
```

---

## Extension Summary

| Extension | Level | Values | Purpose |
|-----------|-------|--------|---------|
| `x-arktype` | Property | ArkType string | Preserve constraints |
| `x-mst-type` | Property | `identifier`, `reference`, `maybe-reference` | MST type hint |
| `x-reference-type` | Property | `single`, `array` | Reference cardinality |
| `x-computed` | Property | `true` | Mark as computed view |
| `x-inverse` | Property | Property name | Inverse relationship |
| `x-original-name` | Definition | Entity name | Preserve name |
| `x-domain` | Definition | Domain name | Multi-domain namespace |

---

## See Also

- [State API Reference](STATE_API.md) — Transformation functions
- [Concepts](../CONCEPTS.md) — Key abstractions
- [Architecture](../ARCHITECTURE.md) — System design
