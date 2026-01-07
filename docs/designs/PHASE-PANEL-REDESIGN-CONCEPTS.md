# Phase Panel Redesign Concepts

## Design Philosophy: "Orchestrated Precision"

This design system adopts an **industrial-modernist aesthetic** inspired by mission control interfaces, technical documentation systems, and architectural blueprints. The visual language communicates:

- **Systematic Progress**: Each phase is a calculated step in a larger orchestration
- **Data Density with Clarity**: Rich information without overwhelming
- **Intentional Hierarchy**: Every element earns its place
- **Traceable Relationships**: Visual connections between related data

### Core Design Tokens

**Typography**:
- Display: **JetBrains Mono** or **IBM Plex Mono** for technical precision
- Body: **Satoshi** or **General Sans** for modern readability
- Micro-text: **Space Mono** for data labels and badges

**Color System**:
```
Phase States:
--phase-discovery:     #3B82F6 (blue-500)      - Exploration
--phase-analysis:      #8B5CF6 (violet-500)    - Investigation
--phase-classification:#EC4899 (pink-500)      - Categorization
--phase-design:        #F59E0B (amber-500)     - Architecture
--phase-spec:          #10B981 (emerald-500)   - Planning
--phase-testing:       #06B6D4 (cyan-500)      - Verification
--phase-implementation:#EF4444 (red-500)       - Execution
--phase-complete:      #22C55E (green-500)     - Success

Semantic:
--priority-must:       #DC2626 (red-600)
--priority-should:     #D97706 (amber-600)
--priority-could:      #2563EB (blue-600)

--status-pending:      #6B7280 (gray-500)
--status-active:       #3B82F6 (blue-500)
--status-complete:     #22C55E (green-500)
--status-blocked:      #EF4444 (red-500)
```

**Spatial System**:
- Generous padding with intentional asymmetry
- Left-aligned vertical rhythm
- Grid-breaking accent elements for emphasis

---

## Phase 1: Discovery

### Current State Analysis
The current DiscoveryView displays intent, initial assessment, and requirements in basic card layouts. Information is flat and lacks visual hierarchy beyond simple headings.

---

### Concept A: "Mission Brief Command Center"

**Aesthetic Direction**: Military/aerospace mission briefing interface with classified document styling

**Visual Layout**:
```
+----------------------------------------------------------+
|  [MISSION BRIEF]                            PHASE 1 of 8 |
+----------------------------------------------------------+
|                                                          |
|  INTENT DECLARATION                                      |
|  +-------------------------------------------------+    |
|  |  "User's original feature request displayed     |    |
|  |   in a monospace terminal-style box with        |    |
|  |   subtle scan-line effect and amber accent      |    |
|  |   border on the left edge"                      |    |
|  |                                       v         |    |
|  |  Character count: 247  |  Keywords: 5          |    |
|  +-------------------------------------------------+    |
|                                                          |
|  INITIAL ASSESSMENT                    [SERVICE]         |
|  +------------------------+  +------------------------+  |
|  |  INDICATORS            |  |  UNCERTAINTIES        |  |
|  |  - - - - - - - - - - - |  |  - - - - - - - - - - |  |
|  |  [=] API boundary      |  |  [?] Data ownership  |  |
|  |  [=] External clients  |  |  [?] Auth scope      |  |
|  |  [=] Protocol exposure |  |  [?] Rate limiting   |  |
|  +------------------------+  +------------------------+  |
|                                                          |
|  REQUIREMENTS MATRIX                                     |
|  +------------------------------------------------------+|
|  |  MUST      ||||||||||||||||||||||||||||||||||  6     ||
|  |  SHOULD    ||||||||||||||||                    4     ||
|  |  COULD     ||||||                              2     ||
|  +------------------------------------------------------+|
|                                                          |
|  [Expandable requirement cards below with status dots]   |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Intent Terminal Box**: Monospace text in a bordered container with subtle CRT scan-line overlay, left accent bar in phase color
2. **Dual-Column Assessment**: Side-by-side panels with checklist iconography (checkmarks vs question marks)
3. **Requirements Bar Chart**: Horizontal stacked bars showing priority distribution at a glance
4. **Classified Stamp Effect**: Corner watermark showing "DISCOVERY IN PROGRESS"

**Data Emphasis**:
- Intent text as the focal hero element
- Priority distribution visible without scrolling
- Clear separation between confirmed (indicators) and uncertain data

**Improvements Over Current**:
- Visual priority breakdown eliminates counting
- Dual-column layout shows relationship between indicators and uncertainties
- Terminal aesthetic conveys "input phase" of the pipeline

**New Renderers Needed**:
- `intent-terminal-renderer`: Styled text block with character count
- `stacked-bar-chart`: Horizontal priority distribution
- `checklist-indicator`: Icon-prefixed list items ([=] confirmed, [?] uncertain)

---

### Concept B: "Requirements Landscape"

**Aesthetic Direction**: Topographical map / data visualization dashboard with requirements as "terrain"

**Visual Layout**:
```
+----------------------------------------------------------+
|  DISCOVERY LANDSCAPE                          1/8        |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |                    INTENT CORE                     |  |
|  |  +----------------------------------------------+  |  |
|  |  |                                              |  |  |
|  |  |    "Feature request as centered block       |  |  |
|  |  |     with radiating connection lines to      |  |  |
|  |  |     requirements below"                     |  |  |
|  |  |                                              |  |  |
|  |  +----------------------------------------------+  |  |
|  |        |              |              |             |  |
|  |        v              v              v             |  |
|  +----------------------------------------------------+  |
|                                                          |
|  ARCHETYPE SIGNAL: [SERVICE] confidence: 0.85           |
|  +--[indicators]----[uncertainties]---[signals]-------+  |
|                                                          |
|  REQUIREMENTS TERRAIN                                    |
|  +----------------------------------------------------+  |
|  |  MUST (Critical)                                   |  |
|  |  +--+ +--+ +--+ +--+ +--+ +--+                     |  |
|  |  |R1| |R2| |R3| |R4| |R5| |R6|  <- Hoverable tiles|  |
|  |  +--+ +--+ +--+ +--+ +--+ +--+                     |  |
|  |                                                    |  |
|  |  SHOULD (Important)                                |  |
|  |  +----+ +----+ +----+ +----+                       |  |
|  |  | R7 | | R8 | | R9 | |R10 |                       |  |
|  |  +----+ +----+ +----+ +----+                       |  |
|  |                                                    |  |
|  |  COULD (Nice-to-have)                              |  |
|  |  +------+ +------+                                 |  |
|  |  | R11  | | R12  |                                 |  |
|  |  +------+ +------+                                 |  |
|  +----------------------------------------------------+  |
|                                                          |
|  [Selected requirement detail panel slides in from right]|
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Intent Core with Radials**: Central statement with visual lines connecting to derived requirements
2. **Archetype Signal Bar**: Confidence meter showing how strongly indicators point to archetype
3. **Requirement Tiles Grid**: Compact tiles sized by priority (MUST=small dense, COULD=larger sparse)
4. **Slide-out Detail Panel**: Selected requirement expands into full detail view

**Data Emphasis**:
- Visual hierarchy through tile sizing (more critical = more items per row)
- Traceability from intent to individual requirements
- Archetype confidence as a measurable signal

**Improvements Over Current**:
- Spatial metaphor makes priority viscerally clear
- Hover interactions allow quick scanning
- Connection lines show derivation chain

**New Renderers Needed**:
- `requirement-tile-grid`: Adaptive grid with priority-based sizing
- `confidence-meter`: Horizontal gauge with gradient fill
- `radial-connection-diagram`: SVG lines from center to items

---

## Phase 2: Analysis

### Current State Analysis
AnalysisView shows findings grouped by type in flat sections with type badges. No visualization of relationships or severity.

---

### Concept A: "Evidence Board"

**Aesthetic Direction**: Detective investigation board with pinned evidence, string connections, and annotations

**Visual Layout**:
```
+----------------------------------------------------------+
|  ANALYSIS EVIDENCE BOARD                       2/8       |
+----------------------------------------------------------+
|                                                          |
|  +--[FILTER BAR]----------------------------------------+|
|  | [All] [Patterns] [Gaps] [Risks] [Evidence] [Tests]   ||
|  +------------------------------------------------------+|
|                                                          |
|  +------------------------------------------------------+|
|  |  CRITICAL FINDINGS (Risks + Gaps)                    ||
|  |  +------------+  +------------+  +------------+      ||
|  |  | [RISK]     |--| [GAP]      |  | [RISK]     |      ||
|  |  | Auth flow  |  | No retry   |  | Data leak  |      ||
|  |  | exposure   |  | mechanism  |  | potential  |      ||
|  |  | ********** |  | ********   |  | *********  |      ||
|  |  | severity:3 |  | severity:2 |  | severity:4 |      ||
|  |  +------------+  +------------+  +------------+      ||
|  |       |                                    |         ||
|  |       +------------------------------------+         ||
|  |              |                                       ||
|  |              v                                       ||
|  |  +--------------------------------------------------+||
|  |  | SUPPORTING EVIDENCE                              |||
|  |  | +--------+ +--------+ +--------+ +--------+      |||
|  |  | |PATTERN | |EVIDENCE| |TEST    | |INT.PT  |      |||
|  |  | +--------+ +--------+ +--------+ +--------+      |||
|  |  +--------------------------------------------------+||
|  +------------------------------------------------------+|
|                                                          |
|  FINDINGS BY LOCATION                                    |
|  packages/mcp/        ||||||||||||  8 findings           |
|  packages/state-api/  ||||||        4 findings           |
|  apps/web/            |||           3 findings           |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Pinned Finding Cards**: Cards with pushpin visual, severity stars, connection strings
2. **Type Filter Chips**: Quick toggle filtering by finding type
3. **Location Heat Bar**: Horizontal bars showing finding density by package
4. **Connection Lines**: SVG paths showing related findings (shared location, linked evidence)

**Data Emphasis**:
- Risks and gaps elevated to "critical" section
- Severity rating visualized as star density
- Package-level aggregation shows hotspots

**Improvements Over Current**:
- Severity visualization adds missing dimension
- Package heat map shows where work concentrates
- Connection lines reveal non-obvious relationships

**New Renderers Needed**:
- `pinned-finding-card`: Card with severity stars and connection anchors
- `finding-filter-bar`: Multi-select chip filter
- `location-heat-bar`: Horizontal density visualization
- `svg-connection-overlay`: Draws lines between related cards

---

### Concept B: "Analysis Matrix"

**Aesthetic Direction**: Scientific data analysis interface with matrices, charts, and structured grids

**Visual Layout**:
```
+----------------------------------------------------------+
|  ANALYSIS MATRIX                               2/8       |
+----------------------------------------------------------+
|                                                          |
|  FINDING DISTRIBUTION                                    |
|  +----------------------------------------------------+  |
|  |     PAT  GAP  RSK  EVD  INT  TST  VER              |  |
|  | mcp  3    1    2    4    2    1    0    = 13       |  |
|  | api  2    2    1    3    1    2    1    = 12       |  |
|  | web  1    0    1    1    0    0    0    = 3        |  |
|  +----------------------------------------------------+  |
|                         ^                                |
|                         | click cell to filter           |
|                                                          |
|  +------------------------+  +------------------------+  |
|  |  RISK ASSESSMENT       |  |  GAP COVERAGE         |  |
|  |  +------------------+  |  |  +------------------+  |  |
|  |  |   /\             |  |  |  Requirements:  12 |  |  |
|  |  |  /  \   HIGH (2) |  |  |  With Gaps:      3 |  |  |
|  |  | /----\  MED (3)  |  |  |  Coverage:      75% |  |  |
|  |  |/______\ LOW (2)  |  |  |  +------------------+  |  |
|  |  +------------------+  |  +------------------------+  |
|  +------------------------+                              |
|                                                          |
|  FINDINGS STREAM                                         |
|  +----------------------------------------------------+  |
|  | [PAT] domain-store-pattern      packages/mcp       |  |
|  | [GAP] missing-retry-logic       packages/api       |  |
|  | [RSK] auth-token-exposure       packages/mcp       |  |
|  | [EVD] existing-hook-system      packages/api       |  |
|  | ...                                                |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Cross-Tab Matrix**: Type x Location grid with counts, clickable cells
2. **Risk Pyramid**: Triangular severity chart
3. **Coverage Gauge**: Circular progress showing gap coverage percentage
4. **Finding Stream**: Virtualized list with type prefix badges

**Data Emphasis**:
- Package x Type distribution in single glanceable matrix
- Risk severity pyramid visualization
- Coverage percentage as key metric

**Improvements Over Current**:
- Matrix view shows concentration patterns
- Aggregate metrics (coverage %, risk pyramid) add executive summary
- Click-to-filter enables drill-down

**New Renderers Needed**:
- `finding-matrix`: Interactive grid with cell click handlers
- `risk-pyramid`: SVG triangular chart
- `coverage-gauge`: Circular progress indicator
- `finding-stream-row`: Compact row with type badge prefix

---

## Phase 3: Classification

### Current State Analysis
ClassificationView shows archetype badge, evidence checklist, patterns, and rationale in simple sections. No visual representation of the classification process or confidence.

---

### Concept A: "Archetype Determination Chamber"

**Aesthetic Direction**: Scientific classification interface with specimen analysis aesthetics

**Visual Layout**:
```
+----------------------------------------------------------+
|  ARCHETYPE CLASSIFICATION                      3/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |           CLASSIFICATION RESULT                    |  |
|  |  +----------------------------------------------+  |  |
|  |  |                                              |  |  |
|  |  |    [INITIAL]          [VALIDATED]            |  |  |
|  |  |    +--------+         +----------+           |  |  |
|  |  |    | DOMAIN | ------> | SERVICE  |           |  |  |
|  |  |    +--------+    !    +----------+           |  |  |
|  |  |                  ^                           |  |  |
|  |  |            CORRECTION                        |  |  |
|  |  +----------------------------------------------+  |  |
|  +----------------------------------------------------+  |
|                                                          |
|  EVIDENCE ANALYSIS                                       |
|  +----------------------------------------------------+  |
|  |  SERVICE INDICATORS        DOMAIN INDICATORS       |  |
|  |  [x] API boundary          [ ] Internal only       |  |
|  |  [x] External clients      [ ] Entity-centric      |  |
|  |  [x] Protocol exposure     [ ] State focus         |  |
|  |  [x] Rate limiting need    [ ] Validation rules    |  |
|  |                                                    |  |
|  |  CONFIDENCE METER                                  |  |
|  |  SERVICE [====================----] 85%            |  |
|  |  DOMAIN  [======------------------] 15%            |  |
|  +----------------------------------------------------+  |
|                                                          |
|  APPLICABLE PATTERNS                                     |
|  [Repository Pattern] [Service Layer] [DTO Mapping]      |
|                                                          |
|  RATIONALE                                               |
|  +----------------------------------------------------+  |
|  | "Classification determined based on evidence..."   |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Transformation Arrow**: Visual showing initial -> validated with correction marker
2. **Dual Evidence Columns**: Side-by-side checklists comparing archetype indicators
3. **Confidence Bars**: Horizontal gauges showing strength of each archetype match
4. **Pattern Pills**: Chip-style tags for applicable patterns

**Data Emphasis**:
- Clear visualization of correction (if any)
- Evidence organized by what it supports
- Confidence as measurable percentage

**Improvements Over Current**:
- Transformation visual makes correction immediately visible
- Dual-column evidence shows "why not" alongside "why"
- Confidence meters add quantitative dimension

**New Renderers Needed**:
- `archetype-transformation`: Arrow diagram with correction indicator
- `evidence-dual-column`: Side-by-side checklist comparison
- `confidence-bar`: Horizontal percentage gauge
- `pattern-pill-set`: Compact chip group

---

### Concept B: "Decision Tree Navigator"

**Aesthetic Direction**: Interactive decision tree / flowchart showing classification logic

**Visual Layout**:
```
+----------------------------------------------------------+
|  CLASSIFICATION NAVIGATOR                      3/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |                   DECISION PATH                    |  |
|  |                                                    |  |
|  |                  [Feature Intent]                  |  |
|  |                        |                           |  |
|  |                        v                           |  |
|  |              "Has API boundary?"                   |  |
|  |               /              \                     |  |
|  |             YES               NO                   |  |
|  |              |                 |                   |  |
|  |              v                 v                   |  |
|  |    "External clients?"    "Entity-centric?"       |  |
|  |        /        \              |                   |  |
|  |      YES        NO            ...                  |  |
|  |       |          |                                 |  |
|  |       v          v                                 |  |
|  |   [SERVICE]  [HYBRID]                             |  |
|  |       ^                                           |  |
|  |       |                                           |  |
|  |    [SELECTED PATH HIGHLIGHTED]                    |  |
|  +----------------------------------------------------+  |
|                                                          |
|  EVIDENCE CHECKLIST              RESULT                  |
|  +------------------------+  +------------------------+  |
|  | [x] API boundary       |  |  +------------------+  |  |
|  | [x] External clients   |  |  |                  |  |  |
|  | [x] Protocol exposure  |  |  |     SERVICE      |  |  |
|  | [ ] Internal only      |  |  |                  |  |  |
|  | [ ] Entity-centric     |  |  |   confidence:    |  |  |
|  | [ ] State focus        |  |  |      0.92        |  |  |
|  +------------------------+  |  +------------------+  |  |
|                              +------------------------+  |
|                                                          |
|  PATTERNS: [Repository] [Service Layer] [DTO Mapping]    |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Decision Tree SVG**: Interactive flowchart with highlighted path
2. **Path Breadcrumb**: Shows the decision sequence that led to classification
3. **Large Result Badge**: Prominent archetype display with confidence
4. **Evidence as Inputs**: Checklist items map to decision nodes

**Data Emphasis**:
- Classification logic made explicit and traceable
- Path through tree shows reasoning
- Confidence derived from evidence completeness

**Improvements Over Current**:
- Explains "why" through visual logic flow
- Interactive nodes could show details on hover
- Educational for understanding archetype system

**New Renderers Needed**:
- `decision-tree-graph`: SVG flowchart with highlighting
- `tree-path-breadcrumb`: Horizontal decision sequence
- `archetype-result-card`: Large badge with confidence
- `evidence-to-node-mapping`: Connection between checklist and tree

---

## Phase 4: Design

### Current State Analysis
DesignView has tabbed interface with Schema (ReactFlow graph), Decisions, and Hooks Plan. Good foundation but graph could be more informative and decisions lack visual structure.

---

### Concept A: "Schema Blueprint Studio"

**Aesthetic Direction**: Architectural blueprint / CAD software with precise technical drawings

**Visual Layout**:
```
+----------------------------------------------------------+
|  SCHEMA BLUEPRINT                              4/8       |
+----------------------------------------------------------+
|  [Schema] [Decisions] [Hooks] [Relationships]            |
+----------------------------------------------------------+
|                                                          |
|  +--------------------------------+  +------------------+|
|  |     ENTITY GRAPH               |  | ENTITY INSPECTOR ||
|  |                                |  +------------------+|
|  |  +--------+      +--------+    |  | FeatureSession   ||
|  |  | User   |----->| Session|    |  |                  ||
|  |  +--------+      +--------+    |  | PROPERTIES       ||
|  |       |               |        |  | +-------------+  ||
|  |       |               |        |  | | id: string  |  ||
|  |       v               v        |  | | name: string|  ||
|  |  +--------+      +--------+    |  | | status: enum|  ||
|  |  | Task   |<-----| Req    |    |  | +-------------+  ||
|  |  +--------+      +--------+    |  |                  ||
|  |                                |  | REFERENCES       ||
|  |  LEGEND:                       |  | --> requirements ||
|  |  [---] reference               |  | --> tasks        ||
|  |  [<->] bidirectional          |  | <-- findings      ||
|  |  [- -] maybe-ref              |  |                  ||
|  +--------------------------------+  +------------------+|
|                                                          |
|  ENTITY STATISTICS                                       |
|  +----------------------------------------------------+  |
|  | Entities: 8 | Properties: 47 | References: 12      |  |
|  | Computed: 5 | Required: 32   | Optional: 15        |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Blueprint-Style Graph**: Nodes with technical drawing aesthetic, dashed grid background
2. **Entity Inspector Panel**: Fixed sidebar with detailed property view
3. **Reference Legend**: Clear visual key for different reference types
4. **Statistics Bar**: Aggregate schema metrics

**Data Emphasis**:
- Graph shows structure at a glance
- Inspector provides deep-dive without leaving context
- Statistics summarize schema complexity

**Improvements Over Current**:
- Blueprint aesthetic reinforces "design document" metaphor
- Reference type legend clarifies relationship meanings
- Statistics bar adds quantitative overview

**New Renderers Needed**:
- `blueprint-entity-node`: Technical drawing styled node
- `reference-type-edge`: Edge with dashed/solid/arrow variations
- `entity-inspector-panel`: Property list with type indicators
- `schema-statistics-bar`: Compact metrics row

---

### Concept B: "Design Decision Chronicle"

**Aesthetic Direction**: Decision journal / changelog with timeline and context

**Visual Layout** (Decisions Tab Focus):
```
+----------------------------------------------------------+
|  DESIGN DECISIONS                              4/8       |
+----------------------------------------------------------+
|  [Schema] [Decisions] [Hooks] [Impact]                   |
+----------------------------------------------------------+
|                                                          |
|  DECISION TIMELINE                                       |
|  +----------------------------------------------------+  |
|  |  o---o---o---o---o---o---o                         |  |
|  |  |   |   |   |   |   |   |                         |  |
|  |  D1  D2  D3  D4  D5  D6  D7                        |  |
|  |              ^                                     |  |
|  |          [SELECTED]                                |  |
|  +----------------------------------------------------+  |
|                                                          |
|  +----------------------------------------------------+  |
|  |  DECISION #4: auth-state-location                  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  QUESTION                                    |  |  |
|  |  |  "Where should authentication state live?"   |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  DECISION                                    |  |  |
|  |  |  "Store in MST environment for global       |  |  |
|  |  |   access without prop drilling"             |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  RATIONALE                                   |  |  |
|  |  |  "Environment pattern allows dependency     |  |  |
|  |  |   injection and testability..."             |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  IMPACT                                      |  |  |
|  |  |  [FeatureSession] [User] [AuthService]      |  |  |
|  |  +----------------------------------------------+  |  |
|  +----------------------------------------------------+  |
|                                                          |
|  DECISION CATEGORIES                                     |
|  [Architecture: 3] [Data: 2] [API: 1] [Testing: 1]       |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Horizontal Timeline**: Decision points as clickable nodes
2. **Structured Decision Card**: Question/Decision/Rationale/Impact sections
3. **Impact Tags**: Entities affected by the decision
4. **Category Filter Chips**: Group decisions by type

**Data Emphasis**:
- Timeline shows decision progression
- Impact tags trace decisions to schema changes
- Categories reveal decision patterns

**Improvements Over Current**:
- Timeline provides temporal context
- Impact tags show what each decision affected
- Categories enable filtering by concern

**New Renderers Needed**:
- `decision-timeline`: Horizontal scrollable timeline with selection
- `structured-decision-card`: Multi-section expandable card
- `impact-entity-tags`: Clickable entity chips
- `decision-category-chips`: Filterable category badges

---

## Phase 5: Spec

### Current State Analysis
SpecView shows tasks sorted by dependency order in a simple list. No visualization of dependencies or task relationships.

---

### Concept A: "Task Dependency Network"

**Aesthetic Direction**: Network graph / project management tool with dependency visualization

**Visual Layout**:
```
+----------------------------------------------------------+
|  IMPLEMENTATION SPEC                           5/8       |
+----------------------------------------------------------+
|                                                          |
|  EXECUTION ORDER                                         |
|  +----------------------------------------------------+  |
|  | Layer 0 (No deps)  Layer 1           Layer 2       |  |
|  | +------+           +------+          +------+      |  |
|  | |Task1 |---------->|Task3 |--------->|Task5 |      |  |
|  | +------+           +------+          +------+      |  |
|  | +------+              |                            |  |
|  | |Task2 |--------------|                            |  |
|  | +------+              v                            |  |
|  |                   +------+                         |  |
|  |                   |Task4 |                         |  |
|  |                   +------+                         |  |
|  +----------------------------------------------------+  |
|                                                          |
|  TASK DETAIL (Selected: Task3)                           |
|  +----------------------------------------------------+  |
|  |  +----------------------------------------------+  |  |
|  |  |  create-auth-service              [PLANNED]  |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  "Implement authentication service with      |  |  |
|  |  |   token management and validation..."        |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  ACCEPTANCE CRITERIA                         |  |  |
|  |  |  [ ] Token generation implemented            |  |  |
|  |  |  [ ] Validation logic complete               |  |  |
|  |  |  [ ] Refresh flow working                    |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  DEPENDS ON: [Task1] [Task2]                 |  |  |
|  |  |  BLOCKS: [Task5]                             |  |  |
|  |  +----------------------------------------------+  |  |
|  +----------------------------------------------------+  |
|                                                          |
|  SUMMARY: 5 tasks | 3 layers | Critical path: T1->T3->T5 |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Layered Dependency Graph**: Tasks arranged by execution layer
2. **Dependency Arrows**: Visual connections between tasks
3. **Selected Task Detail**: Full task card with criteria checklist
4. **Critical Path Indicator**: Highlighted longest dependency chain

**Data Emphasis**:
- Execution order immediately visible
- Dependency relationships explicit
- Critical path shows bottleneck sequence

**Improvements Over Current**:
- Graph visualization over flat list
- Critical path analysis adds project insight
- Bidirectional dependency view (depends on / blocks)

**New Renderers Needed**:
- `dependency-layer-graph`: Horizontal layered graph
- `task-dependency-node`: Compact task node with status
- `critical-path-highlighter`: Path emphasis overlay
- `bidirectional-deps-section`: "Depends on" / "Blocks" display

---

### Concept B: "Task Kanban Board"

**Aesthetic Direction**: Agile board with status columns and task cards

**Visual Layout**:
```
+----------------------------------------------------------+
|  TASK BOARD                                    5/8       |
+----------------------------------------------------------+
|  [List View] [Board View] [Graph View]                   |
+----------------------------------------------------------+
|                                                          |
|  +------------+ +------------+ +------------+ +--------+ |
|  | PLANNED    | | IN_PROGRESS| | COMPLETE   | | BLOCKED| |
|  +------------+ +------------+ +------------+ +--------+ |
|  |            | |            | |            | |        | |
|  | +--------+ | | +--------+ | |            | |        | |
|  | | Task 1 | | | | Task 3 | | |            | |        | |
|  | | ~~~~~~ | | | | ~~~~~~ | | |            | |        | |
|  | | [2dep] | | | | [1dep] | | |            | |        | |
|  | +--------+ | | +--------+ | |            | |        | |
|  |            | |            | |            | |        | |
|  | +--------+ | |            | |            | |        | |
|  | | Task 2 | | |            | |            | |        | |
|  | | ~~~~~~ | | |            | |            | |        | |
|  | | [0dep] | | |            | |            | |        | |
|  | +--------+ | |            | |            | |        | |
|  |            | |            | |            | |        | |
|  | +--------+ | |            | |            | |        | |
|  | | Task 4 | | |            | |            | |        | |
|  | | ~~~~~~ | | |            | |            | |        | |
|  | | [1dep] | | |            | |            | |        | |
|  | +--------+ | |            | |            | |        | |
|  |            | |            | |            | |        | |
|  +------------+ +------------+ +------------+ +--------+ |
|                                                          |
|  PROGRESS: [=====                    ] 0/5 complete      |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Status Columns**: Kanban-style swimlanes
2. **Draggable Task Cards**: Compact cards with dependency indicator
3. **View Toggle**: Switch between list, board, and graph views
4. **Progress Bar**: Overall task completion gauge

**Data Emphasis**:
- Status distribution immediately visible
- Card compactness allows many tasks visible
- Dependency count badge shows complexity

**Improvements Over Current**:
- Multiple view modes for different needs
- Status columns provide progress snapshot
- Progress bar adds completion tracking

**New Renderers Needed**:
- `kanban-column`: Status swimlane container
- `compact-task-card`: Small card with dep badge
- `view-mode-toggle`: Three-way view switcher
- `task-progress-bar`: Completion percentage gauge

---

## Phase 6: Testing

### Current State Analysis
TestingView groups test specs by parent task with Given/When/Then cards. No test type distribution or coverage visualization.

---

### Concept A: "Test Coverage Matrix"

**Aesthetic Direction**: QA dashboard with coverage metrics and test organization

**Visual Layout**:
```
+----------------------------------------------------------+
|  TEST COVERAGE                                 6/8       |
+----------------------------------------------------------+
|                                                          |
|  COVERAGE SUMMARY                                        |
|  +----------------------------------------------------+  |
|  |  +----------+  +----------+  +----------+          |  |
|  |  | UNIT     |  | INTEGR.  |  | ACCEPT.  |          |  |
|  |  |    12    |  |    6     |  |    3     |          |  |
|  |  | 57%      |  | 29%      |  | 14%      |          |  |
|  |  +----------+  +----------+  +----------+          |  |
|  |                                                    |  |
|  |  TASK COVERAGE                                     |  |
|  |  Task 1  [||||||||||||||||    ] 8/10 specs         |  |
|  |  Task 2  [||||||||||||||||||  ] 9/10 specs         |  |
|  |  Task 3  [||||||              ] 3/10 specs         |  |
|  +----------------------------------------------------+  |
|                                                          |
|  TEST SPECIFICATIONS                                     |
|  +----------------------------------------------------+  |
|  |  [Filter: All Types] [Sort: By Task]               |  |
|  +----------------------------------------------------+  |
|  |                                                    |  |
|  |  TASK: create-auth-service                         |  |
|  |  +----------------------------------------------+  |  |
|  |  |  [UNIT] Valid credentials return token       |  |  |
|  |  |  Given: User with valid credentials          |  |  |
|  |  |  When:  Authentication requested             |  |  |
|  |  |  Then:  Token returned with claims           |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |  [UNIT] Invalid credentials rejected         |  |  |
|  |  |  ...                                         |  |  |
|  |  +----------------------------------------------+  |  |
|  |                                                    |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Type Distribution Cards**: Count and percentage per test type
2. **Task Coverage Bars**: Progress bars showing specs per task
3. **Filter/Sort Controls**: Test organization options
4. **Collapsible Task Groups**: Expandable sections per task

**Data Emphasis**:
- Test type distribution visible at glance
- Per-task coverage shows thoroughness
- Filter enables focus on specific types

**Improvements Over Current**:
- Type distribution adds quality insight
- Coverage bars show relative testing effort
- Filters help navigate large test sets

**New Renderers Needed**:
- `test-type-distribution-card`: Count with percentage
- `task-coverage-bar`: Progress with fraction label
- `test-filter-controls`: Type and sort dropdowns
- `collapsible-task-group`: Expandable test section

---

### Concept B: "Test Scenario Theater"

**Aesthetic Direction**: BDD scenario presentation with structured GWT format

**Visual Layout**:
```
+----------------------------------------------------------+
|  TEST SCENARIOS                                6/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |  [= = =]  TEST PYRAMID                             |  |
|  |                                                    |  |
|  |           /\                                       |  |
|  |          /  \  E2E (3)                            |  |
|  |         /----\                                     |  |
|  |        /      \ Integration (6)                    |  |
|  |       /--------\                                   |  |
|  |      /          \ Unit (12)                        |  |
|  |     /============\                                 |  |
|  +----------------------------------------------------+  |
|                                                          |
|  SCENARIO VIEWER                                         |
|  +----------------------------------------------------+  |
|  |  +----------------------------------------------+  |  |
|  |  |  SCENARIO: Valid user authentication         |  |  |
|  |  |  TYPE: [UNIT]  TASK: create-auth-service     |  |  |
|  |  +----------------------------------------------+  |  |
|  |  |                                              |  |  |
|  |  |  GIVEN                                       |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |  | - A user with valid credentials        |  |  |  |
|  |  |  | - An initialized auth service          |  |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |                                              |  |  |
|  |  |  WHEN                                        |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |  | Authentication is requested             |  |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |                                              |  |  |
|  |  |  THEN                                        |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |  | - A valid token is returned            |  |  |  |
|  |  |  | - Token contains expected claims       |  |  |  |
|  |  |  | - Token has correct expiry             |  |  |  |
|  |  |  +----------------------------------------+  |  |  |
|  |  |                                              |  |  |
|  |  +----------------------------------------------+  |  |
|  +----------------------------------------------------+  |
|                                                          |
|  < Prev [3/21] Next >                                    |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Test Pyramid Visualization**: Classic pyramid showing test distribution
2. **Scenario Card**: Large-format GWT presentation
3. **Navigation Controls**: Prev/Next with position indicator
4. **Type and Task Tags**: Context badges on scenario

**Data Emphasis**:
- Test pyramid shows healthy distribution
- Large scenario format improves readability
- Navigation enables scenario review flow

**Improvements Over Current**:
- Pyramid visualization adds testing health metric
- Single scenario focus improves comprehension
- Navigation pattern supports review workflow

**New Renderers Needed**:
- `test-pyramid`: SVG layered triangle
- `scenario-spotlight-card`: Large GWT presentation
- `scenario-navigator`: Prev/Next with counter
- `scenario-context-tags`: Type + task badges

---

## Phase 7: Implementation

### Current State Analysis
ImplementationView shows execution progress bar and task execution rows. Basic but functional, lacks real-time feel and detailed status tracking.

---

### Concept A: "Execution Control Room"

**Aesthetic Direction**: Mission control / CI/CD pipeline with real-time monitoring

**Visual Layout**:
```
+----------------------------------------------------------+
|  IMPLEMENTATION CONTROL                        7/8       |
+----------------------------------------------------------+
|                                                          |
|  RUN STATUS                                              |
|  +----------------------------------------------------+  |
|  |  RUN #3                        [IN_PROGRESS]       |  |
|  |  Started: 2 min ago                                |  |
|  |                                                    |  |
|  |  +----------------------------------------------+  |  |
|  |  |  [============================              ]  |  |
|  |  |  Task 4 of 7: implementing-auth-service       |  |
|  |  +----------------------------------------------+  |  |
|  |                                                    |  |
|  |  STAGE: [test_written] -> [test_failing] ->       |  |
|  |         [implementing] -> [test_passing]          |  |
|  |              ^                                     |  |
|  |          [CURRENT]                                 |  |
|  +----------------------------------------------------+  |
|                                                          |
|  EXECUTION LOG                                           |
|  +----------------------------------------------------+  |
|  | 14:32:01 [PASS] Task 1: create-types               |  |
|  | 14:32:15 [PASS] Task 2: setup-interfaces           |  |
|  | 14:32:45 [PASS] Task 3: create-store               |  |
|  | 14:33:02 [>>>>] Task 4: implementing-auth [2m 15s] |  |
|  | 14:35:-- [----] Task 5: integration-tests          |  |
|  | 14:35:-- [----] Task 6: acceptance-tests           |  |
|  | 14:35:-- [----] Task 7: documentation              |  |
|  +----------------------------------------------------+  |
|                                                          |
|  CURRENT OUTPUT                                          |
|  +----------------------------------------------------+  |
|  |  > Running test: auth-service.test.ts              |  |
|  |  > FAIL: Expected token to have expiry claim       |  |
|  |  > Implementing fix in auth-service.ts:45          |  |
|  |  > Re-running test...                              |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **TDD Stage Indicator**: Visual showing current TDD cycle position
2. **Execution Timeline**: Vertical log with status icons and duration
3. **Live Output Panel**: Terminal-style current task output
4. **Progress Bar with Task Name**: Shows what's currently executing

**Data Emphasis**:
- TDD cycle stage visible
- Timeline shows history with duration
- Live output provides real-time feedback

**Improvements Over Current**:
- TDD stage indicator reinforces methodology
- Duration tracking per task
- Live output adds transparency

**New Renderers Needed**:
- `tdd-stage-indicator`: Horizontal stage progression
- `execution-timeline-log`: Timestamped vertical list
- `live-output-terminal`: Monospace scrolling output
- `progress-with-task-name`: Enhanced progress bar

---

### Concept B: "Task Execution Cards"

**Aesthetic Direction**: Card-based dashboard with detailed execution state per task

**Visual Layout**:
```
+----------------------------------------------------------+
|  EXECUTION DASHBOARD                           7/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |  RUN #3: IN_PROGRESS     Duration: 3m 45s          |  |
|  |  Progress: [=================             ] 4/7    |  |
|  +----------------------------------------------------+  |
|                                                          |
|  +------------+ +------------+ +------------+            |
|  | COMPLETED  | | IN PROGRESS| | PENDING    |            |
|  |     3      | |     1      | |     3      |            |
|  +------------+ +------------+ +------------+            |
|                                                          |
|  TASK EXECUTIONS                                         |
|  +----------------------------------------------------+  |
|  | +------------------------------------------------+ |  |
|  | | create-types                    [test_passing] | |  |
|  | | Duration: 14s | Retries: 0                     | |  |
|  | | Test: types.test.ts | Impl: types.ts           | |  |
|  | +------------------------------------------------+ |  |
|  | +------------------------------------------------+ |  |
|  | | implementing-auth               [implementing]  | |  |
|  | | Duration: 2m 15s | Retries: 1                  | |  |
|  | | Test: auth.test.ts | Impl: auth-service.ts     | |  |
|  | | ERROR: Token expiry claim missing              | |  |
|  | +------------------------------------------------+ |  |
|  | +------------------------------------------------+ |  |
|  | | integration-tests                   [pending]   | |  |
|  | | Waiting for: implementing-auth                 | |  |
|  | +------------------------------------------------+ |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Status Count Cards**: Quick glance at completed/active/pending
2. **Expanded Execution Cards**: Full detail per task including error
3. **File Path Display**: Test and implementation files shown
4. **Retry Counter**: Visible retry attempts per task

**Data Emphasis**:
- Status distribution immediate
- Error messages visible in context
- File paths aid debugging

**Improvements Over Current**:
- Status count cards add summary
- Error display in card prevents need to expand
- File paths help locate issues

**New Renderers Needed**:
- `status-count-card`: Compact counter with label
- `execution-detail-card`: Full task execution with error
- `file-path-display`: Monospace path with icon
- `retry-badge`: Counter with warning color on high

---

## Phase 8: Complete

### Current State Analysis
CompleteView shows success banner and 3-column stats grid. Celebratory but could better summarize the journey.

---

### Concept A: "Journey Summary Report"

**Aesthetic Direction**: Executive report / journey recap with timeline and metrics

**Visual Layout**:
```
+----------------------------------------------------------+
|  FEATURE COMPLETE                              8/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |                                                    |  |
|  |        [CHECK ICON]     FEATURE SHIPPED!           |  |
|  |                                                    |  |
|  |        "Add Authentication Service"                |  |
|  |        Completed: January 6, 2026 at 2:45 PM      |  |
|  |                                                    |  |
|  +----------------------------------------------------+  |
|                                                          |
|  JOURNEY TIMELINE                                        |
|  +----------------------------------------------------+  |
|  | Discovery --> Analysis --> Classification -->      |  |
|  |    15m          8m            3m                   |  |
|  |                                                    |  |
|  | Design --> Spec --> Testing --> Implementation    |  |
|  |   22m       10m      12m          45m              |  |
|  |                                                    |  |
|  | TOTAL TIME: 1h 55m                                 |  |
|  +----------------------------------------------------+  |
|                                                          |
|  DELIVERABLES                                            |
|  +----------------------------------------------------+  |
|  |  +----------+ +----------+ +----------+ +--------+ |  |
|  |  | REQUIRE- | | TASKS    | | TESTS    | | FILES  | |  |
|  |  | MENTS    | | COMPLETE | | PASSING  | | CHANGED| |  |
|  |  |    12    | |   7/7    | |   21/21  | |   15   | |  |
|  |  +----------+ +----------+ +----------+ +--------+ |  |
|  +----------------------------------------------------+  |
|                                                          |
|  ARTIFACTS PRODUCED                                      |
|  +----------------------------------------------------+  |
|  | - Schema: platform-features (8 entities)           |  |
|  | - Tests: 21 specifications (12 unit, 6 int, 3 acc) |  |
|  | - Implementation: 15 files across 3 packages       |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Success Hero**: Large completion banner with timestamp
2. **Phase Timeline**: Horizontal journey with duration per phase
3. **Deliverables Grid**: 4-column stats with counts
4. **Artifacts List**: Bullet summary of produced outputs

**Data Emphasis**:
- Total duration and per-phase breakdown
- All metrics in one view
- Artifact summary for traceability

**Improvements Over Current**:
- Timeline adds journey context
- More comprehensive metrics
- Artifact list aids documentation

**New Renderers Needed**:
- `journey-timeline`: Horizontal phase flow with durations
- `deliverables-grid`: 4-column metric cards
- `artifacts-list`: Structured output summary
- `duration-display`: Formatted time with units

---

### Concept B: "Achievement Celebration"

**Aesthetic Direction**: Gamification / achievement unlock with confetti and badges

**Visual Layout**:
```
+----------------------------------------------------------+
|  ACHIEVEMENT UNLOCKED!                         8/8       |
+----------------------------------------------------------+
|                                                          |
|  +----------------------------------------------------+  |
|  |                                                    |  |
|  |   [CONFETTI ANIMATION]                             |  |
|  |                                                    |  |
|  |        +------------------+                        |  |
|  |        |  [TROPHY ICON]   |                        |  |
|  |        |                  |                        |  |
|  |        | FEATURE SHIPPED  |                        |  |
|  |        | Authentication   |                        |  |
|  |        +------------------+                        |  |
|  |                                                    |  |
|  +----------------------------------------------------+  |
|                                                          |
|  ACHIEVEMENTS EARNED                                     |
|  +----------------------------------------------------+  |
|  |  [BADGE] First Time Author     - Your first feature|  |
|  |  [BADGE] Test Champion         - 100% test pass    |  |
|  |  [BADGE] Speed Runner          - Under 2 hours     |  |
|  |  [BADGE] Zero Retry            - No retries needed |  |
|  +----------------------------------------------------+  |
|                                                          |
|  SESSION STATS                                           |
|  +----------------------------------------------------+  |
|  |  Duration     Requirements    Tasks     Tests      |  |
|  |  1h 55m           12          7/7       21/21      |  |
|  |                                                    |  |
|  |  Implementation Runs: 1 (success on first try!)    |  |
|  +----------------------------------------------------+  |
|                                                          |
|  [Share Achievement] [View Full Report] [Start New]      |
+----------------------------------------------------------+
```

**Key UI Elements**:
1. **Trophy Animation**: Celebratory visual with optional confetti
2. **Achievement Badges**: Unlocked badges based on session metrics
3. **Stats Summary**: Key metrics in compact format
4. **Action Buttons**: Next steps after completion

**Data Emphasis**:
- Celebration reinforces accomplishment
- Badges add gamification motivation
- Clear next actions

**Improvements Over Current**:
- More engaging celebration
- Achievement system adds motivation
- Action buttons guide next steps

**New Renderers Needed**:
- `trophy-celebration`: Animated success visual
- `achievement-badge`: Earned badge with description
- `stats-summary-row`: Compact horizontal stats
- `action-button-group`: Styled next-step buttons

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)
- Create new CSS variables for phase colors
- Add typography (JetBrains Mono, Satoshi) to the app
- Build core renderers: `progress-bar`, `status-badge`, `count-card`

### Phase 2: Discovery & Analysis (Week 2)
- Implement Concept A for Discovery (Mission Brief)
- Implement Concept A for Analysis (Evidence Board)
- Create connection line SVG utilities

### Phase 3: Classification & Design (Week 3)
- Implement Concept A for Classification (Determination Chamber)
- Enhance Design's Schema tab with blueprint styling
- Add Concept B's Decision Timeline to Design

### Phase 4: Spec & Testing (Week 4)
- Implement Concept A for Spec (Dependency Network)
- Implement Concept A for Testing (Coverage Matrix)
- Add test pyramid visualization

### Phase 5: Implementation & Complete (Week 5)
- Implement Concept A for Implementation (Control Room)
- Implement Concept A for Complete (Journey Summary)
- Add TDD stage indicator and journey timeline

### Phase 6: Polish & Integration (Week 6)
- Ensure consistent animation timing
- Add keyboard navigation
- Performance optimization for large datasets
- Accessibility audit

---

## Component Registry Extensions

New renderers to add to `studioRegistry.ts`:

```typescript
// Phase-level renderers
registry.register({
  id: "intent-terminal",
  matches: (meta) => meta.xRenderer === "intent-terminal",
  component: IntentTerminal,
  priority: 200,
})

registry.register({
  id: "stacked-bar-chart",
  matches: (meta) => meta.xRenderer === "stacked-bar-chart",
  component: StackedBarChart,
  priority: 200,
})

registry.register({
  id: "pinned-finding-card",
  matches: (meta) => meta.xRenderer === "pinned-finding-card",
  component: PinnedFindingCard,
  priority: 200,
})

registry.register({
  id: "confidence-meter",
  matches: (meta) => meta.xRenderer === "confidence-meter",
  component: ConfidenceMeter,
  priority: 200,
})

registry.register({
  id: "dependency-graph",
  matches: (meta) => meta.xRenderer === "dependency-graph",
  component: DependencyGraph,
  priority: 200,
})

registry.register({
  id: "test-pyramid",
  matches: (meta) => meta.xRenderer === "test-pyramid",
  component: TestPyramid,
  priority: 200,
})

registry.register({
  id: "tdd-stage-indicator",
  matches: (meta) => meta.xRenderer === "tdd-stage-indicator",
  component: TddStageIndicator,
  priority: 200,
})

registry.register({
  id: "journey-timeline",
  matches: (meta) => meta.xRenderer === "journey-timeline",
  component: JourneyTimeline,
  priority: 200,
})
```

---

## Summary

This design document presents 16 enhanced UX concepts (2 per phase) for the studio app's phase panels. The designs emphasize:

1. **Data Density**: Rich information displayed without overwhelming
2. **Visual Hierarchy**: Clear focal points and progressive disclosure
3. **Meaningful Visualizations**: Charts, graphs, and diagrams that add insight
4. **Strategic Color**: Phase colors, semantic status, and priority coding
5. **Interactive Elements**: Filtering, expansion, navigation, and selection
6. **Schema-Driven Rendering**: Leveraging x-renderer for consistent styling

The "Orchestrated Precision" aesthetic combines industrial-modernist influences with technical documentation clarity, creating a distinctive interface that reinforces the AI-orchestrated development pipeline metaphor.
