// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Database-backed delegated-agent task dispatcher.
 *
 * The task query itself is partitioned by workspace home region in
 * `routes/agent-tasks.ts`. This job wrapper keeps the recurring entry point
 * under `apps/api/src/jobs/` so the multi-region cron guard can discover and
 * classify it.
 */

import {
  dispatchQueuedTasks,
  type AgentTaskRuntimeManager,
} from '../routes/agent-tasks'

const TASK_DISPATCH_INTERVAL_MS = 5_000

export async function runAgentTaskDispatch(
  runtimeManager?: AgentTaskRuntimeManager,
): Promise<void> {
  await dispatchQueuedTasks(runtimeManager)
}

let taskDispatcherTimer: ReturnType<typeof setInterval> | null = null

/** Start the database-backed task dispatcher once during API startup. */
export function startAgentTaskWorker(
  runtimeManager?: AgentTaskRuntimeManager,
): () => void {
  if (taskDispatcherTimer) return stopAgentTaskWorker

  const tick = () => {
    void runAgentTaskDispatch(runtimeManager).catch((error) => {
      console.error('[AgentTask] Dispatcher tick failed:', error)
    })
  }
  tick()
  taskDispatcherTimer = setInterval(tick, TASK_DISPATCH_INTERVAL_MS)
  ;(taskDispatcherTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  return stopAgentTaskWorker
}

export function stopAgentTaskWorker(): void {
  if (taskDispatcherTimer) clearInterval(taskDispatcherTimer)
  taskDispatcherTimer = null
}
