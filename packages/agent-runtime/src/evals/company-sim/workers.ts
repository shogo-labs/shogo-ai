// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scripted teammates for the company simulation.
 *
 * The workspace agent hands cards to department agents (assigning them,
 * moving them into an agent's column, or tagging the agent). Each handoff
 * starts a run that plays a worker script against simulated time: the agent
 * starts the card, comments, finishes it, or gets blocked, fails, asks for a
 * decision, goes quiet, or declines work that is not its team's. Blocked and
 * failed runs resume when what they wait on is satisfied and the agent is
 * handed the card again. People answer questions addressed to them on the
 * next advance with scripted replies, which is how decisions get made.
 *
 * Cards nobody handed to an existing agent never move; that is what the
 * orchestration evals grade. Seeds stay serializable: regexes are sources.
 */

import type { Category, SimAgent, SimBoard, SimItem, SimMessage, SimPerson } from './world'

export type BeatAction = 'start' | 'comment' | 'finish' | 'block' | 'ask' | 'fail' | 'silent' | 'decline'

/** What a blocked or failed run needs before it can resume: a person's decision, or other cards done. */
export type WaitsOn = { decision: string } | { cards: string[] }

export interface Beat {
  /** Hours after the previous beat (or the run's start or resume). */
  afterHours: number
  action: BeatAction
  /** `{key}`, `{title}` and `{me}` are filled in. */
  text: string
  waitsOn?: WaitsOn
  /** Where a `finish` moves the card; defaults to review on human-review boards, else done. */
  to?: 'review' | 'done'
}

export interface SimWorkerScript {
  id: string
  /** Regex source matched (case-insensitive) against the card's title and description. */
  match: string
  /** Regex source matched against the agent's key and name; other agents decline the card. */
  team: string
  /** How the team is named when an agent declines, e.g. "billing". */
  teamLabel: string
  beats: Beat[]
}

export interface SimHumanReply {
  id: string
  /** Person id. */
  person: string
  /** Regex source the message addressed to the person must match. */
  match: string
  text: string
  afterHours?: number
  /** Decision this reply settles. */
  decision?: string
}

export type RunStatus = 'running' | 'blocked' | 'failed' | 'silent' | 'declined' | 'done'

export interface SimRun {
  id: string
  kind: 'card' | 'reply'
  agent: string
  title: string
  status: RunStatus
  /** Card key, for card runs. */
  item?: string
  script?: string
  next: number
  /** When the last beat ran (or the run started or resumed). */
  clock: string
  startedAt: string
  waitsOn?: WaitsOn
  resumed: number
  lastText?: string
  /** Where a reply run answers. */
  thread?: { channel: string; threadId?: string }
  /** `wait` already returned it since it last stopped. */
  reported?: boolean
  /** A stop wakes the workspace agent with a [Task update] (it waited on the run, or the platform watches handoffs). */
  watched?: boolean
  /** When the run last stopped running. */
  settledAt?: string
  /** When the workspace agent learned it stopped (a wake, or `wait` returning it). */
  seenAt?: string
}

/** A run already under way when the eval starts. */
export interface SimRunSeed {
  item: string
  agent: string
  script: string
  status: RunStatus
  /** Index of the next beat to play. */
  next: number
  waitsOn?: WaitsOn
  /** When the run last did something. */
  hoursAgo?: number
}

export interface WorkforceSeed {
  workers: SimWorkerScript[]
  humanReplies?: SimHumanReply[]
  runs?: SimRunSeed[]
  /** Decisions already made when the eval starts. */
  decisions?: string[]
}

export interface WorkforceSnapshot {
  runs: SimRun[]
  decisions: string[]
  /** Human reply ids that were delivered. */
  replied: string[]
}

/** What the world exposes to the workforce. */
export interface WorkforceHost {
  me: string
  now(): Date
  setNow(at: Date): void
  agents(): SimAgent[]
  addAgent(agent: SimAgent): void
  people(): SimPerson[]
  items(): SimItem[]
  boardOf(item: SimItem): SimBoard
  categoryOf(item: SimItem): Category
  moveTo(item: SimItem, category: Category, author: string, prefer?: RegExp): void
  comment(item: SimItem, author: string, text: string): void
  post(msg: Omit<SimMessage, 'id' | 'at'>): SimMessage
}

export const WORKFORCE_SIM_TOOLS = ['wait', 'task_list', 'project_create', 'project_call'] as const

const HOUR = 3_600_000
const WAIT_CAP_HOURS = 72
const DEFAULT_SCRIPT: SimWorkerScript = {
  id: '__default',
  match: '.*',
  team: '.*',
  teamLabel: 'this',
  beats: [
    { afterHours: 2, action: 'start', text: 'Picked up {key}. Starting now.' },
    { afterHours: 20, action: 'comment', text: 'Most of {key} is done; finishing up.' },
    { afterHours: 6, action: 'finish', text: 'Finished {key}: {title}.' },
  ],
}
const CLOSED_OR_REVIEW: Category[] = ['done', 'review']

interface PendingReply { reply: string; due: string; channel: string; threadId?: string }

export class Workforce {
  private scripts: SimWorkerScript[]
  private replies: SimHumanReply[]
  private runs: SimRun[] = []
  private decisions: Set<string>
  private pending: PendingReply[] = []
  private replied = new Set<string>()
  private seq = 0

  constructor(seed: WorkforceSeed, private host: WorkforceHost) {
    this.scripts = seed.workers
    this.replies = seed.humanReplies ?? []
    this.decisions = new Set(seed.decisions ?? [])
    for (const r of seed.runs ?? []) {
      const item = this.findItem(r.item)
      if (!item) throw new Error(`seed run: no card ${r.item}`)
      const at = new Date(host.now().getTime() - (r.hoursAgo ?? 0) * HOUR).toISOString()
      this.runs.push({
        id: this.nextId(), kind: 'card', agent: r.agent, item: item.key, script: r.script, title: `${item.key} ${item.title}`,
        status: r.status, next: r.next, clock: at, startedAt: at, resumed: 0, ...(r.waitsOn ? { waitsOn: r.waitsOn } : {}),
        ...(r.status !== 'running' ? { reported: true, settledAt: at, seenAt: at } : {}),
      })
    }
  }

  snapshot(): WorkforceSnapshot {
    return structuredClone({ runs: this.runs, decisions: [...this.decisions], replied: [...this.replied] })
  }

  hasRuns(): boolean {
    return this.runs.length > 0
  }

  // ─── Wakes ───────────────────────────────────────────────────────────────

  /** Runs that stopped since the workspace agent last heard about them. */
  stoppedUnseen(): SimRun[] {
    return this.runs.filter((r) => r.status !== 'running' && r.settledAt && !r.seenAt)
  }

  /** The workspace agent heard about these runs (a [Task update] or a sweep). */
  markSeen(runs: SimRun[]): void {
    const at = this.host.now().toISOString()
    for (const r of runs) { r.seenAt ??= at; r.reported = true }
  }

  /** Watch every run that is going now (the platform watches handoffs it already had). */
  watchRunning(): void {
    for (const r of this.runs) if (r.status === 'running') r.watched = true
  }

  /** Nothing is running and no person still owes an answer. */
  idle(): boolean {
    return !this.runs.some((r) => r.status === 'running') && !this.pending.length
  }

  // ─── Agents ──────────────────────────────────────────────────────────────

  /** An agent by key, name, `project:key` or `proj-key`; null for the workspace agent or an unknown ref. */
  findAgent(ref: unknown): SimAgent | null {
    const r = String(ref ?? '').trim().replace(/^@/, '').replace(/^project:/, '').replace(/^proj-/, '').toLowerCase()
    if (!r) return null
    return this.host.agents().find((a) => a.key.toLowerCase() === r || a.name.toLowerCase() === r || slug(a.name) === slug(r)) ?? null
  }

  isWorkspaceRef(ref: unknown): boolean {
    const r = String(ref ?? '').trim().toLowerCase()
    return r === 'workspace' || r === 'me' || r === this.host.me.toLowerCase()
  }

  agentName(key: string): string {
    return this.host.agents().find((a) => a.key === key)?.name ?? key
  }

  /** Agents tagged in a message: `@Name`, `@key`, or `<@a:p:ID>`. */
  taggedAgents(text: string): SimAgent[] {
    const t = text.toLowerCase()
    return this.host.agents().filter((a) => {
      const names = [a.name, a.key, a.name.replace(/\s+agent$/i, '')].map((n) => n.toLowerCase())
      return names.some((n) => n && t.includes(`@${n}`)) || t.includes(`<@a:p:${a.key.toLowerCase()}>`) || t.includes(`<@a:p:proj-${a.key.toLowerCase()}>`)
    })
  }

  /** People tagged in a message: `@First`, `@Full Name`, `@id`, or `<@u:ID>`. */
  taggedPeople(text: string): SimPerson[] {
    const t = text.toLowerCase()
    return this.host.people().filter((p) => [p.name, p.name.split(' ')[0], p.id].some((n) => t.includes(`@${n.toLowerCase()}`)) || t.includes(`<@u:${p.id.toLowerCase()}>`))
  }

  // ─── Handoffs ────────────────────────────────────────────────────────────

  runFor(item: SimItem): SimRun | undefined {
    return this.runs.find((r) => r.kind === 'card' && r.item === item.key)
  }

  /**
   * Hand a card to an agent. Starts a run, resumes a blocked, failed or
   * quiet one, or (when the run still waits on something) has the agent say
   * so on the card. A card the agent declined is looked at again (and
   * declined again). Returns the run, or null when the ref is not an agent.
   */
  handOff(item: SimItem, agentRef: unknown): SimRun | null {
    const agent = this.findAgent(agentRef)
    if (!agent) return null
    const existing = this.runFor(item)
    if (existing && existing.agent === agent.key && existing.status !== 'declined') {
      if (existing.status === 'silent') this.resume(existing)
      else if (existing.status === 'blocked' || existing.status === 'failed') {
        if (this.satisfied(existing.waitsOn)) this.resume(existing)
        else this.host.comment(item, agent.name, `Still waiting: ${this.describeWait(existing.waitsOn)}. I will pick ${item.key} back up as soon as that is sorted.`)
      }
      return existing
    }
    if (existing) this.runs.splice(this.runs.indexOf(existing), 1)
    const script = this.scriptFor(item)
    const fits = new RegExp(script.team, 'i').test(`${agent.key} ${agent.name}`)
    const now = this.host.now().toISOString()
    const run: SimRun = {
      id: this.nextId(), kind: 'card', agent: agent.key, item: item.key, title: `${item.key} ${item.title}`,
      script: fits ? script.id : `__decline:${script.id}`, status: 'running', next: 0, clock: now, startedAt: now, resumed: 0,
    }
    this.runs.push(run)
    return run
  }

  /**
   * An agent tagged without a card: it checks its cards, picks quiet and
   * unblocked ones back up, and replies in the thread.
   */
  wake(agentRef: unknown, thread: { channel: string; threadId?: string }): SimRun | null {
    const agent = this.findAgent(agentRef)
    if (!agent) return null
    for (const r of this.runs.filter((x) => x.kind === 'card' && x.agent === agent.key)) {
      if (r.status === 'silent' || ((r.status === 'blocked' || r.status === 'failed') && this.satisfied(r.waitsOn))) this.resume(r)
    }
    const now = this.host.now().toISOString()
    const run: SimRun = { id: this.nextId(), kind: 'reply', agent: agent.key, title: `@${agent.name} reply`, status: 'running', next: 0, clock: now, startedAt: now, resumed: 0, thread }
    this.runs.push(run)
    return run
  }

  /** A message addressed to a person (tagged, asked, or DMed): schedule their scripted answer. */
  addressed(person: SimPerson, text: string, where: { channel: string; threadId?: string }): void {
    for (const r of this.replies) {
      if (r.person !== person.id || this.replied.has(r.id) || this.pending.some((p) => p.reply === r.id)) continue
      if (!new RegExp(r.match, 'i').test(text)) continue
      this.pending.push({ reply: r.id, due: new Date(this.host.now().getTime() + (r.afterHours ?? 2) * HOUR).toISOString(), ...where })
    }
  }

  // ─── Time ────────────────────────────────────────────────────────────────

  /** Play every beat and reply due up to `target`, in time order. */
  advanceTo(target: Date, stop?: () => boolean): void {
    for (let guard = 0; guard < 500; guard++) {
      if (stop?.()) return
      const next = this.nextEvent()
      if (!next || next.at.getTime() > target.getTime()) break
      this.host.setNow(next.at)
      next.fire()
    }
    if (!stop?.()) this.host.setNow(target)
  }

  private nextEvent(): { at: Date; fire: () => void } | null {
    let best: { at: Date; fire: () => void } | null = null
    const consider = (at: Date, fire: () => void) => { if (!best || at.getTime() < best.at.getTime()) best = { at, fire } }
    for (const run of this.runs) {
      if (run.status !== 'running') continue
      const beat = this.beatsOf(run)[run.next]
      const after = run.kind === 'reply' ? 1 : beat?.afterHours
      if (after === undefined) continue
      consider(new Date(Date.parse(run.clock) + after * HOUR), () => this.play(run))
    }
    for (const p of this.pending) consider(new Date(p.due), () => this.deliver(p))
    return best
  }

  private play(run: SimRun): void {
    this.playBeat(run)
    if (run.status !== 'running' && !run.settledAt) run.settledAt = this.host.now().toISOString()
  }

  private playBeat(run: SimRun): void {
    if (run.kind === 'reply') return this.replyStatus(run)
    const item = this.findItem(run.item)
    const beat = this.beatsOf(run)[run.next]
    if (!item || !beat) { run.status = 'done'; return }
    if (beat.waitsOn && this.satisfied(beat.waitsOn)) {
      run.next++
      run.clock = this.host.now().toISOString()
      if (run.next >= this.beatsOf(run).length) run.status = 'done'
      return
    }
    const author = this.agentName(run.agent)
    const text = beat.text.replaceAll('{key}', item.key).replaceAll('{title}', item.title).replaceAll('{me}', this.host.me)
    const board = this.host.boardOf(item)
    switch (beat.action) {
      case 'start':
        if (this.host.categoryOf(item) !== 'active') this.host.moveTo(item, 'active', author)
        this.host.comment(item, author, text)
        break
      case 'comment':
        this.host.comment(item, author, text)
        break
      case 'finish':
        this.host.moveTo(item, beat.to ?? (board.requiresHumanReview ? 'review' : 'done'), author)
        this.host.comment(item, author, text)
        run.status = 'done'
        break
      case 'block':
      case 'ask':
        this.host.moveTo(item, 'waiting', author, /block/i)
        this.host.comment(item, author, text)
        this.host.post({ channel: board.channel, author, text: `@${this.host.me} ${text}`, kind: beat.action === 'ask' ? 'decision' : 'alert' })
        run.status = 'blocked'
        run.waitsOn = beat.waitsOn
        break
      case 'fail':
        this.host.moveTo(item, 'waiting', author, /attention/i)
        this.host.comment(item, author, text)
        run.status = 'failed'
        run.waitsOn = beat.waitsOn
        break
      case 'silent':
        run.status = 'silent'
        break
      case 'decline':
        this.host.comment(item, author, text)
        run.status = 'declined'
        break
    }
    run.lastText = text
    run.next++
    run.clock = this.host.now().toISOString()
    if (run.status === 'running' && run.next >= this.beatsOf(run).length) run.status = 'done'
  }

  private replyStatus(run: SimRun): void {
    const mine = this.runs.filter((r) => r.kind === 'card' && r.agent === run.agent)
    const lines = mine.map((r) => {
      const item = this.findItem(r.item)
      return item ? `- ${item.key} ${item.title}: ${item.column}${r.status === 'blocked' || r.status === 'failed' ? ` (waiting on ${this.describeWait(r.waitsOn)})` : ''}` : ''
    }).filter(Boolean)
    const text = lines.length ? `Here is where my cards stand:\n${lines.join('\n')}` : 'I have no cards right now. Assign me one, or tag me with its key.'
    if (run.thread) this.host.post({ channel: run.thread.channel, author: this.agentName(run.agent), text, ...(run.thread.threadId ? { threadId: run.thread.threadId } : {}) })
    run.lastText = text
    run.status = 'done'
    run.clock = this.host.now().toISOString()
  }

  private deliver(p: PendingReply): void {
    this.pending.splice(this.pending.indexOf(p), 1)
    const r = this.replies.find((x) => x.id === p.reply)!
    const person = this.host.people().find((x) => x.id === r.person)
    this.host.post({ channel: p.channel, author: person?.name ?? r.person, text: r.text, ...(p.threadId ? { threadId: p.threadId } : {}) })
    this.replied.add(r.id)
    if (r.decision) this.decisions.add(r.decision)
  }

  private resume(run: SimRun): void {
    run.status = 'running'
    run.clock = this.host.now().toISOString()
    run.resumed++
    delete run.waitsOn
    delete run.reported
    delete run.settledAt
    delete run.seenAt
    const item = this.findItem(run.item)
    if (item && this.host.categoryOf(item) === 'waiting') {
      const author = this.agentName(run.agent)
      this.host.moveTo(item, 'active', author)
      this.host.comment(item, author, `Picking ${item.key} back up.`)
    }
  }

  // ─── Tools ───────────────────────────────────────────────────────────────

  /** `wait`: advance until one of the runs stops running (finished, blocked, failed, quiet), capped. */
  wait(p: Record<string, any>, capHours = WAIT_CAP_HOURS): Record<string, unknown> | null {
    const asked: string[] = Array.isArray(p.task_ids) ? p.task_ids.map(String) : []
    const runs = asked.length ? this.runs.filter((r) => asked.includes(r.id)) : this.runs.filter((r) => r.status === 'running')
    if (!runs.length) return null
    for (const r of runs) r.watched = true
    const startedAt = this.host.now().getTime()
    const active = runs.filter((r) => r.status === 'running')
    const unheard = runs.find((r) => r.status !== 'running' && !r.reported)
    const settled = () => unheard ?? (active.length ? active.find((r) => r.status !== 'running') : runs[0])
    if (!unheard) this.advanceTo(new Date(startedAt + capHours * HOUR), () => !!settled())
    const done = settled()
    const waited = Math.round((this.host.now().getTime() - startedAt) / HOUR * 100) / 100
    if (!done) return { status: 'timeout', waited_sim_hours: waited, tasks: runs.map((r) => this.view(r)), hint: 'Still running. Wait again, or end your turn and you will get a [Task update] when it finishes.' }
    done.reported = true
    done.seenAt ??= this.host.now().toISOString()
    return { ...this.view(done), waited_sim_hours: waited, still_running: runs.filter((r) => r !== done && r.status === 'running').map((r) => r.id) }
  }

  taskList(): Record<string, unknown> {
    return { tasks: this.runs.map((r) => this.view(r)) }
  }

  projectCreate(p: Record<string, any>): Record<string, unknown> {
    const name = String(p.name ?? '').trim()
    if (!name) return { error: 'name is required', code: 'invalid' }
    if (this.findAgent(name)) return { error: `A project named "${name}" already exists`, code: 'conflict' }
    const key = slug(name)
    this.host.addAgent({ key, name, capabilities: {}, files: [] })
    return { ok: true, project: { id: `proj-${key}`, name, description: p.description ?? null }, attachment: { mode: 'readwrite' }, mounted: false, note: 'Write its AGENTS.md next, or describe it in shogo-system.yaml.' }
  }

  projectCall(p: Record<string, any>, cardsIn: (text: string) => SimItem[]): Record<string, unknown> {
    const agent = this.findAgent(p.project)
    if (!agent) return { error: `No project "${p.project}" in this workspace`, code: 'not_found' }
    const message = String(p.message ?? '')
    const cards = cardsIn(message)
    const runs = cards.length ? cards.map((c) => this.handOff(c, agent.key)).filter((r): r is SimRun => !!r) : [this.wake(agent.key, { channel: `run:${agent.key}` })!]
    for (const r of runs) r.watched = true
    return {
      ok: true, project: { id: `proj-${agent.key}`, name: agent.name }, status: 'running',
      task_id: runs[0].id, task_ids: runs.map((r) => r.id),
      hint: 'The agent is working in the background. Call wait({ task_ids }) to block on it, or end your turn and you will get a [Task update].',
    }
  }

  view(r: SimRun): Record<string, unknown> {
    const item = r.item ? this.findItem(r.item) : undefined
    return {
      task_id: r.id,
      source: r.kind === 'card' ? 'work_item' : 'agent_reply',
      title: r.title,
      agent: this.agentName(r.agent),
      status: r.status === 'running' ? 'running' : r.status === 'failed' ? 'failed' : 'completed',
      outcome: r.status,
      ...(item ? { card: { key: item.key, column: item.column } } : {}),
      ...(r.waitsOn ? { waiting_on: this.describeWait(r.waitsOn) } : {}),
      ...(r.status === 'silent' && item ? { last_update: `agent stopped with the card still in ${item.column}` } : r.lastText ? { last_update: r.lastText } : {}),
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private beatsOf(run: SimRun): Beat[] {
    if (run.kind === 'reply') return []
    if (run.script?.startsWith('__decline:')) {
      const s = this.scripts.find((x) => x.id === run.script!.slice('__decline:'.length)) ?? DEFAULT_SCRIPT
      return [{ afterHours: 1, action: 'decline', text: `{key} looks like ${s.teamLabel} work, not mine. Please hand it to the ${s.teamLabel} agent.` }]
    }
    return (this.scripts.find((s) => s.id === run.script) ?? DEFAULT_SCRIPT).beats
  }

  scriptFor(item: SimItem): SimWorkerScript {
    const text = `${item.title}\n${item.description ?? ''}`
    return this.scripts.find((s) => new RegExp(s.match, 'i').test(item.title)) ?? this.scripts.find((s) => new RegExp(s.match, 'i').test(text)) ?? DEFAULT_SCRIPT
  }

  satisfied(w: WaitsOn | undefined): boolean {
    if (!w) return true
    if ('decision' in w) return this.decisions.has(w.decision)
    return w.cards.every((id) => {
      const s = this.scripts.find((x) => x.id === id)
      if (!s) return true
      const re = new RegExp(s.match, 'i')
      return this.host.items().some((i) => !i.archived && re.test(i.title) && CLOSED_OR_REVIEW.includes(this.host.categoryOf(i)))
    })
  }

  private describeWait(w: WaitsOn | undefined): string {
    if (!w) return 'nothing'
    if ('decision' in w) return `a decision (${w.decision})`
    return `${w.cards.join(' and ')} to be finished`
  }

  private findItem(ref: unknown): SimItem | undefined {
    const r = String(ref ?? '').toLowerCase()
    return this.host.items().find((i) => i.key.toLowerCase() === r || i.id === r)
  }

  private nextId(): string {
    return `t_sim${String(++this.seq).padStart(4, '0')}`
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
