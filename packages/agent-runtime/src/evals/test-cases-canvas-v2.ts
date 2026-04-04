// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas V2 (Code Mode) Eval Test Cases — Full-Stack
 *
 * Tests the agent's ability to build fully-connected apps using:
 * - write_file/edit_file/delete_file for src/ React (TSX) code
 * - .shogo/server/schema.prisma for Prisma-backed REST backend
 * - fetch() in canvas code to connect frontend to skill server
 *
 * These run against a REAL agent-runtime server — the agent decides what
 * tools to use, executes them, and we validate the actual results.
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import { usedTool, neverUsedTool, responseContains, toolCallArgsContain } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared config — every eval seeds canvasMode: 'code' + activeMode: 'canvas'
// ---------------------------------------------------------------------------

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

// ---------------------------------------------------------------------------
// Tool mocks for full-stack evals (skill server)
// ---------------------------------------------------------------------------

const SKILL_SERVER_MOCKS: ToolMockMap = {
  exec: {
    type: 'static',
    response: 'Done.',
  },
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

// ---------------------------------------------------------------------------
// Canvas-v2 validation helpers
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!isCodeFile(path)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function wroteCanvasDataFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/\.(data\.json|json)$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '')
      return isCodeFile(path)
    })
    .map(t => {
      const inp = t.input as any
      return String(inp.content ?? inp.new_string ?? '')
    })
    .join('\n')
    .toLowerCase()
}

function anyCanvasCodeContains(r: EvalResult, term: string): boolean {
  return allCanvasCode(r).includes(term.toLowerCase())
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
    if (!isCodeFile(path)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

function deletedCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name === 'delete_file') {
      const path = String((t.input as any).path ?? '')
      if (!isCodeFile(path)) return false
      return namePattern ? namePattern.test(path) : true
    }
    if (t.name === 'exec') {
      const cmd = String((t.input as any).command ?? '')
      if (!cmd.match(/\brm\s/)) return false
      return namePattern ? namePattern.test(cmd) : true
    }
    return false
  })
}

function canvasFileCount(r: EvalResult): number {
  const paths = new Set<string>()
  for (const t of r.toolCalls) {
    if (t.name !== 'write_file') continue
    const path = String((t.input as any).path ?? '')
    if (isCodeFile(path)) paths.add(path)
  }
  return paths.size
}

function canvasCodeJson(r: EvalResult): string {
  return JSON.stringify(
    r.toolCalls
      .filter(t => t.name === 'write_file' || t.name === 'edit_file')
      .filter(t => {
        const path = String((t.input as any).path ?? '')
        return isCodeFile(path)
      })
      .map(t => t.input)
  ).toLowerCase()
}

// ---------------------------------------------------------------------------
// Full-stack validation helpers
// ---------------------------------------------------------------------------

/** True if write_file was called targeting .shogo/server/schema.prisma */
function wroteSkillServerSchema(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    return path.includes('schema.prisma')
  })
}

/** True if the schema.prisma content contains the given model name */
function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .some(t => {
      const content = String((t.input as any).content ?? '')
      return content.includes(`model ${modelName}`)
    })
}

/** True if canvas code uses fetch() to call the skill server */
function canvasCodeFetches(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return code.includes('fetch(') && (code.includes('localhost:') || code.includes('/api/'))
}

/** True if canvas code has a loading state pattern (useState for loading or Skeleton) */
function canvasHasLoadingState(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return (code.includes('loading') && code.includes('usestate')) || code.includes('skeleton')
}

// ---------------------------------------------------------------------------
// Pre-seeded canvas files for edit/delete evals
// ---------------------------------------------------------------------------

const PRESEEDED_DASHBOARD_TSX = `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const metrics = [
  { label: 'Users', value: '1,200' },
  { label: 'Revenue', value: '$32K' },
  { label: 'Sessions', value: '890' },
]

export default function Dashboard() {
  return (
    <div className="flex flex-col gap-6 p-4">
      <h2 className="text-2xl font-semibold">Dashboard</h2>
      <div className="grid grid-cols-3 gap-4">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardHeader><CardTitle>{m.label}</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-bold">{m.value}</p></CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}`

const PRESEEDED_SETTINGS_TSX = `import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export default function Settings() {
  const [darkMode, setDarkMode] = useState(false)

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-2xl font-semibold">Settings</h2>
      <Card>
        <CardContent className="flex items-center justify-between pt-6">
          <Label>Dark Mode</Label>
          <Switch checked={darkMode} onCheckedChange={setDarkMode} />
        </CardContent>
      </Card>
    </div>
  )
}`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CANVAS_V2_EVALS: AgentEval[] = [
  // ---- Level 1: Simple display-only ----
  {
    id: 'canvas-v2-weather-display',
    name: 'Canvas V2: Build weather display',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 1,
    input: 'What\'s the weather like in San Francisco? Show me something nice — it\'s 72°F and sunny out.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create a canvas file',
        points: 20,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 20,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'references-temp',
        description: 'Code references temperature data',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          return json.includes('72') || json.includes('temp')
        },
      },
      {
        id: 'uses-jsx',
        description: 'Code uses JSX syntax',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, '<div') || anyCanvasCodeContains(r, '<card') || anyCanvasCodeContains(r, 'return ('),
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms the canvas was built',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'weather') || responseContains(r, 'display') || responseContains(r, 'canvas') || responseContains(r, 'dashboard'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=8)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  {
    id: 'canvas-v2-team-roster',
    name: 'Canvas V2: Team roster display',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 1,
    input: 'Show me our team: 5 engineers, 2 designers, 1 PM with their names and roles. Make it look nice.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create a canvas file',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 15,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-team-data',
        description: 'Code has team member data with names',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('engineer') || code.includes('designer') || code.includes('pm')
        },
      },
      {
        id: 'has-table-or-card',
        description: 'Code uses Table or Card to display team',
        points: 20,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Table') || anyCanvasCodeContains(r, 'Card'),
      },
      {
        id: 'uses-jsx',
        description: 'Code uses JSX syntax',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, '<div') || anyCanvasCodeContains(r, '<card') || anyCanvasCodeContains(r, 'return ('),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=8)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  // ---- Level 2: Interactive (no backend) ----
  {
    id: 'canvas-v2-counter-app',
    name: 'Canvas V2: Interactive counter app',
    category: 'canvas-v2',
    tags: ['interactive'],
    level: 2,
    input: 'Build me a counter that I can increment and decrement with buttons. Start at 0.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create a canvas file',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 15,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-usestate',
        description: 'Code contains useState for state management',
        points: 20,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'useState'),
      },
      {
        id: 'has-button',
        description: 'Code contains Button component',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Button'),
      },
      {
        id: 'has-click-handler',
        description: 'Code has click handler with counter logic',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return (code.includes('onclick') || code.includes('function'))
            && (code.includes('setcount') || code.includes('set'))
        },
      },
      {
        id: 'uses-jsx',
        description: 'Code uses JSX syntax',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, '<div') || anyCanvasCodeContains(r, '<button') || anyCanvasCodeContains(r, 'return ('),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=6)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 6,
      },
    ],
  },

  // ---- Level 2: Full-stack with skill server ----
  {
    id: 'canvas-v2-lead-tracker',
    name: 'Canvas V2: Lead tracker with backend',
    category: 'canvas-v2',
    tags: ['full-stack'],
    level: 2,
    input: 'Build me a lead tracker. I need to add new leads with name, email, and status, and see them in a table.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote .shogo/server/schema.prisma with Lead model',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteSkillServerSchema(r) && schemaContainsModel(r, 'Lead'),
      },
      {
        id: 'wrote-canvas',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'code-fetches',
        description: 'Canvas code uses fetch() to call skill server',
        points: 20,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'has-usestate-useeffect',
        description: 'Code uses useState + useEffect for data loading',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'useState') && anyCanvasCodeContains(r, 'useEffect'),
      },
      {
        id: 'has-form-input',
        description: 'Code has Input or form for adding leads',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Input') || anyCanvasCodeContains(r, 'input'),
      },
      {
        id: 'has-table',
        description: 'Code has Table to display leads',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Table'),
      },
    ],
  },

  {
    id: 'canvas-v2-bookmark-manager',
    name: 'Canvas V2: Bookmark manager with backend',
    category: 'canvas-v2',
    tags: ['full-stack'],
    level: 2,
    input: 'I want a bookmark manager where I can save URLs with a title and tags, and search through them.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote schema.prisma with Bookmark model',
        points: 15,
        phase: 'intention',
        validate: (r) => wroteSkillServerSchema(r) && schemaContainsModel(r, 'Bookmark'),
      },
      {
        id: 'wrote-canvas',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'code-fetches',
        description: 'Canvas code uses fetch() for CRUD',
        points: 15,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'has-search-filter',
        description: 'Code has search or filter functionality',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('filter') || code.includes('search') || code.includes('query')
        },
      },
      {
        id: 'has-url-input',
        description: 'Code has Input for URL entry',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Input') || anyCanvasCodeContains(r, 'input'),
      },
      {
        id: 'has-tags',
        description: 'Code or schema references tags',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          return json.includes('tag')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=10)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // ---- Level 3: Complex full-stack + charts ----
  {
    id: 'canvas-v2-expense-dashboard',
    name: 'Canvas V2: Expense dashboard with chart',
    category: 'canvas-v2',
    tags: ['full-stack'],
    level: 3,
    input: 'Build an expense tracking dashboard. I need to add expenses with amount, category, and date, see a breakdown by category, and a chart of spending over time.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote schema.prisma with Expense model',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSkillServerSchema(r) && schemaContainsModel(r, 'Expense'),
      },
      {
        id: 'wrote-canvas',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-chart',
        description: 'Code contains a chart component (Recharts)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('responsivecontainer') || code.includes('barchart')
            || code.includes('linechart') || code.includes('piechart')
            || code.includes('areachart')
        },
      },
      {
        id: 'has-table-or-list',
        description: 'Code has Table or list for expenses',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Table') || anyCanvasCodeContains(r, 'DataList'),
      },
      {
        id: 'has-form',
        description: 'Code has form inputs for adding expenses',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Input') || anyCanvasCodeContains(r, 'input'),
      },
      {
        id: 'code-fetches',
        description: 'Canvas code fetches from skill server',
        points: 15,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'has-loading-state',
        description: 'Code has loading state pattern',
        points: 10,
        phase: 'execution',
        validate: (r) => canvasHasLoadingState(r),
      },
    ],
  },

  {
    id: 'canvas-v2-project-board',
    name: 'Canvas V2: Kanban project board',
    category: 'canvas-v2',
    tags: ['full-stack'],
    level: 3,
    input: 'Build a kanban-style project board with Todo, In Progress, and Done columns. I should be able to add tasks and move them between columns.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote schema.prisma with Task model',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSkillServerSchema(r) && schemaContainsModel(r, 'Task'),
      },
      {
        id: 'wrote-canvas',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-columns',
        description: 'Code has column layout for kanban stages',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return (code.includes('todo') || code.includes('to do'))
            && (code.includes('in progress') || code.includes('inprogress') || code.includes('in_progress'))
            && code.includes('done')
        },
      },
      {
        id: 'has-move-logic',
        description: 'Code has move/status-change logic',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('status') && (code.includes('patch') || code.includes('move') || code.includes('setstatus'))
        },
      },
      {
        id: 'has-add-task',
        description: 'Code has form/input for adding tasks',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Input') || anyCanvasCodeContains(r, 'input'),
      },
      {
        id: 'code-fetches',
        description: 'Canvas code fetches from skill server',
        points: 10,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=12)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  // ---- Level 3: Edit/Delete operations ----
  {
    id: 'canvas-v2-edit-existing',
    name: 'Canvas V2: Edit existing dashboard with chart',
    category: 'canvas-v2',
    tags: ['interactive'],
    level: 3,
    input: 'The dashboard needs a chart showing the weekly trend. Add a line chart to it.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/Dashboard.tsx': PRESEEDED_DASHBOARD_TSX,
    },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-or-write',
        description: 'Used edit_file or write_file on the existing file',
        points: 20,
        phase: 'intention',
        validate: (r) => editedCanvasFile(r, /dashboard/i) || wroteCanvasFile(r, /dashboard/i),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-chart',
        description: 'Canvas code now contains a chart component',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('linechart') || code.includes('areachart')
            || code.includes('barchart') || code.includes('chart')
            || code.includes('responsivecontainer')
        },
      },
      {
        id: 'kept-metrics',
        description: 'Did NOT delete the pre-existing Metric content',
        points: 15,
        phase: 'execution',
        validate: (r) => allCanvasCode(r).includes('metric'),
      },
      {
        id: 'targeted-dashboard',
        description: 'Wrote to Dashboard.tsx specifically',
        points: 15,
        phase: 'execution',
        validate: (r) => editedCanvasFile(r, /dashboard/i) || wroteCanvasFile(r, /dashboard/i),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=8)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  {
    id: 'canvas-v2-delete-surface',
    name: 'Canvas V2: Delete settings page',
    category: 'canvas-v2',
    tags: ['interactive'],
    level: 3,
    input: 'Remove the settings page, I don\'t need it anymore.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/Dashboard.tsx': PRESEEDED_DASHBOARD_TSX,
      'src/components/Settings.tsx': PRESEEDED_SETTINGS_TSX,
    },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-delete-file',
        description: 'Deleted a canvas file (delete_file or exec rm)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'delete_file') || deletedCanvasFile(r, /settings/i),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'deleted-settings',
        description: 'Deleted Settings.tsx specifically',
        points: 25,
        phase: 'execution',
        validate: (r) => deletedCanvasFile(r, /settings/i),
      },
      {
        id: 'kept-dashboard',
        description: 'Did NOT delete Dashboard.tsx',
        points: 20,
        phase: 'execution',
        validate: (r) => !deletedCanvasFile(r, /dashboard/i),
      },
      {
        id: 'response-confirms',
        description: 'Response confirms deletion',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'remov') || responseContains(r, 'delet') || responseContains(r, 'settings'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=5)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 5,
      },
    ],
  },

  // ---- Level 4: Complex multi-turn full-stack ----
  {
    id: 'canvas-v2-crm-dashboard',
    name: 'Canvas V2: CRM dashboard (multi-turn)',
    category: 'canvas-v2',
    tags: ['full-stack'],
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I need a CRM to track my sales pipeline.' },
      { role: 'assistant', content: 'I\'d love to help you build a CRM pipeline! To build the best dashboard for you, could you tell me what stages your deals go through and what information you track per deal?' },
    ],
    input: 'Stages: New, Qualified, Proposal, Closed Won, Closed Lost. Each deal has a company name, deal value in dollars, and contact person. Build the full thing with a pipeline view, summary metrics, and a chart showing value by stage.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    toolMocks: SKILL_SERVER_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote schema.prisma with Deal model',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteSkillServerSchema(r) && schemaContainsModel(r, 'Deal'),
      },
      {
        id: 'wrote-canvas',
        description: 'Wrote src/*.tsx file',
        points: 10,
        phase: 'intention',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'never-v1',
        description: 'Never used v1 canvas_* tools',
        points: 10,
        phase: 'intention',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'has-stages',
        description: 'Code references pipeline stages',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          const stages = ['new', 'qualified', 'proposal', 'closed won', 'closed lost'].filter(s => json.includes(s))
          return stages.length >= 3
        },
      },
      {
        id: 'has-chart',
        description: 'Code contains a chart component',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('responsivecontainer') || code.includes('barchart')
            || code.includes('linechart') || code.includes('piechart')
        },
      },
      {
        id: 'has-metrics',
        description: 'Code contains Metric or summary cards',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Metric') || anyCanvasCodeContains(r, 'value'),
      },
      {
        id: 'code-fetches',
        description: 'Canvas code fetches from skill server',
        points: 10,
        phase: 'execution',
        validate: (r) => canvasCodeFetches(r),
      },
      {
        id: 'has-deal-fields',
        description: 'Code or schema references company and value',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          return json.includes('company') && (json.includes('value') || json.includes('amount'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=12)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },
]
