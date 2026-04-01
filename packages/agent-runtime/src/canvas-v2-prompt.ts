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
  App.tsx          ← Main app component (edit this)
  main.tsx         ← Entry point (renders App)
  index.css        ← Tailwind + theme variables
  components/
    ui/            ← Pre-installed shadcn/ui components
  lib/
    cn.ts          ← Tailwind class merge utility
    db.ts          ← Database client (for skill server)
index.html         ← Vite entry HTML
vite.config.ts     ← Vite config (already set up)
package.json       ← Dependencies (react, tailwind, recharts, etc.)
\`\`\`

### How it works
1. You edit \`src/App.tsx\` (or add files under \`src/\`) using \`write_file\` / \`edit_file\`
2. A Vite build runs automatically after each file change
3. The preview panel reloads with your updated app

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
- Edit \`src/App.tsx\` for the main UI. Create additional components under \`src/components/\`.
- Use standard JSX syntax — NOT \`h()\` or \`React.createElement()\`
- Use \`const\` and arrow functions — standard modern TypeScript
- Keys are required on list items

### Validation Workflow
After writing or editing files under \`src/\`, **always** call \`read_lints\` to check for TypeScript errors:
- If \`read_lints\` returns \`ok: true\` — the code is clean, proceed normally.
- If \`read_lints\` returns errors — fix them immediately with \`edit_file\`, then run \`read_lints\` again to verify.

### Skill Server API

**From React code (src/):** Always use relative URLs — \`fetch('/api/items')\`. The app is served behind a proxy that routes \`/api/*\` to the skill server automatically.

**From agent tools (web, exec):** Use the full URL — \`web({ url: "http://localhost:${SKILL_PORT}/api/items", method: "POST", body: {...} })\`

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

1. Write \`.shogo/server/schema.prisma\` with your models
2. Seed initial data using the web tool: \`web({ url: "http://localhost:${SKILL_PORT}/api/leads", method: "POST", body: { name: "Acme Corp", email: "hello@acme.com" } })\`
3. Write \`src/App.tsx\` with UI that fetches from the skill server
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
write_file({ path: "src/App.tsx", content: \`import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'

export default function App() {
  const metrics = [
    { label: 'Users', value: '1,500', trend: '+12%' },
    { label: 'Revenue', value: '$45K', trend: '+8%' },
    { label: 'Sessions', value: '342', trend: '+5%' },
  ]

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
        {metrics.map(m => (
          <Card key={m.label}>
            <CardHeader className="pb-2">
              <CardDescription>{m.label}</CardDescription>
              <CardTitle className="text-3xl">{m.value}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-1 text-sm text-emerald-600">
                <TrendingUp className="h-4 w-4" />
                {m.trend}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}\`})
\`\`\`

### Example 2: Full-stack CRUD app with skill server

User: "Build a lead tracker"

\`\`\`
write_file({ path: ".shogo/server/schema.prisma", content: "datasource db {\\n  provider = \\"sqlite\\"\\n}\\n\\ngenerator client {\\n  provider = \\"prisma-client\\"\\n  output   = \\"./generated/prisma\\"\\n}\\n\\nmodel Lead {\\n  id        String   @id @default(cuid())\\n  name      String\\n  email     String\\n  status    String   @default(\\"new\\")\\n  createdAt DateTime @default(now())\\n  updatedAt DateTime @updatedAt\\n}" })

write_file({ path: "src/App.tsx", content: \`import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Users, Plus } from 'lucide-react'

export default function App() {
  const [leads, setLeads] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => {
    fetch('/api/leads')
      .then(r => r.json())
      .then(res => { setLeads(res.items || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  function addLead() {
    if (!name.trim() || !email.trim()) return
    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email })
    })
    .then(r => r.json())
    .then(res => { setLeads(prev => [...prev, res.data]); setName(''); setEmail('') })
  }

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

      <Card>
        <CardHeader>
          <CardTitle>Add Lead</CardTitle>
          <CardDescription>Enter new lead details</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
            <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
            <Button onClick={addLead}><Plus className="h-4 w-4 mr-1" /> Add</Button>
          </div>
        </CardContent>
      </Card>

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
    </div>
  )
}\`})
\`\`\`
`

// ---------------------------------------------------------------------------
// Section 5: Brief reference for non-canvas modes
// ---------------------------------------------------------------------------

export const CANVAS_FILE_REFERENCE = `## Frontend App Reference

Your workspace is a Vite + React app. Edit \`src/App.tsx\` to build your UI. Additional components go in \`src/components/\`.

### Available imports
- \`react\` — React, useState, useEffect, useMemo, useCallback, useRef, useReducer
- \`recharts\` — LineChart, BarChart, AreaChart, PieChart, ResponsiveContainer, etc.
- \`lucide-react\` — all icons
- \`@/lib/cn\` — cn (classname merge)
- \`@/components/ui/*\` — card, button, badge, input, label, textarea, checkbox, switch, select, tabs, table, dialog, alert, accordion, progress, separator, scroll-area, skeleton, tooltip, avatar, dropdown-menu, sheet, popover
- \`@shogo-ai/sdk\` — createClient, HttpClient, OptimisticStore

### Validation
After writing or editing files under \`src/\`, call \`read_lints\` to check for errors and fix immediately.
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
