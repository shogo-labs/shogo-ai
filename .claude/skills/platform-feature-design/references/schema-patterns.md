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

## Naming Conventions

- **Entities**: PascalCase (`User`, `ApiKey`, `AuditLog`)
- **Fields**: camelCase (`createdAt`, `passwordHash`)
- **Enums**: lowercase with underscores or camelCase
- **Schema names**: kebab-case (`auth-layer`, `platform-features`)
