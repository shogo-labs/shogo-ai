# Reuse Analysis

Guidelines for identifying and documenting reuse opportunities from existing components.

## Why Reuse Matters

1. **Consistency** - Users get familiar patterns
2. **Speed** - Less code to write
3. **Quality** - Proven patterns have fewer bugs
4. **Maintenance** - Fewer unique components to maintain

## Finding Reuse Candidates

### 1. Query Existing Sections

```javascript
// Find sections with similar tags
sections = store.query({
  model: "ComponentDefinition",
  schema: "component-builder",
  filter: { category: "section" }
})

// Look for tag overlaps with new component needs
```

**Relevant tags for matching:**
- `list` - List rendering patterns
- `grid` - Grid layouts
- `visualization` - Data visualization
- `interactive` - User interaction handling
- Domain-specific: `discovery-phase`, `analysis-phase`, etc.

### 2. Match by Data Pattern

| New Component Needs | Look For |
|---------------------|----------|
| Entity list display | RequirementsListSection, FindingListSection |
| Status grouping | TaskExecutionTimelineSection |
| Progress visualization | ProgressBar, TestPyramidSection |
| Card-based layout | RequirementCard, FindingCard |
| Matrix/grid data | FindingMatrixSection |
| Terminal-style output | IntentTerminalSection, LiveOutputTerminalSection |

### 3. Match by Interaction Pattern

| Interaction | Source Components |
|-------------|-------------------|
| Selection state | FindingMatrixSection, SpecContainerSection |
| Drag-and-drop | (would need to build) |
| Expand/collapse | ArrayDisplay, ObjectDisplay |
| Filter/search | FindingListSection |
| Tab navigation | DesignContainerSection |

## Reuse Opportunity Structure

```typescript
interface ReuseOpportunity {
  id: string
  source: string        // ComponentDefinition name or file path
  whatToReuse: string   // Specific pattern or code to reuse
  adaptationNeeded?: string  // What changes are required
}
```

### Example: Kanban from List

```javascript
{
  id: "reuse-001",
  source: "RequirementsListSection",
  whatToReuse: "Card rendering with priority badges, grouped list structure",
  adaptationNeeded: "Replace vertical groups with horizontal columns, add drag-drop"
}
```

### Example: Status Cards from Timeline

```javascript
{
  id: "reuse-002",
  source: "TaskExecutionTimelineSection",
  whatToReuse: "Status dot color coding, clickable selection pattern",
  adaptationNeeded: "Adapt timeline layout to card layout"
}
```

## Adaptation Categories

### 1. Data Swap
Same visual, different data source
```
Source: RequirementsListSection
Swap: Requirement → ImplementationTask
Keep: Card layout, priority badges, grouping
```

### 2. Layout Transformation
Same data, different arrangement
```
Source: FindingListSection (vertical)
Transform: Vertical list → Kanban columns
Keep: Card component, filter logic
```

### 3. Interaction Addition
Add interactivity to static component
```
Source: ProgressBar (display only)
Add: Click segments to filter, hover for details
Keep: Visual rendering, color calculation
```

### 4. Composition
Combine multiple existing components
```
Sources: [ProgressBar, DataCard, StatusIndicator]
Compose: Dashboard section with all three
Keep: Individual component implementations
```

## Anti-Patterns

### 1. Forced Reuse
**Wrong:** Contorting existing component to fit unrelated use case
**Right:** Build new when concepts don't align

### 2. Shallow Reuse
**Wrong:** "Reuse RequirementCard" when only the card border is similar
**Right:** Be specific: "Reuse card shadow/border styling"

### 3. Missing Adaptation
**Wrong:** "Just use FindingListSection"
**Right:** Document what changes: data source, grouping logic, etc.

## Reuse Discovery Workflow

1. **List component needs** from requirements
2. **Query ComponentDefinitions** by category and tags
3. **Read source code** of promising candidates
4. **Identify specific patterns** to reuse
5. **Document adaptations** needed
6. **Estimate effort** - reuse should save time, not add complexity

## No Good Match?

If no reuse opportunity found:
- Document that explicitly: `reuseOpportunities: []`
- Note why: "Novel visualization type not in existing catalog"
- This is valuable signal for future component library growth

## Section 5: Architectural Pattern Matching

Beyond code reuse, consider **architectural reuse** - where does this new component belong in the system hierarchy?

### Architectural Reuse Levels

| Level | What It Means | Example |
|-------|---------------|---------|
| **Code Reuse** | Copy/adapt code from source | Extract card rendering logic |
| **Sub-component** | Embed inside existing container | DataGridPanel inside ComponentBuilderSection |
| **Container Extension** | Add capability to existing container | New layout option for existing section |
| **Standalone Section** | Independent, discoverable component | RequirementsListSection |

### Finding Container Homes

Before creating a standalone section, check if an existing container is the right home:

| Existing Container | Good Fit For | Bad Fit For |
|--------------------|--------------|-------------|
| `ComponentBuilderSection` | Layout/rendering variations of collection data | Unrelated data types, specialized visualizations |
| `DesignContainerSection` | Schema-related views, design artifacts | Non-schema data |
| `SpecContainerSection` | Implementation spec displays | Runtime data |
| `DynamicCompositionSection` | Rendering saved compositions | New component logic |

### Decision Framework

**Consider embedding (sub-component) when:**
- Capability only makes sense within specific parent context
- Parent already handles data loading, context, state
- Users would never want this independently
- Naming would be confusing as standalone (e.g., "CollectionKanbanSection" when ComponentBuilder already does collections)

**Consider standalone section when:**
- Capability is independently useful in multiple contexts
- Users would want to compose it with other sections
- It handles its own data loading and context
- It represents a distinct concept, not a variation of existing

### Architecture Anti-Patterns

**Anti-pattern 1: Suffix Confusion**
```
❌ DataGridSection embedded in ComponentBuilderSection
   - "Section" suffix implies standalone, but it's embedded
   - Creates discovery confusion

✅ DataGridPanel embedded in ComponentBuilderSection
   - "Panel" suffix indicates internal component
   - Clear hierarchical relationship
```

**Anti-pattern 2: Premature Standalone**
```
❌ Creating KanbanLayoutSection when ComponentBuilderSection
   already handles collection layouts
   - Duplicates data loading logic
   - Fragments the component builder concept

✅ Adding kanban as a layout option to ComponentBuilderSection
   - Extends existing capability
   - Single source of truth for collection rendering
```

**Anti-pattern 3: Buried Capability**
```
❌ Embedding a general-purpose DataGrid inside ComponentBuilderSection
   when datagrids would be useful in many contexts
   - Hides reusable capability
   - Forces component builder dependency

✅ Creating standalone DataGridSection, used BY ComponentBuilderSection
   - Maximizes reusability
   - Clear dependency direction
```

### Naming Conventions by Architecture

| Architecture | Pattern | Examples |
|--------------|---------|----------|
| Standalone Section | `{Name}Section` | `RequirementsListSection`, `DataGridSection` |
| Embedded Panel | `{Name}Panel` | `PreviewPanel`, `DefinitionPanel` |
| Internal Display | `{Name}Display` | `ArrayDisplay`, `ObjectDisplay` |
| Shared Renderer | `{Name}Renderer` | `BadgeRenderer`, `StatusRenderer` |
