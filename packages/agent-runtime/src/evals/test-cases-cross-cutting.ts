// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-cutting eval track
 *
 * Standalone evaluations with no single persona: CSV-to-app migration,
 * multilingual prompts, terse instructions, fiscal-year memory, delegation
 * judgment, parallel research, multi-turn canvas fixes, and casual-user
 * adaptation. Each entry is one `AgentEval` (multi-turn cases use
 * `conversationHistory` on that single eval).
 */

import type { AgentEval, EvalResult } from './types'
import { CROSS_CUTTING_MOCKS, type ToolMockMap } from './tool-mocks'
import {
  usedTool,
  toolCallArgsContain,
  toolCallCount,
  responseContains,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Shared canvas v2 config
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
// Validation helpers
// ---------------------------------------------------------------------------

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path)
}

function wroteCanvasFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    return isCodeFile(String((t.input as any).path ?? ''))
  })
}

function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => isCodeFile(String((t.input as any).path ?? '')))
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

function anyCanvasCodeContains(r: EvalResult, term: string): boolean {
  return allCanvasCode(r).includes(term.toLowerCase())
}

function wroteSchema(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const path = String((t.input as any).path ?? '')
    return path.includes('schema.prisma')
  })
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .some(t => {
      const content = String((t.input as any).content ?? (t.input as any).new_string ?? '')
      return content.includes(`model ${modelName}`)
    })
}

function subagentWasSpawned(r: EvalResult): boolean {
  return usedTool(r, 'task') || usedTool(r, 'agent_spawn')
}

function countSubagentSpawns(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task' || tc.name === 'agent_spawn').length
}

function responseCompanyMentionCount(r: EvalResult): number {
  const t = r.responseText.toLowerCase()
  const companies = ['alphatech', 'betacorp', 'gammaio', 'deltalabs', 'epsilonai'] as const
  return companies.filter(c => t.includes(c)).length
}

function canvasOrToolJsonContainsSeedClient(r: EvalResult): boolean {
  const blob = `${allCanvasCode(r)}\n${toolCallsJson(r)}`
  const touchedCsv =
    toolCallArgsContain(r, 'read_file', 'clients.csv') ||
    toolCallArgsContain(r, 'write_file', 'clients.csv') ||
    toolCallArgsContain(r, 'edit_file', 'clients.csv')
  return (
    blob.includes('acme') ||
    blob.includes('bloom') ||
    blob.includes('techstart') ||
    touchedCsv
  )
}

function fiscalYearAprilEvidence(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  const ignoresAprilFiscal =
    code.includes('q1') &&
    (code.includes('january') || /\bjan\b/.test(code)) &&
    !code.includes('april') &&
    !code.includes('apr') &&
    !code.includes('fiscal')
  if (ignoresAprilFiscal) return false
  return (
    code.includes('april') ||
    code.includes('apr') ||
    code.includes('fiscal') ||
    code.includes('getmonth() === 3') ||
    code.includes('getmonth()==3') ||
    /\bmonth\s*===?\s*3\b/.test(code) ||
    /\bmonth\s*===?\s*4\b/.test(code)
  )
}

function errorRecoveryWorkspace(): Record<string, string> {
  const appTsx = [
    "import React from 'react'",
    '',
    'const tasks = [',
    "  { id: 1, title: 'Design mockups', status: 'done', dueDate: '2026-03-15' },",
    "  { id: 2, title: 'Build prototype', status: 'in-progress', dueDate: '2026-04-01' },",
    "  { id: 3, title: 'User testing', status: 'todo', dueDate: '2026-04-15' },",
    ']',
    '',
    'export default function App() {',
    "  const [filter, setFilter] = React.useState('all')",
    "  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)",
    '  return (',
    '    <div className="p-4">',
    '      <h1 className="text-2xl font-bold mb-4">Task Tracker</h1>',
    '      <select value={filter} onChange={e => setFilter(e.target.value)}>',
    '        <option value="all">All</option>',
    '        <option value="todo">To Do</option>',
    '        <option value="in-progress">In Progress</option>',
    '        <option value="done">Done</option>',
    '      </select>',
    '      <div className="mt-4">',
    '        {filtered.map(task => (',
    '          <div key={task.id} className="border p-2 mb-2">',
    '            <h3>{task.title}</h3>',
    '            <p>Due: {task.dueDate}</p>',
    '          </div>',
    '        ))}',
    '      </div>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')

  return {
    'config.json': V2_CONFIG,
    'src/App.tsx': appTsx,
  }
}

// ---------------------------------------------------------------------------
// 1. CSV → CRM migration
// ---------------------------------------------------------------------------

const XCUT_CSV_MIGRATION: AgentEval = {
  id: 'xcut-csv-migration',
  name: 'Cross-cutting: CSV client import → CRM app',
  category: 'cross-cutting' as any,
  level: 3,
  input:
    'I have all my client data in this spreadsheet in the files folder. Can you import it into a proper CRM app for me?',
  workspaceFiles: {
    'config.json': V2_CONFIG,
    'files/clients.csv': [
      'Client Name,Contact Email,Phone Number,Signed On,Monthly Value',
      'Acme Corp,john@acme.com,(555) 123-4567,Jan 15 2026,$5000',
      'Bloom Beauty,sarah@bloom.com,555.234.5678,2026-02-01,$3500',
      'TechStart,mike@techstart.com,5553456789,03/01/2026,$7500',
      '"Green, Leaf & Co",info@greenleaf.com,(555) 456-7890,2025-12-15,"$2,400"',
      'RetailMax,,555-567-8901,2026/01/20,$4500',
    ].join('\n'),
  },
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 14,
  validationCriteria: [
    {
      id: 'wrote-canvas-code',
      description: 'Wrote at least one src/ TS/TSX file via write_file',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'crm-domain-in-ui',
      description: 'Canvas code references clients or CRM',
      points: 3,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'client') || anyCanvasCodeContains(r, 'crm'),
    },
    {
      id: 'client-model-schema',
      description: 'Prisma schema defines a Client model',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Client'),
    },
    {
      id: 'seed-data-used',
      description: 'Imported or referenced seed client rows (Acme, Bloom, TechStart)',
      points: 3,
      phase: 'execution',
      validate: (r) => canvasOrToolJsonContainsSeedClient(r),
    },
  ],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// 2. Multilingual intent
// ---------------------------------------------------------------------------

const XCUT_MULTILINGUAL: AgentEval = {
  id: 'xcut-multilingual',
  name: 'Cross-cutting: mixed Spanish/English client tracker',
  category: 'cross-cutting' as any,
  level: 3,
  input:
    'Necesito un tracker de clientes. Each client has nombre, company, email, y el status del proyecto. Can you build me algo simple?',
  workspaceFiles: { 'config.json': V2_CONFIG },
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 10,
  validationCriteria: [
    {
      id: 'wrote-canvas',
      description: 'Wrote canvas source files',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'client-concept',
      description: 'Code mentions client or cliente',
      points: 3,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'client') || anyCanvasCodeContains(r, 'cliente'),
    },
    {
      id: 'name-field',
      description: 'Code includes name or nombre field',
      points: 2,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('name') || c.includes('nombre')
      },
    },
    {
      id: 'status-field',
      description: 'Code includes status',
      points: 2,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'status'),
    },
  ],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// 3. Terse mobile-style prompt
// ---------------------------------------------------------------------------

const XCUT_MOBILE_TERSE: AgentEval = {
  id: 'xcut-mobile-terse',
  name: 'Cross-cutting: infer CRM from minimal prompt',
  category: 'cross-cutting' as any,
  level: 3,
  input: 'quick crm. clients, deals, done.',
  workspaceFiles: { 'config.json': V2_CONFIG },
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 10,
  validationCriteria: [
    {
      id: 'wrote-canvas',
      description: 'Wrote canvas source files',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'client-or-deal',
      description: 'Code references clients or deals',
      points: 3,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'client') || anyCanvasCodeContains(r, 'deal'),
    },
    {
      id: 'prisma-schema',
      description: 'Created or updated Prisma schema',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteSchema(r),
    },
  ],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// 4. Fiscal year memory + quarterly dashboard
// ---------------------------------------------------------------------------

const XCUT_MEMORY_RECALL: AgentEval = {
  id: 'xcut-memory-recall',
  name: 'Cross-cutting: April fiscal year + quarterly revenue dashboard',
  category: 'cross-cutting' as any,
  level: 4,
  conversationHistory: [
    {
      role: 'user',
      content:
        'Just so you know, our fiscal year starts in April, not January. Everything should be based on that.',
    },
    {
      role: 'assistant',
      content:
        "Got it! I'll use April as the start of your fiscal year for all financial calculations and reporting.",
    },
    {
      role: 'user',
      content: "Can you check if my Slack is still connected? I think it dropped.",
    },
  ],
  input: 'Build me a quarterly revenue dashboard. Show Q1 through Q4 with monthly breakdowns.',
  workspaceFiles: { 'config.json': V2_CONFIG },
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 14,
  validationCriteria: [
    {
      id: 'wrote-canvas',
      description: 'Wrote canvas source files',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'quarter-breakdown',
      description: 'Code references quarters (Q1–Q4 or quarter)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('quarter') || c.includes('q1') || c.includes('q2') || c.includes('q3') || c.includes('q4')
      },
    },
    {
      id: 'april-fiscal-year',
      description: 'Code shows April-based fiscal year (not calendar Q1 = January only)',
      points: 4,
      phase: 'execution',
      validate: (r) => fiscalYearAprilEvidence(r),
    },
    {
      id: 'revenue',
      description: 'Code references revenue',
      points: 3,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'revenue'),
    },
  ],
  antiPatterns: ['Q1 starts in January without April fiscal year context'],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// 5. Delegation judgment — trivial (no sub-agent)
// ---------------------------------------------------------------------------

const XCUT_DELEGATION_JUDGMENT_SIMPLE: AgentEval = {
  id: 'xcut-delegation-judgment-simple',
  name: 'Cross-cutting: answer trivial math without delegating',
  category: 'cross-cutting' as any,
  level: 2,
  input: "What's 2+2?",
  maxScore: 8,
  validationCriteria: [
    {
      id: 'answer-four',
      description: 'Response states the result is 4',
      points: 4,
      phase: 'execution',
      validate: (r) => responseContains(r, '4'),
    },
    {
      id: 'no-subagent',
      description: 'Did not spawn a sub-agent for a trivial question',
      points: 4,
      phase: 'intention',
      validate: (r) => !subagentWasSpawned(r),
    },
  ],
  antiPatterns: ['delegated-trivial'],
  tags: ['cross-cutting', 'static'],
}

// ---------------------------------------------------------------------------
// 6. Delegation judgment — parallel research
// ---------------------------------------------------------------------------

const XCUT_DELEGATION_JUDGMENT_COMPLEX: AgentEval = {
  id: 'xcut-delegation-judgment-complex',
  name: 'Cross-cutting: parallel competitive intel across five companies',
  category: 'cross-cutting' as any,
  level: 4,
  input:
    'I need competitive intelligence on 5 companies: AlphaTech, BetaCorp, GammaIO, DeltaLabs, and EpsilonAI. Research their products, pricing, and recent news. Do all 5 at the same time.',
  toolMocks: CROSS_CUTTING_MOCKS satisfies ToolMockMap,
  maxScore: 14,
  validationCriteria: [
    {
      id: 'spawned-subagent',
      description: 'Used task or agent_spawn for heavy parallel work',
      points: 5,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'parallelized',
      description: 'Multiple sub-agent spawns or at least five web calls',
      points: 5,
      phase: 'intention',
      validate: (r) => countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 5,
    },
    {
      id: 'mentions-companies',
      description: 'Response names at least three of the five companies',
      points: 4,
      phase: 'execution',
      validate: (r) => responseCompanyMentionCount(r) >= 3,
    },
  ],
  tags: ['cross-cutting', 'static'],
}

// ---------------------------------------------------------------------------
// 7. Multi-turn canvas error recovery
// ---------------------------------------------------------------------------

const XCUT_ERROR_RECOVERY_LOOP: AgentEval = {
  id: 'xcut-error-recovery-loop',
  name: 'Cross-cutting: task tracker follow-up — colors and edits',
  category: 'cross-cutting' as any,
  level: 4,
  conversationHistory: [
    {
      role: 'user',
      content:
        'The task tracker you built works but the dates are showing as raw strings. Can you format them nicely like "March 15, 2026"?',
    },
    {
      role: 'assistant',
      content:
        'I\'ve updated the date formatting to show dates in a readable format like "March 15, 2026".',
    },
    {
      role: 'user',
      content:
        "Thanks. But now the filter dropdown doesn't show which option is selected — it always looks like \"All\" even when I pick something else.",
    },
  ],
  input:
    "Also the status isn't color coded. Can you make 'done' green, 'in-progress' yellow, and 'todo' gray?",
  workspaceFiles: errorRecoveryWorkspace(),
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 14,
  validationCriteria: [
    {
      id: 'wrote-or-edited',
      description: 'Used write_file or edit_file on the project',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) || usedTool(r, 'edit_file'),
    },
    {
      id: 'done-green',
      description: "Status styling uses green for 'done'",
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('green') || c.includes('#22c55e') || c.includes('emerald')
      },
    },
    {
      id: 'in-progress-yellow',
      description: "Status styling uses yellow/amber for 'in-progress'",
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('yellow') || c.includes('#eab308') || c.includes('amber')
      },
    },
    {
      id: 'status-styled',
      description: 'Status is tied to color/className/style',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        const hasStatus = c.includes('status')
        const hasStyleHook =
          c.includes('color') || c.includes('bg-') || c.includes('classname') || c.includes('style')
        return hasStatus && hasStyleHook
      },
    },
  ],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// 8. Persona adaptation (casual teen homework tracker)
// ---------------------------------------------------------------------------

const XCUT_PERSONA_ADAPTATION: AgentEval = {
  id: 'xcut-persona-adaptation',
  name: 'Cross-cutting: simple homework tracker for casual teen prompt',
  category: 'cross-cutting' as any,
  level: 2,
  input:
    "im 14 and i want to track my homework assignments lol. like which class its for, when its due, if i did it yet",
  workspaceFiles: { 'config.json': V2_CONFIG },
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 8,
  validationCriteria: [
    {
      id: 'wrote-canvas',
      description: 'Wrote canvas source files',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'homework-domain',
      description: 'Code references homework or assignments',
      points: 3,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'homework') || anyCanvasCodeContains(r, 'assignment'),
    },
    {
      id: 'class-field',
      description: 'Code includes class, subject, or course',
      points: 2,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('class') || c.includes('subject') || c.includes('course')
      },
    },
  ],
  antiPatterns: ['homework over-engineering prisma schema'],
  tags: ['cross-cutting'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const CROSS_CUTTING_EVALS: AgentEval[] = [
  XCUT_CSV_MIGRATION,
  XCUT_MULTILINGUAL,
  XCUT_MOBILE_TERSE,
  XCUT_MEMORY_RECALL,
  XCUT_DELEGATION_JUDGMENT_SIMPLE,
  XCUT_DELEGATION_JUDGMENT_COMPLEX,
  XCUT_ERROR_RECOVERY_LOOP,
  XCUT_PERSONA_ADAPTATION,
]
