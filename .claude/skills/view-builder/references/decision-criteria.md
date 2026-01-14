# Decision Criteria Reference

Explicit criteria for classifying user intent into branches.

## The Core Question

> **What is the user trying to accomplish with their request?**

Apply these criteria in order until one matches.

---

## Branch A: View Existing Data

**Trigger phrases:**
- "Show me X"
- "Display X"
- "Let me see X"
- "What are the X?"

**Criteria checklist:**
- [ ] User is asking to VIEW or DISPLAY data
- [ ] Data type mentioned exists as a known schema/model
- [ ] No presentation format specified (no "as kanban", "as grid")
- [ ] No styling or grouping specified

**Evidence to confirm:**
```
Query: Does model exist in available schemas?
→ schema_list OR store_query model="ComponentDefinition"

Query: Is there a section for this model?
→ store_query filter={ category: "section", tags: { $in: ["[model]-phase"] } }
```

**If criteria met:** Proceed with Branch A execution

**Common misclassification:**
- "Show me requirements grouped by priority" → This is Branch B (has grouping)
- "Show me a kanban of tasks" → This is Branch B (has layout format)

---

## Branch B: Change Presentation

**Trigger phrases:**
- "Show X as Y" (X = data, Y = format)
- "Display X in Y format"
- "Group by Z"
- "Sort by Z"
- "Make X more prominent"
- "Add colors to X"

**Criteria checklist:**
- [ ] User is asking to change HOW data displays
- [ ] Uses layout terms: kanban, grid, list, table, cards
- [ ] OR uses styling terms: colors, emphasis, size, grouping
- [ ] OR references specific properties to highlight

**Evidence to confirm:**
```
Query: What layout format is requested?
→ Match "kanban" → layout-workspace-* with kanban config
→ Match "grid" → grid layout
→ Match "list" → list layout

Query: What field to group/sort by?
→ Extract from request ("grouped by priority" → groupBy: "priority")
→ If ambiguous, ask ONE question: "Which field should I group by?"

Query: Does binding for requested style exist?
→ store_query model="RendererBinding" filter={ matchExpression: {...} }
```

**If criteria met:** Proceed with Branch B execution

**Common misclassification:**
- "Build me a dashboard" → This is Branch C (multiple components)
- "Show dependency graph" → This might be Branch D (novel visualization)

---

## Branch C: Compose Multiple

**Trigger phrases:**
- "Build me a dashboard"
- "Show X and Y together"
- "Side by side view of X and Y"
- "Combined view with X, Y, Z"
- "Create a dashboard"

**Criteria checklist:**
- [ ] Multiple data types or views mentioned
- [ ] OR explicit "dashboard" keyword
- [ ] OR spatial arrangement terms: "side by side", "together", "combined"

**Evidence to confirm:**
```
Query: What components are needed?
→ Parse request for each data type mentioned
→ Classify each as Branch A (existing) or Branch D (novel)

Query: Do all needed components exist?
→ store_query model="ComponentDefinition" for each type

Query: What layout arranges them best?
→ 2 components → split-h or split-v
→ 3+ components → grid or custom layout
```

**If criteria met:** Proceed with Branch C execution

**Decomposition rule:** Each sub-component is classified independently:
- "Dashboard with requirements and dependencies" → Requirements (A), Dependencies (D)

---

## Branch D: Novel Visualization

**Trigger phrases:**
- "Show as [novel format]" where format isn't list/grid/kanban/table
- "Dependency graph"
- "Timeline view"
- "Force-directed layout"
- "Network diagram"
- "Gantt chart"

**Criteria checklist:**
- [ ] Requested visualization doesn't exist in ComponentDefinitions
- [ ] OR visualization requires capabilities beyond current sections
- [ ] Capability type: relational (graphs), temporal (timelines), spatial (maps)

**Evidence to confirm:**
```
Query: Does a component exist for this visualization?
→ store_query model="ComponentDefinition" filter={ tags: { $in: ["graph", "timeline", ...] } }

Query: What capability is required?
→ "graph", "network", "dependencies" → relational
→ "timeline", "history", "over time" → temporal
→ "map", "location", "position" → spatial

Query: Can we approximate with existing?
→ relational → tree list, dependency table
→ temporal → sorted list by date
→ spatial → grouped list by location
```

**If criteria met:** Proceed with Branch D execution

**Approximation strategy:**
- Always render SOMETHING immediately
- Offer to build full capability as follow-up

---

## Decision Flowchart

```
User Request
    │
    ▼
Contains "dashboard" OR multiple data types?
    │
    ├─ YES → Branch C: Compose Multiple
    │
    └─ NO
        │
        ▼
    Contains layout terms (kanban/grid/list) OR styling terms?
        │
        ├─ YES → Branch B: Change Presentation
        │
        └─ NO
            │
            ▼
        Is visualization type standard (list/table/cards)?
            │
            ├─ YES → Branch A: View Existing Data
            │
            └─ NO → Branch D: Novel Visualization
```

---

## Common Misclassification Scenarios

### Scenario 1: Grouping Interpreted as Simple View
**Request:** "Show me requirements"
**Trap:** Classify as Branch A
**Reality:** If followed by "grouped by priority" → Branch B

**Resolution:** Listen for complete request before classifying

### Scenario 2: Novel Format in Familiar Terms
**Request:** "Show tasks as a tree"
**Trap:** "Tasks" exists, so Branch A?
**Reality:** "Tree" is a novel visualization → Branch D

**Resolution:** Check if format term (tree) matches available layouts

### Scenario 3: Dashboard with Single Component
**Request:** "Build me a requirements dashboard"
**Trap:** "Dashboard" keyword → Branch C
**Reality:** If only one component type, could be Branch A or B

**Resolution:** Parse for multiple component types; single type = Branch A/B

### Scenario 4: Styling Interpreted as Novel
**Request:** "Make priorities more visible"
**Trap:** No standard format mentioned → Branch D?
**Reality:** This is presentation change → Branch B (RendererBinding update)

**Resolution:** Styling/emphasis terms = Branch B

---

## Evidence Gathering Rules

1. **Never guess** - Query the domain to confirm
2. **One question max** - If ambiguous, ask at most one clarifying question
3. **Default to simpler branch** - When uncertain between A and B, try A first
4. **Approximate for D** - Always render something for novel requests

---

## Notes

- These criteria are adapted from the platform-features classification framework
- The goal is explicit, evidence-based decisions - not intuition
- When criteria are ambiguous, gather evidence before acting
- The feedback loop allows correction if initial classification was wrong
