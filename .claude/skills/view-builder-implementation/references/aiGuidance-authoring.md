# aiGuidance Authoring

When implementing components, create `aiGuidance` content that helps AI agents correctly configure and use the component.

## When to Add aiGuidance

Add aiGuidance to ComponentDefinition seed data when:
- Component has non-trivial configuration options
- Multiple valid config patterns exist
- Common mistakes are possible
- Component is generic/reusable across contexts

**Timing**: Author aiGuidance once the component is stable and config surface is finalized. Don't document while iterating.

## Structure

Use this markdown structure:

```markdown
## {ComponentName} Configuration Guide

{One-line description of what the component does}

### Required Config
- `{field}`: {description}
- `{field}`: {description}

### {Topic Section}

{Explanation of key concept or decision}

### {Another Topic}

{More guidance}

### Query/Config Examples

```json
// {scenario description}
{ "config": "example" }

// {another scenario}
{ "different": "config" }
```

### Display Options
- `{option}`: {what it does}
- `{option}`: {what it does}

### When to Use
- {scenario 1}
- {scenario 2}
- {scenario 3}

### Common Patterns
- "{user intent}" -> `{ config: "pattern" }`
- "{another intent}" -> `{ different: "pattern" }`
```

## Content Guidelines

### Be Concise
AI agents have context limits. Keep guidance focused and scannable.

```markdown
// GOOD: Direct and actionable
**Sync vs Async:** Add `query: {}` to use async path for database queries.

// BAD: Verbose explanation
The component supports two different data loading mechanisms. The first is
synchronous and uses MobX-State-Tree views which are reactive and...
```

### Show, Don't Just Tell
Include concrete JSON examples for every pattern.

```markdown
// GOOD: Concrete example
// Filter by status
{ "query": { "filter": { "status": "accepted" } } }

// BAD: Abstract description
You can filter by passing a filter object in the query configuration.
```

### Cover Common Mistakes
If there's a gotcha, document it.

```markdown
**Session Filtering:** When a feature context exists, data is filtered by
`feature.id` by default. Set `sessionFilter: false` to show all data.
```

### Map User Intent to Config
The "Common Patterns" section is critical - it maps natural language to config:

```markdown
### Common Patterns
- "Show requirements" -> `{ schema: "platform-features", model: "Requirement", query: {} }`
- "Show tasks in progress" -> `{ schema: "platform-features", model: "ImplementationTask", query: { filter: { status: "in_progress" } } }`
```

## Field Placement

aiGuidance goes in the ComponentDefinition seed data:

```typescript
// packages/mcp/src/seed-data/component-builder.ts
{
  id: "comp-{name}-section",
  name: "{Name}Section",
  category: "section",
  description: "...",
  implementationRef: "{Name}Section",
  tags: [...],
  supportedConfig: ["schema", "model", "query", ...],
  aiGuidance: `## {Name}Section Configuration Guide

{Full guidance content here}
`,
}
```

## Quality Checklist

Before finalizing aiGuidance:

- [ ] All required config fields documented
- [ ] At least 3 query/config examples provided
- [ ] Common patterns section maps user intent to config
- [ ] Any gotchas or defaults explicitly noted
- [ ] "When to Use" section helps agent decide if component fits
- [ ] Examples use realistic schema/model names from the platform
- [ ] JSON examples are valid and copy-pasteable

## Reference Example

See DataGridSection in `component-builder.ts` for a complete aiGuidance example covering:
- Required config (schema, model)
- Data loading explanation (sync vs async)
- Query examples (filter, sort, paginate, combined)
- Display options
- When to use
- Common patterns
