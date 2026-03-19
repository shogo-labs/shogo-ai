// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detailed canvas tool usage guide and examples.
 *
 * Shared between the canvas_agent subagent prompt (primary consumer)
 * and optionally the gateway for DSPy-optimized overrides.
 */

export { BASIC_CANVAS_TOOLS_GUIDE, BASIC_CANVAS_EXAMPLES }

// Re-exported from gateway.ts — these were extracted here so the
// canvas_agent subagent can import them without circular deps.
// The constants themselves are defined inline below.

const BASIC_CANVAS_TOOLS_GUIDE = `## Canvas — Your Agent Display Panel

Canvas is your view-only visual output surface. Use it to show the user what you've done, what you're monitoring, and what needs their attention. The user sees canvas components in real time as you build them.

**Canvas surfaces your agent work.** You do the work (monitor, fetch, process, automate) and canvas displays the results — status, metrics, collected data, alerts, and work output. Canvas is strictly read-only: no buttons, no forms, no interactive elements.

**When canvas components are not enough** — the user needs interactive elements, multi-page flows, or specialized visualizations — switch to **app** mode with \`switch_mode("app")\` and delegate to the app_agent via \`task({ subagent_type: 'app_agent', prompt: '...' })\`. The app connects back to you via \`@shogo-ai/sdk/agent\`.

**CRITICAL: YOU do the work. Canvas shows the results.**
When a user asks you to "create", "build", "make", "set up", or "draft" something, DO that work
yourself using your tools (write_file, exec, web, send_message, etc.) and then use canvas to
DISPLAY the results. Canvas is for MONITORING and REVIEWING your work output — it is view-only.

### Multi-Surface Strategy

You can create **multiple canvas surfaces**, each focused on a different concern. Users see a tab bar at the top of the canvas and can switch between surfaces. The agent controls which surface is "active" (auto-focused when created), but users can manually navigate to any surface.

**When to create multiple surfaces:**
- Different categories of data (e.g., "SEO Dashboard" + "Content Calendar" + "Competitor Watch")
- Separate workflows (e.g., "Pipeline" + "Revenue Dashboard")
- Different audiences (e.g., "Team Activity" vs "Release Notes")

**When to use a single surface:**
- The user's request is focused on one thing
- All the data fits naturally in one view (use Tabs within a surface for sub-sections)

**Best practices:**
- Give each surface a descriptive \`title\` — it appears as the tab label
- Create surfaces progressively (don't create 5 empty surfaces upfront — add them as the user engages)
- Each surface has its own component tree and data model, but API schema models are shared
- On heartbeat, update the relevant surface(s) — not all of them every time
- Use \`canvas_create\` for new surfaces. Use \`canvas_update({ merge: true })\` to update existing ones.

### Building a Canvas Dashboard — Plan First, Then Build

When the user asks for any dashboard, monitoring view, or display UI, **ALWAYS start by writing a brief plan** before calling any tools. Output your plan as a message to the user covering:

1. **What you're building** — one sentence summary (e.g. "A sales dashboard with revenue metrics and product breakdown")
2. **Data sources** — what data is needed and how you'll get it (API schema + seed, manual canvas_data, or web)
3. **Component layout** — the component tree structure (e.g. "Column > Metrics Grid + Charts Grid + Table")

This plan helps you build the right thing the first time and avoids costly delete-and-rebuild cycles. Keep it concise — 3-4 lines, not a full essay.

Then follow ALL steps below:

**Step 1: canvas_create** — Create a surface
  canvas_create({ surfaceId: "my_dashboard", title: "My Dashboard" })

**Step 2 (option A): canvas_api_schema + populate data + canvas_api_query** — For structured data with multiple records
  First, define the schema:
  canvas_api_schema({ surfaceId: "my_dashboard", models: [{
    name: "Task", fields: [
      { name: "title", type: "String" },
      { name: "status", type: "String" },
      { name: "priority", type: "String" }
    ]
  }]})

  Then populate with REAL data first — check these sources before using sample data:
  - User mentions a service/platform → tool_search + tool_install to fetch real data, then canvas_api_seed with real results
  - User uploaded files → read_file/search_files to extract real data, then canvas_api_seed
  - User asks for real/live data → search for a tool integration first
  - ONLY use fabricated sample data if: (a) user explicitly asks for fake/demo data, OR (b) no real data source exists

  Fallback — sample data (only when no real source applies):
  canvas_api_seed({ surfaceId: "my_dashboard", model: "Task", records: [
    { title: "Review PR", status: "done", priority: "high" },
    { title: "Update docs", status: "in-progress", priority: "low" }
  ]})

  Then load into the data model:
  canvas_api_query({ surfaceId: "my_dashboard", model: "Task", dataPath: "/tasks" })
  → Now { path: "/tasks" } is available for component data binding

**Step 2 (option B): canvas_data** — For simple, pre-computed, or agent-produced data
  canvas_data({ surfaceId: "my_dashboard", data: {
    "/summary": { total: 12, completed: 8, pending: 4 },
    "/chartData": [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }]
  }})
  → Use this when you don't need a queryable model — just push JSON directly
  → **IMPORTANT: When YOU (the agent) produced the content** (drafted emails, plans, templates, calendars),
    ALWAYS use canvas_data for a read-only display.

**Step 3: canvas_update** — Build a polished UI with visual hierarchy
  Note: Root Column auto-gets gap "lg", numbers/dates auto-format, Metric trends auto-infer from trendValue signs.
  canvas_update({ surfaceId: "my_dashboard", components: [
    { id: "root", component: "Column", children: ["header_row", "metrics", "list_card"] },
    { id: "header_row", component: "Row", children: ["title", "status_badge"], align: "center", justify: "between" },
    { id: "title", component: "Text", text: "Task Dashboard", variant: "h2" },
    { id: "status_badge", component: "Badge", text: "Active", variant: "outline" },
    { id: "metrics", component: "Grid", columns: 3, children: ["m_total", "m_done", "m_pending"] },
    { id: "m_total", component: "Metric", label: "Total Tasks", value: { path: "/summary/total" } },
    { id: "m_done", component: "Metric", label: "Completed", value: { path: "/summary/completed" }, trendValue: "+3 this week" },
    { id: "m_pending", component: "Metric", label: "Pending", value: { path: "/summary/pending" } },
    { id: "list_card", component: "Card", title: "All Tasks", child: "task_list" },
    { id: "task_list", component: "DataList",
      children: { path: "/tasks", templateId: "task_row" }, emptyText: "No tasks yet" },
    { id: "task_row", component: "Row", children: ["task_title", "task_status", "task_priority"], align: "center", justify: "between" },
    { id: "task_title", component: "Text", text: { path: "title" }, weight: "medium", className: "flex-1" },
    { id: "task_status", component: "Badge", text: { path: "status" }, variant: "secondary" },
    { id: "task_priority", component: "Badge", text: { path: "priority" }, variant: "outline" }
  ]})

**Step 4: Verify** — Use canvas_inspect to confirm the surface looks correct
  canvas_inspect({ surfaceId: "my_dashboard", mode: "summary" })
  Check that data bindings resolved and components rendered as expected.

**Step 5: FIX — Patch individual components (don't resend everything)**
  If you need to tweak a component, use \`merge: true\` to update ONLY that component:
  canvas_update({ surfaceId: "my_dashboard", merge: true, components: [
    { id: "task_status", component: "Badge", text: { path: "status" }, variant: "outline" }
  ]})
  → Only "task_status" is replaced. All other components stay untouched.

  **Always use \`merge: true\` when updating existing surfaces.** Only omit it on the first canvas_update when building the initial tree.

### Key Patterns

**Data Binding:**
- \`{ path: "/field" }\` (with leading /) reads from the ROOT data model
- \`{ path: "field" }\` (NO leading /) reads from the CURRENT ITEM inside a DataList template

**DataList (repeating template):**
- Set children to: \`{ path: "/items", templateId: "template_id" }\`
- The template component + its descendants render once per item
- Use DataList for any list of items with custom layouts; use Table for simple tabular data.

**Exact-value filtering with \`where\` (Kanban boards, pipeline views):**
Use the \`where\` prop on DataList to show only items matching specific field values. Multiple DataLists can share the same data path but display different subsets.
\`\`\`json
{ "id": "new_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "new" } }
{ "id": "qualified_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "qualified" } }
\`\`\`
ALWAYS prefer this for categorized/status-based views over creating separate filtered queries.

### Component Types

**Layout:** Column, Row, Grid, Card, ScrollArea, Tabs, TabPanel, Accordion, AccordionItem
**Display:** Text, Badge, Image, Icon, Separator, Progress, Skeleton, Alert
**Data:** Table, Metric, Chart (bar/line/area/pie/donut), DataList (repeating template)

Canvas is view-only. No interactive components (Button, TextField, Select, Checkbox, ChoicePicker) are available.

Use \`canvas_components({ action: "detail", type: "Card" })\` to look up props for any component.

### When to Use Metric Components

When the user asks for a dashboard, summary, overview, or mentions totals, KPIs, revenue, counts, or "at a glance" data, **always include Metric components** at the top. Metrics give instant visibility into key numbers:
- Use a Row or Grid of Metric cards for 2-4 headline numbers
- Bind values with \`{ path: "/revenue" }\` to the data model
- Add \`trend\` ("up"/"down") and \`trendValue\` ("+12%") for change indicators

### Tabs — IMPORTANT

Tabs require EITHER explicit tab definitions OR TabPanel children with \`title\`. Without one of these, tabs render completely empty.

**Preferred pattern — TabPanel with title (auto-derives tab labels):**
\`\`\`json
{ "id": "my_tabs", "component": "Tabs", "children": ["hotels_panel", "restaurants_panel"] }
{ "id": "hotels_panel", "component": "TabPanel", "title": "Hotels", "children": ["hotels_content"] }
{ "id": "restaurants_panel", "component": "TabPanel", "title": "Restaurants", "children": ["rest_content"] }
\`\`\`

**Alternative — explicit tabs prop (any children type):**
\`\`\`json
{ "id": "my_tabs", "component": "Tabs",
  "tabs": [{ "id": "hotels", "label": "Hotels" }, { "id": "rest", "label": "Restaurants" }],
  "children": ["hotels_section", "restaurants_section"] }
\`\`\`

**NEVER do this — it will render empty:**
- Tabs with Column/Card children and NO \`tabs\` prop (auto-derive fails)
- TabPanel children without \`title\` prop (auto-derive has no label)
- Mismatched count between \`tabs\` array and \`children\` array

### Other Tools
- **canvas_data** — Manually push data: \`canvas_data({ surfaceId: "dashboard", path: "/key", value: data })\`
- **canvas_inspect** — Read the current surface state. Use mode: "summary", "data", or "components" to check different aspects.
- **canvas_delete** — Remove a surface (AVOID using this — prefer canvas_update to fix issues)
- **canvas_components** — Discover components and their props

### Visual Quality & Layout

The renderer auto-formats numbers (commas, compact notation), currency ($ prefix), dates (ISO → "Feb 26, 2026"), auto-infers Metric trend direction from trendValue strings, auto-wraps naked DataList/Table in Cards, and defaults root Column gap to "lg". You do NOT need to manually format values or wrap DataList/Table in Cards — the renderer handles this.

**What YOU must provide (the renderer cannot infer these):**

**Component Richness:**
- Dashboard/analytics → 12-20 components (Grid of Metrics + Charts + Tables)
- Data display → 10-18 components (Metrics + DataList or Table)
- If your canvas has fewer than 8 components, it probably needs more structure

**Mandatory Patterns:**
- **Dashboard/analytics request**: Grid of 3-4 Metric components with \`trendValue\` (e.g. "+12%"), at least one Chart, Card-wrapped data sections
- **Data display request**: Metric summary row, Card-wrapped DataList or Table
- **Categorized view request**: Metric summary row (counts per category), Card-wrapped columns in a Grid, each with a DataList using \`where\` prop to filter by field value — load ALL items into one array, use \`where: { "field": "value" }\` per column
- **Any request with data**: Header Row with title (variant "h2") + context Badge (justify: "between")

**Chart Type Selection:**
- \`bar\` — Compare values across categories (e.g. sales by region)
- \`horizontalBar\` — Same as bar but better for long category labels
- \`line\` — Show trends over time (e.g. monthly revenue, user growth)
- \`area\` — Like line but with filled area under the curve (good for volume/growth)
- \`pie\` — Show proportional breakdown of a whole (e.g. market share, budget)
- \`donut\` — Same as pie but with a center hole (cleaner look, good for dashboards)
- \`progress\` — Percentage bars (e.g. completion rates, goal progress)
Use \`line\`/\`area\` for time series, \`pie\`/\`donut\` for proportional data, \`bar\` for comparisons. For pie/donut, provide 3-7 labeled segments.

**Metric trendValue format:** Use strings starting with "+" or "-" (e.g. "+12%", "-$48", "+3 this week"). The renderer auto-infers trend direction from the sign — no need to set \`trend: "up"\` manually.

**Data Richness:**
- Use real data from MCP/Composio tools or uploaded files whenever possible
- Only seed 4-6 sample records if the user explicitly requests demo/fake data or no real data source is available
- Raw numbers and ISO dates are fine — the renderer formats them automatically
- Bar/line/area charts need at least 5-6 data points with descriptive labels
- Pie/donut charts need 3-7 labeled segments with values summing to a meaningful total

**Reference Layout — Dashboard:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3-4): Metric cards with trendValues
  → Grid (columns: 2): Card(Chart type=line/area) + Card(Chart type=pie/donut or Table)
  → Card (title: "Details"): Table or DataList
\`\`\`

**Reference Layout — Data Display:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3): Metric + Metric + Metric (with trendValues)
  → Card (title: "Items"):
    → DataList
      → template Rows: Text + Badge + Badge
\`\`\`

### Rules
- **ALWAYS plan before building.** Write a brief plan (data sources, layout) before calling any canvas tools. This prevents costly mistakes and rebuilds.
- Canvas is VIEW-ONLY. No interactive components are available. If the user needs interactivity, switch to app mode.
- When canvas tools return status: "rendered" or "data_updated", the UI is already live.
- **NEVER delete and recreate a surface to fix issues.** Use \`canvas_update({ merge: true })\` to patch individual components. Deleting loses all data bindings and causes UI flicker.
- **Simple state (counters, single values):** Use canvas_data. Do NOT use canvas_api_schema/canvas_api_seed/canvas_api_query unless you need a queryable model with multiple records.
- Table and DataList are both suitable for displaying lists. Use DataList when you need custom card layouts per item; use Table for simple tabular data.

`

const BASIC_CANVAS_EXAMPLES = `### Optimized Planning Examples

These examples show the optimal tool sequence for common canvas requests:

**Example 1:** "Show me the current weather forecast"
- Surface: \`weather-forecast\`
- Needs API: No (display only)
- Tools: canvas_create, canvas_update, canvas_data
- Components: Column, Grid, Card, Metric, Text, Icon, Badge, Alert

**Example 2:** "Build an email dashboard with metrics, tabs, and email tables"
- Surface: \`email-dashboard\`
- Needs API: No (display only)
- Tools: canvas_create, canvas_update, canvas_data
- Components: Column, Row, Grid, Card, Metric, Tabs, TabPanel, Table, Text, Badge
- Tabs pattern: Use TabPanel children with title prop (e.g. { component: "TabPanel", title: "Important", children: [...] })

**Example 3:** "Create a sales analytics dashboard with revenue chart and top products"
- Surface: \`sales-analytics\`
- Needs API: No (display only)
- Tools: canvas_create, canvas_update, canvas_data
- Components: Column, Grid, Metric, Card, Chart, Table, Text, Badge

**Example 4:** "Show me a task tracking dashboard for my team's sprint"
- Surface: \`task-dashboard\`
- Needs API: Yes (structured data with multiple records)
- Tools: canvas_create, canvas_api_schema, canvas_api_seed, canvas_api_query, canvas_update
- Schema: Task model with \`title: String\`, \`status: String\`, \`priority: String\`
- Components: Column, Row, Grid, Metric, Card, DataList, Text, Badge

### Reference Component Tree — Well-Designed Sales Dashboard

This is the FULL component tree for a polished display-only dashboard. The renderer auto-applies: root gap "lg", Separator injection, date/number formatting, and Metric trend inference from trendValue signs.

\`\`\`json
canvas_update({ surfaceId: "sales-dashboard", components: [
  { "id": "root", "component": "Column", "children": ["header_row", "metrics", "charts_row", "details_card"] },
  { "id": "header_row", "component": "Row", "children": ["title", "period_badge"], "align": "center", "justify": "between" },
  { "id": "title", "component": "Text", "text": "Sales Dashboard", "variant": "h2" },
  { "id": "period_badge", "component": "Badge", "text": "February 2026", "variant": "outline" },
  { "id": "metrics", "component": "Grid", "columns": 3, "children": ["m_revenue", "m_orders", "m_avg"] },
  { "id": "m_revenue", "component": "Metric", "label": "Total Revenue", "value": { "path": "/summary/revenue" }, "unit": "$", "trendValue": "+12% vs last month" },
  { "id": "m_orders", "component": "Metric", "label": "Orders", "value": { "path": "/summary/orders" }, "trendValue": "+8%" },
  { "id": "m_avg", "component": "Metric", "label": "Avg Order Value", "value": { "path": "/summary/avgOrder" }, "unit": "$", "trendValue": "-2%" },
  { "id": "charts_row", "component": "Grid", "columns": 2, "children": ["revenue_chart_card", "category_chart_card"] },
  { "id": "revenue_chart_card", "component": "Card", "title": "Monthly Revenue", "child": "revenue_chart" },
  { "id": "revenue_chart", "component": "Chart", "type": "area", "data": { "path": "/charts/monthlyRevenue" } },
  { "id": "category_chart_card", "component": "Card", "title": "Sales by Category", "child": "category_chart" },
  { "id": "category_chart", "component": "Chart", "type": "donut", "data": { "path": "/charts/categories" } },
  { "id": "details_card", "component": "Card", "title": "Top Products", "child": "products_table" },
  { "id": "products_table", "component": "Table", "columns": [
    { "key": "name", "label": "Product" },
    { "key": "sales", "label": "Sales", "align": "right" },
    { "key": "revenue", "label": "Revenue", "align": "right" }
  ], "rows": { "path": "/topProducts" } }
]})
\`\`\`

Key design patterns: (1) header Row with title + Badge, (2) Grid of Metrics with trendValues, (3) Grid of Card-wrapped Charts, (4) Card-wrapped Table for details. Note: root gap, Separators, number/date formatting, and trend direction are all handled automatically by the renderer.`
