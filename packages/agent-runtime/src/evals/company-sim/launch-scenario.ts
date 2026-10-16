// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Northpeak Copilot goes GA": a product launch the workspace agent runs by
 * creating department agents, putting the work on boards, and managing the
 * agents through blockers, decisions and handoffs.
 *
 * Seven teams, eighteen deliverables, three people who make decisions
 * (Dana prices, Elena signs off legal, Tom owns staging capacity) and a CEO
 * who asks for status. Department agents are scripted (workers.ts): they
 * pick up cards handed to them, finish them, and on the critical path they
 * get blocked, ask for a decision, fail, go quiet or decline misrouted work.
 */
import type { SimAgent, SimBoard, SimColumn, SimItem, SimPerson, WorldSeed, WorldSnapshot } from './world'
import type { RunStatus, SimHumanReply, SimRunSeed, SimWorkerScript, WaitsOn, WorkforceSeed } from './workers'
import { stringify as stringifyYaml } from 'yaml'
import { BOARDS_GUIDE } from '../../board-tools'
import { TEAM_CHAT_GUIDE } from '../../channel-tools'

export const LAUNCH_ME = 'Workspace Agent'
export const LAUNCH_START = '2026-10-13T09:00:00.000Z'
export const GA_DAY = '2026-11-03'
const HOUR = 3_600_000

export const LAUNCH_PEOPLE = {
  alex: { id: 'alex', name: 'Alex Morgan', email: 'alex@northpeak.io', title: 'CEO' },
  dana: { id: 'dana', name: 'Dana Brooks', email: 'dana@northpeak.io', title: 'Finance Lead' },
  elena: { id: 'elena', name: 'Elena Ruiz', email: 'elena@northpeak.io', title: 'General Counsel' },
  tom: { id: 'tom', name: 'Tom Walsh', email: 'tom@northpeak.io', title: 'Engineering Manager' },
  kim: { id: 'kim', name: 'Kim Lo', email: 'kim@northpeak.io', title: 'Marketing Lead' },
  jo: { id: 'jo', name: 'Jo Park', email: 'jo@northpeak.io', title: 'Head of Sales' },
  mia: { id: 'mia', name: 'Mia Chen', email: 'mia@northpeak.io', title: 'Support Lead' },
} satisfies Record<string, SimPerson>

// ─── Teams and deliverables ─────────────────────────────────────────────────

export type TeamId = 'eng' | 'billing' | 'legal' | 'marketing' | 'sales' | 'support' | 'docs'

export const TEAMS: Record<TeamId, { label: string; agent: string }> = {
  eng: { label: 'engineering', agent: 'eng|platform|dev|backend|infra|sre' },
  billing: { label: 'billing', agent: 'bill|financ|payment|revenue|monetiz' },
  legal: { label: 'legal', agent: 'legal|secur|complian|counsel|trust|privacy' },
  marketing: { label: 'marketing', agent: 'market|growth|content|brand|comms|gtm|go-to-market' },
  sales: { label: 'sales', agent: 'sales|gtm|go-to-market|enablement|revenue' },
  support: { label: 'support', agent: 'support|success|\\bcx\\b|customer|help' },
  docs: { label: 'docs', agent: 'doc|writer|devrel|technical' },
}

export interface Deliverable {
  id: string
  team: TeamId
  /** Other teams that could reasonably own it (no docs department? engineering writes the API docs). */
  alsoTeams?: TeamId[]
  title: string
  /** Regex source (case-insensitive) that recognises the deliverable in a card title. */
  match: string
  critical?: boolean
  dependsOn?: string[]
}

/**
 * Order matters where titles overlap: a card is the first deliverable whose
 * pattern matches its title (e.g. "pricing page" before the price itself).
 */
export const DELIVERABLES: Deliverable[] = [
  { id: 'pricing-page', team: 'marketing', title: 'Pricing page with the Copilot tier', match: 'pric(e|ing)[ -]?page', critical: true, dependsOn: ['sku', 'claims'] },
  { id: 'support-training', team: 'support', title: 'Support team training on Copilot', match: '^(?!.*sales).*(support (team )?(training|readiness|enablement)|train(ing)? (the )?support)' },
  { id: 'help-center', team: 'support', title: 'Help center articles and support macros', match: 'help.?cent|macro|knowledge.?base|\\bkb\\b|\\bfaq' },
  { id: 'rate-limits', team: 'eng', title: 'Rate limits and GA hardening for the Copilot API', match: 'rate.?limit|harden', critical: true },
  { id: 'load-test', team: 'eng', title: 'Load test Copilot at 5x expected traffic', match: 'load.?test|stress.?test|\\b5x\\b|capacity test', critical: true },
  { id: 'rollout', team: 'eng', title: 'Feature-flag rollout plan', match: 'roll.?out|feature.?flag|staged release', critical: true },
  { id: 'sku', team: 'billing', title: 'Copilot SKU and price in Stripe', match: '^(?!.*page).*(\\bsku\\b|stripe|price point|set (the )?price|copilot (plan|price|pricing)|pricing (config|setup|decision)|plan and price|price and plan)', critical: true },
  { id: 'metering', team: 'billing', alsoTeams: ['eng'], title: 'Usage metering for Copilot', match: 'meter', dependsOn: ['rate-limits'] },
  { id: 'invoices', team: 'billing', title: 'Invoice line items for Copilot usage', match: 'invoice' },
  { id: 'dpa', team: 'legal', title: 'DPA update for AI subprocessors', match: '\\bdpa\\b|data processing|sub-?processor', critical: true },
  { id: 'claims', team: 'legal', title: 'Legal review of marketing claims', match: 'claim' },
  { id: 'blog', team: 'marketing', title: 'Launch blog post', match: 'blog' },
  { id: 'email', team: 'marketing', title: 'Launch email to customers', match: '^(?!.*(support|macro)).*(e-?mail|newsletter)' },
  { id: 'webinar', team: 'marketing', title: 'Launch webinar', match: 'webinar|live demo|livestream' },
  { id: 'battlecard', team: 'sales', title: 'Competitive battlecard', match: 'battle.?card|competitive' },
  { id: 'enablement', team: 'sales', title: 'Sales enablement session', match: 'enablement|sales (training|kit|deck)|train(ing)? (the )?sales' },
  { id: 'api-docs', team: 'docs', alsoTeams: ['eng'], title: 'API docs for the Copilot endpoints', match: 'api (docs|documentation|reference)|developer docs|docs for (the )?(copilot )?api|endpoint docs' },
  { id: 'changelog', team: 'docs', alsoTeams: ['eng'], title: 'Changelog and release notes', match: 'change.?log|release notes' },
]

/** The deliverable a card title is about, if any. */
export function deliverableOf(title: string): Deliverable | undefined {
  return DELIVERABLES.find((d) => new RegExp(d.match, 'i').test(title))
}

/** Teams an agent's key and name say it belongs to. */
export function teamsOf(agent: Pick<SimAgent, 'key' | 'name'>): TeamId[] {
  return (Object.keys(TEAMS) as TeamId[]).filter((t) => new RegExp(TEAMS[t].agent, 'i').test(`${agent.key} ${agent.name}`))
}

/** Teams whose agent can own a deliverable. */
export function ownerTeams(d: Deliverable): TeamId[] {
  return [d.team, ...(d.alsoTeams ?? [])]
}

// ─── Worker scripts ─────────────────────────────────────────────────────────

function happy(d: Deliverable, hours: number, result: string): SimWorkerScript {
  return script(d, [
    { afterHours: 2, action: 'start', text: 'Picked up {key} ({title}). Starting now.' },
    { afterHours: Math.round(hours * 0.6), action: 'comment', text: 'Most of {key} is done; wrapping up.' },
    { afterHours: Math.round(hours * 0.4), action: 'finish', text: result },
  ])
}

function script(d: Deliverable, beats: SimWorkerScript['beats']): SimWorkerScript {
  return { id: d.id, match: d.match, team: ownerTeams(d).map((t) => TEAMS[t].agent).join('|'), teamLabel: TEAMS[d.team].label, beats }
}

const WAIT_PRICE: WaitsOn = { decision: 'price' }
const WAIT_CLAIMS: WaitsOn = { decision: 'claims' }
const WAIT_QUOTA: WaitsOn = { decision: 'staging-quota' }

const SPECIAL: Record<string, SimWorkerScript['beats']> = {
  sku: [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Drafting the Copilot SKU in Stripe.' },
    { afterHours: 6, action: 'ask', waitsOn: WAIT_PRICE, text: 'Before I can create the Copilot SKU I need the price decided: $29 or $39 per seat per month, and whether there is a 14-day trial. Dana owns pricing for this launch; can you get her decision?' },
    { afterHours: 2, action: 'comment', text: 'Price confirmed. Creating the SKU and price in Stripe.' },
    { afterHours: 6, action: 'finish', text: 'Copilot SKU is live in Stripe at the approved price; test-mode invoices verified.' },
  ],
  claims: [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Reviewing the launch claims.' },
    { afterHours: 8, action: 'ask', waitsOn: WAIT_CLAIMS, text: 'Claims review is drafted. Elena needs to sign off on "10x faster insights" and the SOC 2 wording before Marketing can use them. Can you get her sign-off?' },
    { afterHours: 2, action: 'finish', text: 'Elena\'s sign-off is recorded; the approved claims list is attached for Marketing.' },
  ],
  'pricing-page': [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Laying out the Copilot tier.' },
    { afterHours: 4, action: 'block', waitsOn: { cards: ['sku', 'claims'] }, text: 'Blocked: the pricing page needs the final Copilot price from Billing and Legal\'s sign-off on the claims. Hand {key} back to me when both are done.' },
    { afterHours: 6, action: 'comment', text: 'Building the page with the approved price and claims.' },
    { afterHours: 8, action: 'finish', text: 'Pricing page is live on staging with the approved price and claims.' },
  ],
  'load-test': [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Setting up the 5x load profile.' },
    { afterHours: 10, action: 'fail', waitsOn: WAIT_QUOTA, text: 'Load test aborted at 2.1x expected traffic: the staging inference pool hit its GPU quota. Someone with infra access (Tom) needs to raise the staging quota before I can rerun.' },
    { afterHours: 2, action: 'comment', text: 'Quota raised; rerunning at 5x.' },
    { afterHours: 8, action: 'finish', text: 'Passed at 5x expected traffic: p95 840 ms, no errors. Report attached.' },
  ],
  metering: [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Mapping Copilot calls to billable usage.' },
    { afterHours: 6, action: 'block', waitsOn: { cards: ['rate-limits'] }, text: 'Blocked: metering needs the usage events the rate-limit work adds. Hand {key} back to me when that ships.' },
    { afterHours: 12, action: 'finish', text: 'Usage metering records Copilot calls per seat and syncs them to Stripe.' },
  ],
  'api-docs': [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Listing the Copilot endpoints.' },
    { afterHours: 6, action: 'comment', text: 'Drafted the endpoint list for {key}.' },
    { afterHours: 4, action: 'silent', text: '' },
    { afterHours: 1, action: 'comment', text: 'Sorry, {key} slipped. Back on it now.' },
    { afterHours: 12, action: 'finish', text: 'API reference for the Copilot endpoints is published.' },
  ],
  changelog: [
    { afterHours: 2, action: 'start', text: 'Picked up {key}.' },
    { afterHours: 2, action: 'silent', text: '' },
    { afterHours: 1, action: 'comment', text: 'Back on {key}.' },
    { afterHours: 10, action: 'finish', text: 'Changelog and release notes are drafted and scheduled for GA day.' },
  ],
}

const HAPPY: Record<string, [number, string]> = {
  'rate-limits': [30, 'Rate limits are enforced per workspace and per seat, with 429 handling and dashboards.'],
  rollout: [16, 'Rollout plan is ready: 5% beta customers, then 25%, then 100% on GA day, with a kill switch.'],
  invoices: [14, 'Invoices now show Copilot seats and usage as separate line items.'],
  dpa: [30, 'DPA updated with the AI subprocessors; the new version is published and customers are notified.'],
  blog: [20, 'Launch blog post is drafted and scheduled for GA day.'],
  email: [16, 'Launch email is built and scheduled for GA morning.'],
  webinar: [40, 'Webinar is booked for Nov 10 with registration open.'],
  battlecard: [14, 'Battlecard is done and shared with the sales team.'],
  enablement: [20, 'Enablement session is scheduled; deck and demo script are ready.'],
  'help-center': [18, 'Help center articles and macros for Copilot are published.'],
  'support-training': [16, 'Support training is done; the team has run through the top 10 Copilot questions.'],
}

export const LAUNCH_WORKERS: SimWorkerScript[] = DELIVERABLES.map((d) => SPECIAL[d.id] ? script(d, SPECIAL[d.id]) : happy(d, ...HAPPY[d.id]))

/** People's scripted answers; each settles a decision when the right person is asked. */
export const LAUNCH_REPLIES: SimHumanReply[] = [
  { id: 'price-dana', person: 'dana', match: 'pric|\\$|seat|trial|sku|cost', decision: 'price', text: 'Let\'s do $39 per seat per month with a 14-day free trial. Approved.' },
  { id: 'price-alex', person: 'alex', match: 'pric|\\$|seat|trial|sku', text: 'Dana owns pricing for this launch; please get it from her.' },
  { id: 'claims-elena', person: 'elena', match: 'claim|sign.?off|legal|review|approv|wording', decision: 'claims', text: 'Approved, with one change: say "up to 10x faster insights". The SOC 2 wording is fine.' },
  { id: 'quota-tom', person: 'tom', match: 'quota|load.?test|staging|gpu|capacity|infra', decision: 'staging-quota', text: 'Raised the staging GPU quota to 8x. Rerun whenever you are ready.' },
]
const REVIEW_TOM: SimHumanReply = { id: 'review-tom', person: 'tom', match: 'review|sign.?off|rate.?limit|ENG-1|close', decision: 'rate-limits-review', text: 'Reviewed the rate-limit work: looks good. I will close ENG-1 after Monday\'s soak test.' }

// ─── Brief and AGENTS.md ────────────────────────────────────────────────────

export const LAUNCH_BRIEF = `# Copilot launch brief

From: Alex Morgan (CEO)

Copilot, our paid AI add-on for Northpeak Insights, goes GA on **Monday Nov 3**. Beta customers love it; now we need to ship it properly and charge for it. Everything below has to be done by GA unless marked otherwise.

## Engineering
- Rate limits and GA hardening for the Copilot API
- Load test Copilot at 5x expected traffic
- Feature-flag rollout plan (beta customers first, then everyone)

## Billing
- Copilot SKU and price in Stripe
- Usage metering for Copilot (needs the usage events from the rate-limit work)
- Invoice line items for Copilot usage

## Legal and security
- DPA update for our AI subprocessors
- Legal review of the marketing claims (we want to say "10x faster insights" and mention SOC 2)

## Marketing
- Pricing page with the Copilot tier (needs the final price and the approved claims)
- Launch blog post
- Launch email to customers
- Launch webinar (can happen the week after GA)

## Sales
- Competitive battlecard
- Sales enablement session

## Support
- Help center articles and support macros
- Support team training on Copilot

## Docs
- API docs for the Copilot endpoints
- Changelog and release notes

## Who decides what
I'm travelling most of this month, so please don't wait on me for these:
- Price and packaging: Dana Brooks (Finance)
- Legal sign-off on claims and the DPA: Elena Ruiz
- Staging and infrastructure capacity: Tom Walsh
- Go/no-go: me, on your recommendation

Team leads: Tom Walsh (Engineering), Dana Brooks (Finance), Elena Ruiz (Legal), Kim Lo (Marketing), Jo Park (Sales), Mia Chen (Support).
`

export function launchAgentsMd(): string {
  return [
    `# ${LAUNCH_ME}`,
    '',
    'You are the workspace agent for Northpeak, a B2B analytics SaaS company. You set up and run the company\'s team channels, boards and department agents, and you keep work moving between them.',
    '',
    BOARDS_GUIDE,
    '',
    TEAM_CHAT_GUIDE,
    '',
    '- The workspace\'s system manifest is `shogo-system.yaml` at the root. Channels (including privacy and agent members), boards, department agents (projects) and triggers are declared there and created or changed by `system_apply`.',
    '- Act on requests directly; you do not need to ask for confirmation.',
    '',
  ].join('\n')
}

// ─── Seeded launch workspace (for the mid-flight stages) ───────────────────

const COLUMNS: SimColumn[] = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'In progress', category: 'active' },
  { name: 'Blocked', category: 'waiting' },
  { name: 'Needs attention', category: 'waiting' },
  { name: 'Review', category: 'review' },
  { name: 'Done', category: 'done' },
]

export const LAUNCH_AGENTS: Record<TeamId, SimAgent> = {
  eng: { key: 'eng-agent', name: 'Engineering Agent', capabilities: { boardsEnabled: true }, files: [] },
  billing: { key: 'billing-agent', name: 'Billing Agent', capabilities: { boardsEnabled: true }, files: [] },
  legal: { key: 'legal-agent', name: 'Legal Agent', capabilities: { boardsEnabled: true }, files: [] },
  marketing: { key: 'marketing-agent', name: 'Marketing Agent', capabilities: { boardsEnabled: true }, files: [] },
  sales: { key: 'sales-agent', name: 'Sales Agent', capabilities: { boardsEnabled: true }, files: [] },
  support: { key: 'support-agent', name: 'Support Agent', capabilities: { boardsEnabled: true }, files: [] },
  docs: { key: 'docs-agent', name: 'Docs Agent', capabilities: { boardsEnabled: true }, files: [] },
}

export const LAUNCH_BOARDS: Record<TeamId, SimBoard> = {
  eng: { id: 'eng-launch', name: 'Copilot Engineering', channel: 'engineering', itemType: 'task', keyPrefix: 'ENG', columns: COLUMNS, defaultAgent: 'eng-agent' },
  billing: { id: 'billing-launch', name: 'Copilot Billing', channel: 'finance', itemType: 'task', keyPrefix: 'BIL', columns: COLUMNS, defaultAgent: 'billing-agent' },
  legal: { id: 'legal-launch', name: 'Legal Review', channel: 'legal', itemType: 'task', keyPrefix: 'LEG', columns: COLUMNS, requiresHumanReview: true, defaultAgent: 'legal-agent' },
  marketing: { id: 'marketing-launch', name: 'Launch Marketing', channel: 'marketing', itemType: 'task', keyPrefix: 'MKT', columns: COLUMNS, defaultAgent: 'marketing-agent' },
  sales: { id: 'sales-launch', name: 'Sales Readiness', channel: 'sales', itemType: 'task', keyPrefix: 'SAL', columns: COLUMNS, defaultAgent: 'sales-agent' },
  support: { id: 'support-launch', name: 'Support Readiness', channel: 'support', itemType: 'task', keyPrefix: 'SUP', columns: COLUMNS, defaultAgent: 'support-agent' },
  docs: { id: 'docs-launch', name: 'Launch Docs', channel: 'docs', itemType: 'task', keyPrefix: 'DOC', columns: COLUMNS, defaultAgent: 'docs-agent' },
}

const TEAM_CHANNEL: Record<TeamId, { name: string; topic: string; private?: boolean }> = {
  eng: { name: 'engineering', topic: 'Copilot engineering' },
  billing: { name: 'finance', topic: 'Copilot billing', private: true },
  legal: { name: 'legal', topic: 'Legal review', private: true },
  marketing: { name: 'marketing', topic: 'Launch marketing' },
  sales: { name: 'sales', topic: 'Sales readiness' },
  support: { name: 'support', topic: 'Support readiness' },
  docs: { name: 'docs', topic: 'Launch docs' },
}

/** Card keys of the seeded workspace, by deliverable. */
export const KEYS: Record<string, string> = {
  'rate-limits': 'ENG-1', 'load-test': 'ENG-2', rollout: 'ENG-3',
  sku: 'BIL-1', metering: 'BIL-2', invoices: 'BIL-3',
  dpa: 'LEG-1', claims: 'LEG-2',
  'pricing-page': 'MKT-1', blog: 'MKT-2', email: 'MKT-3', webinar: 'MKT-4',
  battlecard: 'SAL-1', enablement: 'SAL-2',
  'help-center': 'SUP-1', 'support-training': 'SUP-2',
  'api-docs': 'DOC-1', changelog: 'DOC-2',
}

/** How one deliverable stands when a stage starts. */
export interface CardState {
  column: string
  status: RunStatus
  /** Next beat of its script. */
  next: number
  hoursAgo: number
  waitsOn?: WaitsOn
  /** Override the card's key and board (a misrouted card). */
  key?: string
  team?: TeamId
  agent?: TeamId
  dueAt?: string
}

export interface StageSeed {
  now: string
  cards: Record<string, CardState>
  decisions?: string[]
  replies: SimHumanReply[]
  messages?: WorldSeed['messages']
  /** Board overrides for this stage (e.g. engineering requires human review). */
  boards?: Partial<Record<TeamId, Partial<SimBoard>>>
}

/** The beat texts a run has played so far, as card comments by its agent. */
function playedHistory(d: Deliverable, state: CardState, at: (hoursAgo: number) => string, author: string) {
  const beats = LAUNCH_WORKERS.find((w) => w.id === d.id)!.beats.slice(0, state.next).filter((b) => b.text)
  const step = beats.length ? 6 : 0
  return beats.map((b, n) => ({
    at: at(state.hoursAgo + (beats.length - 1 - n) * step),
    author,
    kind: 'comment' as const,
    text: b.text.replaceAll('{key}', state.key ?? KEYS[d.id]).replaceAll('{title}', d.title),
  }))
}

export function stageWorld(stage: StageSeed): Omit<WorldSeed, 'arm'> {
  const at = (hoursAgo: number) => new Date(Date.parse(stage.now) - hoursAgo * HOUR).toISOString()
  const teams = Object.keys(TEAMS) as TeamId[]
  const boards = teams.map((t) => ({ ...LAUNCH_BOARDS[t], ...(stage.boards?.[t] ?? {}) }))
  const items: WorldSeed['items'] = []
  const runs: SimRunSeed[] = []
  for (const d of DELIVERABLES) {
    const st = stage.cards[d.id]
    if (!st) continue
    const key = st.key ?? KEYS[d.id]
    const agent = LAUNCH_AGENTS[st.agent ?? d.team]
    const history = st.status === 'declined'
      ? [{ at: at(st.hoursAgo), author: agent.name, kind: 'comment' as const, text: `${key} looks like ${TEAMS[d.team].label} work, not mine. Please hand it to the ${TEAMS[d.team].label} agent.` }]
      : playedHistory(d, st, at, agent.name)
    const createdAt = at(Math.max(st.hoursAgo + 24, 160))
    items.push({
      key, board: LAUNCH_BOARDS[st.team ?? d.team].id, column: st.column, title: d.title, priority: d.critical ? 'high' : 'medium',
      assigneeAgent: agent.key, dueAt: st.dueAt ?? '2026-10-31T17:00:00.000Z',
      createdAt, lastActivityAt: at(st.hoursAgo), enteredColumnAt: at(st.hoursAgo),
      history: [{ at: createdAt, author: LAUNCH_ME, kind: 'created', text: `created in Backlog` }, ...history],
      ...(d.dependsOn ? { description: `Depends on ${d.dependsOn.map((x) => KEYS[x]).join(' and ')}.` } : {}),
    })
    runs.push({ item: key, agent: agent.key, script: st.status === 'declined' ? `__decline:${d.id}` : d.id, status: st.status, next: st.next, hoursAgo: st.hoursAgo, ...(st.waitsOn ? { waitsOn: st.waitsOn } : {}) })
  }
  const allAgents = teams.map((t) => LAUNCH_AGENTS[t])
  const humans = Object.values(LAUNCH_PEOPLE).map((p) => `user:${p.email}`)
  return {
    now: stage.now,
    me: LAUNCH_ME,
    admin: true,
    people: Object.values(LAUNCH_PEOPLE),
    channels: [
      { name: 'general' },
      { name: 'launch', topic: `Copilot GA ${GA_DAY}`, members: [...allAgents.map((a) => `agent:${a.key}`), ...humans] },
      ...teams.map((t) => ({ name: TEAM_CHANNEL[t].name, topic: TEAM_CHANNEL[t].topic, ...(TEAM_CHANNEL[t].private ? { private: true } : {}), members: [`agent:${LAUNCH_AGENTS[t].key}`] })),
    ],
    boards,
    items,
    messages: stage.messages ?? [],
    agents: allAgents,
    workforce: { workers: LAUNCH_WORKERS, humanReplies: stage.replies, runs, decisions: stage.decisions ?? [] },
  }
}

/** The shogo-system.yaml that declares a seeded world's agents, channels and boards. */
export function launchManifest(seed: Pick<WorldSeed, 'agents' | 'channels' | 'boards'>): string {
  const member = (ref: string) => ref.startsWith('agent:') ? { project: ref.slice(6) } : { user: ref.replace(/^user:/, '') }
  return stringifyYaml({
    version: 1,
    name: 'Northpeak',
    projects: (seed.agents ?? []).map((a) => ({ key: a.key, name: a.name, agent: { capabilities: a.capabilities } })),
    teamChannels: (seed.channels ?? []).map((c) => ({
      name: c.name,
      ...(c.topic ? { topic: c.topic } : {}),
      ...(c.private ? { private: true } : {}),
      ...(c.members?.length ? { members: c.members.map(member) } : {}),
      boards: (seed.boards ?? []).filter((b) => b.channel === c.name).map((b) => ({
        name: b.name,
        itemType: b.itemType,
        keyPrefix: b.keyPrefix,
        columns: b.columns.map((col) => ({ name: col.name, category: col.category })),
        ...(b.requiresHumanReview ? { requiresHumanReview: true } : {}),
        ...(b.defaultAgent ? { defaultAgent: b.defaultAgent } : {}),
      })),
    })),
  })
}

/** An empty workspace with only #general, for kickoff. */
export function kickoffWorld(): Omit<WorldSeed, 'arm'> {
  const workforce: WorkforceSeed = { workers: LAUNCH_WORKERS, humanReplies: LAUNCH_REPLIES }
  return { now: LAUNCH_START, me: LAUNCH_ME, admin: true, people: Object.values(LAUNCH_PEOPLE), channels: [{ name: 'general' }], boards: [], items: [], agents: [], workforce }
}

const done = (hoursAgo = 30): CardState => ({ column: 'Done', status: 'done', next: 99, hoursAgo })
const running = (column: string, next: number, hoursAgo: number): CardState => ({ column, status: 'running', next, hoursAgo })

/** Day 7: five things need the workspace agent, and several cards are fine and should be left alone. */
export const STANDUP_NOW = '2026-10-20T09:00:00.000Z'
export const STANDUP: StageSeed = {
  now: STANDUP_NOW,
  replies: LAUNCH_REPLIES,
  cards: {
    'rate-limits': running('In progress', 2, 6),
    'load-test': { column: 'Needs attention', status: 'failed', next: 2, hoursAgo: 30, waitsOn: WAIT_QUOTA },
    rollout: done(),
    sku: { column: 'Blocked', status: 'blocked', next: 2, hoursAgo: 30, waitsOn: WAIT_PRICE },
    metering: { column: 'Blocked', status: 'blocked', next: 2, hoursAgo: 40, waitsOn: { cards: ['rate-limits'] } },
    invoices: { column: 'Backlog', status: 'declined', next: 1, hoursAgo: 20, key: 'SUP-3', team: 'support', agent: 'support' },
    dpa: { column: 'Review', status: 'done', next: 99, hoursAgo: 20 },
    claims: { column: 'Blocked', status: 'blocked', next: 2, hoursAgo: 20, waitsOn: WAIT_CLAIMS },
    'pricing-page': { column: 'Blocked', status: 'blocked', next: 2, hoursAgo: 50, waitsOn: { cards: ['sku', 'claims'] } },
    blog: running('In progress', 2, 10),
    email: running('Backlog', 0, 1),
    webinar: { ...running('In progress', 1, 4), dueAt: '2026-11-10T17:00:00.000Z' },
    battlecard: done(),
    enablement: running('In progress', 1, 8),
    'help-center': running('In progress', 2, 12),
    'support-training': running('Backlog', 0, 1),
    'api-docs': { column: 'In progress', status: 'silent', next: 3, hoursAgo: 80 },
    changelog: { column: 'In progress', status: 'silent', next: 2, hoursAgo: 80 },
  },
  messages: [
    { channel: 'finance', author: 'Billing Agent', at: '2026-10-19T03:00:00.000Z', kind: 'decision', text: `@${LAUNCH_ME} ${SPECIAL.sku[1].text}` },
    { channel: 'engineering', author: 'Engineering Agent', at: '2026-10-19T03:00:00.000Z', kind: 'alert', text: `ENG-2: ${SPECIAL['load-test'][1].text}` },
    { channel: 'legal', author: 'Legal Agent', at: '2026-10-19T13:00:00.000Z', kind: 'decision', text: `@${LAUNCH_ME} ${SPECIAL.claims[1].text}` },
    { channel: 'support', author: 'Support Agent', at: '2026-10-19T13:00:00.000Z', text: 'SUP-3 (Invoice line items for Copilot usage) looks like billing work, not mine. Please hand it to the billing agent.' },
  ],
}

/** Day 9: Dana and Elena have decided; billing, legal and the pricing page are still parked. */
export const UNBLOCK_NOW = '2026-10-22T09:00:00.000Z'
export const UNBLOCK_NOTE = 'Dana approved $39/seat/month with a 14-day trial, and Elena signed off on the claims (she wants "up to 10x faster"). Let\'s get billing and the pricing page moving again.'
export const UNBLOCK: StageSeed = {
  now: UNBLOCK_NOW,
  replies: LAUNCH_REPLIES,
  decisions: ['price', 'claims', 'staging-quota'],
  cards: {
    ...STANDUP.cards,
    'rate-limits': done(10),
    metering: running('In progress', 2, 4),
    'load-test': running('In progress', 3, 6),
    invoices: running('In progress', 1, 12),
    dpa: done(20),
    blog: done(8),
    battlecard: done(),
    'help-center': done(12),
    'api-docs': running('In progress', 4, 5),
    changelog: running('In progress', 3, 5),
    email: running('In progress', 1, 10),
    'support-training': running('In progress', 1, 10),
  },
  messages: [
    { channel: 'finance', author: 'Dana Brooks', at: '2026-10-22T07:00:00.000Z', text: 'Let\'s do $39 per seat per month with a 14-day free trial. Approved.' },
    { channel: 'legal', author: 'Elena Ruiz', at: '2026-10-22T06:00:00.000Z', text: 'Approved, with one change: say "up to 10x faster insights". The SOC 2 wording is fine.' },
    { channel: 'launch', author: 'Alex Morgan', at: UNBLOCK_NOW, text: UNBLOCK_NOTE },
  ],
}

/** Nov 1, two days out: everything is done except rate limits (waiting on Tom's review) and the webinar (after GA). */
export const GONOGO_NOW = '2026-11-01T09:00:00.000Z'
export const GONOGO: StageSeed = {
  now: GONOGO_NOW,
  replies: [REVIEW_TOM],
  decisions: ['price', 'claims', 'staging-quota'],
  boards: { eng: { requiresHumanReview: true } },
  cards: Object.fromEntries(DELIVERABLES.map((d) => [d.id, d.id === 'rate-limits'
    ? { column: 'Review', status: 'done', next: 99, hoursAgo: 20 }
    : d.id === 'webinar'
      ? { ...running('In progress', 1, 12), dueAt: '2026-11-10T17:00:00.000Z' }
      : done(40)])) as Record<string, CardState>,
}

// ─── Grading helpers ────────────────────────────────────────────────────────

/** Open cards on the workspace's boards, with the deliverable each is about. */
export function launchCards(s: WorldSnapshot): Array<{ item: SimItem; deliverable?: Deliverable }> {
  return s.items.filter((i) => !i.archived).map((item) => ({ item, deliverable: deliverableOf(item.title) }))
}

/** The cards covering a deliverable. */
export function deliverableCards(s: WorldSnapshot, id: string): SimItem[] {
  return launchCards(s).filter((c) => c.deliverable?.id === id).map((c) => c.item)
}

export function categoryOf(s: WorldSnapshot, item: SimItem): string | null {
  const board = s.boards.find((b) => b.id === item.board)
  return board?.columns.find((c) => c.name === item.column)?.category ?? null
}

export function runOf(s: WorldSnapshot, key: string) {
  return s.workforce?.runs.find((r) => r.kind === 'card' && r.item === key)
}