// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas V2 Lint Evals — Stress-tests for the canvas code validation system.
 *
 * These evals are designed to trigger the exact classes of bugs the lint system
 * must catch: undefined icon references, wrong component names, scope boundary
 * violations, and self-correction behavior.
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool, builtCanvasV2Only, execCommands, fileWrites, readWorkspaceFile, writtenContent } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

const LINT_ANTI_PATTERNS = [
  'used v1 canvas tools instead of file tools',
  'ignored lint errors and responded without fixing',
]

// ---------------------------------------------------------------------------
// Canvas-v2 validation helpers (aligned with test-cases-canvas-v2.ts)
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

/** Wrote or edited a src/ code file via any route (the template ships src/App.tsx). */
function wroteCodeFile(r: EvalResult, namePattern?: RegExp): boolean {
  return fileWrites(r).some(w => isCodeFile(w.path) && (!namePattern || namePattern.test(w.path)))
}

function allWrittenCode(r: EvalResult): string {
  return writtenContent(r, isCodeFile)
}

function anyCodeContains(r: EvalResult, term: string): boolean {
  return allWrittenCode(r).toLowerCase().includes(term.toLowerCase())
}

function neverUsedV1CanvasTools(r: EvalResult): boolean {
  return builtCanvasV2Only(r)
}

function editedCodeFile(r: EvalResult, namePattern?: RegExp): boolean {
  return fileWrites(r).some(w => w.via !== 'write_file' && isCodeFile(w.path) && (!namePattern || namePattern.test(w.path)))
}

function codeFileCount(r: EvalResult): number {
  return new Set(fileWrites(r).filter(w => isCodeFile(w.path)).map(w => w.path)).size
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  const text = `${writtenContent(r, (p) => p.endsWith('schema.prisma'))}\n${readWorkspaceFile(r, 'prisma/schema.prisma')}`
  return new RegExp(`model\\s+${modelName}\\b`).test(text)
}

function canvasCodeFetches(r: EvalResult): boolean {
  const code = allWrittenCode(r).toLowerCase()
  return code.includes('fetch(') && (code.includes('localhost:') || code.includes('/api/'))
}

// ---------------------------------------------------------------------------
// Lint-specific validation helpers (read_lints-based)
// ---------------------------------------------------------------------------

function parseOutput(output: unknown): any {
  if (typeof output !== 'string') return output
  try { return JSON.parse(output) } catch { return output }
}

const TSC_RE = /(^|[\s;&|(])(npx\s+|bunx\s+|bun\s+x\s+)?(tsc|vue-tsc)\b|\b(bun|npm|pnpm|yarn)\s+(run\s+)?(typecheck|type-check|tsc|lint)\b/

/**
 * Ordered lint verdicts from every route: read_lints results, the inline
 * `lint` field attached to write_file/edit_file results, and tsc / lint
 * script runs. A code write with no inline verdict is `null` (unverified).
 */
function lintSignals(r: EvalResult): Array<boolean | null> {
  const out: Array<boolean | null> = []
  for (const t of r.toolCalls) {
    const o = parseOutput(t.output)
    if (t.name === 'read_lints') {
      out.push(o?.ok === true ? true : o?.ok === false ? false : null)
    } else if (fileWrites(r, [t]).some(w => isCodeFile(w.path))) {
      const lint = o && typeof o === 'object' ? o.lint : undefined
      out.push(lint?.ok === true ? true : lint?.ok === false ? false : null)
    } else if ((t.name === 'exec' || t.name === 'terminal_exec') && execCommands(r, [t]).some(c => TSC_RE.test(c))) {
      const text = typeof o === 'string' ? o : JSON.stringify(o ?? '')
      const exit = o && typeof o === 'object' ? (o.exitCode ?? o.exit_code ?? o.code) : undefined
      out.push(/error TS\d+|Found [1-9]\d* errors?|✖ [1-9]\d* problems?/.test(text) || (typeof exit === 'number' && exit !== 0) ? false : true)
    }
  }
  return out
}

/** Checked lints at some point: read_lints, or a tsc/lint run. */
function usedReadLints(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name === 'read_lints') ||
    execCommands(r).some(c => TSC_RE.test(c))
}

/** The last lint verdict (read_lints, inline write/edit lint, or tsc) is clean. */
function lastReadLintsClean(r: EvalResult): boolean {
  const signals = lintSignals(r)
  return signals.length > 0 && signals[signals.length - 1] === true
}

function selfCorrectedIfNeeded(r: EvalResult): boolean {
  const signals = lintSignals(r)
  const firstWithErrors = signals.indexOf(false)
  if (firstWithErrors === -1) return true
  return signals.slice(firstWithErrors + 1).includes(true)
}

function countDistinctIconImports(r: EvalResult): number {
  const code = allWrittenCode(r)
  const uiComponents = new Set([
    'Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent', 'CardFooter',
    'Button', 'Badge', 'Input', 'Label', 'Textarea', 'Checkbox', 'Switch',
    'Select', 'SelectTrigger', 'SelectValue', 'SelectContent', 'SelectItem',
    'Tabs', 'TabsList', 'TabsTrigger', 'TabsContent',
    'Table', 'TableHeader', 'TableBody', 'TableRow', 'TableHead', 'TableCell',
    'Dialog', 'DialogTrigger', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter',
    'Alert', 'AlertTitle', 'AlertDescription',
    'Accordion', 'AccordionItem', 'AccordionTrigger', 'AccordionContent',
    'Progress', 'Separator', 'ScrollArea', 'Skeleton',
    'Tooltip', 'TooltipProvider', 'TooltipTrigger', 'TooltipContent',
    'Avatar', 'AvatarImage', 'AvatarFallback',
    'DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem',
    'Sheet', 'SheetTrigger', 'SheetContent', 'SheetHeader', 'SheetTitle',
    'Popover', 'PopoverTrigger', 'PopoverContent',
    'ResponsiveContainer', 'LineChart', 'BarChart', 'AreaChart', 'PieChart',
    'Line', 'Bar', 'Area', 'Pie', 'Cell', 'XAxis', 'YAxis', 'CartesianGrid',
    'RechartsTooltip', 'Legend',
  ])
  const jsxTagPattern = /<([A-Z][a-zA-Z]+)/g
  const icons = new Set<string>()
  let match
  while ((match = jsxTagPattern.exec(code)) !== null) {
    if (!uiComponents.has(match[1])) icons.add(match[1])
  }
  return icons.size
}

// ---------------------------------------------------------------------------
// Pre-seeded source files for edit evals (standard React JSX)
// ---------------------------------------------------------------------------

const BROKEN_DASHBOARD_TSX = `import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescrption, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RefreshCcw } from 'lucide-react'
import { useLocalStorage } from '@/hooks/useLocalStorage'

const metrics = [
  { label: 'Users', value: 1234 },
  { label: 'Revenue', value: '$45K' },
  { label: 'Growth', value: '+12%' },
]

export default function Dashboard() {
  const [count, setCount] = useState(0)
  const [prefs, setPrefs] = useLocalStorage('dashboard-prefs', {})

  function handleRefresh() {
    setCount(count + 1)
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Dashboard</h2>
        <Button onClick={handleRefresh}>
          <RefreshCcw className="w-4 h-4 mr-2" />
          Refresh ({count})
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
          <CardDescrption>Key performance indicators</CardDescrption>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {metrics.map((m, i) => (
              <div key={i} className="text-center">
                <p className="text-2xl font-bold">{m.value}</p>
                <p className="text-sm text-muted-foreground">{m.label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}`

const WORKING_TRACKER_TSX = `import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

interface Item {
  id: number
  name: string
  status: string
  hours: number
}

export default function Tracker() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, name: 'Task A', status: 'active', hours: 3.5 },
    { id: 2, name: 'Task B', status: 'completed', hours: 7.0 },
    { id: 3, name: 'Task C', status: 'active', hours: 1.5 },
    { id: 4, name: 'Task D', status: 'paused', hours: 2.0 },
  ])
  const [newName, setNewName] = useState('')

  function addItem() {
    if (!newName.trim()) return
    setItems([...items, { id: Date.now(), name: newName, status: 'active', hours: 0 }])
    setNewName('')
  }

  const totalHours = items.reduce((sum, i) => sum + i.hours, 0)

  return (
    <div className="flex flex-col gap-6 p-4">
      <h2 className="text-2xl font-semibold">Time Tracker</h2>
      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-2 mb-4">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New task name" />
            <Button onClick={addItem}>Add</Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.name}</TableCell>
                  <TableCell>
                    <Badge variant={item.status === 'completed' ? 'default' : 'secondary'}>{item.status}</Badge>
                  </TableCell>
                  <TableCell>{item.hours.toFixed(1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground mt-4">Total: {totalHours.toFixed(1)} hours</p>
        </CardContent>
      </Card>
    </div>
  )
}`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CANVAS_V2_LINT_EVALS: AgentEval[] = [
  // Eval 1: Icon-heavy UI
  {
    id: 'canvas-v2-lint-icon-soup',
    name: 'Canvas V2 Lint: Icon-heavy file manager',
    category: 'canvas-v2',
    tags: ['lint', 'icons', 'self-correction'],
    level: 4,
    useRuntimeTemplate: true,
    input: 'Build a file manager with icons for each action: upload, download, trash, copy, search, folder, settings gear, refresh, and sort arrows. Every action should have a labeled icon button.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Wrote src/*.tsx file',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'uses-multiple-icons',
        description: 'Code references 5+ distinct Lucide icons',
        points: 20,
        phase: 'execution',
        validate: (r) => countDistinctIconImports(r) >= 5,
      },
      {
        id: 'has-button-for-each',
        description: 'Button appears 5+ times in code',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.match(/Button/g) || []).length >= 5
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'self-corrected-if-needed',
        description: 'Self-corrected lint errors if any occurred',
        points: 15,
        phase: 'execution',
        validate: (r) => selfCorrectedIfNeeded(r),
      },
    ],
  },

  // Eval 2: Complex Recharts
  {
    id: 'canvas-v2-lint-recharts-complex',
    name: 'Canvas V2 Lint: Complex multi-chart analytics',
    category: 'canvas-v2',
    tags: ['lint', 'recharts', 'complex'],
    level: 5,
    useRuntimeTemplate: true,
    input: 'Build an analytics dashboard with: a dual-axis line+bar chart (revenue line, orders bars, shared X axis), a donut chart for traffic sources, and a stacked area chart for daily active users by platform (iOS, Android, Web). Use real-looking sample data.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-three-charts',
        description: 'Code references at least 3 chart types',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          const chartTypes = ['LineChart', 'BarChart', 'AreaChart', 'PieChart', 'ComposedChart', 'ResponsiveContainer']
          return chartTypes.filter(c => code.includes(c)).length >= 3
        },
      },
      {
        id: 'has-sample-data',
        description: 'Code contains array literals with sample data',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.match(/\{/g) || []).length >= 10
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'self-corrected-if-needed',
        description: 'Self-corrected lint errors if any occurred',
        points: 15,
        phase: 'execution',
        validate: (r) => selfCorrectedIfNeeded(r),
      },
      {
        id: 'uses-jsx',
        description: 'Uses JSX syntax with React components',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return /<[A-Z][a-zA-Z]+/.test(code) && (code.includes('return (') || code.includes('return('))
        },
      },
    ],
  },

  // Eval 3: Scope boundary — all shadcn compound components
  {
    id: 'canvas-v2-lint-scope-boundary',
    name: 'Canvas V2 Lint: shadcn compound components',
    category: 'canvas-v2',
    tags: ['lint', 'scope-boundary', 'ui-components'],
    level: 5,
    useRuntimeTemplate: true,
    input: 'Build a settings panel with: an accordion for sections, a dialog for confirming changes, tooltips on every setting, a dropdown menu for theme selection, a sheet sliding in from the right for advanced options, and a popover for color picker. Use all of these exact UI patterns.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'uses-accordion',
        description: 'Uses Accordion + AccordionItem + AccordionTrigger',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('Accordion') && code.includes('AccordionItem') && code.includes('AccordionTrigger')
        },
      },
      {
        id: 'uses-dialog',
        description: 'Uses Dialog + DialogContent + DialogTitle',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('Dialog') && code.includes('DialogContent') && code.includes('DialogTitle')
        },
      },
      {
        id: 'uses-tooltip',
        description: 'Uses TooltipProvider + Tooltip + TooltipTrigger + TooltipContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('TooltipProvider') && code.includes('Tooltip') && code.includes('TooltipTrigger') && code.includes('TooltipContent')
        },
      },
      {
        id: 'uses-dropdown',
        description: 'Uses DropdownMenu + Trigger + Content',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('DropdownMenu') && code.includes('DropdownMenuTrigger') && code.includes('DropdownMenuContent')
        },
      },
      {
        id: 'uses-sheet',
        description: 'Uses Sheet + SheetContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('Sheet') && code.includes('SheetContent')
        },
      },
      {
        id: 'uses-popover',
        description: 'Uses Popover + PopoverTrigger + PopoverContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('Popover') && code.includes('PopoverTrigger') && code.includes('PopoverContent')
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 20,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
    ],
  },

  // Eval 4: Fix pre-seeded broken code
  {
    id: 'canvas-v2-lint-fix-broken-code',
    name: 'Canvas V2 Lint: Fix broken dashboard',
    category: 'canvas-v2',
    tags: ['lint', 'self-correction', 'debugging'],
    level: 3,
    useRuntimeTemplate: true,
    input: 'The dashboard preview is broken. Fix whatever is wrong with it.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/Dashboard.tsx': BROKEN_DASHBOARD_TSX,
    },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'read-file-first',
        description: 'Read or grepped before first edit',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const firstEditIdx = r.toolCalls.findIndex(t => t.name === 'edit_file')
          if (firstEditIdx === -1) return false
          return r.toolCalls.slice(0, firstEditIdx).some(t =>
            t.name === 'read_file' || t.name === 'exec' || t.name === 'read_lints'
          )
        },
      },
      {
        id: 'used-read-lints',
        description: 'Checked lints (read_lints or a tsc/lint run)',
        points: 15,
        phase: 'intention',
        validate: (r) => usedReadLints(r),
      },
      {
        id: 'fixed-component-name',
        description: 'Fixed CardDescrption to CardDescription',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const final = readWorkspaceFile(r, 'src/components/Dashboard.tsx')
          if (final) return !final.includes('CardDescrption') && final.includes('<CardTitle>Metrics</CardTitle>')
          return writtenContent(r, /Dashboard\.tsx$/).includes('CardDescription')
        },
      },
      {
        id: 'fixed-hook',
        description: 'Fixed or removed useLocalStorage (import removed, or the hook now exists)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const final = readWorkspaceFile(r, 'src/components/Dashboard.tsx')
          const hookExists = ['src/hooks/useLocalStorage.ts', 'src/hooks/useLocalStorage.tsx'].some(p => readWorkspaceFile(r, p).includes('useLocalStorage'))
          if (final) return !final.includes('useLocalStorage') || hookExists
          return r.toolCalls.some(t => t.name === 'edit_file' && String((t.input as any).old_string ?? '').includes('useLocalStorage'))
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 20,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Used 12 or fewer tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  // Eval 5: Three interconnected components
  {
    id: 'canvas-v2-lint-multi-surface-consistency',
    name: 'Canvas V2 Lint: Multi-page project management',
    category: 'canvas-v2',
    tags: ['lint', 'multi-surface', 'complex'],
    level: 4,
    useRuntimeTemplate: true,
    input: 'Build a project management app with 3 pages: (1) a dashboard showing project metrics and a chart, (2) a team members page with a table and add-member form, (3) a settings page with theme toggle and notification preferences. Each page should have its own component file.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-three-files',
        description: 'Wrote 3+ distinct src/ component files',
        points: 15,
        phase: 'intention',
        validate: (r) => codeFileCount(r) >= 3,
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'dashboard-has-chart',
        description: 'Dashboard component has a chart',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /dashboard/i.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n').toLowerCase()
          return code.includes('chart') || code.includes('responsivecontainer')
        },
      },
      {
        id: 'team-has-table',
        description: 'Team component has Table',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /team/i.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n')
          return code.includes('Table')
        },
      },
      {
        id: 'settings-has-switch',
        description: 'Settings component has Switch or Checkbox',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /setting/i.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n')
          return code.includes('Switch') || code.includes('Checkbox')
        },
      },
      {
        id: 'all-files-lint-clean',
        description: 'All code is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'used-read-lints',
        description: 'Used read_lints at least once (proactive check)',
        points: 10,
        phase: 'execution',
        validate: (r) => usedReadLints(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Used 18 or fewer tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
  },

  // Eval 6: SDK integration
  {
    id: 'canvas-v2-lint-sdk-integration',
    name: 'Canvas V2 Lint: Notification center with SDK',
    category: 'canvas-v2',
    tags: ['lint', 'sdk', 'full-stack', 'complex'],
    level: 5,
    useRuntimeTemplate: true,
    input: 'Build a real-time notification center that fetches notifications from /api/notifications, groups them by type (info, warning, error), shows unread count badges, and lets me mark them as read. Use optimistic updates when marking as read.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote schema.prisma with Notification model',
        points: 10,
        phase: 'intention',
        validate: (r) => schemaContainsModel(r, 'Notification'),
      },
      {
        id: 'wrote-code-file',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'uses-state-management',
        description: 'Uses useState + useEffect + useCallback',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r).toLowerCase()
          return code.includes('usestate') && code.includes('useeffect') && code.includes('usecallback')
        },
      },
      {
        id: 'code-fetches',
        description: 'Code fetches from API',
        points: 10,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'has-grouping-logic',
        description: 'Code has grouping/filtering logic',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r).toLowerCase()
          return code.includes('filter') || code.includes('reduce') || code.includes('group')
        },
      },
      {
        id: 'has-badge-count',
        description: 'Code uses Badge component',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'Badge'),
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
    ],
  },

  // Eval 7: Timer with useEffect cleanup
  {
    id: 'canvas-v2-lint-var-scope-traps',
    name: 'Canvas V2 Lint: Pomodoro timer (effect cleanup)',
    category: 'canvas-v2',
    tags: ['lint', 'effects', 'interactive'],
    level: 4,
    useRuntimeTemplate: true,
    input: 'Build a pomodoro timer with start/pause/reset buttons, a circular progress indicator, and session history. The timer should count down from 25 minutes.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'never-v1',
        description: 'Built the canvas as src/ code, never via retired v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-timer-logic',
        description: 'Code uses setInterval or setTimeout',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r).toLowerCase()
          return code.includes('setinterval') || code.includes('settimeout')
        },
      },
      {
        id: 'has-useeffect-cleanup',
        description: 'useEffect with clearInterval/clearTimeout cleanup',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r).toLowerCase()
          return code.includes('useeffect') &&
            (code.includes('clearinterval') || code.includes('cleartimeout') || code.includes('return ()'))
        },
      },
      {
        id: 'has-buttons',
        description: 'Button appears 3+ times',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.match(/Button/g) || []).length >= 3
        },
      },
      {
        id: 'uses-useState',
        description: 'Uses useState for state management',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'useState'),
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
    ],
  },

  // Eval 8: Adversarial edit — adding an icon to working code
  {
    id: 'canvas-v2-lint-adversarial-edit',
    name: 'Canvas V2 Lint: Add download to tracker (regression)',
    category: 'canvas-v2',
    tags: ['lint', 'edit', 'regression'],
    level: 3,
    useRuntimeTemplate: true,
    input: 'Add a download button to the tracker that exports data as CSV. Use a download icon.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/Tracker.tsx': WORKING_TRACKER_TSX,
    },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on Tracker',
        points: 15,
        phase: 'intention',
        validate: (r) => editedCodeFile(r, /[Tt]racker/),
      },
      {
        id: 'read-first',
        description: 'Read file before editing',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          const firstEditIdx = r.toolCalls.findIndex(t =>
            t.name === 'edit_file' && /[Tt]racker/.test(String((t.input as any).path ?? ''))
          )
          if (firstEditIdx === -1) return false
          return r.toolCalls.slice(0, firstEditIdx).some(t =>
            t.name === 'read_file' || t.name === 'exec' || t.name === 'read_lints'
          )
        },
      },
      {
        id: 'added-download-icon',
        description: 'Edit references a Lucide icon',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const edits = r.toolCalls.filter(t =>
            t.name === 'edit_file' && /[Tt]racker/.test(String((t.input as any).path ?? ''))
          )
          return edits.some(t => {
            const newStr = String((t.input as any).new_string ?? '')
            return /[A-Z][a-z]+[A-Z]/.test(newStr) || newStr.includes('Download')
          })
        },
      },
      {
        id: 'added-csv-logic',
        description: 'Edit contains CSV/download logic',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r).toLowerCase()
          return code.includes('csv') || code.includes('download') || code.includes('blob') || code.includes('createobjecturl')
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final code is lint-clean (last read_lints / inline lint / tsc verdict)',
        points: 25,
        phase: 'execution',
        validate: (r) => lastReadLintsClean(r),
      },
      {
        id: 'did-not-break-existing',
        description: 'Final Tracker.tsx still has state, table, add and totals',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = readWorkspaceFile(r, 'src/components/Tracker.tsx') || allWrittenCode(r)
          return code.includes('useState') && code.includes('<Table') && code.includes('addItem') && code.includes('totalHours')
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Used 10 or fewer tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },
]
