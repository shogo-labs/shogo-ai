# Component Builder Inventory

This document lists all available ComponentDefinitions, LayoutTemplates, and their implementations in the component-builder schema.

## Layout Templates

### 1. layout-phase-two-column
**Description:** Two-column layout for phase views with header and actions areas

**Slots:**
- `header` (top, required): Page header
- `main` (left, required): Main content area
- `sidebar` (right, optional): Sidebar content
- `actions` (bottom, optional): Action buttons/footer

**Grid Structure:** 2-column responsive grid
- Mobile: Stacked
- Desktop: `[1fr 300px]` (main, sidebar)

**Use case:** Basic phase views with optional sidebar

---

### 2. layout-discovery-enhanced
**Description:** Enhanced 3-column grid layout for discovery phase with hero section, main content area, sidebar insights, and action footer

**Slots:**
- `hero` (top-full, required): Hero section spanning all columns
- `overview` (left-top, required): Session metadata overview
- `intent` (left-main, required): User intent display
- `requirements` (center-main, required): Requirements grid/list
- `insights` (right-sidebar, optional): Insights and assessment panel
- `context` (right-footer, optional): Additional context and patterns
- `actions` (bottom-full, required): Action buttons spanning all columns

**Grid Structure:** 3-column responsive grid
- Mobile: Stacked
- Desktop: `[minmax(300px,1fr) 2fr minmax(300px,400px)]` (left, center, right)

**Use case:** Enhanced discovery phase with rich visual layout

---

## Component Definitions

### Display Components (Primitives)

#### String & Text
- **comp-string-display** - StringDisplay: Basic string values with optional truncation
- **comp-long-text-display** - LongTextDisplay: Long text with line clamping and expand/collapse
- **comp-string-array-display** - StringArrayDisplay: String arrays as styled lists (bulleted, numbered, inline)

#### Numbers & Booleans
- **comp-number-display** - NumberDisplay: Numeric values with optional formatting
- **comp-boolean-display** - BooleanDisplay: Boolean values as visual indicators

#### Dates & Times
- **comp-datetime-display** - DateTimeDisplay: Date-time values with relative formatting

#### Links & References
- **comp-email-display** - EmailDisplay: Email addresses as clickable mailto links
- **comp-uri-display** - UriDisplay: URIs as clickable external links
- **comp-reference-display** - ReferenceDisplay: MST reference relationships

#### Structured Data
- **comp-array-display** - ArrayDisplay: Arrays with item counts and expansion
- **comp-object-display** - ObjectDisplay: Nested object structures
- **comp-computed-display** - ComputedDisplay: Computed/derived property values

#### Enums & Badges
- **comp-enum-badge** - EnumBadge: Generic enum values as colored badges

### Display Components (Domain-Specific Badges)

#### Status Badges
- **comp-session-status-badge** - SessionStatusBadge: Session status (discovery, analysis, etc.)
- **comp-requirement-status-badge** - RequirementStatusBadge: Requirement status
- **comp-task-status-badge** - TaskStatusBadge: Task status
- **comp-run-status-badge** - RunStatusBadge: Test run status
- **comp-execution-status-badge** - ExecutionStatusBadge: Execution status
- **comp-test-case-status-badge** - TestCaseStatusBadge: Test case status

#### Category Badges
- **comp-priority-badge** - PriorityBadge: Priority levels (high, medium, low)
- **comp-archetype-badge** - ArchetypeBadge: Feature archetypes (enhancement, new-feature, bug-fix)
- **comp-finding-type-badge** - FindingTypeBadge: Finding types
- **comp-test-type-badge** - TestTypeBadge: Test types (unit, integration, e2e)
- **comp-change-type-badge** - ChangeTypeBadge: Change types (add, modify, extend)

#### Specialized Displays
- **comp-code-path-display** - CodePathDisplay: File paths with monospace font
- **comp-phase-status-renderer** - PhaseStatusRenderer: Interactive phase indicator with navigation

### Entity Renderers
- **comp-task-renderer** - TaskRenderer: Full implementation task entities

### Visualization Components
- **comp-progress-bar** - ProgressBar: Progress with segmented color-coded bars
- **comp-data-card** - DataCard: Data in styled card format with variants
- **comp-graph-node** - GraphNode: Nodes for graph/network visualizations
- **comp-status-indicator** - StatusIndicator: Multi-stage status indicators

### Section Components (Basic)
- **comp-def-intent-terminal-section** - IntentTerminalSection: Session intent in terminal-style display
- **comp-def-initial-assessment-section** - InitialAssessmentSection: Initial assessment with archetype and priority badges
- **comp-def-requirements-list-section** - RequirementsListSection: Requirements as interactive checklist
- **comp-def-session-summary-section** - SessionSummarySection: Session metadata summary
- **comp-def-phase-actions-section** - PhaseActionsSection: Phase-specific action buttons

### Section Components (Enhanced Discovery)
- **comp-def-phase-hero-section** - PhaseHeroSection: Hero section with phase name, progress, and dramatic styling
- **comp-def-session-overview-card** - SessionOverviewCard: Compact metadata card (created, updated, packages)
- **comp-def-intent-rich-panel** - IntentRichPanel: Enhanced intent display with packages and schema highlight
- **comp-def-requirements-grid-section** - RequirementsGridSection: Requirements in grid layout with priority badges
- **comp-def-insights-panel** - InsightsPanel: Sidebar panel with assessment, archetype, priority, key indicators
- **comp-def-context-footer** - ContextFooter: Footer showing patterns and uncertainties

---

## Implementation Status

### Implemented Section Components
All section components listed above have React implementations in:
- `/apps/web/src/components/rendering/sections/*.tsx`

All are registered in:
- `/apps/web/src/components/rendering/sectionImplementations.tsx`

### Layout Rendering
The `SlotLayout` component supports both basic and enhanced layouts:
- `/apps/web/src/components/rendering/composition/SlotLayout.tsx`

**Layout detection:** Automatically detects layout type based on slot positions
- Basic: `top`, `left`, `right`, `bottom`
- Enhanced: `top-full`, `left-top`, `left-main`, `center-main`, `right-sidebar`, `right-footer`, `bottom-full`

---

## Current Composition: composition-discovery

**Layout:** `layout-discovery-enhanced`

**Slot Mappings:**
- `hero` → PhaseHeroSection
- `overview` → SessionOverviewCard
- `intent` → IntentRichPanel
- `requirements` → RequirementsGridSection
- `insights` → InsightsPanel
- `context` → ContextFooter
- `actions` → PhaseActionsSection

**Data Context:** Rich styling configuration with midnight-neon theme, glass cards, glowing borders, and dramatic effects.

---

## Usage

### Querying Components
```typescript
// Get all components
mcp__wavesmith__store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  filter: {},
  terminal: "toArray"
})

// Get components by category
mcp__wavesmith__store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  filter: { category: "section" },
  terminal: "toArray"
})
```

### Querying Layouts
```typescript
mcp__wavesmith__store_query({
  schema: "component-builder",
  model: "LayoutTemplate",
  filter: {},
  terminal: "toArray"
})
```

### Updating Compositions
```typescript
mcp__wavesmith__store_update({
  schema: "component-builder",
  model: "Composition",
  id: "composition-discovery",
  changes: {
    slotContent: [
      { slot: "hero", component: "comp-def-phase-hero-section" },
      // ... other slots
    ]
  }
})
```
