// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TaskRegistry — per-session bookkeeping for background tasks.
 *
 * A task is anything the agent started that keeps running after the tool
 * call returned: a shell command (`exec` with `background: true` or past its
 * soft timeout), a background subagent, or a remote task tracked by the API
 * (a `project_call` run, a tagged agent's reply, a card change). Every source
 * has the same shape, the same `t_xxxx` id, the same output file format, and
 * the same completion note, so the agent only has to learn one rule:
 * `wait` on the id, or end the turn and get a `[Task update]`.
 *
 * The registry also feeds the UI (`listRunning` / `listVisible` / `onChange`)
 * and persists a snapshot so the list survives restarts. Finished entries
 * linger for ~10 minutes so a late `wait` can still read the result.
 */

import { randomBytes } from 'crypto'
import { join, relative } from 'path'
import type { CommandHandle } from './sandbox-exec'
import {
  TaskOutputWriter,
  readTaskOutput,
  tailLines,
  taskOutputBody,
  type TaskOutputRow,
} from './task-output'

/** How long to keep finished entries around so a post-hoc `wait` works. */
export const COMPLETED_RETENTION_MS = 10 * 60 * 1000
/**
 * How long a finished entry whose result nobody has read is kept. Retention is
 * a lease released by `markConsumed`, not an eviction: the short window only
 * applies once the agent that started the task has seen the result. This bound
 * stops the map growing without limit, and the output file outlives it.
 */
export const UNREAD_RETENTION_MS = 24 * 60 * 60 * 1000
/** How long a shell command must run before it is shown in the chat dock. */
export const UI_VISIBLE_AFTER_MS = 30_000
/** Rolling in-memory output window per non-shell task, used by `until` matching. */
const RECENT_OUTPUT_CHARS = 256 * 1024
/** Polling interval for `until` regex checks. */
const UNTIL_POLL_MS = 250
/** Upper bound on a single remote long-poll request. */
const REMOTE_POLL_SLICE_MS = 25_000
/** A client that answers before `waitMs` must not turn the wait into a hot loop. */
const REMOTE_MIN_POLL_GAP_MS = 500

export type TaskSource = 'shell' | 'subagent' | 'project_call' | 'agent_reply' | 'work_item'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Where a task's work is actually happening. The chat dock opens this instead
 * of the runtime-local log, so pressing a background row lands on the agent's
 * thread (a channel thread, a card, a project session) rather than an empty
 * file. `log` is the local output file, used by shell commands.
 */
export type TaskLink =
  | { kind: 'log'; path?: string }
  | { kind: 'project_session'; projectId: string; chatSessionId?: string; name?: string }
  | { kind: 'subagent'; projectId?: string; chatSessionId?: string; toolCallId: string }
  | { kind: 'channel_thread'; workspaceId?: string; conversationId: string; threadRootId: string; title?: string }
  | {
      kind: 'card'
      workspaceId?: string
      conversationId: string
      threadRootId: string
      itemId: string
      itemKey: string
      board: string
    }

export interface TaskResult {
  exitCode?: number
  summary: string
}

type ShellFinalResult = { exitCode: number; stdout: string; stderr: string; killed: boolean; killReason?: string }

export interface TaskEntry {
  id: string
  /** Alias of `id`, kept for the legacy shell-run vocabulary. */
  runId: string
  source: TaskSource
  title: string
  /** Shell tasks: the exact command. Other sources: same as `title`. */
  command: string
  status: TaskStatus
  startedAt: number
  finishedAt?: number
  result?: TaskResult
  /** Wake the agent when this task finishes (default true). */
  notify: boolean
  /** The agent already saw the final result through `wait`. */
  consumed: boolean
  /** The agent was told this task runs in the background. Only these produce notes. */
  backgrounded?: boolean
  /** Restored after a runtime restart; the local process is gone. */
  stale?: boolean
  /**
   * It was in the dock before the restart. A restored terminal row has no live
   * duration to compare against the visibility delay, so it says so directly.
   */
  shown?: boolean
  /** Status comes from a client (the API, or another project's runtime); this entry mirrors it. */
  remote?: boolean
  /** Tracked by the API, which also wakes the agent itself when it finishes. */
  apiTracked?: boolean
  /** Its completion was handed to the API to wake an idle session. */
  reported?: boolean
  /** Not tracked yet: hidden and silent until the agent first waits on it. */
  dormant?: boolean
  /** Source-specific reference (subagent instance id, remote target, ...). */
  ref?: string
  /** Where this task's work is happening, for the dock's "open the thread" action. */
  link?: TaskLink
  /** Wake text the API formatted for this task, when it finished. */
  remoteNote?: string
  /** Absolute path of the output file, when output files are enabled. */
  outputFile?: string
  /** Shell tasks only. */
  handle?: CommandHandle
  finalResult?: ShellFinalResult
  /** Rebuilt from its output file after its entry was evicted. */
  recovered?: boolean
  /** Arms the retention window for this entry's finished result. */
  retentionTimer?: ReturnType<typeof setTimeout>
  /** Resolves when the task leaves the `running` state. */
  done: Promise<void>
  visibilityTimer?: ReturnType<typeof setTimeout>
}

/** Shell entries always carry a process handle. */
export type CommandEntry = TaskEntry & { handle: CommandHandle }

/** Live view of a task for tools and the UI. */
export interface RunningProcess {
  id: string
  runId: string
  source: TaskSource
  title: string
  command: string
  status: TaskStatus
  pid: number | undefined
  sandboxed: boolean
  containerName?: string
  startedAt: number
  elapsedMs: number
  finishedAt?: number
  outputFile?: string
  notify: boolean
  remote?: boolean
  stale?: boolean
  /** Where the task's work is happening (thread, card, project session, log). */
  link?: TaskLink
  /**
   * Finished, but its update is still queued behind a paused wake: the session
   * has not been given it yet. Set by the gateway from the API's wake state.
   */
  waiting?: boolean
}

/** Serializable subset persisted into session metadata so the list survives restart. */
export interface RunningProcessSnapshot {
  runId: string
  command: string
  pid: number | undefined
  sandboxed: boolean
  containerName?: string
  startedAt: number
  source?: TaskSource
  title?: string
  remote?: boolean
  ref?: string
  outputFile?: string
  /** Where the task's work is happening; survives a restart with the row. */
  link?: TaskLink
  /** Terminal rows keep their outcome and freeze so a restart still lists them. */
  status?: TaskStatus
  finishedAt?: number
  /** The snapshot was taken from a row the dock was showing. */
  shown?: boolean
  /** The agent has seen this result; a restart must not turn an unread one read. */
  consumed?: boolean
  /** The agent was told it runs in the background (only these own their result). */
  backgrounded?: boolean
}

export interface TaskNotification {
  taskId: string
  source: TaskSource
  title: string
  status: TaskStatus
  exitCode?: number
  outputFile?: string
  tail: string
  remote?: boolean
  /** When the task settled; a turn only injects notes that finished after it started. */
  finishedAt?: number
}

/** API-side task state, as returned by the internal task routes. */
export interface RemoteTaskState {
  id: string
  status: TaskStatus
  output?: string
  result?: TaskResult
  matched?: boolean
  /** Where the API says the task's work is happening. */
  link?: TaskLink
  /** The API's formatted wake text, when the task has settled. */
  note?: string
}

/** Transport for remote tasks; implemented over the internal API by the gateway. */
export interface RemoteTaskClient {
  get(id: string, opts?: { waitMs?: number; until?: string }): Promise<RemoteTaskState | null>
  cancel(id: string): Promise<void>
  consume(ids: string[]): Promise<void>
}

export interface WaitOutcome {
  kind: 'finished' | 'matched' | 'timeout'
  task?: TaskEntry
  matched?: string
}

export interface TaskHandle {
  entry: TaskEntry
  append(chunk: string): void
  finish(status: Exclude<TaskStatus, 'running'>, result: TaskResult): void
}

type ChangeListener = (running: RunningProcess[]) => void
type NotificationListener = (notification: TaskNotification) => void

export interface TaskRegistryOptions {
  uiVisibleAfterMs?: number
  /** Directory for per-task output files. Omit to disable output files. */
  outputDir?: string
  /** Workspace root, used to report output files as workspace-relative paths. */
  workspaceDir?: string
  remote?: RemoteTaskClient
  /** How long a finished result the agent already read is kept. */
  retentionMs?: number
  /** How long a finished result nobody read is kept. */
  unreadRetentionMs?: number
  /** How many unread finished results may sit in memory before the oldest go. */
  maxUnconsumed?: number
  /**
   * Find a task's log after its entry was evicted, so `resolveFinished` can
   * rebuild the result instead of reporting the task as unknown.
   */
  resolveOutputRow?: (id: string) => TaskOutputRow | null
}

export function newTaskId(): string {
  return `t_${randomBytes(4).toString('hex')}`
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

export function formatTaskNotification(n: TaskNotification): string {
  const outcome =
    n.status === 'cancelled'
      ? 'was cancelled'
      : n.exitCode !== undefined
        ? `${n.status} (exit code ${n.exitCode})`
        : n.status
  const lines = [`[Task update] ${n.title} (${n.taskId}) ${outcome}.`]
  if (n.outputFile) lines.push(`Output: ${n.outputFile}`)
  if (n.tail.trim()) lines.push('Last output:', n.tail)
  return lines.join('\n')
}

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>()
  private aliases = new Map<string, string>()
  private writers = new Map<string, TaskOutputWriter>()
  private recent = new Map<string, string>()
  private resolvers = new Map<string, () => void>()
  private cancels = new Map<string, () => void | Promise<void>>()
  private clients = new Map<string, RemoteTaskClient>()
  private listeners = new Set<ChangeListener>()
  private notificationListeners = new Set<NotificationListener>()
  private pendingWaits = new Map<string, number>()
  private completionNotes = new Map<string, TaskNotification>()
  private readonly uiVisibleAfterMs: number
  private readonly outputDir?: string
  private readonly workspaceDir?: string
  private readonly retentionMs: number
  private readonly unreadRetentionMs: number
  private readonly maxUnconsumed: number
  private readonly findOutputRow?: (id: string) => TaskOutputRow | null
  remote?: RemoteTaskClient

  constructor(options: TaskRegistryOptions = {}) {
    this.uiVisibleAfterMs = options.uiVisibleAfterMs ?? UI_VISIBLE_AFTER_MS
    this.outputDir = options.outputDir
    this.workspaceDir = options.workspaceDir
    this.remote = options.remote
    this.retentionMs = options.retentionMs ?? COMPLETED_RETENTION_MS
    this.unreadRetentionMs = options.unreadRetentionMs ?? UNREAD_RETENTION_MS
    this.maxUnconsumed = options.maxUnconsumed ?? 20
    this.findOutputRow = options.resolveOutputRow
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /** Register a freshly spawned shell command. */
  register(command: string, handle: CommandHandle, opts: { title?: string; notify?: boolean; cwd?: string; link?: TaskLink } = {}): CommandEntry {
    const id = newTaskId()
    let resolveDone!: () => void
    const done = new Promise<void>((r) => { resolveDone = r })
    const entry: CommandEntry = {
      id,
      runId: id,
      source: 'shell',
      title: opts.title ?? command,
      command,
      status: 'running',
      startedAt: handle.startedAt,
      notify: opts.notify ?? true,
      consumed: false,
      handle,
      link: opts.link,
      done,
    }
    this.entries.set(id, entry)
    this.resolvers.set(id, resolveDone)

    const writer = this.createWriter(entry, {
      command,
      cwd: opts.cwd,
      pid: handle.pid,
      container: handle.containerName,
    })
    const unsubscribe = writer && handle.onData ? handle.onData((chunk) => writer.append(chunk)) : undefined

    const visibilityTimer = setTimeout(() => {
      entry.visibilityTimer = undefined
      if (!handle.exited()) this.emitChange()
    }, this.uiVisibleAfterMs)
    entry.visibilityTimer = visibilityTimer
    ;(visibilityTimer as any)?.unref?.()

    handle.done.then((result) => {
      unsubscribe?.()
      entry.finalResult = result
      const status: TaskStatus = result.killed && entry.status === 'cancelled'
        ? 'cancelled'
        : result.exitCode === 0 ? 'completed' : 'failed'
      this.settle(entry, status, {
        exitCode: result.exitCode,
        summary: result.killReason ?? `exit code ${result.exitCode}`,
      })
    }).catch(() => {
      unsubscribe?.()
      this.settle(entry, 'failed', { summary: 'process error' })
    })

    this.emitChange()
    return entry
  }

  /** Register a non-shell task (subagent, ...). The caller drives it via the returned handle. */
  registerTask(opts: {
    source: TaskSource
    title: string
    ref?: string
    notify?: boolean
    backgrounded?: boolean
    cancel?: () => void | Promise<void>
    id?: string
    dormant?: boolean
    link?: TaskLink
  }): TaskHandle {
    const id = opts.id ?? newTaskId()
    let resolveDone!: () => void
    const done = new Promise<void>((r) => { resolveDone = r })
    const entry: TaskEntry = {
      id,
      runId: id,
      source: opts.source,
      title: opts.title,
      command: opts.title,
      status: 'running',
      startedAt: Date.now(),
      notify: opts.notify ?? true,
      consumed: false,
      backgrounded: opts.backgrounded,
      ref: opts.ref,
      link: opts.link,
      dormant: opts.dormant || undefined,
      done,
    }
    this.entries.set(id, entry)
    this.resolvers.set(id, resolveDone)
    if (opts.ref) this.aliases.set(opts.ref, id)
    if (opts.cancel) this.cancels.set(id, opts.cancel)
    if (!opts.dormant) {
      this.createWriter(entry, { ref: opts.ref })
      this.emitChange()
    }
    return {
      entry,
      append: (chunk: string) => this.appendOutput(id, chunk, this.writers.get(id)),
      finish: (status, result) => this.settle(entry, status, result),
    }
  }

  /** Start tracking a dormant task: it gets an output file, shows up, and notifies. */
  activate(id: string): void {
    const entry = this.get(id)
    if (!entry?.dormant) return
    entry.dormant = undefined
    entry.notify = true
    this.createWriter(entry, { ref: entry.ref })
    this.emitChange()
  }

  /** Let `ref` (e.g. a subagent instance id) resolve to task `id`. */
  addAlias(ref: string, id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.ref = ref
    this.aliases.set(ref, id)
  }

  /** Mirror an API-tracked task. Its status is refreshed through `remote`. */
  registerRemote(opts: {
    id: string
    source: TaskSource
    title: string
    ref?: string
    notify?: boolean
    startedAt?: number
    /** Per-task transport. Defaults to the registry's API client. */
    client?: RemoteTaskClient
    /** The API holds the task (wakes the session, records consumption). Default: no per-task client. */
    apiTracked?: boolean
    dormant?: boolean
    /** Where the task's work is happening; shown as the dock row's destination. */
    link?: TaskLink
  }): TaskEntry {
    const existing = this.entries.get(opts.id)
    if (existing) {
      if (opts.link && !existing.link) existing.link = opts.link
      return existing
    }
    const handle = this.registerTask({
      id: opts.id,
      source: opts.source,
      title: opts.title,
      ref: opts.ref,
      notify: opts.notify,
      backgrounded: true,
      dormant: opts.dormant,
      link: opts.link,
    })
    handle.entry.remote = true
    handle.entry.apiTracked = opts.apiTracked ?? !opts.client
    if (opts.client) this.clients.set(opts.id, opts.client)
    if (opts.startedAt) handle.entry.startedAt = opts.startedAt
    return handle.entry
  }

  private createWriter(entry: TaskEntry, extra: Record<string, string | number | undefined>): TaskOutputWriter | undefined {
    if (!this.outputDir) return undefined
    const path = join(this.outputDir, `${entry.id}.log`)
    const writer = new TaskOutputWriter(path, {
      taskId: entry.id,
      source: entry.source,
      title: entry.title,
      startedAt: entry.startedAt,
      extra,
    })
    entry.outputFile = path
    this.writers.set(entry.id, writer)
    return writer
  }

  private clientFor(entry: TaskEntry): RemoteTaskClient | undefined {
    if (!entry.remote) return undefined
    return this.clients.get(entry.id) ?? this.remote
  }

  private appendOutput(id: string, chunk: string, writer?: TaskOutputWriter): void {
    if (!chunk) return
    writer?.append(chunk)
    const prev = this.recent.get(id) ?? ''
    const next = prev + chunk
    this.recent.set(id, next.length > RECENT_OUTPUT_CHARS ? next.slice(-RECENT_OUTPUT_CHARS) : next)
  }

  private settle(entry: TaskEntry, status: TaskStatus, result: TaskResult): void {
    if (entry.status !== 'running' && entry.finishedAt) return
    if (entry.visibilityTimer) {
      clearTimeout(entry.visibilityTimer)
      entry.visibilityTimer = undefined
    }
    entry.status = entry.status === 'cancelled' ? 'cancelled' : status
    entry.finishedAt = Date.now()
    entry.result = result
    this.writers.get(entry.id)?.finish({
      status: entry.status,
      exitCode: result.exitCode,
      elapsedMs: entry.finishedAt - entry.startedAt,
    })
    this.writers.delete(entry.id)
    this.cancels.delete(entry.id)
    this.queueNote(entry)
    this.resolvers.get(entry.id)?.()
    this.resolvers.delete(entry.id)
    this.emitChange()
    this.armRetention(entry)
  }

  /**
   * The result belongs to whoever started the task until they read it. A task
   * the agent was told about in the background keeps its entry (and so a late
   * `wait`) until `markConsumed`; everything else gets the short window.
   */
  private wantsUnreadResult(entry: TaskEntry): boolean {
    return !!entry.backgrounded && !entry.consumed && !entry.stale
  }

  /** (Re)arm the retention window from the entry's finish time. */
  private armRetention(entry: TaskEntry): void {
    if (entry.retentionTimer) {
      clearTimeout(entry.retentionTimer)
      entry.retentionTimer = undefined
    }
    const finishedAt = entry.finishedAt ?? Date.now()
    const deadline = finishedAt + (this.wantsUnreadResult(entry) ? this.unreadRetentionMs : this.retentionMs)
    const timer = setTimeout(() => {
      entry.retentionTimer = undefined
      this.expire(entry.id)
    }, Math.max(0, deadline - Date.now()))
    ;(timer as any)?.unref?.()
    entry.retentionTimer = timer
    this.enforceUnconsumedCap()
  }

  /**
   * Drop a finished entry from memory once its lease is up. An unread result
   * that still has lease left is re-armed instead (a restore from a snapshot or
   * a log comes back with a fresh window), and memory stays bounded by evicting
   * the oldest entries — their output files still hold the result.
   */
  private expire(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.status === 'running' || entry.stale) return
    if (this.wantsUnreadResult(entry)) {
      const deadline = (entry.finishedAt ?? Date.now()) + this.unreadRetentionMs
      if (Date.now() < deadline) {
        this.armRetention(entry)
        return
      }
    }
    this.forget(id)
    this.enforceUnconsumedCap()
  }

  /** Keep at most `maxUnconsumed` unread results in memory, oldest first. */
  private enforceUnconsumedCap(): void {
    const finished = [...this.entries.values()].filter((e) => e.status !== 'running' && !e.stale)
    const unread = finished.filter((e) => this.wantsUnreadResult(e))
    let excess = unread.length - this.maxUnconsumed
    if (excess <= 0) return
    const oldestFirst = (a: TaskEntry, b: TaskEntry) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)
    // Read results are free to drop and keep the map small; only then does an
    // unread one go, and it is rebuildable from its log.
    for (const entry of finished.filter((e) => !this.wantsUnreadResult(e)).sort(oldestFirst)) {
      if (excess <= 0) break
      this.forget(entry.id)
      excess -= 1
    }
    for (const entry of unread.sort(oldestFirst)) {
      if (excess <= 0) break
      this.forget(entry.id)
      excess -= 1
    }
  }

  private forget(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.status === 'running') return
    if (entry.retentionTimer) {
      clearTimeout(entry.retentionTimer)
      entry.retentionTimer = undefined
    }
    this.entries.delete(id)
    this.recent.delete(id)
    if (entry.ref && this.aliases.get(entry.ref) === id) this.aliases.delete(entry.ref)
  }

  // ---------------------------------------------------------------------------
  // Notes / consumption
  // ---------------------------------------------------------------------------

  private queueNote(entry: TaskEntry): void {
    if (!entry.backgrounded || !entry.notify || entry.consumed || entry.stale) return
    if (this.pendingWaits.has(entry.id)) return
    const note = this.buildNotification(entry)
    this.completionNotes.set(entry.id, note)
    for (const listener of this.notificationListeners) {
      try { listener(note) } catch { /* ignore */ }
    }
  }

  buildNotification(entry: TaskEntry): TaskNotification {
    return {
      taskId: entry.id,
      source: entry.source,
      title: entry.title,
      status: entry.status,
      exitCode: entry.result?.exitCode,
      outputFile: this.displayPath(entry.outputFile),
      tail: tailLines(stripAnsi(this.readOutput(entry))),
      remote: entry.remote,
      finishedAt: entry.finishedAt,
    }
  }

  /** Mark a task as one the agent was told runs in the background. */
  markBackgrounded(id: string): void {
    const entry = this.get(id)
    if (!entry) return
    const wasVisible = this.dockVisible(entry, Date.now())
    entry.backgrounded = true
    if (entry.status !== 'running') {
      this.queueNote(entry)
      return
    }
    // A shell command that only just started is still below the visibility
    // delay when it registers, so `register()`'s change was a no-op for the
    // dock. Announcing it now is what puts the row on screen at all — without
    // this the first frame a client ever sees for a background task is the one
    // written when it settles (or after the 30 s timer).
    if (!wasVisible) this.emitChange()
  }

  /**
   * Mark a wait call as observing a task. Completion during this window is
   * returned by the wait itself rather than injected as a duplicate note.
   */
  beginWait(id: string): () => void {
    const resolved = this.resolveId(id)
    this.pendingWaits.set(resolved, (this.pendingWaits.get(resolved) ?? 0) + 1)
    this.completionNotes.delete(resolved)
    return () => {
      const n = (this.pendingWaits.get(resolved) ?? 1) - 1
      if (n <= 0) this.pendingWaits.delete(resolved)
      else this.pendingWaits.set(resolved, n)
    }
  }

  /** The agent has seen the final result; never notify about it again. */
  markConsumed(ids: string[]): void {
    const apiIds: string[] = []
    for (const raw of ids) {
      const entry = this.get(raw)
      if (!entry || entry.consumed) continue
      entry.consumed = true
      this.completionNotes.delete(entry.id)
      // Reading the result ends its unread lease: the short window applies now.
      if (entry.finishedAt) this.armRetention(entry)
      if (entry.apiTracked || entry.reported) apiIds.push(entry.id)
    }
    if (apiIds.length > 0 && this.remote) {
      void this.remote.consume(apiIds).catch(() => {})
    }
  }

  /**
   * Take pending notifications (formatted) and mark them consumed.
   *
   * `filter` lets a caller take only the notes it is actually reporting — a
   * wake turn must not swallow another queued task's note, or that task's own
   * wake is dropped as already-consumed and its result never reaches the
   * transcript.
   */
  consumeCompletionNotes(filter?: (n: TaskNotification) => boolean): string[] {
    return this.takeNotifications(filter).map(formatTaskNotification)
  }

  /** Take pending notifications and mark their tasks consumed. */
  takeNotifications(filter?: (n: TaskNotification) => boolean): TaskNotification[] {
    const taken: TaskNotification[] = []
    for (const [id, note] of this.completionNotes) {
      if (filter && !filter(note)) continue
      taken.push(note)
      this.completionNotes.delete(id)
    }
    if (taken.length > 0) this.markConsumed(taken.map((n) => n.taskId))
    return taken
  }

  hasPendingNotifications(): boolean {
    return this.completionNotes.size > 0
  }

  /** Stop notifying about every task that is running now (used on user Stop). */
  muteRunning(): void {
    const apiIds: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.status !== 'running') continue
      entry.notify = false
      if (entry.apiTracked) apiIds.push(entry.id)
    }
    for (const note of this.completionNotes.values()) {
      const entry = this.entries.get(note.taskId)
      if (entry?.reported) apiIds.push(entry.id)
    }
    this.completionNotes.clear()
    if (apiIds.length > 0 && this.remote) {
      void this.remote.consume(apiIds).catch(() => {})
    }
  }

  /** Notes for these tasks were handed to the API to wake the session; consumption must be reported back. */
  markReported(ids: string[]): void {
    for (const id of ids) {
      const entry = this.get(id)
      if (entry) entry.reported = true
    }
  }

  /** Pending notes, without taking them. */
  peekNotifications(): TaskNotification[] {
    return [...this.completionNotes.values()]
  }

  /** Fires whenever a completion note is queued. */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => { this.notificationListeners.delete(listener) }
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  private resolveId(id: string): string {
    return this.entries.has(id) ? id : (this.aliases.get(id) ?? id)
  }

  get(id: string): TaskEntry | undefined {
    return this.entries.get(this.resolveId(id))
  }

  /** Number of entries (running + recently finished). For tests/diagnostics. */
  size(): number {
    return this.entries.size
  }

  /** Output text for `until` matching and notification tails. */
  readOutput(entry: TaskEntry): string {
    if (entry.handle) {
      const h = entry.handle
      const recent = h.recentOutput()
      return recent || `${h.stdout()}\n${h.stderr()}`
    }
    const mem = this.recent.get(entry.id)
    if (mem) return mem
    return stripFrontMatter(readTaskOutput(entry.outputFile))
  }

  /** Workspace-relative output path for tool results and notes. */
  displayPath(path: string | undefined): string | undefined {
    if (!path) return undefined
    if (!this.workspaceDir) return path
    const rel = relative(this.workspaceDir, path)
    return rel && !rel.startsWith('..') ? rel : path
  }

  /** The log `id` would have written, when output files are enabled. */
  outputPathFor(id: string): string | undefined {
    if (!this.outputDir) return undefined
    return this.displayPath(join(this.outputDir, `${id}.log`))
  }

  /**
   * A finished task's entry, rebuilt from its output file when the in-memory
   * one was evicted. The log is the durable copy: as long as it is there the
   * result is readable, and only a missing log means the task is really gone.
   */
  async resolveFinished(id: string): Promise<TaskEntry | null> {
    const resolved = this.resolveId(id)
    const existing = this.entries.get(resolved)
    if (existing) return existing
    const row = this.findOutputRow?.(resolved)
    if (!row?.status) return null
    const body = taskOutputBody(readTaskOutput(row.path))
    if (body.trim()) this.recent.set(row.taskId, tailLines(body, 400, 200_000))
    const entry: TaskEntry = {
      id: row.taskId,
      runId: row.taskId,
      source: (row.source as TaskSource) ?? 'shell',
      title: row.title,
      command: row.title,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? row.modifiedAt,
      result: { exitCode: row.exitCode, summary: row.status },
      notify: false,
      consumed: false,
      recovered: true,
      outputFile: row.path,
      done: Promise.resolve(),
    }
    this.entries.set(entry.id, entry)
    this.armRetention(entry)
    return entry
  }

  // ---------------------------------------------------------------------------
  // Wait
  // ---------------------------------------------------------------------------

  /**
   * Block until any of `ids` finishes, `until` matches its output, or the
   * timeout elapses. With no ids this is a plain bounded sleep.
   */
  async wait(ids: string[], opts: { timeoutMs: number; until?: RegExp; signal?: AbortSignal }): Promise<WaitOutcome> {
    const entries = ids.map((id) => this.get(id)).filter((e): e is TaskEntry => !!e)
    for (const entry of entries) this.activate(entry.id)
    const timeoutMs = Math.max(0, opts.timeoutMs)

    const matchesUntil = (entry: TaskEntry): boolean => {
      if (!opts.until) return false
      const text = stripAnsi(this.readOutput(entry))
      opts.until.lastIndex = 0
      return opts.until.test(text)
    }

    const immediate = (): WaitOutcome | undefined => {
      for (const entry of entries) {
        if (entry.status !== 'running') {
          this.markConsumed([entry.id])
          return { kind: 'finished', task: entry }
        }
        if (!entry.remote && matchesUntil(entry)) return { kind: 'matched', task: entry, matched: opts.until!.source }
      }
      return undefined
    }

    const first = immediate()
    if (first) return first
    if (entries.length === 0 && ids.length > 0) return { kind: 'timeout' }

    if (timeoutMs === 0) {
      // Non-blocking check: one status refresh for remote tasks, then report.
      if (entries.some((e) => this.clientFor(e))) {
        await Promise.all(entries.filter((e) => this.clientFor(e)).map(async (entry) => {
          try {
            const state = await this.clientFor(entry)!.get(entry.id, { waitMs: 0, until: opts.until?.source })
            if (state) this.applyRemoteState(entry, state)
          } catch { /* keep last known */ }
        }))
        const after = immediate()
        if (after) return after
      }
      return { kind: 'timeout' }
    }

    const endWaits = entries.map((e) => this.beginWait(e.id))
    const cleanups: Array<() => void> = []
    try {
      const racers: Array<Promise<WaitOutcome>> = []

      racers.push(new Promise((resolve) => {
        const t = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        ;(t as any)?.unref?.()
        cleanups.push(() => clearTimeout(t))
      }))

      if (opts.signal) {
        racers.push(new Promise((resolve) => {
          if (opts.signal!.aborted) return resolve({ kind: 'timeout' })
          const onAbort = () => resolve({ kind: 'timeout' })
          opts.signal!.addEventListener('abort', onAbort, { once: true })
          cleanups.push(() => opts.signal!.removeEventListener('abort', onAbort))
        }))
      }

      const local = entries.filter((e) => !e.remote)
      for (const entry of local) {
        racers.push(entry.done.then(() => ({ kind: 'finished' as const, task: entry })))
      }
      if (opts.until && local.length > 0) {
        racers.push(new Promise((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const tick = () => {
            for (const entry of local) {
              if (entry.status === 'running' && matchesUntil(entry)) {
                resolve({ kind: 'matched', task: entry, matched: opts.until!.source })
                return
              }
            }
            timer = setTimeout(tick, UNTIL_POLL_MS)
            ;(timer as any)?.unref?.()
          }
          tick()
          cleanups.push(() => { if (timer) clearTimeout(timer) })
        }))
      }

      const remote = entries.filter((e) => this.clientFor(e))
      if (remote.length > 0) {
        const deadline = Date.now() + timeoutMs
        let stopped = false
        cleanups.push(() => { stopped = true })
        for (const entry of remote) {
          racers.push(this.pollRemote(entry, deadline, opts.until, () => stopped))
        }
      }

      const outcome = await Promise.race(racers)
      if (outcome.kind === 'finished' && outcome.task) this.markConsumed([outcome.task.id])
      return outcome
    } finally {
      for (const c of cleanups) c()
      for (const end of endWaits) end()
    }
  }

  private async pollRemote(
    entry: TaskEntry,
    deadline: number,
    until: RegExp | undefined,
    stopped: () => boolean,
  ): Promise<WaitOutcome> {
    let first = true
    while (!stopped()) {
      const waitMs = first ? Math.max(0, Math.min(REMOTE_POLL_SLICE_MS, deadline - Date.now())) : Math.min(REMOTE_POLL_SLICE_MS, deadline - Date.now())
      if (!first && waitMs <= 0) break
      first = false
      const polledAt = Date.now()
      let state: RemoteTaskState | null = null
      try {
        state = await this.clientFor(entry)!.get(entry.id, { waitMs, until: until?.source })
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      if (!state) break
      this.applyRemoteState(entry, state)
      if (entry.status !== 'running') return { kind: 'finished', task: entry }
      if (state.matched && until) return { kind: 'matched', task: entry, matched: until.source }
      if (deadline - Date.now() <= 0) break
      const early = REMOTE_MIN_POLL_GAP_MS - (Date.now() - polledAt)
      if (early > 0) await new Promise((r) => setTimeout(r, early))
    }
    return new Promise(() => {}) // the timeout racer wins
  }

  /** Apply API state to a mirrored remote entry. */
  applyRemoteState(entry: TaskEntry, state: RemoteTaskState): void {
    if (state.link && !entry.link) entry.link = state.link
    if (state.note) entry.remoteNote = state.note
    if (state.output !== undefined) {
      const prev = this.recent.get(entry.id) ?? ''
      if (state.output.length > prev.length && state.output.startsWith(prev)) {
        this.appendOutput(entry.id, state.output.slice(prev.length), this.writers.get(entry.id))
      } else if (state.output !== prev) {
        this.recent.set(entry.id, state.output.slice(-RECENT_OUTPUT_CHARS))
        this.writers.get(entry.id)?.append(state.output)
      }
    }
    if (state.status !== 'running' && entry.status === 'running') {
      this.settle(entry, state.status, state.result ?? { summary: state.status })
    }
  }

  /** Refresh every running remote task from the API (one non-blocking get each). */
  async refreshRemote(): Promise<void> {
    await this.refreshWhere((e) => !!this.clientFor(e))
  }

  /** Refresh running remote tasks matching `filter`. */
  async refreshWhere(filter: (entry: TaskEntry) => boolean): Promise<void> {
    const running = [...this.entries.values()].filter((e) => e.remote && !e.dormant && e.status === 'running' && filter(e))
    await Promise.all(running.map(async (entry) => {
      try {
        const state = await this.clientFor(entry)!.get(entry.id, { waitMs: 0 })
        if (state) this.applyRemoteState(entry, state)
      } catch { /* keep last known state */ }
    }))
  }

  hasRunningRemote(filter: (entry: TaskEntry) => boolean = () => true): boolean {
    for (const e of this.entries.values()) if (e.remote && !e.dormant && e.status === 'running' && filter(e)) return true
    return false
  }

  /** Running tasks that will wake the agent when they finish. */
  pendingNotifyCount(): number {
    let n = 0
    for (const e of this.entries.values()) {
      if (e.status === 'running' && !e.stale && !e.dormant && e.backgrounded && e.notify) n++
    }
    return n
  }

  // ---------------------------------------------------------------------------
  // Listing / UI
  // ---------------------------------------------------------------------------

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return
    const running = this.listRunning()
    for (const listener of this.listeners) {
      try { listener(running) } catch { /* ignore */ }
    }
  }

  private toView(entry: TaskEntry, now: number): RunningProcess {
    return {
      id: entry.id,
      runId: entry.id,
      source: entry.source,
      title: entry.title,
      command: entry.command,
      status: entry.stale ? 'running' : entry.status,
      pid: entry.handle?.pid,
      sandboxed: entry.handle?.sandboxed ?? false,
      containerName: entry.handle?.containerName,
      startedAt: entry.startedAt,
      elapsedMs: (entry.finishedAt ?? now) - entry.startedAt,
      finishedAt: entry.finishedAt,
      outputFile: this.displayPath(entry.outputFile),
      notify: entry.notify && !!entry.backgrounded,
      remote: entry.remote || undefined,
      stale: entry.stale || undefined,
      link: entry.link,
    }
  }

  private isRunning(entry: TaskEntry): boolean {
    if (entry.stale) return true
    if (entry.handle) return !entry.handle.exited() && entry.status === 'running'
    return entry.status === 'running'
  }

  /** Currently-running (or stale) tasks. Finished entries are excluded. */
  listRunning(): RunningProcess[] {
    const now = Date.now()
    const out: RunningProcess[] = []
    for (const entry of this.entries.values()) {
      if (!entry.dormant && this.isRunning(entry)) out.push(this.toView(entry, now))
    }
    return out
  }

  /** Running tasks plus recently finished ones (for `task_list`). */
  listAll(): RunningProcess[] {
    const now = Date.now()
    return [...this.entries.values()].filter((e) => !e.dormant).map((e) => this.toView(e, now))
  }

  /**
   * Tasks eligible for display in the chat dock. Shell commands appear after
   * the visibility delay (short commands would just flicker); every other
   * task, and any shell command the agent was told about, shows at once.
   */
  listVisible(): RunningProcess[] {
    const now = Date.now()
    const out: RunningProcess[] = []
    for (const entry of this.entries.values()) {
      if (this.isRunning(entry) && this.dockVisible(entry, now)) out.push(this.toView(entry, now))
    }
    return out
  }

  /**
   * Everything the chat dock shows: what is running (or stale) plus what
   * finished inside the retention window, running first and then the newest
   * finish. `task_list` keeps its running-only `listVisible()`; this list is
   * for the dock only, so a row can settle in place instead of vanishing.
   */
  listDock(): RunningProcess[] {
    const now = Date.now()
    const running: RunningProcess[] = []
    const finished: RunningProcess[] = []
    for (const entry of this.entries.values()) {
      if (!this.dockVisible(entry, now)) continue
      if (this.isRunning(entry)) {
        running.push(this.toView(entry, now))
      } else if (entry.finishedAt && now - entry.finishedAt <= COMPLETED_RETENTION_MS) {
        finished.push(this.toView(entry, now))
      }
    }
    finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    return [...running, ...finished]
  }

  /** Would this entry be shown in the dock at all (running or finished)? */
  private dockVisible(entry: TaskEntry, now: number): boolean {
    if (entry.dormant) return false
    if (entry.stale) return true
    if (entry.shown) return true
    if (entry.source !== 'shell') return true
    if (entry.backgrounded) return true
    return (entry.finishedAt ?? now) - entry.startedAt >= this.uiVisibleAfterMs
  }

  /**
   * Serializable snapshot for persistence: every running task plus the
   * recently finished rows the dock was showing, and any finished row whose
   * result its owner has not read yet. Running entries are taken from
   * `listRunning()`, not `listDock()`, because a shell command still inside the
   * dock visibility delay is invisible but must survive a restart; an unread
   * result joins them for the same reason — the dock's 10-minute window is not
   * its lease.
   */
  snapshot(): RunningProcessSnapshot[] {
    const now = Date.now()
    const persisted = new Map<string, RunningProcess>()
    for (const p of this.listRunning()) persisted.set(p.id, p)
    for (const p of this.listDock()) if (!persisted.has(p.id)) persisted.set(p.id, p)
    for (const entry of this.entries.values()) {
      if (persisted.has(entry.id) || entry.dormant) continue
      if (entry.status === 'running' || this.wantsUnreadResult(entry)) persisted.set(entry.id, this.toView(entry, now))
    }
    return [...persisted.values()].map((p) => {
      const entry = this.entries.get(p.id)
      return {
        runId: p.id,
        command: p.command,
        pid: p.pid,
        sandboxed: p.sandboxed,
        containerName: p.containerName,
        startedAt: p.startedAt,
        source: p.source,
        title: p.title,
        remote: entry?.apiTracked || undefined,
        ref: entry?.ref,
        outputFile: entry?.outputFile,
        link: entry?.link,
        // A settled task keeps its outcome across a restart, so it comes back
        // as a finished row for the rest of its retention window.
        status: p.status,
        finishedAt: p.finishedAt,
        shown: true,
        // Whether the agent read the result decides the lease it comes back
        // with; a restart must not turn an unread result into a read one.
        consumed: entry?.consumed,
        backgrounded: entry?.backgrounded,
      }
    })
  }

  /**
   * Re-seed from a persisted snapshot after a runtime restart. Local tasks
   * that were running belonged to the dead gateway and come back `stale`
   * (dismissable only). Remote tasks are still tracked by the API and come
   * back live; tasks that had already settled come back finished.
   */
  restoreStale(snapshots: RunningProcessSnapshot[]): void {
    if (!snapshots?.length) return
    const now = Date.now()
    let changed = false
    for (const snap of snapshots) {
      if (!snap?.runId || this.entries.has(snap.runId)) continue
      if (snap.remote && snap.source) {
        this.registerRemote({
          id: snap.runId,
          source: snap.source,
          title: snap.title ?? snap.command,
          ref: snap.ref,
          startedAt: snap.startedAt,
          link: snap.link,
        })
        changed = true
        continue
      }
      if (this.restoreTerminal(snap, now)) {
        changed = true
        continue
      }
      this.entries.set(snap.runId, {
        id: snap.runId,
        runId: snap.runId,
        source: snap.source ?? 'shell',
        title: snap.title ?? snap.command,
        command: snap.command,
        status: 'running',
        startedAt: snap.startedAt,
        notify: false,
        consumed: false,
        stale: true,
        outputFile: snap.outputFile,
        link: snap.link,
        handle: makeStaleHandle(snap),
        done: Promise.resolve(),
      })
      changed = true
    }
    if (changed) this.emitChange()
  }

  /**
   * Restore what the per-task output logs say ran in this session. Used when
   * no snapshot survived (first run after the snapshot existed, or metadata
   * pruned): a log with a footer is a finished row, one without is a task the
   * previous runtime died under — today's `stale` placeholder.
   */
  restoreFromOutputRows(rows: TaskOutputRow[]): void {
    if (!rows?.length) return
    const now = Date.now()
    let changed = false
    for (const row of rows) {
      if (!row?.taskId || this.entries.has(row.taskId)) continue
      const snap: RunningProcessSnapshot = {
        runId: row.taskId,
        command: row.title,
        pid: undefined,
        sandboxed: false,
        startedAt: row.startedAt,
        source: (row.source as TaskSource) ?? 'shell',
        title: row.title,
        outputFile: row.path,
        status: row.status,
        finishedAt: row.finishedAt,
      }
      if (this.restoreTerminal(snap, now)) {
        changed = true
        continue
      }
      if (now - row.startedAt > COMPLETED_RETENTION_MS) continue
      this.entries.set(row.taskId, {
        id: row.taskId,
        runId: row.taskId,
        source: snap.source ?? 'shell',
        title: row.title,
        command: row.title,
        status: 'running',
        startedAt: row.startedAt,
        notify: false,
        consumed: false,
        stale: true,
        outputFile: row.path,
        link: snap.link,
        handle: makeStaleHandle(snap),
        done: Promise.resolve(),
      })
      changed = true
    }
    if (changed) this.emitChange()
  }

  /** Restore one settled row; false when it is unknown/too old to keep.  */
  private restoreTerminal(snap: RunningProcessSnapshot, now: number): boolean {
    if (!snap.status || snap.status === 'running' || !snap.finishedAt) return false
    const entry: TaskEntry = {
      id: snap.runId,
      runId: snap.runId,
      source: snap.source ?? 'shell',
      title: snap.title ?? snap.command,
      command: snap.command,
      status: snap.status,
      startedAt: snap.startedAt,
      finishedAt: snap.finishedAt,
      notify: false,
      // A snapshot from before this field existed assumed the row was read.
      consumed: snap.consumed ?? true,
      backgrounded: snap.backgrounded,
      shown: snap.shown,
      outputFile: snap.outputFile,
      link: snap.link,
      done: Promise.resolve(),
    }
    const lease = this.wantsUnreadResult(entry) ? this.unreadRetentionMs : this.retentionMs
    if (snap.finishedAt + lease - now <= 0) return true
    this.entries.set(snap.runId, entry)
    this.armRetention(entry)
    return true
  }

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------

  /**
   * Cancel a running task, or dismiss a stale placeholder. Returns true if a
   * task with `id` existed.
   */
  kill(id: string): boolean {
    const entry = this.get(id)
    if (!entry) return false
    if (entry.stale) {
      this.entries.delete(entry.id)
      this.emitChange()
      return true
    }
    if (entry.status !== 'running') return true
    entry.status = 'cancelled'
    entry.consumed = true
    this.completionNotes.delete(entry.id)
    if (entry.handle) {
      if (!entry.handle.exited()) {
        try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
      }
      return true
    }
    const cancel = this.cancels.get(entry.id)
    const client = this.clientFor(entry)
    if (client) void client.cancel(entry.id).catch(() => {})
    try { void cancel?.() } catch { /* ignore */ }
    this.settle(entry, 'cancelled', { summary: 'cancelled' })
    return true
  }

  /** Forcefully terminate every local task. Used on session shutdown. */
  killAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.visibilityTimer) {
        clearTimeout(entry.visibilityTimer)
        entry.visibilityTimer = undefined
      }
      if (entry.stale || entry.remote) continue
      if (entry.status !== 'running') {
        // A finished shell can leave behind processes it detached (`cmd &`) in its process group.
        if (entry.handle) try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
        continue
      }
      entry.notify = false
      if (entry.handle) {
        try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
      } else {
        try { void this.cancels.get(entry.id)?.() } catch { /* ignore */ }
      }
    }
    for (const writer of this.writers.values()) writer.flush()
    this.entries.clear()
    this.aliases.clear()
    this.completionNotes.clear()
    this.emitChange()
  }
}

function stripFrontMatter(text: string): string {
  if (!text.startsWith('---\n')) return text
  const end = text.indexOf('\n---\n', 4)
  if (end !== -1) return text.slice(end + 5)
  // A settled task's log can end exactly at the closing delimiter, with no
  // body written at all. Returning the header would make the output viewer
  // look blank, so report the empty body instead.
  const close = text.lastIndexOf('\n---')
  if (close !== -1 && text.slice(close + 4).trim() === '') return ''
  return text
}

/** Build a synthetic, already-exited handle for a restored (stale) entry. */
function makeStaleHandle(snap: RunningProcessSnapshot): CommandHandle {
  return {
    pid: snap.pid,
    containerName: snap.containerName,
    sandboxed: snap.sandboxed,
    stdout: () => '',
    stderr: () => '',
    recentOutput: () => '',
    done: Promise.resolve({ exitCode: -1, stdout: '', stderr: '', killed: false }),
    kill: () => { /* stale: the OS child is gone, nothing to signal */ },
    exited: () => true,
    startedAt: snap.startedAt,
  }
}
