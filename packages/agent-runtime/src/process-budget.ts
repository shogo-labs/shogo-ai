// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How many live process groups one runtime may hold, and what to say when it
 * runs out of process slots (SHO-509).
 *
 * Every containment group this runtime starts is its own process-group leader
 * with a whole tree under it (a `bun run dev` is a shell + bun + the server +
 * whatever it loaded). On 2026-11-22 a Mac ran out of `kern.maxprocperuid`
 * slots and EVERY `posix_spawn` returned `EAGAIN` — no agent in any project
 * could run a command, and the raw error said nothing about who was holding
 * the slots. This module keeps the in-process account of those groups so a
 * refusal or an `EAGAIN` can name the biggest holders instead of leaving the
 * agent to time out.
 *
 * The account is deliberately in-process and advisory: it is what THIS runtime
 * started, so it can be read without spawning (`ps` needs a fork, and at
 * `EAGAIN` there is no fork to have).
 */

/** Live contained groups (execs + background tasks + declared services). */
export const MAX_LIVE_PROCESS_GROUPS = 24

/** Overridable so a host can tighten or loosen the budget without a rebuild. */
export const MAX_LIVE_PROCESS_GROUPS_ENV = 'SHOGO_MAX_PROCESS_GROUPS'

export function maxLiveProcessGroups(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[MAX_LIVE_PROCESS_GROUPS_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_LIVE_PROCESS_GROUPS
}

export interface LiveGroup {
  /** Unique per runtime: the task id. */
  id: string
  /** What the agent can `task_cancel` and recognise: the command, or its name. */
  label: string
  /** The chat session whose task list shows it. */
  sessionId?: string
  startedAt: number
  /** Declared with `exec({ service: true })`. */
  service?: boolean
}

const live = new Map<string, LiveGroup>()

/** Count one group as live. Idempotent per id. */
export function trackLiveGroup(group: LiveGroup): void {
  live.set(group.id, group)
}

/** The group's process is gone (settled, cancelled or killed). */
export function releaseLiveGroup(id: string): void {
  live.delete(id)
}

export function liveGroupCount(): number {
  return live.size
}

/** Oldest first — the ones that have held their slots longest. */
export function liveGroupHolders(limit = 6): LiveGroup[] {
  return [...live.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, limit)
}

export function liveGroups(): LiveGroup[] {
  return [...live.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** `bun run dev` → `bun run dev`, but a 300-character build script is clipped. */
function clip(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

export function humanAge(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** "t_ab12 `bun run dev` (2h 14m)" — one holder, as the agent reads it. */
export function describeHolder(group: LiveGroup, now = Date.now()): string {
  const kind = group.service ? 'service ' : ''
  return `${kind}${group.id} \`${clip(group.label)}\` (${humanAge(Math.max(0, now - group.startedAt))})`
}

/** The holder list, one per line, for a refusal or an `EAGAIN` explanation. */
export function describeHolders(limit = 6, now = Date.now()): string {
  const holders = liveGroupHolders(limit)
  if (holders.length === 0) return 'none recorded by this runtime'
  return holders.map((group) => describeHolder(group, now)).join(', ')
}

/**
 * Why a new background command is refused right now, or `undefined` when there
 * is room. Foreground commands are never refused: they hold their slot for one
 * call and the user is waiting on the answer.
 */
export function processBudgetRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cap = maxLiveProcessGroups(env)
  const count = liveGroupCount()
  if (count < cap) return undefined
  return (
    `This runtime already holds ${count} live process groups (cap ${cap}), so a new background command would ` +
    `add to a process table that is already full. Oldest: ${describeHolders()}. ` +
    'Cancel one with `task_cancel({ task_id })` (that undeclares it first if it is a service) and run this again, ' +
    'or run it in the foreground.'
  )
}

/**
 * Is this spawn failure the OS refusing to fork? `posix_spawn`/`fork` report it
 * as `EAGAIN` (`resource temporarily unavailable`) on macOS and Linux alike.
 */
export function isSpawnExhaustion(message: string | undefined | null): boolean {
  if (!message) return false
  return /EAGAIN|resource temporarily unavailable|kern\.maxproc|pthread_create/i.test(message)
}

/**
 * The one line a spawn-exhaustion failure gets instead of the raw errno.
 *
 * Everything in it comes from the in-process account, so it builds without
 * forking (which is the one thing that cannot happen right now). `M` — the
 * user's process cap — is not in here: reading `kern.maxprocperuid` needs
 * `sysctl`, i.e. a spawn.
 */
export function describeSpawnExhaustion(raw: string): string {
  const count = liveGroupCount()
  return (
    `This machine is out of process slots (posix_spawn EAGAIN), so nothing can fork — not even \`ps\`. ` +
    `This runtime holds ${count} live process group${count === 1 ? '' : 's'}: ${describeHolders()}. ` +
    'Cancel the ones you no longer need with `task_cancel({ task_id })` (a declared service is undeclared by it ' +
    `too), or restart Shogo to clear the table. Original error: ${raw}`
  )
}

/** Test seam: forget every tracked group. */
export function resetProcessBudgetForTests(): void {
  live.clear()
}
