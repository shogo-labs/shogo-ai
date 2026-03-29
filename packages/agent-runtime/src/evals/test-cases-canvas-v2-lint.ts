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
import type { ToolMockMap } from './tool-mocks'
import { usedTool, neverUsedTool } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

const SKILL_SERVER_MOCKS: ToolMockMap = {
  exec: { type: 'static', response: 'Done.' },
  web: {
    type: 'pattern',
    patterns: [
      { match: { url: '/api/', method: 'POST' }, response: JSON.stringify({ id: 'new-1', createdAt: '2026-03-26T00:00:00Z' }) },
      { match: { url: '/api/', method: 'PATCH' }, response: JSON.stringify({ id: 'new-1', updatedAt: '2026-03-26T00:00:00Z' }) },
      { match: { url: '/api/', method: 'DELETE' }, response: JSON.stringify({ deleted: true }) },
      { match: { url: '/api/' }, response: JSON.stringify([]) },
    ],
    default: JSON.stringify([]),
  },
}

const LINT_ANTI_PATTERNS = [
  'used v1 canvas tools instead of file tools',
  'wrote JSX syntax instead of h() calls',
  'ignored lint errors and responded without fixing',
]

// ---------------------------------------------------------------------------
// Canvas-v2 validation helpers (shared with test-cases-canvas-v2.ts)
// ---------------------------------------------------------------------------

const CANVAS_CODE_RE = /^canvas\/[^/]+\.(js|jsx|ts|tsx)$/

function wroteCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.ts$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '')
      return path.match(/^canvas\/[^/]+\.ts$/)
    })
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
}

function anyCanvasCodeContains(r: EvalResult, term: string): boolean {
  return allCanvasCode(r).toLowerCase().includes(term.toLowerCase())
}

function neverUsedV1CanvasTools(r: EvalResult): boolean {
  const v1Tools = ['canvas_create', 'canvas_update', 'canvas_data', 'canvas_api_schema',
    'canvas_api_seed', 'canvas_api_query', 'canvas_inspect', 'canvas_trigger_action']
  return v1Tools.every(t => neverUsedTool(r, t))
}

function editedCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.ts$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function canvasFileCount(r: EvalResult): number {
  const paths = new Set<string>()
  for (const t of r.toolCalls) {
    if (t.name !== 'write_file') continue
    const path = String((t.input as any).path ?? '')
    if (path.match(/^canvas\/[^/]+\.ts$/)) paths.add(path)
  }
  return paths.size
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .some(t => String((t.input as any).content ?? '').includes(`model ${modelName}`))
}

function canvasCodeFetches(r: EvalResult): boolean {
  const code = allCanvasCode(r).toLowerCase()
  return code.includes('fetch(') && (code.includes('localhost:') || code.includes('/api/'))
}

// ---------------------------------------------------------------------------
// Lint-specific validation helpers (read_lints-based)
// ---------------------------------------------------------------------------

function usedReadLints(r: EvalResult): boolean {
  return r.toolCalls.some(t => t.name === 'read_lints')
}

function lastReadLintsClean(r: EvalResult): boolean {
  const lintCalls = r.toolCalls.filter(t => t.name === 'read_lints')
  if (lintCalls.length === 0) return false
  const last = lintCalls[lintCalls.length - 1]
  try {
    const out = typeof last.output === 'string' ? JSON.parse(last.output) : last.output
    return out?.ok === true
  } catch { return false }
}

function selfCorrectedIfNeeded(r: EvalResult): boolean {
  const lintCalls = r.toolCalls.filter(t => t.name === 'read_lints')
  const firstWithErrors = lintCalls.findIndex(t => {
    try {
      const out = typeof t.output === 'string' ? JSON.parse(t.output) : t.output
      return out?.ok === false
    } catch { return false }
  })
  if (firstWithErrors === -1) return true
  return lintCalls.slice(firstWithErrors + 1).some(t => {
    try {
      const out = typeof t.output === 'string' ? JSON.parse(t.output) : t.output
      return out?.ok === true
    } catch { return false }
  })
}

// Aliases for backward-compatible naming in eval criteria
const lastCanvasWriteIsClean = lastReadLintsClean
const usedCanvasLint = usedReadLints
const allCanvasWritesClean = lastReadLintsClean

function countDistinctIconRefs(r: EvalResult): number {
  const code = allCanvasCode(r)
  const iconPattern = /h\(\s*([A-Z][a-zA-Z]+)\s*,/g
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
    'RechartsTooltip', 'Legend', 'Fragment',
    'Column', 'Row', 'Grid', 'CanvasCard', 'CanvasScrollArea',
    'Metric', 'DataList', 'DynText', 'DynBadge', 'DynImage', 'DynIcon',
    'DynTable', 'DynChart', 'DynTabs', 'DynTabPanel', 'DynAccordion', 'DynAccordionItem',
  ])
  const icons = new Set<string>()
  let match
  while ((match = iconPattern.exec(code)) !== null) {
    if (!uiComponents.has(match[1])) icons.add(match[1])
  }
  return icons.size
}

// ---------------------------------------------------------------------------
// Pre-seeded canvas files for edit evals
// ---------------------------------------------------------------------------

const BROKEN_DASHBOARD_JS = `var _countState = useState(0)
var count = _countState[0], setCount = _countState[1]

var _savedState = useLocalStorage('dashboard-prefs', {})
var prefs = _savedState[0], setPrefs = _savedState[1]

var metrics = [
  { label: 'Users', value: 1234 },
  { label: 'Revenue', value: '$45K' },
  { label: 'Growth', value: '+12%' },
]

function handleRefresh() {
  setCount(count + 1)
}

return h('div', { className: 'flex flex-col gap-6 p-4' }, [
  h('div', { className: 'flex items-center justify-between' }, [
    h('h2', { className: 'text-2xl font-semibold' }, 'Dashboard'),
    h(Button, { onClick: handleRefresh }, [
      h(RefreshCcw, { className: 'w-4 h-4 mr-2' }),
      'Refresh (' + count + ')'
    ]),
  ]),
  h(Card, {}, [
    h(CardHeader, {}, [
      h(CardTitle, {}, 'Metrics'),
      h(CardDescrption, {}, 'Key performance indicators'),
    ]),
    h(CardContent, {},
      h('div', { className: 'grid grid-cols-3 gap-4' },
        metrics.map(function(m, i) {
          return h('div', { key: i, className: 'text-center' }, [
            h('p', { className: 'text-2xl font-bold' }, m.value),
            h('p', { className: 'text-sm text-muted-foreground' }, m.label),
          ])
        })
      )
    ),
  ]),
])`

const WORKING_TRACKER_JS = `var _items = useState([
  { id: 1, name: 'Task A', status: 'active', hours: 3.5 },
  { id: 2, name: 'Task B', status: 'completed', hours: 7.0 },
  { id: 3, name: 'Task C', status: 'active', hours: 1.5 },
  { id: 4, name: 'Task D', status: 'paused', hours: 2.0 },
])
var items = _items[0], setItems = _items[1]

var _newName = useState('')
var newName = _newName[0], setNewName = _newName[1]

function addItem() {
  if (!newName.trim()) return
  var next = { id: Date.now(), name: newName, status: 'active', hours: 0 }
  setItems(items.concat([next]))
  setNewName('')
}

var totalHours = items.reduce(function(sum, i) { return sum + i.hours }, 0)

return h('div', { className: 'flex flex-col gap-6 p-4' }, [
  h('h2', { className: 'text-2xl font-semibold' }, 'Time Tracker'),
  h(Card, {}, [
    h(CardContent, { className: 'pt-6' }, [
      h('div', { className: 'flex gap-2 mb-4' }, [
        h(Input, { value: newName, onChange: function(e) { setNewName(e.target.value) }, placeholder: 'New task name' }),
        h(Button, { onClick: addItem }, 'Add'),
      ]),
      h(Table, {}, [
        h(TableHeader, {}, h(TableRow, {}, [
          h(TableHead, {}, 'Name'),
          h(TableHead, {}, 'Status'),
          h(TableHead, {}, 'Hours'),
        ])),
        h(TableBody, {},
          items.map(function(item) {
            return h(TableRow, { key: item.id }, [
              h(TableCell, {}, item.name),
              h(TableCell, {}, h(Badge, { variant: item.status === 'completed' ? 'default' : 'secondary' }, item.status)),
              h(TableCell, {}, item.hours.toFixed(1)),
            ])
          })
        ),
      ]),
      h('p', { className: 'text-sm text-muted-foreground mt-4' }, 'Total: ' + totalHours.toFixed(1) + ' hours'),
    ]),
  ]),
])`

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
    input: 'Build a file manager with icons for each action: upload, download, trash, copy, search, folder, settings gear, refresh, and sort arrows. Every action should have a labeled icon button.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-canvas-file',
        description: 'Wrote canvas/*.ts file',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'uses-multiple-icons',
        description: 'Canvas code references 5+ distinct Lucide icons',
        points: 20,
        phase: 'execution',
        validate: (r) => countDistinctIconRefs(r) >= 5,
      },
      {
        id: 'has-button-for-each',
        description: 'Button appears 5+ times in canvas code',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return (code.match(/Button/g) || []).length >= 5
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
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
    input: 'Build an analytics dashboard with: a dual-axis line+bar chart (revenue line, orders bars, shared X axis), a donut chart for traffic sources, and a stacked area chart for daily active users by platform (iOS, Android, Web). Use real-looking sample data.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-canvas-file',
        description: 'Wrote canvas/*.ts file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
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
          const code = allCanvasCode(r)
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
          const code = allCanvasCode(r)
          return (code.match(/\{/g) || []).length >= 10
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
      },
      {
        id: 'self-corrected-if-needed',
        description: 'Self-corrected lint errors if any occurred',
        points: 15,
        phase: 'execution',
        validate: (r) => selfCorrectedIfNeeded(r),
      },
      {
        id: 'uses-h-correctly',
        description: 'Uses h() calls, no raw JSX',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('h(') && !/<[A-Z][a-zA-Z]+/.test(code)
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
    input: 'Build a settings panel with: an accordion for sections, a dialog for confirming changes, tooltips on every setting, a dropdown menu for theme selection, a sheet sliding in from the right for advanced options, and a popover for color picker. Use all of these exact UI patterns.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-canvas-file',
        description: 'Wrote canvas/*.ts file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
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
          const code = allCanvasCode(r)
          return code.includes('Accordion') && code.includes('AccordionItem') && code.includes('AccordionTrigger')
        },
      },
      {
        id: 'uses-dialog',
        description: 'Uses Dialog + DialogContent + DialogTitle',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('Dialog') && code.includes('DialogContent') && code.includes('DialogTitle')
        },
      },
      {
        id: 'uses-tooltip',
        description: 'Uses TooltipProvider + Tooltip + TooltipTrigger + TooltipContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('TooltipProvider') && code.includes('Tooltip') && code.includes('TooltipTrigger') && code.includes('TooltipContent')
        },
      },
      {
        id: 'uses-dropdown',
        description: 'Uses DropdownMenu + Trigger + Content',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('DropdownMenu') && code.includes('DropdownMenuTrigger') && code.includes('DropdownMenuContent')
        },
      },
      {
        id: 'uses-sheet',
        description: 'Uses Sheet + SheetContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('Sheet') && code.includes('SheetContent')
        },
      },
      {
        id: 'uses-popover',
        description: 'Uses Popover + PopoverTrigger + PopoverContent',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('Popover') && code.includes('PopoverTrigger') && code.includes('PopoverContent')
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write is lint-clean',
        points: 20,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
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
    input: 'The dashboard preview is broken. Fix whatever is wrong with it.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/dashboard.ts': BROKEN_DASHBOARD_JS,
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
            t.name === 'read_file' || t.name === 'grep' || t.name === 'read_lints'
          )
        },
      },
      {
        id: 'used-read-lints',
        description: 'Called read_lints at some point',
        points: 15,
        phase: 'intention',
        validate: (r) => usedReadLints(r),
      },
      {
        id: 'fixed-icon-name',
        description: 'Fixed RefreshCcw to a valid icon',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'edit_file') return false
            const oldStr = String((t.input as any).old_string ?? '')
            return oldStr.includes('RefreshCcw')
          })
        },
      },
      {
        id: 'fixed-component-name',
        description: 'Fixed CardDescrption to CardDescription',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'edit_file') return false
            const oldStr = String((t.input as any).old_string ?? '')
            const newStr = String((t.input as any).new_string ?? '')
            return oldStr.includes('CardDescrption') && newStr.includes('CardDescription')
          })
        },
      },
      {
        id: 'fixed-hook',
        description: 'Fixed or removed useLocalStorage',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'edit_file') return false
            const oldStr = String((t.input as any).old_string ?? '')
            return oldStr.includes('useLocalStorage')
          })
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas edit is lint-clean',
        points: 15,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
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

  // Eval 5: Three interconnected canvases
  {
    id: 'canvas-v2-lint-multi-surface-consistency',
    name: 'Canvas V2 Lint: Multi-surface project management',
    category: 'canvas-v2',
    tags: ['lint', 'multi-surface', 'complex'],
    level: 4,
    input: 'Build a project management app with 3 pages: (1) a dashboard showing project metrics and a chart, (2) a team members page with a table and add-member form, (3) a settings page with theme toggle and notification preferences. Each page should have its own canvas file.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-three-surfaces',
        description: 'Wrote 3+ distinct canvas files',
        points: 15,
        phase: 'intention',
        validate: (r) => canvasFileCount(r) >= 3,
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'dashboard-has-chart',
        description: 'Dashboard canvas has a chart component',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /canvas\/dashboard/.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n').toLowerCase()
          return code.includes('chart') || code.includes('responsivecontainer')
        },
      },
      {
        id: 'team-has-table',
        description: 'Team canvas has Table component',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /canvas\/team/.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n')
          return code.includes('Table')
        },
      },
      {
        id: 'settings-has-switch',
        description: 'Settings canvas has Switch or Checkbox',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const writes = r.toolCalls.filter(t =>
            t.name === 'write_file' && /canvas\/setting/.test(String((t.input as any).path ?? ''))
          )
          const code = writes.map(t => String((t.input as any).content ?? '')).join('\n')
          return code.includes('Switch') || code.includes('Checkbox')
        },
      },
      {
        id: 'all-surfaces-lint-clean',
        description: 'All canvas writes are lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => allCanvasWritesClean(r),
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
    input: 'Build a real-time notification center that fetches notifications from /api/notifications, groups them by type (info, warning, error), shows unread count badges, and lets me mark them as read. Use optimistic updates when marking as read.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
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
        id: 'wrote-canvas-file',
        description: 'Wrote canvas/*.ts file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
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
          const code = allCanvasCode(r)
          return code.includes('useState') && code.includes('useEffect') && code.includes('useCallback')
        },
      },
      {
        id: 'code-fetches',
        description: 'Canvas code fetches from API',
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
          const code = allCanvasCode(r).toLowerCase()
          return code.includes('filter') || code.includes('reduce') || code.includes('group')
        },
      },
      {
        id: 'has-badge-count',
        description: 'Code uses Badge component',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Badge'),
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
      },
    ],
  },

  // Eval 7: var/function scoping traps
  {
    id: 'canvas-v2-lint-var-scope-traps',
    name: 'Canvas V2 Lint: Pomodoro timer (scoping traps)',
    category: 'canvas-v2',
    tags: ['lint', 'scoping', 'interactive'],
    level: 4,
    input: 'Build a pomodoro timer with start/pause/reset buttons, a circular progress indicator, and session history. The timer should count down from 25 minutes.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-canvas-file',
        description: 'Wrote canvas/*.ts file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas tools',
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
          const code = allCanvasCode(r)
          return code.includes('setInterval') || code.includes('setTimeout')
        },
      },
      {
        id: 'has-useeffect-cleanup',
        description: 'useEffect with clearInterval/clearTimeout cleanup',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('useEffect') &&
            (code.includes('clearInterval') || code.includes('clearTimeout') || code.includes('return function'))
        },
      },
      {
        id: 'has-buttons',
        description: 'Button appears 3+ times',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return (code.match(/Button/g) || []).length >= 3
        },
      },
      {
        id: 'uses-var-not-const',
        description: 'Uses var for top-level declarations (not const/let)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          const varCount = (code.match(/^var\s/gm) || []).length
          return varCount >= 2
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
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
    input: 'Add a download button to the tracker that exports data as CSV. Use a download icon.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/tracker.ts': WORKING_TRACKER_JS,
    },
    initialMode: 'canvas',
    antiPatterns: LINT_ANTI_PATTERNS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-file',
        description: 'Used edit_file on tracker',
        points: 15,
        phase: 'intention',
        validate: (r) => editedCanvasFile(r, /tracker/),
      },
      {
        id: 'read-first',
        description: 'Read file before editing',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          const firstEditIdx = r.toolCalls.findIndex(t =>
            t.name === 'edit_file' && String((t.input as any).path ?? '').includes('tracker')
          )
          if (firstEditIdx === -1) return false
          return r.toolCalls.slice(0, firstEditIdx).some(t =>
            t.name === 'read_file' || t.name === 'grep' || t.name === 'read_lints'
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
            t.name === 'edit_file' && String((t.input as any).path ?? '').includes('tracker')
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
          const code = allCanvasCode(r).toLowerCase()
          return code.includes('csv') || code.includes('download') || code.includes('blob') || code.includes('createobjecturl')
        },
      },
      {
        id: 'no-lint-errors-in-final',
        description: 'Final canvas write/edit is lint-clean',
        points: 25,
        phase: 'execution',
        validate: (r) => lastCanvasWriteIsClean(r),
      },
      {
        id: 'did-not-break-existing',
        description: 'Core tracker elements still present',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('useState') && (code.includes('Table') || code.includes('Card'))
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
