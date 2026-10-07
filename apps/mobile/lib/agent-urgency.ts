// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The agents on Home, most urgent first: ones waiting on you, then failures,
 * then agents working, then queued, then ones that just finished. Pure, so the
 * Home list, the widgets and the Live Activity all agree on the order.
 */
import type { ActiveChatTurn, AgentTask } from './api'
import { readableAgentTaskError } from './agent-task-ui'
import type { PendingApproval } from './team-chat-api'

export type AgentUrgencyState = 'needs_you' | 'failed' | 'running' | 'queued' | 'done'

const RANK: Record<AgentUrgencyState, number> = { needs_you: 0, failed: 1, running: 2, queued: 3, done: 4 }

/** A failure or finish older than this is history, not something to show on Home. */
export const RECENT_MS = 24 * 60 * 60 * 1000

/** The key of the workspace agent, which has no project. */
export const WORKSPACE_AGENT_KEY = 'ws'

export function urgencyRank(state: AgentUrgencyState): number {
  return RANK[state]
}

/** Most urgent first; within a state, the newest first. Does not change its input. */
export function sortByUrgency<T extends { state: AgentUrgencyState; at: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at)
}

export interface UrgencyAgent {
  key: string
  projectId: string | null
  name: string
}

type TaskLike = Pick<
  AgentTask,
  'id' | 'projectId' | 'status' | 'title' | 'currentStep' | 'resultSummary' | 'errorMessage' | 'chatSessionId' | 'startedAt' | 'completedAt' | 'updatedAt' | 'createdAt'
>
type ChatLike = Pick<ActiveChatTurn, 'projectId' | 'sessionName' | 'startedAt' | 'chatSessionId'>

export interface AgentRow {
  /** The agent's key: its project id, or `ws` for the workspace agent. */
  key: string
  projectId: string | null
  name: string
  state: AgentUrgencyState
  /** The line under the name: the command waiting, the step running, the error. */
  detail: string
  at: number
  approval: PendingApproval | null
  /** The running or latest task, to open its chat. */
  taskId: string | null
  chatSessionId: string | null
}

const time = (value: string | null | undefined): number => {
  const parsed = Date.parse(value ?? '')
  return Number.isNaN(parsed) ? 0 : parsed
}

const taskAt = (t: TaskLike) => time(t.updatedAt || t.completedAt || t.startedAt || t.createdAt)

/** The state label shown under an agent's name. */
export function stateLabel(state: AgentUrgencyState): string {
  switch (state) {
    case 'needs_you':
      return 'Waiting for your OK'
    case 'failed':
      return 'Failed'
    case 'running':
      return 'Working'
    case 'queued':
      return 'Queued'
    case 'done':
      return 'Done'
  }
}

/**
 * One row per agent that has something to show. Agents with nothing running,
 * waiting or recently finished are left out.
 */
export function buildAgentRows(input: {
  agents: readonly UrgencyAgent[]
  tasks: readonly TaskLike[]
  activeChats: readonly ChatLike[]
  approvals: readonly PendingApproval[]
  now?: number
}): AgentRow[] {
  const now = input.now ?? Date.now()
  const keyOf = (projectId: string | null) => projectId ?? WORKSPACE_AGENT_KEY
  const rows: AgentRow[] = []

  for (const agent of input.agents) {
    const key = agent.projectId ?? WORKSPACE_AGENT_KEY
    const tasks = input.tasks.filter((t) => keyOf(t.projectId) === key)
    const chat = input.activeChats.find((c) => keyOf(c.projectId) === key) ?? null
    const approval =
      input.approvals
        .filter((a) => keyOf(a.projectId) === key)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0] ?? null

    const running = tasks.filter((t) => t.status === 'running').sort((a, b) => taskAt(b) - taskAt(a))[0]
    const queued = tasks.filter((t) => t.status === 'queued').sort((a, b) => taskAt(b) - taskAt(a))[0]
    const failed = tasks
      .filter((t) => (t.status === 'failed' || t.status === 'cancelled') && now - taskAt(t) < RECENT_MS)
      .sort((a, b) => taskAt(b) - taskAt(a))[0]
    const done = tasks
      .filter((t) => t.status === 'completed' && now - taskAt(t) < RECENT_MS)
      .sort((a, b) => taskAt(b) - taskAt(a))[0]

    const base = { key, projectId: agent.projectId, name: agent.name, approval, taskId: null as string | null, chatSessionId: null as string | null }
    let row: AgentRow | null = null

    if (approval) {
      row = { ...base, state: 'needs_you', detail: approval.summary, at: time(approval.createdAt) }
    } else if (running) {
      // Working again beats an earlier failure: the retry is what matters now.
      row = {
        ...base,
        state: 'running',
        detail: running.currentStep?.trim() || running.title,
        at: taskAt(running),
        taskId: running.id,
        chatSessionId: running.chatSessionId,
      }
    } else if (chat) {
      row = { ...base, state: 'running', detail: chat.sessionName, at: time(chat.startedAt), chatSessionId: chat.chatSessionId }
    } else if (failed) {
      row = {
        ...base,
        state: 'failed',
        detail: readableAgentTaskError(failed.errorMessage, 'This task did not complete.'),
        at: taskAt(failed),
        taskId: failed.id,
        chatSessionId: failed.chatSessionId,
      }
    } else if (queued) {
      row = { ...base, state: 'queued', detail: queued.title, at: taskAt(queued), taskId: queued.id, chatSessionId: queued.chatSessionId }
    } else if (done) {
      row = {
        ...base,
        state: 'done',
        detail: done.resultSummary?.trim() || done.title,
        at: taskAt(done),
        taskId: done.id,
        chatSessionId: done.chatSessionId,
      }
    }
    if (row) rows.push(row)
  }
  return sortByUrgency(rows)
}
