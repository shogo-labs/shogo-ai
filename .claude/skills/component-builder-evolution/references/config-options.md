# XRendererConfig Reference

`XRendererConfig` controls how display components render values. Config can be set at:
1. **Binding level** - `defaultConfig` on RendererBinding (applies to all matches)
2. **Schema level** - `x-renderer-config` on property definition (overrides binding)

## Config Options

### variant
Visual emphasis or semantic meaning.

| Value | Description | Tailwind Classes |
|-------|-------------|------------------|
| `"default"` | Normal appearance | (none) |
| `"muted"` | De-emphasized, secondary | `text-muted-foreground` |
| `"emphasized"` | Bold, important | `font-semibold` |
| `"warning"` | Caution state | `text-amber-600` |
| `"success"` | Positive state | `text-green-600` |
| `"error"` | Error/danger state | `text-red-600` |

**Example:**
```json
{ "variant": "emphasized" }
```

---

### size
Text/element size.

| Value | Description | Tailwind Classes |
|-------|-------------|------------------|
| `"xs"` | Extra small | `text-xs` |
| `"sm"` | Small | `text-sm` |
| `"md"` | Medium (default) | (none) |
| `"lg"` | Large | `text-lg` |
| `"xl"` | Extra large | `text-xl` |

**Example:**
```json
{ "size": "lg" }
```

---

### layout
Display mode for components that support it.

| Value | Description |
|-------|-------------|
| `"inline"` | Inline with surrounding content |
| `"block"` | Full width block |
| `"compact"` | Minimal spacing, dense layout |

**Example:**
```json
{ "layout": "compact" }
```

---

### truncate
Text truncation behavior.

| Value | Description |
|-------|-------------|
| `false` | No truncation |
| `true` | Truncate at 200 characters (default) |
| `number` | Truncate at specified character count |

**Example:**
```json
{ "truncate": 50 }
{ "truncate": false }
```

---

### expandable
Allow expanding truncated or collapsed content.

| Value | Description |
|-------|-------------|
| `true` | Show expand/collapse control |
| `false` | No expansion (default) |

**Example:**
```json
{ "expandable": true }
```

---

### clickable
Make element interactive/clickable.

| Value | Description |
|-------|-------------|
| `true` | Enable click behavior (links, actions) |
| `false` | Static display (default) |

**Example:**
```json
{ "clickable": true }
```

---

### customProps
Pass-through for component-specific props.

**Example:**
```json
{
  "customProps": {
    "showIcon": true,
    "iconPosition": "left"
  }
}
```

---

## Full Interface

```typescript
interface XRendererConfig {
  variant?: "default" | "muted" | "emphasized" | "warning" | "success" | "error"
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  layout?: "inline" | "block" | "compact"
  truncate?: boolean | number
  expandable?: boolean
  clickable?: boolean
  customProps?: Record<string, unknown>
}
```

---

## Component Support

Not all components support all config options. Check `supportedConfig`:

| Component | Supported Config |
|-----------|------------------|
| StringDisplay | size, variant, truncate, layout |
| NumberDisplay | size, variant |
| BooleanDisplay | size, variant |
| DateTimeDisplay | size, variant |
| EmailDisplay | size, variant, clickable |
| UriDisplay | size, variant, truncate, clickable |
| EnumBadge | size, variant |
| ReferenceDisplay | size, variant, clickable |
| ComputedDisplay | size, variant, layout |
| ArrayDisplay | size, variant, expandable, layout |
| ObjectDisplay | size, variant, expandable, layout |
| StringArrayDisplay | size, variant, layout, expandable |
| LongTextDisplay | size, variant, truncate, expandable |
| CodePathDisplay | size, truncate, clickable |

---

## Config Cascade

Config is merged with binding defaults taking lowest priority:

```
Component defaults < Binding defaultConfig < Schema x-renderer-config
```

**Example:**

1. Component default: `{ size: "md" }`
2. Binding defaultConfig: `{ size: "sm", variant: "muted" }`
3. Schema x-renderer-config: `{ variant: "emphasized" }`

**Result:** `{ size: "sm", variant: "emphasized" }`

---

## Common Patterns

### Compact dashboard display
```json
{
  "size": "xs",
  "truncate": 30,
  "layout": "compact"
}
```

### Emphasized email with click
```json
{
  "size": "lg",
  "variant": "emphasized",
  "clickable": true
}
```

### Expandable long text
```json
{
  "truncate": 100,
  "expandable": true,
  "variant": "muted"
}
```

### Warning status badge
```json
{
  "variant": "warning",
  "size": "sm"
}
```

---

## MCP Operations

### Update binding config
```javascript
store.update({
  model: "RendererBinding",
  schema: "component-builder",
  id: "email-display",
  changes: {
    defaultConfig: {
      size: "lg",
      variant: "emphasized",
      clickable: true
    },
    updatedAt: Date.now()
  }
})
```

### Create binding with config
```javascript
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "custom-binding",
    name: "Custom Binding",
    registry: "studio",
    component: "comp-string-display",
    matchExpression: { type: "string", format: "path" },
    priority: 35,
    defaultConfig: {
      size: "xs",
      truncate: 60,
      variant: "muted"
    },
    createdAt: Date.now()
  }
})
```
