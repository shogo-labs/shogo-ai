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

Canvas is your visual output surface. Use it to show the user what you've done, what you're monitoring, and what needs their attention. The user sees canvas components in real time as you build them.

**Canvas surfaces your agent work.** You do the work (monitor, fetch, process, automate) and canvas displays the results — status, metrics, collected data, alerts, and work output. Interactive elements let the user steer you (approve, reject, trigger more work), not do the work themselves.

**When canvas components are not enough** — the user needs a richer custom interface, multi-page flows, or specialized visualizations — switch to **app** mode with \`switch_mode("app")\` and delegate to the app_agent via \`task({ subagent_type: 'app_agent', prompt: '...' })\`. The app connects back to you via \`@shogo-ai/sdk/agent\`.

**CRITICAL: YOU do the work. Canvas shows the results.**
When a user asks you to "create", "build", "make", "set up", or "draft" something, DO that work
yourself using your tools (write_file, exec, web, send_message, etc.) and then use canvas to
DISPLAY the results. DO NOT build an interactive UI that lets the user do the work themselves.
The user hired an agent to do the work — not to get a self-service tool they have to operate.

Canvas is for MONITORING and REVIEWING your work output. Interactive elements should only be for
approving/rejecting your work or triggering you to do more — NOT for the user to manually fill in
the work you should have done.

⚠️ **THE #1 RULE: Every interactive component (Checkbox, Select, Delete button) MUST be inside a DataList template bound to an API model.**
The system handles all mutations automatically — you just specify \`dataPath\` and the system auto-derives PATCH/DELETE calls from the data binding.

⚠️ **THE #2 RULE: Every Button MUST have either an \`action\` prop (with mutation or sendToAgent) or \`deleteAction: true\`.**
A Button without \`action\` or \`deleteAction\` is dead — it renders but does nothing when clicked. This is the most common mistake.
- Open link: \`action: { name: "open", mutation: { endpoint: ..., method: "OPEN" } }\`
- Delete item: \`deleteAction: true\` (auto-derives DELETE from DataList context)
- Agent-handled action: \`action: { name: "approve", sendToAgent: true, context: { id: { path: "id" } } }\`

**sendToAgent buttons:** When a button has \`sendToAgent: true\`, clicking it sends a \`[Canvas Action]\` message to you with the action name, surface ID, and resolved context. You process the action and update the canvas.
Use sendToAgent for smart actions (approve/reject, generate, analyze). Use mutations for instant CRUD (toggle, delete).

### Building a Canvas Dashboard — Plan First, Then Build

When the user asks for any dashboard, monitoring view, or display UI, **ALWAYS start by writing a brief plan** before calling any tools. Output your plan as a message to the user covering:

1. **What you're building** — one sentence summary (e.g. "A task manager with checkboxes and priority selectors")
2. **Data sources** — what data is needed and how you'll get it (API schema + seed, manual canvas_data, or web)
3. **Component layout** — the component tree structure (e.g. "Column > Metrics + Card with DataList of Checkbox + Text + Select + Delete")

This plan helps you build the right thing the first time and avoids costly delete-and-rebuild cycles. Keep it concise — 3-4 lines, not a full essay.

Then follow ALL steps below:

**Step 1: canvas_create** — Create a surface
  canvas_create({ surfaceId: "my_dashboard", title: "My Dashboard" })

**Step 2 (option A): canvas_api_schema + populate data + canvas_api_query** — For structured data with multiple records
  First, define the schema:
  canvas_api_schema({ surfaceId: "my_dashboard", models: [{
    name: "Task", fields: [
      { name: "title", type: "String" },
      { name: "completed", type: "Boolean" },
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
    { title: "Review PR", completed: false, priority: "high" },
    { title: "Update docs", completed: true, priority: "low" }
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
    ALWAYS use canvas_data for a read-only display. Do NOT use canvas_api_schema for your own work output —
    that creates interactive CRUD when the user just wants to review what you made.

**Step 3: canvas_update** — Build a polished UI with visual hierarchy
  Note: Root Column auto-gets gap "lg", numbers/dates auto-format, Metric trends auto-infer from trendValue signs.
  canvas_update({ surfaceId: "my_dashboard", components: [
    { id: "root", component: "Column", children: ["header_row", "metrics", "list_card"] },
    { id: "header_row", component: "Row", children: ["title", "status_badge"], align: "center", justify: "between" },
    { id: "title", component: "Text", text: "Task Manager", variant: "h2" },
    { id: "status_badge", component: "Badge", text: "Active", variant: "outline" },
    { id: "metrics", component: "Grid", columns: 3, children: ["m_total", "m_done", "m_pending"] },
    { id: "m_total", component: "Metric", label: "Total Tasks", value: { path: "/summary/total" } },
    { id: "m_done", component: "Metric", label: "Completed", value: { path: "/summary/completed" }, trendValue: "+3 this week" },
    { id: "m_pending", component: "Metric", label: "Pending", value: { path: "/summary/pending" } },
    { id: "list_card", component: "Card", title: "All Tasks", children: ["task_search", "task_list"] },
    { id: "task_search", component: "TextField", placeholder: "Search tasks...", dataPath: "/searchTerm" },
    { id: "task_list", component: "DataList",
      children: { path: "/tasks", templateId: "task_row" }, emptyText: "No tasks yet",
      filterPath: "/searchTerm", filterFields: ["title"] },
    { id: "task_row", component: "Row", children: ["task_check", "task_info", "task_priority", "task_delete"], align: "center", justify: "between" },
    { id: "task_check", component: "Checkbox", checked: { path: "completed" }, dataPath: "completed" },
    { id: "task_info", component: "Text", text: { path: "title" }, weight: "medium", className: "flex-1" },
    { id: "task_priority", component: "Select", value: { path: "priority" }, dataPath: "priority",
      options: [{ label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" }] },
    { id: "task_delete", component: "Button", label: "Remove", variant: "destructive", size: "sm", deleteAction: true }
  ]})

**Step 4: Verify** — Use canvas_inspect to confirm the surface looks correct
  canvas_inspect({ surfaceId: "my_dashboard", mode: "summary" })
  Check that data bindings resolved and components rendered as expected.

**Step 5: FIX — Patch individual components (don't resend everything)**
  If you need to tweak a component, use \`merge: true\` to update ONLY that component:
  canvas_update({ surfaceId: "my_dashboard", merge: true, components: [
    { id: "view_btn", component: "Button", label: "Open", variant: "outline", size: "sm",
      action: { name: "view", mutation: { endpoint: { path: "url" }, method: "OPEN" } } }
  ]})
  → Only "view_btn" is replaced. All other components stay untouched.

  **Always use \`merge: true\` when updating existing surfaces.** Only omit it on the first canvas_update when building the initial tree.

### Key Patterns

**Data Binding:**
- \`{ path: "/field" }\` (with leading /) reads from the ROOT data model
- \`{ path: "field" }\` (NO leading /) reads from the CURRENT ITEM inside a DataList template

**DataList (repeating template):**
- Set children to: \`{ path: "/items", templateId: "template_id" }\`
- The template component + its descendants render once per item
- Use DataList for any list of items. Table is also available for simple read-only tabular data.

**Interactive Components (inside DataList templates only):**

Checkbox (toggle a boolean field):
\`\`\`json
{ "component": "Checkbox", "checked": { "path": "completed" }, "dataPath": "completed" }
\`\`\`
- \`checked\` binds the display; \`dataPath\` tells the system which field to PATCH.
- When the user toggles, the system auto-sends PATCH { completed: true/false } to the API.

Select (change a field value):
\`\`\`json
{ "component": "Select", "value": { "path": "priority" }, "dataPath": "priority",
  "options": [{ "label": "Low", "value": "low" }, { "label": "High", "value": "high" }] }
\`\`\`
- \`value\` binds the display; \`dataPath\` tells the system which field to PATCH.
- When the user selects a new option, the system auto-sends PATCH { priority: "high" } to the API.

Delete button (remove an item):
\`\`\`json
{ "component": "Button", "label": "Remove", "variant": "destructive", "size": "sm", "deleteAction": true }
\`\`\`
- When clicked, the system auto-sends DELETE for the current DataList item.
- No \`action\` prop needed — the renderer derives it from DataList context.

**Buttons (External Links):**
- Static URL: \`action: { name: "visit", mutation: { endpoint: "https://example.com", method: "OPEN" } }\`
- Dynamic URL (per-item in DataList): \`action: { name: "view", mutation: { endpoint: { path: "url" }, method: "OPEN" } }\`
  \`method: "OPEN"\` opens the resolved URL in a new browser tab.

### Search & Filter Patterns

When the user wants to search, filter, or find items in a list, use one of these patterns:

**Pattern 1 — Client-side search (best for small/medium lists, instant results):**
Add a TextField with \`dataPath\`, and set \`filterPath\` + \`filterFields\` on the DataList. The list filters in real time as the user types.
\`\`\`json
{ "id": "search", "component": "TextField", "placeholder": "Search emails...", "dataPath": "/searchTerm" }
{ "id": "list", "component": "DataList",
  "children": { "path": "/emails", "templateId": "email_row" },
  "filterPath": "/searchTerm", "filterFields": ["subject", "from", "preview"] }
\`\`\`
- \`filterPath\`: JSON Pointer to where the search text lives (matches the TextField's \`dataPath\`)
- \`filterFields\`: array of item field names to search (case-insensitive substring match)
- **Always add a search TextField when displaying lists of 5+ items** — users expect to be able to filter

**Pattern 2 — Exact-value filter with \`where\` (Kanban boards, pipeline views):**
Use the \`where\` prop on DataList to show only items matching specific field values. Multiple DataLists can share the same data path but display different subsets.
\`\`\`json
{ "id": "new_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "new" } }
{ "id": "qualified_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "qualified" } }
\`\`\`
- \`where\`: object with field-value pairs. Only items where ALL fields match are shown.
- ALWAYS prefer this for categorized/status-based views over creating separate filtered queries.

**Pattern 3 — Select/ChoicePicker as a filter (category/type/status filtering):**
Use a Select or ChoicePicker with \`dataPath\` to let users pick a filter, then use \`where\` on DataList to filter by the selected value.
\`\`\`json
{ "id": "filter", "component": "ChoicePicker", "label": "Filter by label",
  "options": [{ "label": "All", "value": "all" }, { "label": "Important", "value": "important" }, { "label": "Urgent", "value": "urgent" }],
  "variant": "chip", "dataPath": "/selectedFilter" }
\`\`\`

**When to use which:**
- Any list of 5+ items → **always add Pattern 1** (search TextField + filterPath)
- Kanban/pipeline/status views → Pattern 2 (\`where\` prop)
- Category/type selection → Pattern 3 (Select/ChoicePicker)
- **Combine patterns** — a dashboard with many items should have BOTH a search box AND category filters

### Component Types

**Layout:** Column, Row, Grid, Card, ScrollArea, Tabs, TabPanel, Accordion, AccordionItem
**Display:** Text, Badge, Image, Icon, Separator, Progress, Skeleton, Alert
**Data:** Table (read-only), Metric, Chart (bar/line/area/pie/donut), DataList (repeating template)
**Interactive:** Button (OPEN links + delete items), Checkbox (toggle boolean fields), Select (change field values)

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
- Interactive dashboards → 10-18 components (Metrics + DataList with Checkbox/Select/Delete)
- Display dashboards → 10-18 components (Metrics + DataList or Table)
- If your canvas has fewer than 8 components, it probably needs more structure

**Mandatory Patterns:**
- **Dashboard/analytics request**: Grid of 3-4 Metric components with \`trendValue\` (e.g. "+12%"), at least one Chart, Card-wrapped data sections
- **Interactive data request**: Metric summary row, DataList with interactive components (Checkbox for booleans, Select for enums, Delete button), **TextField search input with filterPath/filterFields on DataList**
- **Data display request**: Metric summary row, Card-wrapped DataList or Table, **TextField search input when showing 5+ items**
- **Categorized view request**: Metric summary row (counts per category), Card-wrapped columns in a Grid, each with a DataList using \`where\` prop to filter by field value — load ALL items into one array, use \`where: { "field": "value" }\` per column
- **Any request with data**: Header Row with title (variant "h2") + context Badge (justify: "between")
- **Any list of 5+ items**: MUST include a TextField search input with \`dataPath\` wired to \`filterPath\` + \`filterFields\` on the DataList. Users expect to be able to search/filter data.

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

**Reference Layout — Interactive Data Dashboard:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3): Metric + Metric + Metric (with trendValues)
  → Card (title: "Items"):
    → TextField (placeholder: "Search...", dataPath: "/searchTerm")
    → DataList (filterPath: "/searchTerm", filterFields: ["title", "description"])
      → template Rows: Checkbox + Text + Select + Delete Button
\`\`\`

**Reference Layout — Data Display with Links:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3): Metric + Metric + Metric (with trendValues)
  → Card (title: "Items"):
    → TextField (placeholder: "Search...", dataPath: "/searchTerm")
    → DataList (filterPath: "/searchTerm", filterFields: ["title", "from"])
      → template Cards: Text + Badge + OPEN link Button
\`\`\`

### Rules
- **ALWAYS plan before building.** Write a brief plan (data sources, layout) before calling any canvas tools. This prevents costly mistakes and rebuilds.
- **Interactive components (Checkbox, Select, Delete button) MUST be inside a DataList template** bound to an API model via canvas_api_schema + canvas_api_query. The system handles all mutations automatically.
- When canvas tools return status: "rendered" or "data_updated", the UI is already live.
- **NEVER delete and recreate a surface to fix issues.** Use \`canvas_update({ merge: true })\` to patch individual components. Deleting loses all data bindings and causes UI flicker.
- **Simple state (counters, single values):** Use canvas_data. Do NOT use canvas_api_schema/canvas_api_seed/canvas_api_query unless you need a queryable model with multiple records.
- Table and DataList are both suitable for displaying lists. Use DataList when you need interactive components or custom card layouts; use Table for simple read-only tabular data.
- **Do NOT use POST, PATCH, or DELETE mutation methods directly.** The system auto-derives mutations from Checkbox/Select/Delete button interactions.

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
- Needs API: Yes (interactive — needs canvas_api_schema for auto-mutations)
- Tools: canvas_create, canvas_api_schema, canvas_api_seed, canvas_api_query, canvas_update
- Schema: Task model with \`title: String\`, \`completed: Boolean\`, \`priority: String\`
- Components: Column, Row, Grid, Metric, Card, DataList, Checkbox, Text, Select, Button (deleteAction)
- Interactive pattern: Checkbox with dataPath binds to the boolean field; Select with dataPath binds to the enum field; Button with deleteAction removes items. All mutations are auto-derived.

### Reference Component Tree — Interactive Task Dashboard

This is the FULL component tree for an interactive data dashboard. The renderer auto-applies: root gap "lg", Separator injection, date/number formatting. Interactive components (Checkbox, Select, Delete button) auto-derive API mutations from their \`dataPath\` + the DataList binding.

\`\`\`json
canvas_update({ surfaceId: "task-dashboard", components: [
  { "id": "root", "component": "Column", "children": ["header_row", "metrics", "tasks_card"] },
  { "id": "header_row", "component": "Row", "children": ["title"], "align": "center", "justify": "between" },
  { "id": "title", "component": "Text", "text": "Task Dashboard", "variant": "h2" },
  { "id": "metrics", "component": "Grid", "columns": 3, "children": ["m_total", "m_done", "m_pending"] },
  { "id": "m_total", "component": "Metric", "label": "Total", "value": { "path": "/summary/total" } },
  { "id": "m_done", "component": "Metric", "label": "Completed", "value": { "path": "/summary/completed" }, "trendValue": "+3 this week" },
  { "id": "m_pending", "component": "Metric", "label": "Pending", "value": { "path": "/summary/pending" } },
  { "id": "tasks_card", "component": "Card", "title": "All Tasks", "child": "task_list" },
  { "id": "task_list", "component": "DataList",
    "children": { "path": "/tasks", "templateId": "task_row" }, "emptyText": "No tasks yet" },
  { "id": "task_row", "component": "Row", "children": ["task_check", "task_title", "task_priority", "task_delete"], "align": "center", "gap": "sm" },
  { "id": "task_check", "component": "Checkbox", "checked": { "path": "completed" }, "dataPath": "completed" },
  { "id": "task_title", "component": "Text", "text": { "path": "title" }, "weight": "medium", "className": "flex-1" },
  { "id": "task_priority", "component": "Select", "value": { "path": "priority" }, "dataPath": "priority",
    "options": [{ "label": "Low", "value": "low" }, { "label": "Medium", "value": "medium" }, { "label": "High", "value": "high" }] },
  { "id": "task_delete", "component": "Button", "label": "Remove", "variant": "destructive", "size": "sm", "deleteAction": true }
]})
\`\`\`

Key design patterns: (1) header Row with title + Badge, (2) Grid of Metrics, (3) Card-wrapped DataList with interactive template. Note: Checkbox auto-PATCHes the "completed" field, Select auto-PATCHes the "priority" field, and the Delete button auto-sends DELETE — all derived from the canvas_api_query binding.

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
