// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ActiveChatTurn, AgentTask } from './api'

/**
 * What each agent is working on right now, by the project it belongs to: the
 * title of its running task, or of the chat it is answering. A queued task
 * only counts when nothing is running yet.
 */
export function agentWorkingOn(tasks: Pick<AgentTask, 'projectId' | 'status' | 'title' | 'startedAt'>[], chats: Pick<ActiveChatTurn, 'projectId' | 'sessionName'>[]): Map<string, string> {
  const working = new Map<string, string>()
  const queued = new Map<string, string>()
  const started = (t: { startedAt?: string | null }) => Date.parse(t.startedAt ?? '') || 0
  for (const task of [...tasks].sort((a, b) => started(a) - started(b))) {
    if (!task.projectId) continue
    if (task.status === 'running') working.set(task.projectId, task.title)
    else if (task.status === 'queued') queued.set(task.projectId, task.title)
  }
  for (const chat of chats) {
    if (chat.projectId && !working.has(chat.projectId)) working.set(chat.projectId, chat.sessionName)
  }
  for (const [projectId, title] of queued) if (!working.has(projectId)) working.set(projectId, title)
  return working
}
