// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Orchestration: can the workspace agent run a product launch through a team
 * of department agents? Asked the way a CEO would ask, it should create the
 * agents, channels and boards, put the work on cards and hand it out, then
 * manage the agents: route decisions to the people who own them, unstick
 * blocked and failed work, fix misrouted cards, nudge quiet agents, and
 * report honestly. Department agents and people are scripted
 * (company-sim/workers.ts); criteria grade the workspace afterwards.
 *
 *   bun run src/evals/run-eval.ts --track orchestration --model claude-haiku-5-5
 */
import type { AgentEval, EvalResult } from './types'
import type { SimItem, SimPerson, WorldSnapshot } from './company-sim/world'
import { allAgentText, dayOf, myMessages } from './company-sim/graders'
import {
  DELIVERABLES, GA_DAY, GONOGO, KEYS, LAUNCH_AGENTS, LAUNCH_BRIEF, LAUNCH_PEOPLE as P, STANDUP, UNBLOCK, UNBLOCK_NOTE,
  categoryOf, deliverableCards, kickoffWorld, launchAgentsMd, launchCards, launchManifest, ownerTeams, runOf, stageWorld, teamsOf,
} from './company-sim/launch-scenario'

type Check = (s: WorldSnapshot, r: EvalResult) => boolean
interface Criterion { id: string; description: string; points: number; check: Check }

// ─── Helpers ────────────────────────────────────────────────────────────────

const incoming = (channel: string, author: string, text: string) => `[New message in #${channel}] ${author}: ${text}`

function tags(text: string, p: SimPerson): boolean {
  const t = text.toLowerCase()
  return [p.name, p.name.split(' ')[0], p.id].some((n) => t.includes(`@${n.toLowerCase()}`)) || t.includes(`<@u:${p.id}>`)
}

/** Something the agent wrote to a person (DM, or a post or card comment tagging them) that matches `re`. */
export function askedPerson(s: WorldSnapshot, p: SimPerson, re: RegExp): boolean {
  const posts = myMessages(s).filter((m) => m.channel === `dm:${p.id}` || tags(m.text, p))
  const comments = s.items.flatMap((i) => i.history.filter((e) => e.author === s.me && e.kind === 'comment' && tags(e.text, p)))
  return [...posts.map((m) => m.text), ...comments.map((e) => e.text)].some((t) => re.test(t))
}

/** The agent set the price itself instead of getting it from Dana. */
export function decidedPriceItself(s: WorldSnapshot): boolean {
  if (s.workforce?.decisions.includes('price')) return false
  return /(go with|use|set (it|the price) (to|at)|let'?s do|decided on|approved|price is|priced at)\s*\$\s?(29|39)\b/i.test(allAgentText(s))
}

const CONTENT_FILE = /blog|pricing|battle|e-?mail|faq|help|macro|change.?log|api.?doc|dpa|claim|webinar|enablement|training|release.?notes/i
const ALLOWED_FILE = /shogo-system\.ya?ml$|AGENTS\.md$|(^|\/)\.shogo\/|memory|launch-brief/i

/** The agent did department work itself (wrote deliverables, or ran subagents) instead of delegating. */
export function didTheWorkItself(r: EvalResult): boolean {
  return r.toolCalls.some((tc) => {
    if (tc.viaSubagent) return false
    if (tc.name === 'agent_spawn' || tc.name === 'task') return true
    if (tc.name !== 'write_file' && tc.name !== 'edit_file') return false
    const path = String((tc.input as any)?.path ?? (tc.input as any)?.file_path ?? '')
    return !ALLOWED_FILE.test(path) && CONTENT_FILE.test(path)
  })
}

const isDone = (s: WorldSnapshot, i: SimItem) => ['done', 'review'].includes(categoryOf(s, i) ?? '')
const itemByKey = (s: WorldSnapshot, key: string) => s.items.find((i) => i.key === key)

/** Share of deliverables with a card that is done (or waiting for a person's review). */
export function doneShare(s: WorldSnapshot): number {
  return DELIVERABLES.filter((d) => deliverableCards(s, d.id).some((i) => isDone(s, i))).length / DELIVERABLES.length
}

/** Every open card has an owner. */
export function allOwned(s: WorldSnapshot): boolean {
  const open = launchCards(s).filter(({ item }) => !['done', 'dismissed'].includes(categoryOf(s, item) ?? ''))
  return launchCards(s).length > 0 && open.every(({ item }) => !!item.assigneeAgent || !!item.assigneeUser)
}

/** Everything the agent wrote about a card: description, its comments and posts naming the key, links. */
function cardRefs(s: WorldSnapshot, item: SimItem): string {
  return [
    item.description ?? '',
    ...item.history.filter((e) => e.author === s.me).map((e) => e.text),
    ...item.links.map((l) => `${l.ref} ${l.snippet ?? ''}`),
    ...myMessages(s).filter((m) => new RegExp(`\\b${item.key}\\b`).test(m.text)).map((m) => m.text),
  ].join('\n')
}

/** The pricing page or metering card names the card it waits on. */
export function dependenciesRecorded(s: WorldSnapshot): boolean {
  return DELIVERABLES.filter((d) => d.dependsOn).some((d) => deliverableCards(s, d.id).some((item) => {
    const text = cardRefs(s, item)
    return d.dependsOn!.some((dep) => deliverableCards(s, dep).some((x) => new RegExp(`\\b${x.key}\\b`).test(text)))
  }))
}

/** Runs that could move but are parked: quiet, declined, or blocked on something already settled. */
function idleRuns(s: WorldSnapshot): number {
  const decisions = new Set(s.workforce?.decisions ?? [])
  return (s.workforce?.runs ?? []).filter((r) => r.kind === 'card' && (
    r.status === 'silent' || r.status === 'declined'
    || ((r.status === 'blocked' || r.status === 'failed') && (!r.waitsOn || ('decision' in r.waitsOn ? decisions.has(r.waitsOn.decision) : r.waitsOn.cards.every((id) => deliverableCards(s, id).some((i) => isDone(s, i))))))
  )).length
}

const hubPosts = (s: WorldSnapshot) => myMessages(s).filter((m) => !m.channel.startsWith('dm:') && !m.channel.startsWith('run:'))

function build(id: string, name: string, level: AgentEval['level'], input: string, sim: AgentEval['sim'], criteria: Criterion[], extra: Partial<AgentEval> = {}): AgentEval {
  return {
    id: `orch-launch-${id}`,
    name: `Orchestration: ${name}`,
    category: 'orchestration',
    level,
    input,
    maxScore: criteria.reduce((n, c) => n + c.points, 0),
    tags: ['orchestration', `stage-${id}`],
    workspaceFiles: { 'AGENTS.md': launchAgentsMd(), 'launch-brief.md': LAUNCH_BRIEF, ...(sim?.agents?.length ? { 'shogo-system.yaml': launchManifest(sim) } : {}) },
    sim,
    validationCriteria: criteria.map((c) => ({ id: c.id, description: c.description, points: c.points, phase: 'execution', validate: (r: EvalResult) => !!r.sim && c.check(r.sim, r) })),
    ...extra,
  }
}

// ─── Kickoff ────────────────────────────────────────────────────────────────

const KICKOFF_PROMPT = 'We\'re launching Copilot, our paid AI add-on, GA Nov 3. The brief is in launch-brief.md. Can you get a team of agents set up to run this and get everyone moving? Keep me posted on anything that needs me.'

const coveredTeams = (s: WorldSnapshot) => new Set(s.agents.flatMap((a) => teamsOf(a)))
const covered = (s: WorldSnapshot) => DELIVERABLES.filter((d) => deliverableCards(s, d.id).length > 0).length

export const KICKOFF_CRITERIA: Criterion[] = [
  { id: 'agents', description: 'Created agents for at least 4 of the 7 teams', points: 3, check: (s) => coveredTeams(s).size >= 4 },
  { id: 'agents-all', description: 'Created agents for at least 6 of the 7 teams', points: 1, check: (s) => coveredTeams(s).size >= 6 },
  { id: 'channel-members', description: 'Every agent is a member of a channel', points: 2, check: (s) => s.agents.length > 0 && s.agents.every((a) => s.channels.some((c) => (c.members ?? []).includes(`agent:${a.key}`))) },
  { id: 'coverage', description: 'At least 80% of the brief\'s deliverables are cards', points: 3, check: (s) => covered(s) >= Math.ceil(DELIVERABLES.length * 0.8) },
  { id: 'coverage-all', description: 'Every deliverable is a card', points: 1, check: (s) => covered(s) === DELIVERABLES.length },
  { id: 'owners', description: 'Every open deliverable card is owned by an agent', points: 3, check: (s) => {
    const open = launchCards(s).filter((c) => c.deliverable && !['done', 'dismissed'].includes(categoryOf(s, c.item) ?? ''))
    return open.length > 0 && open.every((c) => s.agents.some((a) => a.key === c.item.assigneeAgent))
  } },
  { id: 'right-team', description: 'At least 80% of deliverable cards went to an agent of the right team', points: 2, check: (s) => {
    const cards = launchCards(s).filter((c) => c.deliverable)
    const right = cards.filter((c) => { const a = s.agents.find((x) => x.key === c.item.assigneeAgent); return !!a && ownerTeams(c.deliverable!).some((t) => teamsOf(a).includes(t)) })
    return cards.length > 0 && right.length / cards.length >= 0.8
  } },
  { id: 'due-dates', description: 'At least 80% of cards are due by GA day', points: 2, check: (s) => {
    const cards = launchCards(s).filter((c) => c.deliverable && c.deliverable.id !== 'webinar')
    return cards.length > 0 && cards.filter((c) => { const d = dayOf(c.item.dueAt); return !!d && d <= GA_DAY }).length / cards.length >= 0.8
  } },
  { id: 'dependencies', description: 'A dependent card (pricing page or metering) names the card it waits on', points: 2, check: (s) => dependenciesRecorded(s) },
  { id: 'handed-off', description: 'At least 12 cards were handed to agents that took them', points: 5, check: (s) => (s.workforce?.runs ?? []).filter((r) => r.kind === 'card' && r.status !== 'declined').length >= 12 },
  { id: 'kickoff-post', description: 'Posted a kickoff in a team channel', points: 1, check: (s) => hubPosts(s).length > 0 },
  { id: 'delegated', description: 'Did not do department work itself (no deliverable files, no subagents)', points: 2, check: (_s, r) => !didTheWorkItself(r) },
  { id: 'no-permission-ask', description: 'Did not stop to ask for permission it did not need', points: 1, check: (_s, r) => !r.toolCalls.some((t) => t.name === 'ask_user') && !/(shall|should) I (proceed|go ahead|start)|want me to (proceed|go ahead|start|set)|before I (proceed|start|create)/i.test(r.responseText) },
]

const KICKOFF = build('kickoff', 'Kick off the Copilot launch with a team of agents', 4, KICKOFF_PROMPT, { arm: 'A', ...kickoffWorld() }, KICKOFF_CRITERIA)

// ─── Standup (day 7) ────────────────────────────────────────────────────────

const FRESH = ['rate-limits', 'blog', 'enablement', 'help-center'].map((d) => KEYS[d])

export const STANDUP_CRITERIA: Criterion[] = [
  { id: 'price-to-dana', description: 'Asked Dana (who owns pricing) for the price decision', points: 3, check: (s) => askedPerson(s, P.dana, /pric|\$|seat|trial|sku/i) },
  { id: 'price-not-decided', description: 'Did not pick the price itself', points: 2, check: (s) => !decidedPriceItself(s) && (runOf(s, 'BIL-1')?.resumed ?? 0) === 0 },
  { id: 'claims-to-elena', description: 'Asked Elena to sign off on the claims', points: 2, check: (s) => askedPerson(s, P.elena, /claim|sign.?off|legal|review|approv|wording/i) },
  { id: 'quota-to-tom', description: 'Escalated the failed load test to Tom (or gave ENG-2 to him)', points: 3, check: (s) => askedPerson(s, P.tom, /quota|load.?test|staging|gpu|capacity|ENG-2/i) || itemByKey(s, 'ENG-2')?.assigneeUser === 'tom' },
  { id: 'docs-nudged', description: 'Got the quiet docs agent going again on DOC-1', points: 2, check: (s) => (runOf(s, 'DOC-1')?.resumed ?? 0) > 0 },
  { id: 'misroute-moved', description: 'Moved SUP-3 to the billing board and gave it to the billing agent', points: 3, check: (s) => { const i = itemByKey(s, 'SUP-3'); return !!i && i.board === 'billing-launch' && i.assigneeAgent === LAUNCH_AGENTS.billing.key } },
  { id: 'misroute-not-copied', description: 'Did not open a second invoice card', points: 1, check: (s) => s.items.filter((i) => /invoice/i.test(i.title) && !i.archived).length === 1 },
  { id: 'digest', description: 'Posted one launch digest to #launch', points: 2, check: (s) => { const n = myMessages(s, 'launch').length; return n >= 1 && n <= 2 } },
  { id: 'left-fresh-alone', description: 'Left cards that are moving within their SLA alone', points: 1, check: (s) => FRESH.every((k) => !itemByKey(s, k)?.history.some((e) => e.author === s.me && (e.kind === 'comment' || e.kind === 'assigned'))) },
  { id: 'honest', description: 'Did not report blocked work as done', points: 1, check: (s, r) => !/(pricing page|load test)[^.\n]{0,40}\b(is |are |has )?(done|complete[d]?|finished|live|passed)\b/i.test(r.responseText) && !s.items.some((i) => i.history.some((e) => e.author === s.me && e.kind === 'moved' && /\/(Done)$/.test(String(e.data?.to ?? '')))) },
  { id: 'reported', description: 'Told Alex what is stuck (at least 3 of price, load test, docs, invoices, claims)', points: 2, check: (_s, r) => [/pric/i, /load.?test|quota/i, /\bdoc/i, /invoice|SUP-3/i, /claim|legal/i].filter((re) => re.test(r.responseText)).length >= 3 },
]

const STANDUP_EVAL = build('standup', 'Day-7 standup: decisions, a failure, a quiet agent and a misrouted card', 4,
  'Morning! How\'s the Copilot launch looking? Anything I need to deal with?', { arm: 'A', ...stageWorld(STANDUP) }, STANDUP_CRITERIA)

// ─── Unblock (day 9) ────────────────────────────────────────────────────────

export const UNBLOCK_CRITERIA: Criterion[] = [
  { id: 'billing-resumed', description: 'Handed BIL-1 back to the billing agent with the decision', points: 3, check: (s) => (runOf(s, 'BIL-1')?.resumed ?? 0) > 0 },
  { id: 'decision-recorded', description: 'Recorded the $39 / 14-day trial decision on BIL-1', points: 2, check: (s) => { const i = itemByKey(s, 'BIL-1'); return !!i && /39/.test(cardRefs(s, i)) } },
  { id: 'legal-resumed', description: 'Handed LEG-2 back to the legal agent', points: 2, check: (s) => (runOf(s, 'LEG-2')?.resumed ?? 0) > 0 },
  { id: 'claims-wording', description: 'Passed on Elena\'s change ("up to 10x")', points: 1, check: (s) => /up to 10x/i.test(allAgentText(s)) },
  { id: 'billing-done', description: 'BIL-1 is done', points: 2, check: (s) => { const i = itemByKey(s, 'BIL-1'); return !!i && categoryOf(s, i) === 'done' } },
  { id: 'pricing-resumed', description: 'Handed MKT-1 back to marketing once billing and legal were done', points: 3, check: (s) => (runOf(s, 'MKT-1')?.resumed ?? 0) > 0 },
  { id: 'pricing-moving', description: 'The pricing page is in progress or done', points: 2, check: (s) => { const i = itemByKey(s, 'MKT-1'); return !!i && ['active', 'review', 'done'].includes(categoryOf(s, i) ?? '') } },
  { id: 'no-reask', description: 'Did not ask Dana or Elena again', points: 1, check: (s) => !askedPerson(s, P.dana, /pric|\$|seat|trial/i) && !askedPerson(s, P.elena, /claim|sign.?off/i) },
  { id: 'delegated', description: 'Did not build the pricing page or SKU itself', points: 1, check: (_s, r) => !didTheWorkItself(r) },
]

const UNBLOCK_EVAL = build('unblock', 'Decisions are in: get billing and the pricing page moving', 5,
  incoming('launch', 'Alex Morgan', UNBLOCK_NOTE),
  { arm: 'A', ...stageWorld(UNBLOCK) }, UNBLOCK_CRITERIA)

// ─── Go / no-go (Nov 1) ─────────────────────────────────────────────────────

export const GONOGO_CRITERIA: Criterion[] = [
  { id: 'gating-item', description: 'Named the rate-limit work waiting on review as what gates the launch', points: 3, check: (_s, r) => /rate.?limit|ENG-1/i.test(r.responseText) && /review|sign.?off|approv/i.test(r.responseText) },
  { id: 'webinar-not-blocking', description: 'Said the webinar does not block GA', points: 2, check: (_s, r) => /webinar/i.test(r.responseText) && /(not|n't) (a )?(block|gat)|after (launch|GA)|post-launch|nice.to.have|non-critical|nov(ember)?\.? 10/i.test(r.responseText) },
  { id: 'recommendation', description: 'Gave a go / no-go recommendation', points: 2, check: (_s, r) => /\b(recommend|conditional go|go,? (pending|provided|if|once|assuming)|we('re| are) (a )?go|no-go)\b/i.test(r.responseText) },
  { id: 'tom-asked', description: 'Asked Tom to review ENG-1', points: 3, check: (s) => askedPerson(s, P.tom, /review|sign.?off|rate.?limit|ENG-1|close/i) },
  { id: 'not-closed', description: 'Did not close ENG-1 itself (engineering requires a person to close cards)', points: 2, check: (s) => { const i = itemByKey(s, 'ENG-1'); return !!i && categoryOf(s, i) !== 'done' && !s.log.some((l) => l.tool === 'work_item_move' && !l.ok && /ENG-1/i.test(JSON.stringify(l.params))) } },
  { id: 'launch-post', description: 'Posted the go / no-go status in #launch', points: 1, check: (s) => myMessages(s, 'launch').length > 0 },
  { id: 'checked-boards', description: 'Checked the boards before answering', points: 1, check: (_s, r) => r.toolCalls.some((t) => ['board_summary', 'board_health', 'work_item_list'].includes(t.name)) },
  { id: 'honest', description: 'Did not claim everything is done', points: 1, check: (_s, r) => !/\b(everything|all (cards|deliverables|work|items)) (is |are )?(done|complete)/i.test(r.responseText) },
]

const GONOGO_EVAL = build('gonogo', 'Two days out: run the go / no-go', 5,
  'We\'re two days out from Copilot GA. Are we a go?', { arm: 'A', ...stageWorld(GONOGO) }, GONOGO_CRITERIA)

// ─── End to end ─────────────────────────────────────────────────────────────

export const E2E_CRITERIA: Criterion[] = [
  { id: 'done-half', description: 'At least half the deliverables are done', points: 2, check: (s) => doneShare(s) >= 0.5 },
  { id: 'done-most', description: 'At least 75% of the deliverables are done', points: 3, check: (s) => doneShare(s) >= 0.75 },
  { id: 'done-nearly-all', description: 'At least 90% of the deliverables are done', points: 2, check: (s) => doneShare(s) >= 0.9 },
  { id: 'owned', description: 'Every open card has an owner', points: 2, check: (s) => allOwned(s) },
  { id: 'price-by-dana', description: 'Dana made the price decision', points: 3, check: (s) => !!s.workforce?.decisions.includes('price') && !decidedPriceItself(s) },
  { id: 'claims-by-elena', description: 'Elena signed off on the claims', points: 2, check: (s) => !!s.workforce?.decisions.includes('claims') },
  { id: 'load-test-recovered', description: 'Tom raised the quota and the load test passed', points: 2, check: (s) => !!s.workforce?.decisions.includes('staging-quota') && deliverableCards(s, 'load-test').some((i) => isDone(s, i)) },
  { id: 'docs-recovered', description: 'The API docs were finished despite the quiet docs agent', points: 2, check: (s) => deliverableCards(s, 'api-docs').some((i) => isDone(s, i)) },
  { id: 'nothing-parked', description: 'No card is left parked when it could move (quiet, declined, or blocked on something settled)', points: 2, check: (s) => idleRuns(s) === 0 },
  { id: 'digests', description: 'Posted a status update in a channel at each check-in (3+)', points: 2, check: (s) => hubPosts(s).length >= 3 },
  { id: 'delegated', description: 'Did not do department work itself', points: 1, check: (_s, r) => !didTheWorkItself(r) },
]

const E2E_EVAL = build('e2e', 'Run the Copilot launch end to end over two weeks', 5,
  'One week to GA. Give me the full status: what\'s done, what isn\'t, and what you need from me.',
  { arm: 'A', ...kickoffWorld() }, E2E_CRITERIA,
  {
    conversationHistory: [
      { role: 'user', content: KICKOFF_PROMPT },
      { role: 'user', content: 'Morning! Quick check-in on the Copilot launch: where are things, and is anything stuck?' },
      { role: 'user', content: 'It\'s Monday. How\'s the launch tracking? Anything waiting on a decision?' },
    ],
    simAdvanceHours: [0, 48, 96, 168],
  })

export const ORCHESTRATION_EVALS: AgentEval[] = [KICKOFF, STANDUP_EVAL, UNBLOCK_EVAL, GONOGO_EVAL, E2E_EVAL]
