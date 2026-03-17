// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Gateway
 *
 * The core runtime loop that makes an agent "alive." Manages:
 * - Heartbeat timer (periodic agent turns reading HEARTBEAT.md)
 * - Channel adapters (Telegram, Discord, etc.)
 * - Session management (per-channel message queuing with multi-turn history)
 * - Skill loading and trigger matching
 * - Memory persistence
 * - Hook event system
 * - Slash command handling
 * - BOOT.md startup execution
 * - Webhook event queue
 *
 * Uses Pi Agent Core for the agentic tool-call loop, supporting
 * multi-provider LLMs (Anthropic, OpenAI, Google, xAI, Groq, etc.).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { Message, ImageContent } from '@mariozechner/pi-ai'
import type { StreamFn, AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { ChannelAdapter, IncomingMessage, AgentStatus, ChannelStatus, StreamChunkConfig, SandboxConfig } from './types'
import { loadSkills, matchSkill, type Skill } from './skills'
import { runAgentLoop, type LoopDetectorConfig, type ToolContext } from './agent-loop'
import { createTools, createHeartbeatTools, textResult, type ModeSwitchHandler } from './gateway-tools'
import { PermissionEngine, parseSecurityPolicy } from './permission-engine'
import { getDynamicAppManager } from './dynamic-app-manager'
import { HookEmitter, loadAllHooks } from './hooks'
import { parseSlashCommand, type SlashCommandContext } from './slash-commands'
import { SessionManager, type SessionManagerConfig } from './session-manager'
import { SqliteSessionPersistence } from './sqlite-session-persistence'
import { BlockChunker } from './block-chunker'
import { CanvasStreamParser } from './canvas-stream-parser'
import { MCPClientManager, type MCPServerConfig } from './mcp-client'
import { initComposioSession, resetComposioSession, isComposioEnabled, isComposioInitialized } from './composio'
import type { FilePart } from './file-attachment-utils'
import { parseFileAttachments } from './file-attachment-utils'
import {
  OPTIMIZED_MEMORY_GUIDE,
  OPTIMIZED_PERSONALITY_GUIDE,
  OPTIMIZED_TOOL_PLANNING_GUIDE,
  OPTIMIZED_SESSION_SUMMARY_GUIDE,
  OPTIMIZED_SKILL_MATCHING_GUIDE,
  OPTIMIZED_MCP_DISCOVERY_GUIDE,
  OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE,
} from './optimized-prompts'

function isComposioTool(name: string): boolean {
  return /^[A-Z]+_/.test(name)
}

function extractToolkitName(name: string): string {
  const p = name.split('_')[0]
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : name
}

function hasErrorInResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  return 'error' in (result as any)
}

const AUTH_ERROR_PATTERNS = [
  'unauthorized', 'forbidden', 'not_authed', 'invalid_auth',
  'token expired', 'refresh token', 'invalid_grant', 'expired',
  'revoked', 'auth_expired', 'authexpired', 'credentials',
  'oauth', 'access denied', 'authentication failed',
]

function isAuthError(raw: string): boolean {
  const l = raw.toLowerCase()
  return AUTH_ERROR_PATTERNS.some(p => l.includes(p))
}

function toUserMessage(toolkit: string, raw: string): string {
  const l = raw.toLowerCase()
  if (l.includes('tool') && l.includes('not found'))
    return `${toolkit} integration tools failed to load. Try reconnecting ${toolkit} from the Capabilities tab.`
  if (l.includes('not found') || l.includes('404'))
    return `${toolkit} could not access the requested resource — it may be private or require additional permissions. Check your org's third-party access settings.`
  if (isAuthError(raw))
    return `${toolkit} authorization failed or connection expired. Please reconnect from the Capabilities tab.`
  if (l.includes('rate limit') || l.includes('429'))
    return `${toolkit} rate limit reached. Please wait a moment and try again.`
  return `${toolkit} encountered an issue: ${raw.length > 120 ? raw.slice(0, 120) + '...' : raw}`
}

export type VisualMode = 'canvas' | 'app' | 'none'

export interface GatewayConfig {
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHours: { start: string; end: string; timezone: string }
  channels: Array<{ type: string; config: Record<string, string> }>
  /** Model configuration: provider + name (e.g. { provider: 'anthropic', name: 'claude-sonnet-4-5' }) */
  model: { provider: string; name: string }
  maxSessionMessages?: number
  /** Session management configuration */
  session?: Partial<SessionManagerConfig>
  /** Loop detection configuration (false to disable) */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Streaming chunk configuration for progressive channel responses */
  streamChunk?: Partial<StreamChunkConfig>
  /** Docker sandbox configuration for exec tool isolation */
  sandbox?: Partial<SandboxConfig>
  /** Main session IDs that bypass sandbox (direct owner chats) */
  mainSessionIds?: string[]
  /** MCP servers to spawn on gateway start — tools from these become available to the agent */
  mcpServers?: Record<string, MCPServerConfig>
  /** Active visual mode: canvas, app, or none (default: 'none') */
  activeMode?: VisualMode
  /** Modes this project is allowed to use (default: all modes for paid, ['canvas','none'] for basic) */
  allowedModes?: VisualMode[]
  /** Whether web search & browser tools are enabled (default: true) */
  webEnabled?: boolean
  /** Whether shell/exec tool is enabled (default: true) */
  shellEnabled?: boolean
  /** Whether cron/scheduling tool is enabled (default: true) */
  cronEnabled?: boolean
  /** Whether image generation tool is enabled (default: true) */
  imageGenEnabled?: boolean
  /** Whether memory tools are enabled (default: true) */
  memoryEnabled?: boolean
  /** Whether canvas tools are enabled (default: true). Automatically set false when switching to app/none mode. */
  canvasEnabled?: boolean
}


const _REMOVED_ADVANCED_GUIDE = `removed
You are an agent builder, not an app builder. If a user asks you to "build an app", "create an application",
or anything that sounds like a standalone application, politely redirect them: explain that you specialize
in building **agents** and **dashboards** (data displays, monitoring panels, operational views, triage boards,
analytics dashboards, etc.). You do NOT build apps like todo apps, CRMs, project management apps, or any
standalone application. Dashboards display data, provide metrics, and let users take quick actions — they
are NOT full applications.

**CRITICAL: YOU do the work. Canvas shows the results.**
When a user asks you to "create", "build", "make", "set up", or "draft" something, your job is
to DO that work yourself using your tools (write_file, exec, web, send_message, tool calls, etc.)
and then optionally use canvas to DISPLAY the results or progress.

DO NOT build an interactive UI that lets the user do the work themselves.
The user hired an agent to do the work — not to get a new app they have to operate.

Examples of WRONG behavior:
- User: "Create a Google Ads campaign" → Agent builds a "Campaign Builder" dashboard with form fields
- User: "Create templates to build campaigns" → Agent builds a "Template Manager" UI with dropdowns
- User: "Set up my email sequences" → Agent builds an "Email Sequence Editor" with text fields
- User: "Draft a marketing plan" → Agent builds a "Marketing Plan Builder" with editable sections

Examples of CORRECT behavior:
- User: "Create a Google Ads campaign" → Agent researches best practices, drafts campaign structure,
  writes it to a file or memory, shows a READ-ONLY canvas summary of the campaign details
- User: "Create templates to build campaigns" → Agent creates the actual template files/documents,
  shows a canvas with the template contents for review
- User: "Set up my email sequences" → Agent writes the sequences, configures the tool integration,
  shows a canvas dashboard of what was set up
- User: "Draft a marketing plan" → Agent writes the plan, shows it in canvas as a formatted read-only view

Canvas is for MONITORING and REVIEWING the agent's work output — not for replacing the agent's work
with a self-service UI. Interactive elements (buttons, forms) should be limited to:
- Approving/rejecting agent work ("Looks good, deploy it" / "Revise this section")
- Triggering the agent to do more work ("Run this campaign" / "Send these emails")
- NOT for the user to manually fill in the work the agent should have done

**CRITICAL: Every canvas you build with interactive elements MUST be tested before you're done.**
Never deliver an untested canvas. Build it, test it, confirm it works, then report to the user.

⚠️ **THE #1 RULE: Every Button MUST have action.mutation OR action.sendToAgent. No exceptions.**
Without one of these, buttons look correct but DO NOTHING when clicked.
This is the single most common canvas bug. A button with only \`action: { name: "add_item" }\` is BROKEN — it needs either:
- \`mutation: { endpoint: "/api/...", method: "POST", body: {...} }\` for instant CRUD (no agent round-trip), OR
- \`sendToAgent: true\` for agent-handled actions (clicking sends the action to you as a [Canvas Action] message so you can process it)
Check EVERY button has a mutation or sendToAgent before declaring "done".

**When to use which:**
- **mutation** — Simple CRUD: add/delete/toggle/update a record. Executes instantly against the managed API. Use for task trackers, todo lists, simple data entry.
- **sendToAgent** — Smart actions: approve/reject, generate content, analyze data, run a workflow, anything requiring your intelligence. The user clicks the button and you receive a \`[Canvas Action]\` message with the action name and context, then you process it and update the canvas.

### Building a Canvas Dashboard — Plan First, Then Build

When the user asks for any dashboard, monitoring view, or interactive UI, **ALWAYS start by writing a brief plan** before calling any tools. Output your plan as a message to the user covering:

1. **What you're building** — one sentence summary (e.g. "A task tracker with add, complete, and delete")
2. **Data model** — what models/fields are needed, or "display-only, no API needed"
3. **Component layout** — the component tree structure (e.g. "Column > Card with Metrics row + DataList of tasks with action buttons")
4. **Actions** — what buttons/interactions it will have and their mutations
5. **Test plan** — which actions you'll verify with canvas_trigger_action

This plan helps you build the right thing the first time and avoids costly delete-and-rebuild cycles. Keep it concise — 4-6 lines, not a full essay.

Then follow ALL steps below:

**Step 1: canvas_create** — Create a surface
  canvas_create({ surfaceId: "my_dashboard", title: "My Dashboard" })

**Step 2: Choose your data backend — local schema OR tool-backed binding**

  **Option A: canvas_api_schema** — Local SQLite-backed CRUD (default for most dashboards)
  Use this when data lives in the canvas itself (user-entered data, sample data, file uploads).
  canvas_api_schema({ surfaceId: "my_dashboard", models: [{
    name: "Task", fields: [
      { name: "title", type: "String" },
      { name: "status", type: "String", default: "todo" },
      { name: "priority", type: "String", default: "medium" }
    ]
  }]})
  → Creates REST endpoints: GET/POST /api/tasks, GET/PATCH/DELETE /api/tasks/:id

  **Option B: Tool-backed live data** (for installed integrations)
  Use this when the data comes from an installed tool (Google Calendar, GitHub, Slack, etc.).
  Instead of storing data locally, this routes CRUD operations directly through the
  installed tool so the canvas always shows live, real-time data from the external service.

  **Preferred: autoBind on tool_install** — auto-discovers CRUD operations from the toolkit schema:
  tool_install({ name: "googlecalendar", autoBind: { surfaceId: "my_dashboard", dataPath: "/events" } })
  → Introspects the toolkit, finds list/create/update/delete tools, infers fields and resultPath,
    creates REST endpoints, and auto-loads data. No prior knowledge of the tool's response needed.
    If the surface doesn't exist yet, the binding is deferred until canvas_create.

  **Manual: canvas_api_bind** — when you need fine-grained control over bindings:
  canvas_api_bind({ surfaceId: "my_dashboard", model: "CalendarEvent",
    fields: [
      { name: "summary", type: "String" },
      { name: "start", type: "String" },
      { name: "end", type: "String" }
    ],
    bindings: {
      list: { tool: "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", resultPath: "items" },
      create: { tool: "GOOGLECALENDAR_CREATE_EVENT", paramMap: { summary: "summary", start: "start", end: "end" } }
    },
    cache: { enabled: true, ttlSeconds: 60 },
    dataPath: "/events"
  })
  → Creates REST endpoints backed by live tool calls AND auto-loads data at "/events".
  → When the agent calls any bound tool directly, the canvas auto-refreshes with fresh data.

  **Skill shortcut: bind at install time** — If a saved skill provides the exact config:
  tool_install({ name: "googlecalendar", bind: { surfaceId: "my_dashboard", model: "CalendarEvent", ... } })

  **When to use which:**
  - User asks to "show my calendar events", "list my GitHub issues" → **autoBind** on tool_install (auto-discovers everything)
  - User asks to "track my tasks", "show my data" with no external source → **canvas_api_schema** (data lives locally)
  - User uploads a CSV or provides data inline → **canvas_api_schema + canvas_api_seed**
  - **YOU produced the content** (drafted emails, campaign plans, templates, calendars) → **canvas_data** (display-only). Do NOT use canvas_api_schema for your own work output — that creates a CRUD app when the user just wants to see what you made. Save the content with write_file or memory_write, then push it to canvas_data for a read-only display.

**Step 3: Populate Data** — REAL data first, sample data only as fallback
  If you used autoBind or canvas_api_bind with dataPath (Option B), skip this step — data is auto-loaded from the tool.

  If you used canvas_api_schema (Option A):
  BEFORE seeding sample data, check if real data is available:
  - If the user mentions a service/platform (GitHub, Google, Slack, etc.) → use tool_search + tool_install to fetch real data, then canvas_api_seed with those real results
  - If the user uploaded files → use read_file/search_files to extract real data, then canvas_api_seed with it
  - If the user asks for real/live data (e.g. "show my tasks", "list my emails") → search for a tool integration first
  - ONLY seed fabricated sample data if: (a) the user explicitly asks for fake/demo/sample data, OR (b) no real data source exists for a generic dashboard (e.g. "show me a sample dashboard")

  Fallback — sample data (only when no real source applies):
  canvas_api_seed({ surfaceId: "my_dashboard", model: "Task", records: [
    { title: "First task", priority: "high" },
    { title: "Second task", status: "done" }
  ]})

  Then load data into the data model:
  canvas_api_query({ surfaceId: "my_dashboard", model: "Task", dataPath: "/tasks" })
  → Now { path: "/tasks" } is available for component data binding

**Step 3.5: canvas_api_hooks** — Register hooks for auto-updating metrics and data integrity
  When your UI has Metric components showing aggregates (totals, counts, averages) derived from a collection, register hooks so they auto-update after mutations:
  canvas_api_hooks({ surfaceId: "my_dashboard", model: "Task",
    beforeCreate: [
      { action: "validate", field: "title", rule: "required" }
    ],
    afterCreate: [
      { action: "recompute", target: "/summary/taskCount", source: "/tasks", aggregate: "count" }
    ],
    afterDelete: [
      { action: "recompute", target: "/summary/taskCount", source: "/tasks", aggregate: "count" }
    ]
  })
  Hook actions: recompute (auto-update aggregates), validate (reject bad input), cascade-delete (remove children), transform (normalize fields), log (audit trail).
  → ALWAYS register recompute hooks when Metrics show aggregates. Without hooks, metrics stay stale after mutations.

**Step 4: canvas_update** — Build a polished UI with visual hierarchy
  Note: Root Column auto-gets gap "lg", Separators auto-inject between form and data sections, numbers/dates auto-format, Metric trends auto-infer from trendValue signs.
  canvas_update({ surfaceId: "my_dashboard", components: [
    { id: "root", component: "Column", children: ["header_row", "metrics", "add_card", "list_card"] },
    { id: "header_row", component: "Row", children: ["title", "status_badge"], align: "center", justify: "between" },
    { id: "title", component: "Text", text: "My Tasks", variant: "h2" },
    { id: "status_badge", component: "Badge", text: "Active", variant: "outline" },
    { id: "metrics", component: "Grid", columns: 3, children: ["m_total", "m_done", "m_pending"] },
    { id: "m_total", component: "Metric", label: "Total Tasks", value: { path: "/summary/total" }, trendValue: "+3 this week" },
    { id: "m_done", component: "Metric", label: "Completed", value: { path: "/summary/done" }, trendValue: "+2" },
    { id: "m_pending", component: "Metric", label: "Pending", value: { path: "/summary/pending" }, trendValue: "-1" },
    { id: "add_card", component: "Card", child: "add_form", title: "Add Task", description: "Create a new task" },
    { id: "add_form", component: "Row", children: ["add_input", "add_btn"], gap: "sm", align: "end" },
    { id: "add_input", component: "TextField", placeholder: "Task title...", dataPath: "/newTaskTitle" },
    { id: "add_btn", component: "Button", label: "Add Task",
      action: { name: "add", mutation: { endpoint: "/api/tasks", method: "POST",
        body: { title: { path: "/newTaskTitle" } } } } },
    { id: "list_card", component: "Card", child: "task_list", title: "All Tasks", description: "Manage your task list" },
    { id: "task_list", component: "DataList",
      children: { path: "/tasks", templateId: "task_card" }, emptyText: "No tasks yet" },
    { id: "task_card", component: "Card", child: "task_row" },
    { id: "task_row", component: "Row", children: ["task_info", "task_actions"], align: "center", justify: "between" },
    { id: "task_info", component: "Column", children: ["task_title", "task_status"], gap: "xs" },
    { id: "task_title", component: "Text", text: { path: "title" }, weight: "medium" },
    { id: "task_status", component: "Badge", text: { path: "status" } },
    { id: "task_actions", component: "Row", children: ["done_btn", "del_btn"], gap: "sm" },
    { id: "done_btn", component: "Button", label: "Done", variant: "outline", size: "sm",
      action: { name: "done", mutation: { endpoint: "/api/tasks/:id", method: "PATCH",
        params: { id: { path: "id" } }, body: { status: "done" } } } },
    { id: "del_btn", component: "Button", label: "Delete", variant: "destructive", size: "sm",
      action: { name: "delete", mutation: { endpoint: "/api/tasks/:id", method: "DELETE",
        params: { id: { path: "id" } } } } }
  ]})

**Step 4.5: PRE-FLIGHT CHECK — Verify button definitions before testing (REQUIRED)**
  Before running any canvas_trigger_action, use canvas_inspect to verify your buttons:
  canvas_inspect({ surfaceId: "my_dashboard", mode: "components" })
  Check EVERY Button component:
  1. Every Button has action.mutation (not just action.name) — buttons without mutation do NOTHING
  2. Every mutation.endpoint matches a real API path from canvas_api_schema
  3. Every mutation.method is POST, PATCH, DELETE, or OPEN
  4. Every mutation inside a DataList template has params: { id: { path: "id" } } for :id endpoints
  If ANY button is missing mutation, fix it with canvas_update({ merge: true }) BEFORE testing.

**Step 5: TEST — Verify EVERY interactive action actually works (REQUIRED)**
  Test EACH distinct action type (add, mark complete, delete, etc.) separately.
  canvas_trigger_action resolves the button's ACTUAL mutation from the component tree — the same way the real frontend does. If the button is missing a mutation or has broken params, the test will catch it.

  Just provide the actionName. For buttons inside DataList templates, also provide itemData with the item's data (use a real ID from seed data):

  Example — test add:
  canvas_trigger_action({ surfaceId: "my_dashboard", actionName: "add" })
  → The tool finds the "add" button, resolves its mutation, executes it, and verifies data changed.
  canvas_inspect({ surfaceId: "my_dashboard", mode: "data", dataPath: "/tasks" })

  Example — test mark complete (DataList template button — needs itemData):
  canvas_trigger_action({ surfaceId: "my_dashboard", actionName: "done", itemData: { id: "ITEM_ID", title: "First task", status: "todo" } })
  → The tool resolves { path: "id" } in params against itemData, replacing :id in the endpoint.
  canvas_inspect({ surfaceId: "my_dashboard", mode: "data", dataPath: "/tasks" })

  Example — test delete (DataList template button — needs itemData):
  canvas_trigger_action({ surfaceId: "my_dashboard", actionName: "delete", itemData: { id: "ITEM_ID" } })
  canvas_inspect({ surfaceId: "my_dashboard", mode: "data", dataPath: "/tasks" })
  → Confirm the item count decreased.

  For each test: if ok: false is returned, the button IS BROKEN. Debug and fix before moving on.
  If "resolvedFromButton: true" appears, the test used the real button definition — this is faithful to what users experience.

**Step 6: FIX — Patch individual components (don't resend everything)**
  If a test fails or you need to tweak a component, use \`merge: true\` to update ONLY the broken component:
  canvas_update({ surfaceId: "my_dashboard", merge: true, components: [
    { id: "del_btn", component: "Button", label: "Delete", variant: "destructive", size: "sm",
      action: { name: "delete", mutation: { endpoint: "/api/tasks/:id", method: "DELETE",
        params: { id: { path: "id" } } } } }
  ]})
  → Only "del_btn" is replaced. All other components stay untouched.
  After fixing, re-test the action with canvas_trigger_action + canvas_inspect.

  **Always use \`merge: true\` when updating existing surfaces.** Only omit it on the first canvas_update when building the initial tree.

**You are not done until EVERY action button has been tested and passes.** A canvas that hasn't been fully tested is a canvas that might be broken. Do not tell the user it works unless every action has been verified.

### Key Patterns

**Data Binding:**
- \`{ path: "/field" }\` (with leading /) reads from the ROOT data model
- \`{ path: "field" }\` (NO leading /) reads from the CURRENT ITEM inside a DataList template

**DataList (repeating template):**
- Set children to: \`{ path: "/items", templateId: "template_id" }\`
- The template component + its descendants render once per item
- Use for any list with per-item buttons (Table cannot have buttons in rows)

**Mutations (frontend-handled CRUD, no agent round-trip):**
- POST: \`{ mutation: { endpoint: "/api/tasks", method: "POST", body: { title: "..." } } }\`
- PATCH: \`{ mutation: { endpoint: "/api/tasks/:id", method: "PATCH", params: { id: { path: "id" } }, body: { status: "done" } } }\`
- DELETE: \`{ mutation: { endpoint: "/api/tasks/:id", method: "DELETE", params: { id: { path: "id" } } } }\`
- OPEN (external link): \`{ mutation: { endpoint: "https://example.com", method: "OPEN" } }\`

**Agent-handled actions (sendToAgent):**
When a button has \`sendToAgent: true\`, clicking it sends a \`[Canvas Action]\` message to you with the action name, surface ID, and resolved context values. You then process the action and update the canvas.
- Approve content: \`{ name: "approve", sendToAgent: true, context: { postId: { path: "id" } } }\`
- Generate report: \`{ name: "generate-report", sendToAgent: true, context: { type: "weekly" } }\`
- Analyze URL: \`{ name: "analyze", sendToAgent: true, context: { url: { path: "/inputUrl" } } }\`

You can mix mutation buttons and sendToAgent buttons on the same surface. Use mutations for simple instant CRUD, and sendToAgent for actions that need your intelligence.

⚠️ Reminder: Every Button MUST have \`action.mutation\` or \`action.sendToAgent\` (see THE #1 RULE above). Without one, the button does NOTHING when clicked.
**Common mistake:** \`action: { name: "add_item" }\` ← BROKEN, does nothing.
**Correct (CRUD):** \`action: { name: "add_item", mutation: { endpoint: "/api/items", method: "POST", body: { ... } } }\`
**Correct (agent):** \`action: { name: "generate", sendToAgent: true, context: { ... } }\`

**Form inputs → Mutation body:**
- Set \`dataPath: "/newTitle"\` on TextField to write user input to the data model
- Reference it in mutation body: \`{ title: { path: "/newTitle" } }\`

### Search & Filter Patterns

When the user wants to search, filter, or find items in a list, use one of these patterns:

**Pattern 1 — Client-side filter (best for small lists, instant results):**
Add a TextField with \`dataPath\`, and set \`filterPath\` + \`filterFields\` on the DataList. The list filters in real time as the user types — no API calls, no lag.
\`\`\`json
{ "id": "search", "component": "TextField", "placeholder": "Search...", "dataPath": "/searchTerm" }
{ "id": "list", "component": "DataList",
  "children": { "path": "/tasks", "templateId": "task_card" },
  "filterPath": "/searchTerm", "filterFields": ["title", "description"] }
\`\`\`
- \`filterPath\`: JSON Pointer to where the search text lives in the data model (matches the TextField's \`dataPath\`)
- \`filterFields\`: array of item field names to match against (case-insensitive substring search)
- Use this when the data is already loaded via \`canvas_api_query\` (typically < 100 items)

**Pattern 2 — Server-side search (best for large datasets):**
Use the managed API's \`_search\` and \`_searchFields\` query params via an API binding with reactive params. The API refetches with each search term change.
\`\`\`json
{ "id": "search", "component": "TextField", "placeholder": "Search employees...", "dataPath": "/searchTerm", "debounceMs": 300 }
{ "id": "list", "component": "DataList",
  "children": { "path": "/employees", "templateId": "emp_card" } }
\`\`\`
For server-side search, use \`canvas_api_query\` with the collection's data path, then load the DataList with \`{ api: "/api/employees", params: { "_search": { path: "/searchTerm" }, "_searchFields": "name,title" } }\` on a Table or in a binding.
- Set \`debounceMs: 300\` on the TextField to avoid excessive API calls
- The API performs case-insensitive LIKE matching across the specified fields

**Pattern 3 — Exact-value filter with \`where\` (best for Kanban boards, pipeline columns, status-based views):**
Use the \`where\` prop on DataList to show only items matching specific field values. Multiple DataLists can share the same data path but display different subsets. When mutations update the shared array, all columns re-render automatically.
\`\`\`json
{ "id": "new_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "new" } }
{ "id": "qualified_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "qualified" } }
{ "id": "closed_col", "component": "DataList",
  "children": { "path": "/leads", "templateId": "lead_card" },
  "where": { "stage": "closed" } }
\`\`\`
- \`where\`: object with field-value pairs. Only items where ALL fields match are shown.
- Load ALL items into one array with a single \`canvas_api_query\` (no per-column queries needed).
- After a PATCH mutation changes an item's stage, the base array auto-refreshes and each column re-filters.
- ALWAYS prefer this pattern for Kanban/pipeline/status boards over creating separate filtered queries.

**When to use which:**
- Kanban board / pipeline columns / status-based views → Pattern 3 (\`where\` prop)
- Small list with search box (seeded data, < ~50 items) → Pattern 1 (client-side \`filterPath\`)
- Large dataset or user asks for "search" specifically → Pattern 2 (API \`_search\`)
- When in doubt for search, use Pattern 1 — it's simpler and works for most canvas use cases

### Component Types

**Layout:** Column, Row, Grid, Card, ScrollArea, Tabs, TabPanel, Accordion, AccordionItem
**Display:** Text, Badge, Image, Icon, Separator, Progress, Skeleton, Alert
**Data:** Table (read-only), Metric, Chart (bar/line/area/pie/donut), DataList (repeating with actions)
**Interactive:** Button, TextField, Select, Checkbox, ChoicePicker

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

### Testing Tools

- **canvas_trigger_action** — Simulate a REAL button click. Finds the button by actionName, resolves its mutation from the component tree (same as the frontend), executes it, and verifies data changed. For DataList template buttons, pass \`itemData\` with the item's fields so scoped bindings (\`{ path: "id" }\`) and \`:id\` params resolve correctly. Returns \`resolvedFromButton: true\` when it used the real button definition.
- **canvas_inspect** — Read the current surface state. ALWAYS call this after canvas_trigger_action to double-check the data. Also use with mode: "components" for the pre-flight check (Step 4.5).
- The pattern is always: **pre-flight check → trigger → inspect → report** for EACH action type. No exceptions.
- You MUST test every distinct action button (add, update/mark-complete, delete) — not just one.

### Other Tools
- **canvas_api_bind** — Bind installed tool operations to canvas CRUD routes for live data. Use this instead of canvas_api_schema when data comes from an external service. Include dataPath to auto-load data (replaces canvas_api_query). Prefer using autoBind on tool_install instead — it auto-discovers bindings from the toolkit schema.
- **canvas_api_hooks** — Register declarative hooks (recompute, validate, cascade-delete, transform, log) on model CRUD operations. Hooks fire automatically when data changes.
- **canvas_data** — Manually push data: \`canvas_data({ surfaceId: "dashboard", path: "/key", value: data })\`
- **canvas_data_patch** — Atomic operations (increment, decrement, toggle, append, set) without reading first. Use for counters and toggles instead of the full API pipeline.
- **canvas_action_wait** — Pause and wait for a REAL USER to click. Only use when you need the human to interact — never for self-testing.
- **canvas_delete** — Remove a surface (AVOID using this — prefer canvas_update to fix issues)
- **canvas_components** — Discover components and their props

### Visual Quality & Layout

The renderer auto-formats numbers (commas, compact notation), currency ($ prefix), dates (ISO → "Feb 26, 2026"), auto-infers Metric trend direction from trendValue strings, auto-wraps naked DataList/Table in Cards, auto-injects Separators between form and data sections, and defaults root Column gap to "lg". You do NOT need to manually format values, add Separators, or wrap DataList/Table in Cards — the renderer handles this.

**What YOU must provide (the renderer cannot infer these):**

**Component Richness:**
- Dashboard/analytics → 12-20 components (Grid of Metrics + Charts + Tables)
- Data management dashboards → 10-18 components (Metrics + Form Card + DataList)
- If your canvas has fewer than 8 components, it probably needs more structure

**Mandatory Patterns:**
- **Dashboard/analytics request**: Grid of 3-4 Metric components with \`trendValue\` (e.g. "+12%"), at least one Chart, Card-wrapped data sections
- **Data management dashboard request**: Metric summary row, Card-wrapped form section with title, DataList
- **Kanban/board request**: Metric summary row (counts per column), Card-wrapped columns in a Grid, each with a DataList using \`where\` prop to filter by status/stage — load ALL items into one array, use \`where: { "stage": "value" }\` per column
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

**Reference Layout — Data Management Dashboard:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3): Metric + Metric + Metric (with trendValues)
  → Card (title: "Add Item"): form Row with inputs + Button
  → Card (title: "Items"): DataList with template Cards
\`\`\`

**Reference Layout — Analytics Dashboard:**
\`\`\`
Root Column
  → Row: title (h2) + Badge (justify: between)
  → Grid (columns: 3-4): Metric cards with trendValues
  → Grid (columns: 2): Card(Chart type=line/area) + Card(Chart type=pie/donut or Table)
  → Card (title: "Details"): Table
\`\`\`

### Rules
- **ALWAYS plan before building.** Write a brief plan (data model, layout, actions, tests) before calling any canvas tools. This prevents costly mistakes and rebuilds.
- **ALWAYS register recompute hooks** when Metric components display aggregates (sum, count, avg) of a collection. Without hooks, metrics display stale values after mutations. Use canvas_api_hooks with afterCreate + afterDelete (and afterUpdate if the aggregated field can change).
- **Use validate hooks** for data integrity — required fields, positive numbers, enum constraints. These prevent bad data before it enters the database.
- **Use cascade-delete hooks** when models have parent-child relationships (e.g. Project → Tasks). This prevents orphaned records.
- After building any canvas with buttons or CRUD, ALWAYS run Step 5 (trigger + inspect) for EVERY action type. Test add, update/complete, and delete separately.
- If canvas_trigger_action returns ok: false, the button is BROKEN. Fix it with \`canvas_update({ merge: true })\` — see Step 6.
- After canvas_trigger_action, ALWAYS follow up with canvas_inspect — never canvas_action_wait.
- canvas_action_wait is ONLY for waiting on real human interaction, NOT for testing.
- When canvas tools return status: "rendered" or "data_updated", the UI is already live.
- **NEVER delete and recreate a surface to fix issues.** Use \`canvas_update({ merge: true })\` to patch individual components. Deleting loses all data bindings and causes UI flicker.
- **Simple state (counters, toggles, single values):** Use canvas_data or canvas_data_patch ONLY. Do NOT use canvas_api_schema/canvas_api_seed/canvas_api_query — those are for persistent CRUD data with multiple records.
- **External service data (Calendar, GitHub, Slack, etc.):** Use autoBind on tool_install to auto-discover and bind CRUD operations, or canvas_api_bind with dataPath for manual control. Do NOT use canvas_api_schema + canvas_api_seed for data that belongs to an external service — that creates a stale snapshot instead of live data.
- Table is read-only. For lists needing edit/delete buttons, always use DataList.

`

const BASIC_CANVAS_TOOLS_GUIDE = `## Canvas — Your Agent Display Panel

Canvas is your visual output surface. Use it to show the user what you've done, what you're monitoring, and what needs their attention. The user sees canvas components in real time as you build them.

**Canvas surfaces your agent work.** You do the work (monitor, fetch, process, automate) and canvas displays the results — status, metrics, collected data, alerts, and work output. Interactive elements let the user steer you (approve, reject, trigger more work), not do the work themselves.

**When canvas components are not enough** — the user needs a richer custom interface, multi-page flows, or specialized visualizations — switch to **app** mode with \`switch_mode("app")\` and delegate to \`code_agent\`. The app connects back to you via \`@shogo-ai/sdk/agent\`.

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

const PERSONALITY_EVOLUTION_GUIDE_PREFIX = `## Personality Self-Update

You have a \`personality_update\` tool that lets you improve your own behavior files.

### When to Use
- User explicitly corrects your tone, style, or boundaries (e.g. "be more formal")
- User establishes a new, lasting boundary (e.g. "don't suggest code changes")
- You discover a persistent user preference that should shape future interactions

### When NOT to Use
- One-off requests or trivial conversation
- Information already present in your SOUL.md
- Temporary context that doesn't reflect a lasting change

### How It Works
- Specify the file (SOUL.md, AGENTS.md, or IDENTITY.md), the section heading, and the new content
- Include a reasoning field explaining why the update improves your behavior
- The Boundaries section in SOUL.md can never be removed, only appended to
- All updates are logged to daily memory with [personality-update] tag

`

export class AgentGateway {
  private workspaceDir: string
  private projectId: string
  private config: GatewayConfig
  private currentUserId: string | undefined
  private channels: Map<string, ChannelAdapter> = new Map()
  private skills: Skill[] = []
  private configSkills: Array<{ name: string; trigger?: string; description?: string }> = []
  private running = false
  private lastHeartbeatTick: Date | null = null
  private hookEmitter: HookEmitter = new HookEmitter()
  private pendingEvents: string[] = []
  private sessionManager: SessionManager
  private sessionPersistence: SqliteSessionPersistence | null = null
  private mcpClientManager: MCPClientManager = new MCPClientManager()
  /** Optional custom stream function, injected for testing */
  private _streamFn?: StreamFn
  /** Optional log callback for forwarding gateway events to the UI Logs tab */
  private _onLog?: (line: string) => void
  /** Per-section prompt overrides set by DSPy optimization via POST /agent/prompt-override */
  private promptOverrides = new Map<string, string>()
  /** Tool execute overrides for eval mocking (tool name -> mock fn) */
  private toolMocks = new Map<string, (params: Record<string, any>) => any>()
  /** Synthetic tool definitions for mocked MCP tools that don't exist in the base tool set */
  private syntheticTools = new Map<string, { description: string; paramKeys: string[] }>()
  /** Tools that have mock responses but should not appear until promoted via tool_install */
  private hiddenMockTools = new Set<string>()
  /** Hidden mocks promoted to visible after tool_install is called during a turn */
  private promotedMockTools: AgentTool[] = []
  /** User's IANA timezone, set from chat requests. Falls back to server timezone. */
  private userTimezone: string | null = null
  /** Permission engine for local-mode security guardrails */
  private permissionEngine: PermissionEngine | null = null
  /** Callback to push permission-related SSE events to the connected client */
  private _permissionSseCallback?: (event: Record<string, any>) => void
  /** Claude Code sub-agent tool (created when code-agent module is available) */
  private codeAgentTool: import('@mariozechner/pi-agent-core').AgentTool | null = null

  /** Usage from the most recent agentTurn (consumed by server.ts for the finish event) */
  private _lastTurnUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    iterations: number
    toolCallCount: number
  } | null = null

  constructor(workspaceDir: string, projectId: string) {
    this.workspaceDir = workspaceDir
    this.projectId = projectId
    this.config = this.loadConfig()
    this.sessionManager = new SessionManager(this.config.session)
    this.mcpClientManager.setWorkspaceDir(workspaceDir)

    // Initialize permission engine in local mode
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      const pref = parseSecurityPolicy(process.env.SECURITY_POLICY)
      this.permissionEngine = new PermissionEngine({
        preference: pref,
        workspaceDir,
      })
      console.log(`[AgentGateway] Permission engine initialized: mode=${pref.mode}`)
    }

    // Initialize code agent tool (lazy — only used when mode=app)
    try {
      const { createCodeAgentTool } = require('./code-agent')
      this.codeAgentTool = createCodeAgentTool({
        workspaceDir,
        aiProxy: process.env.AI_PROXY_URL && process.env.AI_PROXY_TOKEN
          ? { url: process.env.AI_PROXY_URL, token: process.env.AI_PROXY_TOKEN }
          : null,
        getModelTier: () => {
          const name = this.config.model.name
          if (name.includes('haiku')) return 'haiku' as const
          if (name.includes('opus')) return 'opus' as const
          return 'sonnet' as const
        },
      })
      console.log(`[AgentGateway] Code agent tool initialized`)
    } catch {
      console.log(`[AgentGateway] Code agent not available (claude-agent-sdk not installed)`)
    }
  }

  /** Inject a custom streamFn (used in tests to mock the LLM) */
  setStreamFn(fn: StreamFn): void {
    this._streamFn = fn
  }

  /** Set a log callback for forwarding gateway events to the UI Logs tab */
  setLogCallback(fn: (line: string) => void): void {
    this._onLog = fn
  }

  setUserTimezone(tz: string): void {
    this.userTimezone = tz
  }

  /** Set the SSE writer callback so the permission engine can push approval requests to the UI */
  setPermissionSseCallback(cb: (event: Record<string, any>) => void): void {
    this._permissionSseCallback = cb
    if (this.permissionEngine) {
      this.permissionEngine.setSseCallback(cb)
    }
  }

  /** Get the permission engine (used by server.ts for the approval response endpoint) */
  getPermissionEngine(): PermissionEngine | null {
    return this.permissionEngine
  }

  /** Install tool-level execute overrides (for eval mocking). Preserves tool schema. */
  setToolMocks(
    mocks: Record<string, (params: Record<string, any>) => any>,
    syntheticDefs?: Record<string, { description: string; paramKeys: string[] }>,
    hiddenTools?: Set<string>,
  ): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
    for (const [name, fn] of Object.entries(mocks)) {
      this.toolMocks.set(name, fn)
    }
    if (syntheticDefs) {
      for (const [name, def] of Object.entries(syntheticDefs)) {
        this.syntheticTools.set(name, def)
      }
    }
    if (hiddenTools) {
      for (const name of hiddenTools) {
        this.hiddenMockTools.add(name)
      }
    }
  }

  clearToolMocks(): void {
    this.toolMocks.clear()
    this.syntheticTools.clear()
    this.hiddenMockTools.clear()
    this.promotedMockTools = []
  }

  /** After mock tool_install returns, promote hidden mock tools listed in the response */
  _promoteHiddenMocksFromInstall(result: any): void {
    const tools = result?.tools
    if (!Array.isArray(tools)) return
    for (const entry of tools) {
      const toolName = typeof entry === 'string' ? entry : entry?.name
      if (!toolName) continue
      if (!this.hiddenMockTools.has(toolName)) continue
      if (this.promotedMockTools.some(t => t.name === toolName)) continue
      const mockFn = this.toolMocks.get(toolName)
      if (!mockFn) continue
      const synDef = this.syntheticTools.get(toolName)
      const paramProps: Record<string, any> = {}
      if (synDef?.paramKeys) {
        for (const key of synDef.paramKeys) {
          paramProps[key] = Type.Optional(Type.String({ description: key }))
        }
      }
      paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
      this.promotedMockTools.push({
        name: toolName,
        description: synDef?.description || `External integration tool: ${toolName}`,
        label: toolName.replace(/__/g, ' > ').replace(/_/g, ' '),
        parameters: Type.Object(paramProps),
        execute: async (_id: string, params: any) => {
          const r = mockFn(params)
          return textResult(r)
        },
      })
      this.hiddenMockTools.delete(toolName)
    }
  }

  /** Consume usage data from the most recent agent turn (returns null if none available) */
  consumeLastTurnUsage() {
    const usage = this._lastTurnUsage
    this._lastTurnUsage = null
    return usage
  }

  /** Replace prompt sections at runtime (used by DSPy optimization pipeline) */
  setPromptOverrides(overrides: Record<string, string>): void {
    this.promptOverrides.clear()
    for (const [key, value] of Object.entries(overrides)) {
      this.promptOverrides.set(key, value)
    }
  }

  private emitLog(line: string): void {
    const ts = new Date().toISOString()
    const formatted = `[${ts}] ${line}`
    this._onLog?.(formatted)
  }

  private loadConfig(): GatewayConfig {
    const defaults: GatewayConfig = {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      maxSessionMessages: 30,
      activeMode: 'none',
      allowedModes: ['canvas', 'app', 'none'],
      mainSessionIds: ['chat'],
    }
    const configPath = join(this.workspaceDir, 'config.json')
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        return {
          ...defaults,
          ...raw,
          heartbeatInterval: raw.heartbeat?.intervalMs
            ? Math.round(raw.heartbeat.intervalMs / 1000)
            : raw.heartbeatInterval ?? defaults.heartbeatInterval,
          heartbeatEnabled: raw.heartbeat?.enabled ?? raw.heartbeatEnabled ?? defaults.heartbeatEnabled,
          channels: Array.isArray(raw.channels) ? raw.channels : [],
        }
      } catch (error: any) {
        console.error('[AgentGateway] Failed to parse config.json:', error.message)
      }
    }
    return defaults
  }

  reloadConfig(): void {
    this.config = this.loadConfig()
    const caps = ['canvas', 'web', 'shell', 'cron', 'imageGen', 'memory'] as const
    const flags = caps.map(c => `${c}=${this.config[`${c}Enabled` as keyof GatewayConfig] !== false}`).join(', ')
    console.log(`[AgentGateway] Config reloaded (mode=${this.config.activeMode || 'none'}, ${flags})`)
  }

  async start(): Promise<void> {
    console.log('[AgentGateway] Starting...')
    this.running = true

    // Load skills from workspace skills/ directory only (bundled skills must be explicitly installed)
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
    this.configSkills = this.loadConfigSkills()
    console.log(`[AgentGateway] Loaded ${this.skills.length} skills, ${this.configSkills.length} config skills`)

    // Load hooks
    try {
      const hooks = await loadAllHooks(this.workspaceDir)
      this.hookEmitter.register(hooks)
      console.log(`[AgentGateway] Loaded ${hooks.length} hooks`)
    } catch (error: any) {
      console.error('[AgentGateway] Failed to load hooks:', error.message)
    }

    // Connect channels
    for (const channelConfig of this.config.channels) {
      try {
        await this.connectChannel(channelConfig.type, channelConfig.config)
      } catch (error: any) {
        console.error(
          `[AgentGateway] Failed to connect ${channelConfig.type}:`,
          error.message
        )
      }
    }

    if (this.config.heartbeatEnabled) {
      console.log(
        `[AgentGateway] Heartbeat enabled (externally scheduled, interval ${this.config.heartbeatInterval}s)`
      )
    }

    // Start configured MCP servers
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      try {
        await this.mcpClientManager.startAll(this.config.mcpServers)
      } catch (error: any) {
        console.error('[AgentGateway] MCP server startup error:', error.message)
      }
    }

    // Composio session init is deferred to per-request (processChatMessageStream)
    // so it uses the real authenticated user ID, not a static default.
    if (isComposioEnabled()) {
      console.log('[AgentGateway] Composio enabled — session will init on first chat request with user context')
    }

    // Initialize session persistence and restore sessions
    this.sessionPersistence = new SqliteSessionPersistence(this.workspaceDir)
    this.sessionManager.setPersistence(this.sessionPersistence)
    await this.sessionManager.restoreSessions()

    // Start session pruning
    this.sessionManager.startPruning()

    // Run BOOT.md if it exists
    await this.runBootMd()

    // Emit gateway:startup hook
    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'startup', 'system', {
        workspaceDir: this.workspaceDir,
        projectId: this.projectId,
      })
    )

    console.log('[AgentGateway] Started successfully')
    this.emitLog('Agent gateway started')
  }

  async stop(): Promise<void> {
    console.log('[AgentGateway] Stopping...')
    this.running = false

    this.sessionManager.destroy()
    this.sessionPersistence?.close()
    await this.mcpClientManager.stopAll()

    for (const [name, adapter] of this.channels) {
      try {
        await adapter.disconnect()
        console.log(`[AgentGateway] Disconnected ${name}`)
      } catch (error: any) {
        console.error(`[AgentGateway] Error disconnecting ${name}:`, error.message)
      }
    }
    this.channels.clear()

    await this.hookEmitter.emit(
      HookEmitter.createEvent('gateway', 'shutdown', 'system', {
        workspaceDir: this.workspaceDir,
      })
    )

    console.log('[AgentGateway] Stopped')
  }

  // ---------------------------------------------------------------------------
  // BOOT.md
  // ---------------------------------------------------------------------------

  private async runBootMd(): Promise<void> {
    const bootPath = join(this.workspaceDir, 'BOOT.md')
    if (!existsSync(bootPath)) return

    const bootContent = readFileSync(bootPath, 'utf-8').trim()
    if (!bootContent) return

    console.log('[AgentGateway] Running BOOT.md...')
    try {
      const response = await this.agentTurn(
        `[BOOT]\nYou are starting up. Execute the following startup instructions:\n\n${bootContent}`,
        'boot'
      )
      console.log('[AgentGateway] BOOT.md result:', response.substring(0, 200))
    } catch (error: any) {
      console.error('[AgentGateway] BOOT.md execution failed:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------


  private isInQuietHours(): boolean {
    if (!this.config.quietHours.start || !this.config.quietHours.end) {
      return false
    }

    const now = new Date()
    const tz = this.config.quietHours.timezone || 'UTC'
    let hours: number
    let minutes: number
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      const timeStr = fmt.format(now)
      const [h, m] = timeStr.split(':').map(Number)
      hours = h % 24
      minutes = m
    } catch {
      hours = now.getUTCHours()
      minutes = now.getUTCMinutes()
    }
    const currentTime = hours * 60 + minutes

    const [startH, startM] = this.config.quietHours.start.split(':').map(Number)
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number)
    const startTime = startH * 60 + startM
    const endTime = endH * 60 + endM

    // Log the comparison for debugging
    const currentStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    console.log(`[AgentGateway] Quiet hours check: current=${currentStr} (${tz}), window=${this.config.quietHours.start}-${this.config.quietHours.end}`)

    if (startTime <= endTime) {
      return currentTime >= startTime && currentTime < endTime
    }
    return currentTime >= startTime || currentTime < endTime
  }

  async heartbeatTick(): Promise<string> {
    this.lastHeartbeatTick = new Date()

    const heartbeatPath = join(this.workspaceDir, 'HEARTBEAT.md')
    if (!existsSync(heartbeatPath)) {
      return 'HEARTBEAT_OK'
    }

    const checklist = readFileSync(heartbeatPath, 'utf-8').trim()
    if (!checklist) {
      return 'HEARTBEAT_OK'
    }

    if (this.isInQuietHours()) {
      console.log('[AgentGateway] Heartbeat skipped (quiet hours)')
      this.emitLog('Heartbeat skipped (quiet hours)')
      return 'HEARTBEAT_OK'
    }

    console.log('[AgentGateway] Running heartbeat...')
    this.emitLog('Running heartbeat...')

    let pendingSection = ''
    if (this.pendingEvents.length > 0) {
      pendingSection = `\n\n[Pending Events]\n${this.pendingEvents.join('\n')}`
      this.pendingEvents = []
    }

    const response = await this.agentTurn(
      `[HEARTBEAT]\nYou are performing a scheduled heartbeat check. Review the following checklist and take action as needed. If everything is fine, respond with exactly "HEARTBEAT_OK". If something needs attention, describe the issue and any actions taken.\n\n${checklist}${pendingSection}`,
      'heartbeat',
      true
    )

    await this.hookEmitter.emit(
      HookEmitter.createEvent('heartbeat', 'tick', 'heartbeat', {
        workspaceDir: this.workspaceDir,
        response,
        hadAlert: response !== 'HEARTBEAT_OK',
      })
    )

    if (response !== 'HEARTBEAT_OK') {
      console.log('[AgentGateway] Heartbeat alert:', response.substring(0, 200))
      this.emitLog(`Heartbeat alert: ${response.substring(0, 200)}`)
      await this.deliverAlert(response)

      await this.hookEmitter.emit(
        HookEmitter.createEvent('heartbeat', 'alert', 'heartbeat', {
          workspaceDir: this.workspaceDir,
          alertText: response,
        })
      )
    } else {
      console.log('[AgentGateway] Heartbeat OK')
      this.emitLog('Heartbeat OK')
    }

    this.appendDailyMemory(`Heartbeat: ${response === 'HEARTBEAT_OK' ? 'All clear' : response.substring(0, 200)}`)

    return response
  }

  async triggerHeartbeat(): Promise<string> {
    return this.heartbeatTick()
  }

  queuePendingEvent(text: string): void {
    this.pendingEvents.push(text)
  }

  // ---------------------------------------------------------------------------
  // Message Processing
  // ---------------------------------------------------------------------------

  async processMessage(input: IncomingMessage): Promise<void> {
    this.emitLog(`Channel message from ${input.channelType || 'unknown'}: "${(input.text || '').substring(0, 100)}"`)
    const sessionId = input.channelId || 'default'
    const qs = this.getQueueState(sessionId)
    this.sessionManager.getOrCreate(sessionId)

    await this.hookEmitter.emit(
      HookEmitter.createEvent('message', 'received', sessionId, {
        workspaceDir: this.workspaceDir,
        from: input.senderId,
        content: input.text,
        channelId: input.channelId,
        channelType: input.channelType,
      })
    )

    qs.queue.push(input)

    if (!qs.processing) {
      await this.processQueue(sessionId, qs)
    }
  }

  private queueState: Map<string, { queue: IncomingMessage[]; processing: boolean }> = new Map()

  private getQueueState(sessionId: string) {
    let state = this.queueState.get(sessionId)
    if (!state) {
      state = { queue: [], processing: false }
      this.queueState.set(sessionId, state)
    }
    return state
  }

  private async processQueue(
    sessionId: string,
    qs: { queue: IncomingMessage[]; processing: boolean }
  ): Promise<void> {
    qs.processing = true
    const session = this.sessionManager.getOrCreate(sessionId)
    session.stopRequested = false

    while (qs.queue.length > 0 && !session.stopRequested) {
      const message = qs.queue.shift()!

      try {
        const cmdResult = parseSlashCommand(message.text, this.buildSlashContext(sessionId))
        if (cmdResult.handled) {
          const response = cmdResult.response || ''

          if (cmdResult.hookEvent) {
            await this.hookEmitter.emit(
              HookEmitter.createEvent(
                cmdResult.hookEvent.type,
                cmdResult.hookEvent.action,
                sessionId,
                {
                  ...cmdResult.hookEvent.context,
                  senderId: message.senderId,
                  channelType: message.channelType,
                }
              )
            )
          }

          if (cmdResult.hookEvent?.action === 'stop') {
            session.stopRequested = true
          }

          if (response && message.channelId && this.channels.has(message.channelType || '')) {
            const adapter = this.channels.get(message.channelType!)
            await adapter?.sendMessage(message.channelId, response)
          }

          continue
        }

        const matchedSkill = matchSkill(this.skills, message.text)
        let prompt = message.text
        let activeSkill: { name: string } | undefined

        if (matchedSkill) {
          prompt = [
            `[Skill: ${matchedSkill.name}]`,
            `A saved skill matched this request. Follow its instructions for this integration.`,
            `You can still use mcp_search if you need additional tools beyond what the skill provides.`,
            ``,
            matchedSkill.content,
            ``,
            `[User Message]`,
            message.text,
          ].join('\n')
          activeSkill = { name: matchedSkill.name }
        }

        const adapter = (message.channelId && this.channels.has(message.channelType || ''))
          ? this.channels.get(message.channelType!)
          : undefined
        const streamTarget = adapter && message.channelId
          ? { adapter, channelId: message.channelId }
          : undefined

        const response = await this.agentTurn(prompt, sessionId, false, streamTarget, undefined, activeSkill)

        if (adapter && message.channelId && !this.config.streamChunk) {
          await adapter.sendMessage(message.channelId, response)
        }

        await this.hookEmitter.emit(
          HookEmitter.createEvent('message', 'sent', sessionId, {
            workspaceDir: this.workspaceDir,
            to: message.channelId,
            content: response,
            channelType: message.channelType,
          })
        )

        this.appendDailyMemory(
          `${message.channelType || 'test'}: "${message.text.substring(0, 100)}" -> "${response.substring(0, 100)}"`
        )
      } catch (error: any) {
        console.error('[AgentGateway] Message processing error:', error.message)
      }
    }

    qs.processing = false
  }

  private isUnconfigured(): boolean {
    if (this.skills.length > 0 || this.configSkills.length > 0) return false
    const agentsPath = join(this.workspaceDir, 'AGENTS.md')
    if (!existsSync(agentsPath)) return true
    const content = readFileSync(agentsPath, 'utf-8')
    return content.includes('Respond concisely and helpfully') && content.includes('# Agent Instructions')
  }

  private buildSetupPrompt(userText: string): string {
    return `[Agent Setup — First Message]\nThis is a brand new agent that has not been configured yet. The user's message below describes what they want the agent to do. Use your tools to set up the agent:\n\n1. Write IDENTITY.md with a fitting name, emoji, and tagline\n2. Write SOUL.md with personality, tone, and boundaries appropriate for this use case\n3. Write AGENTS.md with specific operating instructions and priorities (IMPORTANT: replace the default content)\n4. Write HEARTBEAT.md with a relevant checklist if the agent should run autonomously\n5. Create any relevant skills in the skills/ directory\n6. Update config.json if heartbeat should be enabled\n\nAfter setting up, give the user a brief summary of what you configured.\n\n[User Message]\n${userText}`
  }

  private buildChatPrompt(text: string): { prompt: string; activeSkill?: { name: string } } {
    const matchedSkill = matchSkill(this.skills, text)
    if (matchedSkill) {
      this.emitLog(`Matched skill: ${matchedSkill.name}`)
      const prompt = [
        `[Skill: ${matchedSkill.name}]`,
        `A saved skill matched this request. Follow its instructions for this integration.`,
        `You can still use mcp_search if you need additional tools beyond what the skill provides.`,
        ``,
        matchedSkill.content,
        ``,
        `[User Message]`,
        text,
      ].join('\n')
      return { prompt, activeSkill: { name: matchedSkill.name } }
    }
    return { prompt: `[Chat — User Message]\nThis is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.\n\n${text}` }
  }

  async processChatMessage(text: string): Promise<string> {
    this.emitLog(`Chat message received: "${text.substring(0, 100)}"`)

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(text)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(text)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const response = await this.agentTurn(prompt, 'chat', false, undefined, undefined, activeSkill)
    this.emitLog(`Chat response: "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)

    return response
  }

  /**
   * Streaming variant of processChatMessage that pipes text deltas and
   * tool call events to a UI message stream writer (AI SDK protocol).
   */
  async processChatMessageStream(
    text: string,
    writer: { write(chunk: Record<string, any>): void },
    options?: { modelOverride?: string; fileParts?: FilePart[]; userId?: string },
  ): Promise<void> {
    if (options?.modelOverride) {
      const session = this.sessionManager.getOrCreate('chat')
      session.modelOverride = options.modelOverride
    }

    if (options?.userId) {
      this.currentUserId = options.userId
      if (isComposioEnabled()) {
        await initComposioSession(options.userId, this.projectId)
      }
    }

    this.emitLog(`Chat message received (stream): "${text.substring(0, 100)}"`)

    let images: ImageContent[] | undefined
    let effectiveText = text
    if (options?.fileParts && options.fileParts.length > 0) {
      const parsed = parseFileAttachments(options.fileParts)
      if (parsed.images.length > 0) {
        images = parsed.images
        this.emitLog(`Attached ${parsed.images.length} image(s) for vision`)
      }
      if (parsed.textContext) {
        effectiveText = text
          ? `${text}\n\n${parsed.textContext}`
          : parsed.textContext
      }
    }

    let prompt: string
    let activeSkill: { name: string } | undefined
    if (this.isUnconfigured()) {
      prompt = this.buildSetupPrompt(effectiveText)
      this.emitLog('Agent is not configured — running setup from user message')
    } else {
      const result = this.buildChatPrompt(effectiveText)
      prompt = result.prompt
      activeSkill = result.activeSkill
    }

    const response = await this.agentTurn(prompt, 'chat', false, undefined, writer, activeSkill, images)
    this.emitLog(`Chat response (stream): "${response.substring(0, 100)}"`)

    this.appendDailyMemory(`chat: "${text.substring(0, 100)}" -> "${response.substring(0, 100)}"`)
  }

  async processWebhookMessage(text: string): Promise<string> {
    return this.agentTurn(text, 'webhook')
  }

  async processCanvasAction(event: { surfaceId: string; name: string; context?: Record<string, unknown> }): Promise<string> {
    const { surfaceId, name, context } = event
    const { _sendToAgent, ...cleanContext } = context ?? {}
    const contextStr = Object.keys(cleanContext).length > 0
      ? `\nContext: ${JSON.stringify(cleanContext, null, 2)}`
      : ''
    const prompt = [
      `[Canvas Action] The user clicked "${name}" on surface "${surfaceId}".${contextStr}`,
      `Process this action and update the canvas accordingly.`,
    ].join('\n')
    return this.agentTurn(prompt, 'canvas-action')
  }

  private buildSlashContext(sessionId: string): SlashCommandContext {
    const session = this.sessionManager.getOrCreate(sessionId)
    return {
      sessionKey: sessionId,
      workspaceDir: this.workspaceDir,
      clearHistory: () => {
        this.sessionManager.clearHistory(sessionId)
      },
      getMessages: () => [...session.messages],
      reloadConfig: () => this.reloadConfig(),
      setModelOverride: (model: string) => {
        session.modelOverride = model
      },
      getStatus: () => this.getStatus(),
    }
  }

  // ---------------------------------------------------------------------------
  // Agent Turn (Pi Agent Core)
  // ---------------------------------------------------------------------------

  private async agentTurn(
    prompt: string,
    sessionId: string = 'default',
    isHeartbeat: boolean = false,
    streamTarget?: { adapter: ChannelAdapter; channelId: string },
    uiWriter?: { write(chunk: Record<string, any>): void },
    activeSkill?: { name: string },
    images?: ImageContent[],
  ): Promise<string> {
    if (activeSkill) {
      const skillOverride = [
        `## MCP Server Discovery — Skill Active`,
        ``,
        `The skill "${activeSkill.name}" has been loaded for this request.`,
        `Follow the skill's instructions directly for this integration:`,
        `- Call tool_install if the skill says to (ensures server connection + auth is checked automatically)`,
        `- Proceed to execution with the tools listed in the skill`,
        ``,
        `You can still use mcp_search if you need additional integrations beyond what the skill provides.`,
      ].join('\n')
      this.promptOverrides.set('mcp_discovery_guide', skillOverride)
    }
    const systemPrompt = this.loadBootstrapContext()
    if (activeSkill) {
      this.promptOverrides.delete('mcp_discovery_guide')
    }
    const session = this.sessionManager.getOrCreate(sessionId)
    const modelId = session.modelOverride || this.config.model.name
    const provider = this.config.model.provider

    // Reset per-turn state and wire/clear the SSE writer for permission requests.
    // When there's no uiWriter (cron, heartbeat, channel, webhook turns),
    // clear the callback so "ask" decisions fail closed instead of writing
    // to a stale stream from a previous UI turn.
    if (this.permissionEngine) {
      this.permissionEngine.resetTurn()
      this.permissionEngine.setSseCallback(
        uiWriter ? (event) => uiWriter.write(event) : undefined
      )
    }

    const toolContext: ToolContext = {
      workspaceDir: this.workspaceDir,
      channels: this.channels,
      config: this.config,
      projectId: this.projectId,
      sessionId,
      sandbox: this.config.sandbox,
      mainSessionIds: this.config.mainSessionIds,
      mcpClientManager: this.mcpClientManager,
      connectChannel: (type, config) => this.connectChannel(type, config),
      disconnectChannel: (type) => this.disconnectChannel(type),
      permissionEngine: this.permissionEngine ?? undefined,
      userId: this.currentUserId,
      aiProxyUrl: process.env.AI_PROXY_URL,
      aiProxyToken: process.env.AI_PROXY_TOKEN,
    }

    const modeHandler = {
      onModeSwitch: (mode: VisualMode, reason: string) => {
        this.setActiveMode(mode)
        const enableCanvas = mode === 'canvas'
        // Persist to config.json
        const configPath = join(this.workspaceDir, 'config.json')
        try {
          const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {}
          config.activeMode = mode
          config.canvasEnabled = enableCanvas
          writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
        } catch { /* non-fatal */ }
        this.reloadConfig()
        // Emit SSE event for UI mode switching
        if (uiWriter) {
          uiWriter.write({ type: 'data-mode-switch', data: { mode, reason } })
        }
      },
      getAllowedModes: () => this.getAllowedModes(),
      getActiveMode: () => this.getActiveMode(),
    }

    // Build extra tools (code_agent) that are mode-filtered downstream.
    // Wrap code_agent to inject uiWriter so Claude Code's internal tool
    // calls (Write, Bash, Read, etc.) stream through the SSE connection.
    const extraTools: import('@mariozechner/pi-agent-core').AgentTool[] = []
    if (this.codeAgentTool) {
      const originalCodeAgent = this.codeAgentTool
      extraTools.push({
        ...originalCodeAgent,
        execute: async (id, params, signal, onUpdate) => {
          const context = { uiWriter, abortSignal: signal }
          return originalCodeAgent.execute(id, params, context as any, onUpdate)
        },
      })
    }

    const baseTools = isHeartbeat
      ? createHeartbeatTools(toolContext)
      : createTools(toolContext, modeHandler, extraTools)

    const mcpTools = this.mcpClientManager.getTools()
    let assembledTools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools

    // Mode-based visual tool filtering
    // Canvas tools are only available when canvasEnabled is true OR activeMode is 'canvas'.
    // In 'app' mode or when canvasEnabled is explicitly false, strip all canvas_ tools.
    const activeMode = this.config.activeMode || 'none'
    if (activeMode === 'app' || this.config.canvasEnabled === false) {
      assembledTools = assembledTools.filter(t => !t.name.startsWith('canvas_'))
    }
    // Keep code_agent available in ALL visual modes so the agent can
    // switch_mode('app') + code_agent in the same turn from any starting mode.
    // Only strip for heartbeats where autonomous code generation is not wanted.
    if (isHeartbeat) {
      assembledTools = assembledTools.filter(t =>
        t.name !== 'code_agent' && t.name !== 'preview_status' && t.name !== 'preview_restart'
      )
    }

    // Capability toggles (independent of mode)
    if (this.config.webEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'web' && t.name !== 'browser')
    }
    if (this.config.shellEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'exec')
    }
    if (this.config.cronEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'cron')
    }
    if (this.config.imageGenEnabled === false) {
      assembledTools = assembledTools.filter(t => t.name !== 'generate_image')
    }
    if (this.config.memoryEnabled === false) {
      assembledTools = assembledTools.filter(t => !t.name.startsWith('memory_'))
    }

    let staticTools = assembledTools
    if (this.toolMocks.size > 0) {
      const existingNames = new Set(assembledTools.map(t => t.name))
      const gateway = this

      // Wrap existing tools with mock interceptors
      staticTools = assembledTools.map(tool => {
        const mockFn = this.toolMocks.get(tool.name)
        if (!mockFn) return tool

        // Special handling for tool_install: promote hidden mocks listed in the response
        if (tool.name === 'tool_install') {
          return {
            ...tool,
            execute: async (_id: string, params: any) => {
              const result = mockFn(params)
              gateway._promoteHiddenMocksFromInstall(result)
              return textResult(result)
            },
          }
        }

        return {
          ...tool,
          execute: async (_id: string, params: any) => {
            const result = mockFn(params)
            return textResult(result)
          },
        }
      })

      // Inject synthetic tool definitions for mocked tools not in the base set
      // Skip hidden tools — they become available only after tool_install promotes them
      for (const [name, mockFn] of this.toolMocks) {
        if (existingNames.has(name)) continue
        if (this.hiddenMockTools.has(name)) continue
        const synDef = this.syntheticTools.get(name)
        const paramProps: Record<string, any> = {}
        if (synDef?.paramKeys) {
          for (const key of synDef.paramKeys) {
            paramProps[key] = Type.Optional(Type.String({ description: key }))
          }
        }
        paramProps['input'] = Type.Optional(Type.String({ description: 'Input data or query' }))
        const syntheticTool: AgentTool = {
          name,
          description: synDef?.description || `External integration tool: ${name}`,
          label: name.replace(/__/g, ' > ').replace(/_/g, ' '),
          parameters: Type.Object(paramProps),
          execute: async (_id: string, params: any) => {
            const result = mockFn(params)
            return textResult(result)
          },
        }
        staticTools.push(syntheticTool)
      }
    }

    // Dynamic tools proxy: pi-agent-core uses tools.find() and iterates tools.
    // When tool_install hot-adds servers mid-turn, their tools must be visible
    // immediately. This proxy merges staticTools with live MCP tools on access.
    // Also includes promotedMockTools (hidden mocks promoted via mock tool_install).
    const mcpMgr = this.mcpClientManager
    const promoted = this.promotedMockTools
    const staticNames = new Set(staticTools.map(t => t.name))
    const tools = new Proxy(staticTools, {
      get(target, prop, receiver) {
        if (prop === 'find' || prop === 'filter' || prop === 'map' ||
            prop === 'forEach' || prop === 'some' || prop === 'every' ||
            prop === Symbol.iterator || prop === 'length' ||
            prop === 'slice' || prop === 'concat' || prop === 'includes') {
          const liveMcpTools = mcpMgr.getTools().filter(t => !staticNames.has(t.name))
          const promotedNew = promoted.filter(t => !staticNames.has(t.name))
          const extras = [...liveMcpTools, ...promotedNew]
          const merged = extras.length > 0 ? [...target, ...extras] : target
          if (prop === 'length') return merged.length
          if (prop === Symbol.iterator) return merged[Symbol.iterator].bind(merged)
          return (merged as any)[prop].bind(merged)
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as AgentTool[]

    const history = this.sessionManager.buildHistory(sessionId)

    // Typing indicator: send once before the turn and periodically
    let typingInterval: ReturnType<typeof setInterval> | undefined
    if (streamTarget?.adapter.sendTyping) {
      streamTarget.adapter.sendTyping(streamTarget.channelId).catch(() => {})
      typingInterval = setInterval(() => {
        streamTarget.adapter.sendTyping?.(streamTarget.channelId).catch(() => {})
      }, 4000)
    }

    // Streaming: set up block chunker only if streamChunk config is enabled
    let chunker: BlockChunker | undefined
    const streamedChunks: string[] = []
    if (streamTarget && this.config.streamChunk) {
      chunker = new BlockChunker(
        (chunk) => {
          streamedChunks.push(chunk)
          streamTarget.adapter.sendMessage(streamTarget.channelId, chunk).catch((err) => {
            console.error('[AgentGateway] Stream chunk send failed:', err.message)
          })
        },
        this.config.streamChunk,
      )
    }

    // UI stream writer: track current text/reasoning blocks for delta streaming
    let uiTextId: string | null = null
    let uiReasoningId: string | null = null
    let pendingToolkitError: string | null = null

    // Gate map: onBeforeToolCall stores a promise per toolCallId that
    // resolves once the tool-input-start SSE events have had time to
    // flush to the client.  onAfterToolCall awaits this promise before
    // writing tool-output events, preventing React from batching all
    // tool events into a single render that skips the loading state.
    const toolFlushGates = new Map<string, Promise<void>>()

    // Canvas streaming: track active parsers and which tool calls already
    // sent their tool-input-start via the streaming path.
    const canvasParsers = new Map<string, CanvasStreamParser>()
    const streamedToolCalls = new Set<string>()

    try {
      const hookEmitter = this.hookEmitter
      const result = await runAgentLoop({
        provider,
        model: modelId,
        system: systemPrompt,
        history,
        prompt,
        images,
        tools,
        maxIterations: 50,
        loopDetection: this.config.loopDetection,
        streamFn: this._streamFn,
        thinkingLevel: 'medium',
        onToolCall: (name, input) => {
          console.log(`[AgentGateway] Tool call: ${name}`, JSON.stringify(input).substring(0, 200))
        },
        onThinkingStart: () => {
          if (uiWriter) {
            uiReasoningId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            uiWriter.write({ type: 'reasoning-start', id: uiReasoningId })
          }
        },
        onThinkingDelta: (delta) => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-delta', id: uiReasoningId, delta })
          }
        },
        onThinkingEnd: () => {
          if (uiWriter && uiReasoningId) {
            uiWriter.write({ type: 'reasoning-end', id: uiReasoningId })
            uiReasoningId = null
          }
        },
        onTextDelta: (delta) => {
          if (chunker) chunker.push(delta)
          if (uiWriter) {
            if (!uiTextId) {
              uiTextId = `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              uiWriter.write({ type: 'text-start', id: uiTextId })
            }
            uiWriter.write({ type: 'text-delta', id: uiTextId, delta })
          }
        },
        onToolCallStart: (toolName, toolCallId) => {
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            streamedToolCalls.add(toolCallId)
          }
          if (toolName === 'canvas_update') {
            const manager = getDynamicAppManager()
            const parser = new CanvasStreamParser({
              onSurfaceId: () => {},
              onComponents: (components) => {
                const sid = parser.getSurfaceId()
                if (sid) {
                  manager.streamPreviewComponents(sid, components as any)
                  if (uiWriter) {
                    uiWriter.write({
                      type: 'data-canvas-preview',
                      data: { surfaceId: sid, components },
                    } as any)
                  }
                }
              },
            })
            canvasParsers.set(toolCallId, parser)
          }
        },
        onToolCallDelta: (toolName, delta, toolCallId) => {
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: delta })
          }
          const parser = canvasParsers.get(toolCallId)
          if (parser) {
            parser.feed(delta)
          }
        },
        onToolCallEnd: (_toolName, toolCallId) => {
          canvasParsers.delete(toolCallId)
        },
        onBeforeToolCall: async (toolName, args, toolCallId) => {
          if (uiWriter && uiTextId) {
            uiWriter.write({ type: 'text-end', id: uiTextId })
            uiTextId = null
          }
          if (uiWriter && !streamedToolCalls.has(toolCallId)) {
            uiWriter.write({ type: 'tool-input-start', toolCallId, toolName, dynamic: true })
            uiWriter.write({ type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(args) })
          }
          streamedToolCalls.delete(toolCallId)
          // Store a flush gate that resolves after a short delay, giving
          // the HTTP layer time to deliver the tool-input-start chunk to
          // the client before tool-output-available arrives.
          // NOTE: the pi-agent-core event system does NOT await this
          // callback before firing tool_execution_end, so onAfterToolCall
          // must explicitly await this gate.
          toolFlushGates.set(
            toolCallId,
            new Promise(resolve => setTimeout(resolve, 30)),
          )
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'before', sessionId, {
              toolName, args, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
        },
        onAfterToolCall: async (toolName, args, result, isError, toolCallId) => {
          // Wait for onBeforeToolCall's flush gate so the client receives
          // tool-input-start in a separate HTTP chunk before we send the output.
          const gate = toolFlushGates.get(toolCallId)
          if (gate) {
            await gate
            toolFlushGates.delete(toolCallId)
          }
          if (uiWriter) {
            uiWriter.write({ type: 'tool-input-available', toolCallId, toolName, input: args, dynamic: true })
            uiWriter.write({
              type: 'tool-output-available',
              toolCallId,
              output: isError ? { error: typeof result === 'string' ? result : JSON.stringify(result) } : (result ?? { success: true }),
            })

            if (isComposioTool(toolName) && !pendingToolkitError) {
              if (isError || hasErrorInResult(result)) {
                const toolkit = extractToolkitName(toolName)
                const rawStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')
                let cleanError = rawStr
                try { const p = JSON.parse(rawStr); if (p?.error) cleanError = String(p.error) } catch {}
                pendingToolkitError = toolkit
                const authError = isAuthError(cleanError)
                uiWriter.write({
                  type: 'data-tool-error',
                  id: `tool-err-${toolCallId}`,
                  data: { toolkitName: toolkit, error: toUserMessage(toolkit, cleanError), isAuthError: authError },
                } as any)
              }
            }
          }
          await hookEmitter.emit(
            HookEmitter.createEvent('tool', 'after', sessionId, {
              toolName, args, result, isError, toolCallId, workspaceDir: this.workspaceDir,
            })
          )
          if (!isError && toolName.startsWith('mcp_')) {
            try {
              getDynamicAppManager().handleToolCallInvalidation(toolName)
            } catch { /* non-critical */ }
          }
        },
        onAgentEnd: async (loopResult) => {
          await hookEmitter.emit(
            HookEmitter.createEvent('agent', 'end', sessionId, {
              iterations: loopResult.iterations,
              toolCallCount: loopResult.toolCalls.length,
              inputTokens: loopResult.inputTokens,
              outputTokens: loopResult.outputTokens,
              loopDetected: !!loopResult.loopBreak,
              workspaceDir: this.workspaceDir,
            })
          )
        },
      })

      // Flush any remaining buffered text
      chunker?.flush()
      chunker?.dispose()

      // Close any open UI text block
      if (uiWriter && uiTextId) {
        uiWriter.write({ type: 'text-end', id: uiTextId })
        uiTextId = null
      }

      // Store usage for callers (server.ts includes it in the `finish` event)
      this._lastTurnUsage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        iterations: result.iterations,
        toolCallCount: result.toolCalls.length,
      }

      if (result.loopBreak) {
        console.warn(
          `[AgentGateway] Loop detected in session ${sessionId}: ${result.loopBreak.pattern}`
        )
      }

      const totalInput = result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens
      if (result.toolCalls.length > 0) {
        console.log(
          `[AgentGateway] Agent turn: ${result.iterations} iterations, ${result.toolCalls.length} tool calls, ${totalInput}+${result.outputTokens} tokens (${result.cacheReadTokens} cached)`
        )
      }

      if (result.outputTokens === 0 && result.toolCalls.length === 0 && !isHeartbeat) {
        console.error(
          `[AgentGateway] Agent returned 0 tokens for session ${sessionId} — possible context corruption (${session.compactionCount} compactions, ${session.messages.length} messages)`
        )
        if (uiWriter) {
          uiWriter.write({
            type: 'error',
            errorText: 'I encountered an issue processing your message. Please try starting a new conversation.',
          } as any)
        }
      }

      // Store full messages (including tool calls and tool results) in the
      // session so subsequent turns have complete context about prior actions.
      this.sessionManager.addMessages(sessionId, ...result.newMessages)

      if (this.sessionManager.needsCompaction(session)) {
        const compactResult = await this.sessionManager.compact(sessionId)
        if (compactResult) {
          console.log(
            `[AgentGateway] Session ${sessionId} compacted: ${compactResult.messagesBefore} -> ${compactResult.messagesAfter} messages`
          )
        }
      }

      this.sessionManager.touch(sessionId)

      return result.text || 'HEARTBEAT_OK'
    } catch (error: any) {
      console.error('[AgentGateway] Agent turn failed:', error.message)
      chunker?.dispose()
      return 'HEARTBEAT_OK'
    } finally {
      if (typingInterval) clearInterval(typingInterval)
    }
  }

  private loadBootstrapContext(): string {
    const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md']
    const parts: string[] = []

    for (const filename of files) {
      const filepath = join(this.workspaceDir, filename)
      if (existsSync(filepath)) {
        const content = readFileSync(filepath, 'utf-8').trim()
        if (content) {
          parts.push(content)
        }
      }
    }

    const memoryPath = join(this.workspaceDir, 'MEMORY.md')
    if (existsSync(memoryPath)) {
      const memory = readFileSync(memoryPath, 'utf-8').trim()
      if (memory) {
        parts.push(`## Memory\n${memory}`)
      }
    }

    const now = new Date()
    parts.push([
      '## Current Context',
      `- Today: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- Year: ${now.getFullYear()}`,
      `- Timezone: ${this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      '',
      'When users mention dates without a year, default to the current or next occurrence (never a past date).',
    ].join('\n'))

    const installedToolsContext = this.buildInstalledToolsContext()
    if (installedToolsContext) {
      parts.push(installedToolsContext)
    }

    const uploadedFilesContext = this.buildUploadedFilesContext()
    if (uploadedFilesContext) {
      parts.push(uploadedFilesContext)
    }

    const personalityGuide = this.promptOverrides.get('personality_guide') ?? OPTIMIZED_PERSONALITY_GUIDE
    const toolPlanningGuide = this.promptOverrides.get('tool_planning_guide') ?? OPTIMIZED_TOOL_PLANNING_GUIDE
    const memoryGuide = this.promptOverrides.get('memory_guide') ?? OPTIMIZED_MEMORY_GUIDE
    const skillMatchingGuide = this.promptOverrides.get('skill_matching_guide') ?? OPTIMIZED_SKILL_MATCHING_GUIDE

    const activeMode = this.config.activeMode || 'none'
    // Inject mode-specific prompt sections
    if (activeMode === 'canvas') {
      parts.push(BASIC_CANVAS_TOOLS_GUIDE + BASIC_CANVAS_EXAMPLES)
    } else if (activeMode === 'app') {
      parts.push(`\n## App Mode — Custom Agent Interface

You are in app mode. The \`code_agent\` tool delegates to Claude Code, which builds a custom web interface for your agent capabilities.

**Key principles:**
- All code goes through \`code_agent\` — NEVER write app code directly with write_file.
- The app connects back to you via \`@shogo-ai/sdk/agent\` — it imports useAgentStatus, useAgentChat, useCanvasStream, and other hooks to communicate with your runtime.
- The app is your custom frontend, not a standalone product. It should surface your work, let the user control you, or provide rich interaction with your capabilities.
- Apps run on the same pod as you, so they use relative URLs (\`/agent/status\`, \`/agent/chat\`, etc.) with zero configuration.

**When to switch back:**
- User just wants to see your output quickly → switch to **canvas** (faster, declarative)
- User is just chatting or asking questions → switch to **none**
- The custom UI is built and deployed → stay in app mode for further iterations
`)
    } else if (activeMode === 'none') {
      parts.push(`\n## Visual Modes Available

You have two visual modes for surfacing your work to the user. Both exist to give visibility into and control over what you are doing.

**Canvas** (switch_mode → "canvas") — Your quick display panel. Use declarative components (metrics, charts, tables, lists) to show your work output, monitoring results, and status. Best when built-in components can express the content. Start here for most visual needs.

**App** (switch_mode → "app") — A custom-coded agent interface. Use when canvas components are too limiting and the user needs richer interaction, multi-page flows, or specialized visualizations. The app connects to you via \`@shogo-ai/sdk/agent\`. Delegate all code to \`code_agent\`.

**Default: start with canvas.** It's faster and keeps you in control. Escalate to app only when canvas components cannot express what's needed or the user explicitly asks for a custom app/interface.

Examples:
- "Show me what you found" → canvas
- "Build a monitoring dashboard" → canvas
- "Build a custom control panel for my agent" → app (complex UI)
- "I need a multi-page interface for reviewing your work" → app
`)
    }
    // Mode context injection
    parts.push(`\n## Current Mode\nActive visual mode: **${activeMode}**. Use switch_mode to change.\n`)
    parts.push(PERSONALITY_EVOLUTION_GUIDE_PREFIX + personalityGuide)
    parts.push(toolPlanningGuide)
    parts.push(this.promptOverrides.get('constraint_awareness_guide') ?? OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE)
    if (this.config.memoryEnabled !== false) {
      parts.push(memoryGuide)
    }
    parts.push(skillMatchingGuide)
    parts.push(this.promptOverrides.get('mcp_discovery_guide') ?? OPTIMIZED_MCP_DISCOVERY_GUIDE)

    if (this.permissionEngine) {
      parts.push([
        '## Security Permissions',
        '',
        'This agent runs with a security permission system. Some tool calls may be blocked or require user approval through a UI dialog (not through chat).',
        '- If a tool result says "Permission denied", the action is permanently blocked. Tell the user it is not available. Do NOT ask them to approve it.',
        '- If a tool result says the user "declined" an action, they already decided via the security dialog. Acknowledge it briefly and move on. Do NOT ask again or request confirmation in chat.',
        '- Never try to work around permission denials by re-running the same tool or asking the user to confirm in text.',
      ].join('\n'))
    }

    parts.push([
      '## CRITICAL: Error Notifications (MUST follow)',
      '',
      'You have a tool called `notify_user_error`. You MUST call it whenever:',
      '- A tool returns an error, 404, or access denied',
      '- You cannot complete the task the user asked for',
      '- An integration (GitHub, Slack, Google, etc.) is not working properly',
      '- You detect a configuration or permission issue the user needs to fix',
      '',
      'Usage: `notify_user_error({ title: "GitHub Access Error", message: "The repository CodeGlo/shogo-ai is private or not accessible. Your organization may have OAuth App restrictions enabled. Go to GitHub org Settings > Third-party access to approve." })`',
      '',
      'ALWAYS call notify_user_error BEFORE writing the error explanation in chat.',
      'The title should be short (e.g. "GitHub Access Error", "Slack Auth Expired").',
      'The message should explain what went wrong AND how to fix it.',
      'This shows a prominent toast notification that the user will not miss.',
    ].join('\n'))

    return parts.join('\n\n---\n\n')
  }

  /**
   * Build a context section listing currently installed tool integrations.
   * Included in the system prompt so the agent knows what's available
   * and can use installed tools directly without needing to discover them.
   */
  private buildInstalledToolsContext(): string | null {
    const servers = this.mcpClientManager.getServerInfo()
    if (servers.length === 0) return null

    const lines = [
      '## Installed Tools',
      '',
      'The following tool integrations are currently installed and available:',
      '',
    ]

    for (const server of servers) {
      const toolList = server.toolNames.length <= 8
        ? server.toolNames.join(', ')
        : server.toolNames.slice(0, 8).join(', ') + `, ... (+${server.toolNames.length - 8} more)`
      lines.push(`- **${server.name}** (${server.toolCount} tools): ${toolList}`)
    }

    lines.push('')
    lines.push('Use these tools directly — no need to search or install them. Use `tool_uninstall` to remove any you no longer need.')

    return lines.join('\n')
  }

  /**
   * Build a context section listing files the user has uploaded to files/.
   * Included in the system prompt so the agent knows what data is available
   * and can proactively use list_files/search_files/read_file to access it.
   */
  private buildUploadedFilesContext(): string | null {
    const filesDir = join(this.workspaceDir, 'files')
    if (!existsSync(filesDir)) return null

    try {
      const entries = this.walkUploadedFiles(filesDir, '')
      if (entries.length === 0) return null

      const lines = [
        '## Workspace Uploaded Files',
        '',
        'The user has uploaded the following files to the workspace `files/` directory.',
        'Use `list_files` to browse, `search_files` to search content, or `read_file` with path `files/<name>` to read them.',
        '',
      ]

      for (const entry of entries.slice(0, 50)) {
        const sizeStr = entry.size < 1024
          ? `${entry.size}B`
          : entry.size < 1024 * 1024
            ? `${Math.round(entry.size / 1024)}KB`
            : `${(entry.size / (1024 * 1024)).toFixed(1)}MB`
        lines.push(`- \`${entry.path}\` (${sizeStr})`)
      }

      if (entries.length > 50) {
        lines.push(`- ... and ${entries.length - 50} more files`)
      }

      return lines.join('\n')
    } catch {
      return null
    }
  }

  private walkUploadedFiles(
    dir: string,
    prefix: string,
  ): Array<{ path: string; size: number }> {
    const results: Array<{ path: string; size: number }> = []
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const absPath = join(dir, entry.name)
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          results.push(...this.walkUploadedFiles(absPath, relPath))
        } else {
          const stat = statSync(absPath)
          results.push({ path: relPath, size: stat.size })
        }
      }
    } catch {
      // Ignore permission or other errors
    }
    return results
  }

  // ---------------------------------------------------------------------------
  // Channel Management
  // ---------------------------------------------------------------------------

  async connectChannel(
    type: string,
    config: Record<string, string>
  ): Promise<void> {
    let adapter: ChannelAdapter

    switch (type) {
      case 'telegram': {
        const { TelegramAdapter } = await import('./channels/telegram')
        adapter = new TelegramAdapter(config)
        break
      }
      case 'discord': {
        const { DiscordAdapter } = await import('./channels/discord')
        adapter = new DiscordAdapter(config)
        break
      }
      case 'email': {
        const { EmailAdapter } = await import('./channels/email')
        adapter = new EmailAdapter()
        break
      }
      case 'slack': {
        const { SlackAdapter } = await import('./channels/slack')
        adapter = new SlackAdapter(config)
        break
      }
      case 'whatsapp': {
        const { WhatsAppAdapter } = await import('./channels/whatsapp')
        adapter = new WhatsAppAdapter(config)
        break
      }
      case 'webhook': {
        const { WebhookAdapter } = await import('./channels/webhook')
        adapter = new WebhookAdapter()
        break
      }
      case 'teams': {
        const { TeamsAdapter } = await import('./channels/teams')
        adapter = new TeamsAdapter(config)
        break
      }
      case 'webchat': {
        const { WebChatAdapter } = await import('./channels/webchat')
        adapter = new WebChatAdapter()
        break
      }
      default:
        throw new Error(`Unknown channel type: ${type}`)
    }

    adapter.onMessage((msg) => this.processMessage(msg))
    await adapter.connect(config)
    this.channels.set(type, adapter)
    console.log(`[AgentGateway] Connected channel: ${type}`)
  }

  getChannel(type: string): ChannelAdapter | undefined {
    return this.channels.get(type)
  }

  getMcpClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  async disconnectChannel(type: string): Promise<void> {
    const adapter = this.channels.get(type)
    if (adapter) {
      await adapter.disconnect()
      this.channels.delete(type)
      console.log(`[AgentGateway] Disconnected channel: ${type}`)
    }
  }

  private async deliverAlert(alertText: string): Promise<void> {
    for (const [type, adapter] of this.channels) {
      try {
        const status = adapter.getStatus()
        if (status.connected) {
          await adapter.sendMessage('default', `[HEARTBEAT ALERT]\n${alertText}`)
        }
      } catch (err: any) {
        console.error(`[AgentGateway] Failed to deliver alert via ${type}:`, err.message)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  private appendDailyMemory(entry: string): void {
    const date = new Date().toISOString().split('T')[0]
    const memoryDir = join(this.workspaceDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })

    const filepath = join(memoryDir, `${date}.md`)
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
    const line = `- [${timestamp}] ${entry}\n`

    try {
      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, 'utf-8')
        writeFileSync(filepath, existing + line, 'utf-8')
      } else {
        writeFileSync(filepath, `# ${date}\n\n${line}`, 'utf-8')
      }
    } catch (error: any) {
      console.error('[AgentGateway] Failed to write daily memory:', error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatus(): AgentStatus {
    // Hot-reload config so the UI always reflects the latest config.json
    this.reloadConfig()

    const channelStatuses: ChannelStatus[] = []
    for (const [type, adapter] of this.channels) {
      channelStatuses.push(adapter.getStatus())
    }

    // Merge skills from filesystem with skills declared in config.json
    const fsSkills = this.skills.map((s) => ({
      name: s.name,
      trigger: s.trigger,
      description: s.description,
    }))
    const fsSkillNames = new Set(fsSkills.map((s) => s.name))
    const configSkills = (this.configSkills ?? [])
      .filter((s: any) => s.name && !fsSkillNames.has(s.name))
      .map((s: any) => ({
        name: s.name,
        trigger: s.trigger || '',
        description: s.description || '',
      }))

    return {
      running: this.running,
      heartbeat: {
        enabled: this.config.heartbeatEnabled,
        intervalSeconds: this.config.heartbeatInterval,
        lastTick: this.lastHeartbeatTick?.toISOString() ?? null,
        quietHours: this.config.quietHours,
      },
      channels: channelStatuses,
      skills: [...fsSkills, ...configSkills],
      model: this.config.model,
      sessions: this.sessionManager.getAllStats(),
    }
  }

  reloadConfig(): void {
    const prevEnabled = this.config.heartbeatEnabled
    this.config = this.loadConfig()
    this.skills = loadSkills(join(this.workspaceDir, 'skills'))
    this.configSkills = this.loadConfigSkills()

  }

  private loadConfigSkills(): Array<{ name: string; trigger?: string; description?: string }> {
    const configPath = join(this.workspaceDir, 'config.json')
    if (!existsSync(configPath)) return []
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      return Array.isArray(raw.skills) ? raw.skills : []
    } catch {
      return []
    }
  }

  getHookEmitter(): HookEmitter {
    return this.hookEmitter
  }

  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  getMCPClientManager(): MCPClientManager {
    return this.mcpClientManager
  }

  getActiveMode(): VisualMode {
    return this.config.activeMode || 'none'
  }

  setActiveMode(mode: VisualMode): void {
    this.config.activeMode = mode
  }

  getAllowedModes(): VisualMode[] {
    return this.config.allowedModes || ['canvas', 'app', 'none']
  }

  /** Map of sessionId -> AbortController for cancelling in-progress agent turns */
  private turnAbortControllers = new Map<string, AbortController>()

  abortCurrentTurn(sessionId: string): boolean {
    const controller = this.turnAbortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.turnAbortControllers.delete(sessionId)
      return true
    }
    return false
  }
}
