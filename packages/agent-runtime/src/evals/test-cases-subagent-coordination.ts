// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent Coordination Eval — "AI COO" Pipeline
 *
 * Five-phase pipeline eval testing the agent's ability to create specialist
 * sub-agents and have them coordinate to produce a quarterly business review
 * from raw data.
 *
 * Phases:
 *   1. Assemble the Team — create specialist agents for each business function
 *   2. Parallel Analysis — run analysts in parallel, write domain reports
 *   3. Cross-Functional Strategy — chain agent outputs for dependent work
 *   4. Strategic Review — fork to review all prior work holistically
 *   5. Board Package — compile final deliverables via delegation
 */

import type { AgentEval, EvalResult } from './types'
import {
  usedTool,
  toolCallCount,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function agentCreateCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'agent_create').length
}

function agentSpawnCount(r: EvalResult): number {
  return r.toolCalls.filter(tc => tc.name === 'agent_spawn').length
}

function backgroundSpawnCount(r: EvalResult): number {
  return r.toolCalls.filter(tc =>
    tc.name === 'agent_spawn' &&
    (tc.input as any)?.background === true,
  ).length
}

function fileWasWritten(r: EvalResult, pathSubstr: string): boolean {
  return r.toolCalls.some(tc =>
    (tc.name === 'write_file' || tc.name === 'edit_file') &&
    JSON.stringify(tc.input).includes(pathSubstr),
  )
}

function writeContentContains(r: EvalResult, pathSubstr: string, contentSubstr: string): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'write_file' || tc.name === 'edit_file')
    .some(tc => {
      const input = JSON.stringify(tc.input)
      return input.includes(pathSubstr) && input.toLowerCase().includes(contentSubstr.toLowerCase())
    })
}

function allTextLower(r: EvalResult): string {
  return (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
}

function agentCreatePromptsContain(r: EvalResult, term: string): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'agent_create')
    .some(tc => {
      const input = JSON.stringify(tc.input).toLowerCase()
      return input.includes(term.toLowerCase())
    })
}

function anyAgentUsesModelTier(r: EvalResult, tier: string): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'agent_create')
    .some(tc => {
      const input = tc.input as Record<string, any>
      return input.model_tier === tier || input.model === tier
    })
}

function agentCreateIncludesTool(r: EvalResult, tool: string): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'agent_create')
    .some(tc => JSON.stringify(tc.input).toLowerCase().includes(tool.toLowerCase()))
}

function spawnedInParallel(r: EvalResult): boolean {
  const spawnCalls = r.toolCalls
    .map((tc, i) => ({ ...tc, idx: i }))
    .filter(tc => tc.name === 'agent_spawn')
  if (spawnCalls.length < 2) return false

  const resultCalls = r.toolCalls
    .map((tc, i) => ({ ...tc, idx: i }))
    .filter(tc => tc.name === 'agent_result')

  if (resultCalls.length === 0) {
    const indices = spawnCalls.map(s => s.idx)
    return indices[indices.length - 1] - indices[0] < spawnCalls.length + 2
  }

  const firstResult = resultCalls[0].idx
  const spawnsBeforeFirstResult = spawnCalls.filter(s => s.idx < firstResult).length
  return spawnsBeforeFirstResult >= 2
}

function spawnedWithoutType(r: EvalResult): boolean {
  return r.toolCalls
    .filter(tc => tc.name === 'agent_spawn')
    .some(tc => {
      const input = tc.input as Record<string, any>
      return !input.type && !input.agent_type
    })
}

// ---------------------------------------------------------------------------
// Seed data — Q1 business data files
// ---------------------------------------------------------------------------

const FINANCIALS_JSON = JSON.stringify({
  company: 'NovaCorp',
  period: 'Q1 2026',
  currency: 'USD',
  monthly: [
    {
      month: 'January',
      mrr: 284000,
      arr_run_rate: 3408000,
      new_revenue: 42000,
      churned_revenue: 12000,
      expansion_revenue: 18000,
      gross_revenue: 310000,
      cogs: 62000,
      gross_margin: 0.80,
      operating_expenses: {
        engineering: 185000,
        sales_marketing: 95000,
        general_admin: 45000,
        total: 325000,
      },
      net_income: -77000,
      cash_balance: 4200000,
      burn_rate: 77000,
    },
    {
      month: 'February',
      mrr: 308000,
      arr_run_rate: 3696000,
      new_revenue: 38000,
      churned_revenue: 8000,
      expansion_revenue: 22000,
      gross_revenue: 330000,
      cogs: 66000,
      gross_margin: 0.80,
      operating_expenses: {
        engineering: 190000,
        sales_marketing: 102000,
        general_admin: 46000,
        total: 338000,
      },
      net_income: -74000,
      cash_balance: 4126000,
      burn_rate: 74000,
    },
    {
      month: 'March',
      mrr: 341000,
      arr_run_rate: 4092000,
      new_revenue: 52000,
      churned_revenue: 11000,
      expansion_revenue: 28000,
      gross_revenue: 369000,
      cogs: 73000,
      gross_margin: 0.80,
      operating_expenses: {
        engineering: 195000,
        sales_marketing: 110000,
        general_admin: 47000,
        total: 352000,
      },
      net_income: -56000,
      cash_balance: 4070000,
      burn_rate: 56000,
    },
  ],
  summary: {
    q1_total_revenue: 1009000,
    q1_total_expenses: 1015000,
    q1_net_income: -207000,
    q1_ending_cash: 4070000,
    q1_avg_burn_rate: 69000,
    months_runway: 59,
    mrr_growth_rate: 0.20,
    net_revenue_retention: 1.12,
    logo_retention: 0.94,
  },
}, null, 2)

const CUSTOMERS_JSON = JSON.stringify({
  period: 'Q1 2026',
  total_customers: 47,
  segments: {
    enterprise: 8,
    mid_market: 19,
    startup: 20,
  },
  customers: [
    { name: 'Meridian Financial', segment: 'enterprise', arr: 480000, churn_risk: 0.08, nps_score: 72, contract_end: '2027-03-15', health_status: 'green', csm: 'Sarah Chen' },
    { name: 'Atlas Logistics', segment: 'enterprise', arr: 360000, churn_risk: 0.15, nps_score: 58, contract_end: '2026-09-01', health_status: 'yellow', csm: 'Sarah Chen' },
    { name: 'Prism Healthcare', segment: 'enterprise', arr: 420000, churn_risk: 0.05, nps_score: 85, contract_end: '2027-06-30', health_status: 'green', csm: 'Marcus Lee' },
    { name: 'Vertex Media', segment: 'mid_market', arr: 96000, churn_risk: 0.42, nps_score: 31, contract_end: '2026-06-15', health_status: 'red', csm: 'Marcus Lee' },
    { name: 'Cobalt Energy', segment: 'mid_market', arr: 120000, churn_risk: 0.12, nps_score: 67, contract_end: '2026-12-01', health_status: 'green', csm: 'Aisha Patel' },
    { name: 'Horizon Retail', segment: 'mid_market', arr: 84000, churn_risk: 0.55, nps_score: 22, contract_end: '2026-05-01', health_status: 'red', csm: 'Aisha Patel' },
    { name: 'Nimbus SaaS', segment: 'startup', arr: 24000, churn_risk: 0.25, nps_score: 61, contract_end: '2026-08-01', health_status: 'yellow', csm: 'Marcus Lee' },
    { name: 'Beacon Analytics', segment: 'startup', arr: 36000, churn_risk: 0.10, nps_score: 78, contract_end: '2027-01-15', health_status: 'green', csm: 'Aisha Patel' },
    { name: 'Forge Manufacturing', segment: 'enterprise', arr: 540000, churn_risk: 0.03, nps_score: 91, contract_end: '2027-12-31', health_status: 'green', csm: 'Sarah Chen' },
    { name: 'Slate Education', segment: 'mid_market', arr: 72000, churn_risk: 0.38, nps_score: 40, contract_end: '2026-07-01', health_status: 'yellow', csm: 'Marcus Lee' },
    { name: 'Drift Mobility', segment: 'startup', arr: 18000, churn_risk: 0.65, nps_score: 19, contract_end: '2026-04-30', health_status: 'red', csm: 'Aisha Patel' },
    { name: 'Quartz Fintech', segment: 'mid_market', arr: 108000, churn_risk: 0.09, nps_score: 74, contract_end: '2026-11-15', health_status: 'green', csm: 'Sarah Chen' },
  ],
  churn_summary: {
    q1_churned_accounts: 3,
    q1_churned_arr: 78000,
    at_risk_accounts: 4,
    at_risk_arr: 270000,
    avg_nps: 58,
  },
}, null, 2)

const PRODUCT_METRICS_JSON = JSON.stringify({
  period: 'Q1 2026',
  feature_usage: {
    dashboard: { dau: 1842, wau: 3210, adoption_rate: 0.92, avg_session_min: 14.3 },
    reports: { dau: 1205, wau: 2890, adoption_rate: 0.78, avg_session_min: 8.7 },
    api_access: { dau: 890, wau: 1560, adoption_rate: 0.54, avg_session_min: null },
    integrations: { dau: 634, wau: 1120, adoption_rate: 0.41, avg_session_min: 6.2 },
    automations: { dau: 412, wau: 780, adoption_rate: 0.28, avg_session_min: 11.5 },
    collaboration: { dau: 1580, wau: 2950, adoption_rate: 0.85, avg_session_min: 9.8 },
  },
  support_tickets: {
    total_q1: 342,
    by_category: {
      bug_report: 89,
      feature_request: 78,
      performance: 52,
      integration_issue: 64,
      billing: 31,
      onboarding: 28,
    },
    avg_resolution_hours: 18.4,
    sla_compliance: 0.91,
    csat: 4.2,
  },
  reliability: {
    uptime_percent: 99.87,
    incidents: 4,
    p50_latency_ms: 120,
    p99_latency_ms: 890,
    error_rate: 0.003,
    deploys_per_week: 8.5,
    rollback_rate: 0.06,
  },
}, null, 2)

const TEAM_JSON = JSON.stringify({
  period: 'Q1 2026',
  total_headcount: 52,
  departments: {
    engineering: {
      headcount: 24,
      teams: {
        backend: 8,
        frontend: 6,
        infrastructure: 4,
        mobile: 3,
        qa: 3,
      },
      velocity: {
        avg_story_points_per_sprint: 142,
        sprint_completion_rate: 0.87,
        cycle_time_days: 4.2,
        bugs_per_sprint: 11,
      },
      open_positions: ['Senior Backend Engineer', 'Staff Frontend Engineer', 'SRE'],
    },
    product: {
      headcount: 5,
      roles: { pm: 3, designer: 2 },
      open_positions: ['Senior Product Manager'],
    },
    sales_marketing: {
      headcount: 12,
      roles: { ae: 4, sdr: 3, marketing: 3, solutions_engineer: 2 },
      open_positions: ['Enterprise AE', 'Content Marketing Manager'],
    },
    customer_success: {
      headcount: 6,
      roles: { csm: 3, support: 3 },
      open_positions: [],
    },
    general_admin: {
      headcount: 5,
      roles: { finance: 2, hr: 1, legal: 1, office: 1 },
      open_positions: ['VP Finance'],
    },
  },
  attrition: {
    q1_departures: 2,
    q1_hires: 4,
    voluntary_attrition_rate: 0.038,
    avg_tenure_months: 18,
  },
  engagement: {
    last_survey_score: 7.8,
    participation_rate: 0.91,
    top_concerns: ['career growth', 'work-life balance', 'tooling'],
  },
}, null, 2)

const COMPETITORS_JSON = JSON.stringify({
  period: 'Q1 2026',
  competitors: [
    {
      name: 'DataStream Pro',
      founded: 2019,
      funding: '$45M Series B',
      estimated_arr: 12000000,
      pricing: { starter: 299, professional: 799, enterprise: 'custom' },
      features: {
        real_time_dashboard: true,
        api_access: true,
        custom_integrations: true,
        automations: true,
        collaboration: true,
        mobile_app: true,
        soc2_compliance: true,
        sso: true,
      },
      recent_moves: ['Launched AI analytics module', 'Hired ex-Snowflake VP Eng', 'Expanded to EMEA'],
      strengths: ['Strong enterprise sales', 'Real-time processing speed'],
      weaknesses: ['Poor UX', 'Expensive for mid-market'],
    },
    {
      name: 'InsightHub',
      founded: 2021,
      funding: '$18M Series A',
      estimated_arr: 5000000,
      pricing: { starter: 149, professional: 449, enterprise: 999 },
      features: {
        real_time_dashboard: true,
        api_access: true,
        custom_integrations: false,
        automations: true,
        collaboration: false,
        mobile_app: false,
        soc2_compliance: true,
        sso: false,
      },
      recent_moves: ['Launched freemium tier', 'Partnership with HubSpot', 'Acquired small ML startup'],
      strengths: ['PLG motion', 'Strong self-serve conversion'],
      weaknesses: ['Limited enterprise features', 'No SSO'],
    },
    {
      name: 'Apex Analytics',
      founded: 2017,
      funding: '$120M Series D',
      estimated_arr: 48000000,
      pricing: { starter: null, professional: 1200, enterprise: 'custom' },
      features: {
        real_time_dashboard: true,
        api_access: true,
        custom_integrations: true,
        automations: true,
        collaboration: true,
        mobile_app: true,
        soc2_compliance: true,
        sso: true,
      },
      recent_moves: ['IPO rumored for Q3', 'Launched vertical solutions for healthcare', 'Price increase 15%'],
      strengths: ['Market leader', 'Deep enterprise relationships', 'Broad feature set'],
      weaknesses: ['Slow innovation', 'Legacy architecture', 'Expensive'],
    },
    {
      name: 'Pulse.io',
      founded: 2023,
      funding: '$8M Seed',
      estimated_arr: 1200000,
      pricing: { starter: 49, professional: 199, enterprise: 599 },
      features: {
        real_time_dashboard: true,
        api_access: true,
        custom_integrations: false,
        automations: false,
        collaboration: true,
        mobile_app: true,
        soc2_compliance: false,
        sso: false,
      },
      recent_moves: ['Open-sourced core engine', 'Viral TikTok demo', 'Targeting SMB market'],
      strengths: ['Modern UX', 'Developer-friendly', 'Low price point'],
      weaknesses: ['Early stage', 'Limited features', 'No compliance certs'],
    },
  ],
  our_position: {
    strengths: ['Best-in-class collaboration', 'Strong mid-market fit', 'Fast iteration speed'],
    weaknesses: ['No mobile app', 'Limited enterprise SSO', 'Small sales team'],
    opportunities: ['Apex price increase creating openings', 'InsightHub lacks SSO/enterprise', 'AI features gap in market'],
    threats: ['DataStream AI launch', 'Pulse.io undercutting on price', 'Apex vertical solutions'],
  },
}, null, 2)

function seedWorkspaceFiles(): Record<string, string> {
  return {
    'data/financials.json': FINANCIALS_JSON,
    'data/customers.json': CUSTOMERS_JSON,
    'data/product-metrics.json': PRODUCT_METRICS_JSON,
    'data/team.json': TEAM_JSON,
    'data/competitors.json': COMPETITORS_JSON,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Assemble the Team — Level 2, 25 points
// ---------------------------------------------------------------------------

const PHASE_1: AgentEval = {
  id: 'coord-assemble',
  name: 'AI COO: Assemble the Team — create specialist agents',
  category: 'subagent-coordination' as any,
  level: 2,
  pipeline: 'subagent-coordination',
  pipelinePhase: 1,
  input:
    "You're our AI COO. Here's our Q1 data in `data/`. Start by exploring the data files, " +
    'then create specialist agents for each business function: finance, customer success, ' +
    'product strategy, and engineering.',
  conversationHistory: [],
  workspaceFiles: seedWorkspaceFiles(),
  maxScore: 25,
  validationCriteria: [
    {
      id: 'created-agents',
      description: 'agent_create called 3+ times to build specialist agents',
      points: 5,
      phase: 'intention',
      validate: (r) => agentCreateCount(r) >= 3,
    },
    {
      id: 'distinct-prompts',
      description: 'Each agent has a distinct system prompt referencing its domain',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const domains = ['financ', 'customer', 'product', 'engineer']
        const matched = domains.filter(d => agentCreatePromptsContain(r, d))
        return matched.length >= 3
      },
    },
    {
      id: 'cost-efficient-tier',
      description: 'At least one agent uses model_tier "fast" for cost efficiency',
      points: 3,
      phase: 'intention',
      validate: (r) => anyAgentUsesModelTier(r, 'fast'),
    },
    {
      id: 'read-tools-provided',
      description: 'Agents include read_file and grep in tool lists',
      points: 4,
      phase: 'intention',
      validate: (r) =>
        agentCreateIncludesTool(r, 'read_file') && agentCreateIncludesTool(r, 'grep'),
    },
    {
      id: 'explored-data-first',
      description: 'Agent explored the data files before creating specialists',
      points: 4,
      phase: 'intention',
      validate: (r) => {
        const readIdx = r.toolCalls.findIndex(tc =>
          tc.name === 'read_file' && JSON.stringify(tc.input).includes('data/'),
        )
        const createIdx = r.toolCalls.findIndex(tc => tc.name === 'agent_create')
        return readIdx >= 0 && createIdx >= 0 && readIdx < createIdx
      },
    },
    {
      id: 'no-unnecessary-write-tools',
      description: 'No agent is given write tools unnecessarily',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const createCalls = r.toolCalls.filter(tc => tc.name === 'agent_create')
        const withWrite = createCalls.filter(tc => {
          const json = JSON.stringify(tc.input).toLowerCase()
          return json.includes('write_file') || json.includes('edit_file')
        })
        return withWrite.length <= 1
      },
    },
  ],
  tags: ['subagent-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 2: Parallel Analysis — Level 3, 30 points
// ---------------------------------------------------------------------------

const PHASE_2_PROMPT =
  'Run all your analysts in parallel. Have each one analyze their domain from the data ' +
  'and write a brief report to `reports/<domain>.md`.'

const PHASE_2: AgentEval = {
  id: 'coord-parallel',
  name: 'AI COO: Parallel Analysis — run analysts concurrently',
  category: 'subagent-coordination' as any,
  level: 3,
  pipeline: 'subagent-coordination',
  pipelinePhase: 2,
  input: PHASE_2_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_2_PROMPT }],
  pipelineFiles: {},
  maxScore: 30,
  validationCriteria: [
    {
      id: 'background-spawns',
      description: '3+ agent_spawn calls with background: true',
      points: 8,
      phase: 'intention',
      validate: (r) => backgroundSpawnCount(r) >= 3,
    },
    {
      id: 'collected-results',
      description: 'agent_result called for each spawned agent',
      points: 5,
      phase: 'intention',
      validate: (r) => {
        const spawns = agentSpawnCount(r)
        const results = toolCallCount(r, 'agent_result')
        return spawns > 0 && results >= spawns
      },
    },
    {
      id: 'reports-created',
      description: 'Report files created in reports/ directory',
      points: 8,
      phase: 'execution',
      validate: (r) => {
        const reportFiles = r.toolCalls.filter(tc =>
          tc.name === 'write_file' &&
          JSON.stringify(tc.input).includes('reports/'),
        )
        return reportFiles.length >= 3
      },
    },
    {
      id: 'reports-reference-data',
      description: 'Reports reference actual data from the JSON files',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const text = allTextLower(r)
        const dataTerms = ['mrr', 'novacorp', 'churn_risk', 'nps', 'meridian', 'atlas', 'uptime', 'velocity']
        return dataTerms.filter(t => text.includes(t)).length >= 3
      },
    },
    {
      id: 'parallel-spawn',
      description: 'Multiple spawns in same turn, not sequential',
      points: 4,
      phase: 'intention',
      validate: (r) => spawnedInParallel(r),
    },
  ],
  antiPatterns: [
    'Agent does the analysis itself instead of delegating',
    'Only spawns 1 agent at a time sequentially',
  ],
  tags: ['subagent-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 3: Cross-Functional Strategy — Level 4, 30 points
// ---------------------------------------------------------------------------

const PHASE_3_PROMPT =
  'Now create cross-functional strategies. Have an agent build a product roadmap informed ' +
  'by the customer churn analysis AND engineering capacity. Then have another agent create ' +
  'a hiring plan based on the roadmap and revenue projections. Chain their work — the ' +
  "second agent needs the first agent's output."

const PHASE_3: AgentEval = {
  id: 'coord-chain',
  name: 'AI COO: Cross-Functional Strategy — chained agent outputs',
  category: 'subagent-coordination' as any,
  level: 4,
  pipeline: 'subagent-coordination',
  pipelinePhase: 3,
  input: PHASE_3_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_3_PROMPT }],
  pipelineFiles: {},
  maxScore: 30,
  validationCriteria: [
    {
      id: 'first-agent-references-inputs',
      description: 'First agent_spawn prompt references customer and engineering analysis',
      points: 6,
      phase: 'intention',
      validate: (r) => {
        const spawns = r.toolCalls.filter(tc => tc.name === 'agent_spawn')
        if (spawns.length < 1) return false
        const firstPrompt = JSON.stringify(spawns[0].input).toLowerCase()
        return (firstPrompt.includes('customer') || firstPrompt.includes('churn')) &&
          (firstPrompt.includes('engineer') || firstPrompt.includes('capacity'))
      },
    },
    {
      id: 'second-agent-references-first',
      description: "Second agent_spawn prompt references the first agent's output",
      points: 8,
      phase: 'intention',
      validate: (r) => {
        const spawns = r.toolCalls.filter(tc => tc.name === 'agent_spawn')
        if (spawns.length < 2) return false
        const secondPrompt = JSON.stringify(spawns[1].input).toLowerCase()
        return secondPrompt.includes('roadmap') || secondPrompt.includes('first agent') ||
          secondPrompt.includes('previous') || secondPrompt.includes('output')
      },
    },
    {
      id: 'sequential-execution',
      description: 'Second agent spawned AFTER first completes',
      points: 6,
      phase: 'intention',
      validate: (r) => {
        const calls = r.toolCalls.map((tc, i) => ({ ...tc, idx: i }))
        const spawns = calls.filter(tc => tc.name === 'agent_spawn')
        const results = calls.filter(tc => tc.name === 'agent_result')
        if (spawns.length < 2 || results.length < 1) return false
        const firstResult = results[0].idx
        const secondSpawn = spawns[1].idx
        return secondSpawn > firstResult
      },
    },
    {
      id: 'roadmap-written',
      description: 'Roadmap file written',
      points: 5,
      phase: 'execution',
      validate: (r) =>
        fileWasWritten(r, 'roadmap') ||
        writeContentContains(r, 'reports/', 'roadmap'),
    },
    {
      id: 'hiring-plan-written',
      description: 'Hiring plan file written and references the roadmap',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const hasHiringPlan = fileWasWritten(r, 'hiring') || fileWasWritten(r, 'hiring-plan')
        const referencesRoadmap = writeContentContains(r, 'hiring', 'roadmap') ||
          writeContentContains(r, 'plan', 'roadmap')
        return hasHiringPlan || referencesRoadmap
      },
    },
  ],
  antiPatterns: [
    'Both agents spawned simultaneously (ignoring dependency)',
    'Agent does synthesis itself instead of delegating',
  ],
  tags: ['subagent-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 4: Strategic Review — Level 4, 30 points
// ---------------------------------------------------------------------------

const PHASE_4_PROMPT =
  "Step back and review everything holistically. Are there conflicts between the plans? " +
  "Resource allocation issues? Risks we're missing? I want a thorough cross-cutting review."

const PHASE_4: AgentEval = {
  id: 'coord-fork-review',
  name: 'AI COO: Strategic Review — fork for holistic analysis',
  category: 'subagent-coordination' as any,
  level: 4,
  pipeline: 'subagent-coordination',
  pipelinePhase: 4,
  input: PHASE_4_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_4_PROMPT }],
  pipelineFiles: {},
  maxScore: 30,
  validationCriteria: [
    {
      id: 'fork-mode-spawn',
      description: 'agent_spawn called without type parameter (fork mode)',
      points: 10,
      phase: 'intention',
      validate: (r) => spawnedWithoutType(r),
    },
    {
      id: 'references-prior-phases',
      description: 'Review references findings from 2+ prior phases',
      points: 8,
      phase: 'execution',
      validate: (r) => {
        const text = allTextLower(r)
        const phases = [
          text.includes('financ') || text.includes('revenue') || text.includes('burn'),
          text.includes('customer') || text.includes('churn') || text.includes('nps'),
          text.includes('product') || text.includes('roadmap') || text.includes('feature'),
          text.includes('engineer') || text.includes('hiring') || text.includes('capacity'),
        ]
        return phases.filter(Boolean).length >= 2
      },
    },
    {
      id: 'identifies-risk-or-conflict',
      description: 'Review identifies at least one cross-cutting risk or conflict',
      points: 6,
      phase: 'execution',
      validate: (r) => {
        const text = allTextLower(r)
        return text.includes('risk') || text.includes('conflict') || text.includes('tension') ||
          text.includes('tradeoff') || text.includes('trade-off') || text.includes('misalign')
      },
    },
    {
      id: 'review-file-written',
      description: 'Review written to reports/strategic-review.md',
      points: 6,
      phase: 'execution',
      validate: (r) =>
        fileWasWritten(r, 'strategic-review') || fileWasWritten(r, 'review.md'),
    },
  ],
  antiPatterns: [
    'Agent spawns a fresh general-purpose agent instead of forking',
    'Agent does the review itself without delegating',
  ],
  tags: ['subagent-coordination'],
}

// ---------------------------------------------------------------------------
// Phase 5: Board Package — Level 4, 35 points
// ---------------------------------------------------------------------------

const PHASE_5_PROMPT =
  'Compile everything into a board-ready package. I need: (1) an executive summary in ' +
  '`board/executive-summary.md`, (2) a risk register in `board/risks.md` with owner and ' +
  'severity, and (3) an action items list in `board/action-items.md` with deadlines. ' +
  'Delegate the compilation to your agents.'

const PHASE_5: AgentEval = {
  id: 'coord-board-package',
  name: 'AI COO: Board Package — compile final deliverables',
  category: 'subagent-coordination' as any,
  level: 4,
  pipeline: 'subagent-coordination',
  pipelinePhase: 5,
  input: PHASE_5_PROMPT,
  conversationHistory: [{ role: 'user', content: PHASE_5_PROMPT }],
  pipelineFiles: {},
  maxScore: 35,
  validationCriteria: [
    {
      id: 'delegated-compilation',
      description: 'Sub-agent(s) used for compilation',
      points: 6,
      phase: 'intention',
      validate: (r) => usedTool(r, 'agent_spawn'),
    },
    {
      id: 'executive-summary-exists',
      description: 'board/executive-summary.md exists and references key metrics',
      points: 8,
      phase: 'execution',
      validate: (r) => {
        const hasFile = fileWasWritten(r, 'executive-summary')
        const hasMetrics = writeContentContains(r, 'executive-summary', 'mrr') ||
          writeContentContains(r, 'executive-summary', 'revenue') ||
          writeContentContains(r, 'executive-summary', 'arr') ||
          writeContentContains(r, 'executive-summary', 'growth')
        return hasFile && hasMetrics
      },
    },
    {
      id: 'risk-register-exists',
      description: 'board/risks.md exists with structured entries (severity, owner)',
      points: 8,
      phase: 'execution',
      validate: (r) => {
        const hasFile = fileWasWritten(r, 'risks.md') || fileWasWritten(r, 'board/risks')
        const hasSeverity = writeContentContains(r, 'risk', 'severity') ||
          writeContentContains(r, 'risk', 'high') ||
          writeContentContains(r, 'risk', 'critical')
        const hasOwner = writeContentContains(r, 'risk', 'owner')
        return hasFile && (hasSeverity || hasOwner)
      },
    },
    {
      id: 'action-items-exists',
      description: 'board/action-items.md exists with deadlines',
      points: 8,
      phase: 'execution',
      validate: (r) => {
        const hasFile = fileWasWritten(r, 'action-items')
        const hasDeadlines = writeContentContains(r, 'action', 'deadline') ||
          writeContentContains(r, 'action', 'due') ||
          writeContentContains(r, 'action', '2026') ||
          writeContentContains(r, 'action', 'date')
        return hasFile && hasDeadlines
      },
    },
    {
      id: 'cross-references',
      description: 'Documents cross-reference each other or prior reports',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const text = allTextLower(r)
        const crossRefs = [
          'executive-summary', 'risk register', 'action item',
          'strategic review', 'roadmap', 'hiring plan',
        ]
        return crossRefs.filter(ref => text.includes(ref)).length >= 2
      },
    },
  ],
  antiPatterns: [
    'No delegation - agent writes all documents directly',
  ],
  tags: ['subagent-coordination'],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const SUBAGENT_COORDINATION_EVALS: AgentEval[] = [
  PHASE_1,
  PHASE_2,
  PHASE_3,
  PHASE_4,
  PHASE_5,
]
