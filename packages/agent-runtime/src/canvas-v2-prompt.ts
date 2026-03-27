// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export const CANVAS_V2_PROMPT = `## Canvas — Live React Display

Write React components to \`canvas/*.tsx\` and they render instantly in the canvas panel.
Each file = a tab. Use \`write_file\` to create, \`edit_file\` to update, \`delete_file\` to remove.

Write standard React with JSX and TypeScript. Use \`export default\` to define your component.

### Available Imports

**React** — \`import { useState, useEffect, useMemo, useCallback, useRef, useReducer } from 'react'\`

**shadcn/ui** — import from \`@/components/ui/*\`:
\`\`\`
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
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
\`\`\`

**Canvas components** — \`import { Row, Column, Grid, CanvasCard, CanvasScrollArea } from '@/components/canvas/layout'\`
\`import { Metric, DynTable, DynChart, DataList } from '@/components/canvas/data'\`
\`import { DynText, DynBadge, DynImage } from '@/components/canvas/display'\`

**Recharts** — \`import { ResponsiveContainer, LineChart, BarChart, AreaChart, PieChart, Line, Bar, Area, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend } from 'recharts'\`

**Icons** — \`import { TrendingUp, Search, Calendar, ArrowRight, ... } from 'lucide-react'\` (all lucide-react icons available)

**Utilities** — \`import { cn } from '@/lib/cn'\` (classname merge)

### Data

Write JSON to \`canvas/<name>.data.json\` — import with \`import { data } from '@/canvas/data'\`.
Or use \`fetch()\` inside \`useEffect\` to load data from any API.

### User Actions

\`import { onAction } from '@/canvas/actions'\` — call \`onAction('action-name', { context })\` to send actions to the agent.

### Style

Use Tailwind CSS classes. The canvas supports both light and dark mode automatically.

### Example

\`\`\`
write_file({ path: "canvas/dashboard.tsx", content: \`
import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Row } from '@/components/canvas/layout'
import { Metric } from '@/components/canvas/data'
import { data } from '@/canvas/data'

interface Task {
  title: string
  status: string
}

export default function Dashboard() {
  const [count, setCount] = useState(0)
  const tasks: Task[] = (data as any)?.tasks || []
  const done = tasks.filter(t => t.status === 'done').length

  return (
    <div className="flex flex-col gap-6 p-2">
      <h2 className="text-2xl font-semibold">Dashboard</h2>
      <Row gap="md">
        <Metric label="Total" value={tasks.length} />
        <Metric label="Done" value={done} trend="up" trendValue={\\\`+\\\${done}\\\`} />
        <Metric label="Clicks" value={count} />
      </Row>
      <Card>
        <CardHeader>
          <CardTitle>Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t, i) => (
                <TableRow key={i}>
                  <TableCell>{t.title}</TableCell>
                  <TableCell><Badge>{t.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Button onClick={() => setCount(c => c + 1)}>Click me: {count}</Button>
    </div>
  )
}
\`})
\`\`\`

### Hooks & State

\`\`\`
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export default function Counter() {
  const [count, setCount] = useState(0)
  return <Button onClick={() => setCount(c => c + 1)}>Clicks: {count}</Button>
}
\`\`\`

### Network Requests

\`\`\`
import { useState, useEffect } from 'react'

export default function DataFetcher() {
  const [items, setItems] = useState([])
  useEffect(() => {
    fetch('https://api.example.com/items')
      .then(r => r.json())
      .then(setItems)
  }, [])
  return <ul>{items.map((item: any, i: number) => <li key={i}>{item.name}</li>)}</ul>
}
\`\`\`

### Important Rules
- Use \`export default\` to define your component.
- Use standard React JSX and TypeScript.
- Import only from the available packages listed above — no other packages are available.
- Use Tailwind CSS for styling.
- Each \`canvas/*.tsx\` file is a separate tab.
- Keys are required on list items.
`
