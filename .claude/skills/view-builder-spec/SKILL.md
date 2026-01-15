---
name: view-builder-spec
description: >
  Capture component specifications from planning dialogue. Use after view-builder
  reaches agreement on a novel visualization (Branch D). Extracts requirements,
  layout decisions, data bindings, and reuse opportunities from the conversation
  and stores as a ComponentSpec entity. Invoke when user approves a plan for
  implementation.
---

# View Builder Spec

Capture agreed component plans as structured ComponentSpec entities for implementation.

## Input

- Planning dialogue from view-builder skill
- User approval of the proposed component plan
- Component-builder schema loaded

## Output

- `ComponentSpec` entity with requirements, decisions, bindings
- PlanPreviewSection displays the spec in workspace
- Handoff to view-builder-implementation when approved

## Workflow

### Phase 1: Load Context

```javascript
schema.load("component-builder")

// Check for existing specs with same name
existingSpec = store.query({
  model: "ComponentSpec",
  schema: "component-builder",
  filter: { name: "..." },
  terminal: "first"
})

// If exists, offer to update or create new
```

Present confirmation:
```
Component Spec Capture

From the planning dialogue, I'll capture:
- Intent: {original user request}
- Component Type: {section | renderer | composition}
- Schemas: {involved schemas}

Proceed with spec extraction?
```

### Phase 2: Extract Specification

**Parse planning dialogue to extract structured artifacts:**

#### 2a. Requirements Extraction

Identify explicit and implicit requirements from the dialogue:

```javascript
requirements = [
  {
    id: "req-001",
    description: "Display tasks in kanban board layout",
    priority: "must-have",  // user explicitly requested
    source: "user"
  },
  {
    id: "req-002",
    description: "Group columns by status field",
    priority: "must-have",
    source: "user"
  },
  {
    id: "req-003",
    description: "Allow drag-and-drop between columns",
    priority: "should-have",  // discussed but not mandatory
    source: "inferred"
  }
]
```

**Priority determination:**
- `must-have`: User explicitly stated or confirmed as essential
- `should-have`: Discussed and agreed, but not blocking
- `could-have`: Mentioned as nice-to-have or future enhancement

**Source determination:**
- `user`: Direct quote or explicit confirmation from user
- `inferred`: Derived from context or implied by other requirements

See [spec-extraction-patterns.md](references/spec-extraction-patterns.md) for extraction heuristics.

#### 2b. Layout Decisions

Capture decisions made during planning with rationale:

```javascript
layoutDecisions = [
  {
    id: "dec-001",
    question: "How should columns be arranged?",
    decision: "Horizontal scroll with fixed-width columns",
    rationale: "Matches standard kanban UX, supports many statuses",
    alternatives: ["Vertical stack", "Grid layout"]
  },
  {
    id: "dec-002",
    question: "What data to show per card?",
    decision: "Title, priority badge, assignee avatar",
    rationale: "Keeps cards scannable without detail overload"
  }
]
```

#### 2c. Data Bindings

Document schema and model dependencies:

```javascript
dataBindings = [
  {
    id: "bind-001",
    schema: "platform-features",
    model: "ImplementationTask",
    purpose: "Primary data source for kanban cards",
    queryPattern: "filter by session, order by priority"
  },
  {
    id: "bind-002",
    schema: "platform-features",
    model: "FeatureSession",
    purpose: "Context for filtering tasks",
    queryPattern: "current session from route/context"
  }
]
```

#### 2d. Interaction Patterns

Capture user interaction requirements:

```javascript
interactionPatterns = [
  {
    id: "int-001",
    interaction: "drag",
    behavior: "Drag card between columns updates task status",
    affectedState: "ImplementationTask.status"
  },
  {
    id: "int-002",
    interaction: "click",
    behavior: "Click card opens detail panel",
    affectedState: "selectedTaskId in component state"
  }
]
```

#### 2e. Reuse Opportunities

Identify existing components or patterns to leverage:

```javascript
reuseOpportunities = [
  {
    id: "reuse-001",
    source: "RequirementsListSection",
    whatToReuse: "Card rendering pattern with badges",
    adaptationNeeded: "Replace requirement data with task data"
  },
  {
    id: "reuse-002",
    source: "TaskCoverageBarSection",
    whatToReuse: "Task filtering logic",
    adaptationNeeded: "Add status-based grouping"
  }
]
```

See [reuse-analysis.md](references/reuse-analysis.md) for identifying reuse opportunities.

#### 2f. Registration Strategy

**CRITICAL**: Capture the architectural decision from view-builder Step 3b.

```javascript
registrationStrategy = {
  strategy: "sectionImplementationMap",  // or "embedded", "rendererBindings", "compositionOnly"
  parentContainer: null,  // If embedded: "SpecContainerSection" or other container
  isDiscoverable: true,   // Can users access via set_workspace?
  registrationLocation: "sectionImplementations.tsx",  // Where to register
  namingConvention: "{Name}Section"  // Expected naming pattern
}
```

**Strategy determination:**

| Strategy | Description | Discoverable | Registration |
|----------|-------------|--------------|--------------|
| `sectionImplementationMap` | Standalone section | Yes | sectionImplementations.tsx |
| `embedded` | Internal to parent container | No | Parent component only |
| `rendererBindings` | Property-level renderer | Via bindings | RendererBindings entity |
| `compositionOnly` | Composition template | Via composition | None (data only) |

**Evidence to extract from dialogue:**
- Did user confirm standalone vs embedded in Step 3b?
- What naming pattern was agreed? ({Name}Section vs {Name}Panel)
- Will this be independently discoverable?
- Is there a parent container that owns this?

**If not explicitly decided in dialogue**: Flag as `strategy: "undecided"` and require clarification before approval.

### Phase 3: Create ComponentSpec

```javascript
store.create("ComponentSpec", "component-builder", {
  id: "spec-{kebab-name}",
  name: "{PascalCaseName}",
  intent: "{original user request}",
  componentType: "section",  // or "renderer", "composition"
  schemas: ["platform-features"],
  status: "draft",

  // Architectural decisions (from Phase 2f)
  registrationStrategy: registrationStrategy.strategy,
  parentContainer: registrationStrategy.parentContainer,
  isDiscoverable: registrationStrategy.isDiscoverable,
  namingConvention: registrationStrategy.namingConvention,

  // Extracted artifacts
  requirements: requirements,
  layoutDecisions: layoutDecisions,
  dataBindings: dataBindings,
  interactionPatterns: interactionPatterns,
  reuseOpportunities: reuseOpportunities,
  createdAt: Date.now()
})
```

### Phase 4: Preview in Workspace

Show the captured spec using PlanPreviewSection:

```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "PlanPreviewSection",
    config: { specId: "spec-{id}" }
  }]
})
```

Present for review:
```
ComponentSpec Created

Name: {name}
Type: {componentType}
Status: draft

Requirements:
- {count} must-have
- {count} should-have
- {count} could-have

Layout Decisions: {count}
Data Bindings: {count}
Interaction Patterns: {count}
Reuse Opportunities: {count}

The spec is displayed in the workspace for review.

Options:
1. Approve for implementation
2. Add/modify requirements
3. Update layout decisions
```

### Phase 5: Approval & Handoff

**Pre-approval validation:**

Before accepting approval, verify:
1. `registrationStrategy` is NOT "undecided"
2. If `registrationStrategy === "embedded"`, then `parentContainer` must be set
3. `namingConvention` matches the strategy (Section for standalone, Panel for embedded)

```javascript
// Block approval if registration strategy is undecided
if (spec.registrationStrategy === "undecided") {
  return "Cannot approve spec with undecided registration strategy. " +
         "Please confirm: standalone section or embedded sub-component?"
}

// Block if embedded without parent
if (spec.registrationStrategy === "embedded" && !spec.parentContainer) {
  return "Embedded components must specify parentContainer."
}
```

When user approves (and validation passes):

```javascript
store.update("spec-{id}", "ComponentSpec", "component-builder", {
  status: "approved",
  updatedAt: Date.now()
})
```

Present handoff:
```
Spec Approved

ComponentSpec: {name}
Status: approved

Ready for implementation. Use /view-builder-implementation to:
1. Generate component code
2. Write tests (TDD-lite)
3. Register component
4. Update ComponentSpec.status to 'implemented'
```

## ComponentSpec Entity Reference

```typescript
interface ComponentSpec {
  id: string
  name: string
  intent: string
  componentType: "section" | "renderer" | "composition"
  schemas?: string[]
  status: "draft" | "approved" | "implemented"

  // Architectural decisions (from view-builder Step 3b)
  registrationStrategy?: "sectionImplementationMap" | "embedded" | "rendererBindings" | "compositionOnly" | "undecided"
  parentContainer?: string      // If embedded, which component contains this
  isDiscoverable?: boolean      // Can users access via set_workspace?
  namingConvention?: string     // Expected naming pattern ("{Name}Section" or "{Name}Panel")

  // Nested value objects
  requirements?: ComponentRequirement[]
  layoutDecisions?: LayoutDecision[]
  dataBindings?: DataBinding[]
  interactionPatterns?: InteractionPattern[]
  reuseOpportunities?: ReuseOpportunity[]

  // Link to result when implemented
  implementedAs?: string  // reference to ComponentDefinition

  createdAt: number
  updatedAt?: number
}
```

## Decision Criteria

### When to Create a ComponentSpec

**DO create spec when:**
- Novel visualization not in existing ComponentDefinitions
- User has approved a plan from view-builder Branch D
- Component will be reusable (not one-off)

**DON'T create spec when:**
- Using existing section with different config
- Simple layout change via set_workspace
- Temporary/exploratory visualization

### Component Type Classification

| Type | When to Use |
|------|-------------|
| `section` | Full panel content with data fetching, used in Compositions |
| `renderer` | Property-level display, used via RendererBindings |
| `composition` | Multi-slot layout combining multiple sections |

### Priority Mapping

| Dialogue Signal | Priority |
|-----------------|----------|
| "I need...", "Must have...", "Required..." | must-have |
| "Would be nice...", "Should...", "I'd like..." | should-have |
| "Maybe later...", "Could add...", "Nice to have..." | could-have |

## References

- [spec-extraction-patterns.md](references/spec-extraction-patterns.md) - How to parse planning dialogue
- [reuse-analysis.md](references/reuse-analysis.md) - Identifying reuse opportunities
