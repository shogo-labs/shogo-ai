# Guidance Discovery Protocol

When building workspaces, section components may have an `aiGuidance` field containing semantic configuration guidance. This protocol describes how to discover and apply that guidance during workspace resolution.

## When to Apply

Apply this protocol whenever you:
- Select a section for a workspace slot
- Compose multiple sections into a multi-panel layout
- Configure a section's `config` object

## Single Section Workflow

When selecting a single section component:

1. **Query full ComponentDefinition**
   ```
   store.query({
     schema: "component-builder",
     model: "ComponentDefinition",
     filter: { implementationRef: "SectionName" }
   })
   ```

2. **If `aiGuidance` exists**, read and extract:
   - Configuration patterns applicable to user's request
   - Data binding requirements (schema, model, query patterns)
   - Usage examples matching the scenario
   - Known limitations or constraints

3. **Fold into config building**
   - Use guidance patterns as authoritative examples
   - Apply recommended defaults from guidance
   - Respect any noted limitations

4. **Mention in response** (optional but helpful)
   - "Configuring {Section} with async query pattern from guidance"

## Multi-Section Composition Workflow

When the user's intent maps to a multi-panel layout with multiple sections:

1. **Identify all sections needed** from user intent
   - Parse request for distinct data views or panel purposes
   - Map each to candidate section components

2. **Query aiGuidance for each section**
   - Load ComponentDefinition for each involved section
   - Extract guidance relevant to that section's role in the composition

3. **Build configs in aggregate**
   - Apply each section's guidance to its respective slot config
   - Ensure no conflicts between sections (e.g., competing data contexts)
   - Consider cross-section interactions noted in any guidance

4. **Compose unified workspace**
   - Select appropriate LayoutTemplate for the panel arrangement
   - Populate slotContent with each section + its guidance-informed config
   - Set shared dataContext if sections share data dependencies

### Example: Two-Panel Composition

User: "Show requirements on the left and implementation tasks on the right"

```
1. Identify sections:
   - Left panel: DataGridSection (requirements)
   - Right panel: DataGridSection (tasks)

2. Query guidance for each:
   - DataGridSection.aiGuidance → extract query patterns

3. Build configs using guidance:
   - Left: { schema: "platform-features", model: "Requirement", query: {} }
   - Right: { schema: "platform-features", model: "ImplementationTask", query: {} }

4. Compose:
   - Layout: "layout-two-column" or similar
   - slotContent: [
       { slot: "left", section: "DataGridSection", config: {...left config...} },
       { slot: "right", section: "DataGridSection", config: {...right config...} }
     ]
```

## Guidance Format

The `aiGuidance` field contains markdown with these typical sections:

- **Configuration Patterns** - Common config shapes with examples
- **Data Loading** - Sync vs async, query builder usage
- **Query Examples** - Filter, sort, paginate patterns
- **Display Options** - Visual customization configs
- **When to Use** - Scenarios this section fits
- **Common Patterns** - User intent → config mappings

## Components Without Guidance

Components without `aiGuidance` continue to work normally:
- Use `supportedConfig` keys as hints
- Apply reasonable defaults based on context
- Infer config from user intent and section purpose

## Key Principle

Guidance is **advisory, not prescriptive**. The agent should:
- Use guidance to inform decisions, not blindly copy examples
- Adapt patterns to the specific user request
- Combine guidance with contextual understanding
- Override guidance if user explicitly requests something different
