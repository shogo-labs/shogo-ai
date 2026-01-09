# Component Catalog

All 29 registered display components in the component-builder domain.

---

## Primitive Display (13 components)

### StringDisplay
- **ID:** `comp-string-display`
- **Ref:** `StringDisplay`
- **Purpose:** Renders string values with optional truncation
- **Config:** size, variant, truncate, layout
- **Tags:** primitive, text, readonly

### NumberDisplay
- **ID:** `comp-number-display`
- **Ref:** `NumberDisplay`
- **Purpose:** Renders numeric values with optional formatting
- **Config:** size, variant
- **Tags:** primitive, numeric, readonly

### BooleanDisplay
- **ID:** `comp-boolean-display`
- **Ref:** `BooleanDisplay`
- **Purpose:** Renders boolean values as visual indicators
- **Config:** size, variant
- **Tags:** primitive, boolean, readonly

### DateTimeDisplay
- **ID:** `comp-datetime-display`
- **Ref:** `DateTimeDisplay`
- **Purpose:** Renders date-time values with relative formatting
- **Config:** size, variant
- **Tags:** primitive, date, time, readonly

### EmailDisplay
- **ID:** `comp-email-display`
- **Ref:** `EmailDisplay`
- **Purpose:** Renders email addresses as clickable mailto links
- **Config:** size, variant, clickable
- **Tags:** primitive, email, link, readonly

### UriDisplay
- **ID:** `comp-uri-display`
- **Ref:** `UriDisplay`
- **Purpose:** Renders URIs as clickable external links
- **Config:** size, variant, truncate, clickable
- **Tags:** primitive, uri, link, readonly

### EnumBadge
- **ID:** `comp-enum-badge`
- **Ref:** `EnumBadge`
- **Purpose:** Renders enum values as colored badges
- **Config:** size, variant
- **Tags:** primitive, enum, badge, readonly

### ReferenceDisplay
- **ID:** `comp-reference-display`
- **Ref:** `ReferenceDisplay`
- **Purpose:** Renders MST reference relationships
- **Config:** size, variant, clickable
- **Tags:** primitive, reference, relationship, readonly

### ComputedDisplay
- **ID:** `comp-computed-display`
- **Ref:** `ComputedDisplay`
- **Purpose:** Renders computed/derived property values
- **Config:** size, variant, layout
- **Tags:** primitive, computed, derived, readonly

### ArrayDisplay
- **ID:** `comp-array-display`
- **Ref:** `ArrayDisplay`
- **Purpose:** Renders arrays with item counts and expansion
- **Config:** size, variant, expandable, layout
- **Tags:** primitive, array, collection, readonly

### ObjectDisplay
- **ID:** `comp-object-display`
- **Ref:** `ObjectDisplay`
- **Purpose:** Renders nested object structures
- **Config:** size, variant, expandable, layout
- **Tags:** primitive, object, nested, readonly

### StringArrayDisplay
- **ID:** `comp-string-array-display`
- **Ref:** `StringArrayDisplay`
- **Purpose:** Renders string arrays as styled lists (bulleted, numbered, or inline)
- **Config:** size, variant, layout, expandable
- **Tags:** primitive, array, list, readonly

### LongTextDisplay
- **ID:** `comp-long-text-display`
- **Ref:** `LongTextDisplay`
- **Purpose:** Renders long text with line clamping and expand/collapse
- **Config:** size, variant, truncate, expandable
- **Tags:** primitive, text, readonly

---

## Domain-Specific Display (12 components)

### PriorityBadge
- **ID:** `comp-priority-badge`
- **Ref:** `PriorityBadge`
- **Purpose:** Renders priority enum values (must, should, could) with semantic colors
- **Binding:** `{ xRenderer: "priority-badge" }`
- **Tags:** domain, priority, badge, readonly

### ArchetypeBadge
- **ID:** `comp-archetype-badge`
- **Ref:** `ArchetypeBadge`
- **Purpose:** Renders feature archetype values with semantic colors
- **Binding:** `{ xRenderer: "archetype-badge" }`
- **Tags:** domain, archetype, badge, readonly

### FindingTypeBadge
- **ID:** `comp-finding-type-badge`
- **Ref:** `FindingTypeBadge`
- **Purpose:** Renders finding type enum values with semantic colors
- **Binding:** `{ xRenderer: "finding-type-badge" }`
- **Tags:** domain, finding, badge, readonly

### TaskStatusBadge
- **ID:** `comp-task-status-badge`
- **Ref:** `TaskStatusBadge`
- **Purpose:** Renders task status enum values with semantic colors
- **Binding:** `{ xRenderer: "task-status-badge" }`
- **Tags:** domain, task, status, badge, readonly

### TestTypeBadge
- **ID:** `comp-test-type-badge`
- **Ref:** `TestTypeBadge`
- **Purpose:** Renders test type enum values with semantic colors
- **Binding:** `{ xRenderer: "test-type-badge" }`
- **Tags:** domain, test, type, badge, readonly

### SessionStatusBadge
- **ID:** `comp-session-status-badge`
- **Ref:** `SessionStatusBadge`
- **Purpose:** Renders session status enum values with semantic colors
- **Binding:** `{ xRenderer: "session-status-badge" }`
- **Tags:** domain, session, status, badge, readonly

### RequirementStatusBadge
- **ID:** `comp-requirement-status-badge`
- **Ref:** `RequirementStatusBadge`
- **Purpose:** Renders requirement status enum values with semantic colors
- **Binding:** `{ xRenderer: "requirement-status-badge" }`
- **Tags:** domain, requirement, status, badge, readonly

### RunStatusBadge
- **ID:** `comp-run-status-badge`
- **Ref:** `RunStatusBadge`
- **Purpose:** Renders test run status enum values with semantic colors
- **Binding:** `{ xRenderer: "run-status-badge" }`
- **Tags:** domain, run, status, badge, readonly

### ExecutionStatusBadge
- **ID:** `comp-execution-status-badge`
- **Ref:** `ExecutionStatusBadge`
- **Purpose:** Renders execution status enum values with semantic colors
- **Binding:** `{ xRenderer: "execution-status-badge" }`
- **Tags:** domain, execution, status, badge, readonly

### TestCaseStatusBadge
- **ID:** `comp-test-case-status-badge`
- **Ref:** `TestCaseStatusBadge`
- **Purpose:** Renders test case status enum values with semantic colors
- **Binding:** `{ xRenderer: "test-case-status-badge" }`
- **Tags:** domain, test-case, status, badge, readonly

### TaskRenderer
- **ID:** `comp-task-renderer`
- **Ref:** `TaskRenderer`
- **Purpose:** Renders implementation task entities with full detail
- **Binding:** `{ xRenderer: "implementation-task" }`
- **Tags:** domain, task, entity, readonly

### CodePathDisplay
- **ID:** `comp-code-path-display`
- **Ref:** `CodePathDisplay`
- **Purpose:** Renders file paths with monospace font and optional truncation
- **Config:** size, truncate, clickable
- **Binding:** `{ xRenderer: "code-path" }`
- **Tags:** domain, code, path, readonly

---

## Visualization (4 components)

### ProgressBar
- **ID:** `comp-progress-bar`
- **Ref:** `ProgressBar`
- **Purpose:** Renders progress with segmented color-coded bars
- **Binding:** `{ xRenderer: "progress-bar" }`
- **Tags:** visualization, progress, bar, readonly

### DataCard
- **ID:** `comp-data-card`
- **Ref:** `DataCard`
- **Purpose:** Renders data in a styled card format with variants
- **Binding:** `{ xRenderer: "data-card" }`
- **Tags:** visualization, card, container, readonly

### GraphNode
- **ID:** `comp-graph-node`
- **Ref:** `GraphNode`
- **Purpose:** Renders nodes for graph/network visualizations
- **Binding:** `{ xRenderer: "graph-node" }`
- **Tags:** visualization, graph, node, readonly

### StatusIndicator
- **ID:** `comp-status-indicator`
- **Ref:** `StatusIndicator`
- **Purpose:** Renders multi-stage status indicators with layout options
- **Binding:** `{ xRenderer: "status-indicator" }`
- **Tags:** visualization, status, indicator, readonly

---

## Quick Lookup

### By implementationRef
| Ref | Component ID |
|-----|--------------|
| StringDisplay | comp-string-display |
| NumberDisplay | comp-number-display |
| BooleanDisplay | comp-boolean-display |
| DateTimeDisplay | comp-datetime-display |
| EmailDisplay | comp-email-display |
| UriDisplay | comp-uri-display |
| EnumBadge | comp-enum-badge |
| ReferenceDisplay | comp-reference-display |
| ComputedDisplay | comp-computed-display |
| ArrayDisplay | comp-array-display |
| ObjectDisplay | comp-object-display |
| StringArrayDisplay | comp-string-array-display |
| LongTextDisplay | comp-long-text-display |
| PriorityBadge | comp-priority-badge |
| ArchetypeBadge | comp-archetype-badge |
| FindingTypeBadge | comp-finding-type-badge |
| TaskStatusBadge | comp-task-status-badge |
| TestTypeBadge | comp-test-type-badge |
| SessionStatusBadge | comp-session-status-badge |
| RequirementStatusBadge | comp-requirement-status-badge |
| RunStatusBadge | comp-run-status-badge |
| ExecutionStatusBadge | comp-execution-status-badge |
| TestCaseStatusBadge | comp-test-case-status-badge |
| TaskRenderer | comp-task-renderer |
| CodePathDisplay | comp-code-path-display |
| ProgressBar | comp-progress-bar |
| DataCard | comp-data-card |
| GraphNode | comp-graph-node |
| StatusIndicator | comp-status-indicator |

### By Category
| Category | Count | Components |
|----------|-------|------------|
| display | 25 | All primitive + domain |
| visualization | 4 | ProgressBar, DataCard, GraphNode, StatusIndicator |
| input | 0 | (none yet) |
| layout | 0 | (none yet) |
