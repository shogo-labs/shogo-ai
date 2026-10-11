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
  | 'tasks'
  | 'schedules'
  | 'goals'
  | 'publishes'
  | 'members'

export const ACTIVITY_CHANNEL_FILTERS: Array<{ id: ActivityChannelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent_messages', label: 'Agent messages' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'goals', label: 'Goals' },
  { id: 'publishes', label: 'Publishes' },
  { id: 'members', label: 'Members' },
]

const PREFIX: Partial<Record<ActivityChannelFilter, string>> = {
  tasks: 'task.',
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
