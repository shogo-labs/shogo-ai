// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tasks as a board: one lane per status. Dragging a draft into Queued starts
 * it, dragging queued or running work into Failed cancels it; other drops do
 * nothing because the agent, not the person, moves tasks along.
 */
import type { AgentTaskStatus } from './api'

export type TaskLane = 'draft' | 'queued' | 'running' | 'done' | 'failed'

export const TASK_LANES: Array<{ id: TaskLane; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
]

export function taskLane(status: AgentTaskStatus): TaskLane {
  switch (status) {
    case 'draft':
    case 'queued':
    case 'running':
      return status
    case 'completed':
      return 'done'
    default:
      return 'failed'
  }
}

export type TaskDropAction = 'start' | 'cancel' | null

export function taskDropAction(status: AgentTaskStatus, lane: TaskLane): TaskDropAction {
  if (status === 'draft' && (lane === 'queued' || lane === 'running')) return 'start'
  if ((status === 'queued' || status === 'running') && lane === 'failed') return 'cancel'
  return null
}
