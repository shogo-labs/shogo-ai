// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Filter chips for the #activity channel. Matching is pure: the timeline
 * keeps every message loaded and only hides the ones that don't fit.
 */
import type { ChatMessage } from './team-chat-api'

export type ActivityChannelFilter =
  | 'all'
  | 'agent_messages'
  | 'questions'
  | 'tasks'
  | 'work'
  | 'schedules'
  | 'goals'
  | 'publishes'
  | 'members'

export const ACTIVITY_CHANNEL_FILTERS: Array<{ id: ActivityChannelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent_messages', label: 'Agent messages' },
  { id: 'questions', label: 'Questions' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'work', label: 'Work' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'goals', label: 'Goals' },
  { id: 'publishes', label: 'Publishes' },
  { id: 'members', label: 'Members' },
]

const PREFIX: Partial<Record<ActivityChannelFilter, string>> = {
  questions: 'question.',
  tasks: 'task.',
  work: 'work.',
  schedules: 'schedule.',
}

const EXACT: Partial<Record<ActivityChannelFilter, string>> = {
  agent_messages: 'agent.message',
  goals: 'goal.event',
  publishes: 'project.published',
  members: 'member.joined',
}

/** Whether an #activity line belongs under a chip. "All" shows everything, including replies. */
export function matchesActivityFilter(message: Pick<ChatMessage, 'blocks'>, filter: ActivityChannelFilter): boolean {
  if (filter === 'all') return true
  const blocks = message.blocks
  if (!blocks || blocks.type !== 'activity' || typeof blocks.kind !== 'string') return false
  const prefix = PREFIX[filter]
  if (prefix) return blocks.kind.startsWith(prefix)
  return blocks.kind === EXACT[filter]
}

/**
 * Kind chip plus any number of agents and channels. An empty list means that
 * axis is not narrowed.
 */
export interface ActivityFilterState {
  kind: ActivityChannelFilter
  /** Mentionable agent keys: 'ws' or 'p:<projectId>'. Empty = any agent. */
  agentKeys: string[]
  conversationIds: string[]
}

export const EMPTY_ACTIVITY_FILTER: ActivityFilterState = { kind: 'all', agentKeys: [], conversationIds: [] }

export function isActivityFilterActive(filter: ActivityFilterState): boolean {
  return filter.kind !== 'all' || filter.agentKeys.length > 0 || filter.conversationIds.length > 0
}

function activityBlocks(message: Pick<ChatMessage, 'blocks'>): Record<string, unknown> | null {
  const blocks = message.blocks
  if (!blocks || blocks.type !== 'activity' || typeof blocks.kind !== 'string') return null
  return blocks
}

/**
 * Agent key for a line. Members joining aren't an agent's work, so they match
 * no agent. A missing project is the workspace agent (`ws`).
 */
function activityAgentKey(blocks: Record<string, unknown>): string | null {
  if (blocks.kind === 'member.joined') return null
  const projectId = blocks.projectId
  return typeof projectId === 'string' && projectId ? `p:${projectId}` : 'ws'
}

/**
 * Kind, agent, and channel must all match. Several agents (or channels) match
 * a line when it belongs to any of them. An empty list matches every line.
 */
export function matchesActivityFilters(message: Pick<ChatMessage, 'blocks'>, filter: ActivityFilterState): boolean {
  if (!matchesActivityFilter(message, filter.kind)) return false
  const blocks = activityBlocks(message)
  if (filter.agentKeys.length > 0) {
    const key = blocks ? activityAgentKey(blocks) : null
    if (!key || !filter.agentKeys.includes(key)) return false
  }
  if (filter.conversationIds.length > 0) {
    const conversationId = blocks?.conversationId
    if (typeof conversationId !== 'string' || !filter.conversationIds.includes(conversationId)) return false
  }
  return true
}
