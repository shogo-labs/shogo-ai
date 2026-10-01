// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace activity in team chat.
 *
 * - `#activity` gets a system line for agent task outcomes, schedule runs,
 *   goal events, publishes and new members, so the whole team can see what
 *   agents and teammates are doing.
 * - Schedules and tasks with `notifyConversationId` also post their result
 *   into that channel/DM as the agent that did the work.
 * - "Catch me up" summarizes unread messages with the workspace agent.
 *
 * Every producer hook is best-effort: chat is never allowed to fail the job
 * that triggered it.
 */

import { prisma } from '../lib/prisma'
import { homeRegionWorkspaceWhere } from '../lib/region'
import {
  ConversationError,
  agentDisplayName,
  getActivityConversation,
  loadAccess,
  postMessage,
} from './conversation.service'
import { renderTranscript, runWorkspaceAgentPrompt } from './conversation-agent-dispatcher'
import { agentChatEnabled, getWorkspaceChatConfig, nativeChatEnabled } from './chat-mode'
import { postAgentMessage } from './chat-providers/outbound'
import { blocksForKind } from './conversation-message-kind'

const db = prisma as any

const MAX_RESULT_CHARS = 6_000
const MAX_CATCH_UP_MESSAGES = 150

export type ActivityKind =
  | 'task.completed'
  | 'task.failed'
  | 'schedule.ok'
  | 'schedule.failed'
  | 'goal.event'
  | 'project.published'
  | 'member.joined'

export interface ActivityInput {
  kind: ActivityKind
  text: string
  /** Stable id for the source event; repeated calls with the same ref post once. */
  ref: string
  link?: string | null
  projectId?: string | null
  actorUserId?: string | null
  meta?: Record<string, unknown>
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function logFailure(what: string, err: unknown): void {
  console.error(`[ConversationActivity] ${what} failed:`, err instanceof Error ? err.message : err)
}

/**
 * Message seq allocation must stay single-writer per workspace. Producers
 * that can run outside the workspace's home region (e.g. invite-link
 * accepts, which are not workspace-routed) skip posting there.
 */
async function isHomeRegionFor(workspaceId: string): Promise<boolean> {
  const homeWhere = homeRegionWorkspaceWhere()
  if (!homeWhere) return true
  const owned = await db.workspace.findFirst({ where: { id: workspaceId, ...homeWhere }, select: { id: true } })
  return !!owned
}

export async function postActivity(workspaceId: string, input: ActivityInput) {
  if (!nativeChatEnabled(await getWorkspaceChatConfig(workspaceId))) return null
  if (!(await isHomeRegionFor(workspaceId))) return null
  const activity = await getActivityConversation(workspaceId)
  if (!activity) return null
  return postMessage({
    conversationId: activity.id,
    text: input.text,
    authorType: 'system',
    externalRef: `activity:${input.ref}`,
    blocks: {
      type: 'activity',
      kind: input.kind,
      link: input.link ?? null,
      projectId: input.projectId ?? null,
      actorUserId: input.actorUserId ?? null,
      ...input.meta,
    },
  })
}

/**
 * Post an agent's result into the conversation a schedule/task was pointed
 * at. Silently skips conversations that are gone, archived, in another
 * workspace, or the read-only activity feed.
 */
export async function deliverAgentResult(input: {
  workspaceId: string
  conversationId: string
  projectId: string | null
  text: string
  failed: boolean
  ref: string
  sessionId?: string | null
  /** Post under this thread; falls back to the channel if the thread is gone. */
  threadRootId?: string | null
}) {
  const conversation = await db.conversation.findUnique({ where: { id: input.conversationId } })
  if (!conversation || conversation.workspaceId !== input.workspaceId) return null
  if (conversation.archivedAt || conversation.kind === 'activity') return null
  if (!agentChatEnabled(await getWorkspaceChatConfig(input.workspaceId))) return null
  if (!(await isHomeRegionFor(input.workspaceId))) return null
  const name = await agentDisplayName(input.workspaceId, input.projectId)
  const root = input.threadRootId
    ? await db.conversationMessage.findFirst({
        where: { id: input.threadRootId, conversationId: conversation.id, threadRootId: null, deletedAt: null },
        select: { id: true },
      })
    : null
  const posted = await postAgentMessage({
    conversationId: conversation.id,
    text: clip(input.text, MAX_RESULT_CHARS),
    agent: { projectId: input.projectId, name },
    threadRootId: root?.id ?? null,
    agentStatus: input.failed ? 'error' : 'done',
    agentSessionId: input.sessionId ?? null,
    externalRef: input.ref,
    // A finished run is a result and stays quiet; a failed one is an alert.
    blocks: blocksForKind({ kind: input.failed ? 'alert' : 'result' }),
  })
  if (!posted.duplicate) {
    void import('./conversation-pipeline')
      .then(({ afterMessagePosted }) => afterMessagePosted(posted, { actorUserId: null, origin: 'agent' }))
      .catch(() => {})
  }
  return posted
}

// ─── Producer hooks ──────────────────────────────────────────────────────────

export async function recordAgentTaskOutcome(task: {
  id: string
  workspaceId: string
  userId: string
  title: string
  projectId: string | null
  chatSessionId: string | null
  notifyConversationId?: string | null
  resultSummary?: string | null
  errorMessage?: string | null
  status: string
}): Promise<void> {
  const failed = task.status === 'failed'
  try {
    const name = await agentDisplayName(task.workspaceId, task.projectId)
    const ref = `task:${task.id}:${task.status}:${task.chatSessionId ?? ''}`
    await postActivity(task.workspaceId, {
      kind: failed ? 'task.failed' : 'task.completed',
      text: failed
        ? `**${name}** couldn't finish the task “${task.title}”: ${clip(task.errorMessage ?? 'unknown error', 300)}`
        : `**${name}** finished the task “${task.title}”.`,
      ref,
      link: `/tasks?taskId=${encodeURIComponent(task.id)}`,
      projectId: task.projectId,
      actorUserId: task.userId,
      meta: { taskId: task.id },
    })
    if (task.notifyConversationId) {
      await deliverAgentResult({
        workspaceId: task.workspaceId,
        conversationId: task.notifyConversationId,
        projectId: task.projectId,
        text: failed
          ? `Task “${task.title}” failed: ${task.errorMessage ?? 'unknown error'}`
          : `**Task “${task.title}” is done.**\n\n${task.resultSummary ?? ''}`,
        failed,
        ref,
        sessionId: task.chatSessionId,
      })
    }
  } catch (err) {
    logFailure('task outcome', err)
  }
}

export async function recordScheduleOutcome(schedule: {
  id: string
  workspaceId: string
  userId: string
  name: string
  chatSessionId?: string | null
  notifyConversationId?: string | null
  notifyThreadRootId?: string | null
}, outcome: { status: string; summary?: string | null; error?: string | null; runKey: string }): Promise<void> {
  if (outcome.status === 'skipped') return
  const failed = outcome.status !== 'ok'
  try {
    const name = await agentDisplayName(schedule.workspaceId, null)
    const ref = `schedule:${schedule.id}:${outcome.runKey}`
    await postActivity(schedule.workspaceId, {
      kind: failed ? 'schedule.failed' : 'schedule.ok',
      text: failed
        ? `**${name}**'s scheduled run “${schedule.name}” failed: ${clip(outcome.error ?? 'unknown error', 300)}`
        : `**${name}** ran the schedule “${schedule.name}”.`,
      ref,
      actorUserId: schedule.userId,
      meta: { scheduleId: schedule.id },
    })
    if (schedule.notifyConversationId) {
      await deliverAgentResult({
        workspaceId: schedule.workspaceId,
        conversationId: schedule.notifyConversationId,
        projectId: null,
        text: failed
          ? `Scheduled run “${schedule.name}” failed: ${outcome.error ?? 'unknown error'}`
          : `**${schedule.name}**\n\n${outcome.summary ?? 'The scheduled run completed.'}`,
        failed,
        ref,
        sessionId: schedule.chatSessionId ?? null,
        threadRootId: schedule.notifyThreadRootId ?? null,
      })
    }
  } catch (err) {
    logFailure('schedule outcome', err)
  }
}

const GOAL_EVENT_LABEL: Record<string, string> = {
  progress: 'made progress on',
  deliverable: 'delivered on',
  blocker: 'is blocked on',
  approval: 'needs approval for',
}

export async function recordGoalEvent(workspaceId: string, event: {
  id: string
  goalId: string
  kind: string
  message: string
}): Promise<void> {
  const verb = GOAL_EVENT_LABEL[event.kind]
  if (!verb) return
  try {
    const goal = await db.goal.findUnique({ where: { id: event.goalId }, select: { title: true } })
    if (!goal) return
    const name = await agentDisplayName(workspaceId, null)
    await postActivity(workspaceId, {
      kind: 'goal.event',
      text: `**${name}** ${verb} the goal “${goal.title}”: ${clip(event.message, 400)}`,
      ref: `goal-event:${event.id}`,
      meta: { goalId: event.goalId, goalEventKind: event.kind },
    })
  } catch (err) {
    logFailure('goal event', err)
  }
}

export async function recordProjectPublished(project: { id: string; workspaceId: string; name: string }, url: string, publishedAt: Date): Promise<void> {
  try {
    await postActivity(project.workspaceId, {
      kind: 'project.published',
      text: `**${project.name}** was published to ${url}`,
      ref: `publish:${project.id}:${publishedAt.getTime()}`,
      link: url,
      projectId: project.id,
    })
  } catch (err) {
    logFailure('publish', err)
  }
}

export async function recordMemberJoined(workspaceId: string, userId: string): Promise<void> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
    await postActivity(workspaceId, {
      kind: 'member.joined',
      text: `**${user?.name || user?.email || 'A new teammate'}** joined the workspace.`,
      ref: `member-joined:${workspaceId}:${userId}`,
      actorUserId: userId,
    })
  } catch (err) {
    logFailure('member joined', err)
  }
}

// ─── Catch me up ─────────────────────────────────────────────────────────────

export interface CatchUpResult {
  summary: string | null
  messageCount: number
  fromSeq: number
  toSeq: number
}

/**
 * Summarize what the user missed in a conversation (everything after their
 * read position, or the last day for channels they haven't joined). The
 * summary is returned only to the requester.
 */
export async function catchUp(conversationId: string, userId: string): Promise<CatchUpResult> {
  const access = await loadAccess(conversationId, userId)
  const { conversation, membership } = access
  const where: Record<string, unknown> = { conversationId, deletedAt: null }
  if (membership) where.seq = { gt: membership.lastReadSeq ?? 0 }
  else where.createdAt = { gte: new Date(Date.now() - 24 * 60 * 60_000) }

  const rows = await db.conversationMessage.findMany({
    where,
    orderBy: { seq: 'desc' },
    take: MAX_CATCH_UP_MESSAGES,
    include: { authorUser: { select: { name: true, email: true } } },
  })
  const history = rows.reverse().filter((m: any) => m.text?.trim() && m.agentStatus !== 'running')
  if (!history.length) return { summary: null, messageCount: 0, fromSeq: 0, toSeq: 0 }

  const transcript = await renderTranscript(conversation.workspaceId, history)
  const where_ = conversation.kind === 'dm' || conversation.kind === 'group_dm'
    ? 'a direct message conversation'
    : `the #${conversation.name ?? 'channel'} channel`
  const prompt = [
    `Summarize what I missed in ${where_} of our team chat.`,
    'Lead with decisions, requests addressed to me, and open questions; then briefly list other notable updates.',
    'Use short Markdown bullets and name who said what. Do not use tools; answer only from the messages below.',
    '',
    transcript,
  ].join('\n')

  const result = await runWorkspaceAgentPrompt({
    workspaceId: conversation.workspaceId,
    userId,
    prompt,
    label: `Catch up: #${conversation.name ?? 'conversation'}`,
  })
  if (result.failed) {
    throw new ConversationError(502, 'agent_failed', result.error ?? 'The agent could not summarize this conversation')
  }
  return {
    summary: result.text || null,
    messageCount: history.length,
    fromSeq: history[0].seq,
    toSeq: history[history.length - 1].seq,
  }
}
