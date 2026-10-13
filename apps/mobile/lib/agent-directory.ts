// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ActiveChatTurn, AgentTask } from './api'

/**
 * Where to open when someone taps what an agent is working on.
 * A channel reply opens that conversation; everything else opens the session.
 */
export type WorkTarget =
  | { kind: 'conversation'; conversationId: string; threadRootId: string | null; messageId: string | null }
  | { kind: 'session'; projectId: string | null; chatSessionId: string | null; isPrimary: boolean }

export interface AgentWork {
  /** Full line under the agent, e.g. "Working in #ops" or "Working on Reconcile invoices". */
  label: string
  /** The place or title after "working in/on", for the DM banner. */
  place: string
  relation: 'in' | 'on'
  target: WorkTarget
}

type TaskLike = Pick<AgentTask, 'projectId' | 'status' | 'title' | 'startedAt' | 'chatSessionId'>
type ChatLike = Pick<ActiveChatTurn, 'projectId' | 'sessionName' | 'chatSessionId' | 'isPrimary'> &
  Partial<Pick<ActiveChatTurn, 'conversationId' | 'threadRootId' | 'messageId' | 'conversationName' | 'conversationKind'>>

/**
 * What each agent is working on right now, by the project it belongs to: the
 * title of its running task, or of the chat it is answering. A queued task
 * only counts when nothing is running yet. A task whose session is a team-chat
 * reply points at that conversation instead of the backing session.
 */
export function agentWorkingOn(tasks: TaskLike[], chats: ChatLike[]): Map<string, AgentWork> {
  const working = new Map<string, AgentWork>()
  const queued = new Map<string, AgentWork>()
  const chatBySession = new Map(chats.filter((chat) => chat.chatSessionId).map((chat) => [chat.chatSessionId, chat]))
  const started = (t: { startedAt?: string | null }) => Date.parse(t.startedAt ?? '') || 0
  for (const task of [...tasks].sort((a, b) => started(a) - started(b))) {
    if (!task.projectId) continue
    const work = workForTask(task, chatBySession.get(task.chatSessionId ?? ''))
    if (task.status === 'running') working.set(task.projectId, work)
    else if (task.status === 'queued') queued.set(task.projectId, work)
  }
  for (const chat of chats) {
    if (chat.projectId && !working.has(chat.projectId)) working.set(chat.projectId, workFromChat(chat))
  }
  for (const [projectId, work] of queued) if (!working.has(projectId)) working.set(projectId, work)
  return working
}

function workForTask(task: TaskLike, chat: ChatLike | undefined): AgentWork {
  if (chat?.conversationId) return workFromChat(chat)
  return {
    label: `Working on ${task.title}`,
    place: task.title,
    relation: 'on',
    target: {
      kind: 'session',
      projectId: task.projectId,
      chatSessionId: task.chatSessionId ?? chat?.chatSessionId ?? null,
      isPrimary: chat?.isPrimary ?? false,
    },
  }
}

function workFromChat(chat: ChatLike): AgentWork {
  const place = conversationPlace(chat)
  if (chat.conversationId && place) {
    return {
      label: `Working in ${place}`,
      place,
      relation: 'in',
      target: {
        kind: 'conversation',
        conversationId: chat.conversationId,
        threadRootId: chat.threadRootId ?? null,
        messageId: chat.messageId ?? null,
      },
    }
  }
  return {
    label: `Working on ${chat.sessionName}`,
    place: chat.sessionName,
    relation: 'on',
    target: {
      kind: 'session',
      projectId: chat.projectId,
      chatSessionId: chat.chatSessionId ?? null,
      isPrimary: chat.isPrimary ?? false,
    },
  }
}

/** `#ops` for a channel, the conversation name for a DM. */
function conversationPlace(chat: ChatLike): string | null {
  if (!chat.conversationId) return null
  if (chat.conversationKind === 'dm' || chat.conversationKind === 'group_dm') {
    return chat.conversationName || 'a direct message'
  }
  const name = (chat.conversationName || 'channel').replace(/^#/, '')
  return `#${name}`
}
