// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runs agents that were @mentioned (or subscribed) in a workspace channel.
 *
 * Each reply is a thread message backed by its own ChatSession, so the full
 * agent transcript (tools, files, checkpoints) stays inspectable in the
 * normal chat UI while the channel sees a concise streamed answer. Follow-ups
 * in the same thread reuse that session, giving the agent memory of the
 * thread without sharing one session across the whole channel.
 */

import { prisma } from '../lib/prisma'
import { finishAgentReply, startAgentReply, streamAgentReply } from './chat-providers/outbound'
import {
  agentKey,
  collectMentionIds,
  groupNames,
  mentionedAgents,
  renderMentionsAsText,
  type AgentTarget,
  type MentionNames,
  type ParsedMention,
} from './conversation-mentions'
import {
  agentDisplayName,
  listAgentMembers,
  MESSAGE_INCLUDE,
  postMessage,
  replaceMentions,
  serializeMessage,
  type PostMessageResult,
} from './conversation.service'
import type { IRuntimeManager } from '../lib/runtime'
import { tryAcquireSharedSlot } from '../lib/chat-limits'
import {
  agentMentionChainsEnabled,
  agentTurnsSinceHuman,
  chainLimitHit,
  envInt,
  humanChain,
  MAX_AGENT_CHAIN_DEPTH,
  MAX_AGENT_PING_PONG_TURNS,
  MAX_AGENT_TURNS_PER_THREAD,
  nextChain,
  readChain,
  rootChain,
  threadOwner,
  type AgentChain,
  type ChainLimit,
} from './conversation-agent-chain'
import { resolveFriendlyMentions } from './conversation-directory'

const db = prisma as any

export const MAX_AGENTS_PER_MESSAGE = 3
export const MAX_CONCURRENT_AGENT_REPLIES_PER_WORKSPACE = envInt('SHOGO_CHANNEL_AGENT_CONCURRENCY', 6)
const CONTEXT_MESSAGES = 20
const DELTA_THROTTLE_MS = 350
export const AGENT_REPLY_TIMEOUT_MS = envInt('SHOGO_CHANNEL_AGENT_TIMEOUT_MS', 30 * 60_000)
const PROVIDER_SURFACE: Record<string, string> = { slack: 'Slack', teams: 'Microsoft Teams', google_chat: 'Google Chat' }

interface DispatcherConfig {
  runtimeManager?: IRuntimeManager
  /** Test seam: replaces the internal chat route call. */
  invoke?: (args: InvokeArgs) => Promise<Response>
}

let config: DispatcherConfig = {}

export function configureConversationAgentDispatcher(next: DispatcherConfig): void {
  config = { ...config, ...next }
}

export interface InvokeArgs {
  workspaceId: string
  projectId: string | null
  sessionId: string
  userId: string
  prompt: string
  signal: AbortSignal
}

const running = new Map<string, AbortController>()
const activeByWorkspace = new Map<string, number>()
const waiters = new Map<string, Array<() => void>>()

// A lease outlives the longest run so a crashed pod's slots free themselves.
const SLOT_LEASE_MS = AGENT_REPLY_TIMEOUT_MS + 60_000
const SLOT_POLL_MS = 1_000

async function acquireLocalSlot(workspaceId: string): Promise<() => void> {
  const active = activeByWorkspace.get(workspaceId) ?? 0
  if (active >= MAX_CONCURRENT_AGENT_REPLIES_PER_WORKSPACE) {
    await new Promise<void>((resolve) => {
      const queue = waiters.get(workspaceId) ?? []
      queue.push(resolve)
      waiters.set(workspaceId, queue)
    })
  }
  activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    activeByWorkspace.set(workspaceId, Math.max(0, (activeByWorkspace.get(workspaceId) ?? 1) - 1))
    const next = waiters.get(workspaceId)?.shift()
    if (next) next()
  }
}

/** One of the workspace's agent-reply slots, shared across pods when Redis is up. */
async function acquireSlot(workspaceId: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    signal?.throwIfAborted()
    const shared = await tryAcquireSharedSlot(`agent-replies:${workspaceId}`, MAX_CONCURRENT_AGENT_REPLIES_PER_WORKSPACE, SLOT_LEASE_MS)
    if (shared) return shared
    if (shared === null) return acquireLocalSlot(workspaceId)
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS + Math.random() * 250))
  }
}

// ─── Target selection ────────────────────────────────────────────────────────

function keywordMatch(text: string, keywords: string | null): boolean {
  if (!keywords) return false
  const lower = text.toLowerCase()
  return keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((k) => lower.includes(k))
}

/** Agent that last replied in this thread (for follow-ups without a fresh @mention). */
async function threadAgent(conversationId: string, threadRootId: string): Promise<AgentTarget | null> {
  const last = await db.conversationMessage.findFirst({
    where: {
      conversationId,
      authorType: 'agent',
      OR: [{ id: threadRootId }, { threadRootId }],
    },
    orderBy: { seq: 'desc' },
    select: { authorAgentRef: true },
  })
  const ref = last?.authorAgentRef
  return ref ? { projectId: ref.projectId ?? null } : null
}

/** Drops mention targets whose project is missing or belongs to another workspace. */
async function inWorkspace(workspaceId: string, targets: AgentTarget[]): Promise<AgentTarget[]> {
  const projectIds = [...new Set(targets.map((t) => t.projectId).filter((id): id is string => !!id))]
  if (!projectIds.length) return targets
  const rows = await db.project.findMany({ where: { id: { in: projectIds }, workspaceId }, select: { id: true } })
  const allowed = new Set(rows.map((r: any) => r.id))
  return targets.filter((t) => !t.projectId || allowed.has(t.projectId))
}

/** Private channels only admit agents that are members. */
async function allowedInConversation(conversation: any, targets: AgentTarget[]): Promise<AgentTarget[]> {
  if (conversation.kind !== 'private' || !targets.length) return targets
  const members = await listAgentMembers(conversation.id)
  const keys = new Set(members.map((m: any) => agentKey({ projectId: m.projectId ?? null })))
  return targets.filter((t) => keys.has(agentKey(t)))
}

export async function selectAgentTargets(
  result: Pick<PostMessageResult, 'row' | 'conversation'>,
  options: { fromAgent?: boolean } = {},
): Promise<AgentTarget[]> {
  const { row, conversation } = result
  const targets = new Map<string, AgentTarget>()
  for (const target of await inWorkspace(conversation.workspaceId, mentionedAgents(row.text))) {
    targets.set(agentKey(target), target)
  }

  if (options.fromAgent) {
    // Agents wake each other only by explicit mention: channel triggers
    // ("all", keywords) and thread follow-ups would turn every post into a loop.
    targets.delete(agentKey({ projectId: row.authorAgentRef?.projectId ?? null }))
    return (await allowedInConversation(conversation, Array.from(targets.values()))).slice(0, MAX_AGENTS_PER_MESSAGE)
  }

  if (!targets.size) {
    const members = await listAgentMembers(conversation.id)
    for (const member of members) {
      const target = { projectId: member.projectId ?? null }
      const topLevel = !row.threadRootId
      if (member.agentTrigger === 'all' && (topLevel || conversation.kind === 'dm')) {
        targets.set(agentKey(target), target)
      } else if (member.agentTrigger === 'keyword' && topLevel && keywordMatch(row.text, member.agentKeywords)) {
        targets.set(agentKey(target), target)
      }
    }
  }

  if (!targets.size && row.threadRootId) {
    const owner = await threadOwner(row.threadRootId)
    const target = (owner && (await inWorkspace(conversation.workspaceId, [owner]))[0]) || (await threadAgent(conversation.id, row.threadRootId))
    if (target) targets.set(agentKey(target), target)
  }

  return Array.from(targets.values()).slice(0, MAX_AGENTS_PER_MESSAGE)
}

/** Entry point after a human posts a message. Fire-and-forget per agent. */
export async function dispatchAgentsForMessage(result: PostMessageResult, actorUserId: string): Promise<AgentTarget[]> {
  if (result.duplicate || result.row.authorType !== 'user') return []
  const targets = await selectAgentTargets(result)
  if (!targets.length) return []
  const chain = humanChain(result.row, actorUserId, await rootChain(result.row.threadRootId))
  for (const target of targets) {
    void runAgentReply({
      conversation: result.conversation,
      trigger: result.row,
      target,
      userId: actorUserId,
      chain: nextChain(chain, target, 0),
    }).catch((err) => console.error('[ChannelAgent] reply failed:', err))
  }
  return targets
}

function replyThreadRoot(conversation: any, trigger: any): string | null {
  return isAgentDm(conversation) ? trigger.threadRootId ?? null : trigger.threadRootId ?? trigger.id
}

/**
 * Entry point after an agent posts (tool post or finished reply) with agent
 * mentions in it. Runs the mentioned agents as the next hop of the chain,
 * billed to the person who started it, unless a chain limit trips.
 */
export async function dispatchAgentsFromAgentMessage(result: Pick<PostMessageResult, 'row' | 'conversation' | 'duplicate'>): Promise<AgentTarget[]> {
  const { row, conversation } = result
  if (result.duplicate || row.authorType !== 'agent' || !agentMentionChainsEnabled()) return []
  const chain = readChain(row.agentChain)
  if (!chain?.originUserId || !mentionedAgents(row.text).length) return []
  const targets = await selectAgentTargets(result, { fromAgent: true })
  if (!targets.length) return []

  const turns = await agentTurnsSinceHuman(conversation.id, replyThreadRoot(conversation, row))
  const started: AgentTarget[] = []
  let tripped: ChainLimit | null = null
  for (const target of targets) {
    const next = nextChain(chain, target, turns + started.length)
    const limit = chainLimitHit(next)
    if (limit) {
      tripped ??= limit
      continue
    }
    started.push(target)
    void runAgentReply({ conversation, trigger: row, target, userId: chain.originUserId, chain: next })
      .catch((err) => console.error('[ChannelAgent] chained reply failed:', err))
  }
  if (tripped) await postChainPaused(conversation, row, chain, tripped)
  return started
}

function pausedReason(limit: ChainLimit): string {
  if (limit === 'depth') return `after ${MAX_AGENT_CHAIN_DEPTH} agent hand-offs`
  if (limit === 'thread_turns') return `after ${MAX_AGENT_TURNS_PER_THREAD} agent turns in this thread`
  return `because two agents handed work back and forth ${MAX_AGENT_PING_PONG_TURNS} times`
}

/** Stop a chain: a system note in the thread that tags (and notifies) whoever started it. */
async function postChainPaused(conversation: any, trigger: any, chain: AgentChain, limit: ChainLimit): Promise<void> {
  const result = await postMessage({
    conversationId: conversation.id,
    authorType: 'system',
    threadRootId: replyThreadRoot(conversation, trigger),
    text: `Paused ${pausedReason(limit)}. <@u:${chain.originUserId}>, reply here to continue.`,
    blocks: { chainPaused: { limit, depth: chain.depth } },
    systemMentions: true,
  })
  const { afterMessagePosted } = await import('./conversation-pipeline')
  await afterMessagePosted(result, { actorUserId: null, origin: 'system' })
}

// ─── Reply execution ─────────────────────────────────────────────────────────

function agentName(workspaceId: string, target: AgentTarget): Promise<string> {
  return agentDisplayName(workspaceId, target.projectId)
}

function isAgentDm(conversation: any): boolean {
  return conversation.kind === 'dm' && typeof conversation.dmKey === 'string' && conversation.dmKey.startsWith('a:')
}

async function existingSession(conversation: any, threadRootId: string | null, target: AgentTarget): Promise<string | null> {
  const where: Record<string, unknown> = {
    conversationId: conversation.id,
    authorType: 'agent',
    agentSessionId: { not: null },
  }
  if (threadRootId) where.OR = [{ id: threadRootId }, { threadRootId }]
  else where.threadRootId = null
  const rows = await db.conversationMessage.findMany({
    where,
    orderBy: { seq: 'desc' },
    take: 20,
    select: { agentSessionId: true, authorAgentRef: true },
  })
  const match = rows.find((r: any) => agentKey({ projectId: r.authorAgentRef?.projectId ?? null }) === agentKey(target))
  if (!match?.agentSessionId) return null
  const session = await db.chatSession.findUnique({ where: { id: match.agentSessionId }, select: { id: true } })
  return session?.id ?? null
}

async function createSession(conversation: any, target: AgentTarget, label: string): Promise<string> {
  const session = await db.chatSession.create({
    data: target.projectId
      ? { inferredName: label.slice(0, 120), contextType: 'project', contextId: target.projectId }
      : { inferredName: label.slice(0, 120), contextType: 'workspace', workspaceId: conversation.workspaceId },
    select: { id: true },
  })
  return session.id
}

/**
 * Plain-text transcript for a prompt. Rows need `authorUser` ({name,email})
 * included; mention tokens are rendered as names.
 */
/** Display names for every mention token in `texts`. */
export async function loadMentionNames(workspaceId: string, texts: string[]): Promise<MentionNames> {
  const ids = collectMentionIds(texts)
  const [users, projects, conversations, workspaceAgentName] = await Promise.all([
    ids.userIds.length ? db.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, name: true, email: true } }) : [],
    ids.projectIds.length ? db.project.findMany({ where: { id: { in: ids.projectIds } }, select: { id: true, name: true } }) : [],
    ids.conversationIds.length ? db.conversation.findMany({ where: { id: { in: ids.conversationIds } }, select: { id: true, name: true } }) : [],
    agentName(workspaceId, { projectId: null }),
  ])
  return {
    users: new Map<string, string>(users.map((u: any) => [u.id, u.name || u.email])),
    projects: new Map<string, string>(projects.map((p: any) => [p.id, p.name])),
    conversations: new Map<string, string>(conversations.map((c: any) => [c.id, c.name ?? 'channel'])),
    groups: await groupNames(db, workspaceId, ids.groupIds),
    workspaceAgentName,
  }
}

export async function renderTranscript(workspaceId: string, history: any[], markMessageId?: string): Promise<string> {
  const names = await loadMentionNames(workspaceId, history.map((m) => m.text))
  const author = (m: any) =>
    m.authorType === 'user' ? (m.authorUser?.name || m.authorUser?.email || m.blocks?.externalAuthor?.name || 'Someone')
      : m.authorType === 'agent' ? `${m.authorAgentRef?.name ?? 'Agent'} (agent)`
        : m.authorType === 'bot' ? 'Bot' : 'System'
  return history
    .map((m) => `${author(m)}${m.id === markMessageId ? ' [mentions you]' : ''}: ${renderMentionsAsText(m.text, names)}`)
    .join('\n')
}

async function buildPrompt(args: {
  conversation: any
  trigger: any
  threadRootId: string | null
  reusedSession: boolean
  name: string
  workspaceName: string
  chain: AgentChain
}): Promise<string> {
  const { conversation, trigger, threadRootId, reusedSession, name, workspaceName, chain } = args
  let history: any[]
  if (threadRootId) {
    history = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id, OR: [{ id: threadRootId }, { threadRootId }], deletedAt: null },
      orderBy: { seq: 'desc' },
      take: CONTEXT_MESSAGES,
      include: { authorUser: { select: { name: true, email: true } } },
    })
  } else {
    history = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id, threadRootId: null, deletedAt: null, seq: { lte: trigger.seq } },
      orderBy: { seq: 'desc' },
      take: reusedSession ? 6 : CONTEXT_MESSAGES,
      include: { authorUser: { select: { name: true, email: true } } },
    })
  }
  history = history.reverse().filter((m) => m.text?.trim() && !(m.authorType === 'agent' && m.agentStatus === 'running'))

  if (reusedSession) {
    const lastAgentIdx = history.map((m) => m.authorType).lastIndexOf('agent')
    if (lastAgentIdx >= 0) history = history.slice(lastAgentIdx + 1)
  }

  const transcript = await renderTranscript(conversation.workspaceId, history, trigger.id)

  const where = isAgentDm(conversation)
    ? 'a direct message with a teammate'
    : conversation.kind === 'dm' || conversation.kind === 'group_dm'
      ? 'a direct message between teammates'
      : `the #${conversation.name ?? 'channel'} channel`
  const surface = PROVIDER_SURFACE[conversation.provider] ?? 'Shogo'
  const lines = [
    `You are ${name}, a teammate in ${where} of the "${workspaceName}" workspace's team chat in ${surface}.`,
    threadRootId ? 'You are replying inside a thread; the thread so far is below.' : 'Recent messages are below.',
    'Reply to the latest message addressed to you. Write concise Markdown suitable for a chat message.',
    'Do real work with your tools when asked. The team sees only your final reply here; your full session is linked from it.',
    ...chainContext(conversation, trigger, threadRootId, chain),
    '',
    transcript,
  ]
  return lines.join('\n')
}

function chainContext(conversation: any, trigger: any, threadRootId: string | null, chain: AgentChain): string[] {
  const ids = [`channel id ${conversation.id}`]
  if (threadRootId) ids.push(`thread id ${threadRootId}`)
  if (chain.runId) ids.push(`run id ${chain.runId}`)
  const lines = [`Team chat context: ${ids.join(', ')}.`]
  if (trigger.authorType === 'agent') {
    lines.push(`${trigger.authorAgentRef?.name ?? 'Another agent'} (an agent) handed this to you.`)
  }
  lines.push(
    'To hand work to another agent, tag them in your reply (e.g. @Planner); they run next in this thread. ' +
      'Tag people only when you need a decision from them.',
    'Write your reply so someone reading the thread later understands it: in two to four sentences, say what you did, ' +
      'what you found or decided and why, and what you need next. No bare "your turn" or "done".',
  )
  if (chain.depth >= MAX_AGENT_CHAIN_DEPTH - 2 || chain.turns >= MAX_AGENT_TURNS_PER_THREAD - 3) {
    lines.push(
      `This is agent hand-off ${chain.depth} of ${MAX_AGENT_CHAIN_DEPTH}; finish the work or ask a person ` +
        'instead of handing off again.',
    )
  }
  return lines
}

async function invokeChat(args: InvokeArgs): Promise<Response> {
  if (config.invoke) return config.invoke(args)
  const body = JSON.stringify({
    messages: [{ role: 'user', parts: [{ type: 'text', text: args.prompt }] }],
    chatSessionId: args.sessionId,
    userId: args.userId,
    agentMode: 'auto',
    interactionMode: 'agent',
    clientTurnId: `channel-agent-${args.sessionId}-${crypto.randomUUID()}`,
  })
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': args.sessionId,
    'X-Billing-User-Id': args.userId,
    'X-Channel-User-Id': args.userId,
  }
  if (args.projectId) {
    const { projectChatRoutes } = await import('../routes/project-chat')
    return projectChatRoutes({ runtimeManager: config.runtimeManager, suppressCompletionPush: true }).fetch(
      new Request(`http://internal/projects/${encodeURIComponent(args.projectId)}/chat`, {
        method: 'POST', headers, body, signal: args.signal,
      }),
    )
  }
  const { workspaceChatRoutes } = await import('../routes/workspace-chat')
  return workspaceChatRoutes({
    runtimeManager: config.runtimeManager,
    alwaysEnabled: true,
    resolveUserId: async (c: any) => c.req.header('X-Channel-User-Id') || null,
  }).fetch(
    new Request(`http://internal/workspaces/${encodeURIComponent(args.workspaceId)}/chat`, {
      method: 'POST', headers, body, signal: args.signal,
    }),
  )
}

export interface StreamSummary {
  text: string
  failed: boolean
  error?: string
}

/** Read an AI SDK UI-message SSE stream, reporting text and tool progress. */
export async function readAgentStream(
  response: Response,
  onProgress: (state: { text: string; tool: string | null }) => void,
): Promise<StreamSummary> {
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let message = raw || `Agent request failed with HTTP ${response.status}`
    try {
      const payload = JSON.parse(raw)
      message = payload?.error?.message || payload?.message || message
    } catch {}
    return { text: '', failed: true, error: message }
  }
  if (!response.body) return { text: '', failed: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let segments = 0
  let tool: string | null = null
  let failed = false
  let error: string | undefined

  const handle = (raw: string) => {
    if (!raw || raw === '[DONE]') return
    let chunk: any
    try { chunk = JSON.parse(raw) } catch { return }
    const type = chunk?.type
    if (type === 'text-start') {
      segments++
      if (segments > 1 && text) text += '\n\n'
      tool = null
    } else if (type === 'text-delta' && typeof chunk.delta === 'string') {
      text += chunk.delta
    } else if (type === 'tool-input-start' || type === 'tool-call-start') {
      tool = String(chunk.toolName || chunk.name || 'a tool')
    } else if (type === 'tool-output-available' || type === 'tool-output-error') {
      tool = null
    } else if (type === 'error') {
      failed = true
      error = String(chunk.errorText || chunk.error || 'The agent hit an error')
    } else if ((type === 'data-turn-complete' || type === 'finish') && (chunk.status || chunk.data?.status) === 'failed') {
      failed = true
    } else {
      return
    }
    onProgress({ text, tool })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data:')) handle(line.slice(line.startsWith('data: ') ? 6 : 5).trim())
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) handle(buffer.slice(buffer.startsWith('data: ') ? 6 : 5).trim())
  } finally {
    reader.releaseLock()
  }
  return { text, failed, error }
}

async function latestAssistantText(sessionId: string, after: Date): Promise<string | null> {
  const message = await db.chatMessage.findFirst({
    where: { sessionId, role: 'assistant', createdAt: { gte: after } },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  })
  return message?.content?.trim() || null
}

/**
 * One-off workspace-agent turn in a fresh session (e.g. "catch me up").
 * Nothing is posted to a conversation; the caller decides what to do with
 * the text.
 */
export async function runWorkspaceAgentPrompt(args: {
  workspaceId: string
  userId: string
  prompt: string
  label: string
  timeoutMs?: number
}): Promise<{ text: string; failed: boolean; error?: string; sessionId: string }> {
  const sessionId = await createSession({ workspaceId: args.workspaceId }, { projectId: null }, args.label)
  await db.chatMessage.create({
    data: { sessionId, role: 'user', content: args.prompt, parts: JSON.stringify([{ type: 'text', text: args.prompt }]), agent: 'technical' },
  }).catch(() => {})
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timed out')), args.timeoutMs ?? 5 * 60_000)
  ;(timeout as any).unref?.()
  const startedAt = new Date()
  let release: (() => void) | null = null
  try {
    release = await acquireSlot(args.workspaceId, controller.signal)
    const response = await invokeChat({
      workspaceId: args.workspaceId,
      projectId: null,
      sessionId,
      userId: args.userId,
      prompt: args.prompt,
      signal: controller.signal,
    })
    const summary = await readAgentStream(response, () => {})
    const text = summary.text.trim() || (await latestAssistantText(sessionId, startedAt)) || ''
    return { text, failed: summary.failed && !text, error: summary.error, sessionId }
  } catch (err: any) {
    return { text: '', failed: true, error: err?.message ?? 'The agent run failed', sessionId }
  } finally {
    clearTimeout(timeout)
    release?.()
  }
}

export interface RunAgentReplyArgs {
  conversation: any
  trigger: any
  target: AgentTarget
  userId: string
  /** Chain state for this reply; a fresh human-started chain when omitted. */
  chain?: AgentChain
}

export async function runAgentReply(args: RunAgentReplyArgs): Promise<string | null> {
  const { conversation, trigger, target, userId } = args
  if (!(await inWorkspace(conversation.workspaceId, [target])).length) return null
  const threadRootId = replyThreadRoot(conversation, trigger)
  const chain = args.chain ?? nextChain(humanChain(trigger, userId, await rootChain(trigger.threadRootId)), target, 0)
  const name = await agentName(conversation.workspaceId, target)
  const workspace = await db.workspace.findUnique({ where: { id: conversation.workspaceId }, select: { name: true } })

  const reused = await existingSession(conversation, threadRootId, target)
  const label = conversation.name ? `#${conversation.name}: ${trigger.text}` : `Chat: ${trigger.text}`
  const sessionId = reused ?? await createSession(conversation, target, renderMentionsAsText(label))

  const reply = await startAgentReply({
    conversation,
    agent: { projectId: target.projectId, name },
    threadRootId,
    agentSessionId: sessionId,
    agentChain: chain,
  })
  const messageId = reply.messageId
  const settle = (text: string, agentStatus: string) => finishAgentReply(reply, { text, agentStatus })

  const controller = new AbortController()
  running.set(messageId, controller)
  const timeout = setTimeout(() => controller.abort(new Error('timed out')), AGENT_REPLY_TIMEOUT_MS)
  ;(timeout as any).unref?.()

  let lastPublish = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  let latest = { text: '', tool: null as string | null }
  const flush = () => {
    pending = null
    lastPublish = Date.now()
    void streamAgentReply(reply, latest)
  }

  const startedAt = new Date()
  let release: (() => void) | null = null
  try {
    release = await acquireSlot(conversation.workspaceId, controller.signal)
    const prompt = await buildPrompt({
      conversation, trigger, threadRootId, reusedSession: !!reused, name, workspaceName: workspace?.name ?? 'workspace', chain,
    })
    await db.chatMessage.create({
      data: { sessionId, role: 'user', content: prompt, parts: JSON.stringify([{ type: 'text', text: prompt }]), agent: 'technical' },
    }).catch(() => {})
    const response = await invokeChat({
      workspaceId: conversation.workspaceId,
      projectId: target.projectId,
      sessionId,
      userId,
      prompt,
      signal: controller.signal,
    })
    const summary = await readAgentStream(response, (state) => {
      latest = state
      if (pending) return
      const wait = Math.max(0, DELTA_THROTTLE_MS - (Date.now() - lastPublish))
      pending = setTimeout(flush, wait)
    })
    if (pending) {
      clearTimeout(pending)
      pending = null
    }
    const finalText = summary.text.trim() || (await latestAssistantText(sessionId, startedAt)) || ''
    if (controller.signal.aborted) {
      await settle(finalText || '_Stopped._', 'stopped')
    } else if (summary.failed && !finalText) {
      await settle(`I couldn't finish that: ${summary.error ?? 'the agent run failed'}`, 'error')
    } else if (summary.failed || !finalText) {
      await settle(finalText || '_No response._', summary.failed ? 'error' : 'done')
    } else {
      const text = await resolveFriendlyMentions(conversation.workspaceId, finalText)
      const mentions = /<[@!]/.test(text) ? await replaceMentions(messageId, conversation.workspaceId, text) : []
      await settle(text, 'done')
      if (mentions.length) await afterReplySettled(reply.conversation, messageId, mentions)
    }
    return messageId
  } catch (err: any) {
    const stopped = controller.signal.aborted
    const partial = latest.text.trim()
    await settle(
      stopped ? partial || '_Stopped._' : `I couldn't finish that: ${err?.message ?? 'unknown error'}`,
      stopped ? 'stopped' : 'error',
    ).catch(() => {})
    return messageId
  } finally {
    if (pending) clearTimeout(pending)
    clearTimeout(timeout)
    running.delete(messageId)
    release?.()
  }
}

/** A finished reply's mentions notify people and wake the agents it tags. */
async function afterReplySettled(conversation: any, messageId: string, mentions: ParsedMention[]): Promise<void> {
  try {
    const row = await db.conversationMessage.findUnique({ where: { id: messageId }, include: MESSAGE_INCLUDE })
    if (!row) return
    const { afterMessagePosted } = await import('./conversation-pipeline')
    await afterMessagePosted(
      { message: serializeMessage(row), row, conversation, mentions, duplicate: false },
      { actorUserId: null, origin: 'agent', settled: true },
    )
  } catch (err) {
    console.error('[ChannelAgent] post-reply hooks failed:', err)
  }
}

/**
 * Stop an in-flight agent reply. Aborts locally when this pod owns the run;
 * otherwise asks the chat route to stop the backing session, which ends the
 * stream on whichever pod is reading it.
 */
export async function stopAgentReply(message: {
  id: string
  workspaceId: string
  agentSessionId: string | null
  authorAgentRef: { projectId?: string | null } | null
}, userId: string): Promise<void> {
  const controller = running.get(message.id)
  if (controller) {
    controller.abort(new Error('stopped'))
    return
  }
  if (!message.agentSessionId) return
  const projectId = message.authorAgentRef?.projectId ?? null
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': message.agentSessionId,
    'X-Channel-User-Id': userId,
  }
  const body = JSON.stringify({ chatSessionId: message.agentSessionId })
  if (projectId) {
    const { projectChatRoutes } = await import('../routes/project-chat')
    await projectChatRoutes({ runtimeManager: config.runtimeManager }).fetch(
      new Request(`http://internal/projects/${encodeURIComponent(projectId)}/chat/stop`, { method: 'POST', headers, body }),
    )
    return
  }
  const { workspaceChatRoutes } = await import('../routes/workspace-chat')
  await workspaceChatRoutes({
    runtimeManager: config.runtimeManager,
    alwaysEnabled: true,
    resolveUserId: async (c: any) => c.req.header('X-Channel-User-Id') || null,
  }).fetch(
    new Request(`http://internal/workspaces/${encodeURIComponent(message.workspaceId)}/chat/stop`, { method: 'POST', headers, body }),
  )
}

export function _resetDispatcherForTests(): void {
  running.clear()
  activeByWorkspace.clear()
  waiters.clear()
  config = {}
}
