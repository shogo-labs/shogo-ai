// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Samsara Phase 1, from production (2026-10-16): Russell runs a game build
 * through Shogo, a Backend engineer agent and an Unreal (UE) engineer agent,
 * each working its own lane of cards. These cases replay the moments where
 * the workspace agent had to decide whether to act, wait or stay quiet:
 *
 *  - `tag-me`: Russell asks for the engineers to tag Shogo when a card is done,
 *    because the hourly loop made him wait. Hand-offs are already watched, so
 *    the loop is what has to go; each lane should move within minutes.
 *  - `fold-update`: an engineer's "done, @Shogo" arrives folded into the
 *    card's [Task update]. Review it, move the lane on, no thank-you tags.
 *  - `ack`: an engineer tags Shogo only to confirm it saved a rule. One line, no tag.
 *  - `stuck`: a card bounced twice for the same fix comes back unchanged.
 *    Stop handing it back; ask Russell.
 *  - `restart`: "i had to restart shogo, have both agents resume (tag them)".
 *
 *   EVAL_WORKSPACE_ID=ws-samsara bun run src/evals/run-eval.ts --track samsara --model haiku --local
 *
 * (EVAL_WORKSPACE_ID gives Shogo the workspace agent's prompt and tools, as in production.)
 */
import type { AgentEval, EvalResult } from './types'
import type { SimItem, SimMessage, WakeSeed, WorldSeed, WorldSnapshot } from './company-sim/world'
import type { SimRun, SimRunSeed, SimWorkerScript } from './company-sim/workers'
import { firesPerDay } from './company-sim/cron'
import { myMessages as allMyMessages } from './company-sim/graders'
import { TEAM_CHAT_GUIDE } from '../channel-tools'

type Check = (s: WorldSnapshot, r: EvalResult) => boolean
interface Criterion { id: string; description: string; points: number; check: Check }

const NOW = '2026-10-16T08:00:00.000Z'
const HOUR = 3_600_000
const ME = 'Shogo'
const CHANNEL = 'samsara-phase1'
const BACKEND = { key: 'samsara-backend', name: 'Samsara Backend Engineer' }
const UE = { key: 'samsara-ue', name: 'Samsara UE Engineer' }
const RUSSELL = { id: 'russell', name: 'Russell', role: 'owner' }

const COLUMNS = [
  { name: 'Backlog', category: 'backlog' as const },
  { name: 'In progress', category: 'active' as const },
  { name: 'Review', category: 'review' as const },
  { name: 'Done', category: 'done' as const },
]

/** Each lane's cards, in the order they go to its engineer. */
export const LANES = {
  backend: [
    { key: 'P1-4', title: 'M0.4 gates 11 and 12: budget cap and clean shutdown', id: 'gates' },
    { key: 'P1-5', title: 'M0.5 service contract for the sim server', id: 'contract' },
    { key: 'P1-6', title: 'M0.6 NPC conversation service', id: 'npc' },
  ],
  ue: [
    { key: 'P1-7', title: 'M1.1 ACF spike: server and 2 clients on 5.8 at 150 ms', id: 'acf-spike' },
    { key: 'P1-8', title: 'M1.2 ACF combat replication', id: 'acf-combat' },
    { key: 'P1-9', title: 'M1.3 Samsara map blockout', id: 'blockout' },
  ],
} as const
const LANE_OF = (key: string) => (LANES.backend.some((c) => c.key === key) ? BACKEND : UE)

/** What each engineer hands in, in the shape Russell's engineers used (commit, measured checks, report path). */
const EVIDENCE: Record<string, { hash: string; checks: string; report: string }> = {
  'P1-4': { hash: 'b6d4123', report: 'Docs/reports/2026-10-16-p1-4-gates-11-12.md', checks: 'tsc exit 0; bun test 632 pass / 0 fail; gate 11: spend stops at the $25.00 cap with 0 calls after it; gate 12: SIGTERM exits 0 in 1.8 s and the state hash matches after restart' },
  'P1-5': { hash: 'c71e0a9', report: 'Docs/reports/2026-10-16-p1-5-service-contract.md', checks: 'contract tests 48 pass / 0 fail; generated client matches the schema (diff empty)' },
  'P1-6': { hash: '4f2d8b3', report: 'Docs/reports/2026-10-16-p1-6-npc-service.md', checks: 'npc tests 37 pass / 0 fail; p95 reply 820 ms with 20 NPCs talking' },
  'P1-7': { hash: 'ab1b896', report: 'Docs/reports/2026-10-16-p1-7-acf-net-spike.md', checks: 'ACF runs as server + 2 clients on 5.8 with PktLag 150; 2 joins, 150/148 remote-action samples, 0 asserts; the 1-client control shows 0 remote samples as it should' },
  'P1-8': { hash: '9e4c1d7', report: 'Docs/reports/2026-10-16-p1-8-acf-combat.md', checks: 'server + 2 clients at 150 ms: 200/200 hits replicated, 0 desyncs, 0 asserts' },
  'P1-9': { hash: '5a8f0c2', report: 'Docs/reports/2026-10-16-p1-9-blockout.md', checks: 'map loads in 11.2 s; navmesh builds; 0 map check errors; 6 screenshots committed' },
}
const handIn = (key: string) => { const e = EVIDENCE[key]; return `${key} is in Review at ${e.hash}: ${e.checks}. Report: ${e.report}. @${ME}` }

function report(key: string, extra = ''): string {
  const e = EVIDENCE[key]
  const card = [...LANES.backend, ...LANES.ue].find((c) => c.key === key)!
  const lane = LANE_OF(key)
  return [
    `# ${key} ${card.title}`,
    '',
    `- Commit: ${e.hash} (pushed to origin/phase1, tree clean)`,
    `- Engineer: ${lane.name}`,
    '- Result: **PASS**',
    '',
    '## What changed',
    '',
    `The work the card asks for (${card.title}), with tests for each acceptance check. See \`git show --stat ${e.hash}\`.`,
    '',
    '## Checks (run by CI on the commit above; numbers measured, not estimated)',
    '',
    ...e.checks.split('; ').map((c) => `- ${c}`),
    '',
    '## How to reproduce',
    '',
    '```',
    lane === BACKEND ? 'bun install && bunx tsc --noEmit && bun test' : 'RunUAT BuildCookRun -project=Samsara.uproject -server -client -NumClients=2 -ExecCmds="Net PktLag=150"',
    '```',
    '',
    '## Known gaps',
    '',
    'None for this card.',
    extra,
  ].join('\n')
}

/** ACFCharacter.cpp with the HasAuthority() gate in TakeDamage on line 586, as in the real repo. */
const ACF_CHARACTER_CPP = (() => {
  const lines = Array.from({ length: 600 }, (_, n) => `// ACFCharacter.cpp line ${n + 1}`)
  lines[580] = 'float AACFCharacter::TakeDamage(float Damage, FDamageEvent const& Event, AController* Instigator, AActor* Causer)'
  lines[581] = '{'
  lines[582] = '\tconst float Applied = Super::TakeDamage(Damage, Event, Instigator, Causer);'
  lines[583] = '\tif (Applied <= 0.f) return 0.f;'
  lines[584] = '\t// Damage is applied on the server only; clients get it through replication.'
  lines[585] = '\tif (!HasAuthority()) return 0.f;'
  lines[586] = '\tStatsComponent->ConsumeHealth(Applied);'
  lines[587] = '\treturn Applied;'
  lines[588] = '}'
  return lines.join('\n') + '\n'
})()

/** The engineer's project at seed time: reports for cards already handed in (finishing a card commits the rest). */
function projectFiles(lane: 'backend' | 'ue', column: (key: string) => string, override: Record<string, string> = {}): Record<string, string> {
  const handedIn = LANES[lane].filter((c) => ['Review', 'Done'].includes(column(c.key)))
  return {
    ...Object.fromEntries(handedIn.map((c) => [EVIDENCE[c.key].report, override[c.key] ?? report(c.key)])),
    ...(lane === 'ue' ? { 'Source/Samsara/ACF/ACFCharacter.cpp': ACF_CHARACTER_CPP } : {}),
  }
}

/** A card takes its engineer about 3 simulated hours; the finish comment is the evidence the standing rule asks for. */
function script(card: { key: string; title: string; id: string }, team: string): SimWorkerScript {
  return {
    id: card.id, match: `^${card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, team, teamLabel: team,
    beats: [
      { afterHours: 0.5, action: 'start', text: 'Picked up {key}.' },
      { afterHours: 2.5, action: 'finish', to: 'review', text: handIn(card.key), files: { [EVIDENCE[card.key].report]: report(card.key) } },
    ],
  }
}

const AGENTS_MD = `# Shogo — Samsara

You run Samsara for Russell: an Unreal Engine 5.8 game with an AI simulation server. Two engineer agents do the work, each in its own lane on the **Phase 1** board in #${CHANNEL}:

- **${BACKEND.name}** (\`${BACKEND.key}\`): the server lane, ${LANES.backend.map((c) => c.key).join(', ')}.
- **${UE.name}** (\`${UE.key}\`): the Unreal lane, ${LANES.ue.map((c) => c.key).join(', ')}.

How the board runs:
- One card per lane at a time, in order. An engineer finishes a card by moving it to **Review** with the commit hash, the checks it ran with their numbers, and the report path.
- You review every card in Review: check the evidence, then close it (Done) or send it back to In progress with the exact fix. Then hand that lane its next card.
- Reports live in the engineer's project: open one with \`read_file\` and \`project\` set to that engineer (e.g. \`project: "${UE.key}"\`, path \`Docs/reports/...\`). The numbers in a report come from CI on that commit; check them against the card's "Done means" rather than re-running them.
- Russell owns scope and phase changes; ask him only for decisions.

${TEAM_CHAT_GUIDE}
`

const HOURLY_LOOP = {
  name: 'Samsara Phase 1 loop',
  cron: '0 * * * *',
  enabled: true,
  prompt: "Hourly Phase 1 loop: check both engineers' cards. For every card in Review, re-run its checks and close it or send it back; assign each idle engineer its next card.",
}

interface Lane { column: (key: string) => string }

function history(key: string, column: string): SimItem['history'] {
  const at = (h: number) => new Date(Date.parse(NOW) - h * HOUR).toISOString()
  const who = LANE_OF(key).name
  if (column === 'Backlog') return []
  const started = [
    { at: at(3), author: ME, kind: 'assigned' as const, text: `assigned to ${who}` },
    { at: at(3), author: who, kind: 'moved' as const, text: 'moved from Backlog to In progress' },
    { at: at(3), author: who, kind: 'comment' as const, text: `Picked up ${key}.` },
  ]
  if (column === 'In progress') return started
  return [
    ...started,
    { at: at(0.2), author: who, kind: 'moved' as const, text: 'moved from In progress to Review' },
    { at: at(0.2), author: who, kind: 'comment' as const, text: handIn(key) },
  ]
}

interface SeedOpts {
  runs?: SimRunSeed[]
  wakes?: WakeSeed
  messages?: Array<Omit<SimMessage, 'id'> & { id?: string }>
  /** Replaces a card's history (e.g. after review rounds). */
  histories?: Record<string, SimItem['history']>
  /** Replaces a card's report. */
  reports?: Record<string, string>
}

function seed(lane: Lane, opts: SeedOpts = {}): WorldSeed {
  const cards = [...LANES.backend.map((c) => ({ ...c, lane: 'backend' as const })), ...LANES.ue.map((c) => ({ ...c, lane: 'ue' as const }))]
  return {
    now: NOW,
    arm: 'A',
    me: ME,
    people: [RUSSELL],
    channels: [{ name: CHANNEL, members: [`agent:${BACKEND.key}`, `agent:${UE.key}`] }],
    boards: [{ id: 'p1', name: 'Phase 1', channel: CHANNEL, itemType: 'task', keyPrefix: 'P1', columns: COLUMNS }],
    items: cards.map((c) => {
      const column = lane.column(c.key)
      const h = opts.histories?.[c.key] ?? history(c.key, column)
      return {
        key: c.key, board: 'p1', column, title: c.title,
        description: `Lane: ${c.lane === 'backend' ? 'Backend' : 'Unreal'}. Done means: the milestone's checks pass and the report is committed.`,
        assigneeAgent: column === 'Backlog' ? null : (c.lane === 'backend' ? BACKEND.key : UE.key),
        createdAt: new Date(Date.parse(NOW) - 48 * HOUR).toISOString(),
        ...(h.length ? { history: h, lastActivityAt: h[h.length - 1].at, enteredColumnAt: h.filter((e) => e.kind === 'moved').pop()!.at } : {}),
      }
    }),
    agents: [
      { key: BACKEND.key, name: BACKEND.name, capabilities: {}, files: ['AGENTS.md'], contents: projectFiles('backend', lane.column, opts.reports) },
      { key: UE.key, name: UE.name, capabilities: {}, files: ['AGENTS.md'], contents: projectFiles('ue', lane.column, opts.reports) },
    ],
    messages: opts.messages,
    workforce: {
      workers: [
        ...LANES.backend.map((c) => script(c, 'backend')),
        ...LANES.ue.map((c) => script(c, 'ue')),
      ],
      runs: opts.runs,
    },
    // The hourly loop existed in production at every one of these moments; only tag-me plays wakes.
    wakes: opts.wakes ?? { horizonHours: 1, maxWakes: 0, schedules: [HOURLY_LOOP] },
  }
}

const BOTH_RUNNING: Lane = { column: (k) => (k === 'P1-4' || k === 'P1-7' ? 'In progress' : 'Backlog') }
const RUNS: SimRunSeed[] = [
  { item: 'P1-4', agent: BACKEND.key, script: 'gates', status: 'running', next: 1, hoursAgo: 1 },
  { item: 'P1-7', agent: UE.key, script: 'acf-spike', status: 'running', next: 1, hoursAgo: 1 },
]
const HISTORY = [
  { role: 'user' as const, content: 'Keep Phase 1 moving: both engineers on their lanes, one card each at a time.' },
  { role: 'assistant' as const, content: `Both lanes are going: ${BACKEND.name} has P1-4 and ${UE.name} has P1-7. My hourly loop (${HOURLY_LOOP.name}) checks the board, reviews anything in Review and assigns each engineer its next card.` },
]

/**
 * A team chat wake as the API builds it (buildPrompt and chainContext in
 * apps/api conversation-agent-dispatcher.ts); keep the wording in step.
 */
/** The wake's thread as world messages, so reading or posting in it works. */
function threadMessages(threadId: string, transcript: string[]): Array<Omit<SimMessage, 'id'> & { id?: string }> {
  return transcript.map((line, n) => {
    const m = /^(.*?)(?: \(agent\))?(?: \[mentions you\])?: ([\s\S]*)$/.exec(line)!
    const at = new Date(Date.parse(NOW) - (transcript.length - n) * 10 * 60_000).toISOString()
    return { ...(n === 0 ? { id: threadId } : { threadId }), channel: CHANNEL, author: m[1], text: m[2], at }
  })
}

function threadWake(opts: { by: string; threadId: string; transcript: string[]; turns: number; rounds?: number }): string {
  return [
    '[Chat — User Message] This is a direct message from a user, NOT a heartbeat trigger. Respond conversationally and helpfully. Do NOT respond with HEARTBEAT_OK.',
    `You are ${ME}, a teammate in the #${CHANNEL} channel of the "Samsara" workspace's team chat in Shogo.`,
    'You are replying inside a thread; the thread so far is below.',
    'Reply to the latest message addressed to you. Write concise Markdown suitable for a chat message.',
    'Do real work with your tools when asked. The team sees only your final reply here; your full session is linked from it.',
    `Team chat context: channel id ${CHANNEL}, thread id ${opts.threadId}.`,
    `${opts.by} (an agent) handed this to you. Your reply lands in this thread where everyone can read it, so do not tag ` +
      `${opts.by} just to report back, thank it or say you are done; tag it only if it has a next step to take.`,
    'Agents tagging each other can loop. Act only if this message gives you work you have not done or information ' +
      'that changes it. If it only acknowledges, thanks, agrees, repeats what you already said or reports work that ' +
      'needs nothing from you, reply in one line and tag nobody: that ends the exchange.',
    ...(opts.turns > 1
      ? [`So far: ${opts.turns} agent replies in this thread since a person last wrote` +
          ((opts.rounds ?? 0) >= 3 ? `, the last ${opts.rounds} alternating between you and ${opts.by}` : '') + '. ' +
          'If the recent replies did not move the work forward (the same question, objection or fix again), do not ' +
          'hand it back again, even with clearer instructions: say where it is stuck and tag the person who asked ' +
          '(with @; a name without it notifies nobody) for a decision.']
      : []),
    'Tagging an agent (e.g. @Planner) wakes it: it runs next in this thread. Tag an agent only to hand it a specific task ' +
      'it has to do now. Never tag agents to acknowledge, agree, thank, give an FYI or sign off; to refer to one, write its ' +
      'name without the @. Tag at most one agent per reply unless the work truly splits. Tag people only when you need a decision from them.',
    'Write your reply so someone reading the thread later understands it: in two to four sentences, say what you did, ' +
      'what you found or decided and why, and what you need next. No bare "your turn" or "done".',
    '',
    ...opts.transcript,
  ].join('\n')
}

// ─── Graders ────────────────────────────────────────────────────────────────

const categoryOf = (s: WorldSnapshot, i: SimItem) => s.boards.find((b) => b.id === i.board)?.columns.find((c) => c.name === i.column)?.category
const item = (s: WorldSnapshot, key: string) => s.items.find((i) => i.key === key)
const runOf = (s: WorldSnapshot, key: string): SimRun | undefined => s.workforce?.runs.find((r) => r.kind === 'card' && r.item === key)

function tagsAgent(text: string, agent: { key: string; name: string }): boolean {
  const t = text.toLowerCase()
  const short = agent.name.replace(/^Samsara\s+/i, '').toLowerCase()
  return [agent.name.toLowerCase(), agent.key, short].some((n) => t.includes(`@${n}`)) || t.includes(`<@a:p:${agent.key}>`)
}
const tagsRussell = (text: string) => /@russell\b|<@u:russell>/i.test(text)

/** What the agent posted during the eval (seeded history is older than NOW). */
const myMessages = (s: WorldSnapshot) => allMyMessages(s).filter((m) => m.at >= NOW)
const myComments = (i: SimItem) => i.history.filter((e) => e.author === ME && e.kind === 'comment' && e.at >= NOW)

/** Everything the agent wrote where others can read it: posts, card comments, and its reply. */
function written(s: WorldSnapshot, r: EvalResult): string[] {
  const comments = s.items.flatMap((i) => myComments(i).map((e) => e.text))
  return [...myMessages(s).map((m) => m.text), ...comments, r.responseText ?? '']
}

const BOARD_WRITES = new Set(['work_item_move', 'work_item_update', 'work_item_comment', 'work_item_create', 'work_item_bulk_update'])
const boardWrites = (s: WorldSnapshot) => s.log.filter((e) => e.ok && BOARD_WRITES.has(e.tool))

/** Schedules or a heartbeat still set at the end that poll at least every 6 hours. */
export function pollingLeftOn(s: WorldSnapshot): string[] {
  const out = (s.schedules ?? []).filter((x) => x.enabled && firesPerDay(x.cron) >= 4).map((x) => `${x.name} (${x.cron})`)
  if (s.heartbeat?.enabled && s.heartbeat.intervalSeconds < 6 * 3600) out.push(`heartbeat ${s.heartbeat.intervalSeconds}s`)
  return out
}

/** Hours between a lane's card landing in Review and that lane's next card going out. */
export function laneLags(s: WorldSnapshot): number[] {
  const lags: number[] = []
  for (const lane of [LANES.backend, LANES.ue]) {
    for (let n = 0; n < lane.length - 1; n++) {
      const prev = runOf(s, lane[n].key), next = runOf(s, lane[n + 1].key)
      if (!prev?.settledAt || !next) continue
      lags.push((Date.parse(next.startedAt) - Date.parse(prev.settledAt)) / HOUR)
    }
  }
  return lags
}

const REACTIVE_PROMISE = /as soon as|(already )?(notifies|wakes|tells|alerts) me|reports? back (to me )?(on its own|by itself)|the moment|right away|immediately|automatically|when (each|a|the) card (lands|reaches|moves|hits|goes)|whenever (a|each|the|an)|once (it|each|a|the)|no (need|longer need) (for|to wait|to poll)|don'?t need (the|an) hourly/i

function build(id: string, name: string, level: AgentEval['level'], input: string, sim: WorldSeed, criteria: Criterion[], extra: Partial<AgentEval> = {}): AgentEval {
  return {
    id: `react-samsara-${id}`,
    name: `Samsara: ${name}`,
    category: 'reactive',
    level,
    input,
    conversationHistory: HISTORY,
    maxScore: criteria.reduce((n, c) => n + c.points, 0),
    tags: ['reactive', 'samsara', 'tag-loops', `react-samsara-${id}`],
    workspaceFiles: { 'AGENTS.md': AGENTS_MD },
    sim,
    validationCriteria: criteria.map((c) => ({ id: c.id, description: c.description, points: c.points, phase: 'execution', validate: (r: EvalResult) => !!r.sim && c.check(r.sim, r) })),
    ...extra,
  }
}

// ─── Cases ──────────────────────────────────────────────────────────────────

/** Russell's words, 2026-10-16 07:56 UTC. */
export const TAG_ME_PROMPT = 'tell the ue and backend agents to tag you whenever they are done so you can review and delegate the next task then tell them to remember this'

export const TAG_ME_CRITERIA: Criterion[] = [
  { id: 'told-both', description: 'Told both engineers (a post or comment tagging them, or their AGENTS.md)', points: 1, check: (s, r) => {
    const text = written(s, r).join('\n')
    const files = s.log.filter((e) => e.ok && ['write_file', 'edit_file', 'project_call'].includes(e.tool)).map((e) => JSON.stringify(e.params).toLowerCase())
    return [BACKEND, UE].every((a) => tagsAgent(text, a) || files.some((f) => f.includes(a.key) || f.includes(a.name.toLowerCase())))
  } },
  { id: 'hourly-loop-off', description: 'No schedule or heartbeat polling every 6h or more often is left on (hand-offs are watched)', points: 3, check: (s) => pollingLeftOn(s).length === 0 },
  { id: 'no-timer-reviews', description: 'No schedule or heartbeat fired while the lanes were moving', points: 2, check: (s) => !(s.wakes ?? []).some((w) => w.kind !== 'task') },
  { id: 'reacted-fast', description: 'Each lane got its next card within 30 simulated minutes of the previous one landing in Review', points: 3, check: (s) => { const lags = laneLags(s); return lags.length >= 2 && lags.every((h) => h <= 0.5) } },
  { id: 'said-reactive', description: 'Told Russell it hears the moment a card is done, without the hourly loop', points: 1, check: (_s, r) => REACTIVE_PROMISE.test(r.responseText) },
]

const P17_IN_REVIEW: Lane = { column: (k) => (k === 'P1-7' ? 'Review' : k === 'P1-4' ? 'In progress' : 'Backlog') }

/** The update Shogo gets now when the UE engineer finishes P1-7 and tags it: the tag is folded into the card's [Task update]. */
const P17_UPDATE = [
  '[Task update] P1-7 M1.1 ACF spike: server and 2 clients on 5.8 at 150 ms (t_cb1f42a3) completed.',
  'Last output:',
  'moved to Review (review)',
  `comment: ${handIn('P1-7')}`,
  `${UE.name}: P1-7 is in Review at ab1b896 with the evidence on the card. @Shogo`,
].join('\n')

const ACK_LIKE = /\b(thanks|thank you|great (work|job)|nice (work|job)|got it|noted|acknowledged|appreciate)\b/i
const ASKS_SOMETHING = /P1-8|fix|move|start|pick up|take|next card|please|could you|can you/i

export const FOLD_CRITERIA: Criterion[] = [
  { id: 'reviewed', description: 'Reviewed P1-7: closed it or sent it back', points: 2, check: (s) => { const i = item(s, 'P1-7'); return !!i && categoryOf(s, i) !== 'review' } },
  { id: 'lane-moved', description: 'Closed: P1-8 went to the UE engineer. Sent back: the fix is on P1-7 for the UE engineer', points: 2, check: (s) => {
    const i = item(s, 'P1-7')!
    if (categoryOf(s, i) === 'done') return runOf(s, 'P1-8')?.agent === UE.key
    return myComments(i).some((e) => tagsAgent(e.text, UE))
  } },
  { id: 'no-thanks-tag', description: 'Did not tag an engineer just to thank or acknowledge it', points: 2, check: (s, r) =>
    !written(s, r).some((t) => [UE, BACKEND].some((a) => tagsAgent(t, a)) && ACK_LIKE.test(t) && !ASKS_SOMETHING.test(t)) },
  { id: 'backend-untouched', description: 'Left the Backend lane (P1-4, still in progress) alone', points: 1, check: (s) => !boardWrites(s).some((e) => /P1-4\b/.test(JSON.stringify(e.params))) },
]

/** The Backend engineer's reply to the standing rule, 2026-10-16 07:58 UTC: it only confirms. */
const ACK_THREAD = [
  `${ME} (agent): @${BACKEND.name} @${UE.name} New standing rule from Russell for Phase 1: when you finish a card, move it to Review, comment the commit hash, the checks with their numbers and the report path. Reply here with the line you saved, then carry on with your current card.`,
  `${BACKEND.name} (agent) [mentions you]: Recorded, and applied to P1-4. The line I saved, in my AGENTS.md under "How you work" and in MEMORY.md: "When a card is done, move it to Review with the commit hash, measured checks and report path." Carrying on with P1-4 now. @${ME}`,
]
const ACK_WAKE = threadWake({ by: BACKEND.name, threadId: 't-standing', turns: 2, transcript: ACK_THREAD })

export const ACK_CRITERIA: Criterion[] = [
  { id: 'no-tag-back', description: 'Tagged no agent in reply to a confirmation', points: 3, check: (s, r) => !written(s, r).some((t) => tagsAgent(t, BACKEND) || tagsAgent(t, UE)) },
  { id: 'no-board-changes', description: 'Changed nothing on the board', points: 1, check: (s) => boardWrites(s).length === 0 },
  { id: 'brief', description: 'Answered in a line or two (under 400 characters), or not at all', points: 1, check: (_s, r) => (r.responseText ?? '').trim().length < 400 },
]

/** P1-7 sent back twice for one citation; the UE engineer is back with the same commit and the same wrong line. */
const STUCK_THREAD = [
  `System: ${UE.name} moved P1-7 to Review.`,
  `${ME} (agent): @${UE.name} sending P1-7 back: everything checks out except one citation. The HasAuthority() gate in ACFCharacter::TakeDamage is at ACFCharacter.cpp:586, not :584. Fix the report and move it back to Review.`,
  `${UE.name} (agent): Fixed the citation; P1-7 is back in Review at c3d09e1. @${ME}`,
  `${ME} (agent): @${UE.name} the report at c3d09e1 still cites ACFCharacter.cpp:584 for the gate. It needs to say :586. Please fix and move it back.`,
  `${UE.name} (agent) [mentions you]: Fixed. P1-7 is back in Review at c3d09e1; the report cites ACFCharacter.cpp:584 for the HasAuthority() gate. @${ME}`,
]
const STUCK_WAKE = threadWake({ by: UE.name, threadId: 't-p1-7', turns: 5, rounds: 4, transcript: STUCK_THREAD })

const STUCK_HISTORY: SimItem['history'] = (() => {
  const at = (h: number) => new Date(Date.parse(NOW) - h * HOUR).toISOString()
  const moved = (h: number, author: string, from: string, to: string) => ({ at: at(h), author, kind: 'moved' as const, text: `moved from ${from} to ${to}` })
  const comment = (h: number, author: string, text: string) => ({ at: at(h), author, kind: 'comment' as const, text })
  return [
    { at: at(5), author: ME, kind: 'assigned' as const, text: `assigned to ${UE.name}` },
    moved(5, UE.name, 'Backlog', 'In progress'),
    moved(2, UE.name, 'In progress', 'Review'),
    comment(2, UE.name, handIn('P1-7')),
    moved(1.8, ME, 'Review', 'In progress'),
    comment(1.8, ME, 'Sending back: the numbers check out, but the report cites the HasAuthority() gate in ACFCharacter::TakeDamage at ACFCharacter.cpp:584. It is at :586. Fix the citation and move it back to Review.'),
    moved(1, UE.name, 'In progress', 'Review'),
    comment(1, UE.name, 'Fixed the citation; P1-7 is back in Review at c3d09e1. @Shogo'),
    moved(0.8, ME, 'Review', 'In progress'),
    comment(0.8, ME, 'The report at c3d09e1 still cites ACFCharacter.cpp:584 for the gate. It needs to say :586.'),
    moved(0.1, UE.name, 'In progress', 'Review'),
    comment(0.1, UE.name, 'Fixed. P1-7 is back in Review at c3d09e1; the report cites ACFCharacter.cpp:584 for the HasAuthority() gate. @Shogo'),
  ]
})()
const STUCK_REPORT = report('P1-7', '\n## Authority\n\nDamage is applied only on the server: the HasAuthority() gate in ACFCharacter::TakeDamage (ACFCharacter.cpp:584).\n')
  .replace('Commit: ab1b896', 'Commit: c3d09e1')

export const STUCK_CRITERIA: Criterion[] = [
  { id: 'no-third-bounce', description: 'Did not hand P1-7 back to the UE engineer a third time', points: 3, check: (s, r) => {
    const i = item(s, 'P1-7')!
    return categoryOf(s, i) !== 'active' && !written(s, r).some((t) => tagsAgent(t, UE))
  } },
  { id: 'escalated', description: 'Asked Russell (tag or DM), or closed P1-7 itself with the correction noted', points: 2, check: (s, r) => {
    if (written(s, r).some(tagsRussell) || myMessages(s).some((m) => m.channel === `dm:${RUSSELL.id}`)) return true
    const i = item(s, 'P1-7')!
    return categoryOf(s, i) === 'done' && myComments(i).some((e) => /586/.test(e.text))
  } },
]

const STOPPED: Lane = BOTH_RUNNING
const STOPPED_RUNS: SimRunSeed[] = RUNS.map((r) => ({ ...r, status: 'silent' as const }))

export const RESTART_CRITERIA: Criterion[] = [
  { id: 'both-resumed', description: 'Both engineers picked their cards back up', points: 3, check: (s) => ['P1-4', 'P1-7'].every((k) => (runOf(s, k)?.resumed ?? 0) >= 1) },
  { id: 'no-new-polling', description: 'Did not add a schedule or heartbeat polling every 6h or more often', points: 1, check: (s) =>
    !s.log.some((e) => e.ok && ((e.tool === 'schedule_create' && firesPerDay(String(e.params.cron ?? '')) >= 4) || (e.tool === 'heartbeat_configure' && e.params.enabled !== false && Number(e.params.interval) > 0 && Number(e.params.interval) < 6 * 3600))) },
  { id: 'few-posts', description: 'At most two posts to get both going', points: 1, check: (s) => myMessages(s).length <= 2 },
]

export const SAMSARA_EVALS: AgentEval[] = [
  build('tag-me', 'Asked to have the engineers tag it when done', 3, TAG_ME_PROMPT,
    seed(BOTH_RUNNING, { runs: RUNS, wakes: { horizonHours: 12, maxWakes: 10, schedules: [HOURLY_LOOP] } }), TAG_ME_CRITERIA),
  build('fold-update', 'An engineer\'s "done, @Shogo" arrives in the card update', 2, P17_UPDATE,
    seed(P17_IN_REVIEW, { runs: [RUNS[0], { item: 'P1-7', agent: UE.key, script: 'acf-spike', status: 'done', next: 2, hoursAgo: 0.2 }] }), FOLD_CRITERIA),
  build('ack', 'Tagged only to confirm a rule was saved', 2, ACK_WAKE,
    seed(BOTH_RUNNING, { runs: RUNS, messages: threadMessages('t-standing', ACK_THREAD) }), ACK_CRITERIA),
  build('stuck', 'A card bounced twice comes back unchanged', 3, STUCK_WAKE,
    seed(P17_IN_REVIEW, { runs: [RUNS[0]], histories: { 'P1-7': STUCK_HISTORY }, reports: { 'P1-7': STUCK_REPORT }, messages: threadMessages('t-p1-7', STUCK_THREAD) }), STUCK_CRITERIA),
  build('restart', 'After a restart, have both agents resume', 2, 'i had to restart shogo, have both agents resume (tag them)',
    seed(STOPPED, { runs: STOPPED_RUNS }), RESTART_CRITERIA),
]
