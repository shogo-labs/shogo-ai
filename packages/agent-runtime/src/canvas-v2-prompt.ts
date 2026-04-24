// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas V2 (Code Mode) Prompt Sections
 *
 * The workspace is a standard Vite + React + Tailwind + shadcn/ui app.
 * The agent writes directly into src/ and the build runs automatically.
 */

const SKILL_PORT = process.env.SKILL_SERVER_PORT || '4100'

// ---------------------------------------------------------------------------
// Section 1: Core Guide
// ---------------------------------------------------------------------------

export const CANVAS_V2_GUIDE = `## Frontend App Reference

Your workspace is a standard **Vite + React + TypeScript + Tailwind CSS** app. Write code directly into \`src/\` — a Vite build runs automatically after each file change and the preview panel reloads.

### Project structure

\`\`\`
src/
  App.tsx              ← Navigation shell (tabs across features)
  main.tsx             ← Entry point (renders App)
  index.css            ← Tailwind + theme variables
  components/
    ui/                ← Pre-installed shadcn/ui components
    SprintBoard.tsx    ← Feature component (example)
    LeadTracker.tsx    ← Feature component (example)
  lib/
    cn.ts              ← Tailwind class merge utility
    db.ts              ← Database client (for skill server)
index.html             ← Vite entry HTML
vite.config.ts         ← Vite config (already set up)
package.json           ← Dependencies (react, tailwind, recharts, etc.)
\`\`\`

### How it works
1. Create feature components under \`src/components/\` (e.g. \`SprintBoard.tsx\`) using \`write_file\`
2. Update \`src/App.tsx\` to import and display the new feature using \`edit_file\`
3. A Vite build runs automatically after each file change and the preview panel reloads

### Available imports

**React** — \`import React, { useState, useEffect, useMemo, useCallback, useRef, useReducer } from 'react'\`

**shadcn/ui** — Pre-installed in \`src/components/ui/\`. Import from \`@/components/ui/*\`:
\`\`\`tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
\`\`\`

**Recharts** — \`import { ResponsiveContainer, LineChart, BarChart, ... } from 'recharts'\`

**Icons** — \`import { TrendingUp, Search, Calendar, ... } from 'lucide-react'\`

**Utilities** — \`import { cn } from '@/lib/cn'\`

**SDK** — \`import { createClient, HttpClient, OptimisticStore } from '@shogo-ai/sdk'\`

**Integration Tools SDK** — \`import { ToolsClient, useTools } from '@shogo-ai/sdk/tools'\` — Call installed integration tools (Meta Ads, Google Calendar, Slack, etc.) from your React code. See the "Integration Tools" section below.

**Installing new packages** — Run \`exec({ command: "bun add <package-name>" })\` to install any npm package.

### Style

Use Tailwind CSS classes. The app supports both light and dark mode automatically. Follow these critical design rules:
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
- \`src/App.tsx\` is the **navigation shell** — it imports and renders feature components. Don't put feature logic directly in App.tsx.
- Each feature gets its own file under \`src/components/\` (e.g. \`SprintBoard.tsx\`, \`CapacityPlanner.tsx\`).
- **Write modular, reusable components.** Extract repeated UI patterns (stat cards, data tables, form sections, chart wrappers) into their own files under \`src/components/\`. A feature component should compose smaller pieces, not be a single 500-line file.
- Use standard JSX syntax — NOT \`h()\` or \`React.createElement()\`
- Use \`const\` and arrow functions — standard modern TypeScript
- Keys are required on list items

### Multi-feature apps

When a project has **multiple features**, use \`src/App.tsx\` as a **tabbed navigation shell** with shadcn Tabs. Each feature is a self-contained component.

**Pattern — App.tsx as navigation shell:**
\`\`\`tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import SprintBoard from './components/SprintBoard'
import CapacityPlanner from './components/CapacityPlanner'

export default function App() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">Engineering Hub</h2>
        <p className="text-sm text-muted-foreground">Tools and dashboards</p>
      </div>
      <Tabs defaultValue="sprint-board">
        <TabsList>
          <TabsTrigger value="sprint-board">Sprint Board</TabsTrigger>
          <TabsTrigger value="capacity">Capacity Planner</TabsTrigger>
        </TabsList>
        <TabsContent value="sprint-board"><SprintBoard /></TabsContent>
        <TabsContent value="capacity"><CapacityPlanner /></TabsContent>
      </Tabs>
    </div>
  )
}
\`\`\`

**Adding a new feature to an existing project:**
1. \`write_file\` — create \`src/components/NewFeature.tsx\` with the full feature UI
2. \`edit_file\` — update \`src/App.tsx\` to add the import and a new TabsTrigger + TabsContent entry

**For a single-feature project**, you can write a simpler App.tsx without tabs. Once the user asks for a second feature, refactor into the tabbed shell and move the first feature into its own component file.

### Validation Workflow
After writing or editing files under \`src/\`, **always** call \`read_lints\` with no arguments to check for TypeScript errors. It auto-scopes to the files you just touched — you do not need to pass a path:
- If \`read_lints\` returns \`ok: true\` — the code is clean, proceed normally.
- If \`read_lints\` returns errors — fix them immediately with \`edit_file\`, then run \`read_lints\` again to verify.

### Skill Server API

**From React code (src/):** Always use relative URLs — \`fetch('/api/items')\`. The app is served behind a proxy that routes \`/api/*\` to the skill server automatically.

**From agent tools (web, exec):** Use the full URL — \`web({ url: "http://localhost:${SKILL_PORT}/api/items", method: "POST", body: {...} })\`

**From scripts or server-side code (Node/Bun):** Read the port from \`process.env.SKILL_SERVER_PORT\` (currently \`${SKILL_PORT}\` on this runtime). The port varies per deployment — do NOT hardcode it. Example: \`const port = process.env.SKILL_SERVER_PORT ?? '${SKILL_PORT}'; await fetch(\\\`http://localhost:\${port}/api/items\\\`)\`.

### Build Systems, Not Reports

When the user asks you to analyze, organize, track, or monitor data:
1. **Persist the data** — Write a schema and POST processed data to the skill server API
2. **Visualize it** — Write React code in \`src/\` that fetches from the skill server
3. **Make it reusable** — Save a skill file so the workflow can be re-run

Do NOT write Markdown reports, summary files, or text-only responses when the user wants an ongoing system.
`

// ---------------------------------------------------------------------------
// Section 2: Backend with Skill Server
// ---------------------------------------------------------------------------

export const CANVAS_V2_BACKEND_GUIDE = `## Backend — Skill Server

For apps that need persistent data (CRUD, lists, forms), create a skill server backend. The frontend fetches data via \`fetch()\`.

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

That's it — **everything else is automatic**: dependency install, code generation, database creation, and server startup on \`http://localhost:${SKILL_PORT}\`. In scripts or server-side code, read the port from \`process.env.SKILL_SERVER_PORT\` (currently \`${SKILL_PORT}\` on this runtime) — do not hardcode it, it varies per deployment. Do NOT manually write \`server.tsx\` or \`db.tsx\` — they are auto-generated from the schema. Only write \`schema.prisma\`.

**CRITICAL — No custom servers:** NEVER create your own HTTP server (Hono, Express, Fastify, etc.). Do NOT write \`server.ts\`, \`server.tsx\`, or any file that imports a server framework and calls \`.listen()\` or \`Bun.serve()\`. The skill server is **always running** at \`http://localhost:${SKILL_PORT}\` with a \`/health\` endpoint — it starts automatically and provides full CRUD on every model once a schema is written. There are three ways to get data into the app:
1. **Integration Tools SDK** — For external APIs (Meta Ads, Gmail, Slack, etc.), use \`useTools()\` from \`@shogo-ai/sdk/tools\` directly in React code. This proxies through the runtime automatically — no custom server needed.
2. **Skill server** — For persistent CRUD data, write a \`.shogo/server/schema.prisma\` and fetch from \`/api/...\` endpoints.
3. **Custom API routes** — For routes beyond CRUD (external API proxies, aggregation, webhooks), edit \`.shogo/server/custom-routes.ts\` (see below).

Never create a standalone server file. Use the tools SDK, skill server, or custom routes.

### Custom API Routes

The file \`.shogo/server/custom-routes.ts\` already exists and is mounted at \`/api/\`. To add custom routes (external API proxies, aggregation endpoints, webhooks), **edit** this file using \`edit_file\`:

\`\`\`ts
import { Hono } from 'hono'
const app = new Hono()

app.get('/meta/campaigns', async (c) => {
  const token = c.req.header('X-Meta-Token')
  const res = await fetch(\`https://graph.facebook.com/v19.0/me/campaigns?access_token=\${token}\`)
  return c.json(await res.json())
})

export default app
\`\`\`

Custom routes are mounted at \`/api/\` alongside the CRUD routes and the server auto-restarts when the file is saved. Use this instead of creating a standalone server. You do NOT need a schema.prisma to use custom routes — they work independently.

### Additive schema management

The schema is **cumulative** — models from different features coexist in one file. Follow these rules:

1. **Before writing the schema, ALWAYS \`read_file\` the current \`.shogo/server/schema.prisma\`** to see what models already exist
2. **If models already exist, APPEND your new models** — include ALL existing models in your write. Never drop models the user has already built.
3. **Use relations across features** when it makes sense — e.g. an \`Engineer\` model created for a capacity planner can be referenced by an on-call scheduler via a relation field
4. **NEVER write a schema that removes existing models** — the database preserves data across changes, and dropping models deletes user data

Adding models is safe and cheap — the server regenerates incrementally and \`db push\` adds new tables without touching existing ones.

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

### Fetching from the app

Use \`fetch()\` in a \`useEffect\` to load data from the skill server.
**IMPORTANT:** In React code, always use relative URLs (\`/api/...\`) — never \`http://localhost:...\`. The app is served behind a proxy.

\`\`\`tsx
const [leads, setLeads] = useState<any[]>([])
const [loading, setLoading] = useState(true)

useEffect(() => {
  fetch('/api/leads')
    .then(r => r.json())
    .then(res => { setLeads(res.items); setLoading(false) })
    .catch(() => setLoading(false))
}, [])
\`\`\`

### Full-stack workflow

1. \`read_file\` the current schema, then write \`.shogo/server/schema.prisma\` with **ALL** models (existing + new)
2. Seed initial data using the web tool: \`web({ url: "http://localhost:${SKILL_PORT}/api/leads", method: "POST", body: { name: "Acme Corp", email: "hello@acme.com" } })\`
3. Create a feature component under \`src/components/\`, then update \`src/App.tsx\` to include it
4. If building a reusable template, save a skill file: \`write_file({ path: "skills/lead-tracking.md", content: "..." })\`

The skill server starts automatically when the schema is saved. The app can immediately \`fetch()\` from it.
`

// ---------------------------------------------------------------------------
// Section 3: React Code Quality
// ---------------------------------------------------------------------------

export const CANVAS_V2_REACT_GUIDE = `## React Patterns

### Data fetching — always use the loading/error/data triple

\`\`\`tsx
const [items, setItems] = useState<any[]>([])
const [loading, setLoading] = useState(true)
const [error, setError] = useState<string | null>(null)

useEffect(() => {
  fetch('/api/items')
    .then(r => {
      if (!r.ok) throw new Error('Failed to load')
      return r.json()
    })
    .then(res => { setItems(res.items); setLoading(false) })
    .catch(err => { setError(err.message); setLoading(false) })
}, [])

if (loading) return (
  <div className="flex flex-col gap-4 p-4">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-32 w-full" />
  </div>
)
if (error) return (
  <Alert variant="destructive">
    <AlertTitle>Error</AlertTitle>
    <AlertDescription>{error}</AlertDescription>
  </Alert>
)
\`\`\`

### Form input — controlled state with submit handler

\`\`\`tsx
const [name, setName] = useState('')

function handleSubmit() {
  if (!name.trim()) return
  fetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  .then(r => r.json())
  .then(res => {
    setItems(prev => [...prev, res.data])
    setName('')
  })
}

// In render:
<div className="flex gap-2">
  <Input value={name} onChange={e => setName(e.target.value)} placeholder="Enter name..." />
  <Button onClick={handleSubmit}>Add</Button>
</div>
\`\`\`

### List rendering — always provide keys

\`\`\`tsx
{items.map(item => (
  <TableRow key={item.id}>
    <TableCell>{item.name}</TableCell>
    <TableCell><Badge>{item.status}</Badge></TableCell>
  </TableRow>
))}
\`\`\`

### Optimistic updates — update UI immediately, then sync

\`\`\`tsx
function deleteItem(id: string) {
  setItems(prev => prev.filter(i => i.id !== id))
  fetch(\`/api/items/\${id}\`, { method: 'DELETE' })
}
\`\`\`

### Integration Tools (Meta Ads, Google Calendar, Slack, etc.)

When the user has installed integrations via \`tool_install\`, you can call them directly from React code using the tools SDK. This is the preferred approach for building apps around third-party integrations.

**Step 1:** Install the integration (agent tool call):
\`\`\`
tool_install({ name: "meta_ads" })
\`\`\`

**Step 2:** Use the \`useTools\` hook in your React code:
\`\`\`tsx
import { useState, useEffect } from 'react'
import { useTools } from '@shogo-ai/sdk/tools'

export default function AdsManager() {
  const { execute, tools, loading } = useTools()
  const [insights, setInsights] = useState<any>(null)

  useEffect(() => {
    execute('METAADS_GET_INSIGHTS', {
      ad_account_id: 'act_123456',
      date_preset: 'last_30_days',
    }).then(res => {
      if (res.ok && res.data) setInsights(JSON.parse(res.data))
    })
  }, [execute])

  if (loading) return <p>Loading...</p>
  return <pre>{JSON.stringify(insights, null, 2)}</pre>
}
\`\`\`

**Imperative (non-React) usage:**
\`\`\`ts
import { ToolsClient } from '@shogo-ai/sdk/tools'
const tools = new ToolsClient()
const result = await tools.execute('GMAIL_SEND_EMAIL', { to: 'user@example.com', subject: 'Hello', body: 'Hi!' })
\`\`\`

**Key points:**
- Tools must be installed first via \`tool_install({ name: "<toolkit>" })\` before the app can call them
- Tool names are uppercase slugs like \`METAADS_GET_INSIGHTS\`, \`GMAIL_SEND_EMAIL\`, \`GOOGLECALENDAR_CREATE_EVENT\`
- \`execute()\` returns \`{ ok: boolean, data?: string, error?: string }\` — parse \`data\` as JSON when the tool returns structured data
- \`useTools()\` auto-discovers installed tools — use \`tools\` array to show available actions in the UI
- Works zero-config because the app is served same-origin with the agent runtime

### State management

- Use \`useState\` for UI state (form inputs, toggles, selected tab)
- Use \`useState\` + \`useEffect\` + \`fetch\` for server data
`

// ---------------------------------------------------------------------------
// Section 4: Few-Shot Examples
// ---------------------------------------------------------------------------

export const CANVAS_V2_EXAMPLES = `## App Examples

### Example 1: Display-only dashboard (no backend)

User: "Show me our key metrics — 1,500 users, $45K revenue, 342 sessions"

\`\`\`
write_file({ path: "src/components/MetricCard.tsx", content: \`import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'

interface MetricCardProps {
  label: string
  value: string
  trend: string
}

export default function MetricCard({ label, value, trend }: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1 text-sm text-emerald-600">
          <TrendingUp className="h-4 w-4" />
          {trend}
        </div>
      </CardContent>
    </Card>
  )
}\`})

write_file({ path: "src/components/Dashboard.tsx", content: \`import MetricCard from './MetricCard'
import { Badge } from '@/components/ui/badge'

const metrics = [
  { label: 'Users', value: '1,500', trend: '+12%' },
  { label: 'Revenue', value: '$45K', trend: '+8%' },
  { label: 'Sessions', value: '342', trend: '+5%' },
]

export default function Dashboard() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">Key performance metrics at a glance</p>
        </div>
        <Badge variant="outline">Live</Badge>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {metrics.map(m => <MetricCard key={m.label} {...m} />)}
      </div>
    </div>
  )
}\`})

write_file({ path: "src/App.tsx", content: \`import Dashboard from './components/Dashboard'

export default function App() {
  return <Dashboard />
}\`})
\`\`\`

### Example 2: Full-stack CRUD app with skill server

User: "Build a lead tracker"

\`\`\`
write_file({ path: ".shogo/server/schema.prisma", content: "datasource db {\\n  provider = \\"sqlite\\"\\n}\\n\\ngenerator client {\\n  provider = \\"prisma-client\\"\\n  output   = \\"./generated/prisma\\"\\n}\\n\\nmodel Lead {\\n  id        String   @id @default(cuid())\\n  name      String\\n  email     String\\n  status    String   @default(\\"new\\")\\n  createdAt DateTime @default(now())\\n  updatedAt DateTime @updatedAt\\n}" })

write_file({ path: "src/components/AddLeadForm.tsx", content: \`import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus } from 'lucide-react'

interface AddLeadFormProps {
  onAdd: (lead: any) => void
}

export default function AddLeadForm({ onAdd }: AddLeadFormProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  function handleSubmit() {
    if (!name.trim() || !email.trim()) return
    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email })
    })
    .then(r => r.json())
    .then(res => { onAdd(res.data); setName(''); setEmail('') })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Lead</CardTitle>
        <CardDescription>Enter new lead details</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
          <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
          <Button onClick={handleSubmit}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </div>
      </CardContent>
    </Card>
  )
}\`})

write_file({ path: "src/components/LeadTable.tsx", content: \`import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Users } from 'lucide-react'

interface LeadTableProps {
  leads: any[]
}

export default function LeadTable({ leads }: LeadTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All Leads</CardTitle>
        <CardDescription>Your complete lead directory</CardDescription>
      </CardHeader>
      <CardContent>
        {leads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold">No leads yet</h3>
            <p className="text-sm text-muted-foreground">Add your first lead above.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map(l => (
                <TableRow key={l.id} className="hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell className="text-muted-foreground">{l.email}</TableCell>
                  <TableCell><Badge variant={l.status === 'new' ? 'default' : 'secondary'}>{l.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}\`})

write_file({ path: "src/components/LeadTracker.tsx", content: \`import { useState, useEffect } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import AddLeadForm from './AddLeadForm'
import LeadTable from './LeadTable'

export default function LeadTracker() {
  const [leads, setLeads] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/leads')
      .then(r => r.json())
      .then(res => { setLeads(res.items || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="flex flex-col gap-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  )

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">Lead Tracker</h2>
        <p className="text-sm text-muted-foreground">Manage your sales leads</p>
      </div>
      <AddLeadForm onAdd={lead => setLeads(prev => [...prev, lead])} />
      <LeadTable leads={leads} />
    </div>
  )
}\`})

write_file({ path: "src/App.tsx", content: \`import LeadTracker from './components/LeadTracker'

export default function App() {
  return <LeadTracker />
}\`})
\`\`\`
`

// ---------------------------------------------------------------------------
// Section 5: Brief reference for non-canvas modes
// ---------------------------------------------------------------------------

export const CANVAS_FILE_REFERENCE = `## Frontend App Reference

Your workspace is a Vite + React app. Build features as components under \`src/components/\` and import them in \`src/App.tsx\`.

### Available imports
- \`react\` — React, useState, useEffect, useMemo, useCallback, useRef, useReducer
- \`recharts\` — LineChart, BarChart, AreaChart, PieChart, ResponsiveContainer, etc.
- \`lucide-react\` — all icons
- \`@/lib/cn\` — cn (classname merge)
- \`@/components/ui/*\` — card, button, badge, input, label, textarea, checkbox, switch, select, tabs, table, dialog, alert, accordion, progress, separator, scroll-area, skeleton, tooltip, avatar, dropdown-menu, sheet, popover
- \`@shogo-ai/sdk\` — createClient, HttpClient, OptimisticStore
- \`@shogo-ai/sdk/tools\` — ToolsClient, useTools (call installed integration tools from code)

### Validation
After writing or editing files under \`src/\`, call \`read_lints\` with no arguments to check for errors and fix immediately. It auto-scopes to the files you just touched.
`

// ---------------------------------------------------------------------------
// Legacy compat — combined prompt
// ---------------------------------------------------------------------------

export const CANVAS_V2_PROMPT = [
  CANVAS_V2_GUIDE,
  CANVAS_V2_BACKEND_GUIDE,
  CANVAS_V2_REACT_GUIDE,
  CANVAS_V2_EXAMPLES,
].join('\n\n---\n\n')
