/**
 * Canvas Eval Test Cases
 *
 * Tests the agent's ability to build dynamic UIs using canvas_* tools.
 * These run against a REAL agent-runtime server — the agent decides what
 * tools to use, executes them, and we validate the actual results.
 *
 * Validation queries the /agent/dynamic-app/state endpoint to verify
 * surfaces, components, and data bindings actually exist.
 */

import type { AgentEval, EvalResult, ValidationPhase } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usedTool(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName)
}

function toolCallCount(result: EvalResult, toolName: string): number {
  return result.toolCalls.filter(t => t.name === toolName).length
}

function canvasState(result: EvalResult): any {
  const stateCall = result.toolCalls.find(t =>
    t.name === 'canvas_create' || t.name === 'canvas_update' || t.name === 'canvas_data'
  )
  return stateCall?.output
}

function responseContains(result: EvalResult, ...terms: string[]): boolean {
  const text = result.responseText.toLowerCase()
  return terms.every(t => text.includes(t.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CANVAS_EVALS: AgentEval[] = [
  // ---- Level 1: Basic surface creation ----
  {
    id: 'canvas-basic-weather',
    name: 'Canvas: Build weather display',
    category: 'canvas',
    level: 1,
    input: 'Show me the current weather for San Francisco on a canvas. Use fake data — 72°F and sunny.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Used canvas_create to create a surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to add components',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data to populate data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data'),
      },
      {
        id: 'canvas-has-temp',
        description: 'Response or tool calls reference temperature',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('72') || json.includes('temp')
        },
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms the canvas was built',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'canvas') || responseContains(r, 'weather') || responseContains(r, 'display'),
      },
      {
        id: 'no-excessive-tools',
        description: 'Used a reasonable number of tool calls (<= 8)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 8,
      },
    ],
    antiPatterns: ['Repeated identical tool calls (loop)'],
  },

  // ---- Level 2: Dashboard with multiple components ----
  {
    id: 'canvas-dashboard-metrics',
    name: 'Canvas: Build metrics dashboard',
    category: 'canvas',
    level: 2,
    input: 'Create a dashboard canvas showing these metrics: Total Users: 1,500, Revenue: $45,000, Active Sessions: 342. Use Metric components for each.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components in the layout',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Metric"')
        },
      },
      {
        id: 'has-data-values',
        description: 'Populated all three metric values',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('1500') || json.includes('1,500')
        },
      },
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data to set the data model',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_data'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // ---- Level 3: Canvas with CRUD API ----
  {
    id: 'canvas-todo-crud',
    name: 'Canvas: Build todo app with CRUD API',
    category: 'canvas',
    level: 3,
    input: 'Build me a todo list app on the canvas with a Table showing todos. I need to be able to add, complete, and delete todos. Set up a backend API with canvas_api_schema and seed it with 3 sample todos.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the backend',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate initial data',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table component for displaying todos',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-todo-model',
        description: 'API schema defines a Todo model',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('todo') && json.includes('model')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: ['No tool calls at all'],
  },

  // ---- Level 3: Interactive canvas with action wait ----
  {
    id: 'canvas-interactive-buttons',
    name: 'Canvas: Interactive button actions',
    category: 'canvas',
    level: 3,
    input: 'Create a canvas with two buttons: "Option A" and "Option B". Each should trigger a different action when clicked. Explain what you built.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added button components',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-button-components',
        description: 'Included Button components',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Button"')
        },
      },
      {
        id: 'has-actions',
        description: 'Buttons have action handlers defined',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"action"') && json.includes('"name"')
        },
      },
      {
        id: 'has-two-buttons',
        description: 'Created at least two buttons',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const matches = JSON.stringify(r.toolCalls).match(/"Button"/g)
          return (matches?.length || 0) >= 2
        },
      },
      {
        id: 'response-explains',
        description: 'Response explains the canvas',
        points: 15,
        phase: 'execution',
        validate: (r) => r.responseText.length > 30,
      },
    ],
  },
]
