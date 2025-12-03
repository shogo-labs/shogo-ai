# Enhanced JSON Schema Specification

Enhanced JSON Schema is **JSON Schema 2020-12 with custom x-* extensions** that preserve MobX-State-Tree (MST) model metadata and enable Wavesmith's reactive state management.

---

## Base Structure

```json
{
  "id": "unique-uuid",
  "name": "schema-name",
  "format": "enhanced-json-schema",
  "createdAt": 1735510000000,
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "EntityName": { ... }
  }
}
```

### Required Root Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique schema identifier |
| `name` | string | Schema name (kebab-case) |
| `format` | string | Must be "enhanced-json-schema" |
| `createdAt` | number | Unix timestamp (milliseconds) |
| `$schema` | string | JSON Schema version URL |
| `$defs` | object | Entity definitions |

---

## Entity Definition Structure

```json
"$defs": {
  "EntityName": {
    "type": "object",
    "properties": { ... },
    "required": [...],
    "x-original-name": "EntityName"
  }
}
```

### Required Entity Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Must be "object" for entities |
| `properties` | object | Field definitions |
| `required` | array | Required field names |
| `x-original-name` | string | Original entity name from ArkType |

---

## Field Types

### Simple Fields

**String**:
```json
"fieldName": {
  "type": "string",
  "format": "email" | "date-time" | "uuid" | ...  // Optional
}
```

**Number**:
```json
"score": {
  "type": "number",
  "minimum": 0,     // Optional
  "maximum": 100    // Optional
}
```

**Boolean**:
```json
"isActive": {
  "type": "boolean"
}
```

### Enum Fields

```json
"status": {
  "type": "string",
  "enum": ["pending", "approved", "rejected"]
}
```

**Note**: Empty enum `"enum": []` is valid but uncommon.

### Object Fields (Nested)

**Single nested object**:
```json
"address": {
  "type": "object",
  "properties": {
    "street": { "type": "string" },
    "city": { "type": "string" }
  },
  "required": ["street", "city"]
}
```

**Flexible object** (no predefined structure):
```json
"metadata": {
  "type": "object"
  // No properties defined - accepts any structure
}
```

### Array Fields

**Array of primitives**:
```json
"tags": {
  "type": "array",
  "items": { "type": "string" }
}
```

**Array of objects**:
```json
"comments": {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "text": { "type": "string" },
      "author": { "type": "string" }
    },
    "required": ["text", "author"]
  },
  "minItems": 1,    // Optional: minimum items required
  "maxItems": 100   // Optional: maximum items allowed
}
```

---

## x-* Extensions (Wavesmith-Specific)

### x-original-name

**Purpose**: Preserves original entity name from ArkType schema

**Usage**: Required on all entity definitions

```json
"$defs": {
  "MyEntity": {
    "type": "object",
    "x-original-name": "MyEntity"
  }
}
```

### x-mst-type

**Purpose**: Overrides MST type generation

**Values**:
- `"reference"` - This field references another entity
- `"identifier"` - This field is the entity identifier (rarely used explicitly)

**Usage**: Required for reference fields

```json
"template": {
  "type": "string",
  "x-mst-type": "reference",
  "x-reference-type": "single",
  "x-arktype": "Template"
}
```

### x-reference-type

**Purpose**: Specifies reference cardinality

**Values**:
- `"single"` - One-to-one or many-to-one (single reference)
- `"array"` - One-to-many or many-to-many (array reference)

**Usage**: Required when `x-mst-type: "reference"`

**Single reference** (1:1 or N:1):
```json
"owner": {
  "type": "string",
  "x-mst-type": "reference",
  "x-reference-type": "single",
  "x-arktype": "User"
}
```

**Array reference** (1:N or N:M):
```json
"reviews": {
  "type": "array",
  "items": { "type": "string" },
  "x-mst-type": "reference",
  "x-reference-type": "array",
  "x-arktype": "Review[]"
}
```

### x-arktype

**Purpose**: Original ArkType definition for this field

**Usage**: Required when `x-mst-type: "reference"`

**Format**:
- Single reference: `"EntityName"`
- Array reference: `"EntityName[]"`

```json
// Single
"x-arktype": "Template"

// Array
"x-arktype": "Artifact[]"
```

---

## Reference Patterns

### Single Reference (1:1 or N:1)

**Use when**: One entity references one other entity

**Example**: Review → Document (each review is for one document)

```json
"Document": {
  "type": "object",
  "properties": {
    "id": { "type": "string" }
  }
},
"Review": {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "document": {
      "type": "string",
      "x-mst-type": "reference",
      "x-reference-type": "single",
      "x-arktype": "Document"
    }
  },
  "required": ["id", "document"]
}
```

**Data example**:
```json
{
  "id": "rev-001",
  "document": "doc-001"  // String ID, resolved to Document instance by MST
}
```

### Array Reference (1:N or N:M)

**Use when**: One entity references multiple other entities

**Example**: DiscoverySession → Artifact[] (session has multiple artifacts)

```json
"DiscoverySession": {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "artifacts": {
      "type": "array",
      "items": { "type": "string" },
      "x-mst-type": "reference",
      "x-reference-type": "array",
      "x-arktype": "Artifact[]"
    }
  },
  "required": ["id"]
}
```

**Data example**:
```json
{
  "id": "sess-001",
  "artifacts": ["art-001", "art-002", "art-003"]  // Array of IDs
}
```

### N:M Relationships

**Use when**: Both sides need to navigate the relationship

**Example**: Collection ↔ Recipe (recipes can be in multiple collections)

```json
"Collection": {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "recipes": {
      "type": "array",
      "items": { "type": "string" },
      "x-mst-type": "reference",
      "x-reference-type": "array",
      "x-arktype": "Recipe[]"
    }
  }
}
```

**Note**: Recipe doesn't explicitly list collections. Relationship is navigable from Collection → Recipe. To navigate Recipe → Collection, query collections that contain the recipe ID.

---

## Composition Patterns

### Embedded Objects (Value Objects)

**Use when**: Child has no independent existence

```json
"Template": {
  "type": "object",
  "properties": {
    "sections": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sectionName": { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["sectionName", "content"]
      }
    }
  }
}
```

**Key difference from reference**:
- ❌ No `x-mst-type: "reference"`
- ❌ No string IDs
- ✅ Inline object definition
- ✅ Lifetime bound to parent

---

## Constraint Patterns

### Required Fields

```json
{
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "email": { "type": "string" }
  },
  "required": ["id", "name", "email"]
}
```

**Pattern**: Fields not in `required` array are optional.

### Enums

```json
"status": {
  "type": "string",
  "enum": ["pending", "running", "completed", "failed"]
}
```

**Pattern**: Fixed set of allowed values.

### Numeric Constraints

```json
"confidence": {
  "type": "number",
  "minimum": 0,
  "maximum": 1
}
```

**Available constraints**:
- `minimum` - Inclusive lower bound
- `maximum` - Inclusive upper bound
- `exclusiveMinimum` - Exclusive lower bound
- `exclusiveMaximum` - Exclusive upper bound

### String Formats

```json
"email": {
  "type": "string",
  "format": "email"
}
```

**Common formats**:
- `"email"` - Email address
- `"date-time"` - ISO 8601 date-time
- `"uuid"` - UUID format
- `"uri"` - URI format

### Array Constraints

```json
"ingredients": {
  "type": "array",
  "items": { "type": "string" },
  "minItems": 1,
  "maxItems": 100
}
```

**Available constraints**:
- `minItems` - Minimum array length
- `maxItems` - Maximum array length

---

## Temporal Tracking Pattern

**Pattern**: Use `type: "number"` for Unix timestamps

```json
"createdAt": {
  "type": "number"
},
"updatedAt": {
  "type": "number"
},
"completedAt": {
  "type": "number"
}
```

**Data**: `Date.now()` returns milliseconds since epoch

```javascript
{
  "createdAt": 1735510000000  // milliseconds
}
```

---

## Complete Example

```json
{
  "id": "uuid-123",
  "name": "task-manager",
  "format": "enhanced-json-schema",
  "createdAt": 1735510000000,
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "User": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "username": { "type": "string" },
        "email": { "type": "string", "format": "email" },
        "createdAt": { "type": "number" }
      },
      "required": ["id", "username", "email", "createdAt"],
      "x-original-name": "User"
    },
    "Task": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "owner": {
          "type": "string",
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "User"
        },
        "title": { "type": "string" },
        "status": {
          "type": "string",
          "enum": ["todo", "in_progress", "done"]
        },
        "priority": {
          "type": "number",
          "minimum": 1,
          "maximum": 5
        },
        "tags": {
          "type": "array",
          "items": { "type": "string" }
        },
        "createdAt": { "type": "number" },
        "dueDate": { "type": "number" }
      },
      "required": ["id", "owner", "title", "status", "priority", "createdAt"],
      "x-original-name": "Task"
    }
  }
}
```

---

## Validation Checklist

Before finalizing a schema, verify:

- [ ] Root has all required fields (id, name, format, createdAt, $schema, $defs)
- [ ] All entities in $defs have `type: "object"` and `x-original-name`
- [ ] All entities have `id` field
- [ ] All reference fields have `x-mst-type: "reference"`, `x-reference-type`, and `x-arktype`
- [ ] Reference target entities exist in $defs
- [ ] Enum values are appropriate (not random IDs)
- [ ] Required arrays include field names that actually exist in properties
- [ ] Timestamps use `type: "number"` not "string"

---

## Common Mistakes

### ❌ Missing x-mst-type on Reference

**Wrong**:
```json
"template": {
  "type": "string"
}
```

**Right**:
```json
"template": {
  "type": "string",
  "x-mst-type": "reference",
  "x-reference-type": "single",
  "x-arktype": "Template"
}
```

### ❌ Wrong Type for Array Reference

**Wrong**:
```json
"artifacts": {
  "type": "string",  // Should be array!
  "x-mst-type": "reference",
  "x-reference-type": "array"
}
```

**Right**:
```json
"artifacts": {
  "type": "array",
  "items": { "type": "string" },
  "x-mst-type": "reference",
  "x-reference-type": "array",
  "x-arktype": "Artifact[]"
}
```

### ❌ Reference to Non-Existent Entity

**Wrong**:
```json
{
  "$defs": {
    "Review": {
      "properties": {
        "document": {
          "x-arktype": "Document"  // Document not in $defs!
        }
      }
    }
  }
}
```

**Right**: Ensure Document entity exists in $defs.

### ❌ Timestamp as String

**Wrong**:
```json
"createdAt": {
  "type": "string",
  "format": "date-time"
}
```

**Right** (for Wavesmith):
```json
"createdAt": {
  "type": "number"  // Unix timestamp
}
```

---

## Summary

**Key principles**:
1. Start with valid JSON Schema 2020-12
2. Add `x-mst-type: "reference"` for relationships
3. Use `x-reference-type` to specify cardinality
4. Always include `x-arktype` with references
5. Embed value objects, reference entities
6. Use `type: "number"` for timestamps

**When in doubt**: Look at the three domain examples (document-processing, data-pipeline, webapp) for patterns.
