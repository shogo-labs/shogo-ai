// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Advanced Skill Server Evals — Complex Multi-Step Agent Scenarios
 *
 * Six level-5 evals that test the agent's full orchestration pipeline using
 * natural user prompts with NO meta-prompting. The user never mentions
 * "skill server", "schema.prisma", "canvas", or "SKILL.md". The agent must
 * independently decide to use the right tools.
 *
 * Every integration mock returns noisy data — irrelevant records, red
 * herrings, dirty data — forcing the agent to filter, reason, and
 * categorize rather than just piping data through.
 *
 * Covers:
 * 1. CI/CD Failure Analyzer (GitHub integration, categorization, trends)
 * 2. Competitive Intelligence Tracker (scoring algorithm, ranked dashboard)
 * 3. Incident Triage (causal reasoning, alert correlation, timeline)
 * 4. Email + Slack Reconciliation (cross-source filtering, action items)
 * 5. Self-Healing Data Pipeline (diagnosis, fix, execution, persistence)
 * 6. Multi-Source Intelligence Briefing (3 integrations, synthesis)
 *
 * Track: --track skill-server-advanced
 */

import type { AgentEval, EvalResult } from './types'
import type { ToolMockMap } from './tool-mocks'
import {
  usedTool,
  responseContains,
  toolCallsJson,
  toolCallArgsContain,
} from './eval-helpers'

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
// Shared validation helpers
// ---------------------------------------------------------------------------

function wroteSchema(r: EvalResult, ...requiredModels: string[]): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '').toLowerCase()
  return requiredModels.every((m) => content.includes(`model ${m.toLowerCase()}`))
}

function wroteSchemaWithAnyModels(r: EvalResult, minModels: number): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '')
  const matches = content.match(/model\s+\w+/g)
  return (matches?.length ?? 0) >= minModels
}

function schemaContainsFields(r: EvalResult, ...fields: string[]): boolean {
  const write = r.toolCalls
    .filter((t) => t.name === 'write_file')
    .find((t) => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (!write) return false
  const content = String((write.input as any).content ?? '').toLowerCase()
  return fields.every((f) => content.includes(f.toLowerCase()))
}

function wroteCanvasFile(r: EvalResult): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'write_file') return false
    const path = String((t.input as any).path ?? '')
    return /^src\/.*\.(tsx?|jsx?)$/.test(path) || /^canvas\/[^/]+\.ts$/.test(path)
  })
}

function allCanvasCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '')
      return /^src\/.*\.(tsx?|jsx?)$/.test(path) || /^canvas\/[^/]+\.ts$/.test(path)
    })
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

/** True if agent called tool_install for a specific integration (or any). */
function installedIntegration(r: EvalResult, name?: string): boolean {
  return r.toolCalls.some(t => {
    if (t.name !== 'tool_install') return false
    if (!name) return true
    return JSON.stringify(t.input).toLowerCase().includes(name.toLowerCase())
  })
}

/** True if agent used exec with a `gh` CLI command. */
function usedGhCli(r: EvalResult): boolean {
  return r.toolCalls.some(t =>
    t.name === 'exec' && /\bgh\b/.test(String((t.input as any).command ?? '')),
  )
}

/** True if data was POSTed to the skill server via the web tool or exec curl. */
function postedToSkillServer(r: EvalResult, pathFragment?: string): boolean {
  const frag = (pathFragment ?? 'api').toLowerCase()
  const viaWeb = r.toolCalls.some(t => {
    if (t.name !== 'web') return false
    const json = JSON.stringify(t.input).toLowerCase()
    return json.includes('post') && json.includes(frag)
  })
  if (viaWeb) return true
  return r.toolCalls.some(t => {
    if (t.name !== 'exec') return false
    const cmd = String((t.input as any).command ?? '').toLowerCase()
    return cmd.includes('curl') && cmd.includes('post') && cmd.includes(frag)
  })
}

/** True if component code uses fetch() or references the skill server API. */
function canvasFetchesFromApi(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return (code.includes('fetch(') || code.includes('useeffect') || code.includes('axios') || code.includes('/api/')) &&
    (code.includes('/api/') || code.includes('localhost:4100'))
}

function wroteSkillFile(r: EvalResult, ...keywords: string[]): boolean {
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

function readFileBeforeEdit(r: EvalResult, pathSubstring: string): boolean {
  const editIdx = r.toolCalls.findIndex(
    (t) => (t.name === 'edit_file' || t.name === 'write_file') &&
      String((t.input as any).path ?? '').includes(pathSubstring),
  )
  if (editIdx === -1) return false
  return r.toolCalls.slice(0, editIdx).some(
    (t) => t.name === 'read_file' && String((t.input as any).path ?? '').includes(pathSubstring),
  )
}

// ---------------------------------------------------------------------------
// Skill server mock factory (reused across evals)
// ---------------------------------------------------------------------------

function makeSkillServerMocks(models: string[], sampleData: Record<string, any[]>, extras?: ToolMockMap): ToolMockMap {
  const webPatterns: Array<{ match: Record<string, string>; response: { content: string; status: number } }> = []

  for (const model of models) {
    const plural = model.toLowerCase() + 's'
    webPatterns.push({
      match: { url: plural, method: 'POST' },
      response: {
        content: JSON.stringify({ ok: true, data: { id: `${model.toLowerCase()}-1`, ...(sampleData[model]?.[0] ?? {}) } }),
        status: 201,
      },
    })
    webPatterns.push({
      match: { url: plural },
      response: {
        content: JSON.stringify({ ok: true, items: (sampleData[model] ?? []).map((d, i) => ({ id: `${model.toLowerCase()}-${i + 1}`, ...d })) }),
        status: 200,
      },
    })
  }

  return {
    web: {
      type: 'pattern',
      patterns: [
        ...webPatterns,
        { match: { url: 'health' }, response: { content: JSON.stringify({ ok: true }), status: 200 } },
      ],
      default: { content: JSON.stringify({ ok: true }), status: 200 },
    },
    ...extras,
  }
}

// =========================================================================
// EVAL 1: CI/CD Failure Analyzer
// =========================================================================

const CI_GITHUB_WORKFLOW_RUNS = [
  { id: 1001, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 481, created_at: '2026-03-24T09:15:00Z', updated_at: '2026-03-24T09:22:00Z', event: 'push', jobs: [{ name: 'test-unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
  { id: 1002, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 480, created_at: '2026-03-24T08:00:00Z', updated_at: '2026-03-24T08:05:00Z', event: 'push', jobs: [{ name: 'test-unit', conclusion: 'success' }] },
  { id: 1003, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'feature/auth', run_number: 479, created_at: '2026-03-23T16:30:00Z', updated_at: '2026-03-23T16:45:00Z', event: 'pull_request', jobs: [{ name: 'test-unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }, { name: 'test-e2e', conclusion: 'skipped' }] },
  { id: 1004, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 478, created_at: '2026-03-23T15:00:00Z', updated_at: '2026-03-23T15:06:00Z', event: 'push', jobs: [] },
  { id: 1005, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 477, created_at: '2026-03-23T11:00:00Z', updated_at: '2026-03-23T11:30:00Z', event: 'push', jobs: [{ name: 'build', conclusion: 'failure', steps: [{ name: 'Build app', conclusion: 'failure' }] }] },
  { id: 1006, name: 'Deploy Staging', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 202, created_at: '2026-03-23T10:00:00Z', updated_at: '2026-03-23T10:02:00Z', event: 'push', jobs: [] },
  { id: 1007, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'fix/payments', run_number: 476, created_at: '2026-03-22T17:00:00Z', updated_at: '2026-03-22T17:20:00Z', event: 'pull_request', jobs: [{ name: 'test-unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
  { id: 1008, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 475, created_at: '2026-03-22T14:00:00Z', updated_at: '2026-03-22T14:04:00Z', event: 'push', jobs: [] },
  { id: 1009, name: 'CodeQL', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 98, created_at: '2026-03-22T12:00:00Z', updated_at: '2026-03-22T12:15:00Z', event: 'schedule', jobs: [] },
  { id: 1010, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 474, created_at: '2026-03-22T10:00:00Z', updated_at: '2026-03-22T10:35:00Z', event: 'push', jobs: [{ name: 'test-e2e', conclusion: 'failure', steps: [{ name: 'E2E tests', conclusion: 'timed_out' }] }] },
  { id: 1011, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'feature/dashboard', run_number: 473, created_at: '2026-03-21T16:00:00Z', updated_at: '2026-03-21T16:05:00Z', event: 'pull_request', jobs: [] },
  { id: 1012, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 472, created_at: '2026-03-21T14:00:00Z', updated_at: '2026-03-21T14:22:00Z', event: 'push', jobs: [{ name: 'test-unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
  { id: 1013, name: 'Deploy Staging', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 201, created_at: '2026-03-21T13:00:00Z', updated_at: '2026-03-21T13:05:00Z', event: 'push', jobs: [] },
  { id: 1014, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 471, created_at: '2026-03-21T10:00:00Z', updated_at: '2026-03-21T10:06:00Z', event: 'push', jobs: [] },
  { id: 1015, name: 'Dependabot', status: 'completed', conclusion: 'success', head_branch: 'dependabot/npm_and_yarn/express-4.21.1', run_number: 55, created_at: '2026-03-21T03:00:00Z', updated_at: '2026-03-21T03:04:00Z', event: 'pull_request', jobs: [] },
  { id: 1016, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'feature/auth', run_number: 470, created_at: '2026-03-20T17:00:00Z', updated_at: '2026-03-20T17:18:00Z', event: 'pull_request', jobs: [{ name: 'test-unit', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
  { id: 1017, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 469, created_at: '2026-03-20T15:00:00Z', updated_at: '2026-03-20T15:05:00Z', event: 'push', jobs: [] },
  { id: 1018, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', run_number: 468, created_at: '2026-03-20T11:00:00Z', updated_at: '2026-03-20T11:25:00Z', event: 'push', jobs: [{ name: 'build', conclusion: 'failure', steps: [{ name: 'Build app', conclusion: 'failure' }] }] },
  { id: 1019, name: 'CodeQL', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 97, created_at: '2026-03-20T06:00:00Z', updated_at: '2026-03-20T06:12:00Z', event: 'schedule', jobs: [] },
  { id: 1020, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', run_number: 467, created_at: '2026-03-19T16:00:00Z', updated_at: '2026-03-19T16:05:00Z', event: 'push', jobs: [] },
]

const CI_ANALYZER_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['WorkflowRun', 'FlakyTest'], {
    WorkflowRun: [{ name: 'CI', status: 'failure', category: 'test_failure' }],
    FlakyTest: [{ testName: 'test-unit', failureCount: 5 }],
  }),
}

const CI_ANALYZER_EVAL: AgentEval = {
  id: 'adv-ci-failure-analyzer',
  name: 'Advanced: CI/CD Failure Analyzer from GitHub data',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  input: "Our CI pipeline on GitHub has been really flaky this week. I exported the recent workflow runs to github_workflow_runs.json in the workspace. Can you analyze the data, figure out what's going wrong (are they test failures? build errors? timeouts?), and give me a breakdown so I can see which tests are the flakiest and what the overall failure trend looks like? Store the analysis in a skill server and build me a React dashboard. I want to be able to re-run this analysis whenever things get bad again.",
  workspaceFiles: {
    'config.json': V2_CONFIG,
    'github_workflow_runs.json': JSON.stringify({ total_count: CI_GITHUB_WORKFLOW_RUNS.length, workflow_runs: CI_GITHUB_WORKFLOW_RUNS }, null, 2),
  },
  maxScore: 30,
  toolMocks: CI_ANALYZER_MOCKS,
  validationCriteria: [
    { id: 'read-data', description: 'Read the exported GitHub workflow data', points: 4, phase: 'intention', validate: (r) => r.toolCalls.some(t => t.name === 'read_file' && String((t.input as any).path ?? '').includes('github_workflow')) },
    { id: 'wrote-schema', description: 'Wrote schema.prisma with at least 2 models', points: 4, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 2) },
    { id: 'schema-fields', description: 'Schema contains failure-related fields', points: 3, phase: 'execution', validate: (r) => schemaContainsFields(r, 'status') && (schemaContainsFields(r, 'category') || schemaContainsFields(r, 'type') || schemaContainsFields(r, 'conclusion')) },
    { id: 'posted-data', description: 'POSTed categorized data to skill server', points: 4, phase: 'execution', validate: (r) => postedToSkillServer(r) },
    { id: 'built-canvas', description: 'Built canvas dashboard', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 3, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'canvas-has-categories', description: 'Canvas references failure categories or flaky tests', points: 3, phase: 'execution', validate: (r) => { const c = allCanvasCode(r); return c.includes('flaky') || c.includes('failure') || c.includes('test') || c.includes('build') || c.includes('timeout') } },
    { id: 'wrote-skill', description: 'Created a reusable skill file', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) },
    { id: 'response-analysis', description: 'Response includes failure analysis', points: 3, phase: 'execution', validate: (r) => responseContains(r, 'fail') || responseContains(r, 'flaky') || responseContains(r, 'test') },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Tool loop or repeated identical calls'],
}

// =========================================================================
// EVAL 2: Competitive Intelligence Tracker
// =========================================================================

const COMPETITIVE_INTEL_MOCKS_ADV = makeSkillServerMocks(
  ['Competitor'],
  { Competitor: [{ name: 'Acme Corp', fundingStage: 'Series B', arr: 12000000, employees: 150, threatScore: 82 }] },
)

const COMPETITIVE_INTEL_EVAL: AgentEval = {
  id: 'adv-competitive-intel',
  name: 'Advanced: Competitive Intelligence Tracker with threat scoring',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    "I need to keep track of our competitors and understand who's the biggest threat. Here's what I know:",
    '',
    '- Acme Corp: Series B, $12M ARR, 150 employees, launched an AI feature last month',
    '- Beta Inc: Series A, $3M ARR, 40 employees, just raised $15M last quarter',
    '- Gamma Labs: Seed stage, $800K ARR, 12 employees, launched their product 2 weeks ago',
    '',
    "Can you organize this, score them by threat level (I care most about funding and revenue, then team size and momentum), and give me a view of the competitive landscape? I'd like to be able to update this with new info whenever I get it.",
  ].join('\n'),
  maxScore: 30,
  toolMocks: COMPETITIVE_INTEL_MOCKS_ADV,
  validationCriteria: [
    { id: 'wrote-schema', description: 'Wrote schema.prisma with Competitor model', points: 3, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 1) },
    { id: 'schema-scoring-fields', description: 'Schema includes scoring-related fields', points: 3, phase: 'execution', validate: (r) => schemaContainsFields(r, 'score') || schemaContainsFields(r, 'threat') || schemaContainsFields(r, 'rank') },
    { id: 'posted-competitors', description: 'POSTed competitor records to skill server', points: 4, phase: 'execution', validate: (r) => postedToSkillServer(r, 'competitor') },
    { id: 'computed-scores', description: 'Response shows computed threat scores', points: 4, phase: 'execution', validate: (r) => responseContains(r, 'score') || responseContains(r, 'threat') || responseContains(r, 'rank') },
    { id: 'built-canvas', description: 'Built canvas dashboard', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 3, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'canvas-shows-rankings', description: 'Canvas displays scores or rankings', points: 3, phase: 'execution', validate: (r) => { const c = allCanvasCode(r); return c.includes('score') || c.includes('threat') || c.includes('rank') || c.includes('acme') } },
    { id: 'wrote-skill', description: 'Created a reusable skill file', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) },
    { id: 'skill-mentions-update', description: 'Skill mentions how to update with new data', points: 4, phase: 'execution', validate: (r) => wroteSkillFile(r, 'update') || wroteSkillFile(r, 'competitor') || wroteSkillFile(r, 'new') },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Canvas without doing data work first'],
}

// =========================================================================
// EVAL 3: Incident Triage from Raw Alerts
// =========================================================================

const INCIDENT_TRIAGE_MOCKS = makeSkillServerMocks(
  ['Alert', 'Incident'],
  {
    Alert: [{ message: 'High CPU', severity: 'warning', timestamp: '2026-03-25T14:02:00Z', source: 'api-server-3' }],
    Incident: [{ title: 'Database cascade failure', severity: 'critical', status: 'investigating' }],
  },
)

const INCIDENT_TRIAGE_EVAL: AgentEval = {
  id: 'adv-incident-triage',
  name: 'Advanced: Incident Triage with causal analysis',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    "We just had a bunch of alerts fire in the last hour and I need help making sense of them:",
    '',
    "1. 'Disk usage > 90% on db-primary' at 14:01 — warning",
    "2. 'High CPU on api-server-3' at 14:02 — warning",
    "3. 'High CPU on api-server-1' at 14:03 — warning",
    "4. 'Response time > 2s on /api/orders' at 14:05 — critical",
    "5. 'Database connection pool exhausted' at 14:08 — critical",
    '',
    "These feel related but I'm not sure what the actual root cause is. Can you figure out what's going on, show me a timeline, and set things up so I can do this kind of triage quickly next time something like this happens?",
  ].join('\n'),
  maxScore: 30,
  toolMocks: INCIDENT_TRIAGE_MOCKS,
  validationCriteria: [
    { id: 'wrote-schema-both', description: 'Wrote schema with Alert + Incident models', points: 4, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 2) },
    { id: 'schema-correlation-fields', description: 'Schema has severity, timestamp, and correlation fields', points: 3, phase: 'execution', validate: (r) => schemaContainsFields(r, 'severity') && (schemaContainsFields(r, 'timestamp') || schemaContainsFields(r, 'time') || schemaContainsFields(r, 'createdat') || schemaContainsFields(r, 'at')) },
    { id: 'posted-alerts', description: 'POSTed alerts to skill server', points: 4, phase: 'execution', validate: (r) => postedToSkillServer(r, 'alert') },
    { id: 'created-incident', description: 'Created at least 1 incident in skill server', points: 3, phase: 'execution', validate: (r) => postedToSkillServer(r, 'incident') },
    { id: 'root-cause-analysis', description: 'Response includes root cause or causal chain', points: 4, phase: 'execution', validate: (r) => responseContains(r, 'root cause') || responseContains(r, 'disk') || (responseContains(r, 'database') && responseContains(r, 'connection')) },
    { id: 'built-canvas-timeline', description: 'Built canvas with timeline or ordered list', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 3, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'canvas-severity', description: 'Canvas shows incident severity', points: 3, phase: 'execution', validate: (r) => { const c = allCanvasCode(r); return c.includes('critical') || c.includes('severity') || c.includes('warning') } },
    { id: 'wrote-skill', description: 'Created a reusable triage skill', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Tool loop or repeated identical calls'],
}

// =========================================================================
// EVAL 4: Email + Slack Cross-Integration Reconciliation
// =========================================================================

const NOISY_EMAILS = [
  { id: 'e1', from: 'sarah@partner.io', subject: 'RE: Integration timeline — need your sign-off', date: '2026-03-25T09:15:00Z', snippet: 'Hey, just following up on the API integration timeline. We need your approval to proceed by Friday.', labels: ['inbox'] },
  { id: 'e2', from: 'noreply@github.com', subject: '[acme/app] CI failed on main', date: '2026-03-25T09:10:00Z', snippet: 'Build #481 failed — test-unit step failed.', labels: ['notifications'] },
  { id: 'e3', from: 'newsletter@techcrunch.com', subject: 'TechCrunch Daily: AI funding hits record', date: '2026-03-25T08:00:00Z', snippet: 'AI startups raised $12B in Q1...', labels: ['promotions'] },
  { id: 'e4', from: 'dave@bigcustomer.com', subject: 'Urgent: Invoice #4521 overdue', date: '2026-03-25T07:30:00Z', snippet: 'Hi, our finance team flagged invoice #4521 as 30 days overdue. Can you look into this ASAP?', labels: ['inbox'] },
  { id: 'e5', from: 'alerts@datadog.com', subject: 'Resolved: High CPU on api-server-3', date: '2026-03-25T07:00:00Z', snippet: 'Alert has been resolved. Duration: 45m.', labels: ['notifications'] },
  { id: 'e6', from: 'marketing@competitor.com', subject: 'See what Acme Corp shipped this week', date: '2026-03-25T06:30:00Z', snippet: 'New features, product updates, and more...', labels: ['promotions'] },
  { id: 'e7', from: 'lisa@investor.vc', subject: 'Board deck review — comments attached', date: '2026-03-24T18:00:00Z', snippet: 'I reviewed the Q1 board deck. A few comments on slide 7 re: burn rate. Can we discuss before Thursday?', labels: ['inbox', 'starred'] },
  { id: 'e8', from: 'noreply@linear.app', subject: 'You were assigned ENG-445: Fix payment retry logic', date: '2026-03-24T17:00:00Z', snippet: 'Marcus assigned you ENG-445.', labels: ['notifications'] },
  { id: 'e9', from: 'receipts@aws.amazon.com', subject: 'Your AWS bill for March 2026', date: '2026-03-24T15:00:00Z', snippet: 'Amount due: $1,247.33', labels: ['receipts'] },
  { id: 'e10', from: 'noreply@zoom.us', subject: 'Cloud Recording Available: Team Sync', date: '2026-03-24T14:00:00Z', snippet: 'Your cloud recording is ready to view.', labels: ['notifications'] },
  { id: 'e11', from: 'mike@team.co', subject: 'Can you review the API spec?', date: '2026-03-24T11:00:00Z', snippet: 'Hey, I finished the v2 API spec. Would you mind reviewing it before I share with the team? No huge rush but ideally this week.', labels: ['inbox'] },
  { id: 'e12', from: 'no-reply@slack.com', subject: 'New message in #general', date: '2026-03-24T10:30:00Z', snippet: 'Alex posted in #general', labels: ['notifications'] },
  { id: 'e13', from: 'hello@substack.com', subject: 'New post from Lenny: Product-Market Fit', date: '2026-03-24T09:00:00Z', snippet: "This week's newsletter covers...", labels: ['promotions'] },
  { id: 'e14', from: 'jira@atlassian.net', subject: '5 issues updated in Sprint 23', date: '2026-03-24T08:00:00Z', snippet: 'Summary of changes...', labels: ['notifications'] },
  { id: 'e15', from: 'security@google.com', subject: 'Security alert: new sign-in from Windows', date: '2026-03-24T03:00:00Z', snippet: 'A new sign-in was detected on your account.', labels: ['notifications'] },
  { id: 'e16', from: 'priya@team.co', subject: 'Design review feedback needed', date: '2026-03-23T16:00:00Z', snippet: 'I uploaded the new mockups to Figma. Could you leave comments by EOD Wednesday?', labels: ['inbox'] },
  { id: 'e17', from: 'noreply@notion.so', subject: 'Weekly digest: 12 pages updated', date: '2026-03-23T15:00:00Z', snippet: 'See what changed in your workspace.', labels: ['notifications'] },
  { id: 'e18', from: 'support@stripe.com', subject: 'Payout completed: $8,450.00', date: '2026-03-23T12:00:00Z', snippet: 'Your payout has been initiated.', labels: ['receipts'] },
  { id: 'e19', from: 'hr@company.com', subject: 'Benefits enrollment deadline: March 31', date: '2026-03-23T10:00:00Z', snippet: 'Reminder: open enrollment ends March 31.', labels: ['inbox'] },
  { id: 'e20', from: 'noreply@vercel.com', subject: 'Deployment successful: app-prod', date: '2026-03-23T09:00:00Z', snippet: 'Your deployment completed successfully.', labels: ['notifications'] },
  { id: 'e21', from: 'alex@team.co', subject: 'Re: Q2 OKR drafts', date: '2026-03-22T17:00:00Z', snippet: 'Updated the OKR doc with your feedback. Ready for your final sign-off.', labels: ['inbox'] },
  { id: 'e22', from: 'spam@deals.shop', subject: 'HUGE SALE — 90% off everything!', date: '2026-03-22T14:00:00Z', snippet: 'Limited time offer...', labels: ['spam'] },
  { id: 'e23', from: 'calendar@google.com', subject: 'Reminder: 1:1 with Marcus tomorrow at 2pm', date: '2026-03-22T12:00:00Z', snippet: 'Google Calendar reminder', labels: ['notifications'] },
  { id: 'e24', from: 'noreply@github.com', subject: '[acme/app] Dependabot: bump express to 4.21.1', date: '2026-03-22T06:00:00Z', snippet: 'Automated security update.', labels: ['notifications'] },
  { id: 'e25', from: 'jenny@partner2.com', subject: 'Contract renewal — action needed', date: '2026-03-21T11:00:00Z', snippet: 'Our contract expires April 15. We need a signed renewal by April 1. Can you confirm?', labels: ['inbox'] },
]

const NOISY_SLACK_MESSAGES = [
  { channel: '#general', user: 'alex', text: 'Good morning everyone! ☀️', ts: '2026-03-25T09:00:00Z', type: 'message' },
  { channel: '#engineering', user: 'bot:deploybot', text: 'Deployed app-prod v2.14.3 successfully', ts: '2026-03-25T08:55:00Z', type: 'message' },
  { channel: '#engineering', user: 'marcus', text: 'Hey, has anyone looked at the flaky test-unit failures? I keep having to re-run CI on my PRs.', ts: '2026-03-25T08:50:00Z', type: 'message' },
  { channel: '#general', user: 'bot:standup', text: 'Daily standup summary: 5 team members posted updates.', ts: '2026-03-25T08:45:00Z', type: 'message' },
  { channel: '#support', user: 'sarah', text: 'Customer @BigCorp is asking about the API rate limit again. They hit 429s yesterday. This is the 3rd time this month.', ts: '2026-03-25T08:30:00Z', type: 'message' },
  { channel: '#random', user: 'bob', text: 'Has anyone tried the new coffee place on 5th? ☕', ts: '2026-03-25T08:20:00Z', type: 'message' },
  { channel: '#engineering', user: 'alice', text: "I'm blocked on the auth PR — need someone to review. It's been open for 3 days.", ts: '2026-03-25T08:15:00Z', type: 'message' },
  { channel: '#general', user: 'bot:hr', text: 'Reminder: Benefits enrollment ends March 31!', ts: '2026-03-25T08:00:00Z', type: 'message' },
  { channel: '#support', user: 'dave', text: "SmallStartup says their webhook integration stopped working after last week's update. They're losing data.", ts: '2026-03-24T17:30:00Z', type: 'message' },
  { channel: '#random', user: 'priya', text: '🎉', ts: '2026-03-24T17:00:00Z', type: 'message' },
  { channel: '#engineering', user: 'bot:github', text: 'PR #234 merged: Fix payment retry logic', ts: '2026-03-24T16:45:00Z', type: 'message' },
  { channel: '#general', user: 'mike', text: 'Team lunch tomorrow at noon — who\'s in?', ts: '2026-03-24T16:30:00Z', type: 'message' },
  { channel: '#engineering', user: 'alex', text: 'FYI: upgrading to Node 22 next week. Should be backwards compatible but heads up.', ts: '2026-03-24T15:00:00Z', type: 'message' },
  { channel: '#support', user: 'sarah', text: 'MediumCo is threatening to churn if we don\'t fix the CSV export bug by end of week.', ts: '2026-03-24T14:30:00Z', type: 'message' },
  { channel: '#random', user: 'marcus', text: 'anyone watching the game tonight?', ts: '2026-03-24T14:00:00Z', type: 'message' },
  { channel: '#general', user: 'bot:notion', text: '3 docs updated in Engineering workspace', ts: '2026-03-24T13:00:00Z', type: 'message' },
  { channel: '#engineering', user: 'priya', text: 'Can someone help me debug the SSO flow? Getting a redirect loop in staging.', ts: '2026-03-24T11:00:00Z', type: 'message' },
  { channel: '#support', user: 'dave', text: 'EnterpriseCo wants to know the ETA on SOC 2 compliance. Their security team is asking.', ts: '2026-03-24T10:00:00Z', type: 'message' },
  { channel: '#random', user: 'alice', text: 'shared a link: https://xkcd.com/927/', ts: '2026-03-24T09:30:00Z', type: 'message' },
  { channel: '#general', user: 'ceo', text: 'Great Q1 everyone — all-hands recap doc is in Notion.', ts: '2026-03-24T09:00:00Z', type: 'message' },
  { channel: '#engineering', user: 'bot:ci', text: 'CI run #480 passed on main ✅', ts: '2026-03-24T08:05:00Z', type: 'message' },
  { channel: '#engineering', user: 'bob', text: 'joined #engineering', ts: '2026-03-24T08:00:00Z', type: 'channel_join' },
  { channel: '#support', user: 'jenny', text: 'Quick win: TinyStartup loves the new onboarding flow. They said "best setup experience we\'ve had"!', ts: '2026-03-23T17:00:00Z', type: 'message' },
  { channel: '#general', user: 'bot:standup', text: 'Daily standup summary: 6 team members posted updates.', ts: '2026-03-23T08:45:00Z', type: 'message' },
  { channel: '#random', user: 'mike', text: 'Friday vibes 🎶', ts: '2026-03-23T08:30:00Z', type: 'message' },
  { channel: '#engineering', user: 'marcus', text: 'The e2e tests are timing out again on CI. Might be a flaky Playwright issue.', ts: '2026-03-22T16:00:00Z', type: 'message' },
  { channel: '#support', user: 'sarah', text: 'FYI: 3 customers reported slow load times in EU region today.', ts: '2026-03-22T14:00:00Z', type: 'message' },
  { channel: '#general', user: 'bot:calendar', text: 'Upcoming: Team Retro on Friday 3pm', ts: '2026-03-22T10:00:00Z', type: 'message' },
  { channel: '#random', user: 'alex', text: 'PSA: the office AC is fixed 🎉🎉🎉', ts: '2026-03-22T09:00:00Z', type: 'message' },
  { channel: '#engineering', user: 'alice', text: "merged the dashboard refactor. let me know if anything looks off.", ts: '2026-03-21T17:00:00Z', type: 'message' },
]

const EMAIL_SLACK_RECON_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['ActionItem'], {
    ActionItem: [{ title: 'Review API spec', source: 'email', requester: 'mike', urgency: 'medium' }],
  }),
  tool_search: {
    type: 'pattern',
    description: 'Search for tools.',
    paramKeys: ['query', 'limit'],
    patterns: [
      { match: { query: 'gmail' }, response: { query: 'gmail', results: [{ name: 'gmail', description: 'Gmail — managed OAuth integration. Read and send emails.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s). Use tool_install to add one.' } },
      { match: { query: 'email' }, response: { query: 'email', results: [{ name: 'gmail', description: 'Gmail — managed OAuth integration. Read and send emails.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s). Use tool_install to add one.' } },
      { match: { query: 'slack' }, response: { query: 'slack', results: [{ name: 'slack', description: 'Slack — managed OAuth integration. Read and send messages.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s). Use tool_install to add one.' } },
    ],
    default: { query: 'communication', results: [{ name: 'gmail', description: 'Gmail — managed OAuth.', source: 'managed', authType: 'oauth' }, { name: 'slack', description: 'Slack — managed OAuth.', source: 'managed', authType: 'oauth' }], message: 'Found 2 tool(s).' },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool.',
    paramKeys: ['name'],
    patterns: [
      { match: { name: 'gmail' }, response: { ok: true, server: 'composio', integration: 'gmail', toolCount: 2, connected: true, authStatus: 'active', tools: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'], message: 'Installed gmail with 2 tool(s).' } },
      { match: { name: 'slack' }, response: { ok: true, server: 'composio', integration: 'slack', toolCount: 2, connected: true, authStatus: 'active', tools: ['SLACK_LIST_MESSAGES', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL'], message: 'Installed slack with 2 tool(s).' } },
    ],
    default: { ok: true, connected: true, authStatus: 'active', tools: [], message: 'Installed.' },
  },
  GMAIL_FETCH_EMAILS: {
    type: 'static',
    description: 'Fetch recent emails from Gmail.',
    paramKeys: ['max_results', 'query'],
    response: { emails: NOISY_EMAILS, total: NOISY_EMAILS.length },
  },
  SLACK_LIST_MESSAGES: {
    type: 'static',
    description: 'List recent messages from Slack channels.',
    paramKeys: ['channel', 'limit'],
    response: { messages: NOISY_SLACK_MESSAGES, total: NOISY_SLACK_MESSAGES.length },
  },
}

const EMAIL_SLACK_RECON_EVAL: AgentEval = {
  id: 'adv-email-slack-reconciliation',
  name: 'Advanced: Email + Slack action item reconciliation',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: "I've been losing track of things that need my attention across email and Slack. Can you pull my recent emails and Slack messages and figure out which things are actually urgent or waiting on me? There's a lot of noise — I want to see just the actionable items, who's waiting, and how long they've been waiting. Set it up so I can check this regularly.",
  maxScore: 30,
  toolMocks: EMAIL_SLACK_RECON_MOCKS,
  validationCriteria: [
    { id: 'used-tool-search', description: 'Used tool_search to discover integrations', points: 2, phase: 'intention', validate: (r) => usedTool(r, 'tool_search') },
    { id: 'installed-integrations', description: 'Installed Gmail and Slack via tool_install before using them', points: 2, phase: 'intention', validate: (r) => installedIntegration(r, 'gmail') && installedIntegration(r, 'slack') },
    { id: 'called-both', description: 'Called both Gmail and Slack integration tools', points: 4, phase: 'execution', validate: (r) => usedTool(r, 'GMAIL_FETCH_EMAILS') && usedTool(r, 'SLACK_LIST_MESSAGES') },
    { id: 'wrote-schema', description: 'Wrote schema.prisma with action-item model', points: 3, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 1) },
    { id: 'schema-fields', description: 'Schema has source, urgency, requester fields', points: 3, phase: 'execution', validate: (r) => schemaContainsFields(r, 'source') || (schemaContainsFields(r, 'urgency') || schemaContainsFields(r, 'priority')) },
    { id: 'posted-filtered', description: 'POSTed filtered data to skill server', points: 4, phase: 'execution', validate: (r) => postedToSkillServer(r) },
    { id: 'built-canvas', description: 'Built canvas with prioritized view', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 3, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'canvas-urgency', description: 'Canvas distinguishes urgency or sources', points: 3, phase: 'execution', validate: (r) => { const c = allCanvasCode(r); return c.includes('urgent') || c.includes('priority') || c.includes('email') || c.includes('slack') || c.includes('action') } },
    { id: 'wrote-skill', description: 'Created a reusable skill file', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Tool loop or repeated identical calls'],
}

// =========================================================================
// EVAL 5: Self-Healing Data Pipeline
// =========================================================================

const BROKEN_SCRIPT = `import csv
import json
from collections import defaultdict

def process_sales(input_file, output_file):
    """Read sales CSV, aggregate by region and product, write JSON summary."""
    totals_by_region = defaultdict(float)
    totals_by_product = defaultdict(float)
    row_count = 0

    with open(input_file, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            region = row['region']
            product = row['product']
            revenue = float(row['revenue'])

            totals_by_region[region] += revenue
            totals_by_product[product] += revenue
            row_count += 1

    summary = {
        'total_rows': row_count,
        'total_revenue': sum(totals_by_region.values()),
        'by_region': dict(totals_by_region),
        'by_product': dict(totals_by_product),
    }

    with open(output_file, 'w') as f:
        json.dump(summary, f, indent=2)

    print(f"Processed {row_count} rows. Total revenue: \${summary['total_revenue']:,.2f}")
    return summary

if __name__ == '__main__':
    process_sales('sales_data.csv', 'sales_summary.json')
`

const NOISY_CSV_HEADER = 'date,region,product,total_revenue,discount,units_sold'
const NOISY_CSV_ROWS = [
  '2026-03-01,North America,Widget Pro,15000.00,500.00,120',
  '2026-03-01,Europe,Widget Pro,12000.00,300.00,95',
  '2026-03-01,Asia Pacific,Widget Basic,8000.00,200.00,200',
  '2026-03-02,North America,Widget Basic,6500.00,150.00,180',
  '2026-03-02,Europe,Widget Enterprise,45000.00,2000.00,15',
  '2026-03-03, North America ,Widget Pro,14500.00,450.00,115',
  '2026-03-03,Europe,Widget Basic,7200.00,180.00,190',
  '2026-03-04,Asia Pacific,Widget Enterprise,38000.00,1500.00,12',
  '2026-03-04,North America,Widget Pro,16000.00,600.00,130',
  '2026-03-05,Europe,Widget Pro,11500.00,280.00,90',
  '2026-03-05,Asia Pacific,Widget Basic,7800.00,190.00,195',
  '2026-03-06,North America,Widget Enterprise,52000.00,2500.00,18',
  '2026-03-06,Europe,Widget Basic,6800.00,,175',
  '2026-03-07,Asia Pacific,Widget Pro,13200.00,350.00,105',
  '2026-03-07,North America,Widget Basic,5900.00,140.00,165',
  'March 8,Europe,Widget Enterprise,41000.00,1800.00,14',
  '2026-03-08,Asia Pacific,Widget Basic,8200.00,210.00,205',
  '2026-03-09,North America,Widget Pro,15500.00,520.00,125',
  '2026-03-09, Europe,Widget Pro,12200.00,310.00,97',
  '2026-03-10,Asia Pacific,Widget Enterprise,39000.00,1600.00,13',
  '2026-03-10,North America,Widget Basic,6300.00,,170',
  '2026-03-11,Europe,Widget Basic,7100.00,175.00,188',
  '2026-03-11,Asia Pacific,Widget Pro,13500.00,360.00,108',
  '2026-03-12,North America,Widget Enterprise,48000.00,2200.00,16',
  '2026-03-12,Europe,Widget Pro,11800.00,290.00,92',
  '2026-03-01,North America,Widget Pro,15000.00,500.00,120',
  '2026-03-06,Europe,Widget Basic,6800.00,,175',
  'March 15,Asia Pacific,Widget Basic,8500.00,220.00,210',
  '2026-03-13,North America,Widget Pro,15200.00,480.00,122',
  '2026-03-13,Europe,Widget Basic,6900.00,165.00,180',
  '2026-03-14,Asia Pacific,Widget Enterprise,40000.00,-1200.00,14',
  '2026-03-14, North America ,Widget Basic,6100.00,145.00,168',
  '2026-03-15,Europe,Widget Pro,12500.00,320.00,100',
  '2026-03-15,Asia Pacific,Widget Basic,7600.00,185.00,192',
  '2026-03-16,North America,Widget Enterprise,50000.00,2400.00,17',
  '2026-03-16,Europe,Widget Basic,7300.00,180.00,185',
  '2026-03-17,Asia Pacific,Widget Pro,13800.00,370.00,110',
  '2026-03-17,North America,Widget Basic,6200.00,,167',
  '2026-03-18,Europe,Widget Enterprise,43000.00,1900.00,15',
  '2026-03-18,Asia Pacific,Widget Basic,8100.00,205.00,202',
  '2026-03-19,North America,Widget Pro,15800.00,540.00,128',
  '2026-03-14,Asia Pacific,Widget Enterprise,40000.00,-1200.00,14',
  'March 20,Europe,Widget Pro,12800.00,330.00,102',
  '2026-03-20,Asia Pacific,Widget Basic,7900.00,195.00,198',
  '2026-03-21,North America,Widget Enterprise,51000.00,2300.00,17',
  '2026-03-21,Europe,Widget Basic,7400.00,182.00,187',
  '2026-03-22, Asia Pacific ,Widget Pro,14000.00,380.00,112',
  '2026-03-22,North America,Widget Basic,6400.00,155.00,172',
  '2026-03-23,Europe,Widget Enterprise,44000.00,2000.00,15',
  '2026-03-23,Asia Pacific,Widget Basic,,215.00,208',
]

const DATA_PIPELINE_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['SalesSummary'], {
    SalesSummary: [{ region: 'North America', product: 'Widget Pro', totalRevenue: 15000, rowCount: 1 }],
  }),
}

const DATA_PIPELINE_EVAL: AgentEval = {
  id: 'adv-self-healing-pipeline',
  name: 'Advanced: Self-healing data pipeline diagnosis and fix',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  input: "I have a script that processes our weekly sales data but it broke. Here's the script and the latest data file. It was working fine last month but now it crashes. I still need this week's numbers — can you figure out what went wrong, fix it, get me the results, and make sure it won't break like this again?",
  workspaceFiles: {
    'config.json': V2_CONFIG,
    'process_sales.py': BROKEN_SCRIPT,
    'sales_data.csv': [NOISY_CSV_HEADER, ...NOISY_CSV_ROWS].join('\n'),
  },
  maxScore: 30,
  toolMocks: DATA_PIPELINE_MOCKS,
  validationCriteria: [
    { id: 'read-script', description: 'Read the script before editing', points: 3, phase: 'execution', validate: (r) => readFileBeforeEdit(r, 'process_sales') },
    { id: 'edited-script', description: 'Edited process_sales.py (not full rewrite)', points: 3, phase: 'execution', validate: (r) => toolCallArgsContain(r, 'edit_file', 'process_sales') },
    { id: 'fix-column-rename', description: 'Fix addresses the revenue → total_revenue rename', points: 3, phase: 'execution', validate: (r) => { const edits = r.toolCalls.filter(t => t.name === 'edit_file' || t.name === 'write_file'); const json = JSON.stringify(edits.map(t => t.input)).toLowerCase(); return json.includes('total_revenue') } },
    { id: 'ran-script', description: 'Ran the fixed script via exec', points: 4, phase: 'execution', validate: (r) => r.toolCalls.some(t => t.name === 'exec' && String((t.input as any).command ?? '').includes('python')) },
    { id: 'wrote-schema', description: 'Wrote schema.prisma for results', points: 3, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 1) },
    { id: 'posted-data', description: 'POSTed aggregated data to skill server', points: 4, phase: 'execution', validate: (r) => postedToSkillServer(r) },
    { id: 'built-canvas', description: 'Built canvas showing sales metrics', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 4, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'wrote-skill', description: 'Created a reusable skill or mentioned recurring execution', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) || responseContains(r, 'recurring') || responseContains(r, 'schedule') || responseContains(r, 'heartbeat') || responseContains(r, 'cron') },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Tool loop or repeated identical calls'],
}

// =========================================================================
// EVAL 6: Multi-Source Intelligence Briefing
// =========================================================================

const NOISY_GITHUB_ACTIVITY = [
  { type: 'commit', sha: 'a1b2c3d', message: 'feat: implement SSO login flow', author: 'alice', date: '2026-03-24T16:00:00Z' },
  { type: 'commit', sha: 'e4f5g6h', message: 'fix typo in README', author: 'bob', date: '2026-03-24T15:30:00Z' },
  { type: 'commit', sha: 'i7j8k9l', message: 'bump express to 4.21.1', author: 'dependabot', date: '2026-03-24T15:00:00Z' },
  { type: 'commit', sha: 'm1n2o3p', message: 'feat: add real-time notifications', author: 'marcus', date: '2026-03-24T14:00:00Z' },
  { type: 'commit', sha: 'q4r5s6t', message: 'chore: update lockfile', author: 'dependabot', date: '2026-03-24T13:00:00Z' },
  { type: 'commit', sha: 'u7v8w9x', message: 'fix: payment retry logic for failed charges', author: 'marcus', date: '2026-03-23T17:00:00Z' },
  { type: 'commit', sha: 'y1z2a3b', message: 'chore: lint fixes', author: 'alice', date: '2026-03-23T16:30:00Z' },
  { type: 'commit', sha: 'c4d5e6f', message: 'feat: CSV export for analytics', author: 'priya', date: '2026-03-23T15:00:00Z' },
  { type: 'commit', sha: 'g7h8i9j', message: 'fix typo in error message', author: 'bob', date: '2026-03-23T14:00:00Z' },
  { type: 'commit', sha: 'k1l2m3n', message: 'chore: update CI config', author: 'alex', date: '2026-03-23T12:00:00Z' },
  { type: 'commit', sha: 'o4p5q6r', message: 'feat: webhook retry with exponential backoff', author: 'alex', date: '2026-03-22T16:00:00Z' },
  { type: 'commit', sha: 's7t8u9v', message: 'chore: bump typescript to 5.8', author: 'dependabot', date: '2026-03-22T10:00:00Z' },
  { type: 'commit', sha: 'w1x2y3z', message: 'fix: handle null discount in invoice calc', author: 'marcus', date: '2026-03-22T09:00:00Z' },
  { type: 'commit', sha: 'aa1bb2c', message: 'docs: update API changelog', author: 'mike', date: '2026-03-21T17:00:00Z' },
  { type: 'commit', sha: 'dd3ee4f', message: 'chore: remove unused imports', author: 'alice', date: '2026-03-21T15:00:00Z' },
  { type: 'commit', sha: 'gg5hh6i', message: 'feat: EU data residency support', author: 'alex', date: '2026-03-21T14:00:00Z' },
  { type: 'commit', sha: 'jj7kk8l', message: 'fix version in package.json', author: 'bob', date: '2026-03-21T11:00:00Z' },
  { type: 'commit', sha: 'mm9nn0o', message: 'chore: prettier format', author: 'bob', date: '2026-03-21T10:00:00Z' },
  { type: 'commit', sha: 'pp1qq2r', message: 'feat: admin dashboard redesign', author: 'priya', date: '2026-03-20T16:00:00Z' },
  { type: 'commit', sha: 'ss3tt4u', message: 'chore: update test fixtures', author: 'marcus', date: '2026-03-20T14:00:00Z' },
  { type: 'pr', number: 234, title: 'Fix payment retry logic', state: 'merged', author: 'marcus', merged_at: '2026-03-24T16:45:00Z' },
  { type: 'pr', number: 231, title: 'Add SSO login flow', state: 'merged', author: 'alice', merged_at: '2026-03-24T16:30:00Z' },
  { type: 'pr', number: 229, title: 'CSV export for analytics', state: 'merged', author: 'priya', merged_at: '2026-03-23T16:00:00Z' },
  { type: 'pr', number: 227, title: 'Bump express to 4.21.1', state: 'merged', author: 'dependabot', merged_at: '2026-03-24T15:10:00Z' },
  { type: 'pr', number: 225, title: 'Webhook retry with backoff', state: 'merged', author: 'alex', merged_at: '2026-03-22T17:00:00Z' },
  { type: 'pr', number: 223, title: 'EU data residency', state: 'merged', author: 'alex', merged_at: '2026-03-21T15:00:00Z' },
  { type: 'pr', number: 221, title: 'Admin dashboard redesign', state: 'merged', author: 'priya', merged_at: '2026-03-20T17:00:00Z' },
  { type: 'pr', number: 220, title: 'Update lockfile', state: 'merged', author: 'dependabot', merged_at: '2026-03-20T10:00:00Z' },
  { type: 'issue', number: 445, title: 'Fix payment retry logic', state: 'closed', closed_at: '2026-03-24T16:45:00Z' },
  { type: 'issue', number: 440, title: 'SSO redirect loop in staging', state: 'open' },
  { type: 'issue', number: 438, title: 'API rate limit too aggressive', state: 'open' },
  { type: 'issue', number: 435, title: 'CSV export missing headers', state: 'closed', closed_at: '2026-03-23T16:00:00Z' },
  { type: 'issue', number: 430, title: 'Webhook delivery failures', state: 'closed', closed_at: '2026-03-22T17:00:00Z' },
  { type: 'issue', number: 425, title: 'EU data residency requirement', state: 'closed', closed_at: '2026-03-21T15:00:00Z' },
  { type: 'issue', number: 420, title: 'Admin dashboard slow for large datasets', state: 'closed', closed_at: '2026-03-20T17:00:00Z' },
]

const NOISY_INVESTOR_EMAILS = [
  { id: 'b1', from: 'lisa@investor.vc', subject: 'Board deck review — comments attached', date: '2026-03-24T18:00:00Z', snippet: 'I reviewed the Q1 board deck. A few comments on slide 7 re: burn rate. Can we discuss before Thursday?' },
  { id: 'b2', from: 'noreply@github.com', subject: '[acme/app] PR #234 merged', date: '2026-03-24T16:50:00Z', snippet: 'Fix payment retry logic merged by marcus.' },
  { id: 'b3', from: 'newsletter@techcrunch.com', subject: 'TechCrunch Daily', date: '2026-03-24T08:00:00Z', snippet: 'AI startups raised $12B...' },
  { id: 'b4', from: 'mark@sequoia.com', subject: 'RE: Series B timeline', date: '2026-03-23T20:00:00Z', snippet: 'Thanks for the update. We\'re targeting a term sheet by mid-April. Will need updated financials by April 5.' },
  { id: 'b5', from: 'alerts@datadog.com', subject: 'Alert: High latency on /api/orders', date: '2026-03-23T14:05:00Z', snippet: 'Response time exceeded 2s threshold.' },
  { id: 'b6', from: 'hello@substack.com', subject: 'New post from Lenny', date: '2026-03-23T09:00:00Z', snippet: 'Product-Market Fit...' },
  { id: 'b7', from: 'sarah@partner.io', subject: 'Integration launch date confirmed', date: '2026-03-22T17:00:00Z', snippet: 'We\'re good to launch the integration on April 1. Marketing materials are ready on our end.' },
  { id: 'b8', from: 'noreply@linear.app', subject: 'ENG-445 assigned to you', date: '2026-03-22T15:00:00Z', snippet: 'Marcus assigned you.' },
  { id: 'b9', from: 'receipts@aws.amazon.com', subject: 'AWS bill for March', date: '2026-03-22T12:00:00Z', snippet: '$1,247.33' },
  { id: 'b10', from: 'noreply@zoom.us', subject: 'Cloud Recording Available', date: '2026-03-22T11:00:00Z', snippet: 'Recording ready.' },
  { id: 'b11', from: 'david@bigcustomer.com', subject: 'Great experience with onboarding', date: '2026-03-22T10:00:00Z', snippet: 'Just wanted to say the new onboarding flow is fantastic. Exactly what we needed.' },
  { id: 'b12', from: 'marketing@competitor.com', subject: 'See what Acme shipped', date: '2026-03-22T06:00:00Z', snippet: 'New features, product updates...' },
  { id: 'b13', from: 'noreply@notion.so', subject: 'Weekly digest', date: '2026-03-21T15:00:00Z', snippet: '12 pages updated.' },
  { id: 'b14', from: 'security@google.com', subject: 'New sign-in detected', date: '2026-03-21T03:00:00Z', snippet: 'New sign-in from Windows.' },
  { id: 'b15', from: 'lisa@investor.vc', subject: 'Intro to potential enterprise customer', date: '2026-03-20T14:00:00Z', snippet: 'Connecting you with Maria at EnterpriseCo. They\'re looking for exactly what you\'re building.' },
  { id: 'b16', from: 'spam@deals.shop', subject: 'HUGE SALE', date: '2026-03-20T08:00:00Z', snippet: '90% off...' },
  { id: 'b17', from: 'noreply@github.com', subject: 'Dependabot: bump express', date: '2026-03-20T06:00:00Z', snippet: 'Automated security update.' },
  { id: 'b18', from: 'hr@company.com', subject: 'Benefits enrollment reminder', date: '2026-03-19T10:00:00Z', snippet: 'Open enrollment ends March 31.' },
  { id: 'b19', from: 'calendar@google.com', subject: 'Reminder: Board meeting March 26', date: '2026-03-19T09:00:00Z', snippet: 'Google Calendar reminder.' },
  { id: 'b20', from: 'noreply@vercel.com', subject: 'Deployment successful', date: '2026-03-19T08:00:00Z', snippet: 'app-prod deployed.' },
]

const BRIEFING_SLACK = [
  { channel: '#support', user: 'sarah', text: 'Customer @BigCorp hitting API rate limits again — 3rd time this month. They\'re not happy.', ts: '2026-03-25T08:30:00Z' },
  { channel: '#general', user: 'bot:standup', text: 'Daily standup summary: 5 team members posted updates.', ts: '2026-03-25T08:45:00Z' },
  { channel: '#random', user: 'bob', text: 'Anyone tried the new coffee place on 5th? ☕', ts: '2026-03-25T08:20:00Z' },
  { channel: '#support', user: 'dave', text: 'SmallStartup says webhooks stopped working after last week\'s update. They\'re losing event data.', ts: '2026-03-24T17:30:00Z' },
  { channel: '#engineering', user: 'bot:ci', text: 'CI run #480 passed on main ✅', ts: '2026-03-24T08:05:00Z' },
  { channel: '#random', user: 'priya', text: '🎉', ts: '2026-03-24T17:00:00Z' },
  { channel: '#support', user: 'sarah', text: 'MediumCo threatening to churn over CSV export bug. Need fix by EOW.', ts: '2026-03-24T14:30:00Z' },
  { channel: '#general', user: 'mike', text: 'Team lunch tomorrow at noon — who\'s in?', ts: '2026-03-24T16:30:00Z' },
  { channel: '#engineering', user: 'marcus', text: 'flaky test-unit failures on CI are getting worse. 4th time this week I had to re-run.', ts: '2026-03-25T08:50:00Z' },
  { channel: '#general', user: 'bot:hr', text: 'Reminder: Benefits enrollment ends March 31!', ts: '2026-03-25T08:00:00Z' },
  { channel: '#support', user: 'jenny', text: 'TinyStartup LOVES the new onboarding: "best setup experience we\'ve had". 🎉', ts: '2026-03-23T17:00:00Z' },
  { channel: '#engineering', user: 'bot:github', text: 'PR #234 merged: Fix payment retry logic', ts: '2026-03-24T16:45:00Z' },
  { channel: '#random', user: 'marcus', text: 'anyone watching the game tonight?', ts: '2026-03-24T14:00:00Z' },
  { channel: '#general', user: 'bot:notion', text: '3 docs updated in Engineering workspace', ts: '2026-03-24T13:00:00Z' },
  { channel: '#support', user: 'sarah', text: '3 customers reported slow load times in EU region today.', ts: '2026-03-22T14:00:00Z' },
  { channel: '#general', user: 'ceo', text: 'Great Q1 everyone — all-hands recap doc is in Notion.', ts: '2026-03-24T09:00:00Z' },
  { channel: '#random', user: 'alice', text: 'shared a link: https://xkcd.com/927/', ts: '2026-03-24T09:30:00Z' },
  { channel: '#support', user: 'dave', text: 'EnterpriseCo asking about SOC 2 timeline. Their security team needs an answer.', ts: '2026-03-24T10:00:00Z' },
  { channel: '#engineering', user: 'alice', text: 'merged the dashboard refactor. let me know if anything looks off.', ts: '2026-03-21T17:00:00Z' },
  { channel: '#random', user: 'alex', text: 'PSA: the office AC is fixed 🎉🎉🎉', ts: '2026-03-22T09:00:00Z' },
  { channel: '#general', user: 'bot:calendar', text: 'Upcoming: Team Retro on Friday 3pm', ts: '2026-03-22T10:00:00Z' },
  { channel: '#engineering', user: 'alex', text: 'FYI: upgrading to Node 22 next week. Backwards compatible but heads up.', ts: '2026-03-24T15:00:00Z' },
  { channel: '#support', user: 'dave', text: 'Update: SmallStartup webhook issue was from the backoff change. Alex is looking into it.', ts: '2026-03-25T09:00:00Z' },
  { channel: '#general', user: 'bot:standup', text: 'Daily standup summary: 6 team members posted.', ts: '2026-03-23T08:45:00Z' },
  { channel: '#random', user: 'mike', text: 'Friday vibes 🎶', ts: '2026-03-23T08:30:00Z' },
]

const BRIEFING_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['BriefingItem'], {
    BriefingItem: [{ category: 'engineering', title: 'SSO login shipped', source: 'github' }],
  }),
  tool_search: {
    type: 'pattern',
    description: 'Search for tools.',
    paramKeys: ['query', 'limit'],
    patterns: [
      { match: { query: 'github' }, response: { query: 'github', results: [], message: 'No managed integrations found for "github". For developer tools like GitHub, use the CLI (e.g. `gh`) directly via exec.' } },
      { match: { query: 'gmail' }, response: { query: 'gmail', results: [{ name: 'gmail', description: 'Gmail — managed OAuth.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' } },
      { match: { query: 'email' }, response: { query: 'email', results: [{ name: 'gmail', description: 'Gmail — managed OAuth.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' } },
      { match: { query: 'slack' }, response: { query: 'slack', results: [{ name: 'slack', description: 'Slack — managed OAuth.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' } },
    ],
    default: { query: 'communication', results: [{ name: 'gmail', description: 'Gmail — managed OAuth.', source: 'managed', authType: 'oauth' }, { name: 'slack', description: 'Slack — managed OAuth.', source: 'managed', authType: 'oauth' }], message: 'Found 2 tool(s).' },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool.',
    paramKeys: ['name'],
    patterns: [
      { match: { name: 'github' }, response: { ok: false, error: 'No managed integration available for "github". Use the gh CLI instead.' } },
      { match: { name: 'gmail' }, response: { ok: true, server: 'composio', integration: 'gmail', toolCount: 1, connected: true, authStatus: 'active', tools: ['GMAIL_FETCH_EMAILS'], message: 'Installed gmail.' } },
      { match: { name: 'slack' }, response: { ok: true, server: 'composio', integration: 'slack', toolCount: 1, connected: true, authStatus: 'active', tools: ['SLACK_LIST_MESSAGES'], message: 'Installed slack.' } },
    ],
    default: { ok: false, error: 'No managed integration available. For developer tools, use the CLI directly.' },
  },
  GMAIL_FETCH_EMAILS: { type: 'static', description: 'Fetch emails.', paramKeys: ['max_results', 'query'], response: { emails: NOISY_INVESTOR_EMAILS, total: NOISY_INVESTOR_EMAILS.length } },
  SLACK_LIST_MESSAGES: { type: 'static', description: 'List Slack messages.', paramKeys: ['channel', 'limit'], response: { messages: BRIEFING_SLACK, total: BRIEFING_SLACK.length } },
}

const BRIEFING_EVAL: AgentEval = {
  id: 'adv-multi-source-briefing',
  name: 'Advanced: Multi-source board meeting briefing',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  input: "I have a board meeting tomorrow morning and I need to get up to speed fast. Can you pull together what's been happening this past week? I exported our recent GitHub activity to github_activity.json in the workspace. Use Gmail for investor/partner communications and Slack for customer and team chatter. I need to know what our dev team shipped, any important investor or partner communications, and what customers have been saying. Store everything in a skill server so I can regenerate this before the next board meeting, and build me a React briefing dashboard I can quickly review tonight.",
  workspaceFiles: {
    'config.json': V2_CONFIG,
    'github_activity.json': JSON.stringify(NOISY_GITHUB_ACTIVITY, null, 2),
  },
  maxScore: 30,
  toolMocks: BRIEFING_MOCKS,
  validationCriteria: [
    { id: 'read-github-data', description: 'Read the exported GitHub activity data', points: 2, phase: 'intention', validate: (r) => r.toolCalls.some(t => t.name === 'read_file' && String((t.input as any).path ?? '').includes('github_activity')) },
    { id: 'installed-email-slack', description: 'Installed Gmail and/or Slack via tool_install', points: 2, phase: 'intention', validate: (r) => installedIntegration(r, 'gmail') || installedIntegration(r, 'slack') },
    { id: 'used-all-three', description: 'Read GitHub file + used Gmail + Slack integrations', points: 4, phase: 'execution', validate: (r) => r.toolCalls.some(t => t.name === 'read_file' && String((t.input as any).path ?? '').includes('github')) && usedTool(r, 'GMAIL_FETCH_EMAILS') && usedTool(r, 'SLACK_LIST_MESSAGES') },
    { id: 'wrote-schema', description: 'Wrote schema for briefing data', points: 3, phase: 'execution', validate: (r) => wroteSchemaWithAnyModels(r, 1) },
    { id: 'posted-filtered', description: 'POSTed filtered/categorized data to skill server', points: 3, phase: 'execution', validate: (r) => postedToSkillServer(r) },
    { id: 'organized-by-category', description: 'Response organizes by category (dev/investors/customers)', points: 4, phase: 'execution', validate: (r) => { const t = r.responseText.toLowerCase(); const cats = [t.includes('engineer') || t.includes('ship') || t.includes('dev'), t.includes('investor') || t.includes('board') || t.includes('fund'), t.includes('customer') || t.includes('support') || t.includes('churn')]; return cats.filter(Boolean).length >= 2 } },
    { id: 'built-canvas', description: 'Built structured briefing canvas', points: 3, phase: 'execution', validate: (r) => wroteCanvasFile(r) },
    { id: 'canvas-wired', description: 'Canvas fetches data from skill server API', points: 3, phase: 'execution', validate: (r) => canvasFetchesFromApi(r) },
    { id: 'canvas-details', description: 'Canvas has specific details (names, features, issues)', points: 3, phase: 'execution', validate: (r) => { const c = allCanvasCode(r); return (c.includes('sso') || c.includes('payment') || c.includes('csv') || c.includes('investor') || c.includes('bigcorp') || c.includes('churn')) } },
    { id: 'wrote-skill', description: 'Created reusable briefing skill', points: 3, phase: 'execution', validate: (r) => wroteSkillFile(r) },
  ],
  antiPatterns: ['Unnecessary clarification questions instead of building', 'Tool loop or repeated identical calls'],
}

// =========================================================================
// EVAL 7: No Custom Server — Agent Must Use Skill Server
// =========================================================================

// ---------------------------------------------------------------------------
// Shared anti-pattern helpers for custom server detection
// ---------------------------------------------------------------------------

/** True if the agent wrote .shogo/server/custom-routes.ts (the approved convention). */
function wroteCustomRoutes(r: EvalResult): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .some(t => {
      const path = String((t.input as any).path ?? '').toLowerCase()
      return /\.shogo\/server\/custom-routes\.tsx?$/.test(path) || path === 'custom-routes.ts' || path === 'custom-routes.tsx'
    })
}

/** Content of the custom-routes file (if written). */
function customRoutesCode(r: EvalResult): string {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '').toLowerCase()
      return /custom-routes\.tsx?$/.test(path)
    })
    .map(t => String((t.input as any).content ?? (t.input as any).new_string ?? ''))
    .join('\n')
    .toLowerCase()
}

/** True if the agent wrote a custom server file (server.ts, server.tsx, etc.) at the project root. */
function wroteCustomServer(r: EvalResult): boolean {
  return r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .some(t => {
      const path = String((t.input as any).path ?? '').toLowerCase()
      return /^server\.(ts|tsx|js|mjs)$/.test(path) ||
        /^src\/server\.(ts|tsx|js|mjs)$/.test(path) ||
        /^api\/.*\.(ts|tsx|js|mjs)$/.test(path)
    })
}

/** True if any written file (excluding custom-routes.ts) imports Hono, Express, Fastify, or Koa. */
function wroteCustomHttpServer(r: EvalResult): boolean {
  const allCode = r.toolCalls
    .filter(t => t.name === 'write_file' || t.name === 'edit_file')
    .filter(t => {
      const path = String((t.input as any).path ?? '').toLowerCase()
      return !/custom-routes\.tsx?$/.test(path)
    })
    .map(t => {
      const input = t.input as Record<string, any>
      return String(input.content ?? input.new_string ?? '')
    })
    .join('\n')
    .toLowerCase()
  return /import.*from\s+['"]hono['"]/.test(allCode) ||
    /import.*from\s+['"]express['"]/.test(allCode) ||
    /import.*from\s+['"]fastify['"]/.test(allCode) ||
    /import.*from\s+['"]koa['"]/.test(allCode) ||
    /require\(['"]express['"]\)/.test(allCode) ||
    /new hono\b/.test(allCode) ||
    /bun\.serve\b/.test(allCode)
}

/** True if canvas code uses the Integration Tools SDK (useTools / ToolsClient). */
function canvasUsesToolsSdk(r: EvalResult): boolean {
  const code = allCanvasCode(r)
  return code.includes('usetools') || code.includes('toolsclient') || code.includes('@shogo-ai/sdk/tools')
}

/** True if canvas code calls a specific integration tool via execute(). */
function canvasExecutesTool(r: EvalResult, toolPrefix: string): boolean {
  const code = allCanvasCode(r)
  return code.includes(`execute('${toolPrefix}`) || code.includes(`execute("${toolPrefix}`)
}

// =========================================================================
// EVAL 7a: External API Integration — Use Tools SDK, Not Custom Server
// Reproduces the real bug: user needs Meta Ads data in dashboard, agent
// should use useTools()/execute() from @shogo-ai/sdk/tools, NOT create
// a custom Hono server to proxy the Facebook Graph API.
// =========================================================================

const META_ADS_INTEGRATION_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['Campaign'], {
    Campaign: [{ name: 'Summer Sale Push', platform: 'meta', budget: 5000, spend: 3200, impressions: 450000, clicks: 12500, conversions: 380, status: 'active' }],
  }),
  tool_search: {
    type: 'static',
    response: {
      results: [
        { name: 'meta_ads', displayName: 'Meta Ads', description: 'Manage Facebook and Instagram ad campaigns', installed: true },
      ],
    },
  },
  tool_install: {
    type: 'static',
    response: {
      ok: true,
      tools: [
        { name: 'METAADS_GET_INSIGHTS', description: 'Get ad insights and performance metrics' },
        { name: 'METAADS_LIST_CAMPAIGNS', description: 'List all campaigns in an ad account' },
        { name: 'METAADS_UPDATE_CAMPAIGN', description: 'Update campaign status or budget' },
      ],
    },
  },
  METAADS_GET_INSIGHTS: {
    type: 'static',
    response: {
      ok: true,
      data: JSON.stringify({
        data: [
          { campaign_name: 'Summer Sale Push', spend: '3200.00', impressions: '450000', clicks: '12500', conversions: '380', cpc: '0.26', ctr: '2.78', date_start: '2026-03-01', date_stop: '2026-03-31' },
          { campaign_name: 'Brand Awareness Q2', spend: '6100.00', impressions: '890000', clicks: '15000', conversions: '210', cpc: '0.41', ctr: '1.69', date_start: '2026-03-01', date_stop: '2026-03-31' },
        ],
      }),
    },
  },
  METAADS_LIST_CAMPAIGNS: {
    type: 'static',
    response: {
      ok: true,
      data: JSON.stringify({
        data: [
          { id: 'camp_1', name: 'Summer Sale Push', status: 'ACTIVE', daily_budget: '500' },
          { id: 'camp_2', name: 'Brand Awareness Q2', status: 'ACTIVE', daily_budget: '800' },
          { id: 'camp_3', name: 'Retargeting Flow', status: 'PAUSED', daily_budget: '200' },
        ],
      }),
    },
  },
}

const META_ADS_INTEGRATION_EVAL: AgentEval = {
  id: 'adv-meta-ads-no-custom-server',
  name: 'Advanced: Meta Ads dashboard uses Tools SDK or custom-routes instead of custom server',
  category: 'skill',
  level: 4,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    'I have Meta Ads connected. Build me a dashboard that shows my ad campaign performance.',
    'I want to see spend, impressions, clicks, CTR, CPC for each campaign, and a chart of spending trends.',
    'I should be able to pause/resume campaigns from the dashboard too.',
  ].join('\n'),
  maxScore: 30,
  toolMocks: META_ADS_INTEGRATION_MOCKS,
  validationCriteria: [
    {
      id: 'used-meta-ads-tool',
      description: 'Called METAADS_GET_INSIGHTS or METAADS_LIST_CAMPAIGNS to fetch data',
      points: 4,
      phase: 'execution',
      validate: (r) => usedTool(r, 'METAADS_GET_INSIGHTS') || usedTool(r, 'METAADS_LIST_CAMPAIGNS'),
    },
    {
      id: 'built-canvas',
      description: 'Built a canvas dashboard component',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'canvas-uses-tools-sdk-or-custom-routes',
      description: 'Canvas uses useTools()/@shogo-ai/sdk/tools OR agent wrote custom-routes.ts',
      points: 5,
      phase: 'execution',
      validate: (r) => canvasUsesToolsSdk(r) || wroteCustomRoutes(r),
    },
    {
      id: 'canvas-calls-metaads-or-custom-routes',
      description: 'Canvas calls METAADS_ tools via execute() OR custom-routes proxies Meta API',
      points: 4,
      phase: 'execution',
      validate: (r) => canvasExecutesTool(r, 'METAADS') || (wroteCustomRoutes(r) && (customRoutesCode(r).includes('meta') || customRoutesCode(r).includes('facebook') || customRoutesCode(r).includes('campaign'))),
    },
    {
      id: 'canvas-has-metrics',
      description: 'Canvas displays CTR/CPC/spend metrics',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('cpc') || c.includes('ctr') || c.includes('spend')
      },
    },
    {
      id: 'no-custom-server-file',
      description: 'Did NOT create a custom server.ts/server.tsx file',
      points: 5,
      phase: 'execution',
      validate: (r) => !wroteCustomServer(r),
    },
    {
      id: 'no-http-framework',
      description: 'Did NOT import Hono/Express/Fastify outside of custom-routes.ts',
      points: 3,
      phase: 'execution',
      validate: (r) => !wroteCustomHttpServer(r),
    },
    {
      id: 'no-direct-graph-api-in-canvas',
      description: 'Canvas does NOT call graph.facebook.com directly (should use tools SDK or custom-routes)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return !code.includes('graph.facebook.com') && !code.includes('graph.facebook')
      },
    },
  ],
  antiPatterns: [
    'Created a custom Hono or Express server to proxy the Facebook Graph API (custom-routes.ts is acceptable)',
    'Wrote to server.ts or server.tsx',
    'Called graph.facebook.com directly from React code instead of using the tools SDK or custom-routes',
  ],
}

// =========================================================================
// EVAL 7b: CRUD Dashboard — Skill Server Instead of Custom Server
// Tests that when the user needs persistent data (not external API),
// the agent uses the skill server schema, not a custom Hono server.
// =========================================================================

const CRUD_DASHBOARD_MOCKS = makeSkillServerMocks(
  ['Campaign'],
  { Campaign: [{ name: 'Summer Sale Push', platform: 'meta', budget: 5000, spend: 3200, impressions: 450000, clicks: 12500, conversions: 380, status: 'active' }] },
)

const CRUD_DASHBOARD_EVAL: AgentEval = {
  id: 'adv-crud-no-custom-server',
  name: 'Advanced: CRUD dashboard uses skill server instead of custom Hono server',
  category: 'skill',
  level: 4,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    'I need a dashboard to manually track my ad campaigns. I want to store:',
    '',
    '- Campaign name, platform (meta/google), budget, spend, impressions, clicks, conversions, status',
    '- Calculate CPC, CTR, and ROAS automatically in the UI',
    '',
    "Here's my current data to seed:",
    '- Summer Sale Push: Meta, $5K budget, $3.2K spent, 450K impressions, 12.5K clicks, 380 conversions, active',
    '- Brand Awareness Q2: Google, $8K budget, $6.1K spent, 890K impressions, 15K clicks, 210 conversions, active',
    '- Retargeting Flow: Meta, $2K budget, $1.8K spent, 120K impressions, 8.2K clicks, 520 conversions, paused',
    '',
    'I want to be able to add new campaigns and update metrics as they come in.',
  ].join('\n'),
  maxScore: 30,
  toolMocks: CRUD_DASHBOARD_MOCKS,
  validationCriteria: [
    {
      id: 'wrote-schema',
      description: 'Wrote schema.prisma with Campaign model',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteSchemaWithAnyModels(r, 1),
    },
    {
      id: 'schema-has-campaign-fields',
      description: 'Schema includes campaign-related fields (budget, spend, impressions)',
      points: 3,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'budget') || schemaContainsFields(r, 'spend') || schemaContainsFields(r, 'impressions'),
    },
    {
      id: 'posted-campaigns',
      description: 'POSTed campaign records to skill server',
      points: 4,
      phase: 'execution',
      validate: (r) => postedToSkillServer(r, 'campaign'),
    },
    {
      id: 'built-canvas',
      description: 'Built canvas dashboard component',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'canvas-wired',
      description: 'Canvas fetches data from /api/ endpoints',
      points: 3,
      phase: 'execution',
      validate: (r) => canvasFetchesFromApi(r),
    },
    {
      id: 'canvas-has-metrics',
      description: 'Canvas computes or displays CPC/CTR/ROAS metrics',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const c = allCanvasCode(r)
        return c.includes('cpc') || c.includes('ctr') || c.includes('roas') || c.includes('cost per')
      },
    },
    {
      id: 'no-custom-server-file',
      description: 'Did NOT create a custom server.ts/server.tsx file',
      points: 4,
      phase: 'execution',
      validate: (r) => !wroteCustomServer(r),
    },
    {
      id: 'no-http-framework',
      description: 'Did NOT import Hono/Express/Fastify to build a custom server',
      points: 3,
      phase: 'execution',
      validate: (r) => !wroteCustomHttpServer(r),
    },
    {
      id: 'no-wrong-port',
      description: 'Canvas does NOT reference localhost:3001 or localhost:8080',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return !code.includes('localhost:3001') && !code.includes('localhost:8080') && !code.includes('localhost:3000')
      },
    },
  ],
  antiPatterns: [
    'Created a custom Hono or Express server instead of using the skill server',
    'Wrote to server.ts or server.tsx',
    'Referenced localhost:3001 or localhost:8080 in canvas code',
  ],
}

// =========================================================================
// EVAL 8: Custom Routes Proxy — No Schema Needed
// Tests that the agent uses custom-routes.ts (by editing, not creating) to
// proxy an external API when no database is needed.
// =========================================================================

const CUSTOM_ROUTES_PROXY_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    patterns: [
      { match: { url: 'health' }, response: { content: JSON.stringify({ ok: true }), status: 200 } },
      { match: { url: 'weather' }, response: { content: JSON.stringify({ temp: 72, condition: 'sunny', city: 'London' }), status: 200 } },
      { match: { url: '/api/' }, response: { content: JSON.stringify({ ok: true }), status: 200 } },
    ],
    default: { content: JSON.stringify({ ok: true }), status: 200 },
  },
}

const CUSTOM_ROUTES_PROXY_EVAL: AgentEval = {
  id: 'adv-custom-routes-proxy',
  name: 'Advanced: Custom routes proxy for external API (no schema needed)',
  category: 'skill',
  level: 4,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    "I need a backend endpoint that proxies requests to the OpenWeather API.",
    "The frontend should call our server at /api/weather?city=London and get back the weather data.",
    "Don't need a database for this — just a simple proxy.",
    "Build me a nice weather dashboard that shows current conditions.",
  ].join('\n'),
  maxScore: 30,
  toolMocks: CUSTOM_ROUTES_PROXY_MOCKS,
  validationCriteria: [
    {
      id: 'edited-custom-routes',
      description: 'Edited .shogo/server/custom-routes.ts (not created a new server)',
      points: 6,
      phase: 'execution',
      validate: (r) => wroteCustomRoutes(r),
    },
    {
      id: 'custom-routes-has-weather',
      description: 'Custom routes file has a /weather route',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = customRoutesCode(r)
        return code.includes('weather')
      },
    },
    {
      id: 'custom-routes-imports-hono',
      description: 'Custom routes file imports Hono',
      points: 2,
      phase: 'execution',
      validate: (r) => {
        const code = customRoutesCode(r)
        return code.includes('hono')
      },
    },
    {
      id: 'built-canvas',
      description: 'Built a weather dashboard canvas',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'canvas-fetches-api-weather',
      description: 'Canvas fetches from /api/weather (relative URL)',
      points: 4,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('/api/weather')
      },
    },
    {
      id: 'no-custom-server-file',
      description: 'Did NOT create a custom server.ts/server.tsx file',
      points: 4,
      phase: 'execution',
      validate: (r) => !wroteCustomServer(r),
    },
    {
      id: 'no-schema-written',
      description: 'Did NOT write schema.prisma (no database needed)',
      points: 4,
      phase: 'execution',
      validate: (r) => !wroteSchema(r),
    },
    {
      id: 'no-http-framework-outside-cr',
      description: 'Did NOT import Hono/Express outside of custom-routes.ts',
      points: 3,
      phase: 'execution',
      validate: (r) => !wroteCustomHttpServer(r),
    },
  ],
  antiPatterns: [
    'Created a custom Hono or Express server instead of editing custom-routes.ts',
    'Wrote schema.prisma when no database was needed',
    'Called openweathermap.org directly from React instead of through the proxy',
  ],
}

// =========================================================================
// EVAL 9: CRUD + Custom Routes Combined
// Tests that the agent can combine schema-based CRUD with custom routes for
// enrichment endpoints in a single project.
// =========================================================================

const CRUD_PLUS_CUSTOM_ROUTES_MOCKS: ToolMockMap = {
  ...makeSkillServerMocks(['Contact'], {
    Contact: [
      { name: 'Jane Smith', email: 'jane@example.com', company: 'Acme Corp', status: 'lead' },
    ],
  }),
  web: {
    type: 'pattern',
    patterns: [
      { match: { url: 'health' }, response: { content: JSON.stringify({ ok: true }), status: 200 } },
      { match: { url: 'enrich' }, response: { content: JSON.stringify({ ok: true, data: { company: 'Acme Corp', industry: 'SaaS', employees: 150, funding: 'Series B' } }), status: 200 } },
      { match: { url: 'contact' }, response: { content: JSON.stringify({ ok: true, items: [{ id: 'c1', name: 'Jane Smith', email: 'jane@example.com', company: 'Acme Corp', status: 'lead' }] }), status: 200 } },
    ],
    default: { content: JSON.stringify({ ok: true }), status: 200 },
  },
}

const CRUD_PLUS_CUSTOM_ROUTES_EVAL: AgentEval = {
  id: 'adv-crud-plus-custom-routes',
  name: 'Advanced: CRM with CRUD + custom enrichment route',
  category: 'skill',
  level: 5,
  initialMode: 'canvas',
  useRuntimeTemplate: true,
  workspaceFiles: { 'config.json': V2_CONFIG },
  input: [
    "Build me a CRM dashboard. I need to store contacts in a database (name, email, company, status).",
    "Also add an endpoint that enriches contact data by calling the Clearbit API when I click 'enrich' on a contact.",
    "The enrichment should add company info like industry, employee count, and funding stage.",
  ].join('\n'),
  maxScore: 30,
  toolMocks: CRUD_PLUS_CUSTOM_ROUTES_MOCKS,
  validationCriteria: [
    {
      id: 'wrote-schema-contact',
      description: 'Wrote schema.prisma with a Contact model',
      points: 4,
      phase: 'execution',
      validate: (r) => wroteSchema(r, 'Contact'),
    },
    {
      id: 'schema-has-contact-fields',
      description: 'Schema has name, email, company fields',
      points: 3,
      phase: 'execution',
      validate: (r) => schemaContainsFields(r, 'name', 'email', 'company'),
    },
    {
      id: 'edited-custom-routes',
      description: 'Edited custom-routes.ts with an /enrich route',
      points: 5,
      phase: 'execution',
      validate: (r) => {
        const code = customRoutesCode(r)
        return wroteCustomRoutes(r) && code.includes('enrich')
      },
    },
    {
      id: 'built-canvas',
      description: 'Built a CRM canvas dashboard',
      points: 3,
      phase: 'execution',
      validate: (r) => wroteCanvasFile(r),
    },
    {
      id: 'canvas-fetches-crud',
      description: 'Canvas fetches from /api/contacts (CRUD)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('/api/contact')
      },
    },
    {
      id: 'canvas-fetches-enrich',
      description: 'Canvas fetches from /api/enrich (custom route)',
      points: 3,
      phase: 'execution',
      validate: (r) => {
        const code = allCanvasCode(r)
        return code.includes('/api/enrich')
      },
    },
    {
      id: 'no-custom-server-file',
      description: 'Did NOT create a custom server.ts/server.tsx file',
      points: 4,
      phase: 'execution',
      validate: (r) => !wroteCustomServer(r),
    },
    {
      id: 'no-http-framework-outside-cr',
      description: 'Did NOT import Hono/Express outside of custom-routes.ts',
      points: 3,
      phase: 'execution',
      validate: (r) => !wroteCustomHttpServer(r),
    },
    {
      id: 'response-mentions-both',
      description: 'Response mentions both CRUD and enrichment',
      points: 2,
      phase: 'execution',
      validate: (r) => responseContains(r, 'contact') && responseContains(r, 'enrich'),
    },
  ],
  antiPatterns: [
    'Created a custom server instead of using skill server + custom-routes.ts',
    'Did not write a schema when one was needed for contacts',
    'Called Clearbit directly from React instead of through the proxy',
  ],
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const SKILL_SERVER_ADVANCED_EVALS: AgentEval[] = [
  CI_ANALYZER_EVAL,
  COMPETITIVE_INTEL_EVAL,
  INCIDENT_TRIAGE_EVAL,
  EMAIL_SLACK_RECON_EVAL,
  DATA_PIPELINE_EVAL,
  BRIEFING_EVAL,
  META_ADS_INTEGRATION_EVAL,
  CRUD_DASHBOARD_EVAL,
  CUSTOM_ROUTES_PROXY_EVAL,
  CRUD_PLUS_CUSTOM_ROUTES_EVAL,
]
