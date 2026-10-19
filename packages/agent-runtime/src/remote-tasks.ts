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
 * Register an API-tracked task for this session. With `lazy`, the API row is
 * only created when the agent first waits on it (cards: reading one should not
 * start tracking it). Without it, tracking starts now and `until` settles the
 * task when an event line matches. Returns undefined when this runtime cannot
 * reach the API.
 */
export async function trackRemoteTask(
  registry: TaskRegistry,
  sessionId: string,
  opts: {
    source: BackgroundTaskSource
    targetRef: string
    title: string
    id?: string
    lazy?: boolean
    until?: string
    /** Where the task's work is happening, so the dock can open it. */
    link?: TaskLink
  },
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
    const created = await createBackgroundTask({ id, chatSessionId: sessionId, source: opts.source, targetRef: opts.targetRef, title: opts.title, until: opts.until, link: opts.link })
    if (!created.ok) return undefined
  }

  let created = !opts.lazy
  const api = createApiTaskClient()
  const ensure = async (until?: string) => {
    if (created) return
    const res = await createBackgroundTask({ id, chatSessionId: sessionId, source: opts.source, targetRef: opts.targetRef, title: opts.title, until, link: opts.link })
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
