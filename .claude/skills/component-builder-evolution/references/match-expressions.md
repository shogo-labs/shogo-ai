# Match Expression Reference

Match expressions use MongoDB-style query syntax to match `PropertyMetadata` objects. The system uses `@ucast/js` for parsing and interpretation.

## PropertyMetadata Fields

These are the fields you can match against:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Property name |
| `type` | "string" \| "number" \| "boolean" \| "array" \| "object" | JSON Schema type |
| `format` | string | JSON Schema format (email, uri, date-time, etc.) |
| `enum` | string[] | Enum values if present |
| `xReferenceType` | "single" \| "array" | MST reference type |
| `xReferenceTarget` | string | Target model name for references |
| `xComputed` | boolean | Whether property is computed/derived |
| `xRenderer` | string | Explicit renderer binding ID |
| `required` | boolean | Whether property is required |

---

## Basic Patterns

### Type Matching
```json
{ "type": "string" }
{ "type": "number" }
{ "type": "boolean" }
{ "type": "array" }
{ "type": "object" }
```

### Format Matching
```json
{ "format": "email" }
{ "format": "uri" }
{ "format": "date-time" }
{ "format": "date" }
{ "format": "time" }
```

### Explicit x-renderer
```json
{ "xRenderer": "priority-badge" }
{ "xRenderer": "status-indicator" }
```

### Reference Matching
```json
{ "xReferenceType": "single" }
{ "xReferenceType": "array" }
```

### Computed Properties
```json
{ "xComputed": true }
```

---

## Operators

### $exists - Field Existence
```json
{ "enum": { "$exists": true } }
{ "format": { "$exists": true } }
{ "xRenderer": { "$exists": false } }
```

### $eq - Equality (implicit)
```json
{ "type": "string" }
// Same as:
{ "type": { "$eq": "string" } }
```

### $ne - Not Equal
```json
{ "type": { "$ne": "object" } }
```

### $in - Value in Array
```json
{ "format": { "$in": ["email", "uri"] } }
{ "type": { "$in": ["string", "number"] } }
```

### $nin - Value Not in Array
```json
{ "type": { "$nin": ["array", "object"] } }
```

### $regex - Regular Expression
```json
{ "name": { "$regex": "^status" } }
{ "format": { "$regex": "date" } }
```

---

## Logical Operators

### $and - All Conditions Must Match
```json
{
  "$and": [
    { "type": "string" },
    { "format": "email" }
  ]
}
```

### $or - Any Condition Can Match
```json
{
  "$or": [
    { "format": "email" },
    { "format": "uri" }
  ]
}
```

### $not - Negate Condition
```json
{
  "$not": { "type": "object" }
}
```

---

## Complex Examples

### String with specific format
```json
{
  "$and": [
    { "type": "string" },
    { "format": "email" }
  ]
}
```

### Any enum property
```json
{ "enum": { "$exists": true } }
```

### Enum with specific values
```json
{
  "$and": [
    { "enum": { "$exists": true } },
    { "name": "status" }
  ]
}
```

### Non-computed string
```json
{
  "$and": [
    { "type": "string" },
    { "xComputed": { "$ne": true } }
  ]
}
```

### Reference to specific model
```json
{
  "$and": [
    { "xReferenceType": "single" },
    { "xReferenceTarget": "User" }
  ]
}
```

### Either email format or explicit email renderer
```json
{
  "$or": [
    { "format": "email" },
    { "xRenderer": "email-display" }
  ]
}
```

### Required string fields only
```json
{
  "$and": [
    { "type": "string" },
    { "required": true }
  ]
}
```

---

## Priority Interaction

Match expressions work with priority to determine which binding wins:

1. **Higher priority wins** - A binding with priority 200 beats priority 100
2. **First match wins** - For equal priorities, first binding in sorted order wins
3. **Child registries first** - Bindings from child registry checked before parent

### Example: Override type with format
```json
// Type binding (priority 10)
{ "matchExpression": { "type": "string" }, "priority": 10 }

// Format binding (priority 30) - wins for emails
{ "matchExpression": { "format": "email" }, "priority": 30 }
```

### Example: Explicit override
```json
// Generic enum binding (priority 50)
{ "matchExpression": { "enum": { "$exists": true } }, "priority": 50 }

// Explicit status badge (priority 200) - wins when x-renderer declared
{ "matchExpression": { "xRenderer": "status-badge" }, "priority": 200 }
```

---

## Debugging Match Expressions

### Test in BindingEditorPanel
1. Open with Cmd+Shift+B
2. Click on a binding to edit
3. Modify matchExpression JSON
4. Save and observe UI changes

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Binding never matches | Invalid JSON syntax | Validate JSON |
| Binding never matches | Field name typo | Check PropertyMetadata fields |
| Wrong binding matches | Priority too low | Increase priority |
| Multiple bindings conflict | Same priority | Adjust priorities |

---

## Source Implementation

Match expressions are compiled via `createMatcherFromExpression()` in:
`packages/state-api/src/component-builder/match-expression.ts`

Uses `@ucast/js` with AST caching for performance.
