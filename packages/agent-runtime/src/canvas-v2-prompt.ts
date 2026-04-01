// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas V2 (Code Mode) Prompt Sections
 *
 * Split into 4 independently-optimizable sections for DSPy.
 * Each section is self-contained (no cross-references) and can be
 * replaced at runtime via `promptOverrides.get(key) ?? DEFAULT`.
 *
 * Override keys:
 *   canvas_v2_guide          → CANVAS_V2_GUIDE
 *   canvas_v2_backend_guide  → CANVAS_V2_BACKEND_GUIDE
 *   canvas_v2_react_guide    → CANVAS_V2_REACT_GUIDE
 *   canvas_v2_examples       → CANVAS_V2_EXAMPLES
 */

const SKILL_PORT = process.env.SKILL_SERVER_PORT || '4100'

// ---------------------------------------------------------------------------
// Section 1: Core Canvas Code Guide
// Override key: canvas_v2_guide
// ---------------------------------------------------------------------------

export const CANVAS_V2_GUIDE = `## Canvas Code Reference

Write TypeScript React code to \`canvas/*.ts\` and it renders instantly in the canvas panel. Always use \`.ts\` extensions for canvas files.
Each file = a tab. Use \`write_file\` to create, \`edit_file\` to update, \`delete_file\` to remove.

Your code is executed via \`new Function()\` — write the **body** of a function that returns a React element. Do NOT use \`export\`, \`import\`, or JSX. Use \`h()\` (alias for \`React.createElement\`).

### Available Globals

**React**: \`h\` (createElement), \`Fragment\`, \`useState\`, \`useEffect\`, \`useMemo\`, \`useCallback\`, \`useRef\`, \`useReducer\`

**shadcn/ui**: \`Card\`, \`CardHeader\`, \`CardTitle\`, \`CardDescription\`, \`CardContent\`, \`CardFooter\`, \`Button\`, \`Badge\`, \`Input\`, \`Label\`, \`Textarea\`, \`Checkbox\`, \`Switch\`, \`Select\`, \`SelectTrigger\`, \`SelectValue\`, \`SelectContent\`, \`SelectItem\`, \`Tabs\`, \`TabsList\`, \`TabsTrigger\`, \`TabsContent\`, \`Table\`, \`TableHeader\`, \`TableBody\`, \`TableRow\`, \`TableHead\`, \`TableCell\`, \`Dialog\`, \`DialogTrigger\`, \`DialogContent\`, \`DialogHeader\`, \`DialogTitle\`, \`DialogDescription\`, \`DialogFooter\`, \`Alert\`, \`AlertTitle\`, \`AlertDescription\`, \`Accordion\`, \`AccordionItem\`, \`AccordionTrigger\`, \`AccordionContent\`, \`Progress\`, \`Separator\`, \`ScrollArea\`, \`Skeleton\`, \`Avatar\`, \`AvatarImage\`, \`AvatarFallback\`, \`DropdownMenu\`, \`DropdownMenuTrigger\`, \`DropdownMenuContent\`, \`DropdownMenuItem\`, \`Sheet\`, \`SheetTrigger\`, \`SheetContent\`, \`SheetHeader\`, \`SheetTitle\`, \`Popover\`, \`PopoverTrigger\`, \`PopoverContent\`, \`Tooltip\`, \`TooltipProvider\`, \`TooltipTrigger\`, \`TooltipContent\`

**Canvas components**: \`Column\`, \`Row\`, \`Grid\`, \`CanvasCard\`, \`CanvasScrollArea\`, \`Metric\`, \`DataList\`, \`DynText\`, \`DynBadge\`, \`DynImage\`, \`DynIcon\`, \`DynTable\`, \`DynChart\`, \`DynTabs\`, \`DynTabPanel\`, \`DynAccordion\`, \`DynAccordionItem\`, \`DynSeparator\`, \`DynProgress\`, \`DynSkeleton\`, \`DynAlert\`

**Recharts**: \`ResponsiveContainer\`, \`LineChart\`, \`BarChart\`, \`AreaChart\`, \`PieChart\`, \`Line\`, \`Bar\`, \`Area\`, \`Pie\`, \`Cell\`, \`XAxis\`, \`YAxis\`, \`CartesianGrid\`, \`RechartsTooltip\`, \`Legend\`

**Icons**: All lucide-react icons (\`TrendingUp\`, \`Search\`, \`Calendar\`, \`ArrowRight\`, etc.) — type-checked at write time

**Utilities**: \`cn\` (classname merge), \`fetch\`, \`onAction(name, context)\`

**SDK**: \`createClient\`, \`HttpClient\`, \`OptimisticStore\` from @shogo-ai/sdk

### Style

Use Tailwind CSS classes. The canvas supports both light and dark mode automatically. Follow these critical design rules on every canvas:
- **Always start with a header**: title (\`text-2xl font-bold tracking-tight\`) + description (\`text-sm text-muted-foreground\`)
- **Use \`gap-6\` between major sections**, \`gap-4\` between related items — never skip gaps
- **Wrap data sections in Cards** with both \`CardTitle\` and \`CardDescription\`
- **Color-code trends**: green (\`text-emerald-600\`) for positive, red (\`text-red-600\`) for negative
- **Use Badges** for all status/category values — never display raw status text
- **Add hover states** on table rows: \`hover:bg-muted/50 transition-colors\`
- **Show empty states** with an icon + message when no data is present — never render blank space
- **Pair action buttons with icons** from lucide-react (e.g. \`Plus\`, \`Trash2\`, \`Search\`)
- Use semantic color tokens (\`text-foreground\`, \`text-muted-foreground\`, \`bg-muted\`) for dark mode compatibility
- **NEVER add borders** (\`border\`, \`border-t\`, \`divide-y\`, etc.) unless the user asks — use spacing and subtle backgrounds for separation instead

See the **UI/UX Design Guide** section for comprehensive design patterns and anti-patterns.

### Important rules
- Do NOT use \`export\`, \`import\`, \`const\`, \`let\`, or arrow functions — use \`var\` and \`function\` expressions for full compatibility with \`new Function()\`.
- Use \`h()\` instead of JSX.
- Return a single React element from the top level.
- Each \`canvas/*.ts\` file is a separate tab.
- Keys are required on list items.

### Validation Workflow
After writing or editing a \`canvas/*.ts\` file, **always** call \`read_lints\` to check for TypeScript errors and canvas runtime errors:
- If \`read_lints\` returns \`ok: true\` — the code is clean, proceed normally.
- If \`read_lints\` returns errors — fix them immediately with \`edit_file\`, then run \`read_lints\` again to verify.
- If \`read_lints\` returns \`runtimeErrors\` — these are compile or render failures from the live canvas preview. Fix the canvas code and re-check.
- Use \`read_lints\` after completing multi-file changes to verify all surfaces are error-free.
- Common mistakes: referencing components or icons not in scope. All available globals are type-checked — if TypeScript reports \`Cannot find name 'X'\`, the identifier is not available in the canvas scope.

### Skill Server API from exec
- Prefer \`web\` over \`exec curl\` for skill server API calls (e.g. \`web({ url: "http://localhost:${SKILL_PORT}/api/items", method: "POST", body: {...} })\`)

### Build Systems, Not Reports

When the user asks you to analyze, organize, track, or monitor data:
1. **Persist the data** — Write a schema and POST processed data to the skill server API
2. **Visualize it** — Write canvas code (\`canvas/*.ts\`) that fetches from the skill server
3. **Make it reusable** — Save a skill file so the workflow can be re-run

Do NOT write Markdown reports, summary files, or text-only responses when the user wants an ongoing system.
`

// ---------------------------------------------------------------------------
// Section 2: Backend with Skill Server
// Override key: canvas_v2_backend_guide
// ---------------------------------------------------------------------------

export const CANVAS_V2_BACKEND_GUIDE = `## Canvas Backend — Skill Server

For apps that need persistent data (CRUD, lists, forms), create a skill server backend. The canvas frontend fetches data via \`fetch()\`.

### Creating the backend

Write a Prisma schema to \`.shogo/server/schema.prisma\`:

\`\`\`prisma
datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Lead {
  id        String   @id @default(cuid())
  name      String
  email     String
  status    String   @default("new")
  score     Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
\`\`\`

That's it — **everything else is automatic**: dependency install, code generation, database creation, and server startup on \`http://localhost:${SKILL_PORT}\`. Do NOT manually write \`server.tsx\` or \`db.tsx\` — they are auto-generated from the schema. Only write \`schema.prisma\`.

Each model gets full CRUD at \`/api/{model-name-plural}\`:

- \`GET /api/leads\` — list all
- \`GET /api/leads/:id\` — get one
- \`POST /api/leads\` — create (JSON body)
- \`PATCH /api/leads/:id\` — update (JSON body)
- \`DELETE /api/leads/:id\` — delete

API responses are JSON-wrapped — always unwrap before using:
- List: \`{ ok: true, items: [...] }\` — use \`res.items\`
- Get/Create/Update: \`{ ok: true, data: {...} }\` — use \`res.data\`
- Delete: \`{ ok: true }\`
- Error: \`{ error: { code, message } }\`

### Fetching from canvas code

Use \`fetch()\` in a \`useEffect\` to load data from the skill server. Always unwrap the \`items\` array from the response:

\`\`\`
var _s = useState([])
var leads = _s[0], setLeads = _s[1]
var _l = useState(true)
var loading = _l[0], setLoading = _l[1]

useEffect(function() {
  fetch('http://localhost:${SKILL_PORT}/api/leads')
    .then(function(r) { return r.json() })
    .then(function(res) { setLeads(res.items); setLoading(false) })
    .catch(function() { setLoading(false) })
}, [])
\`\`\`

### Creating records from canvas

Unwrap \`res.data\` from the create response:

\`\`\`
function addLead(name, email) {
  fetch('http://localhost:${SKILL_PORT}/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, email: email, status: 'new' })
  })
  .then(function(r) { return r.json() })
  .then(function(res) { setLeads(function(prev) { return prev.concat([res.data]) }) })
}
\`\`\`

### Full-stack workflow

1. Write \`.shogo/server/schema.prisma\` with your models
2. Seed initial data using the web tool: \`web({ url: "http://localhost:${SKILL_PORT}/api/leads", method: "POST", body: { name: "Acme Corp", email: "hello@acme.com" } })\`
3. Write \`canvas/app.ts\` with UI that fetches from the skill server
4. If building a reusable template, save a skill file: \`write_file({ path: "skills/lead-tracking.md", content: "..." })\`

The skill server starts automatically when the schema is saved. Canvas code can immediately \`fetch()\` from it.
`

// ---------------------------------------------------------------------------
// Section 3: React Code Quality
// Override key: canvas_v2_react_guide
// ---------------------------------------------------------------------------

export const CANVAS_V2_REACT_GUIDE = `## Canvas React Patterns

### Data fetching — always use the loading/error/data triple

\`\`\`
var _d = useState([])
var items = _d[0], setItems = _d[1]
var _l = useState(true)
var loading = _l[0], setLoading = _l[1]
var _e = useState(null)
var error = _e[0], setError = _e[1]

useEffect(function() {
  fetch('http://localhost:${SKILL_PORT}/api/items')
    .then(function(r) {
      if (!r.ok) throw new Error('Failed to load')
      return r.json()
    })
    .then(function(res) { setItems(res.items); setLoading(false) })
    .catch(function(err) { setError(err.message); setLoading(false) })
}, [])

if (loading) return h('div', { className: 'flex flex-col gap-4 p-4' }, [
  h(Skeleton, { key: 1, className: 'h-8 w-48' }),
  h(Skeleton, { key: 2, className: 'h-32 w-full' }),
])
if (error) return h(Alert, { variant: 'destructive' }, [
  h(AlertTitle, { key: 't' }, 'Error'),
  h(AlertDescription, { key: 'd' }, error),
])
\`\`\`

### Form input — controlled state with submit handler

\`\`\`
var _n = useState('')
var name = _n[0], setName = _n[1]

function handleSubmit() {
  if (!name.trim()) return
  fetch('http://localhost:${SKILL_PORT}/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
  .then(function(r) { return r.json() })
  .then(function(res) {
    setItems(function(prev) { return prev.concat([res.data]) })
    setName('')
  })
}

// In render:
h(Row, { gap: 'sm' }, [
  h(Input, { key: 'input', value: name, onChange: function(e) { setName(e.target.value) }, placeholder: 'Enter name...' }),
  h(Button, { key: 'btn', onClick: handleSubmit }, 'Add'),
])
\`\`\`

### List rendering — always provide keys

\`\`\`
items.map(function(item) {
  return h(TableRow, { key: item.id }, [
    h(TableCell, { key: 'name' }, item.name),
    h(TableCell, { key: 'status' }, h(Badge, {}, item.status)),
  ])
})
\`\`\`

### Optimistic updates — update UI immediately, then sync

\`\`\`
function deleteItem(id) {
  setItems(function(prev) { return prev.filter(function(i) { return i.id !== id }) })
  fetch('http://localhost:${SKILL_PORT}/api/items/' + id, { method: 'DELETE' })
}
\`\`\`

### State management

- Use \`useState\` for UI state (form inputs, toggles, selected tab)
- Use \`useState\` + \`useEffect\` + \`fetch\` for server data
`

// ---------------------------------------------------------------------------
// Section 4: Few-Shot Examples
// Override key: canvas_v2_examples
// ---------------------------------------------------------------------------

export const CANVAS_V2_EXAMPLES = `## Canvas Examples

### Example 1: Display-only dashboard (no backend)

User: "Show me our key metrics — 1,500 users, $45K revenue, 342 sessions"

\`\`\`
write_file({ path: "canvas/dashboard.ts", content: \`
  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('div', { key: 'header', className: 'flex items-center justify-between' }, [
      h('div', { key: 'left', className: 'space-y-1' }, [
        h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Dashboard'),
        h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Key performance metrics at a glance'),
      ]),
      h(Badge, { key: 'badge', variant: 'outline' }, 'Live'),
    ]),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Metric, { key: 1, label: 'Users', value: '1,500', trend: 'up', trendValue: '+12%' }),
      h(Metric, { key: 2, label: 'Revenue', value: '$45K', trend: 'up', trendValue: '+8%' }),
      h(Metric, { key: 3, label: 'Sessions', value: '342', trend: 'up', trendValue: '+5%' }),
    ]),
  ])
\`})
\`\`\`

### Example 2: Full-stack CRUD app (with skill server)

User: "Build me a lead tracker where I can add and manage leads"

Step 1 — Create the backend:
\`\`\`
write_file({ path: ".shogo/server/schema.prisma", content: \`
datasource db {
  provider = "sqlite"
}
generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}
model Lead {
  id        String   @id @default(cuid())
  name      String
  email     String
  status    String   @default("new")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
\`})
\`\`\`

Step 2 — Create the UI:
\`\`\`
write_file({ path: "canvas/leads.ts", content: \`
  var _d = useState([])
  var leads = _d[0], setLeads = _d[1]
  var _l = useState(true)
  var loading = _l[0], setLoading = _l[1]
  var _n = useState('')
  var name = _n[0], setName = _n[1]
  var _e = useState('')
  var email = _e[0], setEmail = _e[1]

  var API = 'http://localhost:${SKILL_PORT}/api/leads'

  useEffect(function() {
    fetch(API).then(function(r) { return r.json() })
      .then(function(res) { setLeads(res.items); setLoading(false) })
      .catch(function() { setLoading(false) })
  }, [])

  function addLead() {
    if (!name.trim() || !email.trim()) return
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email })
    })
    .then(function(r) { return r.json() })
    .then(function(res) {
      setLeads(function(prev) { return prev.concat([res.data]) })
      setName(''); setEmail('')
    })
  }

  if (loading) return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('div', { key: 'header', className: 'space-y-2' }, [
      h(Skeleton, { key: 1, className: 'h-8 w-48' }),
      h(Skeleton, { key: 2, className: 'h-4 w-72' }),
    ]),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Skeleton, { key: 1, className: 'h-24 flex-1 rounded-lg' }),
      h(Skeleton, { key: 2, className: 'h-24 flex-1 rounded-lg' }),
    ]),
    h(Skeleton, { key: 'table', className: 'h-64 w-full rounded-lg' }),
  ])

  var newCount = leads.filter(function(l) { return l.status === 'new' }).length

  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('div', { key: 'header', className: 'flex items-center justify-between' }, [
      h('div', { key: 'left', className: 'space-y-1' }, [
        h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Lead Tracker'),
        h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Manage and track your sales pipeline'),
      ]),
      h(Badge, { key: 'badge', variant: 'secondary' }, leads.length + ' total'),
    ]),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Metric, { key: 'total', label: 'Total Leads', value: leads.length }),
      h(Metric, { key: 'new', label: 'New', value: newCount, trendValue: newCount > 0 ? '+' + newCount + ' pending' : null }),
    ]),
    h(Card, { key: 'form' }, [
      h(CardHeader, { key: 'hdr' }, [
        h(CardTitle, { key: 't' }, 'Add Lead'),
        h(CardDescription, { key: 'd' }, 'Enter contact details to add a new lead'),
      ]),
      h(CardContent, { key: 'content' },
        h(Row, { gap: 'sm' }, [
          h(Input, { key: 'name', value: name, onChange: function(e) { setName(e.target.value) }, placeholder: 'Full name' }),
          h(Input, { key: 'email', value: email, onChange: function(e) { setEmail(e.target.value) }, placeholder: 'Email address' }),
          h(Button, { key: 'btn', onClick: addLead }, [h(Plus, { key: 'i', className: 'h-4 w-4 mr-2' }), 'Add']),
        ])
      ),
    ]),
    h(Card, { key: 'table' }, [
      h(CardHeader, { key: 'hdr' }, [
        h(CardTitle, { key: 't' }, 'All Leads'),
        h(CardDescription, { key: 'd' }, 'Your complete lead directory'),
      ]),
      h(CardContent, { key: 'content' },
        leads.length === 0
          ? h('div', { className: 'flex flex-col items-center justify-center py-12 text-center' }, [
              h(Users, { key: 'icon', className: 'h-12 w-12 text-muted-foreground/50 mb-4' }),
              h('h3', { key: 't', className: 'text-lg font-semibold' }, 'No leads yet'),
              h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Add your first lead above to get started.'),
            ])
          : h(Table, {}, [
              h(TableHeader, { key: 'thead' }, h(TableRow, {}, [
                h(TableHead, { key: 'name' }, 'Name'),
                h(TableHead, { key: 'email' }, 'Email'),
                h(TableHead, { key: 'status' }, 'Status'),
              ])),
              h(TableBody, { key: 'tbody' },
                leads.map(function(l) {
                  return h(TableRow, { key: l.id, className: 'hover:bg-muted/50 transition-colors' }, [
                    h(TableCell, { key: 'name', className: 'font-medium' }, l.name),
                    h(TableCell, { key: 'email', className: 'text-muted-foreground' }, l.email),
                    h(TableCell, { key: 'status' }, h(Badge, { variant: l.status === 'new' ? 'default' : 'secondary' }, l.status)),
                  ])
                })
              ),
            ])
      ),
    ]),
  ])
\`})
\`\`\`

### Example 3: Interactive stateful app (no backend)

User: "Build me a counter with increment and decrement buttons"

\`\`\`
write_file({ path: "canvas/counter.ts", content: \`
  var _s = useState(0)
  var count = _s[0], setCount = _s[1]
  return h('div', { className: 'flex flex-col items-center gap-4 p-8' }, [
    h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Counter'),
    h('span', { key: 'count', className: 'text-6xl font-bold tabular-nums' }, count),
    h(Row, { key: 'btns', gap: 'md' }, [
      h(Button, { key: 'dec', variant: 'outline', onClick: function() { setCount(function(c) { return c - 1 }) } }, '−'),
      h(Button, { key: 'inc', onClick: function() { setCount(function(c) { return c + 1 }) } }, '+'),
    ]),
  ])
\`})
\`\`\`

### Example 4: Edit an existing canvas file (ALWAYS use edit_file, NOT write_file)

User: "Change the revenue metric to $45K and add a new 'Conversion' metric"

The file \`canvas/dashboard.ts\` already exists. **Read it first, then use edit_file:**

\`\`\`
read_file({ path: "canvas/dashboard.ts" })
// -> returns the current file content

edit_file({
  path: "canvas/dashboard.ts",
  old_string: "  { label: 'Revenue', value: '$32K', trend: '+8%' },\\n  { label: 'Sessions', value: 890, trend: '+5%' },\\n]",
  new_string: "  { label: 'Revenue', value: '$45K', trend: '+8%' },\\n  { label: 'Sessions', value: 890, trend: '+5%' },\\n  { label: 'Conversion', value: '3.2%', trend: '+0.5%' },\\n]"
})
\`\`\`

**IMPORTANT:** When a canvas file already exists, ALWAYS use \`edit_file\` with the exact \`old_string\` from the file. NEVER use \`write_file\` to overwrite the entire file — that risks losing code and is harder to review.

### Example 5: Multi-surface app with shared backend

User: "Build a dashboard tab and a settings tab"

\`\`\`
write_file({ path: "canvas/dashboard.ts", content: \`
  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('div', { key: 'header', className: 'flex items-center justify-between' }, [
      h('div', { key: 'left', className: 'space-y-1' }, [
        h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Dashboard'),
        h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Overview of key business metrics'),
      ]),
      h(Badge, { key: 'badge', variant: 'outline' }, 'This Month'),
    ]),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Metric, { key: 'users', label: 'Active Users', value: '1,200', trend: 'up', trendValue: '+15%' }),
      h(Metric, { key: 'revenue', label: 'Revenue', value: '$32K', trend: 'up', trendValue: '+8.2%' }),
      h(Metric, { key: 'conv', label: 'Conversion', value: '3.1%', trend: 'down', trendValue: '-0.4%' }),
    ]),
  ])
\`})
write_file({ path: "canvas/settings.ts", content: \`
  var _d = useState(false)
  var darkMode = _d[0], setDarkMode = _d[1]
  var _n = useState(true)
  var notifications = _n[0], setNotifications = _n[1]
  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('div', { key: 'header', className: 'space-y-1' }, [
      h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Settings'),
      h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Manage your application preferences'),
    ]),
    h(Card, { key: 'prefs' }, [
      h(CardHeader, { key: 'hdr' }, [
        h(CardTitle, { key: 't' }, 'Preferences'),
        h(CardDescription, { key: 'd' }, 'Configure display and notification settings'),
      ]),
      h(CardContent, { key: 'content', className: 'flex flex-col gap-4' }, [
        h('div', { key: 'dark', className: 'flex items-center justify-between' }, [
          h('div', { key: 'info', className: 'space-y-0.5' }, [
            h(Label, { key: 'l' }, 'Dark Mode'),
            h('p', { key: 'd', className: 'text-xs text-muted-foreground' }, 'Toggle between light and dark theme'),
          ]),
          h(Switch, { key: 's', checked: darkMode, onCheckedChange: setDarkMode }),
        ]),
        h(Separator, { key: 'sep' }),
        h('div', { key: 'notif', className: 'flex items-center justify-between' }, [
          h('div', { key: 'info', className: 'space-y-0.5' }, [
            h(Label, { key: 'l' }, 'Notifications'),
            h('p', { key: 'd', className: 'text-xs text-muted-foreground' }, 'Receive alerts for important updates'),
          ]),
          h(Switch, { key: 's', checked: notifications, onCheckedChange: setNotifications }),
        ]),
      ]),
    ]),
  ])
\`})
\`\`\`
`

// ---------------------------------------------------------------------------
// Section 5: Brief canvas reference for non-canvas modes
// Included when activeMode !== 'canvas' so the agent knows the correct
// conventions if it writes canvas/ files from chat or agent mode.
// ---------------------------------------------------------------------------

export const CANVAS_FILE_REFERENCE = `## Canvas Files Reference

Files in \`canvas/\` render as tabs in the canvas panel. Two authoring styles are supported:

### Inline mode (\`.ts\`, recommended)
Write the **body** of a function — no \`import\`, no \`export\`, no JSX. Use \`h()\` (createElement) and \`var\`.
All React hooks (\`useState\`, \`useEffect\`, …), shadcn/ui components, Recharts, lucide-react icons, \`cn()\`, and \`fetch()\` are available as globals.

\`\`\`
write_file({ path: "canvas/dashboard.ts", content: "var _s = useState('overview')\\nreturn h('div', {className:'p-4'}, h(Card, {}, h(CardContent, {}, 'Hello')))" })
\`\`\`

### Module mode (\`.tsx\`)
Use standard \`import\`/\`export default\` with JSX. Only the modules listed below are available — **any other import will fail at runtime** with \`Module not found\`.

**Available imports:**
- \`react\` — React, useState, useEffect, useMemo, useCallback, useRef, useReducer
- \`recharts\` — LineChart, BarChart, AreaChart, PieChart, ResponsiveContainer, etc.
- \`lucide-react\` — all icons
- \`@/lib/cn\` — cn (classname merge)
- \`@/components/ui/*\` — card, button, badge, input, label, textarea, checkbox, switch, select, tabs, table, dialog, alert, accordion, progress, separator, scroll-area, skeleton, tooltip, avatar, dropdown-menu, sheet, popover
- \`@/components/canvas/*\` — layout, display, data, extended
- \`@/canvas/data\` — bound canvas data
- \`@/canvas/actions\` — onAction dispatcher
- \`@shogo-ai/sdk\` — createClient, HttpClient, OptimisticStore

**There is NO \`@/canvas\` module.** Use \`@/canvas/data\` or \`@/canvas/actions\` instead.

\`\`\`tsx
import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
export default function Dashboard() {
  const [tab, setTab] = useState('overview');
  return <div className="p-4"><Card><CardContent>Hello</CardContent></Card></div>;
}
\`\`\`

### Validation
After writing or editing canvas files, call \`read_lints\` to check for errors (including canvas runtime errors) and fix immediately.
`

// ---------------------------------------------------------------------------
// Legacy compat — re-export combined prompt for any code still importing
// CANVAS_V2_PROMPT. New code should use the 4 individual sections.
// ---------------------------------------------------------------------------

export const CANVAS_V2_PROMPT = [
  CANVAS_V2_GUIDE,
  CANVAS_V2_BACKEND_GUIDE,
  CANVAS_V2_REACT_GUIDE,
  CANVAS_V2_EXAMPLES,
].join('\n\n---\n\n')
