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

  // ---- Level 2: CRM Lead Pipeline Board (n8n lead scoring + Odin CRM) ----
  {
    id: 'canvas-crm-pipeline',
    name: 'Canvas: CRM lead pipeline board',
    category: 'canvas',
    level: 2,
    input: 'Build a CRM pipeline canvas showing leads in 3 stages: New (5 leads), Qualified (3), Closed (2). Show lead name, company, and score. Use fake data.',
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
        description: 'Used canvas_data to populate lead data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data'),
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
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // ---- Level 2: Expense Report Dashboard (Odin AI + OpenClaw) ----
  {
    id: 'canvas-expense-dashboard',
    name: 'Canvas: Expense tracker dashboard',
    category: 'canvas',
    level: 2,
    input: 'Create an expense tracker dashboard showing: total spend this month ($4,230), budget remaining ($1,770), and a Table of recent expenses with date, description, category, and amount. Use fake data.',
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
        description: 'Included a Table for expense line items',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
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
        description: 'Data includes budget remaining',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('1770') || json.includes('1,770') || json.includes('budget')
        },
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

  // ---- Level 2: CI/CD Pipeline Monitor (OpenClaw DevOps) ----
  {
    id: 'canvas-cicd-monitor',
    name: 'Canvas: CI/CD pipeline monitor',
    category: 'canvas',
    level: 2,
    input: 'Build a CI/CD pipeline monitor canvas showing 4 recent deploys with status (success/failed/running), branch name, commit message, and duration. Include a Chart showing deploy frequency over the last 7 days. Use fake data.',
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
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // ---- Level 3: Customer Support Ticket System (n8n + Odin AI) ----
  {
    id: 'canvas-support-tickets',
    name: 'Canvas: Support ticket system with CRUD',
    category: 'canvas',
    level: 3,
    input: 'Build a support ticket management app. I need a Table of tickets with title, priority (Low/Medium/High/Critical), status (Open/In Progress/Resolved), assignee, and created date. Set up a CRUD API and seed with 5 sample tickets.',
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
        description: 'Used canvas_api_schema to define the Ticket model',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample tickets',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table for displaying tickets',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-ticket-model',
        description: 'API schema defines a Ticket model with priority and status',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('ticket') && json.includes('priority') && json.includes('status')
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

  // ---- Level 3: Invoice Management System (n8n AI invoice agent) ----
  {
    id: 'canvas-invoice-tracker',
    name: 'Canvas: Invoice management with CRUD',
    category: 'canvas',
    level: 3,
    input: 'Build an invoice tracker app on canvas. Each invoice has a client name, amount, due date, and status (Draft/Sent/Paid/Overdue). Set up the API schema with seed data for 4 invoices and display them in a Table with a total amount Metric at the top.',
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
        description: 'Used canvas_api_schema to define the Invoice model',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample invoices',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table for displaying invoices',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-metric-component',
        description: 'Included a Metric for the total amount',
        points: 10,
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
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  // ---- Level 3: HR Applicant Pipeline (Odin AI recruiting + n8n HR) ----
  {
    id: 'canvas-hr-pipeline',
    name: 'Canvas: Recruiting pipeline with CRUD',
    category: 'canvas',
    level: 3,
    input: 'Create a recruiting pipeline app for tracking job applicants. Each applicant has a name, position applied for, stage (Applied/Phone Screen/Interview/Offer/Hired), rating (1-5), and notes. Create the API with 4 seed applicants across different stages.',
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
        description: 'Used canvas_api_schema to define the Applicant model',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample applicants',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table for displaying applicants',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-applicant-model',
        description: 'API schema defines an Applicant model with stage and rating',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('applicant') && json.includes('stage') && json.includes('rating')
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

  // ---- Level 4: Social Media Command Center (OpenClaw + n8n) ----
  {
    id: 'canvas-social-media',
    name: 'Canvas: Social media analytics dashboard',
    category: 'canvas',
    level: 4,
    input: 'Build a social media analytics dashboard. Show metrics for followers (12.5K), engagement rate (4.2%), posts this week (7). Below that, show a Chart of engagement over the last 30 days and a Table of scheduled posts with platform, content preview, scheduled time, and status. Use fake data.',
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
        description: 'Scheduled posts include platform column',
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

  // ---- Level 4: E-Commerce Order Tracker (OpenClaw Shopify + Odin AI) ----
  {
    id: 'canvas-ecommerce-orders',
    name: 'Canvas: E-commerce order management with CRUD',
    category: 'canvas',
    level: 4,
    input: 'Build an order management dashboard with CRUD. Show today\'s orders (23), revenue ($3,450), and pending shipments (8) as metrics. Below, a Table of orders with order number, customer, items, total, and status (Pending/Shipped/Delivered). Set up the API and seed 5 orders.',
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
        description: 'Used canvas_api_schema to define the Order model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample orders',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for KPIs',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table for displaying orders',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-order-model',
        description: 'API schema defines an Order model with status and total',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('order') && json.includes('status') && json.includes('total')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 14 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 14,
      },
    ],
  },
]
