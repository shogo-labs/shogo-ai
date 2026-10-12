// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where an #activity line leads. The row opens the real source — the channel
 * message, the agent session, the goal, or the published site — instead of a
 * discussion thread on the activity line itself.
 */
export type ActivityTarget =
  | { type: 'route'; pathname: string; params: Record<string, string> }
  | { type: 'url'; url: string }

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The place a line opens, or null when the line has nowhere to go. */
export function activityTarget(blocks: Record<string, unknown> | null | undefined): ActivityTarget | null {
  if (!blocks || blocks.type !== 'activity' || typeof blocks.kind !== 'string') return null
  const kind = blocks.kind

  if (kind === 'agent.message') {
    const conversationId = text(blocks.conversationId)
    const messageId = text(blocks.messageId)
    if (!conversationId || !messageId) return null
    const params: Record<string, string> = { conversationId, msg: messageId }
    const thread = text(blocks.threadRootId)
    if (thread) params.thread = thread
    return { type: 'route', pathname: '/(app)/c/[conversationId]', params }
  }

  if (kind.startsWith('task.')) {
    const projectId = text(blocks.projectId)
    const chatSessionId = text(blocks.chatSessionId)
    if (projectId) {
      const params: Record<string, string> = { id: projectId }
      if (chatSessionId) params.chatSessionId = chatSessionId
      return { type: 'route', pathname: '/(app)/projects/[id]', params }
    }
    if (chatSessionId) return { type: 'route', pathname: '/(app)/agent', params: { chatSessionId } }
    const taskId = text(blocks.taskId)
    if (taskId) return { type: 'route', pathname: '/(app)/tasks', params: { taskId } }
    return null
  }

  if (kind.startsWith('schedule.')) {
    const chatSessionId = text(blocks.chatSessionId)
    if (!chatSessionId) return null
    return { type: 'route', pathname: '/(app)/agent', params: { chatSessionId } }
  }

  if (kind === 'goal.event') {
    const id = text(blocks.goalId)
    return id ? { type: 'route', pathname: '/(app)/goals/[id]', params: { id } } : null
  }

  if (kind === 'project.published') {
    const url = text(blocks.link)
    return url ? { type: 'url', url } : null
  }

  return null
}
