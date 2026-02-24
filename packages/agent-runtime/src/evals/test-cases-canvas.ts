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

/**
 * Check that at least one canvas_trigger_action call returned ok: true.
 */
function triggerActionSucceeded(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'canvas_trigger_action') return false
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('"ok":true') || output.includes('"ok": true')
  })
}

/**
 * Check that all Button components in canvas_update calls have a mutation
 * in their action definition.
 */
function allButtonsHaveMutations(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  if (updateCalls.length === 0) return false
  for (const call of updateCalls) {
    const inputStr = JSON.stringify(call.input ?? '')
    const componentArrayMatch = inputStr.match(/"components"\s*:\s*\[/)
    if (!componentArrayMatch) continue
    const buttonRe = /"component"\s*:\s*"Button"/g
    let match: RegExpExecArray | null
    while ((match = buttonRe.exec(inputStr)) !== null) {
      const surroundingStart = Math.max(0, match.index - 500)
      const surroundingEnd = Math.min(inputStr.length, match.index + 500)
      const surroundingChunk = inputStr.slice(surroundingStart, surroundingEnd)
      if (surroundingChunk.includes('"action"') && !surroundingChunk.includes('"mutation"')) {
        return false
      }
    }
  }
  return true
}

/**
 * Check that canvas_trigger_action output shows actual data changes
 * (the "changes" array is populated or "VERIFIED" appears).
 */
function triggerActionChangedData(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'canvas_trigger_action') return false
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('count_changed') || output.includes('VERIFIED') || output.includes('"type":"added"')
  })
}

/**
 * Check that at least one canvas_inspect call occurs after at least one
 * canvas_trigger_action call. Handles the common pattern where a pre-flight
 * inspect occurs before the first trigger.
 */
function inspectAfterTrigger(result: EvalResult): boolean {
  const firstTrigger = result.toolCalls.findIndex(t => t.name === 'canvas_trigger_action')
  if (firstTrigger < 0) return false
  return result.toolCalls.some((t, i) => t.name === 'canvas_inspect' && i > firstTrigger)
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
    input: 'What\'s the weather like in San Francisco? Show me something nice — it\'s 72°F and sunny out.',
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
        description: 'Used canvas_data or canvas_api_query to populate data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
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
        description: 'Used a reasonable number of tool calls (<= 10)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
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
    input: 'I need to see our key business numbers at a glance — we have 1,500 users, $45,000 in revenue, and 342 active sessions.',
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
        description: 'Used canvas_data or canvas_api_query to set the data model',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
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
    input: 'I want to track my todos — adding, completing, and deleting them. Set me up with a few sample ones to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the backend',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate initial data',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying todos',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-todo-model',
        description: 'API schema defines a Todo model',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('todo') && json.includes('model')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a todo',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the interaction result',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: Interactive canvas with action wait ----
  {
    id: 'canvas-interactive-buttons',
    name: 'Canvas: Interactive button actions',
    category: 'canvas',
    level: 3,
    input: 'I need a quick poll — give people two options, A and B, and let them pick one.',
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
        description: 'Added button components',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-button-components',
        description: 'Included Button components',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Button"')
        },
      },
      {
        id: 'has-actions',
        description: 'Buttons have action handlers defined',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"action"') && json.includes('"name"')
        },
      },
      {
        id: 'has-two-buttons',
        description: 'Created at least two buttons',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const matches = JSON.stringify(r.toolCalls).match(/"Button"/g)
          return (matches?.length || 0) >= 2
        },
      },
      {
        id: 'handles-votes',
        description: 'Used canvas_data_patch, canvas_action_wait, or canvas_trigger_action to handle votes',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          usedTool(r, 'canvas_data_patch') ||
          usedTool(r, 'canvas_action_wait') ||
          usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'verified-state',
        description: 'Used canvas_inspect to verify the poll state',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'response-explains',
        description: 'Response explains the canvas and verification result',
        points: 10,
        phase: 'execution',
        validate: (r) => r.responseText.length > 30,
      },
    ],
    antiPatterns: ['Did not verify button interactions work'],
  },

  // ---- Level 2: CRM Lead Pipeline Board (n8n lead scoring + Odin CRM) ----
  {
    id: 'canvas-crm-pipeline',
    name: 'Canvas: CRM lead pipeline board',
    category: 'canvas',
    level: 2,
    input: 'I want to see my sales pipeline. I\'ve got leads in New, Qualified, and Closed stages — show me who\'s where with their company and score.',
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
        id: 'used-canvas-data',
        description: 'Used canvas_data or canvas_api_query to populate lead data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
      },
      {
        id: 'has-stage-labels',
        description: 'Includes pipeline stage labels (New, Qualified, Closed)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('new') && json.includes('qualified') && json.includes('closed')
        },
      },
      {
        id: 'has-lead-data',
        description: 'Data includes lead name and company fields',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('company') && (json.includes('name') || json.includes('lead'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // ---- Level 2: Expense Report Dashboard (Odin AI + OpenClaw) ----
  {
    id: 'canvas-expense-dashboard',
    name: 'Canvas: Expense tracker dashboard',
    category: 'canvas',
    level: 2,
    input: 'Help me see where my team\'s money is going this month. We\'ve spent $4,230 of our $6,000 budget so far. Show me the breakdown of recent expenses.',
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
        description: 'Used Metric components for totals',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for expense line items',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-spend-data',
        description: 'Data includes spend amount',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('4230') || json.includes('4,230')
        },
      },
      {
        id: 'has-budget-data',
        description: 'Data includes budget info',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('6000') || json.includes('6,000') || json.includes('1770') || json.includes('1,770') || json.includes('budget')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // ---- Level 2: CI/CD Pipeline Monitor (OpenClaw DevOps) ----
  {
    id: 'canvas-cicd-monitor',
    name: 'Canvas: CI/CD pipeline monitor',
    category: 'canvas',
    level: 2,
    input: 'Show me our recent deployments — I want to see which ones passed and which failed, plus the trend over the last week.',
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
        id: 'has-deploy-list',
        description: 'Included a Table or DataList for deploys',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') || json.includes('"DataList"')
        },
      },
      {
        id: 'has-chart',
        description: 'Included a Chart for deploy frequency',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'has-status-indicators',
        description: 'Includes status values (success/failed/running)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('success') || json.includes('failed') || json.includes('running')
        },
      },
      {
        id: 'has-deploy-data',
        description: 'Data includes branch and commit info',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('branch') || json.includes('commit')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // ---- Level 3: Customer Support Ticket System (n8n + Odin AI) ----
  {
    id: 'canvas-support-tickets',
    name: 'Canvas: Support ticket system with CRUD',
    category: 'canvas',
    level: 3,
    input: 'I need a way to manage support tickets. Should have priority levels and status tracking. Throw in some example tickets to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Ticket model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample tickets',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying tickets',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-ticket-model',
        description: 'API schema defines a Ticket model with priority and status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('ticket') && json.includes('priority') && json.includes('status')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test ticket',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the ticket was created',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: Invoice Management System (n8n AI invoice agent) ----
  {
    id: 'canvas-invoice-tracker',
    name: 'Canvas: Invoice management with CRUD',
    category: 'canvas',
    level: 3,
    input: 'Help me track my invoices — client, amount, due date, and whether they\'re paid. Add a few sample invoices to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Invoice model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample invoices',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying invoices',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-metric-component',
        description: 'Included a Metric for the total amount',
        points: 5,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-invoice-model',
        description: 'API schema defines an Invoice model with amount and status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('invoice') && json.includes('amount') && json.includes('status')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test invoice',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the invoice was created',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: HR Applicant Pipeline (Odin AI recruiting + n8n HR) ----
  {
    id: 'canvas-hr-pipeline',
    name: 'Canvas: Recruiting pipeline with CRUD',
    category: 'canvas',
    level: 3,
    input: 'I need to track job applicants through our hiring process — who applied, what role, what stage they\'re at, and how they rate. Seed it with a few sample candidates.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Applicant model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample applicants',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying applicants',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-applicant-model',
        description: 'API schema defines an Applicant model with stage and rating',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('applicant') && json.includes('stage') && json.includes('rating')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test applicant',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the applicant was added',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 4: Social Media Command Center (multi-turn) ----
  {
    id: 'canvas-social-media',
    name: 'Canvas: Social media analytics dashboard (multi-turn)',
    category: 'canvas',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'Show me how our social media is doing — follower count, engagement rate, and what\'s scheduled to post next.' },
    ],
    input: 'We\'re @shogo_ai on Twitter/X with 12.4K followers and 4.2% engagement, @shogoai on Instagram with 8.1K followers and 6.1% engagement, and our LinkedIn company page has 3.2K followers at 2.8% engagement. We have 5 posts scheduled for next week across all three platforms. Build me a canvas dashboard showing metrics per platform, an engagement trend chart, and a table of the upcoming scheduled posts. Use those numbers as sample data.',
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
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for KPIs',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const matches = JSON.stringify(r.toolCalls).match(/"Metric"/g)
          return (matches?.length || 0) >= 3
        },
      },
      {
        id: 'has-chart',
        description: 'Included a Chart for engagement trends',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'has-table',
        description: 'Included a Table for scheduled posts',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-engagement-data',
        description: 'Data includes engagement metrics',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('engagement') || json.includes('follower')
        },
      },
      {
        id: 'has-platform-data',
        description: 'Includes platform-specific data (Twitter, Instagram, LinkedIn)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('platform') || json.includes('twitter') || json.includes('instagram') || json.includes('linkedin')
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
  },

  // ---- Level 4: E-Commerce Order Tracker (multi-turn) ----
  {
    id: 'canvas-ecommerce-orders',
    name: 'Canvas: E-commerce order management with CRUD (multi-turn)',
    category: 'canvas',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I need to manage my incoming orders — can you help me track revenue, shipments, and the order list?' },
    ],
    input: 'We\'re on Shopify. Today we had 23 orders totaling $3,450 with 8 pending shipments. Each order has an order number, customer name, items, total amount, and status (Pending/Shipped/Delivered). Build me a canvas dashboard with revenue and shipment metrics at the top and the full order list below as a table. Set up a CRUD API so I can add new orders, and seed it with 5 sample orders based on those numbers. After building it, add a test order for customer "Eval Shopper" with total $42 using canvas_trigger_action, then canvas_inspect to verify it was created.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Order model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample orders',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for KPIs',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying orders',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-order-model',
        description: 'API schema defines an Order model with status and total',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('order') && json.includes('status') && json.includes('total')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test order',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the order was created',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ====================================================================
  // Interaction Evals — verify the agent self-tests its canvas UIs
  // ====================================================================

  // ---- Level 4: Build CRUD app + trigger action + inspect result ----
  {
    id: 'canvas-crud-self-test',
    name: 'Canvas: CRUD app with self-testing via trigger+inspect',
    category: 'canvas',
    level: 4,
    input: 'Build me a quick todo tracker with a couple sample items. Make sure it actually works.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Defined API schema for todos',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded sample data',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Built UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'tested-add-action',
        description: 'Tested a POST/add action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const json = JSON.stringify(t.input).toLowerCase()
          return json.includes('post')
        }),
      },
      {
        id: 'tested-update-action',
        description: 'Tested a PATCH/mark-complete action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const json = JSON.stringify(t.input).toLowerCase()
          return json.includes('patch') || json.includes('put')
        }),
      },
      {
        id: 'tested-delete-action',
        description: 'Tested a DELETE action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const json = JSON.stringify(t.input).toLowerCase()
          return json.includes('delete')
        }),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'At least one canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'inspect-after-each-trigger',
        description: 'canvas_inspect called at least twice to verify multiple actions',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'canvas_inspect') >= 2,
      },
      {
        id: 'inspect-after-trigger',
        description: 'canvas_inspect was called after canvas_trigger_action',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'response-confirms-count',
        description: 'Response mentions the total count (3 todos)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('3') || text.includes('three')
        },
      },
    ],
    antiPatterns: ['Did not use canvas_trigger_action', 'Did not use canvas_inspect', 'Only tested one action type — must test add, update, and delete', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 4: Counter app with self-testing loop (multi-turn) ----
  {
    id: 'canvas-counter-self-test',
    name: 'Canvas: Counter with trigger/inspect verification loop (multi-turn)',
    category: 'canvas',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'Make me a simple counter on the canvas — just a number display and a button I can click to increment it. Start the count at 0.' },
    ],
    input: 'Looks good! Now test that the increment actually works — use canvas_trigger_action to click the increment button 3 times, then use canvas_inspect to check the counter state and tell me the final value.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'triggered-at-least-once',
        description: 'Used canvas_trigger_action at least once',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to check the result',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'triggered-3-times',
        description: 'Used canvas_trigger_action at least 3 times',
        points: 30,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'canvas_trigger_action') >= 3,
      },
      {
        id: 'inspect-after-triggers',
        description: 'Used canvas_inspect after the last trigger',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const lastTrigger = r.toolCalls.map((t, i) => ({ ...t, idx: i }))
            .filter(t => t.name === 'canvas_trigger_action').pop()
          const inspectAfter = r.toolCalls.findIndex(
            (t, i) => t.name === 'canvas_inspect' && lastTrigger && i > lastTrigger.idx
          )
          return inspectAfter >= 0
        },
      },
      {
        id: 'response-reports-value',
        description: 'Response mentions the final counter value (3 or higher)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          return /\b[3-9]\b/.test(text) || text.includes('three')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['Did not trigger any actions', 'Did not inspect the result'],
  },

  // ---- Level 5: Full CRUD roundtrip verification ----
  {
    id: 'canvas-crud-roundtrip',
    name: 'Canvas: Full CRUD roundtrip with verification',
    category: 'canvas',
    level: 5,
    input: 'Build me a contacts list where I can add, edit, and delete people — name, email, phone. Seed a couple entries, then run through each operation to make sure it all works and tell me the results.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Defined Contact model via API schema',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded 2 initial contacts',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'trigger-create',
        description: 'Used canvas_trigger_action with POST mutation to add a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'canvas_trigger_action') return false
            const json = JSON.stringify(t.input).toLowerCase()
            return json.includes('post')
          })
        },
      },
      {
        id: 'trigger-update',
        description: 'Used canvas_trigger_action with PATCH/PUT mutation to update a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'canvas_trigger_action') return false
            const json = JSON.stringify(t.input).toLowerCase()
            return json.includes('patch') || json.includes('put')
          })
        },
      },
      {
        id: 'trigger-delete',
        description: 'Used canvas_trigger_action with DELETE mutation to remove a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'canvas_trigger_action') return false
            const json = JSON.stringify(t.input).toLowerCase()
            return json.includes('delete')
          })
        },
      },
      {
        id: 'trigger-action-succeeded',
        description: 'At least one canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'inspect-after-each',
        description: 'Used canvas_inspect at least 3 times (after create, update, delete)',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'canvas_inspect') >= 3,
      },
      {
        id: 'response-reports-steps',
        description: 'Response describes results of each CRUD step',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('add') || text.includes('creat')) &&
                 (text.includes('update') || text.includes('patch')) &&
                 (text.includes('delete') || text.includes('remov'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Skipped verification steps',
      'Did not use canvas_trigger_action for CRUD',
      'Did not use canvas_inspect to verify',
      'Buttons missing mutation in action definition',
    ],
  },
]
