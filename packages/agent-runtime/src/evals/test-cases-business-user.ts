// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Business User Mega Eval — "Pixel & Co."
 *
 * 5 multi-turn evals simulating a small-business owner (Maya) progressively
 * adopting Shogo to run her 12-person digital agency.  Each eval is one
 * phase of adoption (~4 user turns) and seeds its workspace with the assumed
 * output of prior phases so the 5 phases can run independently in parallel.
 *
 * Phases:
 *   1. Onboarding — intro, Slack, email, heartbeat
 *   2. Core Apps  — CRM, deals pipeline, project tracker, team directory
 *   3. Financials — expense dashboard, revenue analysis, competitive research, KPI dashboard
 *   4. Integrations — GitHub, calendar, onboarding checklist app, weekly digest
 *   5. Operations — morning briefing, incident response, QBR, project audit
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import { BUSINESS_USER_MOCKS } from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  toolCallArgsContain,
  toolCallCount,
  responseContains,
  toolCallsJson,
  anyExecToSkillServerSucceeded,
  lastSkillServerExecSucceeded,
} from './eval-helpers'
import { buildSkillServerSchema } from '../workspace-defaults'

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

const V2_CONFIG_WITH_CHANNELS = JSON.stringify({
  heartbeatInterval: 3600,
  heartbeatEnabled: true,
  channels: [
    { type: 'slack', config: { botToken: 'xoxb-fake-slack-token-12345', appToken: 'xapp-fake-app-token-67890' } },
    { type: 'email', config: { email: 'maya@pixelandco.com', imapHost: 'imap.pixelandco.com', smtpHost: 'smtp.pixelandco.com' } },
  ],
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

function wroteCanvasFile(r: EvalResult, namePattern?: RegExp): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    if (!isCodeFile(path)) return false
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

function canvasCodeFetches(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return code.includes('fetch(') && (code.includes('localhost:') || code.includes('/api/'))
}

function subagentWasSpawned(r: EvalResult): boolean {
  return usedTool(r, 'task') || usedTool(r, 'agent_spawn')
}

function countSubagentSpawns(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'task' || tc.name === 'agent_spawn').length
}

// ---------------------------------------------------------------------------
// Workspace generators — each phase seeds prior-phase output
// ---------------------------------------------------------------------------

function phase1Workspace(): Record<string, string> {
  return {}
}

function phase2Workspace(): Record<string, string> {
  // Runtime template (index.html, package.json, tsconfig, etc.) and skill server
  // scaffold (shogo.config.json, prisma.config.ts) are provided by the
  // useRuntimeTemplate / useSkillServer eval flags. Only eval-specific overlays here.
  return {
    'config.json': V2_CONFIG_WITH_CHANNELS,
    'src/App.tsx': [
      'import React from "react"',
      'export default function App() {',
      '  return <div className="p-4"><h1 className="text-2xl font-bold">Pixel & Co.</h1></div>',
      '}',
    ].join('\n'),
  }
}

const PRISMA_SCHEMA_PHASE2 = buildSkillServerSchema(`model Client {
  id        String   @id @default(cuid())
  company   String
  contact   String
  email     String
  phone     String
  industry  String
  signedOn  DateTime
  deals     Deal[]
  projects  Project[]
  createdAt DateTime @default(now())
}

model Deal {
  id            String   @id @default(cuid())
  name          String
  value         Float
  stage         String
  expectedClose DateTime
  client        Client   @relation(fields: [clientId], references: [id])
  clientId      String
  createdAt     DateTime @default(now())
}

model Project {
  id        String   @id @default(cuid())
  name      String
  status    String
  startDate DateTime
  deadline  DateTime
  budget    Float
  members   String
  client    Client   @relation(fields: [clientId], references: [id])
  clientId  String
  createdAt DateTime @default(now())
}

model TeamMember {
  id         String   @id @default(cuid())
  name       String
  role       String
  email      String
  department String
  startDate  DateTime
  skills     String
  createdAt  DateTime @default(now())
}`)

const INVOICES_CSV = [
  'invoice_id,client,amount,status,due_date,paid_date',
  'INV-001,Acme Corp,12000,paid,2026-01-15,2026-01-14',
  'INV-002,Bloom Skincare,8500,paid,2026-01-20,2026-01-28',
  'INV-003,FitGear,15000,paid,2026-02-01,2026-02-10',
  'INV-004,Acme Corp,12000,paid,2026-02-15,2026-02-14',
  'INV-005,Luxe Candles,6000,paid,2026-02-20,2026-03-05',
  'INV-006,RetailMax,9500,overdue,2026-02-28,',
  'INV-007,Bloom Skincare,8500,paid,2026-03-01,2026-03-02',
  'INV-008,FitGear,15000,paid,2026-03-01,2026-03-08',
  'INV-009,Acme Corp,12000,paid,2026-03-15,2026-03-14',
  'INV-010,Terrain Outdoor,7500,overdue,2026-03-10,',
  'INV-011,Bloom Skincare,8500,sent,2026-04-01,',
  'INV-012,Luxe Candles,6000,paid,2026-03-20,2026-04-01',
  'INV-013,FitGear,15000,sent,2026-04-01,',
  'INV-014,Acme Corp,14000,draft,2026-04-15,',
  'INV-015,RetailMax,9500,overdue,2026-03-28,',
  'INV-016,Terrain Outdoor,7500,sent,2026-04-05,',
  'INV-017,Bloom Skincare,10000,draft,2026-04-10,',
  'INV-018,FitGear,18000,draft,2026-04-15,',
  'INV-019,Luxe Candles,6000,sent,2026-04-08,',
  'INV-020,Acme Corp,12000,paid,2026-01-15,2026-01-20',
  'INV-021,Acme Corp,13000,paid,2026-02-15,2026-02-16',
  'INV-022,Bloom Skincare,9000,paid,2026-01-10,2026-01-12',
  'INV-023,FitGear,16000,paid,2026-02-20,2026-02-25',
  'INV-024,RetailMax,9500,paid,2026-01-28,2026-02-15',
  'INV-025,Luxe Candles,5500,paid,2026-01-15,2026-01-16',
  'INV-026,Terrain Outdoor,8000,paid,2026-02-05,2026-02-08',
  'INV-027,RetailMax,10000,paid,2026-03-01,2026-03-20',
  'INV-028,Luxe Candles,6500,paid,2026-03-05,2026-03-06',
  'INV-029,Terrain Outdoor,7000,paid,2026-03-15,2026-03-16',
  'INV-030,Bloom Skincare,9500,paid,2026-03-20,2026-03-21',
].join('\n')

function phase3Workspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    'prisma/schema.prisma': PRISMA_SCHEMA_PHASE2,
    'files/invoices.csv': INVOICES_CSV,
  }
}

const PRISMA_SCHEMA_PHASE3 = PRISMA_SCHEMA_PHASE2 + `

model Expense {
  id          String   @id @default(cuid())
  description String
  amount      Float
  category    String
  date        DateTime
  submittedBy String
  createdAt   DateTime @default(now())
}

model Invoice {
  id       String   @id @default(cuid())
  client   String
  amount   Float
  status   String
  dueDate  DateTime
  paidDate DateTime?
  createdAt DateTime @default(now())
}`

function phase4Workspace(): Record<string, string> {
  return {
    ...phase3Workspace(),
    'prisma/schema.prisma': PRISMA_SCHEMA_PHASE3,
  }
}

const PROJECTS_JSON = JSON.stringify([
  { name: 'Acme Corp Redesign', client: 'Acme Corp', status: 'in-progress', startDate: '2026-01-15', deadline: '2026-04-15', budget: 48000, spent: 42000, members: ['James', 'Sarah', 'Mike'], blockers: ['Waiting on brand guidelines v2'] },
  { name: 'Bloom Skincare Shopify', client: 'Bloom Skincare', status: 'review', startDate: '2026-02-01', deadline: '2026-04-01', budget: 25000, spent: 23000, members: ['Sarah', 'Lisa'], blockers: [] },
  { name: 'FitGear Mobile App', client: 'FitGear', status: 'in-progress', startDate: '2026-01-01', deadline: '2026-05-30', budget: 60000, spent: 35000, members: ['James', 'Mike', 'Tom', 'Nina'], blockers: ['API rate limiting issues'] },
  { name: 'Luxe Candles Migration', client: 'Luxe Candles', status: 'planning', startDate: '2026-03-15', deadline: '2026-06-15', budget: 18000, spent: 2000, members: ['Lisa'], blockers: [] },
  { name: 'RetailMax AI Chatbot', client: 'RetailMax', status: 'in-progress', startDate: '2026-02-15', deadline: '2026-04-10', budget: 30000, spent: 28500, members: ['Tom', 'Nina'], blockers: ['Model accuracy below target', 'Client delayed training data'] },
  { name: 'Terrain Outdoor Branding', client: 'Terrain Outdoor', status: 'done', startDate: '2026-01-10', deadline: '2026-03-10', budget: 15000, spent: 14200, members: ['Lisa', 'Sarah'], blockers: [] },
  { name: 'Internal Tools Dashboard', client: 'Pixel & Co.', status: 'in-progress', startDate: '2026-03-01', deadline: '2026-04-30', budget: 8000, spent: 3500, members: ['Mike'], blockers: [] },
  { name: 'PixelCo Website Refresh', client: 'Pixel & Co.', status: 'planning', startDate: '2026-04-01', deadline: '2026-05-15', budget: 12000, spent: 0, members: ['Sarah', 'Lisa'], blockers: ['Need copy from marketing'] },
], null, 2)

function phase5Workspace(): Record<string, string> {
  return {
    ...phase4Workspace(),
    'files/projects.json': PROJECTS_JSON,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (biz-onboarding) — Level 2, 30 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'biz-onboarding',
  name: 'Business User: Onboarding — channels, heartbeat',
  category: 'business-user' as any,
  level: 2,
  pipeline: 'business-user',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "Hi! I'm Maya, I run a digital agency called Pixel & Co. We have 12 people — " +
        '4 designers, 5 developers, 2 PMs, and me. Our clients are mid-size e-commerce brands. ' +
        'I want to use you to help me run the whole business. What can you do for me?',
    },
    {
      role: 'user',
      content:
        "Let's start by connecting our team Slack. Here's the bot token: " +
        'xoxb-fake-slack-token-12345 and the app token: xapp-fake-app-token-67890',
    },
    {
      role: 'user',
      content:
        'Also connect my work email — maya@pixelandco.com, IMAP is imap.pixelandco.com, ' +
        'SMTP is smtp.pixelandco.com, password fakepass123',
    },
  ],
  input:
    "One more thing — check in with me every morning. Quick summary of what's happening. " +
    "But don't bug me after 7pm.",
  askUserResponses: [
    'Sounds great! Let\'s start with channels and automations. Use the tokens I gave you directly.',
    'Just use the credentials I provided. My timezone is America/New_York.',
    'Morning means 8am. Use America/New_York timezone. Just set it up.',
  ],
  workspaceFiles: phase1Workspace(),
  toolMocks: BUSINESS_USER_MOCKS,
  maxScore: 37,
  validationCriteria: [
    // --- Interaction phase: validate the agent asks good questions ---
    {
      id: 'asked-about-timezone',
      description: 'Agent asked about timezone before configuring heartbeat',
      points: 4,
      phase: 'interaction',
      validate: (r) => {
        const json = toolCallsJson(r)
        const text = r.responseText.toLowerCase()
        const allText = (json + ' ' + text).toLowerCase()
        return json.includes('ask_user') && (allText.includes('timezone') || allText.includes('time zone'))
      },
    },
    {
      id: 'asked-about-schedule',
      description: 'Agent clarified morning time or quiet hours details',
      points: 3,
      phase: 'interaction',
      validate: (r) => {
        const allText = (toolCallsJson(r) + ' ' + r.responseText).toLowerCase()
        return allText.includes('morning') || allText.includes('what time') || allText.includes('quiet')
      },
    },
    // --- Execution phase: validate actual tool usage after answers ---
    {
      id: 'slack-connected',
      description: 'Connected Slack channel with provided tokens',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'channel_connect') &&
        toolCallArgsContain(r, 'channel_connect', 'slack'),
    },
    {
      id: 'slack-tokens',
      description: 'Slack config includes both bot and app tokens',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('xoxb-fake-slack-token') && json.includes('xapp-fake-app-token')
      },
    },
    {
      id: 'email-connected',
      description: 'Connected email channel with IMAP/SMTP details',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'channel_connect') &&
        toolCallArgsContain(r, 'channel_connect', 'email'),
    },
    {
      id: 'email-details',
      description: 'Email config includes IMAP and SMTP hosts',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('imap.pixelandco.com') && json.includes('smtp.pixelandco.com')
      },
    },
    {
      id: 'heartbeat-configured',
      description: 'Configured heartbeat for daily check-ins',
      points: 6,
      phase: 'intention',
      validate: (r) => usedToolAnywhere(r, 'heartbeat_configure'),
    },
    {
      id: 'quiet-hours',
      description: 'Set quiet hours ending after 7pm',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('19:') || json.includes('7:00') || json.includes('7pm') ||
               json.includes('21:') || json.includes('22:') || json.includes('quiet')
      },
    },
  ],
  tags: ['business-user'],
}

// ---------------------------------------------------------------------------
// Phase 2: Core Apps (biz-core-apps) — Level 3, 50 points
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'biz-core-apps',
  name: 'Business User: Core Apps — CRM, deals, projects, team',
  category: 'business-user' as any,
  level: 3,
  pipeline: 'business-user',
  pipelinePhase: 2,
  pipelineFiles: {
    'config.json': V2_CONFIG_WITH_CHANNELS,
  },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need a way to track all our clients. For each client I want to store their company ' +
        "name, main contact person, email, phone, which industry they're in, and when they signed on. " +
        'Can you build me something?',
    },
    {
      role: 'user',
      content:
        'Love it! Now I also need to track deals. Each deal has a name, value in dollars, which ' +
        'client it\'s for, a stage (lead, proposal, negotiation, won, lost), and an expected close date. ' +
        "I want to see them as a pipeline — like a kanban board where I can see deals in each stage.",
    },
    {
      role: 'user',
      content:
        'We need a project tracker too. Each project has a name, client, status ' +
        '(planning, in-progress, review, done), start date, deadline, assigned team members, and a budget. ' +
        'Show me all active projects with how close they are to deadline.',
    },
  ],
  input:
    "Last one — a team directory. Everyone's name, role, email, department " +
    '(design, dev, pm, leadership), start date, and skills. Pre-populate it with my 12 people — ' +
    'make up realistic details.',
  workspaceFiles: phase2Workspace(),
  useRuntimeTemplate: true,
  useSkillServer: true,
  toolMocks: BUSINESS_USER_MOCKS,
  initialMode: 'canvas' as const,
  maxScore: 55,
  validationCriteria: [
    // CRM
    {
      id: 'wrote-client-schema',
      description: 'Created a Prisma schema with a Client model',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Client'),
    },
    {
      id: 'client-ui',
      description: 'Built a UI component for client management',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && anyCanvasCodeContains(r, 'client'),
    },
    // Deals
    {
      id: 'wrote-deal-schema',
      description: 'Created a Deal model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Deal'),
    },
    {
      id: 'deal-pipeline-ui',
      description: 'Built pipeline/kanban UI with deal stages',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const hasStages = ['lead', 'proposal', 'negotiation', 'won'].some(s => code.includes(s))
        return hasStages
      },
    },
    // Projects
    {
      id: 'wrote-project-schema',
      description: 'Created a Project model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Project'),
    },
    {
      id: 'project-deadline-indicator',
      description: 'Project UI shows deadline proximity (days, progress, color)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('deadline') || code.includes('days') || code.includes('overdue') || code.includes('progress')
      },
    },
    // Team directory
    {
      id: 'wrote-team-schema',
      description: 'Created a TeamMember model in schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && (schemaContainsModel(r, 'TeamMember') || schemaContainsModel(r, 'Team')),
    },
    {
      id: 'team-directory-ui',
      description: 'Built team directory UI with department/role info',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return (code.includes('design') || code.includes('department')) && code.includes('team')
      },
    },
    {
      id: 'team-seed-data',
      description: 'Pre-populated with realistic team data',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const json = toolCallsJson(r)
        const hasNames = (code.match(/['"][A-Z][a-z]+/g) || []).length >= 5 ||
                         (json.match(/['"][A-Z][a-z]+/g) || []).length >= 5
        return hasNames
      },
    },
    // Full-stack wiring
    {
      id: 'canvas-fetches-api',
      description: 'Canvas code uses fetch() to call the skill server API',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'ran-prisma-generate',
      description: 'Ran prisma generate or shogo generate to scaffold backend',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('prisma') || json.includes('shogo generate') || json.includes('db push')
      },
    },
    {
      id: 'exec-api-succeeded',
      description: 'At least one exec call to the skill server returned valid data',
      points: 3,
      phase: 'execution',
      validate: (r) => anyExecToSkillServerSucceeded(r),
    },
    {
      id: 'exec-no-persistent-errors',
      description: 'Last exec call to the skill server did not return an error',
      points: 2,
      phase: 'execution',
      validate: (r) => lastSkillServerExecSucceeded(r),
    },
  ],
  tags: ['business-user'],
}

// ---------------------------------------------------------------------------
// Phase 3: Financials (biz-financials) — Level 4, 65 points
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'biz-financials',
  name: 'Business User: Financials — dashboards, sub-agent research',
  category: 'business-user' as any,
  level: 4,
  pipeline: 'business-user',
  pipelinePhase: 3,
  pipelineFiles: {
    'files/invoices.csv': INVOICES_CSV,
  },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need a financial dashboard. Track expenses (description, amount, category like ' +
        'software/travel/office/contractors, date, who submitted it) and invoices (client name, amount, ' +
        'status: draft/sent/paid/overdue, due date). Show me totals, a chart of expenses by category, ' +
        'and a list of overdue invoices.',
    },
    {
      role: 'user',
      content:
        "Now analyze our revenue. I put our invoice data in the files folder. Check payment " +
        'patterns, find slow payers, and summarize. This is a lot of analysis so feel free to ' +
        'delegate the research to an agent.',
    },
    {
      role: 'user',
      content:
        "I want to understand what our competitors are doing. Research these three agencies: " +
        "'Webflow Studio', 'Digital Forge', and 'Creative Dynamics'. Look at their services, " +
        'pricing approach, and recent work. Do all three at the same time so it\'s faster.',
    },
  ],
  input:
    'Build me an executive KPI dashboard — revenue this quarter, active projects, average deal ' +
    'size, team utilization, client satisfaction score, and new leads this month. Use charts where ' +
    'it makes sense. I want this to look professional enough for an investor meeting.',
  workspaceFiles: phase3Workspace(),
  useRuntimeTemplate: true,
  useSkillServer: true,
  toolMocks: BUSINESS_USER_MOCKS,
  initialMode: 'canvas' as const,
  maxScore: 65,
  validationCriteria: [
    // Turn 1: expense dashboard
    {
      id: 'wrote-expense-model',
      description: 'Created Expense model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Expense'),
    },
    {
      id: 'wrote-invoice-model',
      description: 'Created Invoice model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Invoice'),
    },
    {
      id: 'expense-chart',
      description: 'Built a chart for expenses (Recharts or similar)',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart') || code.includes('barchart') || code.includes('piechart')
      },
    },
    {
      id: 'overdue-filter',
      description: 'Dashboard filters or highlights overdue invoices',
      points: 4,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'overdue'),
    },
    // Turn 2: revenue analysis with sub-agent
    {
      id: 'delegated-revenue-analysis',
      description: 'Delegated revenue analysis to a sub-agent',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'revenue-data-referenced',
      description: 'Analysis references the invoice data or slow payers',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return (text.includes('revenue') || text.includes('invoice')) &&
               (text.includes('slow') || text.includes('overdue') || text.includes('late') || text.includes('pattern'))
      },
    },
    // Turn 3: competitive research
    {
      id: 'parallel-competitor-research',
      description: 'Launched multiple sub-agents or web searches for competitors',
      points: 7,
      phase: 'intention',
      validate: (r) => {
        const spawns = countSubagentSpawns(r)
        const webCalls = toolCallCount(r, 'web')
        return spawns >= 3 || webCalls >= 3
      },
    },
    {
      id: 'all-competitors-covered',
      description: 'Response mentions all three competitor agencies',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'webflow') &&
        responseContains(r, 'digital forge') &&
        responseContains(r, 'creative dynamics'),
    },
    // Turn 4 (input): KPI dashboard
    {
      id: 'kpi-dashboard-built',
      description: 'Built a KPI dashboard with multiple metrics',
      points: 6,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && anyCanvasCodeContains(r, 'revenue'),
    },
    {
      id: 'kpi-charts',
      description: 'KPI dashboard uses charts (Recharts)',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'kpi-multiple-metrics',
      description: 'Dashboard displays at least 4 distinct KPI metrics',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const text = r.responseText.toLowerCase()
        const combined = code + ' ' + text
        const metrics = ['revenue', 'project', 'deal', 'utilization', 'satisfaction', 'lead']
        return metrics.filter(m => combined.includes(m)).length >= 4
      },
    },
    {
      id: 'professional-layout',
      description: 'Dashboard has a professional layout (grid, cards)',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return (code.includes('grid') || code.includes('flex')) && (code.includes('card') || code.includes('section'))
      },
    },
  ],
  tags: ['business-user'],
}

// ---------------------------------------------------------------------------
// Phase 4: Integrations (biz-integrations) — Level 3, 45 points
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'biz-integrations',
  name: 'Business User: Integrations — GitHub, calendar, automation',
  category: 'business-user' as any,
  pipeline: 'business-user',
  pipelinePhase: 4,
  pipelineFiles: {},
  level: 3,
  conversationHistory: [
    {
      role: 'user',
      content:
        'Our dev team uses GitHub. Can you connect to it so you can see our repos and pull ' +
        "requests? I want to be able to ask you about what the team is shipping.",
    },
    {
      role: 'user',
      content:
        'Connect to my Google Calendar too. I want you to know about my meetings so you can ' +
        'help me prep and avoid scheduling conflicts.',
    },
    {
      role: 'user',
      content:
        "When we sign a new client, there are always a million things to do — create their " +
        'project folder, set up a Slack channel, schedule the kickoff meeting, assign a PM, send the ' +
        'welcome packet. Build me an app where I can add a new client and it gives me a checklist of ' +
        'all these onboarding steps that I can check off as we complete them.',
    },
  ],
  input:
    'Every Friday at 4pm, I want you to send a digest to our Slack channel with: how many ' +
    'projects shipped this week, any deals that closed, upcoming deadlines for next week, and any ' +
    'overdue invoices. Set this up as an automated thing.',
  workspaceFiles: phase4Workspace(),
  useRuntimeTemplate: true,
  useSkillServer: true,
  toolMocks: BUSINESS_USER_MOCKS,
  initialMode: 'canvas' as const,
  maxScore: 45,
  validationCriteria: [
    // Turn 1: GitHub
    {
      id: 'searched-github',
      description: 'Searched for GitHub integration (tool_search or mcp_search)',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const searched = usedToolAnywhere(r, 'tool_search') || usedToolAnywhere(r, 'mcp_search')
        const mentioned = toolCallsJson(r).includes('github')
        return searched && mentioned
      },
    },
    {
      id: 'installed-github',
      description: 'Attempted to install GitHub integration',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'tool_install') || usedToolAnywhere(r, 'mcp_install'),
    },
    // Turn 2: Calendar
    {
      id: 'searched-calendar',
      description: 'Searched for calendar integration',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('calendar')
      },
    },
    {
      id: 'installed-calendar',
      description: 'Attempted to install calendar integration',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const installCount = toolCallCount(r, 'tool_install') + toolCallCount(r, 'mcp_install')
        return installCount >= 2
      },
    },
    // Turn 3: onboarding checklist app
    {
      id: 'onboarding-schema',
      description: 'Created schema for onboarding checklist',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return (json.includes('onboarding') || json.includes('checklist') || json.includes('task'))
               && wroteSchema(r)
      },
    },
    {
      id: 'checklist-ui',
      description: 'Built checklist UI with toggle/checkbox functionality',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return (code.includes('checkbox') || code.includes('check') || code.includes('toggle') ||
                code.includes('complete')) && code.includes('onboarding') || code.includes('checklist')
      },
    },
    {
      id: 'checklist-steps',
      description: 'Checklist includes predefined onboarding steps',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const json = toolCallsJson(r)
        const combined = code + json
        const steps = ['slack', 'kickoff', 'pm', 'welcome', 'folder']
        return steps.filter(s => combined.includes(s)).length >= 3
      },
    },
    // Turn 4 (input): weekly digest automation
    {
      id: 'digest-scheduling',
      description: 'Set up scheduling for the weekly digest (heartbeat or cron)',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const usedScheduling = usedToolAnywhere(r, 'heartbeat_configure') || usedTool(r, 'write_file')
        const text = r.responseText.toLowerCase()
        const mentionsSchedule = text.includes('friday') || text.includes('weekly') ||
                                  text.includes('automat') || text.includes('schedule')
        return usedScheduling || mentionsSchedule
      },
    },
    {
      id: 'digest-content-items',
      description: 'Digest describes all requested content (projects, deals, deadlines, invoices)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        const items = ['project', 'deal', 'deadline', 'invoice']
        return items.filter(i => text.includes(i)).length >= 3
      },
    },
    {
      id: 'digest-slack-delivery',
      description: 'Digest mentions delivery via Slack',
      points: 3,
      phase: 'execution',
      validate: (r) => responseContains(r, 'slack'),
    },
  ],
  tags: ['business-user'],
}

// ---------------------------------------------------------------------------
// Phase 5: Daily Operations (biz-operations) — Level 5, 75 points
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'biz-operations',
  name: 'Business User: Operations — briefing, incident, QBR, audit',
  category: 'business-user' as any,
  pipeline: 'business-user',
  pipelinePhase: 5,
  pipelineFiles: {
    'files/projects.json': PROJECTS_JSON,
  },
  level: 5,
  conversationHistory: [
    {
      role: 'user',
      content:
        'Good morning! Daily briefing please — today\'s meetings, GitHub PRs needing review, ' +
        'overdue invoices, and projects near their deadline. Delegate the different lookups to save time.',
    },
    {
      role: 'user',
      content:
        "URGENT — Acme Corp just called. Their website is showing errors and they need it " +
        'fixed today. Can you check our GitHub for their repo and see what recent changes were made? ' +
        'Build me a quick incident tracker so we can manage this.',
    },
    {
      role: 'user',
      content:
        "It's end of quarter. Build me a quarterly business review dashboard showing: revenue " +
        'trend over the past 3 months, deals won vs lost, project completion rate, top 5 clients by ' +
        'revenue, team productivity metrics, and a comparison to last quarter. This needs to look ' +
        'polished enough to show my investors.',
    },
  ],
  input:
    "I'm worried some of our projects are behind schedule and over budget. Can you do a full " +
    'audit? Check every active project — look at the timeline, budget usage, team assignments, and ' +
    'any blockers. Have your agents do the deep analysis and give me a summary with recommendations ' +
    'for each project.',
  workspaceFiles: phase5Workspace(),
  useRuntimeTemplate: true,
  useSkillServer: true,
  toolMocks: BUSINESS_USER_MOCKS,
  initialMode: 'canvas' as const,
  maxScore: 75,
  validationCriteria: [
    // Turn 1: morning briefing
    {
      id: 'briefing-delegation',
      description: 'Delegated briefing lookups to sub-agents',
      points: 8,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'briefing-multi-source',
      description: 'Briefing covers multiple data sources (calendar, GitHub, invoices, projects)',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        const json = toolCallsJson(r)
        const combined = text + json
        const sources = ['calendar', 'meeting', 'github', 'pr', 'invoice', 'overdue', 'project', 'deadline']
        return sources.filter(s => combined.includes(s)).length >= 4
      },
    },
    // Turn 2: incident response
    {
      id: 'incident-github-lookup',
      description: 'Looked up Acme Corp repo or PRs on GitHub',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('acme') && (json.includes('github') || usedTool(r, 'GITHUB_LIST_PULL_REQUESTS'))
      },
    },
    {
      id: 'incident-tracker-built',
      description: 'Built an incident tracking UI',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('incident') || code.includes('error') || code.includes('status') || code.includes('urgent')
      },
    },
    {
      id: 'incident-action-plan',
      description: 'Response includes an action plan or team assignments',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return (text.includes('action') || text.includes('assign') || text.includes('fix') || text.includes('deploy'))
      },
    },
    // Turn 3: quarterly business review dashboard
    {
      id: 'qbr-dashboard-built',
      description: 'Built a QBR dashboard with multiple visualizations',
      points: 7,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && (anyCanvasCodeContains(r, 'revenue') || anyCanvasCodeContains(r, 'quarter')),
    },
    {
      id: 'qbr-charts',
      description: 'QBR dashboard uses Recharts or charting library',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart') || code.includes('linechart') || code.includes('barchart')
      },
    },
    {
      id: 'qbr-multiple-visualizations',
      description: 'Dashboard has at least 3 distinct data sections (revenue trend, deals, completion rate, top clients, productivity)',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const text = r.responseText.toLowerCase()
        const combined = code + ' ' + text
        const sections = ['revenue', 'deal', 'completion', 'client', 'productiv', 'trend']
        return sections.filter(s => combined.includes(s)).length >= 3
      },
    },
    {
      id: 'qbr-professional',
      description: 'Dashboard has professional layout (grid/cards/sections)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return (code.includes('grid') || code.includes('flex')) && code.includes('card')
      },
    },
    // Turn 4 (input): project audit
    {
      id: 'audit-delegation',
      description: 'Delegated project audit to sub-agents',
      points: 8,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'audit-read-data',
      description: 'Read the projects data file for analysis',
      points: 4,
      phase: 'intention',
      validate: (r) => usedTool(r, 'read_file') || usedTool(r, 'task'),
    },
    {
      id: 'audit-project-coverage',
      description: 'Audit covers multiple projects by name',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        const projects = ['acme', 'bloom', 'fitgear', 'luxe', 'retailmax', 'terrain']
        return projects.filter(p => text.includes(p)).length >= 3
      },
    },
    {
      id: 'audit-budget-analysis',
      description: 'Audit addresses budget status (over/under budget, % spent)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return text.includes('budget') && (text.includes('%') || text.includes('over') || text.includes('spent'))
      },
    },
    {
      id: 'audit-recommendations',
      description: 'Audit includes specific recommendations for at-risk projects',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return (text.includes('recommend') || text.includes('suggest') || text.includes('action') || text.includes('priority')) &&
               (text.includes('risk') || text.includes('behind') || text.includes('over budget') || text.includes('blocker'))
      },
    },
  ],
  tags: ['business-user'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const BUSINESS_USER_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
