// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Freelancer Mega Eval — "Jake Designs"
 *
 * Five multi-turn evals for Jake, a freelance UX designer juggling 6–8 clients.
 * Each phase is ~four user turns and seeds its workspace with the assumed output
 * of prior phases so phases can run independently in parallel.
 *
 * Phases:
 *   1. Onboarding — email, Google Calendar, heartbeat, Friday invoice reminder
 *   2. Client & time tracking — CRM fields, time entries, effective rate, utilization dashboard
 *   3. Invoicing — generator, overdue AR, quarterly tax estimate, delegated annual summary
 *   4. Proposal pipeline — template, lead kanban, win-rate analysis, parallel rate research
 *   5. End-of-year — deductions, client profitability review, goals dashboard, parallel client audit
 */

import type { AgentEval, EvalResult } from './types'
import { FREELANCER_MOCKS } from './tool-mocks'
import {
  usedTool,
  toolCallArgsContain,
  toolCallCount,
  responseContains,
  toolCallsJson,
  lastSchemaPreservesModel,
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
    const path = String((t.input as any).path ?? '')
    return isCodeFile(path)
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
    return String((t.input as any).path ?? '').includes('schema.prisma')
  })
}

function schemaContainsModel(r: EvalResult, modelName: string): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .some(t => String((t.input as any).content ?? (t.input as any).new_string ?? '').includes(`model ${modelName}`))
}

/** True if schema defines `model Time {` (not only a substring of `model TimeEntry`). */
function schemaHasTimeEntryOrTimeModel(r: EvalResult): boolean {
  if (schemaContainsModel(r, 'TimeEntry')) return true
  const prismaBlocks = r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
  return /\bmodel\s+Time\s*\{/.test(prismaBlocks)
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

function responseMentionsClientCount(r: EvalResult): number {
  const text = r.responseText.toLowerCase()
  const names = ['acme', 'bloom', 'techstart', 'retailux', 'greenleaf', 'startupxyz', 'fitbrand']
  return names.filter(n => text.includes(n)).length
}

function rateResearchCitiesCovered(r: EvalResult): boolean {
  const text = r.responseText.toLowerCase()
  const hasSf = text.includes('san francisco') || /\bsf\b/.test(text)
  const hasNy = text.includes('new york') || /\bnyc\b/.test(text)
  const hasRemote = text.includes('remote')
  return hasSf && hasNy && hasRemote
}

// ---------------------------------------------------------------------------
// CSV seed data
// ---------------------------------------------------------------------------

const INVOICES_CSV = `invoice_id,client,amount,status,due_date,paid_date,hours,rate
INV-001,Acme Design Co,4800,paid,2026-01-15,2026-01-14,40,120
INV-002,Bloom Beauty,3600,paid,2026-01-20,2026-01-28,30,120
INV-003,TechStart Inc,7500,paid,2026-02-01,2026-02-10,50,150
INV-004,Acme Design Co,4800,paid,2026-02-15,2026-02-14,40,120
INV-005,Bloom Beauty,3600,paid,2026-02-20,2026-03-05,30,120
INV-006,RetailUX,5400,overdue,2026-02-28,,36,150
INV-007,TechStart Inc,7500,paid,2026-03-01,2026-03-02,50,150
INV-008,Acme Design Co,4800,paid,2026-03-15,2026-03-14,40,120
INV-009,Bloom Beauty,3600,paid,2026-03-01,2026-03-08,30,120
INV-010,GreenLeaf,2400,overdue,2026-03-10,,20,120
INV-011,RetailUX,5400,sent,2026-04-01,,36,150
INV-012,TechStart Inc,7500,sent,2026-04-01,,50,150
INV-013,Acme Design Co,6000,draft,2026-04-15,,40,150
INV-014,GreenLeaf,2400,sent,2026-04-05,,20,120
INV-015,Bloom Beauty,4500,draft,2026-04-10,,30,150
INV-016,StartupXYZ,3000,paid,2026-01-10,2026-01-12,25,120
INV-017,StartupXYZ,3000,paid,2026-02-10,2026-02-15,25,120
INV-018,StartupXYZ,3600,paid,2026-03-10,2026-03-20,30,120
INV-019,FitBrand,4500,paid,2026-01-25,2026-01-26,30,150
INV-020,FitBrand,4500,paid,2026-02-25,2026-02-28,30,150
INV-021,FitBrand,4500,paid,2026-03-25,2026-03-26,30,150
INV-022,RetailUX,5400,paid,2026-01-28,2026-02-15,36,150
INV-023,GreenLeaf,2400,paid,2026-02-05,2026-02-08,20,120
INV-024,GreenLeaf,2400,paid,2026-01-15,2026-01-16,20,120
INV-025,StartupXYZ,3600,sent,2026-04-10,,30,120`

const EXPENSES_CSV = `date,description,category,amount
2026-01-05,Figma subscription,software,15
2026-01-15,Adobe Creative Cloud,software,55
2026-02-01,Coworking space,office,250
2026-02-10,Client lunch - Acme,travel,45
2026-02-15,Figma subscription,software,15
2026-03-01,Coworking space,office,250
2026-03-05,Adobe Creative Cloud,software,55
2026-03-10,Conference ticket,travel,350
2026-03-15,Figma subscription,software,15
2026-03-20,New monitor,equipment,450
2026-04-01,Coworking space,office,250
2026-04-05,Figma subscription,software,15`

const PROPOSALS_CSV = `proposal_id,client,project,value,status,sent_date,decision_date
PROP-001,Acme Design Co,Website Redesign,12000,won,2025-11-01,2025-11-15
PROP-002,Bloom Beauty,Brand Refresh,8000,won,2025-11-10,2025-12-01
PROP-003,TechStart Inc,Mobile App UX,15000,won,2025-12-01,2025-12-10
PROP-004,RetailUX,Dashboard Design,10000,won,2026-01-05,2026-01-20
PROP-005,GreenLeaf,E-commerce UX,6000,won,2026-01-15,2026-02-01
PROP-006,NovaTech,SaaS Redesign,20000,lost,2025-11-20,2025-12-15
PROP-007,UrbanEats,App Design,9000,lost,2026-01-10,2026-02-10
PROP-008,CloudBase,Admin Panel,7000,lost,2026-02-01,2026-02-20
PROP-009,StartupXYZ,Landing Pages,5000,won,2026-02-15,2026-02-20
PROP-010,FitBrand,Fitness App,12000,won,2026-02-01,2026-02-10
PROP-011,DataViz Co,Analytics Dashboard,18000,pending,2026-03-15,
PROP-012,MedTech,Patient Portal,14000,pending,2026-03-20,
PROP-013,EduLearn,Course Platform,11000,pending,2026-04-01,`

const TIME_ENTRIES_CSV = `date,client,project,hours,billable,description
2026-01-06,Acme Design Co,Website Redesign,6,yes,Homepage wireframes
2026-01-07,Acme Design Co,Website Redesign,8,yes,User flow design
2026-01-08,Acme Design Co,Website Redesign,4,no,Revision round 3
2026-01-10,Bloom Beauty,Brand Refresh,5,yes,Logo concepts
2026-01-13,Bloom Beauty,Brand Refresh,3,no,Revision feedback
2026-01-14,TechStart Inc,Mobile App UX,8,yes,User research
2026-01-15,TechStart Inc,Mobile App UX,7,yes,Wireframes
2026-01-20,,Admin,3,no,Invoicing and bookkeeping
2026-01-22,RetailUX,Dashboard Design,6,yes,Dashboard wireframes
2026-01-23,RetailUX,Dashboard Design,4,yes,Component library
2026-01-27,GreenLeaf,E-commerce UX,5,yes,Product page design
2026-02-03,Acme Design Co,Website Redesign,7,yes,Design system
2026-02-04,Acme Design Co,Website Redesign,5,no,Revision round 4
2026-02-05,TechStart Inc,Mobile App UX,8,yes,Prototype
2026-02-10,,Admin,4,no,Proposals and outreach
2026-02-11,RetailUX,Dashboard Design,6,yes,Data visualization
2026-02-12,RetailUX,Dashboard Design,3,no,Revision round 2
2026-02-17,Bloom Beauty,Brand Refresh,4,yes,Brand guidelines
2026-02-18,StartupXYZ,Landing Pages,5,yes,Landing page design
2026-02-19,StartupXYZ,Landing Pages,3,yes,Responsive layouts
2026-02-24,FitBrand,Fitness App,7,yes,App wireframes
2026-02-25,FitBrand,Fitness App,6,yes,Interaction design
2026-02-26,FitBrand,Fitness App,2,no,Scope creep revisions
2026-03-03,Acme Design Co,Website Redesign,6,yes,Final designs
2026-03-04,TechStart Inc,Mobile App UX,7,yes,Usability testing
2026-03-05,TechStart Inc,Mobile App UX,3,no,Bug fix designs
2026-03-10,GreenLeaf,E-commerce UX,5,yes,Checkout flow
2026-03-11,GreenLeaf,E-commerce UX,4,no,Revision round 2
2026-03-12,,Admin,3,no,Tax prep
2026-03-17,RetailUX,Dashboard Design,5,yes,Final deliverables
2026-03-18,Bloom Beauty,Brand Refresh,3,yes,Social templates
2026-03-19,StartupXYZ,Landing Pages,4,yes,A/B test variants
2026-03-24,FitBrand,Fitness App,6,yes,User testing
2026-03-25,FitBrand,Fitness App,4,yes,Final screens
2026-03-26,,Admin,2,no,Portfolio update
2026-03-31,Acme Design Co,Website Redesign,4,no,Last-minute revisions
2026-04-01,TechStart Inc,Mobile App UX,6,yes,Handoff
2026-04-02,Bloom Beauty,Brand Refresh,3,yes,Asset export
2026-04-03,GreenLeaf,E-commerce UX,5,yes,Prototype testing`

// ---------------------------------------------------------------------------
// Workspace generators — each phase seeds prior-phase output
// ---------------------------------------------------------------------------

function phase1Workspace(): Record<string, string> {
  return {}
}

function phase2Workspace(): Record<string, string> {
  return {
    'config.json': V2_CONFIG,
    'src/App.tsx': [
      'import React from "react"',
      'export default function App() {',
      '  return <div className="p-4"><h1 className="text-2xl font-bold">Jake Designs</h1></div>',
      '}',
    ].join('\n'),
  }
}

function phase3Workspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    'files/invoices.csv': INVOICES_CSV,
    'files/expenses.csv': EXPENSES_CSV,
  }
}

function phase4Workspace(): Record<string, string> {
  return {
    ...phase3Workspace(),
    'files/proposals.csv': PROPOSALS_CSV,
  }
}

function phase5Workspace(): Record<string, string> {
  return {
    ...phase4Workspace(),
    'files/time-entries.csv': TIME_ENTRIES_CSV,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (free-onboarding) — Level 2, 28 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'free-onboarding',
  name: 'Freelancer: Onboarding — email, calendar, heartbeat',
  category: 'freelancer' as any,
  level: 2,
  pipeline: 'freelancer',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "Hey, I'm Jake. I'm a freelance UX designer — I juggle about 8 clients right now and I'm drowning in admin work. " +
        "Invoicing, time tracking, proposals... it's killing me. Can you help?",
    },
    {
      role: 'user',
      content:
        "Let's start by connecting my email. jake@jakedesigns.com, IMAP is imap.jakedesigns.com, " +
        'SMTP is smtp.jakedesigns.com, password is fakepass456',
    },
    {
      role: 'user',
      content:
        "Also hook up my Google Calendar — I live and die by my calendar for client meetings",
    },
  ],
  input:
    "One more thing — remind me every Friday at 3pm to send out invoices. I always forget and then I'm chasing money.",
  workspaceFiles: phase1Workspace(),
  toolMocks: FREELANCER_MOCKS,
  maxScore: 28,
  validationCriteria: [
    {
      id: 'email-connected',
      description: 'Connected email channel',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        usedTool(r, 'channel_connect') &&
        toolCallArgsContain(r, 'channel_connect', 'email'),
    },
    {
      id: 'email-details',
      description: 'Email config includes IMAP and SMTP hosts',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('imap.jakedesigns.com') && json.includes('smtp.jakedesigns.com')
      },
    },
    {
      id: 'calendar-searched',
      description: 'Searched or referenced calendar integration',
      points: 4,
      phase: 'intention',
      validate: (r) => toolCallsJson(r).includes('calendar'),
    },
    {
      id: 'calendar-installed',
      description: 'Installed calendar-related tool or MCP',
      points: 4,
      phase: 'execution',
      validate: (r) => usedTool(r, 'tool_install') || usedTool(r, 'mcp_install'),
    },
    {
      id: 'heartbeat-configured',
      description: 'Configured heartbeat or recurring reminder',
      points: 6,
      phase: 'intention',
      validate: (r) => usedTool(r, 'heartbeat_configure'),
    },
    {
      id: 'friday-schedule',
      description: 'Friday 3pm invoice reminder captured in tool args or config',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('friday') || json.includes('15:00') || json.includes('3pm') || json.includes('3:00')
      },
    },
  ],
  tags: ['freelancer'],
}

// ---------------------------------------------------------------------------
// Phase 2: Client & Time Tracking (free-tracking) — Level 3, 48 points
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'free-tracking',
  name: 'Freelancer: Clients, time tracking, utilization dashboard',
  category: 'freelancer' as any,
  level: 3,
  pipeline: 'freelancer',
  pipelinePhase: 2,
  pipelineFiles: { 'config.json': V2_CONFIG },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need to track my clients properly. For each client: their name, company, email, phone, ' +
        "my hourly rate for them, whether they're on retainer, and when we started working together.",
    },
    {
      role: 'user',
      content:
        'Now I need time tracking. For each entry: which project, which client, hours worked, date, ' +
        "and what I did. I want to be able to see a running timer too.",
    },
    {
      role: 'user',
      content:
        "Here's what I really want to know — what's my effective hourly rate for each client? " +
        'Factor in all those unpaid revision hours. Some clients eat up way more time than they pay for.',
    },
  ],
  input:
    "Build me a utilization dashboard. Show my billable vs non-billable hours, my utilization percentage, " +
    "and how it trends week by week. I want to see if I'm leaving money on the table.",
  workspaceFiles: phase2Workspace(),
  toolMocks: FREELANCER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 48,
  validationCriteria: [
    {
      id: 'client-schema',
      description: 'Created Prisma schema with Client model',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Client'),
    },
    {
      id: 'client-ui',
      description: 'Built client-related UI in canvas',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && anyCanvasCodeContains(r, 'client'),
    },
    {
      id: 'time-entry-schema',
      description: 'Created TimeEntry or Time model in Prisma',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaHasTimeEntryOrTimeModel(r),
    },
    {
      id: 'time-tracking-ui',
      description: 'Time tracking UI mentions timer, hours, or time',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('timer') || code.includes('hour') || code.includes('time')
      },
    },
    {
      id: 'rate-calculation',
      description: 'Effective or hourly rate logic in canvas code',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('rate') || code.includes('hourly')
      },
    },
    {
      id: 'utilization-dashboard',
      description: 'Utilization or billable dashboard in canvas',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'utilization') || anyCanvasCodeContains(r, 'billable')),
    },
    {
      id: 'utilization-chart',
      description: 'Chart library or chart component for utilization',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart') || code.includes('barchart')
      },
    },
    {
      id: 'utilization-percentage',
      description: 'Shows utilization as percent or with %',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('%') || code.includes('percent') || code.includes('utilization')
      },
    },
    {
      id: 'weekly-trend',
      description: 'Week-over-week or trend language in code',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('week') || code.includes('trend')
      },
    },
    {
      id: 'api-fetches',
      description: 'Canvas fetches local API or skill server',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['freelancer'],
}

// ---------------------------------------------------------------------------
// Phase 3: Invoicing (free-invoicing) — Level 4, 58 points
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'free-invoicing',
  name: 'Freelancer: Invoicing, AR, taxes, annual summary',
  category: 'freelancer' as any,
  level: 4,
  pipeline: 'freelancer',
  pipelinePhase: 3,
  pipelineFiles: { 'files/invoices.csv': INVOICES_CSV, 'files/expenses.csv': EXPENSES_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need an invoice generator. Pull from my time logs — each invoice should have line items with hours, ' +
        'rate, and totals. Include tax at 8.5%. Make it look professional enough to send to clients.',
    },
    {
      role: 'user',
      content:
        "Which clients owe me money right now? I put my invoice data in the files folder. Show me anything overdue.",
    },
    {
      role: 'user',
      content:
        'Tax time is coming. I need a quarterly tax estimate — show my income vs expenses, and estimate what I\'ll ' +
        'owe. My expenses are in the files folder too. Assume 25% effective tax rate for self-employment.',
    },
  ],
  input:
    "I need an annual income summary. There's a lot of data to crunch across invoices and expenses. " +
    'Can you have your agent analyze it all and give me the big picture — total revenue, total expenses, ' +
    'net income, and trends by month?',
  workspaceFiles: phase3Workspace(),
  toolMocks: FREELANCER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 58,
  validationCriteria: [
    {
      id: 'invoice-generator',
      description: 'Built invoice-related canvas UI',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && anyCanvasCodeContains(r, 'invoice'),
    },
    {
      id: 'invoice-line-items',
      description: 'Line items, hours, or itemization in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('line') || code.includes('item') || code.includes('hours')
      },
    },
    {
      id: 'invoice-tax',
      description: 'Tax or 8.5% handling in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('tax') || code.includes('8.5') || code.includes('0.085')
      },
    },
    {
      id: 'overdue-identified',
      description: 'Response mentions overdue balances or money owed',
      points: 5,
      phase: 'execution',
      validate: (r) => responseContains(r, 'overdue') || responseContains(r, 'owe'),
    },
    {
      id: 'overdue-clients',
      description: 'Names overdue clients from seed data',
      points: 4,
      phase: 'execution',
      validate: (r) => responseContains(r, 'retailux') || responseContains(r, 'greenleaf'),
    },
    {
      id: 'tax-estimate-built',
      description: 'Tax estimate UI in canvas',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r) && anyCanvasCodeContains(r, 'tax'),
    },
    {
      id: 'tax-calculation',
      description: 'Self-employment or 25% rate in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('25') || code.includes('self-employment') || code.includes('estimated')
      },
    },
    {
      id: 'expense-categories',
      description: 'Expense category labels in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('software') || code.includes('office') || code.includes('travel') || code.includes('equipment')
      },
    },
    {
      id: 'annual-delegation',
      description: 'Delegated annual analysis to sub-agent',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'annual-summary',
      description: 'Response covers revenue and expenses or net',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        return text.includes('revenue') && (text.includes('expense') || text.includes('income') || text.includes('net'))
      },
    },
    {
      id: 'annual-numbers',
      description: 'Response includes monetary or total figures',
      points: 4,
      phase: 'execution',
      validate: (r) => responseContains(r, '$') || responseContains(r, 'total'),
    },
    {
      id: 'annual-trend',
      description: 'Response mentions months, trends, or quarters',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'month') || responseContains(r, 'trend') || responseContains(r, 'quarter'),
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Client model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) => lastSchemaPreservesModel(r, 'Client'),
    },
  ],
  tags: ['freelancer'],
}

// ---------------------------------------------------------------------------
// Phase 4: Proposal Pipeline (free-proposals) — Level 4, 50 points
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'free-proposals',
  name: 'Freelancer: Proposals, pipeline, win rate, rate research',
  category: 'freelancer' as any,
  level: 4,
  pipeline: 'freelancer',
  pipelinePhase: 4,
  pipelineFiles: { 'files/proposals.csv': PROPOSALS_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'I need a proposal template builder. Each proposal should have a project scope section, timeline with milestones, ' +
        'deliverables list, and pricing breakdown. Make it something I can fill in for each new client.',
    },
    {
      role: 'user',
      content:
        'Build me a lead tracker too. I want to see all my potential clients in a pipeline — stages are: inquiry, ' +
        'call scheduled, proposal sent, negotiating, won, lost. Like a kanban board.',
    },
    {
      role: 'user',
      content:
        "I have my proposal history in the files folder. Can you analyze my win rate? Tell me what's working — " +
        "which project types win more, what price points convert. Delegate the analysis if it's easier.",
    },
  ],
  input:
    'One more thing — research what other freelance UX designers charge in San Francisco, New York, and for remote work. ' +
    "Do all three at the same time so it's quick.",
  workspaceFiles: phase4Workspace(),
  toolMocks: FREELANCER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 50,
  validationCriteria: [
    {
      id: 'proposal-template',
      description: 'Proposal or scope template in canvas',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'proposal') || anyCanvasCodeContains(r, 'scope')),
    },
    {
      id: 'proposal-sections',
      description: 'Timeline, deliverables, or pricing in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('timeline') || code.includes('deliverable') || code.includes('pricing')
      },
    },
    {
      id: 'lead-pipeline',
      description: 'Pipeline, kanban, or lead UI',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('pipeline') || code.includes('kanban') || code.includes('lead')
      },
    },
    {
      id: 'lead-stages',
      description: 'Pipeline stages in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('inquiry') || code.includes('negotiat') || code.includes('won')
      },
    },
    {
      id: 'win-rate-delegation',
      description: 'Delegated win-rate analysis',
      points: 6,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'win-rate-analysis',
      description: 'Response discusses win rate',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('win') && (t.includes('rate') || t.includes('percent') || t.includes('%'))
      },
    },
    {
      id: 'rate-research-parallel',
      description: 'Parallel sub-agents or web searches for rate research',
      points: 7,
      phase: 'intention',
      validate: (r) =>
        countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 3,
    },
    {
      id: 'rate-research-cities',
      description: 'Response covers SF, NYC, and remote',
      points: 5,
      phase: 'execution',
      validate: (r) => rateResearchCitiesCovered(r),
    },
    {
      id: 'rate-research-numbers',
      description: 'Response cites rates or hourly wording',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const t = r.responseText.toLowerCase()
        return t.includes('$') || t.includes('per hour') || t.includes('/hr') || t.includes('hourly')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas uses fetch to API',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['freelancer'],
}

// ---------------------------------------------------------------------------
// Phase 5: End-of-Year (free-year-end) — Level 5, 70 points
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'free-year-end',
  name: 'Freelancer: Taxes, client review, goals, client audit',
  category: 'freelancer' as any,
  level: 5,
  pipeline: 'freelancer',
  pipelinePhase: 5,
  pipelineFiles: { 'files/time-entries.csv': TIME_ENTRIES_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Tax time. Build me a deduction organizer — categorize my expenses: home office, software subscriptions, ' +
        'travel, equipment, meals. Show totals per category.',
    },
    {
      role: 'user',
      content:
        "I want to review all my clients this year. Who's actually profitable when you factor in unbilled revision time? " +
        "Who pays on time? I put all the time entries in the files folder. Have your agents dig into it.",
    },
    {
      role: 'user',
      content:
        'Build me a goals dashboard for next year. I want to hit $200K revenue, maintain 75% utilization, keep my average ' +
        'rate above $140/hr, and max out at 6 active clients. Show progress bars for each.',
    },
  ],
  input:
    'Should I drop any of my clients? Do a full audit — check profitability, payment timeliness, revision frequency, ' +
    'and overall hassle factor for each client. Have your agents analyze each one in parallel and give me a recommendation.',
  workspaceFiles: phase5Workspace(),
  toolMocks: FREELANCER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 70,
  validationCriteria: [
    {
      id: 'tax-deductions',
      description: 'Deduction or expense category organizer UI',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'deduction') ||
          anyCanvasCodeContains(r, 'expense') ||
          anyCanvasCodeContains(r, 'category')),
    },
    {
      id: 'tax-categories',
      description: 'Category labels in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('software') || code.includes('office') || code.includes('travel')
      },
    },
    {
      id: 'client-review-delegation',
      description: 'Spawned agents for client profitability review',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'client-review-profitability',
      description: 'Response discusses profitability or effective rate',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'profit') ||
        responseContains(r, 'margin') ||
        responseContains(r, 'effective rate'),
    },
    {
      id: 'client-review-payment',
      description: 'Response discusses payment behavior',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'payment') ||
        responseContains(r, 'late') ||
        responseContains(r, 'overdue') ||
        responseContains(r, 'on time'),
    },
    {
      id: 'goals-dashboard',
      description: 'Goals or targets dashboard',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'goal') || anyCanvasCodeContains(r, 'target')),
    },
    {
      id: 'goals-progress',
      description: 'Progress bars or percent UI',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('progress') || code.includes('bar') || code.includes('%')
      },
    },
    {
      id: 'goals-metrics',
      description: 'Revenue, utilization, or 200K targets in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('200') || code.includes('revenue') || code.includes('utilization')
      },
    },
    {
      id: 'audit-parallel-delegation',
      description: 'Parallel sub-agents or per-client phrasing',
      points: 8,
      phase: 'intention',
      validate: (r) =>
        countSubagentSpawns(r) >= 3 ||
        (subagentWasSpawned(r) &&
          (responseContains(r, 'each client') || responseContains(r, 'per client'))),
    },
    {
      id: 'audit-client-coverage',
      description: 'Response names at least three tracked clients',
      points: 6,
      phase: 'execution',
      validate: (r) => responseMentionsClientCount(r) >= 3,
    },
    {
      id: 'audit-profitability',
      description: 'Audit mentions profitability or revenue',
      points: 5,
      phase: 'execution',
      validate: (r) => responseContains(r, 'profitable') || responseContains(r, 'profit') || responseContains(r, 'revenue'),
    },
    {
      id: 'audit-revisions',
      description: 'Audit mentions revisions or unbilled time',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'revision') || responseContains(r, 'unbilled') || responseContains(r, 'non-billable'),
    },
    {
      id: 'audit-recommendation',
      description: 'Clear keep/drop or recommendation language',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'recommend') ||
        responseContains(r, 'suggest') ||
        responseContains(r, 'drop') ||
        responseContains(r, 'keep') ||
        responseContains(r, 'consider'),
    },
    {
      id: 'audit-hassle',
      description: 'Discusses hassle or difficulty',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'hassle') ||
        responseContains(r, 'difficult') ||
        responseContains(r, 'time-consuming') ||
        responseContains(r, 'maintenance'),
    },
  ],
  tags: ['freelancer'],
}

export const FREELANCER_EVALS: AgentEval[] = [PHASE_1, PHASE_2, PHASE_3, PHASE_4, PHASE_5]
