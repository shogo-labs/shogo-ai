// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Startup CTO Mega Eval — "Launchpad" (Priya)
 *
 * Five multi-turn evals for a Series A CTO (20 people, 12 engineers) progressively
 * adopting Shogo for eng management, hiring, technical operations, and strategy.
 * Each phase seeds its workspace with the assumed output of prior phases so phases
 * can run independently in parallel.
 *
 * Phases:
 *   1. Onboarding — Slack, GitHub, morning digest heartbeat
 *   2. Eng Management — sprint board, capacity, on-call, tech debt
 *   3. Hiring Pipeline — applicants, scorecards, offers, headcount runway
 *   4. Technical Operations — postmortems, deploy dashboard, SLA, ADRs
 *   5. Strategic — velocity analysis, feature-flag research, QER, roadmap
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import { STARTUP_CTO_MOCKS } from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  toolCallArgsContain,
  toolCallCount,
  responseContains,
  toolCallsJson,
  lastSchemaPreservesModel,
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
      '  return <div className="p-4"><h1 className="text-2xl font-bold">Launchpad</h1></div>',
      '}',
    ].join('\n'),
  }
}

const PRISMA_SCHEMA_PHASE2 = buildSkillServerSchema(`model Ticket {
  id           String   @id @default(cuid())
  title        String
  assignee     String
  status       String
  storyPoints  Int
  sprintNumber Int
  createdAt    DateTime @default(now())
}

model EngineerCapacity {
  id         String   @id @default(cuid())
  name       String
  projects   String
  allocation Int
  createdAt  DateTime @default(now())
}

model OnCallSlot {
  id        String   @id @default(cuid())
  team      String
  weekStart DateTime
  engineer  String
  createdAt DateTime @default(now())
}

model TechDebt {
  id          String   @id @default(cuid())
  description String
  severity    String
  effortDays  Float
  owningTeam  String
  filedAt     DateTime
  createdAt   DateTime @default(now())
}`)

function phase3Workspace(): Record<string, string> {
  return {
    ...phase2Workspace(),
    '.shogo/server/schema.prisma': PRISMA_SCHEMA_PHASE2,
  }
}

/** Phase 4 seeds the same files as phase 3 (assumed prior-phase output). */
function phase4Workspace(): Record<string, string> {
  return { ...phase3Workspace() }
}

const SPRINTS_JSON = JSON.stringify([
  { sprint: 1, name: 'Sprint 1', startDate: '2026-01-06', endDate: '2026-01-17', planned: 42, completed: 38, carryover: 4, blockers: 2 },
  { sprint: 2, name: 'Sprint 2', startDate: '2026-01-20', endDate: '2026-01-31', planned: 45, completed: 40, carryover: 5, blockers: 3 },
  { sprint: 3, name: 'Sprint 3', startDate: '2026-02-03', endDate: '2026-02-14', planned: 40, completed: 39, carryover: 1, blockers: 1 },
  { sprint: 4, name: 'Sprint 4', startDate: '2026-02-17', endDate: '2026-02-28', planned: 48, completed: 35, carryover: 13, blockers: 5 },
  { sprint: 5, name: 'Sprint 5', startDate: '2026-03-03', endDate: '2026-03-14', planned: 38, completed: 36, carryover: 2, blockers: 1 },
  { sprint: 6, name: 'Sprint 6', startDate: '2026-03-17', endDate: '2026-03-28', planned: 44, completed: 41, carryover: 3, blockers: 2 },
], null, 2)

function phase5Workspace(): Record<string, string> {
  return {
    ...phase4Workspace(),
    'files/sprints.json': SPRINTS_JSON,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Onboarding (cto-onboarding) — Level 2, 30 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'cto-onboarding',
  name: 'Startup CTO: Onboarding — Slack, GitHub, digest heartbeat',
  category: 'startup-cto' as any,
  level: 2,
  pipeline: 'startup-cto',
  pipelinePhase: 1,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        "I'm Priya, CTO at Launchpad — we're a Series A startup, 20 people total, 12 engineers. " +
        "I'm technical but I'm drowning in management overhead. Standups, sprint planning, hiring, incidents... " +
        'I barely code anymore. Help me get organized.',
    },
    {
      role: 'user',
      content:
        'Connect our Slack — bot token: xoxb-fake-launchpad-token and app token: xapp-fake-launchpad-app',
    },
    {
      role: 'user',
      content:
        "Also connect our GitHub org. Here's a PAT: ghp_fakeLaunchpadToken123",
    },
  ],
  input:
    "Every morning at 9:30am, give me a digest: yesterday's merged PRs, any open incidents, and who's on PTO today.",
  workspaceFiles: phase1Workspace(),
  toolMocks: STARTUP_CTO_MOCKS,
  maxScore: 30,
  validationCriteria: [
    {
      id: 'slack-connected',
      description: 'Connected Slack via channel_connect',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'channel_connect') &&
        toolCallArgsContain(r, 'channel_connect', 'slack'),
    },
    {
      id: 'slack-tokens',
      description: 'Slack tool args include Launchpad bot token substring',
      points: 4,
      phase: 'execution',
      validate: (r) => toolCallsJson(r).includes('xoxb-fake-launchpad'),
    },
    {
      id: 'github-connected',
      description: 'GitHub mentioned in tool call payload (intention)',
      points: 5,
      phase: 'intention',
      validate: (r) => toolCallsJson(r).includes('github'),
    },
    {
      id: 'github-cli',
      description: 'Used gh CLI via exec to interact with GitHub',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        usedToolAnywhere(r, 'tool_install') || usedToolAnywhere(r, 'mcp_install') ||
        toolCallArgsContain(r, 'exec', 'gh '),
    },
    {
      id: 'digest-plan',
      description: 'Response describes digest/heartbeat/schedule plan',
      points: 6,
      phase: 'intention',
      validate: (r) =>
        responseContains(r, 'digest') || responseContains(r, 'heartbeat') ||
        responseContains(r, 'schedule') || usedToolAnywhere(r, 'heartbeat_configure'),
    },
    {
      id: 'clarifies-channel-or-timezone',
      description: 'Asks about Slack channel or timezone, or configures schedule with 9:30',
      points: 4,
      phase: 'intention',
      validate: (r) => {
        const text = r.responseText.toLowerCase()
        const asksChannel = text.includes('channel') || text.includes('timezone') || text.includes('time zone')
        const json = toolCallsJson(r)
        const configures930 = json.includes('9:30') || json.includes('09:30')
        return asksChannel || configures930
      },
    },
  ],
  tags: ['startup-cto'],
}

// ---------------------------------------------------------------------------
// Phase 2: Eng Management (cto-eng-management) — Level 3, 50 points
// ---------------------------------------------------------------------------

const PHASE_2: AgentEval = {
  id: 'cto-eng-management',
  name: 'Startup CTO: Eng Management — sprint, capacity, on-call, tech debt',
  category: 'startup-cto' as any,
  level: 3,
  pipeline: 'startup-cto',
  pipelinePhase: 2,
  pipelineFiles: { 'config.json': V2_CONFIG },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build me a sprint board. Each ticket has a title, assignee, status (backlog, todo, in-progress, in-review, done), ' +
        'story points, and sprint number. Show column totals for story points.',
    },
    {
      role: 'user',
      content:
        'I need a team capacity planner. Show each of my 12 engineers, what projects they\'re allocated to, ' +
        'and their percentage allocation. I want to see who\'s overloaded and who has room.',
    },
    {
      role: 'user',
      content:
        'Build an on-call rotation scheduler. We have 4 teams: Platform, API, Frontend, and Infra. Weekly rotation, and let people swap shifts.',
    },
  ],
  input:
    'Last thing — a tech debt tracker. Each item has a description, severity (critical, high, medium, low), ' +
    'estimated effort in days, which team owns it, and when it was filed. Sort by severity, and show me how old the oldest items are.',
  workspaceFiles: phase2Workspace(),
  toolMocks: STARTUP_CTO_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 50,
  validationCriteria: [
    {
      id: 'sprint-schema',
      description: 'Prisma schema includes Ticket, Sprint, or Task model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Ticket') || schemaContainsModel(r, 'Sprint') || schemaContainsModel(r, 'Task')),
    },
    {
      id: 'sprint-kanban',
      description: 'Canvas code references sprint column statuses',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return ['backlog', 'todo', 'in-progress', 'in-review'].some(s => code.includes(s))
      },
    },
    {
      id: 'sprint-points',
      description: 'Canvas code references story points',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('point') || code.includes('story')
      },
    },
    {
      id: 'capacity-ui',
      description: 'Capacity or allocation surfaced in UI code',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'capacity') || anyCanvasCodeContains(r, 'allocation'),
    },
    {
      id: 'capacity-engineers',
      description: 'Engineer load / percent / overload in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('%') || code.includes('percent') || code.includes('overload')
      },
    },
    {
      id: 'oncall-rotation',
      description: 'On-call or rotation in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'on-call') ||
        anyCanvasCodeContains(r, 'oncall') ||
        anyCanvasCodeContains(r, 'rotation'),
    },
    {
      id: 'oncall-teams',
      description: 'Team names (platform, api, frontend, infra) in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('platform') || code.includes('api') || code.includes('frontend') || code.includes('infra')
      },
    },
    {
      id: 'techdebt-schema',
      description: 'TechDebt or Debt model in Prisma schema',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'TechDebt') || schemaContainsModel(r, 'Debt')),
    },
    {
      id: 'techdebt-severity',
      description: 'Severity levels in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('critical') || code.includes('severity')
      },
    },
    {
      id: 'techdebt-sort',
      description: 'Sorting / ordering for tech debt',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('sort') || code.includes('priority') || code.includes('order')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas uses fetch to local /api',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'ran-prisma',
      description: 'Ran prisma or shogo generate / db push',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const json = toolCallsJson(r)
        return json.includes('prisma') || json.includes('shogo generate') || json.includes('db push')
      },
    },
  ],
  tags: ['startup-cto'],
}

// ---------------------------------------------------------------------------
// Phase 3: Hiring Pipeline (cto-hiring) — Level 3, 48 points
// ---------------------------------------------------------------------------

const PHASE_3: AgentEval = {
  id: 'cto-hiring',
  name: 'Startup CTO: Hiring — applicants, scorecards, offers, headcount',
  category: 'startup-cto' as any,
  level: 3,
  pipeline: 'startup-cto',
  pipelinePhase: 3,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        'We\'re hiring. Build an applicant tracker — candidate name, role they applied for, ' +
        'stage (applied, phone screen, technical, onsite, offer, hired, rejected), ' +
        'source (referral, LinkedIn, careers page), and notes.',
    },
    {
      role: 'user',
      content:
        'I need interview scorecards. For each candidate interview: rate them on technical skills, system design, ' +
        'communication, and culture fit, each 1-5. Calculate a weighted average — technical should be 40%, system design 30%, communication 15%, culture 15%.',
    },
    {
      role: 'user',
      content:
        'Build an offer letter generator. Input: role, base salary, equity (shares and strike price), start date, sign-on bonus, and PTO days. Output a formatted offer.',
    },
  ],
  input:
    'One more — headcount planning. Show our current team by role (frontend, backend, infra, mobile, PM, design), open positions, ' +
    'monthly burn rate per head ($15K average), and how many months of runway we have left with $4M in the bank. ' +
    'Show what happens to runway as we fill each open position.',
  workspaceFiles: phase3Workspace(),
  toolMocks: STARTUP_CTO_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 48,
  validationCriteria: [
    {
      id: 'applicant-schema',
      description: 'Candidate or Applicant model in schema',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Candidate') || schemaContainsModel(r, 'Applicant')),
    },
    {
      id: 'applicant-stages',
      description: 'Hiring stages in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('phone screen') || code.includes('technical') || code.includes('onsite') || code.includes('applied')
      },
    },
    {
      id: 'scorecard-ui',
      description: 'Scorecard / interview / rating UI',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'scorecard') ||
        anyCanvasCodeContains(r, 'interview') ||
        anyCanvasCodeContains(r, 'rating'),
    },
    {
      id: 'scorecard-weights',
      description: 'Weighted scoring in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('weight') || code.includes('40') || code.includes('0.4')
      },
    },
    {
      id: 'offer-generator',
      description: 'Offer or salary in UI code',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'offer') || anyCanvasCodeContains(r, 'salary'),
    },
    {
      id: 'offer-fields',
      description: 'Equity / compensation fields in canvas code',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('equity') || code.includes('shares') || code.includes('sign-on') || code.includes('pto')
      },
    },
    {
      id: 'headcount-dashboard',
      description: 'Headcount or runway dashboard',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'headcount') || anyCanvasCodeContains(r, 'runway'),
    },
    {
      id: 'headcount-roles',
      description: 'Engineering / role breakdown in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('frontend') || code.includes('backend') || code.includes('infra')
      },
    },
    {
      id: 'headcount-runway',
      description: 'Runway or burn or $4M context',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('runway') || code.includes('4m') || code.includes('4,000,000') ||
          code.includes('4000000') || code.includes('burn')
      },
    },
    {
      id: 'headcount-projection',
      description: 'Projection / forecast / hiring fill scenario',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('projection') || code.includes('forecast') || code.includes('scenario') || code.includes('fill')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas uses fetch to local /api',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Ticket model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        lastSchemaPreservesModel(r, 'Ticket') || lastSchemaPreservesModel(r, 'Sprint'),
    },
  ],
  tags: ['startup-cto'],
}

// ---------------------------------------------------------------------------
// Phase 4: Technical Operations (cto-tech-ops) — Level 4, 54 points (criteria sum)
// ---------------------------------------------------------------------------

const PHASE_4: AgentEval = {
  id: 'cto-tech-ops',
  name: 'Startup CTO: Tech Ops — postmortems, deploy, SLA, ADRs',
  category: 'startup-cto' as any,
  level: 4,
  pipeline: 'startup-cto',
  pipelinePhase: 4,
  pipelineFiles: {},
  conversationHistory: [
    {
      role: 'user',
      content:
        'Build a postmortem template app. For each incident: title, severity (SEV1-SEV4), date, timeline of events, ' +
        'root cause, impact (users affected, duration), action items with owners and due dates.',
    },
    {
      role: 'user',
      content:
        'I want a deployment dashboard. Pull from our GitHub data — show deploy frequency per week, which branches ship most, ' +
        'success vs rollback rate. Use charts.',
    },
    {
      role: 'user',
      content:
        'Build an SLA compliance tracker. We promise 99.9% uptime for our API and 99.5% for the dashboard. ' +
        'Track actual uptime by month, number of incidents, total downtime minutes, and flag any month we missed our target.',
    },
  ],
  input:
    'One more — an Architecture Decision Record (ADR) system. Each ADR has a number, title, status (proposed, accepted, superseded, deprecated), ' +
    'date, context (why we need to decide), decision (what we chose), and consequences (what trade-offs we accepted). ' +
    'I want to see all ADRs sorted by most recent.',
  workspaceFiles: phase4Workspace(),
  toolMocks: STARTUP_CTO_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 54,
  validationCriteria: [
    {
      id: 'postmortem-schema',
      description: 'Incident or Postmortem model in schema',
      points: 4,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Incident') || schemaContainsModel(r, 'Postmortem')),
    },
    {
      id: 'postmortem-fields',
      description: 'Timeline / root cause / action items in canvas code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('timeline') || code.includes('root cause') || code.includes('action item')
      },
    },
    {
      id: 'postmortem-severity',
      description: 'SEV / severity in canvas code',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('sev1') || code.includes('sev-1') || code.includes('severity')
      },
    },
    {
      id: 'deploy-dashboard',
      description: 'Deployment dashboard in canvas code',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'deploy') || anyCanvasCodeContains(r, 'deployment'),
    },
    {
      id: 'deploy-charts',
      description: 'Charts for deploy metrics',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart') || code.includes('barchart')
      },
    },
    {
      id: 'deploy-frequency',
      description: 'Frequency / weekly deploy language',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('frequency') || code.includes('per week') || code.includes('weekly')
      },
    },
    {
      id: 'sla-tracker',
      description: 'SLA or uptime tracker',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        anyCanvasCodeContains(r, 'sla') || anyCanvasCodeContains(r, 'uptime'),
    },
    {
      id: 'sla-targets',
      description: '99.9 / 99.5 / target language',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('99.9') || code.includes('99.5') || code.includes('target')
      },
    },
    {
      id: 'sla-compliance',
      description: 'Compliance / miss / breach / flag language',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('compliance') || code.includes('miss') || code.includes('breach') || code.includes('flag')
      },
    },
    {
      id: 'adr-schema',
      description: 'ADR / Decision / ArchitectureDecision model',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'ADR') || schemaContainsModel(r, 'Decision') || schemaContainsModel(r, 'ArchitectureDecision')),
    },
    {
      id: 'adr-statuses',
      description: 'ADR lifecycle statuses in code',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('proposed') || code.includes('accepted') || code.includes('superseded')
      },
    },
    {
      id: 'adr-fields',
      description: 'Context / consequence / decision fields',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('context') || code.includes('consequence') || code.includes('decision')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas uses fetch to local /api',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
    {
      id: 'prior-models-preserved',
      description: 'Schema preserves Applicant model from prior phase',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        lastSchemaPreservesModel(r, 'Applicant') || lastSchemaPreservesModel(r, 'Candidate'),
    },
  ],
  tags: ['startup-cto'],
}

// ---------------------------------------------------------------------------
// Phase 5: Strategic (cto-strategic) — Level 5, 69 points (criteria sum)
// ---------------------------------------------------------------------------

const PHASE_5: AgentEval = {
  id: 'cto-strategic',
  name: 'Startup CTO: Strategic — velocity, flags, QER, roadmap',
  category: 'startup-cto' as any,
  level: 5,
  pipeline: 'startup-cto',
  pipelinePhase: 5,
  pipelineFiles: { 'files/sprints.json': SPRINTS_JSON },
  conversationHistory: [
    {
      role: 'user',
      content:
        'Analyze our engineering velocity. Sprint data is in the files folder. Look at completion rates, cycle time trends, and blocker patterns. Delegate the analysis.',
    },
    {
      role: 'user',
      content:
        'We need a feature flag system. Research LaunchDarkly, Unleash, and Flagsmith — compare pricing, features, self-hosting options, and developer experience. Do all three simultaneously.',
    },
    {
      role: 'user',
      content:
        'Build me a quarterly eng review dashboard. I want: velocity trend (line chart), deployment frequency (bar chart), incident count by severity (stacked bar), ' +
        'tech debt burned vs accumulated, and hiring pipeline status. Make it investor-grade.',
    },
  ],
  input:
    'Last one — build a roadmap planner. Each feature has a name, description, owning team, target quarter, status (proposed, committed, in-progress, shipped), ' +
    'effort estimate (S/M/L/XL), and dependencies on other features. I need to see which features block other features — show it as a dependency graph or Gantt chart.',
  workspaceFiles: phase5Workspace(),
  toolMocks: STARTUP_CTO_MOCKS,
  initialMode: 'canvas' as const,
  useRuntimeTemplate: true,
  useSkillServer: true,
  maxScore: 65,
  validationCriteria: [
    {
      id: 'velocity-delegation',
      description: 'Delegated velocity analysis (sub-agent)',
      points: 7,
      phase: 'intention',
      validate: (r) => subagentWasSpawned(r),
    },
    {
      id: 'velocity-analysis',
      description: 'Response discusses completion/velocity and sprints',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        (responseContains(r, 'completion') || responseContains(r, 'velocity')) &&
        responseContains(r, 'sprint'),
    },
    {
      id: 'velocity-blockers',
      description: 'Response mentions blockers or carryover',
      points: 3,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'blocker') || responseContains(r, 'carryover'),
    },
    {
      id: 'research-parallel',
      description: 'Parallel research (3+ sub-agents or 3+ web calls)',
      points: 7,
      phase: 'intention',
      validate: (r) =>
        countSubagentSpawns(r) >= 3 || toolCallCount(r, 'web') >= 3,
    },
    {
      id: 'research-all-vendors',
      description: 'Response names all three vendors',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        responseContains(r, 'launchdarkly') &&
        responseContains(r, 'unleash') &&
        responseContains(r, 'flagsmith'),
    },
    {
      id: 'qer-dashboard',
      description: 'Quarterly eng review canvas with velocity/sprint',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteCanvasFile(r) &&
        (anyCanvasCodeContains(r, 'velocity') || anyCanvasCodeContains(r, 'sprint')),
    },
    {
      id: 'qer-charts',
      description: 'QER uses charting',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('recharts') || code.includes('chart')
      },
    },
    {
      id: 'qer-multiple-viz',
      description: 'Multiple chart components or repeated chart usage',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        const chartTerms = ['linechart', 'barchart', 'piechart', 'areachart']
        const distinct = chartTerms.filter(t => code.includes(t)).length
        const chartOccurrences = (code.match(/chart/g) || []).length
        return distinct >= 2 || chartOccurrences >= 3
      },
    },
    {
      id: 'roadmap-schema',
      description: 'Feature or Roadmap model in schema',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        wroteSchema(r) &&
        (schemaContainsModel(r, 'Feature') || schemaContainsModel(r, 'Roadmap')),
    },
    {
      id: 'roadmap-dependencies',
      description: 'Dependencies / blocks / prerequisites in code',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('depend') || code.includes('block') || code.includes('prerequisite')
      },
    },
    {
      id: 'roadmap-quarters',
      description: 'Quarter / Q1 / Q2 planning language',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('quarter') || code.includes('q1') || code.includes('q2')
      },
    },
    {
      id: 'roadmap-effort',
      description: 'Effort / estimate / size (S/M/L)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('effort') || code.includes('estimate') || code.includes('size')
      },
    },
    {
      id: 'roadmap-visualization',
      description: 'Gantt / graph / DAG / timeline / dependency viz',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('gantt') || code.includes('graph') || code.includes('dag') ||
          code.includes('timeline') || code.includes('dependency')
      },
    },
    {
      id: 'api-wiring',
      description: 'Canvas uses fetch to local /api',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasCodeFetches(r),
    },
  ],
  tags: ['startup-cto'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const STARTUP_CTO_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
