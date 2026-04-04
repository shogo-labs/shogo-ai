// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Event Planner Mega Eval — "Stellar Events"
 *
 * Five multi-turn evals for Sofia, owner of a boutique event planning company,
 * progressively adopting Shogo for onboarding, canvas apps, day-of ops, sales
 * analytics, and multi-event logistics. Each phase seeds the workspace with the
 * assumed output of prior phases so phases can run independently in parallel.
 *
 * Phases:
 *   1. Onboarding — email, Google Calendar, heartbeat, event countdowns
 *   2. Event Management — events, vendors, guest list, budget breakdown UI
 *   3. Day-of Operations — run-of-show, payments, seating, dependency checklist
 *   4. Client & Sales — pipeline, proposals, surveys, delegated revenue analysis
 *   5. Multi-Event Ops — cross-event calendar, parallel vendor research, conflict planning
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import { EVENT_PLANNER_MOCKS } from './tool-mocks'
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
  return {
    'config.json': V2_CONFIG,
    'src/App.tsx': [
      'import React from "react"',
      'export default function App() {',
      '  return <div className="p-4"><h1 className="text-2xl font-bold">Stellar Events</h1></div>',
      '}',
    ].join('\n'),
  }
}

function phase3Workspace(): Record<string, string> {
  return { ...phase2Workspace() }
}

const EVENTS_CSV = [
  'event_id,name,type,date,venue,budget,actual_spent,headcount,revenue,status',
  'EVT-001,Morrison Wedding,wedding,2026-05-15,Grand Ballroom,45000,42000,180,55000,confirmed',
  'EVT-002,TechCorp Annual Gala,corporate,2026-05-16,Convention Center,80000,75000,500,95000,confirmed',
  'EVT-003,BrightPath Fundraiser,fundraiser,2026-06-20,City Park Pavilion,15000,8000,200,25000,planning',
  'EVT-004,Johnson Anniversary,wedding,2026-04-10,Garden Estate,25000,24500,80,30000,completed',
  'EVT-005,StartupWeek Mixer,corporate,2026-03-15,Innovation Hub,12000,11500,150,15000,completed',
  'EVT-006,Art Museum Benefit,fundraiser,2026-03-28,Art Museum,35000,33000,300,50000,completed',
  'EVT-007,Chen-Park Wedding,wedding,2026-07-20,Beachside Resort,55000,0,220,65000,planning',
  'EVT-008,CloudCo Product Launch,corporate,2026-08-05,Tech Campus,40000,0,400,48000,planning',
  'EVT-009,Holiday Charity Ball,fundraiser,2026-12-12,Historic Hotel,60000,0,350,80000,planning',
  'EVT-010,Rivera Wedding,wedding,2026-09-18,Vineyard Estate,38000,0,160,45000,planning',
].join('\n')

function phase4Workspace(): Record<string, string> {
  return {
    ...phase3Workspace(),
    'files/events.csv': EVENTS_CSV,
  }
}

const VENDORS_CSV = [
  'vendor_id,name,category,contact,email,phone,rating,price_range,events_worked',
  'VND-001,Savory Bites Catering,catering,Maria Santos,maria@savorybites.com,555-0101,4.8,premium,12',
  'VND-002,Fresh Feast,catering,Tom Williams,tom@freshfeast.com,555-0102,4.2,mid,8',
  'VND-003,Gourmet Guild,catering,Anna Lee,anna@gourmetguild.com,555-0103,4.5,premium,15',
  'VND-004,Plate Perfect,catering,James Cook,james@plateperfect.com,555-0104,3.9,budget,20',
  'VND-005,Bloom & Petal,floral,Sarah Flower,sarah@bloompetal.com,555-0201,4.7,premium,10',
  'VND-006,BrightLens Photo,photography,Mike Shot,mike@brightlens.com,555-0301,4.9,premium,18',
  'VND-007,SoundWave DJ,dj,DJ Rico,rico@soundwave.com,555-0401,4.3,mid,14',
  'VND-008,Grand Rentals,rentals,Pat Rental,pat@grandrentals.com,555-0501,4.0,budget,25',
  'VND-009,LightShow AV,av,Chris Light,chris@lightshow.com,555-0601,4.6,mid,11',
  'VND-010,Elegant Drape,decor,Nina Drape,nina@elegantdrape.com,555-0701,4.4,premium,9',
].join('\n')

function phase5Workspace(): Record<string, string> {
  return {
    ...phase4Workspace(),
    'files/vendors.csv': VENDORS_CSV,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (event-onboarding) — Level 2, 28 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'event-onboarding',
  name: 'Event Planner: Onboarding — email, calendar, heartbeat, countdowns',
  category: 'event-planner' as any,
  level: 2,
  pipeline: 'event-planner',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "I'm Sofia, I run a boutique event planning company called Stellar Events. We handle corporate events, " +
        'weddings, and fundraisers — usually 3-4 events at a time. I need help staying organized because things get chaotic fast.',
    },
    {
      role: 'user',
      content:
        'Connect my email — sofia@stellarevents.com, IMAP is imap.stellarevents.com, SMTP is smtp.stellarevents.com, password fakepass202',
    },
    {
      role: 'user',
      content:
        "Hook up my Google Calendar — I literally can't function without it. Every event, every vendor meeting, every tasting is on there.",
    },
  ],
  input:
    'Set up daily event countdowns. Every morning, tell me how many days until each of my upcoming events. ' +
    'I have the Morrison wedding on May 15, the TechCorp gala on May 16, and the BrightPath fundraiser on June 20.',
  workspaceFiles: phase1Workspace(),
  toolMocks: EVENT_PLANNER_MOCKS,
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
      description: 'Email config references Stellar Events IMAP host',
      points: 3,
      phase: 'execution',
      validate: (r) => toolCallsJson(r).includes('imap.stellarevents.com'),
    },
    {
      id: 'calendar-searched',
      description: 'Searched or invoked calendar-related tools',
      points: 4,
      phase: 'intention',
      validate: (r) => toolCallsJson(r).includes('calendar'),
    },
    {
      id: 'calendar-installed',
      description: 'Installed calendar integration (tool_install or mcp_install)',
      points: 4,
      phase: 'execution',
      validate: (r) => usedTool(r, 'tool_install') || usedTool(r, 'mcp_install'),
    },
    {
      id: 'heartbeat-configured',
      description: 'Configured heartbeat for daily countdowns',
      points: 6,
      phase: 'intention',
      validate: (r) => usedTool(r, 'heartbeat_configure'),
    },
    {
      id: 'events-mentioned',
      description: 'Response references named events and countdown/days/morning',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        (responseContains(r, 'morrison') || responseContains(r, 'techcorp') || responseContains(r, 'brightpath')) &&
        (responseContains(r, 'countdown') || responseContains(r, 'days') || responseContains(r, 'morning')),
    },
  ],
  tags: ['event-planner'],
}

// ---------------------------------------------------------------------------
// Phase 2: Event Management (event-management) — Level 3 (rubric 47 pts)
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'event-management',
  name: 'Event Planner: Event Management — events, vendors, guests, budgets',
  category: 'event-planner' as any,
  level: 3,
  pipeline: 'event-planner',
  pipelinePhase: 2,
  pipelineFiles: { 'config.json': V2_CONFIG },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build me an event tracker. Each event has: name, type (corporate, wedding, fundraiser), date, venue name, ' +
        'total budget, expected headcount, and status (planning, confirmed, in-progress, completed, cancelled).',
    },
    {
      role: 'user',
      content:
        'Now a vendor directory. For each vendor: company name, category (catering, floral, AV/lighting, photography, ' +
        'venue, DJ/music, rentals), contact person, phone, email, rating (1-5 stars), price range (budget/mid/premium), and notes.',
    },
    {
      role: 'user',
      content:
        'Build a guest list manager for the Morrison wedding. For each guest: name, email, RSVP status (pending, confirmed, declined), ' +
        'dietary restrictions (none, vegetarian, vegan, gluten-free, halal, kosher), table assignment, and whether they have a plus-one.',
    },
  ],
  input:
    'I need a budget breakdown for each event. Categories: venue, catering, decor/flowers, entertainment, photography, ' +
    'rentals, staffing, and miscellaneous. For each category show budgeted amount vs actual spent, and flag anything that\'s over budget. ' +
    'Show me total budget vs total spent with a big warning if we\'re over.',
  workspaceFiles: phase2Workspace(),
  toolMocks: EVENT_PLANNER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 47,
  validationCriteria: [
    {
      id: 'event-schema',
      description: 'Created Prisma Event model',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Event'),
    },
    {
      id: 'event-types',
      description: 'Canvas references corporate, wedding, or fundraiser',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('corporate') || code.includes('wedding') || code.includes('fundraiser')
      },
    },
    {
      id: 'event-status',
      description: 'Canvas references planning, confirmed, or in-progress',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('planning') || code.includes('confirmed') || code.includes('in-progress')
      },
    },
    {
      id: 'vendor-schema',
      description: 'Created Prisma Vendor model',
      points: 5,
      phase: 'execution',
      validate: (r) => wroteSchema(r) && schemaContainsModel(r, 'Vendor'),
    },
    {
      id: 'vendor-categories',
      description: 'Canvas references vendor categories',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('catering') || code.includes('floral') || code.includes('photography') ||
          code.includes('av') || code.includes('dj')
      },
    },
    {
      id: 'guest-list',
      description: 'Canvas references guests or RSVP',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'guest') || anyCanvasCodeContains(r, 'rsvp'),
    },
    {
      id: 'guest-dietary',
      description: 'Canvas references dietary or restriction types',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('dietary') || code.includes('vegetarian') || code.includes('vegan') || code.includes('gluten')
      },
    },
    {
      id: 'budget-breakdown',
      description: 'Canvas references budget breakdown',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'budget'),
    },
    {
      id: 'budget-categories',
      description: 'Canvas references budget line categories',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('venue') || code.includes('catering') || code.includes('decor') || code.includes('entertainment')
      },
    },
    {
      id: 'budget-variance',
      description: 'Canvas references variance, actual, or spent vs budget',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('over') || code.includes('variance') || code.includes('actual') || code.includes('spent')
      },
    },
    {
      id: 'budget-warning',
      description: 'Canvas includes warning or flag for over budget',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('warning') || code.includes('alert') || code.includes('flag') || code.includes('red') ||
          code.includes('over budget')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas code fetches skill server API',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['event-planner'],
}

// ---------------------------------------------------------------------------
// Phase 3: Day-of Operations (event-day-of) — Level 4 (rubric 49 pts)
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'event-day-of',
  name: 'Event Planner: Day-of — timeline, payments, seating, dependencies',
  category: 'event-planner' as any,
  level: 4,
  pipeline: 'event-planner',
  pipelinePhase: 3,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build a run-of-show timeline for events. Each entry has: time slot (like \'2:00 PM - 2:30 PM\'), activity name, ' +
        'responsible person, location within the venue, notes, and status (pending, in-progress, done). Order by time.',
    },
    {
      role: 'user',
      content:
        'I need a vendor payment tracker. For each payment: vendor name, which event it\'s for, total amount, amount paid, ' +
        'amount remaining, due date, payment status (pending, partial, paid, overdue), and payment method.',
    },
    {
      role: 'user',
      content:
        'Build a seating chart tool. Each table has a number, capacity (8 or 10), and assigned guests. Show how many seats are filled vs empty. ' +
        'Group guests with matching dietary restrictions together when possible.',
    },
  ],
  input:
    'Build a task checklist with dependencies. Some tasks can\'t start until others are done — like \'Set up AV\' can\'t happen until ' +
    '\'Venue access confirmed\', and \'Final headcount to caterer\' can\'t happen until \'RSVP deadline passed\'. Show which tasks are blocked ' +
    'and which are ready to go.',
  workspaceFiles: phase3Workspace(),
  toolMocks: EVENT_PLANNER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 49,
  validationCriteria: [
    {
      id: 'timeline-ui',
      description: 'Canvas references timeline, run of show, or schedule',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'timeline') || anyCanvasCodeContains(r, 'run of show') || anyCanvasCodeContains(r, 'schedule'),
    },
    {
      id: 'timeline-time',
      description: 'Canvas references time slots',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('time') || code.includes('slot') || code.includes('pm') || code.includes('am')
      },
    },
    {
      id: 'timeline-status',
      description: 'Canvas references timeline entry status',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('pending') || code.includes('in-progress') || code.includes('done') || code.includes('complete')
      },
    },
    {
      id: 'payment-tracker',
      description: 'Canvas references payments and amounts',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        (anyCanvasCodeContains(r, 'payment') || anyCanvasCodeContains(r, 'vendor')) &&
        (anyCanvasCodeContains(r, 'amount') || anyCanvasCodeContains(r, 'paid')),
    },
    {
      id: 'payment-overdue',
      description: 'Canvas references overdue, remaining, or due',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('overdue') || code.includes('remaining') || code.includes('due')
      },
    },
    {
      id: 'seating-chart',
      description: 'Canvas references seating or tables',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'seating') || anyCanvasCodeContains(r, 'table'),
    },
    {
      id: 'seating-capacity',
      description: 'Canvas references capacity or fill state',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('capacity') || code.includes('seats') || code.includes('filled') || code.includes('empty')
      },
    },
    {
      id: 'dependency-checklist',
      description: 'Canvas references dependencies or blocked tasks',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'dependency') || anyCanvasCodeContains(r, 'depends') ||
        anyCanvasCodeContains(r, 'blocked') || anyCanvasCodeContains(r, 'prerequisite'),
    },
    {
      id: 'dependency-logic',
      description: 'Canvas references blocked vs ready state',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('block') || code.includes('ready') || code.includes('enabled') || code.includes('disabled') ||
          code.includes('locked')
      },
    },
    {
      id: 'dependency-examples',
      description: 'Canvas references example dependency domains',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('venue') || code.includes('caterer') || code.includes('rsvp') || code.includes('headcount') ||
          code.includes('av')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas code fetches skill server API',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Event model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) => lastSchemaPreservesModel(r, 'Event'),
    },
  ],
  tags: ['event-planner'],
}

// ---------------------------------------------------------------------------
// Phase 4: Client & Sales (event-sales) — Level 4, 50 points
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'event-sales',
  name: 'Event Planner: Client & Sales — pipeline, proposals, surveys, revenue',
  category: 'event-planner' as any,
  level: 4,
  pipeline: 'event-planner',
  pipelinePhase: 4,
  pipelineFiles: { 'files/events.csv': EVENTS_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build a client inquiry pipeline. When someone contacts us about an event, I track them through: inquiry, consultation, ' +
        'proposal sent, contract negotiation, contract signed, event completed. Like a sales funnel.',
    },
    {
      role: 'user',
      content:
        'Build a proposal builder for events. I need to enter the event type, expected headcount, and select services. ' +
        'For each service category (venue, catering, decor, entertainment, photography, coordination fee), show an itemized cost with my markup (20%). ' +
        'Calculate subtotal, markup, and grand total.',
    },
    {
      role: 'user',
      content:
        'Build a post-event survey form. Questions: overall satisfaction (1-10), venue rating (1-5), food rating (1-5), entertainment rating (1-5), ' +
        'would they recommend us (yes/no), and an open text field for comments. Calculate an NPS score from the recommend question.',
    },
  ],
  input:
    'My event history is in the files folder. Analyze revenue per event type this year — weddings vs corporate vs fundraisers. ' +
    'Which is most profitable? Factor in the budget vs revenue margin. Delegate the analysis.',
  workspaceFiles: phase4Workspace(),
  toolMocks: EVENT_PLANNER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 50,
  validationCriteria: [
    {
      id: 'inquiry-pipeline',
      description: 'Canvas references pipeline, inquiry, or funnel',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'pipeline') || anyCanvasCodeContains(r, 'inquiry') || anyCanvasCodeContains(r, 'funnel'),
    },
    {
      id: 'inquiry-stages',
      description: 'Canvas references funnel stages',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('consultation') || code.includes('proposal') || code.includes('contract') || code.includes('signed')
      },
    },
    {
      id: 'proposal-builder',
      description: 'Canvas references proposals and pricing',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'proposal') &&
        (anyCanvasCodeContains(r, 'cost') || anyCanvasCodeContains(r, 'price')),
    },
    {
      id: 'proposal-markup',
      description: 'Canvas references markup or 20%',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('markup') || code.includes('20%') || code.includes('0.2') || code.includes('1.2')
      },
    },
    {
      id: 'proposal-total',
      description: 'Canvas references totals',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('total') || code.includes('subtotal') || code.includes('grand')
      },
    },
    {
      id: 'survey-form',
      description: 'Canvas references survey or feedback',
      points: 4,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'survey') || anyCanvasCodeContains(r, 'feedback'),
    },
    {
      id: 'survey-nps',
      description: 'Canvas references NPS or recommend scoring',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('nps') || code.includes('recommend') || code.includes('score')
      },
    },
    {
      id: 'survey-ratings',
      description: 'Canvas references ratings or scales',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('rating') || code.includes('satisfaction') || code.includes('1-5') || code.includes('1-10')
      },
    },
    {
      id: 'revenue-delegation',
      description: 'Delegated revenue analysis to a sub-agent',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'revenue-event-types',
      description: 'Response covers wedding, corporate, and fundraiser',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'wedding') && responseContains(r, 'corporate') && responseContains(r, 'fundraiser'),
    },
    {
      id: 'revenue-profitability',
      description: 'Response discusses profit or margin or most profitable',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'profit') || responseContains(r, 'margin') || responseContains(r, 'most profitable'),
    },
    {
      id: 'revenue-numbers',
      description: 'Response references dollar amounts or revenue or budget',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, '$') || responseContains(r, 'revenue') || responseContains(r, 'budget'),
    },
  ],
  tags: ['event-planner'],
}

// ---------------------------------------------------------------------------
// Phase 5: Multi-Event Ops (event-operations) — Level 5 (rubric 64 pts)
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'event-operations',
  name: 'Event Planner: Multi-Event Ops — calendar, vendors, dashboard, conflicts',
  category: 'event-planner' as any,
  level: 5,
  pipeline: 'event-planner',
  pipelinePhase: 5,
  pipelineFiles: { 'files/vendors.csv': VENDORS_CSV },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build a cross-event calendar view. Show all my events, their prep days (I usually need 2 days before each event), ' +
        'and vendor commitments on a single timeline or calendar view. I need to see overlaps.',
    },
    {
      role: 'user',
      content:
        'Compare these 4 caterers for the Morrison wedding: Savory Bites, Fresh Feast, Gourmet Guild, and Plate Perfect. ' +
        'Check their reviews, pricing for 180 guests, availability for May 15, and menu options. Do all four at the same time.',
    },
    {
      role: 'user',
      content:
        'Build a quarterly revenue dashboard. Show revenue by event type (wedding/corporate/fundraiser), profit margin per event, ' +
        'client retention rate (repeat clients), and month-by-month trend. Use charts.',
    },
  ],
  input:
    'I have 2 events on the same weekend — the Morrison wedding on Saturday May 15 and the TechCorp gala on Friday May 16. Help me figure out: ' +
    'which vendors are shared between both events, do I have enough staff for both (I have 8 people), what\'s the logistics plan for equipment that needs to move between venues, ' +
    'and flag any scheduling conflicts. This is complex — have your agents help figure it out.',
  workspaceFiles: phase5Workspace(),
  toolMocks: EVENT_PLANNER_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 64,
  validationCriteria: [
    {
      id: 'cross-calendar',
      description: 'Wrote canvas file with calendar or timeline',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'calendar') || anyCanvasCodeContains(r, 'timeline')),
    },
    {
      id: 'cross-events',
      description: 'Canvas references flagship events by name',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('morrison') || code.includes('techcorp') || code.includes('brightpath')
      },
    },
    {
      id: 'cross-prep-days',
      description: 'Canvas references prep or setup before events',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('prep') || code.includes('setup') || code.includes('day before')
      },
    },
    {
      id: 'vendor-comparison-parallel',
      description: 'Parallel sub-agents or web lookups for caterer comparison',
      points: 7,
      phase: 'intention',
      validate: (r) => countSubagentSpawns(r) >= 4 || toolCallCount(r, 'web') >= 4,
    },
    {
      id: 'vendor-all-four',
      description: 'Response names all four caterers',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'savory') &&
        responseContains(r, 'fresh feast') &&
        responseContains(r, 'gourmet') &&
        responseContains(r, 'plate perfect'),
    },
    {
      id: 'quarterly-dashboard',
      description: 'Canvas references revenue or quarterly view',
      points: 5,
      phase: 'execution',
      validate: (r) => anyCanvasCodeContains(r, 'revenue') || anyCanvasCodeContains(r, 'quarter'),
    },
    {
      id: 'quarterly-charts',
      description: 'Canvas uses Recharts or chart components',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'quarterly-margin',
      description: 'Canvas references margin or profit',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('margin') || code.includes('profit')
      },
    },
    {
      id: 'conflict-delegation',
      description: 'Delegated conflict analysis to sub-agents',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'conflict-vendors',
      description: 'Response discusses shared vendors or caterers across events',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        (responseContains(r, 'vendor') || responseContains(r, 'caterer')) &&
        (responseContains(r, 'shared') || responseContains(r, 'both')),
    },
    {
      id: 'conflict-staff',
      description: 'Response addresses staffing vs 8 people',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        (responseContains(r, 'staff') || responseContains(r, 'people') || responseContains(r, 'team')) &&
        (responseContains(r, '8') || responseContains(r, 'enough')),
    },
    {
      id: 'conflict-logistics',
      description: 'Response covers logistics, equipment, or transport',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'logistics') || responseContains(r, 'equipment') || responseContains(r, 'move') ||
        responseContains(r, 'transport'),
    },
    {
      id: 'conflict-schedule',
      description: 'Response mentions conflicts, overlap, or schedule',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'conflict') || responseContains(r, 'overlap') || responseContains(r, 'schedule') ||
        responseContains(r, 'timing'),
    },
    {
      id: 'conflict-plan',
      description: 'Response offers plan, recommendations, or suggestions',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'plan') || responseContains(r, 'recommend') || responseContains(r, 'suggest'),
    },
    {
      id: 'api-wiring',
      description: 'Canvas code fetches skill server API',
      points: 3,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['event-planner'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EVENT_PLANNER_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
