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

// ---------------------------------------------------------------------------
// Section 1: Core Canvas Code Guide
// Override key: canvas_v2_guide
// ---------------------------------------------------------------------------

export const CANVAS_V2_GUIDE = `## Canvas Code Reference

Write React code to \`canvas/*.js\` and it renders instantly in the canvas panel.
Each file = a tab. Use \`write_file\` to create, \`edit_file\` to update, \`delete_file\` to remove.

Your code is executed via \`new Function()\` — write the **body** of a function that returns a React element. Do NOT use \`export\`, \`import\`, or JSX. Use \`h()\` (alias for \`React.createElement\`).

### Available Globals

**React**: \`h\` (createElement), \`Fragment\`, \`useState\`, \`useEffect\`, \`useMemo\`, \`useCallback\`, \`useRef\`, \`useReducer\`

**shadcn/ui**: \`Card\`, \`CardHeader\`, \`CardTitle\`, \`CardDescription\`, \`CardContent\`, \`CardFooter\`, \`Button\`, \`Badge\`, \`Input\`, \`Label\`, \`Textarea\`, \`Checkbox\`, \`Switch\`, \`Select\`, \`SelectTrigger\`, \`SelectValue\`, \`SelectContent\`, \`SelectItem\`, \`Tabs\`, \`TabsList\`, \`TabsTrigger\`, \`TabsContent\`, \`Table\`, \`TableHeader\`, \`TableBody\`, \`TableRow\`, \`TableHead\`, \`TableCell\`, \`Dialog\`, \`DialogTrigger\`, \`DialogContent\`, \`DialogHeader\`, \`DialogTitle\`, \`DialogDescription\`, \`DialogFooter\`, \`Alert\`, \`AlertTitle\`, \`AlertDescription\`, \`Accordion\`, \`AccordionItem\`, \`AccordionTrigger\`, \`AccordionContent\`, \`Progress\`, \`Separator\`, \`ScrollArea\`, \`Skeleton\`, \`Avatar\`, \`AvatarImage\`, \`AvatarFallback\`, \`DropdownMenu\`, \`DropdownMenuTrigger\`, \`DropdownMenuContent\`, \`DropdownMenuItem\`, \`Sheet\`, \`SheetTrigger\`, \`SheetContent\`, \`SheetHeader\`, \`SheetTitle\`, \`Popover\`, \`PopoverTrigger\`, \`PopoverContent\`, \`Tooltip\`, \`TooltipProvider\`, \`TooltipTrigger\`, \`TooltipContent\`

**Canvas components**: \`Column\`, \`Row\`, \`Grid\`, \`CanvasCard\`, \`CanvasScrollArea\`, \`Metric\`, \`DataList\`, \`DynText\`, \`DynBadge\`, \`DynImage\`, \`DynIcon\`, \`DynTable\`, \`DynChart\`, \`DynTabs\`, \`DynTabPanel\`, \`DynAccordion\`, \`DynAccordionItem\`, \`DynSeparator\`, \`DynProgress\`, \`DynSkeleton\`, \`DynAlert\`

**Recharts**: \`ResponsiveContainer\`, \`LineChart\`, \`BarChart\`, \`AreaChart\`, \`PieChart\`, \`Line\`, \`Bar\`, \`Area\`, \`Pie\`, \`Cell\`, \`XAxis\`, \`YAxis\`, \`CartesianGrid\`, \`RechartsTooltip\`, \`Legend\`

**Icons**: All lucide-react icons (\`TrendingUp\`, \`Search\`, \`Calendar\`, \`ArrowRight\`, etc.) — type-checked at write time

**Utilities**: \`cn\` (classname merge), \`fetch\`, \`data\` (parsed from canvas/<name>.data.json), \`onAction(name, context)\`

**SDK**: \`createClient\`, \`HttpClient\`, \`OptimisticStore\` from @shogo-ai/sdk

### Data

Write JSON to \`canvas/<name>.data.json\` — available as \`data\` in your code.
Or use \`fetch()\` inside \`useEffect\` to load data from any API.

### Style

Use Tailwind CSS classes. The canvas supports both light and dark mode automatically.

### Important rules
- Do NOT use \`export\`, \`import\`, \`const\`, \`let\`, or arrow functions — use \`var\` and \`function\` expressions for full compatibility with \`new Function()\`.
- Use \`h()\` instead of JSX.
- Return a single React element from the top level.
- Each \`canvas/*.js\` file is a separate tab.
- Keys are required on list items.

### Validation Workflow
When you \`write_file\` or \`edit_file\` a \`canvas/*.js\` file, the tool result will include \`canvas_lint\` feedback:
- If \`canvas_lint.ok\` is \`true\` — the code is clean, proceed normally.
- If \`canvas_lint.ok\` is \`false\` — the \`canvas_lint.errors\` array lists TypeScript errors (e.g. \`Cannot find name 'RefreshCw'\`). **You must fix these errors immediately** with \`edit_file\` before responding to the user.
- Use \`canvas_lint\` tool after completing multi-file changes to verify all surfaces are error-free.
- Common mistakes: referencing components or icons not in scope. All available globals are type-checked — if TypeScript reports \`Cannot find name 'X'\`, the identifier is not available in the canvas scope.
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

That's it — **everything else is automatic**: dependency install, code generation, database creation, and server startup on \`http://localhost:4100\`. Each model gets full CRUD at \`/api/{model-name-plural}\`:

- \`GET /api/leads\` — list all
- \`GET /api/leads/:id\` — get one
- \`POST /api/leads\` — create (JSON body)
- \`PATCH /api/leads/:id\` — update (JSON body)
- \`DELETE /api/leads/:id\` — delete

### Fetching from canvas code

Use \`fetch()\` in a \`useEffect\` to load data from the skill server:

\`\`\`
var _s = useState([])
var leads = _s[0], setLeads = _s[1]
var _l = useState(true)
var loading = _l[0], setLoading = _l[1]

useEffect(function() {
  fetch('http://localhost:4100/api/leads')
    .then(function(r) { return r.json() })
    .then(function(data) { setLeads(data); setLoading(false) })
    .catch(function() { setLoading(false) })
}, [])
\`\`\`

### Creating records from canvas

\`\`\`
function addLead(name, email) {
  fetch('http://localhost:4100/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, email: email, status: 'new' })
  })
  .then(function(r) { return r.json() })
  .then(function(newLead) { setLeads(function(prev) { return prev.concat([newLead]) }) })
}
\`\`\`

### Full-stack workflow

1. Write \`.shogo/server/schema.prisma\` with your models
2. Write \`canvas/app.js\` with UI that fetches from the skill server
3. Optionally write \`canvas/app.data.json\` for static config

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
  fetch('http://localhost:4100/api/items')
    .then(function(r) {
      if (!r.ok) throw new Error('Failed to load')
      return r.json()
    })
    .then(function(data) { setItems(data); setLoading(false) })
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
  fetch('http://localhost:4100/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
  .then(function(r) { return r.json() })
  .then(function(item) {
    setItems(function(prev) { return prev.concat([item]) })
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
  fetch('http://localhost:4100/api/items/' + id, { method: 'DELETE' })
}
\`\`\`

### State management

- Use \`useState\` for UI state (form inputs, toggles, selected tab)
- Use \`useState\` + \`useEffect\` + \`fetch\` for server data
- Use \`canvas/*.data.json\` (\`data\` global) for static configuration that doesn't change at runtime
`

// ---------------------------------------------------------------------------
// Section 4: Few-Shot Examples
// Override key: canvas_v2_examples
// ---------------------------------------------------------------------------

export const CANVAS_V2_EXAMPLES = `## Canvas Examples

### Example 1: Display-only dashboard (no backend)

User: "Show me our key metrics — 1,500 users, $45K revenue, 342 sessions"

\`\`\`
write_file({ path: "canvas/dashboard.js", content: \`
  var metrics = [
    { label: 'Users', value: '1,500', trend: '+12%' },
    { label: 'Revenue', value: '$45K', trend: '+8%' },
    { label: 'Sessions', value: '342', trend: '+5%' },
  ]
  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('h2', { className: 'text-2xl font-semibold' }, 'Dashboard'),
    h(Row, { gap: 'md' },
      metrics.map(function(m, i) {
        return h(Metric, { key: i, label: m.label, value: m.value, trend: 'up', trendValue: m.trend })
      })
    ),
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
write_file({ path: "canvas/leads.js", content: \`
  var _d = useState([])
  var leads = _d[0], setLeads = _d[1]
  var _l = useState(true)
  var loading = _l[0], setLoading = _l[1]
  var _n = useState('')
  var name = _n[0], setName = _n[1]
  var _e = useState('')
  var email = _e[0], setEmail = _e[1]

  var API = 'http://localhost:4100/api/leads'

  useEffect(function() {
    fetch(API).then(function(r) { return r.json() })
      .then(function(data) { setLeads(data); setLoading(false) })
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
    .then(function(lead) {
      setLeads(function(prev) { return prev.concat([lead]) })
      setName(''); setEmail('')
    })
  }

  if (loading) return h('div', { className: 'p-4 space-y-3' }, [
    h(Skeleton, { key: 1, className: 'h-8 w-48' }),
    h(Skeleton, { key: 2, className: 'h-64 w-full' }),
  ])

  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Lead Tracker'),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Metric, { key: 'total', label: 'Total Leads', value: leads.length }),
      h(Metric, { key: 'new', label: 'New', value: leads.filter(function(l) { return l.status === 'new' }).length }),
    ]),
    h(Card, { key: 'form' }, [
      h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'Add Lead')),
      h(CardContent, { key: 'content' },
        h(Row, { gap: 'sm' }, [
          h(Input, { key: 'name', value: name, onChange: function(e) { setName(e.target.value) }, placeholder: 'Name' }),
          h(Input, { key: 'email', value: email, onChange: function(e) { setEmail(e.target.value) }, placeholder: 'Email' }),
          h(Button, { key: 'btn', onClick: addLead }, 'Add'),
        ])
      ),
    ]),
    h(Card, { key: 'table' }, [
      h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'All Leads')),
      h(CardContent, { key: 'content' },
        h(Table, {}, [
          h(TableHeader, { key: 'thead' }, h(TableRow, {}, [
            h(TableHead, { key: 'name' }, 'Name'),
            h(TableHead, { key: 'email' }, 'Email'),
            h(TableHead, { key: 'status' }, 'Status'),
          ])),
          h(TableBody, { key: 'tbody' },
            leads.map(function(l) {
              return h(TableRow, { key: l.id }, [
                h(TableCell, { key: 'name' }, l.name),
                h(TableCell, { key: 'email' }, l.email),
                h(TableCell, { key: 'status' }, h(Badge, {}, l.status)),
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
write_file({ path: "canvas/counter.js", content: \`
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

### Example 4: Multi-surface app with shared backend

User: "Build a dashboard tab and a settings tab"

\`\`\`
write_file({ path: "canvas/dashboard.js", content: \`
  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Dashboard'),
    h(Row, { key: 'metrics', gap: 'md' }, [
      h(Metric, { key: 'users', label: 'Users', value: 1200 }),
      h(Metric, { key: 'revenue', label: 'Revenue', value: '$32K' }),
    ]),
  ])
\`})
write_file({ path: "canvas/settings.js", content: \`
  var _d = useState(false)
  var darkMode = _d[0], setDarkMode = _d[1]
  var _n = useState(true)
  var notifications = _n[0], setNotifications = _n[1]
  return h('div', { className: 'flex flex-col gap-4 p-2' }, [
    h('h2', { key: 'title', className: 'text-2xl font-semibold' }, 'Settings'),
    h(Card, { key: 'prefs' }, [
      h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'Preferences')),
      h(CardContent, { key: 'content', className: 'flex flex-col gap-4' }, [
        h('div', { key: 'dark', className: 'flex items-center justify-between' }, [
          h(Label, { key: 'l' }, 'Dark Mode'),
          h(Switch, { key: 's', checked: darkMode, onCheckedChange: setDarkMode }),
        ]),
        h('div', { key: 'notif', className: 'flex items-center justify-between' }, [
          h(Label, { key: 'l' }, 'Notifications'),
          h(Switch, { key: 's', checked: notifications, onCheckedChange: setNotifications }),
        ]),
      ]),
    ]),
  ])
\`})
\`\`\`
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
