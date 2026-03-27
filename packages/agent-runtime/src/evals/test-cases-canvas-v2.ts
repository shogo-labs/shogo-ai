// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas V2 (Code Mode) Eval Test Cases
 *
 * Tests the agent's ability to build dynamic UIs using write_file/edit_file/delete_file
 * to canvas/*.js files instead of the v1 canvas_* tools.
 * These run against a REAL agent-runtime server — the agent decides what
 * tools to use, executes them, and we validate the actual results.
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool, responseContains } from './eval-helpers'

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
// Canvas-v2 validation helpers
// ---------------------------------------------------------------------------

/** True if write_file was called with a path matching canvas/*.js */
function wroteCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.js$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

/** True if write_file was called with a path matching canvas/*.data.json */
function wroteCanvasDataFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.data\.json$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

/** Concatenated content of all write_file calls targeting canvas/*.js (lowercased). */
function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '')
      return path.match(/^canvas\/[^/]+\.js$/)
    })
    .map(t => String((t.input as any).content ?? ''))
    .join('\n')
    .toLowerCase()
}

/** True if ALL write_file/edit_file calls to canvas/*.js contain every term (case-insensitive). */
function canvasCodeContains(r: EvalResult, ...terms: string[]): boolean {
  const code = allCanvasCode(r)
  if (!code) return false
  return terms.every(t => code.includes(t.toLowerCase()))
}

/** True if ANY write_file/edit_file call to canvas/*.js contains the term. */
function anyCanvasCodeContains(r: EvalResult, term: string): boolean {
  return allCanvasCode(r).includes(term.toLowerCase())
}

/** True if no canvas_* (v1) tools were called. */
function neverUsedV1CanvasTools(r: EvalResult): boolean {
  const v1Tools = ['canvas_create', 'canvas_update', 'canvas_data', 'canvas_api_schema',
    'canvas_api_seed', 'canvas_api_query', 'canvas_inspect', 'canvas_trigger_action']
  return v1Tools.every(t => neverUsedTool(r, t))
}

/** True if edit_file was called targeting canvas/*.js */
function editedCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.js$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

/** True if delete_file was called targeting canvas/*.js */
function deletedCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'delete_file') return false
    const path = String((t.input as any).path ?? '')
    if (!path.match(/^canvas\/[^/]+\.js$/)) return false
    return namePattern ? namePattern.test(path) : true
  })
}

/** Count of distinct canvas/*.js files written (by unique path). */
function canvasFileCount(r: EvalResult): number {
  const paths = new Set<string>()
  for (const t of r.toolCalls) {
    if (t.name !== 'write_file') continue
    const path = String((t.input as any).path ?? '')
    if (path.match(/^canvas\/[^/]+\.js$/)) paths.add(path)
  }
  return paths.size
}

/** JSON of all write_file/edit_file content targeting canvas/ (lowercased, for ad-hoc searches). */
function canvasCodeJson(r: EvalResult): string {
  return JSON.stringify(
    r.toolCalls
      .filter(t => t.name === 'write_file' || t.name === 'edit_file')
      .filter(t => {
        const path = String((t.input as any).path ?? '')
        return path.startsWith('canvas/')
      })
      .map(t => t.input)
  ).toLowerCase()
}

// ---------------------------------------------------------------------------
// Pre-seeded canvas files for edit/delete evals
// ---------------------------------------------------------------------------

const PRESEEDED_DASHBOARD_JS = `var metrics = [
  { label: 'Users', value: 1200 },
  { label: 'Revenue', value: '$32K' },
  { label: 'Sessions', value: 890 },
]

return h('div', { className: 'flex flex-col gap-6 p-2' }, [
  h('h2', { className: 'text-2xl font-semibold' }, 'Dashboard'),
  h(Row, { gap: 'md' },
    metrics.map(function(m, i) {
      return h(Metric, { key: i, label: m.label, value: m.value })
    })
  ),
])`

const PRESEEDED_SETTINGS_JS = `var _state = useState(false)
var darkMode = _state[0], setDarkMode = _state[1]

return h('div', { className: 'flex flex-col gap-4 p-2' }, [
  h('h2', { className: 'text-2xl font-semibold' }, 'Settings'),
  h(Card, {}, [
    h(CardContent, { className: 'flex items-center justify-between pt-6' }, [
      h(Label, {}, 'Dark Mode'),
      h(Switch, { checked: darkMode, onCheckedChange: setDarkMode }),
    ]),
  ]),
])`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CANVAS_V2_EVALS: AgentEval[] = [
  // ---- Level 1: Basic view-only creation ----
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
        id: 'wrote-canvas-js',
        description: 'Wrote to a canvas/*.js path',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r),
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
    id: 'canvas-v2-metrics-dashboard',
    name: 'Canvas V2: Metrics dashboard with key numbers',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 1,
    input: 'I need to see our key numbers — 1,500 users, $45K revenue, 342 active sessions. Build me a dashboard.',
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
        id: 'has-metric',
        description: 'Code uses Metric component',
        points: 20,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Metric'),
      },
      {
        id: 'has-data-values',
        description: 'Code references the data values (1500 or 45)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = canvasCodeJson(r)
          return code.includes('1500') || code.includes('1,500') || code.includes('45')
        },
      },
      {
        id: 'uses-h',
        description: 'Code uses h() not JSX angle brackets',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'h('),
      },
      {
        id: 'uses-var',
        description: 'Code uses var not const/let',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          if (!code) return false
          const hasVar = code.includes('var ')
          const hasConstLet = /\b(const|let)\s/.test(code)
          return hasVar && !hasConstLet
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=8)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  // ---- Level 2: Data-backed and multi-component ----
  {
    id: 'canvas-v2-expense-tracker',
    name: 'Canvas V2: Expense tracker with budget breakdown',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 2,
    input: 'Help me see where my team\'s money is going. We spent $4,230 of our $6,000 budget. Show a breakdown of recent expenses.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file for .js file',
        points: 15,
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
        id: 'wrote-data-file',
        description: 'Wrote a .data.json file for expense data',
        points: 15,
        phase: 'execution',
        validate: (r) => wroteCanvasDataFile(r),
      },
      {
        id: 'references-data-var',
        description: 'Code references data variable',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'data'),
      },
      {
        id: 'has-table-or-card',
        description: 'Code includes Table or Card component',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Table') || anyCanvasCodeContains(r, 'Card'),
      },
      {
        id: 'has-spend-data',
        description: 'Spend data appears in code or data files',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          return json.includes('4230') || json.includes('4,230') || json.includes('6000') || json.includes('6,000')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=10)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  {
    id: 'canvas-v2-crm-pipeline',
    name: 'Canvas V2: CRM sales pipeline',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 2,
    input: 'Show me my sales pipeline — leads in New, Qualified, and Closed stages with company name and score for each.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create canvas file',
        points: 15,
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
        id: 'has-stage-labels',
        description: 'Code or data has stage labels (New, Qualified, Closed)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          const hasStages = ['new', 'qualified', 'closed'].filter(s => json.includes(s))
          return hasStages.length >= 2
        },
      },
      {
        id: 'has-lead-company-fields',
        description: 'Code or data has lead and company fields',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          return (json.includes('company') || json.includes('name')) && (json.includes('lead') || json.includes('score'))
        },
      },
      {
        id: 'has-layout-components',
        description: 'Code uses layout components (Grid, Row, Column, or Card)',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Grid') || anyCanvasCodeContains(r, 'Row') || anyCanvasCodeContains(r, 'Column') || anyCanvasCodeContains(r, 'Card'),
      },
      {
        id: 'has-badge',
        description: 'Code uses Badge for status display',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Badge'),
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

  // ---- Level 2: Interactive stateful apps ----
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
          return (code.includes('onclick') || code.includes('onchange') || code.includes('function'))
            && (code.includes('setcount') || code.includes('set'))
        },
      },
      {
        id: 'uses-h',
        description: 'Code uses h() not JSX',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'h('),
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

  {
    id: 'canvas-v2-todo-list',
    name: 'Canvas V2: Interactive todo list',
    category: 'canvas-v2',
    tags: ['interactive'],
    level: 2,
    input: 'I want to track my todos — adding, completing, and deleting them. Throw in a few sample tasks to start.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create a canvas file',
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
        id: 'has-usestate',
        description: 'Code contains useState for todo state',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'useState'),
      },
      {
        id: 'has-add-delete',
        description: 'Code has add and delete/remove logic',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          const hasAdd = code.includes('push') || code.includes('concat') || code.includes('...') || code.includes('add')
          const hasDelete = code.includes('filter') || code.includes('splice') || code.includes('delete') || code.includes('remove')
          return hasAdd && hasDelete
        },
      },
      {
        id: 'has-input',
        description: 'Code has Input or text input element',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Input') || anyCanvasCodeContains(r, 'input'),
      },
      {
        id: 'has-button',
        description: 'Code contains Button component',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Button'),
      },
      {
        id: 'has-checkbox-or-toggle',
        description: 'Code contains Checkbox or strikethrough toggle',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Checkbox') || anyCanvasCodeContains(r, 'line-through') || anyCanvasCodeContains(r, 'completed') || anyCanvasCodeContains(r, 'done'),
      },
      {
        id: 'has-sample-data',
        description: 'Code has sample todo data in state initializer',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('usestate(') && (code.includes('[{') || code.includes('[\'') || code.includes('["'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Reasonable number of tool calls (<=8)',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
  },

  // ---- Level 3: Multi-surface and edit/delete ----
  {
    id: 'canvas-v2-multi-surface',
    name: 'Canvas V2: Multi-surface (dashboard + settings)',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 3,
    input: 'Build me an app with a dashboard tab showing metrics and a settings tab with toggle switches.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create canvas files',
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
        id: 'wrote-2-files',
        description: 'Wrote at least 2 distinct canvas/*.js files',
        points: 25,
        phase: 'execution',
        validate: (r) => canvasFileCount(r) >= 2,
      },
      {
        id: 'dashboard-file',
        description: 'One file name suggests dashboard',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r, /dashboard|metrics|overview/i),
      },
      {
        id: 'settings-file',
        description: 'One file name suggests settings',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r, /settings|config|preferences/i),
      },
      {
        id: 'has-switch-toggle',
        description: 'Code contains Switch or toggle element',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Switch') || anyCanvasCodeContains(r, 'toggle'),
      },
      {
        id: 'has-metric',
        description: 'Code contains Metric or numeric display',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Metric') || anyCanvasCodeContains(r, 'value'),
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

  {
    id: 'canvas-v2-edit-existing',
    name: 'Canvas V2: Edit existing dashboard with chart',
    category: 'canvas-v2',
    tags: ['interactive'],
    level: 3,
    input: 'The dashboard needs a chart showing the weekly trend. Add a line chart to it.',
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'canvas/dashboard.js': PRESEEDED_DASHBOARD_JS,
    },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-or-write',
        description: 'Used edit_file or write_file on the existing file',
        points: 20,
        phase: 'intention',
        validate: (r) => editedCanvasFile(r, /dashboard/) || wroteCanvasFile(r, /dashboard/),
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
        validate: (r) => {
          const code = allCanvasCode(r)
          return code.includes('metric')
        },
      },
      {
        id: 'targeted-dashboard',
        description: 'Wrote to canvas/dashboard.js specifically',
        points: 15,
        phase: 'execution',
        validate: (r) => editedCanvasFile(r, /dashboard/) || wroteCanvasFile(r, /dashboard/),
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
      'canvas/dashboard.js': PRESEEDED_DASHBOARD_JS,
      'canvas/settings.js': PRESEEDED_SETTINGS_JS,
    },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-delete-file',
        description: 'Used delete_file to remove a canvas file',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'delete_file'),
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
        description: 'Deleted canvas/settings.js specifically',
        points: 25,
        phase: 'execution',
        validate: (r) => deletedCanvasFile(r, /settings/),
      },
      {
        id: 'kept-dashboard',
        description: 'Did NOT delete canvas/dashboard.js',
        points: 20,
        phase: 'execution',
        validate: (r) => !deletedCanvasFile(r, /dashboard/),
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

  // ---- Level 4: Complex multi-turn ----
  {
    id: 'canvas-v2-social-analytics',
    name: 'Canvas V2: Social analytics dashboard (multi-turn)',
    category: 'canvas-v2',
    tags: ['view-only'],
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'Show me how our social media is doing.' },
      { role: 'assistant', content: 'I\'d love to help you visualize your social media performance! Could you share the metrics for your accounts? I\'ll need platform names, follower counts, and engagement rates to build a comprehensive dashboard.' },
    ],
    input: '@shogo_ai on Twitter has 12.4K followers and 4.2% engagement, @shogoai on Instagram has 8.1K and 6.1%, LinkedIn has 3.2K at 2.8%. Build me a dashboard with per-platform metrics, an engagement chart, and scheduled posts table.',
    workspaceFiles: { 'config.json': V2_CONFIG },
    initialMode: 'canvas',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to create canvas file',
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
        id: 'wrote-canvas-js',
        description: 'Wrote a canvas .js file',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteCanvasFile(r),
      },
      {
        id: 'references-platforms',
        description: 'Code or data references all 3 platforms',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = canvasCodeJson(r)
          const found = ['twitter', 'instagram', 'linkedin'].filter(p => json.includes(p))
          return found.length >= 3
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
            || code.includes('areachart')
        },
      },
      {
        id: 'has-table',
        description: 'Code contains Table or table-like display',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Table'),
      },
      {
        id: 'has-metric',
        description: 'Code contains Metric or metric-like cards',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCanvasCodeContains(r, 'Metric') || anyCanvasCodeContains(r, 'Card'),
      },
      {
        id: 'has-data',
        description: 'Wrote .data.json or embedded data in code',
        points: 10,
        phase: 'execution',
        validate: (r) => wroteCanvasDataFile(r) || anyCanvasCodeContains(r, '12.4') || anyCanvasCodeContains(r, '12400'),
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
