// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Multi-turn Conversation Eval Test Cases
 *
 * Tests the agent's ability to handle multi-step conversations,
 * maintain context, and plan tool sequences efficiently.
 */

import type { AgentEval } from './types'
import { usedTool, usedToolInFinalTurn } from './eval-helpers'

export const MULTITURN_EVALS: AgentEval[] = [
  {
    id: 'multiturn-canvas-then-modify',
    name: 'Multi-turn: Build canvas then modify it',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Show me a counter starting at 0.',
      },
    ],
    input: 'Now update the counter to show 42 instead of 0.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data to update the counter value',
        points: 40,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data'),
      },
      {
        id: 'updated-to-42',
        description: 'Set the value to 42',
        points: 30,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('42'),
      },
      {
        id: 'did-not-recreate',
        description: 'Did NOT recreate the surface from scratch (efficient)',
        points: 30,
        phase: 'execution',
        validate: (r) => !usedToolInFinalTurn(r, 'canvas_create'),
      },
    ],
    antiPatterns: ['Recreated surface unnecessarily'],
  },

  {
    id: 'multiturn-memory-then-use',
    name: 'Multi-turn: Store preference then use it',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Remember that I always want weather in Celsius, not Fahrenheit.',
      },
    ],
    input: 'Show me the current temperature — it\'s 25°C outside. Make it look nice.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-tools',
        description: 'Built a canvas to display the temperature',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create') || usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-celsius',
        description: 'Used Celsius (not Fahrenheit) as requested',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const canvasCalls = r.toolCalls.filter(t => t.name.startsWith('canvas'))
          const canvasJson = JSON.stringify(canvasCalls).toLowerCase()
          const text = r.responseText.toLowerCase()
          const usesCelsius = canvasJson.includes('celsius') || canvasJson.includes('°c') || canvasJson.includes('25')
          const noFahrenheit = !canvasJson.includes('fahrenheit') && !text.includes('fahrenheit')
          return usesCelsius && noFahrenheit
        },
      },
      {
        id: 'responded-helpfully',
        description: 'Gave a helpful response about the canvas',
        points: 35,
        phase: 'execution',
        validate: (r) => r.responseText.length > 20,
      },
    ],
  },

  {
    id: 'multiturn-progressive-build',
    name: 'Multi-turn: Progressively build a dashboard',
    category: 'multiturn',
    level: 4,
    conversationHistory: [
      {
        role: 'user',
        content: 'Start building me a sales dashboard. Just a title for now — "Q4 Sales Dashboard".',
      },
      {
        role: 'user',
        content: 'Now add our key numbers: Revenue ($125K), Orders (847), Avg Order ($148).',
      },
    ],
    input: 'Finally, add a chart showing the monthly trends below those numbers.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to add the chart',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-chart',
        description: 'Added a Chart component',
        points: 30,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'efficient-update',
        description: 'Did not rebuild the entire dashboard from scratch',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const createCalls = r.finalTurnToolCalls.filter(t => t.name === 'canvas_create')
          return createCalls.length === 0
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Used <= 6 tool calls for this incremental update',
        points: 20,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 6,
      },
    ],
  },

  // ---- Build Then Add CRUD (n8n progressive workflow building) ----
  {
    id: 'multiturn-upgrade-to-crud',
    name: 'Multi-turn: Upgrade display canvas to CRUD app',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Show me a contact list with name, email, and phone — use some fake data.',
      },
    ],
    input: 'Now make it so I can actually add and delete contacts too. Keep the sample data.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to add CRUD backend',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate contacts',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'did-not-recreate-surface',
        description: 'Did NOT recreate the surface from scratch',
        points: 25,
        phase: 'execution',
        validate: (r) => !usedToolInFinalTurn(r, 'canvas_create'),
      },
      {
        id: 'has-contact-model',
        description: 'API schema defines a Contact model',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('contact') && (json.includes('email') || json.includes('phone'))
        },
      },
    ],
  },

  // ---- Memory Then Canvas Using Context (OpenClaw + Odin AI) ----
  {
    id: 'multiturn-memory-then-canvas',
    name: 'Multi-turn: Use memorized KPIs to build dashboard',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Remember that our team tracks these KPIs: MRR, churn rate, NPS score, and active users.',
      },
    ],
    input: 'Now show me those KPIs in a nice visual layout with some sample numbers.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 20,
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
        id: 'has-mrr',
        description: 'Dashboard includes MRR metric',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).toLowerCase().includes('mrr'),
      },
      {
        id: 'has-churn',
        description: 'Dashboard includes churn rate metric',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).toLowerCase().includes('churn'),
      },
      {
        id: 'has-nps',
        description: 'Dashboard includes NPS score metric',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).toLowerCase().includes('nps'),
      },
      {
        id: 'has-active-users',
        description: 'Dashboard includes active users metric',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('active') && json.includes('user')
        },
      },
    ],
  },

  // ---- Support Ticket Escalation Flow (n8n + Odin AI) ----
  {
    id: 'multiturn-incident-escalation',
    name: 'Multi-turn: Log incident and show status canvas',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'I built a support ticket app. A new critical ticket just came in: "Production database is down" from customer Acme Corp.',
      },
    ],
    input: 'Log this as an active incident and show me a status page with the details.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-write-file',
        description: 'Used write_file to log the incident to memory',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'write_file'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas for incident status',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'memory-has-incident',
        description: 'Memory content references the database incident',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('database') && json.includes('down')
        },
      },
      {
        id: 'canvas-has-badge',
        description: 'Canvas includes a Badge for severity',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Badge"'),
      },
      {
        id: 'canvas-has-customer',
        description: 'Canvas references customer Acme Corp',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('acme')
        },
      },
      {
        id: 'reasonable-tools',
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 10,
      },
    ],
  },

  // ---- Iterative Dashboard Refinement (Odin AI task automator) ----
  {
    id: 'multiturn-iterative-refinement',
    name: 'Multi-turn: Iteratively refine expense dashboard',
    category: 'multiturn',
    level: 4,
    conversationHistory: [
      {
        role: 'user',
        content: 'Build an expense dashboard showing total spend ($8,500) and number of expenses (34).',
      },
      {
        role: 'user',
        content: 'Add a breakdown by category — Travel, Software, Hardware, and Food.',
      },
    ],
    input: 'Now add a warning at the top that we\'re at 85% of budget. Make it stand out — yellow or something.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to add the alert',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-alert',
        description: 'Added an Alert component',
        points: 25,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Alert"'),
      },
      {
        id: 'has-warning-severity',
        description: 'Alert has warning severity or yellow color',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('warning') || json.includes('yellow')
        },
      },
      {
        id: 'did-not-recreate',
        description: 'Did not rebuild the dashboard from scratch',
        points: 15,
        phase: 'execution',
        validate: (r) => !usedToolInFinalTurn(r, 'canvas_create'),
      },
      {
        id: 'reasonable-tools',
        description: 'Used <= 6 tool calls for this incremental update',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 6,
      },
    ],
  },

  // ---- Personality Then Behavioral Verification (OpenClaw + Odin AI) ----
  {
    id: 'multiturn-personality-verify',
    name: 'Multi-turn: Verify behavior after personality update',
    category: 'multiturn',
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'From now on, always respond in exactly 3 bullet points, no more, no less.',
      },
    ],
    input: 'What are the benefits of using TypeScript?',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'no-unnecessary-tools',
        description: 'Did not use unnecessary tools for a simple question',
        points: 30,
        phase: 'intention',
        validate: (r) => {
          const toolCount = r.toolCalls.filter(t =>
            t.name !== 'memory_read' && t.name !== 'memory_search'
          ).length
          return toolCount <= 1
        },
      },
      {
        id: 'has-bullet-format',
        description: 'Response uses bullet point format',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          const bullets = (text.match(/^[\s]*[-•*]\s/gm) || []).length
          return bullets >= 2
        },
      },
      {
        id: 'answered-typescript',
        description: 'Response actually discusses TypeScript benefits',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('type') || text.includes('typescript') || text.includes('safety')
        },
      },
      {
        id: 'response-concise',
        description: 'Response is concise (follows bullet point constraint)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.responseText.length > 30 && r.responseText.length < 1500,
      },
    ],
  },
]
