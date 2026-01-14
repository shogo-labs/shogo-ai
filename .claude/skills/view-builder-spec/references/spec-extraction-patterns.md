# Spec Extraction Patterns

Guidelines for extracting structured ComponentSpec artifacts from planning dialogue.

## Dialogue Analysis Approach

### 1. Identify the Original Intent

Look for the triggering message that started the planning dialogue:

```
User: "Show me tasks as a kanban board"
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      This becomes ComponentSpec.intent
```

**Extract verbatim** - don't paraphrase. The intent captures the user's original words.

### 2. Classify Component Type

| Dialogue Pattern | Component Type |
|------------------|----------------|
| "Show me X", "Display X", "Visualize X" | section |
| "Render X as Y", "X should look like Y" | renderer |
| "Dashboard with X and Y", "Combined view" | composition |

### 3. Extract Requirements

**Must-have indicators:**
- "I need..."
- "Must have..."
- "Required..."
- "Essential..."
- "Has to..."
- Direct affirmative response to feature question

**Should-have indicators:**
- "Would be nice..."
- "Should..."
- "I'd like..."
- "Ideally..."
- Positive but hedged responses

**Could-have indicators:**
- "Maybe later..."
- "Could add..."
- "Nice to have..."
- "Possibly..."
- Future enhancement discussions

**Source classification:**
- `user`: Direct quote or explicit "yes" to a question
- `inferred`: Derived from context, implied by other requirements

### Example Extraction

```
User: "Show me tasks as a kanban board grouped by status"

Claude: "I can create that. Should each card show priority and assignee?"

User: "Yes, priority is important. Assignee would be nice."

Claude: "Want drag-and-drop to change status?"

User: "Yes, that's essential."
```

**Extracted requirements:**
```javascript
[
  {
    id: "req-001",
    description: "Display tasks in kanban board layout",
    priority: "must-have",
    source: "user"  // Direct request
  },
  {
    id: "req-002",
    description: "Group columns by status field",
    priority: "must-have",
    source: "user"  // Direct request
  },
  {
    id: "req-003",
    description: "Show priority on each card",
    priority: "must-have",
    source: "user"  // "priority is important"
  },
  {
    id: "req-004",
    description: "Show assignee on each card",
    priority: "should-have",
    source: "user"  // "would be nice"
  },
  {
    id: "req-005",
    description: "Drag-and-drop to change task status",
    priority: "must-have",
    source: "user"  // "essential"
  }
]
```

## Layout Decision Extraction

Look for questions and answers about structure:

**Question patterns:**
- "How should X be arranged?"
- "Where should X appear?"
- "What layout for X?"
- "Should X be inline or block?"

**Decision patterns:**
- "Let's use..."
- "I prefer..."
- "Go with..."
- Affirmative responses to layout suggestions

**Capture alternatives** when multiple options were discussed:
```javascript
{
  id: "dec-001",
  question: "How should columns be arranged?",
  decision: "Horizontal scroll with fixed-width columns",
  rationale: "Matches standard kanban UX",
  alternatives: ["Vertical stack", "Grid layout"]
}
```

## Data Binding Extraction

Look for schema/model references:

**Explicit references:**
- "From the tasks table..."
- "Query ImplementationTask..."
- "Filter by session..."

**Implicit references:**
- "Show the status" → need to know which model has status
- "Group by priority" → priority field implies specific model

**Query pattern hints:**
- "Filter by X" → `filter: { X: ... }`
- "Order by X" → `orderBy: { X: "asc" }`
- "Group by X" → grouping logic in component

## Interaction Pattern Extraction

Look for user behavior discussions:

| Dialogue | Interaction Type |
|----------|------------------|
| "Click to...", "When clicked..." | click |
| "Drag to...", "Move cards..." | drag |
| "Hover shows...", "On hover..." | hover |
| "Select...", "Pick..." | selection |

**Affected state identification:**
- "Updates the status" → model field mutation
- "Opens detail panel" → component state change
- "Filters the list" → filter state change

## Common Extraction Mistakes

### 1. Over-inferring Requirements
**Wrong:** Adding requirements not discussed
**Right:** Only capture what was explicitly discussed or clearly implied

### 2. Missing Context
**Wrong:** "Show tasks" without specifying which model
**Right:** "Show ImplementationTask entities from platform-features schema"

### 3. Vague Decisions
**Wrong:** "Use standard layout"
**Right:** "Use two-column layout with main content left, sidebar right"

### 4. Missing Rationale
**Wrong:** `decision: "Horizontal columns"`
**Right:** `decision: "Horizontal columns", rationale: "Matches user's existing mental model from Trello"`

## Validation Checklist

Before creating ComponentSpec, verify:

- [ ] Intent captured verbatim from original request
- [ ] Component type matches the visualization scope
- [ ] All discussed requirements included
- [ ] Priority reflects dialogue signals, not assumptions
- [ ] Layout decisions have rationale
- [ ] Data bindings specify schema AND model
- [ ] Interaction patterns identify affected state
