# Priority Guide

How binding priorities determine which component renders a property.

---

## Priority Cascade

When multiple bindings match a property, the **highest priority wins**.

| Priority | Category | Use Case |
|----------|----------|----------|
| **200** | Explicit | `xRenderer` schema declaration |
| **100** | Metadata | `xComputed`, `xReferenceType` |
| **50** | Enum | Properties with `enum` array |
| **30** | Format | `format`: email, uri, date-time |
| **10** | Type | `type`: string, number, boolean |
| **0** | Fallback | Default when nothing matches |

---

## Resolution Algorithm

1. Collect all bindings from registry (including inherited from parent)
2. Sort bindings by priority descending
3. For each binding, test `matchExpression` against property metadata
4. First matching binding wins
5. If no binding matches, use fallback component (StringDisplay)

```typescript
for (const binding of sortedBindings) {
  if (binding.matcher(propertyMetadata)) {
    return binding.component
  }
}
return fallbackComponent
```

---

## Priority 200: Explicit x-renderer

Use when schema explicitly declares which renderer to use.

**Schema declaration:**
```json
{
  "status": {
    "type": "string",
    "enum": ["pending", "active", "complete"],
    "x-renderer": "session-status-badge"
  }
}
```

**Binding:**
```json
{
  "matchExpression": { "xRenderer": "session-status-badge" },
  "priority": 200
}
```

**When to use:**
- Domain-specific visualization
- Custom badges for specific fields
- Override generic enum handling

---

## Priority 100: Metadata-based

Use for MST-specific metadata that needs special rendering.

**Examples:**
```json
// Computed properties
{ "matchExpression": { "xComputed": true }, "priority": 100 }

// Single references
{ "matchExpression": { "xReferenceType": "single" }, "priority": 100 }

// Array references
{ "matchExpression": { "xReferenceType": "array" }, "priority": 100 }
```

**When to use:**
- Computed fields that should look different
- MST references that need navigation
- Derived values

---

## Priority 50: Enum-based

Use for any property with enum values.

**Binding:**
```json
{
  "matchExpression": { "enum": { "$exists": true } },
  "priority": 50
}
```

**When to use:**
- Generic colored badge for enums
- Dropdown selections
- Status indicators

**Note:** Explicit x-renderer (200) overrides this for domain-specific enums.

---

## Priority 30: Format-based

Use for JSON Schema format strings.

**Common formats:**
```json
// Email
{ "matchExpression": { "format": "email" }, "priority": 30 }

// URI
{ "matchExpression": { "format": "uri" }, "priority": 30 }

// Date-time
{ "matchExpression": { "format": "date-time" }, "priority": 30 }
```

**When to use:**
- Special display for standard formats
- Clickable links for emails/URIs
- Formatted dates

**Custom formats** (use priority 35 to beat generic format):
```json
{
  "matchExpression": { "format": "file-path" },
  "priority": 35
}
```

---

## Priority 10: Type-based

Fallback for basic JSON Schema types.

**Types:**
```json
// String
{ "matchExpression": { "type": "string" }, "priority": 10 }

// Number
{ "matchExpression": { "type": "number" }, "priority": 10 }

// Boolean
{ "matchExpression": { "type": "boolean" }, "priority": 10 }

// Array
{ "matchExpression": { "type": "array" }, "priority": 10 }

// Object
{ "matchExpression": { "type": "object" }, "priority": 10 }
```

**When to use:**
- Base rendering for primitive types
- Catch-all for unmatched properties

---

## Priority 0: Fallback

The registry's `fallbackComponent` (typically StringDisplay).

Used when:
- No binding matches the property
- All matchers return false

---

## Complex Matches

For complex conditions, use intermediate priorities:

```json
// String with URI format - priority 30 (format)
{ "matchExpression": { "format": "uri" }, "priority": 30 }

// String with custom path format - priority 35 (beats generic format)
{
  "matchExpression": {
    "$and": [
      { "type": "string" },
      { "format": "file-path" }
    ]
  },
  "priority": 35
}

// Any URI regardless of type - priority 32
{
  "matchExpression": { "format": { "$regex": "uri" } },
  "priority": 32
}
```

---

## Registry Inheritance

Child registry bindings are checked before parent bindings:

```
studio (extends default)
└── Binding A (priority 200)
└── Binding B (priority 50)
    default
    └── Binding C (priority 100)
    └── Binding D (priority 50)
```

**Resolution order:**
1. Binding A (200) - studio
2. Binding C (100) - default
3. Binding B (50) - studio ← checked before D due to child-first
4. Binding D (50) - default

---

## Debugging Priority Issues

### Binding Not Taking Effect

**Symptom:** Your new binding is ignored.

**Check:**
1. Is there a higher-priority binding matching the same property?
2. Is the matchExpression correct?
3. Is the binding in the correct registry?

**Debug:**
```javascript
// Query all bindings
const bindings = store.query({
  model: "RendererBinding",
  schema: "component-builder"
})

// Sort by priority to see cascade
bindings.sort((a, b) => b.priority - a.priority)

// Check which would match your property
for (const b of bindings) {
  console.log(`${b.id}: priority ${b.priority}, matches: ${JSON.stringify(b.matchExpression)}`)
}
```

### Multiple Bindings Matching

**Symptom:** Wrong component renders.

**Check:**
1. Compare priorities
2. Check child-first ordering
3. Look for overly broad matchExpressions

**Solution:** Increase priority or make matchExpression more specific.

---

## Best Practices

1. **Use standard priorities** - Stick to 200/100/50/30/10/0 convention
2. **Be specific** - Use narrow matchExpressions to avoid conflicts
3. **Prefer explicit** - Use x-renderer for domain-specific rendering
4. **Document** - Comment why you chose a particular priority
5. **Test** - Verify bindings work via BindingEditorPanel

---

## Quick Reference

| Want to render... | Priority | Match |
|-------------------|----------|-------|
| Specific field by name | 200 | `{ xRenderer: "..." }` |
| Computed properties | 100 | `{ xComputed: true }` |
| MST references | 100 | `{ xReferenceType: "..." }` |
| Any enum | 50 | `{ enum: { $exists: true } }` |
| Email format | 30 | `{ format: "email" }` |
| URI format | 30 | `{ format: "uri" }` |
| Date-time format | 30 | `{ format: "date-time" }` |
| Custom format | 35 | `{ format: "custom" }` |
| String type | 10 | `{ type: "string" }` |
| Number type | 10 | `{ type: "number" }` |
| Everything else | 0 | fallback |
