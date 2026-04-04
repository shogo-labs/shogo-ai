// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Template Evals
 *
 * Real-world functional evals where the agent builds complete skill server
 * setups with Prisma schemas, REST APIs, canvas dashboards, and skill files.
 * Each eval maps to an app template use case and tests the full pipeline:
 *
 *   write schema → auto-generate → populate data → build dashboard → save skill
 *
 * Covers:
 * - Sales Pipeline CRM (sales-revenue template)
 * - Support Ticket Triage (support-ops template)
 * - HR Recruiting Pipeline (hr-recruiting template)
 * - Project Sprint Board (project-manager template)
 * - Content Calendar (marketing-command-center template)
 * - Expense Tracker (personal-assistant template)
 */

import type { AgentEval } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedTool,
  responseContains,
  toolCallsJson,
} from './eval-helpers'

const V2_CONFIG = JSON.stringify({
  heartbeatInterval: 1800,
  heartbeatEnabled: false,
  channels: [],
  activeMode: 'canvas',
  canvasMode: 'code',
  model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
}, null, 2)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function wroteSchema(r: import('./types').EvalResult, ...requiredModels: string[]): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '').toLowerCase()
  return requiredModels.every((m) => content.includes(`model ${m.toLowerCase()}`))
}

function schemaContainsFields(r: import('./types').EvalResult, ...fields: string[]): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '').toLowerCase()
  return fields.every((f) => content.includes(f.toLowerCase()))
}

function schemaUsesPrisma7(r: import('./types').EvalResult): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '')
  const hasNoUrl = !content.includes('url')
  const hasPrismaClient = content.includes('prisma-client') && !content.includes('prisma-client-js')
  return hasNoUrl && hasPrismaClient
}

function isCodeFile(path: string): boolean {
  return /^src\/.*\.(tsx?|jsx?)$/.test(path) || /^canvas\/[^/]+\.ts$/.test(path)
}

function wroteCanvasFile(r: import('./types').EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    return isCodeFile(path)
  })
}

function allCanvasCode(r: import('./types').EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => isCodeFile(String((t.input as any).path ?? '')))
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

function calledApiEndpoint(r: import('./types').EvalResult, path: string, method?: string): boolean {
  const json = toolCallsJson(r)
  const hasPath = json.includes(path.toLowerCase())
  if (!method) return hasPath
  return hasPath && json.includes(method.toLowerCase())
}

function wroteSkillFile(r: import('./types').EvalResult, ...keywords: string[]): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => {
      const path = String((t.input as any).path ?? '').toLowerCase()
      return path.includes('skills/') && path.endsWith('.md')
    })
  if (!write) return false
  if (keywords.length === 0) return true
  const content = String((write.input as any).content ?? '').toLowerCase()
  return keywords.every((k) => content.includes(k.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Tool Mocks - shared across all template evals
// ---------------------------------------------------------------------------

function makeSkillServerMocks(models: string[], sampleData: Record<string, any[]>): ToolMockMap {
  const webPatterns: Array<{ match: Record<string, string>; response: { content: string; status: number } }> = []

  for (const model of models) {
    const plural = model.toLowerCase() + 's'

    webPatterns.push({
      match: { url: plural, method: 'POST' },
      response: {
        content: JSON.stringify({
          ok: true,
          data: { id: `${model.toLowerCase()}-1`, ...(sampleData[model]?.[0] ?? {}) },
        }),
        status: 201,
      },
    })

    webPatterns.push({
      match: { url: plural },
      response: {
        content: JSON.stringify({
          ok: true,
          items: (sampleData[model] ?? []).map((d, i) => ({ id: `${model.toLowerCase()}-${i + 1}`, ...d })),
        }),
        status: 200,
      },
    })
  }

  return {
    exec: {
      type: 'static',
      response: { stdout: '', stderr: '', exitCode: 0 },
    },
    web: {
      type: 'pattern',
      patterns: [
        ...webPatterns,
        {
          match: { url: 'health' },
          response: { content: JSON.stringify({ ok: true }), status: 200 },
        },
      ],
      default: { content: JSON.stringify({ ok: true }), status: 200 },
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Sales Pipeline CRM
// Template: sales-revenue
// ---------------------------------------------------------------------------

const SALES_PIPELINE_MOCKS = makeSkillServerMocks(
  ['Deal', 'Contact'],
  {
    Deal: [
      { name: 'Acme Corp Enterprise', value: 125000, stage: 'negotiation', contactId: 'contact-1', probability: 80, closeDate: '2026-04-15' },
      { name: 'StartupXYZ Pro Plan', value: 24000, stage: 'discovery', contactId: 'contact-2', probability: 30, closeDate: '2026-05-01' },
      { name: 'BigBank Platform', value: 250000, stage: 'closed-won', contactId: 'contact-3', probability: 100, closeDate: '2026-03-20' },
    ],
    Contact: [
      { name: 'Jane Smith', email: 'jane@acme.com', company: 'Acme Corp', role: 'VP Engineering' },
      { name: 'Bob Chen', email: 'bob@startupxyz.io', company: 'StartupXYZ', role: 'CTO' },
      { name: 'Sarah Park', email: 'sarah@bigbank.com', company: 'BigBank', role: 'Head of Platform' },
    ],
  },
)

const SALES_PIPELINE_EVAL: AgentEval = {
  id: 'skill-server-tpl-sales-pipeline',
  name: 'Template: Sales Pipeline CRM with revenue dashboard',
  category: 'skill',
  level: 4,
  input: [
    'Build me a sales CRM to track my deals pipeline.',
    'I need a Deal model (name, value in dollars, stage like discovery/proposal/negotiation/closed-won/closed-lost, probability percentage, expected close date)',
    'and a Contact model (name, email, company, role).',
    'Each deal should link to a contact.',
    'After the server is running, add 3 sample deals and build me a canvas dashboard with pipeline metrics',
    '(total pipeline value, deals by stage, weighted forecast) and a deals table.',
  ].join(' '),
  maxScore: 100,
  toolMocks: SALES_PIPELINE_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Deal and Contact models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Deal', 'Contact'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax (no url, prisma-client generator)',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'deal-has-pipeline-fields',
      description: 'Deal model includes value, stage, probability, closeDate',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'value', 'stage', 'probability'),
    },
    {
      id: 'deal-links-contact',
      description: 'Deal has a relation to Contact',
      points: 5,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'contact'),
    },
    {
      id: 'populated-deals',
      description: 'Created sample deals via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, '/api/deals', 'post') || calledApiEndpoint(r, 'deals', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes Metric components (pipeline value, deal count, etc.)',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes a Table or DataList for deals',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'response-mentions-pipeline',
      description: 'Response explains the pipeline setup',
      points: 5,
      phase: 'execution',
      validate: (r) => responseContains(r, 'pipeline') || responseContains(r, 'deal'),
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'deal'),
    },
  ],
  antiPatterns: [
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// 2. Support Ticket Triage
// Template: support-ops
// ---------------------------------------------------------------------------

const SUPPORT_TICKET_MOCKS = makeSkillServerMocks(
  ['Ticket', 'Escalation'],
  {
    Ticket: [
      { title: 'Login broken on mobile', priority: 'P1', status: 'open', assignee: 'eng-team', category: 'bug', createdAt: '2026-03-23T10:00:00Z' },
      { title: 'Feature request: dark mode', priority: 'P3', status: 'triaged', assignee: 'product', category: 'feature', createdAt: '2026-03-23T09:00:00Z' },
      { title: 'API rate limiting users', priority: 'P0', status: 'in-progress', assignee: 'infra-team', category: 'incident', createdAt: '2026-03-23T08:00:00Z' },
      { title: 'Onboarding email typo', priority: 'P3', status: 'closed', assignee: 'content', category: 'bug', createdAt: '2026-03-22T15:00:00Z' },
    ],
    Escalation: [
      { ticketId: 'ticket-3', reason: 'P0 incident affecting 200+ users', escalatedTo: 'VP Engineering', createdAt: '2026-03-23T08:30:00Z' },
    ],
  },
)

const SUPPORT_TICKET_EVAL: AgentEval = {
  id: 'skill-server-tpl-support-tickets',
  name: 'Template: Support Ticket Triage with SLA dashboard',
  category: 'skill',
  level: 4,
  input: [
    'Set up a support ticket tracking system.',
    'I need a Ticket model (title, description, priority P0-P3, status open/triaged/in-progress/resolved/closed,',
    'category bug/feature/incident/question, assignee, customer email)',
    'and an Escalation model (links to a ticket, reason, escalatedTo, resolved boolean).',
    'Add 4 sample tickets including a P0 incident, then build a canvas ops dashboard showing',
    'ticket counts by status, open P0/P1 count, and a table of all tickets sorted by priority.',
  ].join(' '),
  maxScore: 100,
  toolMocks: SUPPORT_TICKET_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Ticket and Escalation models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Ticket', 'Escalation'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'ticket-has-triage-fields',
      description: 'Ticket model includes priority, status, category, assignee',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'priority', 'status', 'category', 'assignee'),
    },
    {
      id: 'populated-tickets',
      description: 'Created sample tickets via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, 'tickets', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas ops dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes Metric components (P0 count, open tickets, etc.)',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes a tickets table',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'response-mentions-priority',
      description: 'Response references ticket priorities or SLA',
      points: 5,
      phase: 'execution',
      validate: (r) => responseContains(r, 'P0') || responseContains(r, 'priority') || responseContains(r, 'sla'),
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'ticket'),
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
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// 3. HR Recruiting Pipeline
// Template: hr-recruiting
// ---------------------------------------------------------------------------

const RECRUITING_MOCKS = makeSkillServerMocks(
  ['Candidate', 'Interview'],
  {
    Candidate: [
      { name: 'Alice Wang', email: 'alice@gmail.com', role: 'Senior Engineer', stage: 'onsite', source: 'referral', appliedAt: '2026-03-10' },
      { name: 'Marcus Johnson', email: 'marcus@outlook.com', role: 'Product Manager', stage: 'phone-screen', source: 'linkedin', appliedAt: '2026-03-18' },
      { name: 'Priya Patel', email: 'priya@yahoo.com', role: 'Senior Engineer', stage: 'offer', source: 'careers-page', appliedAt: '2026-03-01' },
      { name: 'James Lee', email: 'james@proton.me', role: 'Designer', stage: 'applied', source: 'linkedin', appliedAt: '2026-03-22' },
    ],
    Interview: [
      { candidateId: 'candidate-1', type: 'technical', interviewer: 'Sarah Kim', score: 4, notes: 'Strong system design', scheduledAt: '2026-03-20T14:00:00Z' },
      { candidateId: 'candidate-2', type: 'phone-screen', interviewer: 'Bob Chen', score: 3, notes: 'Good communication', scheduledAt: '2026-03-21T10:00:00Z' },
    ],
  },
)

const RECRUITING_EVAL: AgentEval = {
  id: 'skill-server-tpl-recruiting',
  name: 'Template: HR Recruiting Pipeline with hiring dashboard',
  category: 'skill',
  level: 4,
  input: [
    'Build me a recruiting pipeline tracker.',
    'I need a Candidate model (name, email, role applied for, stage: applied/phone-screen/onsite/offer/hired/rejected, source, notes)',
    'and an Interview model (links to candidate, interview type, interviewer name, score 1-5, notes, scheduled time).',
    'Add 4 sample candidates at different stages and 2 interviews.',
    'Build a canvas dashboard with a hiring funnel (candidates by stage), time-to-hire metrics, and a candidate table.',
  ].join(' '),
  maxScore: 100,
  toolMocks: RECRUITING_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Candidate and Interview models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Candidate', 'Interview'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'candidate-has-pipeline-fields',
      description: 'Candidate model includes stage, role, source',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'stage', 'role', 'source'),
    },
    {
      id: 'interview-has-score',
      description: 'Interview model includes score and interviewer',
      points: 5,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'score', 'interviewer'),
    },
    {
      id: 'populated-candidates',
      description: 'Created sample candidates via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, 'candidates', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas recruiting dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes metrics (candidate counts, pipeline stats)',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes a candidate table',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'candidate') || wroteSkillFile(r, 'recruit'),
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
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// 4. Project Sprint Board
// Template: project-manager
// ---------------------------------------------------------------------------

const SPRINT_BOARD_MOCKS = makeSkillServerMocks(
  ['Task', 'Sprint'],
  {
    Task: [
      { title: 'Implement auth flow', status: 'in-progress', priority: 'high', assignee: 'alice', storyPoints: 8, sprintId: 'sprint-1' },
      { title: 'Design settings page', status: 'todo', priority: 'medium', assignee: 'bob', storyPoints: 5, sprintId: 'sprint-1' },
      { title: 'Write API docs', status: 'done', priority: 'low', assignee: 'charlie', storyPoints: 3, sprintId: 'sprint-1' },
      { title: 'Fix mobile nav bug', status: 'in-review', priority: 'high', assignee: 'alice', storyPoints: 2, sprintId: 'sprint-1' },
      { title: 'Add analytics events', status: 'todo', priority: 'medium', assignee: 'bob', storyPoints: 5, sprintId: 'sprint-1' },
    ],
    Sprint: [
      { name: 'Sprint 23', startDate: '2026-03-17', endDate: '2026-03-28', goal: 'Ship auth + settings', status: 'active' },
    ],
  },
)

const SPRINT_BOARD_EVAL: AgentEval = {
  id: 'skill-server-tpl-sprint-board',
  name: 'Template: Project Sprint Board with velocity metrics',
  category: 'skill',
  level: 4,
  input: [
    'Build a sprint planning and task tracking system for my team.',
    'I need a Task model (title, description, status: todo/in-progress/in-review/done, priority: low/medium/high/critical,',
    'assignee, story points, labels) and a Sprint model (name, start date, end date, goal, status: planned/active/completed).',
    'Each task belongs to a sprint.',
    'Create a current sprint with 5 sample tasks across different statuses.',
    'Build a canvas dashboard with sprint progress (done vs total points), task breakdown by status, and a task board table.',
  ].join(' '),
  maxScore: 100,
  toolMocks: SPRINT_BOARD_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Task and Sprint models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Task', 'Sprint'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'task-has-agile-fields',
      description: 'Task model includes status, priority, storyPoints, assignee',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'status', 'priority', 'assignee') &&
        (schemaContainsFields(r, 'storypoints') || schemaContainsFields(r, 'story_points') || schemaContainsFields(r, 'points')),
    },
    {
      id: 'task-belongs-to-sprint',
      description: 'Task has a relation to Sprint',
      points: 5,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'sprint'),
    },
    {
      id: 'populated-tasks',
      description: 'Created sample tasks via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, 'tasks', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas sprint dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes sprint metrics (points, progress)',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes a task board or table',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'task') || wroteSkillFile(r, 'sprint'),
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
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// 5. Content Calendar
// Template: marketing-command-center
// ---------------------------------------------------------------------------

const CONTENT_CALENDAR_MOCKS = makeSkillServerMocks(
  ['Post', 'Campaign'],
  {
    Post: [
      { title: 'How We Scaled to 10K Users', platform: 'blog', status: 'published', publishDate: '2026-03-20', campaignId: 'campaign-1', author: 'Sarah' },
      { title: 'Product Update: Dark Mode', platform: 'twitter', status: 'scheduled', publishDate: '2026-03-25', campaignId: 'campaign-1', author: 'Mike' },
      { title: 'Customer Success Story: Acme', platform: 'linkedin', status: 'draft', publishDate: '2026-04-01', campaignId: 'campaign-1', author: 'Sarah' },
      { title: 'Weekly Tips Thread', platform: 'twitter', status: 'idea', publishDate: null, campaignId: null, author: 'Mike' },
    ],
    Campaign: [
      { name: 'Q1 Product Launch', startDate: '2026-03-01', endDate: '2026-03-31', goal: 'Drive 500 signups', status: 'active' },
    ],
  },
)

const CONTENT_CALENDAR_EVAL: AgentEval = {
  id: 'skill-server-tpl-content-calendar',
  name: 'Template: Content Calendar with publishing dashboard',
  category: 'skill',
  level: 4,
  input: [
    'Build a content calendar system for my marketing team.',
    'I need a Post model (title, body, platform: blog/twitter/linkedin/newsletter, status: idea/draft/scheduled/published,',
    'publish date, author, tags) and a Campaign model (name, start date, end date, goal, status).',
    'Posts can belong to a campaign.',
    'Add 4 sample posts across different statuses and platforms, plus a campaign.',
    'Build a canvas dashboard with publishing metrics (posts by status, by platform), upcoming schedule, and a content table.',
  ].join(' '),
  maxScore: 100,
  toolMocks: CONTENT_CALENDAR_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Post and Campaign models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Post', 'Campaign'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'post-has-content-fields',
      description: 'Post model includes platform, status, publishDate, author',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'platform', 'status', 'author'),
    },
    {
      id: 'populated-posts',
      description: 'Created sample posts via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, 'posts', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas content dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes publishing metrics',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes a content table or calendar view',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'content') || wroteSkillFile(r, 'post') || wroteSkillFile(r, 'calendar'),
    },
    {
      id: 'response-mentions-content-workflow',
      description: 'Response discusses content workflow or publishing',
      points: 5,
      phase: 'execution',
      validate: (r) => responseContains(r, 'publish') || responseContains(r, 'content') || responseContains(r, 'schedule'),
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
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// 6. Expense Tracker
// Template: personal-assistant
// ---------------------------------------------------------------------------

const EXPENSE_TRACKER_MOCKS = makeSkillServerMocks(
  ['Expense', 'Budget'],
  {
    Expense: [
      { description: 'AWS monthly bill', amount: 450, category: 'infrastructure', date: '2026-03-01', vendor: 'Amazon Web Services', recurring: true },
      { description: 'Team lunch', amount: 85, category: 'meals', date: '2026-03-15', vendor: 'Restaurant', recurring: false },
      { description: 'Figma subscription', amount: 45, category: 'software', date: '2026-03-01', vendor: 'Figma', recurring: true },
      { description: 'Conference travel', amount: 1200, category: 'travel', date: '2026-03-10', vendor: 'Delta Airlines', recurring: false },
      { description: 'Office supplies', amount: 120, category: 'office', date: '2026-03-18', vendor: 'Staples', recurring: false },
    ],
    Budget: [
      { category: 'infrastructure', monthlyLimit: 2000, currentSpend: 450 },
      { category: 'software', monthlyLimit: 500, currentSpend: 245 },
      { category: 'travel', monthlyLimit: 3000, currentSpend: 1200 },
    ],
  },
)

const EXPENSE_TRACKER_EVAL: AgentEval = {
  id: 'skill-server-tpl-expense-tracker',
  name: 'Template: Expense Tracker with budget dashboard',
  category: 'skill',
  level: 4,
  input: [
    'Build an expense tracking system for my small business.',
    'I need an Expense model (description, amount in cents, category: infrastructure/software/meals/travel/office/other,',
    'date, vendor, receipt URL optional, recurring boolean)',
    'and a Budget model (category, monthly limit, period like 2026-03).',
    'Add 5 sample expenses across different categories and 3 budget entries.',
    'Build a canvas dashboard with total spend this month, spend by category, budget utilization metrics, and an expense table.',
  ].join(' '),
  maxScore: 100,
  toolMocks: EXPENSE_TRACKER_MOCKS,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  validationCriteria: [
    {
      id: 'wrote-schema-with-models',
      description: 'Created schema.prisma with Expense and Budget models',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Expense', 'Budget'),
    },
    {
      id: 'schema-prisma7',
      description: 'Schema uses Prisma 7 syntax',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaUsesPrisma7(r),
    },
    {
      id: 'expense-has-tracking-fields',
      description: 'Expense model includes amount, category, vendor, recurring',
      points: 10,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'amount', 'category', 'vendor'),
    },
    {
      id: 'budget-has-limit',
      description: 'Budget model includes monthly limit or budget amount',
      points: 5,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'limit') || schemaContainsFields(r, 'budget') || schemaContainsFields(r, 'amount'),
    },
    {
      id: 'populated-expenses',
      description: 'Created sample expenses via the REST API',
      points: 15,
      phase: 'execution',
      validate: (r) => calledApiEndpoint(r, 'expenses', 'post'),
    },
    {
      id: 'built-canvas-dashboard',
      description: 'Created a canvas expense dashboard',
      points: 15,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'dashboard-has-metrics',
      description: 'Dashboard includes spend metrics',
      points: 10,
      phase: 'execution',
      validate: (r) => allCanvasCode(r).includes('metric') || allCanvasCode(r).includes('total') || allCanvasCode(r).includes('count'),
    },
    {
      id: 'dashboard-has-table',
      description: 'Dashboard includes an expense table',
      points: 10,
      phase: 'execution',
      validate: (r) => { const c = allCanvasCode(r); return c.includes('table') || c.includes('list') || c.includes('<tr') || c.includes('map(') },
    },
    {
      id: 'wrote-skill-file',
      description: 'Saved a reusable skill file',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSkillFile(r, 'expense') || wroteSkillFile(r, 'budget'),
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
    'Unnecessary clarification questions instead of building',
    'Loop of repeated tool calls',
  ],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const SKILL_SERVER_TEMPLATE_EVALS: AgentEval[] = [
  SALES_PIPELINE_EVAL,
  SUPPORT_TICKET_EVAL,
  RECRUITING_EVAL,
  SPRINT_BOARD_EVAL,
  CONTENT_CALENDAR_EVAL,
  EXPENSE_TRACKER_EVAL,
]
