// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tasks the API observes on the agent's behalf: a project call, a tagged
 * agent's reply, a card. The runtime mirrors each as a TaskRegistry entry so
 * `wait`, `task_list` and the dock treat them like any local task; the API
 * holds the source of truth and wakes the session when one finishes.
 */
import {
  cancelBackgroundTask,
  consumeBackgroundTasks,
  createBackgroundTask,
  getBackgroundTask,
  hasInternalApiCredentials,
  type BackgroundTaskSource,
  type BackgroundTaskState,
} from './internal-api'
import { newTaskId, type RemoteTaskClient, type RemoteTaskState, type TaskLink, type TaskRegistry } from './task-registry'

export function toRemoteState(task: BackgroundTaskState): RemoteTaskState {
  return {
    id: task.id,
    status: task.status,
    output: task.output,
    result: task.result ? { ...task.result, summary: task.result.summary ?? task.status } : undefined,
    matched: task.matched,
    link: task.link ?? undefined,
    note: task.note ?? undefined,
  }
}

/** The registry-level client: every API-tracked task goes through the internal task routes. */
export function createApiTaskClient(): RemoteTaskClient {
  return {
    async get(id, opts) {
      const res = await getBackgroundTask(id, opts)
      if (res.ok && res.data) return toRemoteState(res.data)
      if (res.status === 404) return { id, status: 'failed', result: { summary: 'The task is no longer tracked.' } }
      throw new Error(res.error ?? `task lookup failed (${res.status})`)
    },
    async cancel(id) {
      await cancelBackgroundTask(id)
    },
    async consume(ids) {
      await consumeBackgroundTasks(ids)
    },
  }
}

/** Mirror tasks the API created on the agent's behalf (e.g. one per tagged agent). */
export function mirrorApiTasks(
  registry: TaskRegistry,
  source: BackgroundTaskSource,
  tasks: Array<{ task_id: string; title: string }>,
): TrackedTask[] {
  return tasks.map((task) => {
    const entry = registry.registerRemote({ id: task.task_id, source, title: task.title, apiTracked: true })
    return { task_id: entry.id, status: 'running', output_file: registry.displayPath(entry.outputFile) }
  })
}

export interface TrackedTask {
  task_id: string
  status: 'running'
  output_file?: string
}

/** Starters for lazy tasks, so a later eager track of the same target can activate it. */
const lazyStarters = new WeakMap<TaskRegistry, Map<string, (until?: string) => Promise<void>>>()

/**
 * A wake the API did not accept is retried on these delays; so is a task the
 * API did not accept on its first `POST /internal/tasks`. The note stays
 * unreported until a flush succeeds, and a task row stays uncreated until a
 * create succeeds, so a refusal cannot silently end either one.
 */
export const TASK_WAKE_RETRY_MS = [2_000, 5_000, 15_000, 60_000, 300_000] as const

// Mutable so tests can install a tight schedule instead of waiting out the
// ~6 minute production budget. Only the create retry below reads it.
let createRetryDelaysMs: readonly number[] = TASK_WAKE_RETRY_MS

/**
 * Test-only: swap the create-retry schedule. Returns a restore function the
 * caller MUST invoke (typically in `afterEach`).
 */
export function __setCreateRetryDelaysForTest(delays: readonly number[]): () => void {
  const before = createRetryDelaysMs
  createRetryDelaysMs = delays
  return () => {
    createRetryDelaysMs = before
  }
}

interface TrackOptions {
  source: BackgroundTaskSource
  targetRef: string
  title: string
  id?: string
  lazy?: boolean
  until?: string
  /** Where the task's work is happening, so the dock can open it. */
  link?: TaskLink
}

function createInput(sessionId: string, id: string, opts: TrackOptions, until?: string) {
  return { id, chatSessionId: sessionId, source: opts.source, targetRef: opts.targetRef, title: opts.title, until, link: opts.link }
}

/**
 * Retry a task the API did not accept, off the caller's path.
 *
 * `enqueueTaskWake` only reads `background_tasks` rows and the drain sweep has
 * nothing to reconcile, so a task that keeps running with no row can never wake
 * the session: its result is lost until the agent happens to look at the dock.
 * A transient 5xx, a restart or a network blip must not cost that wake, so keep
 * trying on the wake flush's schedule and log the give-up once.
 */
function retryCreateInBackground(
  registry: TaskRegistry,
  sessionId: string,
  id: string,
  opts: TrackOptions,
  firstError: string,
  attempt = 0,
): void {
  if (attempt >= createRetryDelaysMs.length) {
    console.warn(
      `[remote-tasks] Gave up creating the API row for task ${id} (${opts.source}:${opts.targetRef}) after ${attempt + 1} attempts: ${firstError}`,
    )
    return
  }
  const timer = setTimeout(() => {
    if (registry.get(id)?.status === 'cancelled') return
    void createBackgroundTask(createInput(sessionId, id, opts, opts.until)).then(
      (res) => {
        if (!res.ok) retryCreateInBackground(registry, sessionId, id, opts, firstError, attempt + 1)
      },
      () => retryCreateInBackground(registry, sessionId, id, opts, firstError, attempt + 1),
    )
  }, createRetryDelaysMs[attempt]!)
  ;(timer as any).unref?.()
}

/**
 * Register an API-tracked task for this session. With `lazy`, the API row is
 * only created when the agent first waits on it (cards: reading one should not
 * start tracking it). Without it, tracking starts now and `until` settles the
 * task when an event line matches. Returns undefined when this runtime cannot
 * reach the API at all; a create the API refuses is retried and the task stays
 * tracked locally meanwhile.
 */
export async function trackRemoteTask(
  registry: TaskRegistry,
  sessionId: string,
  opts: TrackOptions,
): Promise<TrackedTask | undefined> {
  if (!hasInternalApiCredentials() && !process.env.SHOGO_API_URL) return undefined
  const existing = registry.get(opts.id ?? opts.targetRef)
  if (existing?.status === 'running' && existing.source === opts.source) {
    if (opts.link && !existing.link) existing.link = opts.link
    if (existing.dormant && !opts.lazy) {
      const start = lazyStarters.get(registry)?.get(existing.id)
      if (start) {
        try {
          await start(opts.until)
        } catch {
          return undefined
        }
      }
      registry.activate(existing.id)
    }
    return { task_id: existing.id, status: 'running', output_file: registry.displayPath(existing.outputFile) }
  }
  const id = opts.id ?? newTaskId()

  if (!opts.lazy) {
    const created = await createBackgroundTask(createInput(sessionId, id, opts, opts.until))
    if (!created.ok) {
      // Keep the task visible locally and keep trying for the API row: without
      // one nothing can ever wake the session when the task finishes.
      retryCreateInBackground(registry, sessionId, id, opts, created.error ?? `HTTP ${created.status}`)
    }
  }

  let created = !opts.lazy
  const api = createApiTaskClient()
  const ensure = async (until?: string) => {
    if (created) return
    const res = await createBackgroundTask(createInput(sessionId, id, opts, until))
    if (!res.ok) throw new Error(res.error ?? 'could not start tracking the task')
    created = true
  }
  if (opts.lazy) {
    let starters = lazyStarters.get(registry)
    if (!starters) lazyStarters.set(registry, (starters = new Map()))
    starters.set(id, ensure)
  }
  const client: RemoteTaskClient = opts.lazy
    ? {
        async get(taskId, getOpts) {
          await ensure(getOpts?.until)
          return api.get(taskId, getOpts)
        },
        cancel: async (taskId) => { if (created) await api.cancel(taskId) },
        consume: async (ids) => { if (created) await api.consume(ids) },
      }
    : api

  const entry = registry.registerRemote({
    id,
    source: opts.source,
    title: opts.title,
    ref: opts.targetRef,
    client: opts.lazy ? client : undefined,
    apiTracked: true,
    notify: !opts.lazy,
    dormant: opts.lazy,
    link: opts.link,
  })
  return { task_id: entry.id, status: 'running', output_file: registry.displayPath(entry.outputFile) }
}
