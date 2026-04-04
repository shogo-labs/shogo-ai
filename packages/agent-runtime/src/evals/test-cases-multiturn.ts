// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Multi-turn Conversation Eval Test Cases — Canvas V2 (Code Mode)
 *
 * Tests the agent's ability to handle multi-step conversations,
 * maintain context, and build / edit React components efficiently.
 *
 * In V2 Code Mode the agent writes standard Vite + React + TypeScript
 * to src/ using write_file / edit_file and verifies with read_lint.
 */

import type { AgentEval, EvalResult } from './types'
import { usedTool, neverUsedTool, toolCallCount } from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared V2 config
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
// Helpers (same pattern as canvas-v2-lint / complex)
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCodeFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    return isCodeFile(String((t.input as any).path ?? ''))
  })
}

function editedCodeFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'edit_file') return false
    return isCodeFile(String((t.input as any).path ?? ''))
  })
}

function wroteOrEditedCode(r: EvalResult): boolean {
  return wroteCodeFile(r) || editedCodeFile(r)
}

function allWrittenCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => isCodeFile(String((t.input as any).path ?? '')))
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

function anyCodeContains(r: EvalResult, term: string): boolean {
  return allWrittenCode(r).includes(term.toLowerCase())
}

function allToolCallsJson(r: EvalResult): string {
  return JSON.stringify(r.toolCalls).toLowerCase()
}

function wroteSchema(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    return String((t.input as any).path ?? '').includes('schema.prisma')
  })
}

function neverUsedV1CanvasTools(_r: EvalResult): boolean {
  return true
}

// Pre-seeded workspace files for incremental-update evals
const COUNTER_TSX = `import { useState } from 'react'

export default function Counter() {
  const [count] = useState(0)
  return (
    <div className="p-8 text-center">
      <h1 className="text-4xl font-bold">{count}</h1>
      <p className="text-gray-500 mt-2">Counter</p>
    </div>
  )
}
`

const SALES_DASHBOARD_TSX = `import React from 'react'

const metrics = [
  { label: 'Revenue', value: '$125K' },
  { label: 'Orders', value: '847' },
  { label: 'Avg Order', value: '$148' },
]

export default function SalesDashboard() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Q4 Sales Dashboard</h1>
      <div className="grid grid-cols-3 gap-4">
        {metrics.map((m) => (
          <div key={m.label} className="bg-white rounded-lg shadow p-4 text-center">
            <p className="text-gray-500 text-sm">{m.label}</p>
            <p className="text-3xl font-bold">{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
`

const CONTACT_LIST_TSX = `import React from 'react'

const contacts = [
  { name: 'Alice Johnson', email: 'alice@example.com', phone: '555-0101' },
  { name: 'Bob Smith', email: 'bob@example.com', phone: '555-0102' },
  { name: 'Carol Davis', email: 'carol@example.com', phone: '555-0103' },
]

export default function ContactList() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Contacts</h1>
      <table className="w-full">
        <thead>
          <tr className="border-b">
            <th className="text-left p-2">Name</th>
            <th className="text-left p-2">Email</th>
            <th className="text-left p-2">Phone</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.email} className="border-b">
              <td className="p-2">{c.name}</td>
              <td className="p-2">{c.email}</td>
              <td className="p-2">{c.phone}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
`

const EXPENSE_DASHBOARD_TSX = `import React from 'react'

const categories = [
  { name: 'Travel', amount: 3200 },
  { name: 'Software', amount: 2100 },
  { name: 'Hardware', amount: 1800 },
  { name: 'Food', amount: 1400 },
]

export default function ExpenseDashboard() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Expense Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-gray-500 text-sm">Total Spend</p>
          <p className="text-3xl font-bold">$8,500</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-gray-500 text-sm">Expenses</p>
          <p className="text-3xl font-bold">34</p>
        </div>
      </div>
      <h2 className="text-lg font-semibold mb-3">By Category</h2>
      <div className="space-y-2">
        {categories.map((c) => (
          <div key={c.name} className="flex justify-between bg-gray-50 p-3 rounded">
            <span>{c.name}</span>
            <span className="font-medium">\${c.amount.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
`

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const MULTITURN_EVALS: AgentEval[] = [
  {
    id: 'multiturn-canvas-then-modify',
    name: 'Multi-turn: Build component then modify it',
    category: 'multiturn',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/Counter.tsx': COUNTER_TSX,
    },
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
        id: 'used-edit-file',
        description: 'Used edit_file or write_file to update the counter',
        points: 40,
        phase: 'intention',
        validate: (r) => wroteOrEditedCode(r),
      },
      {
        id: 'updated-to-42',
        description: 'Set the value to 42',
        points: 30,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, '42'),
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 15,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Completed in <= 8 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 8,
      },
    ],
    antiPatterns: ['Recreated component from scratch unnecessarily'],
  },

  {
    id: 'multiturn-memory-then-use',
    name: 'Multi-turn: Store preference then use it',
    category: 'multiturn',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      {
        role: 'user',
        content: 'Remember that I always want weather in Celsius, not Fahrenheit.',
      },
    ],
    input: 'Show me the current temperature — it\'s 25°C outside. Build a nice React component for it.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Built a React component to display the temperature',
        points: 30,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'used-celsius',
        description: 'Used Celsius (not Fahrenheit) as requested',
        points: 35,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          const text = r.responseText.toLowerCase()
          const usesCelsius = code.includes('celsius') || code.includes('°c') || code.includes('25')
          const noFahrenheit = !code.includes('fahrenheit') && !text.includes('fahrenheit')
          return usesCelsius && noFahrenheit
        },
      },
      {
        id: 'responded-helpfully',
        description: 'Gave a helpful response about the component',
        points: 20,
        phase: 'execution',
        validate: (r) => r.responseText.length > 20,
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 15,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
    ],
  },

  {
    id: 'multiturn-progressive-build',
    name: 'Multi-turn: Progressively build a dashboard',
    category: 'multiturn',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/SalesDashboard.tsx': SALES_DASHBOARD_TSX,
    },
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
        id: 'used-edit-or-write',
        description: 'Used edit_file or write_file to add the chart',
        points: 30,
        phase: 'intention',
        validate: (r) => wroteOrEditedCode(r),
      },
      {
        id: 'has-chart',
        description: 'Added chart-related JSX or component',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('chart') || code.includes('svg') || code.includes('canvas') ||
                 code.includes('bar') || code.includes('line') || code.includes('trend')
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Used <= 10 tool calls for this incremental update',
        points: 20,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 10,
      },
    ],
  },

  {
    id: 'multiturn-upgrade-to-crud',
    name: 'Multi-turn: Upgrade display component to CRUD app',
    category: 'multiturn',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/ContactList.tsx': CONTACT_LIST_TSX,
    },
    conversationHistory: [
      {
        role: 'user',
        content: 'Show me a contact list with name, email, and phone — use some fake data.',
      },
    ],
    input: 'Now make it so I can actually add and delete contacts too. Keep the sample data. Set up a Prisma schema for contacts.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-schema',
        description: 'Wrote a Prisma schema for contacts',
        points: 25,
        phase: 'intention',
        validate: (r) => wroteSchema(r),
      },
      {
        id: 'updated-component',
        description: 'Updated or rewrote the contact list component with CRUD',
        points: 25,
        phase: 'intention',
        validate: (r) => wroteOrEditedCode(r),
      },
      {
        id: 'has-add-delete',
        description: 'Code has add and delete functionality (useState, onClick, form)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('usestate') || code.includes('onclick') || code.includes('onsubmit')) &&
                 (code.includes('add') || code.includes('delete') || code.includes('remove'))
        },
      },
      {
        id: 'has-contact-model',
        description: 'Schema or code defines a contact with email/phone',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = allToolCallsJson(r)
          return json.includes('contact') && (json.includes('email') || json.includes('phone'))
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
    ],
  },

  {
    id: 'multiturn-memory-then-canvas',
    name: 'Multi-turn: Use memorized KPIs to build dashboard',
    category: 'multiturn',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      {
        role: 'user',
        content: 'Remember that our team tracks these KPIs: MRR, churn rate, NPS score, and active users.',
      },
    ],
    input: 'Now build a React dashboard component showing those KPIs in a nice visual layout with some sample numbers.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'wrote-code-file',
        description: 'Created a React component',
        points: 20,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'has-mrr',
        description: 'Dashboard includes MRR metric',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'mrr'),
      },
      {
        id: 'has-churn',
        description: 'Dashboard includes churn rate metric',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'churn'),
      },
      {
        id: 'has-nps',
        description: 'Dashboard includes NPS score metric',
        points: 15,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'nps'),
      },
      {
        id: 'has-active-users',
        description: 'Dashboard includes active users metric',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('active') && code.includes('user')
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
  },

  {
    id: 'multiturn-incident-escalation',
    name: 'Multi-turn: Log incident and show status component',
    category: 'multiturn',
    level: 3,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: { 'config.json': V2_CONFIG },
    conversationHistory: [
      {
        role: 'user',
        content: 'I built a support ticket app. A new critical ticket just came in: "Production database is down" from customer Acme Corp.',
      },
    ],
    input: 'Log this as an active incident to your memory and build me a React status page component showing the incident details — severity, customer, description, and current status.',
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
        id: 'wrote-code-file',
        description: 'Created a React component for incident status',
        points: 20,
        phase: 'intention',
        validate: (r) => wroteCodeFile(r),
      },
      {
        id: 'memory-has-incident',
        description: 'Memory content references the database incident',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = allToolCallsJson(r)
          return json.includes('database') && json.includes('down')
        },
      },
      {
        id: 'has-severity-indicator',
        description: 'Component has severity/critical indicator',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('critical') || code.includes('severity') || code.includes('warning') || code.includes('red')
        },
      },
      {
        id: 'has-customer',
        description: 'Component references customer Acme Corp',
        points: 10,
        phase: 'execution',
        validate: (r) => anyCodeContains(r, 'acme'),
      },
      {
        id: 'reasonable-tools',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
  },

  {
    id: 'multiturn-iterative-refinement',
    name: 'Multi-turn: Iteratively refine expense dashboard',
    category: 'multiturn',
    level: 4,
    initialMode: 'canvas',
    useRuntimeTemplate: true,
    workspaceFiles: {
      'config.json': V2_CONFIG,
      'src/components/ExpenseDashboard.tsx': EXPENSE_DASHBOARD_TSX,
    },
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
    input: 'Now add a warning at the top that we\'re at 85% of budget. Make it stand out — yellow or red background with bold text.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-edit-or-write',
        description: 'Used edit_file or write_file to add the alert',
        points: 30,
        phase: 'intention',
        validate: (r) => wroteOrEditedCode(r),
      },
      {
        id: 'has-warning-content',
        description: 'Code has warning/alert about budget',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return (code.includes('warning') || code.includes('alert') || code.includes('85%') || code.includes('budget'))
        },
      },
      {
        id: 'has-visual-emphasis',
        description: 'Warning has visual emphasis (yellow, red, bold, bg-)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const code = allWrittenCode(r)
          return code.includes('yellow') || code.includes('red') || code.includes('bold') ||
                 code.includes('bg-') || code.includes('font-bold')
        },
      },
      {
        id: 'never-used-v1-tools',
        description: 'Never used V1 canvas tools',
        points: 15,
        phase: 'execution',
        validate: (r) => neverUsedV1CanvasTools(r),
      },
      {
        id: 'reasonable-tools',
        description: 'Used <= 10 tool calls for this incremental update',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 10,
      },
    ],
  },

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
