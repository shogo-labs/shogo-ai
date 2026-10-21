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
import { homeRegionWorkspaceWhere } from '../lib/region'
import { finishAgentReply, startAgentReply, streamAgentReply } from './chat-providers/outbound'
import {
  agentKey,
  loadNamesForTexts,
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
  setAgentMuted,
  serializeMessage,
  type PostMessageResult,
} from './conversation.service'
import type { IRuntimeManager } from '../lib/runtime'
import { tryAcquireSharedSlot } from '../lib/chat-limits'
import {
  agentTurnsSinceHuman,
  chainLimitHit,
  envInt,
  humanChain,
  MAX_AGENT_CHAIN_DEPTH,
  MAX_AGENT_PING_PONG_TURNS,
  MAX_AGENT_TURNS_PER_THREAD,
  nextChain,
  pingPongRun,
  readChain,
  rootChain,
  threadOwner,
  type AgentChain,
  type ChainLimit,
} from './conversation-agent-chain'
import { resolveFriendlyMentions } from './conversation-directory'
import { expirePendingApprovals, postApprovalCard, type ApprovalRequest } from './conversation-approvals'
import type { AgentWork, IntegrationConnectRequest, StatusCard } from './conversation-message-kind'
import { agentWorkOf } from './agent-work-log'
import { AGENT_REPLY_TIMEOUT_MS, emitTaskEvent, replyEvent, replyTargetRef, silenceSessionTasks } from './background-tasks.service'
import { docContextFor } from './conversation-doc.service'
import { parseMuteCommand, pickResponder, type RelevanceCandidate } from './conversation-agent-relevance'
import { publishReplyMedia } from './agent-reply-media'
import { resolveAgentRunModel } from './agent-run-model.service'
import {
  DEFAULT_STALE_AFTER_MS,
  markTurnEnded,
  markTurnStarted,
  startTurnHeartbeat,
} from './chat-turn-state.service'

const db = prisma as any

export const MAX_AGENTS_PER_MESSAGE = 3
export const MAX_CONCURRENT_AGENT_REPLIES_PER_WORKSPACE = envInt('SHOGO_CHANNEL_AGENT_CONCURRENCY', 6)
/** Backoff for a runtime that is still waking. The last delay repeats until the budget is spent. */
const DEFAULT_START_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000]
const DEFAULT_START_RETRY_BUDGET_MS = 3 * 60_000
/** Safety cap so a zero delay cannot spin for the whole budget. */
const MAX_START_RETRIES = 20
const CONTEXT_MESSAGES = 20
/** Each streamed-reply update is a database write plus a broadcast; once a second reads as live. */
const DELTA_THROTTLE_MS = 1_000
/** A workspace file read for a reply's media; a slow runtime must not hold the reply. */
const REPLY_MEDIA_FETCH_TIMEOUT_MS = 10_000
export { AGENT_REPLY_TIMEOUT_MS }
/**
 * A running turn streams a heartbeat every ~250ms, even while it waits on a
 * background task, so this long without a frame means the runtime is gone.
 */
export const AGENT_REPLY_IDLE_TIMEOUT_MS = envInt('SHOGO_CHANNEL_AGENT_IDLE_TIMEOUT_MS', 10 * 60_000)
const PROVIDER_SURFACE: Record<string, string> = { slack: 'Slack', teams: 'Microsoft Teams', google_chat: 'Google Chat' }

interface DispatcherConfig {
  runtimeManager?: IRuntimeManager
  /** Test seam: replaces the internal chat route call. */
  invoke?: (args: InvokeArgs) => Promise<Response>
  /** Test seam: replaces the permission-response call. */
  respondToPermission?: (input: { projectId: string; requestId: string; decision: 'allow_once' | 'deny' }) => Promise<boolean>
  /** Test seam: replaces the call that stops the runtime turn behind a reply. */
  stopRuntimeTurn?: (input: { workspaceId: string; projectId: string | null; sessionId: string; userId: string }) => Promise<void>
  /**
   * Test seam: replaces the read of a workspace file when a reply embeds one.
   * The default fetches it from the runtime that answered the turn.
   */
  fetchWorkspaceFile?: (input: { workspaceId: string; projectId: string | null; path: string }) => Promise<Response | null>
  /**
   * Waits between retries of a retryable 503, in milliseconds. The last entry
   * is reused. Defaults to 2s, 4s, 8s, then 15s.
   */
  retryDelaysMs?: number[]
  /** Total scheduled wait before a retryable 503 is final. Defaults to 3 minutes. */
  retryBudgetMs?: number
  /** Test seam: replaces `AGENT_REPLY_TIMEOUT_MS`. */
  replyTimeoutMs?: number
  /** Test seam: replaces `AGENT_REPLY_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number
}

let config: DispatcherConfig = {}

export function configureConversationAgentDispatcher(next: DispatcherConfig): void {
  config = { ...config, ...next }
}

/**
 * An agent reply is "running" only while a live turn is behind it. After a
 * restart or a crash the placeholder would show "Thinking…" forever, so settle
 * any that no live turn is writing — the turn heartbeat (`chat-turn-state`)
 * decides, so a peer pod's live run is left alone whatever the row's age.
 *
 * `minAgeMs` is a floor for a caller that knows a peer may not have marked its
 * turn yet; the bot's heartbeat, not the age, is what proves a run is dead.
 */
export async function settleOrphanedAgentReplies(minAgeMs = 0): Promise<number> {
  const cutoff = new Date(Date.now() - minAgeMs)
  // Only settle replies in workspaces homed here: a peer region's running
  // replies live in that region's memory, not ours.
  const home = homeRegionWorkspaceWhere()
  const stale = await db.conversationMessage.findMany({
    where: {
      authorType: 'agent',
      agentStatus: 'running',
      createdAt: { lt: cutoff },
      deletedAt: null,
      ...(home ? { conversation: { workspace: home } } : {}),
    },
    select: { id: true, threadRootId: true, authorAgentRef: true, agentSessionId: true, createdAt: true },
    take: 500,
  })
  const orphans = await withoutLiveTurn(stale)
  if (!orphans.length) return 0
  const { noteCardRunEnded } = await import('./work-boards.service')
  let settled = 0
  for (const m of orphans) {
    // Only the pod that flips the row may act on it: two pods booting at once
    // compute the same list, and each would otherwise re-hand the card again.
    const { count } = await db.conversationMessage.updateMany({
      where: { id: m.id, agentStatus: 'running' },
      data: { agentStatus: 'error', text: 'This reply was interrupted because the server restarted. Mention the agent again to retry.' },
    }).catch(() => ({ count: 0 }))
    if (count !== 1) continue
    settled++
    if (!m.threadRootId) continue
    const projectId = (m.authorAgentRef as { projectId?: string | null } | null)?.projectId ?? null
    await noteCardRunEnded({ threadRootId: m.threadRootId, projectId, messageId: m.id, agentStatus: 'error', startedAt: m.createdAt })
      .catch((err: Error) => console.error('[ChannelAgent] orphaned card run note failed:', err.message))
  }
  return settled
}

/** A reply this pod is not writing and whose turn has not heartbeated inside the window. */
async function withoutLiveTurn(
  rows: any[],
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): Promise<any[]> {
  const ours = rows.filter((r) => !running.has(r.id) && !liveReplyHere(r.id))
  const sessionIds = [...new Set(ours.map((r) => r.agentSessionId).filter((id): id is string => !!id))]
  if (!sessionIds.length) return ours
  const liveCutoff = new Date(Date.now() - staleAfterMs)
  const sessions = await db.chatSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, activeTurnId: true, activeTurnHeartbeatAt: true },
  })
  const alive = new Set(
    (sessions as any[])
      .filter((s) => s.activeTurnId && s.activeTurnHeartbeatAt && new Date(s.activeTurnHeartbeatAt) > liveCutoff)
      .map((s) => s.id),
  )
  // No session at all is not a live turn either: the run never got that far.
  return ours.filter((r) => !r.agentSessionId || !alive.has(r.agentSessionId))
}

/** Is this pod writing that reply? (Any live run here holds it.) */
function liveReplyHere(messageId: string): boolean {
  for (const live of liveRuns.values()) if (live.messageId === messageId) return true
  return false
}

/**
 * A run whose process died without a restart to notice it: its reply row still
 * says `running`, but no turn has heartbeated for it in `staleAfterMs` (or it
 * never had one) and this pod is not writing it. Settled once — the
 * compare-and-set below means two concurrent sweeps cannot both act — and then
 * the card goes through the same handler a normal run end does.
 *
 * Scoped to card threads: a chat reply has its own restart path, and this
 * sweep's job is the card nobody is moving.
 */
export async function sweepDeadAgentReplies(opts: { staleAfterMs?: number } = {}): Promise<number> {
  const home = homeRegionWorkspaceWhere()
  const rows = await db.conversationMessage.findMany({
    where: {
      authorType: 'agent',
      agentStatus: 'running',
      deletedAt: null,
      threadRootId: { not: null },
      ...(home ? { conversation: { workspace: home } } : {}),
    },
    select: { id: true, threadRootId: true, authorAgentRef: true, agentSessionId: true, createdAt: true },
    take: 200,
  })
  if (!rows.length) return 0
  const roots = [...new Set((rows as any[]).map((r) => r.threadRootId).filter((id): id is string => !!id))]
  const cards = await db.workItem.findMany({
    where: { threadRootMessageId: { in: roots } },
    select: { threadRootMessageId: true },
  })
  const cardRoots = new Set((cards as any[]).map((c) => c.threadRootMessageId))
  const inCards = (rows as any[]).filter((r) => cardRoots.has(r.threadRootId))
  const dead = await withoutLiveTurn(inCards, opts.staleAfterMs)
  if (!dead.length) return 0

  const { noteCardRunEnded } = await import('./work-boards.service')
  let settled = 0
  for (const m of dead) {
    // Only the sweep that flips the row 'running' may act on it.
    const { count } = await db.conversationMessage.updateMany({
      where: { id: m.id, agentStatus: 'running' },
      data: {
        agentStatus: 'error',
        text: `This run stopped sending heartbeats ${Math.round((opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) / 60_000)} minutes ago, so its process is gone. Mention the agent again to retry.`,
      },
    }).catch(() => ({ count: 0 }))
    if (count !== 1) continue
    settled++
    const projectId = (m.authorAgentRef as { projectId?: string | null } | null)?.projectId ?? null
    await noteCardRunEnded({ threadRootId: m.threadRootId, projectId, messageId: m.id, agentStatus: 'error', startedAt: m.createdAt })
      .catch((err: Error) => console.error('[ChannelAgent] dead card run note failed:', err.message))
  }
  return settled
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

async function relevanceCandidates(workspaceId: string, members: any[]): Promise<RelevanceCandidate[]> {
  const projectIds = members.map((m) => m.projectId).filter((id): id is string => !!id)
  const projects = projectIds.length
    ? await db.project.findMany({ where: { id: { in: projectIds }, workspaceId }, select: { id: true, name: true, description: true } })
    : []
  const byId = new Map<string, any>(projects.map((p: any) => [p.id, p]))
  const out: RelevanceCandidate[] = []
  for (const member of members) {
    const target = { projectId: member.projectId ?? null }
    if (target.projectId) {
      const project = byId.get(target.projectId)
      if (project) out.push({ target, name: project.name, about: project.description ?? null })
    } else {
      out.push({ target, name: await agentName(workspaceId, target), about: null })
    }
  }
  return out
}

/** The few messages before `row`, for the relevance check. */
async function recentTranscript(conversation: any, row: any): Promise<string> {
  const history = await db.conversationMessage.findMany({
    where: { conversationId: conversation.id, threadRootId: null, deletedAt: null, seq: { lt: row.seq } },
    orderBy: { seq: 'desc' },
    take: 5,
    include: { authorUser: { select: { name: true, email: true } } },
  })
  return renderTranscript(conversation.workspaceId, history.reverse().filter((m: any) => m.text?.trim()))
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
    const watching: any[] = []
    for (const member of members) {
      if (member.agentMuted) continue
      const target = { projectId: member.projectId ?? null }
      const topLevel = !row.threadRootId
      if (member.agentTrigger === 'all' && (topLevel || conversation.kind === 'dm')) {
        targets.set(agentKey(target), target)
      } else if (member.agentTrigger === 'keyword' && topLevel && keywordMatch(row.text, member.agentKeywords)) {
        targets.set(agentKey(target), target)
      } else if (member.agentTrigger === 'auto' && topLevel) {
        watching.push(member)
      }
    }
    // Only when nothing else claimed the message: one watching agent, if it is relevant.
    if (!targets.size && watching.length) {
      const target = await pickResponder(conversation.id, {
        text: row.text,
        recent: await recentTranscript(conversation, row),
        candidates: await relevanceCandidates(conversation.workspaceId, watching),
      })
      if (target) targets.set(agentKey(target), target)
    }
  }

  if (!targets.size && row.threadRootId) {
    const owner = await threadOwner(row.threadRootId)
    const target = (owner && (await inWorkspace(conversation.workspaceId, [owner]))[0]) || (await threadAgent(conversation.id, row.threadRootId))
    if (target) targets.set(agentKey(target), target)
  }

  return Array.from(targets.values()).slice(0, MAX_AGENTS_PER_MESSAGE)
}

/**
 * `@agent mute` / `@agent unmute` in a channel: flips the agents' mute flag and
 * confirms in the thread instead of running them. True when the message was one.
 */
async function applyMuteCommand(result: PostMessageResult, actorUserId: string): Promise<boolean> {
  const { row, conversation } = result
  if (conversation.kind === 'dm' && !isAgentDm(conversation)) return false
  const command = parseMuteCommand(row.text, await inWorkspace(conversation.workspaceId, mentionedAgents(row.text)))
  if (!command) return false
  const members = await listAgentMembers(conversation.id)
  const names: string[] = []
  for (const target of command.targets) {
    const member = members.find((m: any) => agentKey({ projectId: m.projectId ?? null }) === agentKey(target))
    if (!member) continue
    await setAgentMuted(conversation.id, actorUserId, target, command.muted)
    names.push(await agentName(conversation.workspaceId, target))
  }
  if (!names.length) return false
  const list = names.join(', ')
  const text = command.muted
    ? `${list} will stay quiet in this channel unless someone @mentions them. Reply with "@${names[0]} unmute" to let ${names.length > 1 ? 'them' : 'it'} speak up again.`
    : `${list} can speak up again when something is relevant.`
  const note = await postMessage({
    conversationId: conversation.id,
    authorType: 'system',
    threadRootId: row.threadRootId ?? row.id,
    text,
  })
  const { afterMessagePosted } = await import('./conversation-pipeline')
  await afterMessagePosted(note, { actorUserId: null, origin: 'system' })
  return true
}

/** Entry point after a human posts a message. Fire-and-forget per agent. */
export async function dispatchAgentsForMessage(result: PostMessageResult, actorUserId: string): Promise<AgentTarget[]> {
  if (result.duplicate || result.row.authorType !== 'user') return []
  if (await applyMuteCommand(result, actorUserId)) return []
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
/** Agents an agent's post hands work to: the ones `dispatchAgentsFromAgentMessage` would start. */
export async function agentPostTargets(result: Pick<PostMessageResult, 'row' | 'conversation' | 'duplicate'>): Promise<AgentTarget[]> {
  const { row } = result
  if (result.duplicate || row.authorType !== 'agent') return []
  const chain = readChain(row.agentChain)
  if (!chain?.originUserId || !mentionedAgents(row.text).length) return []
  return selectAgentTargets(result, { fromAgent: true })
}

export async function dispatchAgentsFromAgentMessage(result: Pick<PostMessageResult, 'row' | 'conversation' | 'duplicate'>): Promise<AgentTarget[]> {
  const { row, conversation } = result
  const { watchesThreadCard } = await import('./work-boards.service')
  const threadRootId = replyThreadRoot(conversation, row)
  const targets: AgentTarget[] = []
  for (const target of await agentPostTargets(result)) {
    if (!(await watchesThreadCard(threadRootId, target))) targets.push(target)
  }
  return startChained(conversation, row, targets)
}

/** A card-thread post's tag to the card's watcher, run once the run that wrote it ended without a card update to fold it into. */
export async function startDeferredReply(row: any, target: AgentTarget): Promise<AgentTarget[]> {
  const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
  if (!conversation || !readChain(row.agentChain)?.originUserId) return []
  return startChained(conversation, row, [target])
}

async function startChained(conversation: any, row: any, targets: AgentTarget[]): Promise<AgentTarget[]> {
  if (!targets.length) return []
  const chain = readChain(row.agentChain)!

  const turns = await agentTurnsSinceHuman(conversation.id, replyThreadRoot(conversation, row))
  const started: AgentTarget[] = []
  let tripped: ChainLimit | null = null
  for (const target of targets) {
    const next = nextChain(chain, target, turns + started.length)
    const limit = chainLimitHit(next)
    if (limit) {
      tripped ??= limit
      await emitTaskEvent('agent_reply', replyTargetRef(row.id, target.projectId), {
        status: 'failed',
        summary: `not started: paused ${pausedReason(limit)}`,
      })
      continue
    }
    started.push(target)
    void runAgentReply({ conversation, trigger: row, target, userId: chain.originUserId!, chain: next })
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

// ─── One live run per (agent, thread) ────────────────────────────────────────

/**
 * A reply this process is writing, per (agent, thread). A wake that arrives
 * while it is live queues behind it instead of starting a second run: the
 * runtime holds one turn per session, so the duplicate would sit `running`
 * behind the first with its own placeholder — and one Stop, which is
 * session-wide, would end both and leave the card with nobody on it.
 */
interface LiveAgentRun {
  messageId: string | null
  sessionId: string | null
}
const liveRuns = new Map<string, LiveAgentRun>()
/** Drains in flight, so the sweep and a settling run cannot both start one. */
const draining = new Set<string>()

/** `project:<id>` / `workspace`, the way boards and mentions name an agent. */
export function agentRefForTarget(target: AgentTarget): string {
  return target.projectId ? `project:${target.projectId}` : 'workspace'
}

export function targetForAgentRef(ref: string): AgentTarget {
  return { projectId: ref.startsWith('project:') ? ref.slice('project:'.length) : null }
}

/** A top-level channel message is its own thread; an agent DM has no root at all. */
function runKey(conversationId: string, threadRootId: string | null, target: AgentTarget): string {
  return `${conversationId}|${threadRootId ?? ''}|${agentRefForTarget(target)}`
}

interface QueuedWake {
  conversation: any
  trigger: any
  target: AgentTarget
  userId: string
  chain: AgentChain
  threadRootId: string | null
  runningMessageId: string | null
}

/** What the thread says when nothing more specific is going on. */
async function queuedNote(workspaceId: string, target: AgentTarget): Promise<string> {
  return `_Queued — ${await agentName(workspaceId, target)} is still working on the previous message here; this wake will run when that reply ends._`
}

export interface AgentWakeInput {
  conversationId: string
  threadRootId: string | null
  /** The message the run reads its instruction from. */
  triggerMessageId: string
  agentRef: string
  userId: string
  chain?: AgentChain | null
  /** `wake` (behind a live run), `move_nudge`, or `run_died_retry`. */
  reason?: string
  /** Earliest time the drain may start this row. */
  notBefore?: Date | null
  /** What the thread says about the wait; the caller's own line when it has one. */
  note?: { text: string; blocks?: Record<string, unknown> } | null
}

/**
 * The one place an `AgentWake` row is created. The row is the durable part: it
 * outlives this process, so a restart drains it instead of dropping the
 * request. Returns null when the same trigger already woke this agent (one wake
 * per trigger) — the caller's request is already queued.
 */
export async function enqueueAgentWake(input: AgentWakeInput): Promise<string | null> {
  const conversation = await db.conversation.findUnique({ where: { id: input.conversationId }, select: { id: true, workspaceId: true } })
  if (!conversation) return null
  let wakeId: string
  try {
    const wake = await db.agentWake.create({
      data: {
        workspaceId: conversation.workspaceId,
        conversationId: input.conversationId,
        threadRootId: input.threadRootId,
        triggerMessageId: input.triggerMessageId,
        agentRef: input.agentRef,
        userId: input.userId,
        // The object on Postgres, JSON text on SQLite (`create-prisma-client`
        // stringifies it there); `readChain` parses either shape.
        chain: input.chain ?? null,
        reason: input.reason ?? 'wake',
        notBefore: input.notBefore ?? null,
        status: 'pending',
      },
      select: { id: true },
    })
    wakeId = wake.id
  } catch (err: any) {
    // The same trigger waking this agent twice is one wake, already acknowledged.
    if (err?.code === 'P2002') return null
    throw err
  }
  if (!input.note) return wakeId
  const posted = await postMessage({
    conversationId: input.conversationId,
    authorType: 'system',
    threadRootId: input.threadRootId,
    systemMentions: true,
    text: input.note.text,
    blocks: input.note.blocks,
  })
  const { afterMessagePosted } = await import('./conversation-pipeline')
  void afterMessagePosted(posted, { actorUserId: null, origin: 'system' })
  return wakeId
}

/**
 * Park a wake behind the live run in this thread and say so in the thread.
 */
async function queueWake(args: QueuedWake): Promise<void> {
  const agentRef = agentRefForTarget(args.target)
  const note = {
    text: await queuedNote(args.conversation.workspaceId, args.target),
    blocks: { wakeQueued: { agentRef, triggerMessageId: args.trigger.id, runningMessageId: args.runningMessageId } },
  }
  const wakeId = await enqueueAgentWake({
    conversationId: args.conversation.id,
    threadRootId: args.threadRootId,
    triggerMessageId: args.trigger.id,
    agentRef,
    userId: args.userId,
    chain: args.chain,
    note,
  })
  if (!wakeId || !args.threadRootId) return
  const { noteAgentWakeQueued } = await import('./work-boards.service')
  await noteAgentWakeQueued({ threadRootId: args.threadRootId, agentRef, runningMessageId: args.runningMessageId })
    .catch((err: Error) => console.warn('[ChannelAgent] queued-wake note failed:', err.message))
}

/** A run ended: start the oldest wake waiting for this agent in this thread. */
async function drainWakes(conversationId: string, threadRootId: string | null, agentRef: string): Promise<number> {
  let ran = 0
  for (;;) {
    const next = await db.agentWake.findFirst({
      // A row inside its debounce window is not ready yet; anything else pending
      // goes now, so a waiting nudge cannot hold a real wake back.
      where: {
        conversationId,
        threadRootId,
        agentRef,
        status: 'pending',
        OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!next) return ran
    const claimed = await db.agentWake.updateMany({
      where: { id: next.id, status: 'pending' },
      data: { status: 'claimed', claimedAt: new Date(), attempts: { increment: 1 } },
    })
    // Another pod claimed it first.
    if (!claimed.count) continue
    const wake = await db.agentWake.findUnique({ where: { id: next.id } })
    if (!wake) return ran
    try {
      await runWake(wake)
      await db.agentWake.updateMany({ where: { id: wake.id, status: 'claimed' }, data: { status: 'done', lastError: null } })
    } catch (err: any) {
      const lastError = String(err?.message ?? err).slice(0, 1000)
      await db.agentWake.updateMany({ where: { id: wake.id, status: 'claimed' }, data: { status: 'failed', lastError } })
        .catch(() => {})
      console.warn(`[ChannelAgent] queued wake ${wake.id} failed:`, lastError)
    }
    ran++
  }
}

/** Post the wake's trigger again, now that nothing else is running in the thread. */
async function runWake(wake: any): Promise<void> {
  if (wake.reason === MOVE_NUDGE_REASON) {
    // A move nudge has no message of its own: the window passed with nothing to
    // supersede it, so the board posts the wake now and the agent runs on it.
    const { fireMoveNudge } = await import('./work-boards.service')
    await fireMoveNudge({
      threadRootId: wake.threadRootId,
      agentRef: wake.agentRef,
      userId: wake.userId,
      chain: readChain(wake.chain),
    })
    return
  }
  const [conversation, trigger] = await Promise.all([
    db.conversation.findUnique({ where: { id: wake.conversationId } }),
    db.conversationMessage.findUnique({ where: { id: wake.triggerMessageId } }),
  ])
  if (!conversation || !trigger) {
    throw new Error('the message or channel this wake was queued for is gone')
  }
  await runAgentReply(
    {
      conversation,
      trigger,
      target: targetForAgentRef(wake.agentRef),
      userId: wake.userId,
      chain: readChain(wake.chain) ?? undefined,
    },
    { drained: true },
  )
}

/** How long a queued wake waits for the run in front of it to end before the sweep steps in. */
const WAKE_SWEEP_MIN_AGE_MS = 60_000
const WAKE_MAX_ATTEMPTS = 3
/** A move's hint at the card's own agent; the row is debounced by `notBefore`. */
const MOVE_NUDGE_REASON = 'move_nudge'
/** A card's one re-hand after its run died; also a hint, so a real wake supersedes it. */
export const RUN_DIED_RETRY_REASON = 'run_died_retry'
const HINT_REASONS = [MOVE_NUDGE_REASON, RUN_DIED_RETRY_REASON]

/** Is a reply for this agent still running in that thread (any process, per the DB)? */
async function agentRunningInThread(conversationId: string, threadRootId: string | null, agentRef: string): Promise<boolean> {
  const rows = await db.conversationMessage.findMany({
    where: {
      conversationId,
      authorType: 'agent',
      agentStatus: 'running',
      deletedAt: null,
      ...(threadRootId ? { OR: [{ id: threadRootId }, { threadRootId }] } : { threadRootId: null }),
    },
    select: { authorAgentRef: true },
    take: 20,
  })
  const projectId = targetForAgentRef(agentRef).projectId
  return rows.some((r: any) => (r.authorAgentRef?.projectId ?? null) === projectId)
}

/**
 * A wake that arrives on its own — a person's tag, a chained tag, an assign, an
 * explicit column hand-off — carries the instruction, so a hint still waiting
 * out its window for this agent is redundant: mark it superseded rather than
 * waking the agent a second time for the same thing. Both hints count — a move
 * nudge and a re-hand after a run died. A row that is already claimed (its own
 * drain) is untouched.
 */
async function supersedePendingMoveNudges(threadRootId: string | null, agentRef: string): Promise<void> {
  if (!threadRootId) return
  await db.agentWake.updateMany({
    where: { threadRootId, agentRef, status: 'pending', reason: { in: HINT_REASONS } },
    data: { status: 'superseded' },
  }).catch((err: Error) => console.warn('[ChannelAgent] superseding a pending hint failed:', err.message))
}

/** Is every automatic agent start held in this workspace? */
function workspaceAgentsPaused(workspaceId: string): Promise<boolean> {
  return import('./workspace-pause.service').then((module) => module.isWorkspaceAgentsPaused(workspaceId))
}

/**
 * Start this (agent, thread)'s pending wakes if nothing is running. One entry
 * point for the settle drain, the post-enqueue timer and the 15s sweep, so two
 * of them can never start the same queue twice. The run itself is detached:
 * `true` means "a drain started", not "a turn finished".
 */
async function startDrainIfIdle(row: { conversationId: string; threadRootId: string | null; agentRef: string }): Promise<boolean> {
  const key = runKey(row.conversationId, row.threadRootId, targetForAgentRef(row.agentRef))
  if (liveRuns.has(key) || draining.has(key)) return false
  draining.add(key)
  let started = false
  try {
    // A paused workspace starts nothing; the rows stay pending for the resume.
    const conversation = await db.conversation.findUnique({
      where: { id: row.conversationId },
      select: { workspaceId: true },
    })
    if (conversation && (await workspaceAgentsPaused(conversation.workspaceId))) return false
    if (!(await agentRunningInThread(row.conversationId, row.threadRootId, row.agentRef))) {
      started = true
      void drainWakes(row.conversationId, row.threadRootId, row.agentRef)
        .catch((err: Error) => console.error('[ChannelAgent] draining queued wakes failed:', err.message))
        .finally(() => draining.delete(key))
    }
    return started
  } finally {
    if (!started) draining.delete(key)
  }
}

/**
 * A debounced row is not left to the 15s sweep: the board's timer fires just
 * after its window closes, so a bounce nobody tagged wakes its developer in
 * ~5s. The sweep stays the backstop for a process that restarted.
 */
export function scheduleAgentWakeDrain(
  row: { conversationId: string; threadRootId: string | null; agentRef: string },
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    void startDrainIfIdle(row).catch((err: Error) => console.error('[ChannelAgent] draining a deferred wake failed:', err.message))
  }, Math.max(0, delayMs))
  // Never hold the process open for a hint.
  timer.unref?.()
}

/**
 * Drain wakes nothing else will: a queue written by a pod that has since
 * restarted, or one whose run ended while its process was dying. Every 15s
 * tick of the chat-queue job calls this, so a queued wake is never stranded.
 * Returns how many it started; the runs themselves continue in the background
 * so one long reply cannot stall the rest of the tick.
 */
export async function sweepPendingAgentWakes(minAgeMs = WAKE_SWEEP_MIN_AGE_MS): Promise<number> {
  const now = new Date()
  const cutoff = new Date(Date.now() - minAgeMs)
  // A wake claimed by a run that died with its process is claimable again.
  await db.agentWake.updateMany({
    where: { status: 'claimed', claimedAt: { lt: new Date(Date.now() - (AGENT_REPLY_TIMEOUT_MS + 60_000)) } },
    data: { status: 'pending' },
  }).catch(() => {})
  // Finished rows are history, not state: keep a week of it.
  await db.agentWake.deleteMany({
    where: { status: { in: ['done', 'failed', 'superseded'] }, updatedAt: { lt: new Date(Date.now() - 7 * 24 * 3_600_000) } },
  }).catch(() => {})
  const rows = await db.agentWake.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
      attempts: { lt: WAKE_MAX_ATTEMPTS },
      // A debounced row still inside its window waits for its own timer.
      OR: [{ notBefore: null }, { notBefore: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { conversationId: true, threadRootId: true, agentRef: true },
  })
  let started = 0
  for (const row of rows) {
    if (await startDrainIfIdle(row)) started++
  }
  return started
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
  const [names, workspaceAgentName] = await Promise.all([
    loadNamesForTexts(db, workspaceId, texts),
    agentName(workspaceId, { projectId: null }),
  ])
  return { ...names, workspaceAgentName }
}

export async function renderTranscript(workspaceId: string, history: any[], markMessageId?: string): Promise<string> {
  const names = await loadMentionNames(workspaceId, history.map((m) => m.text))
  const author = (m: any) =>
    m.authorType === 'user' ? (m.authorUser?.name || m.authorUser?.email || m.blocks?.externalAuthor?.name || 'Someone')
      : m.authorType === 'agent' ? `${m.authorAgentRef?.name ?? 'Agent'} (agent)`
        : m.authorType === 'bot' ? 'Bot' : 'System'
  const files = (m: any) => {
    const list = (m.attachments ?? []).map((a: any) => `${a.name} (file id ${a.id})`)
    return list.length ? ` [attached: ${list.join(', ')}]` : ''
  }
  return history
    .map((m) => `${author(m)}${m.id === markMessageId ? ' [mentions you]' : ''}: ${renderMentionsAsText(m.text, names)}${files(m)}`)
    .join('\n')
}

/** The task card in this thread (latest one), which pins the acceptance criteria and links. */
async function threadStatusCard(conversationId: string, threadRootId: string | null): Promise<StatusCard | null> {
  if (!threadRootId) return null
  const rows = await db.conversationMessage.findMany({
    where: { conversationId, OR: [{ id: threadRootId }, { threadRootId }], deletedAt: null },
    orderBy: { seq: 'desc' },
    take: 50,
    select: { blocks: true },
  })
  for (const row of rows) {
    const card = row.blocks?.type === 'status_card' ? row.blocks.card : null
    if (card && typeof card.title === 'string') return card as StatusCard
  }
  return null
}

/** What the session view shows instead of the wrapper prompt. */
export interface ChannelDispatch {
  conversationId: string
  conversationName: string | null
  threadRootId: string | null
  agentName: string
  trigger: { authorName: string; text: string }
  handedOffBy?: string
  contextMode: string
}

async function messageAuthorName(message: any): Promise<string> {
  if (message.authorType === 'user') {
    const known = message.authorUser?.name || message.authorUser?.email || message.blocks?.externalAuthor?.name
    if (typeof known === 'string' && known.trim()) return known
    if (message.authorUserId) {
      const user = await db.user.findUnique({ where: { id: message.authorUserId }, select: { name: true, email: true } })
      if (user) return user.name || user.email
    }
    return 'Someone'
  }
  if (message.authorType === 'agent') return message.authorAgentRef?.name ?? 'Agent'
  if (message.authorType === 'bot') return 'Bot'
  return 'System'
}

/** The card the session shows for this run: who asked, where, and the message that woke the agent. */
async function channelDispatchFor(args: {
  conversation: any
  trigger: any
  threadRootId: string | null
  name: string
  contextMode: string
}): Promise<ChannelDispatch> {
  const { conversation, trigger, threadRootId, name, contextMode } = args
  const [authorName, names] = await Promise.all([
    messageAuthorName(trigger),
    loadMentionNames(conversation.workspaceId, [trigger.text ?? '']),
  ])
  const dispatch: ChannelDispatch = {
    conversationId: conversation.id,
    conversationName: typeof conversation.name === 'string' && conversation.name.trim() ? conversation.name : null,
    threadRootId,
    agentName: name,
    trigger: { authorName, text: renderMentionsAsText(trigger.text ?? '', names) },
    contextMode,
  }
  if (trigger.authorType === 'agent') dispatch.handedOffBy = trigger.authorAgentRef?.name ?? authorName
  return dispatch
}

/**
 * Prompt for an agent that reviews without the discussion: only the hand-off,
 * the task's acceptance criteria and its links. It forms its own view from the
 * work itself.
 */
async function buildIsolatedPrompt(args: {
  conversation: any
  trigger: any
  threadRootId: string | null
  name: string
  workspaceName: string
  chain: AgentChain
}): Promise<string> {
  const { conversation, trigger, threadRootId, name, workspaceName, chain } = args
  const [handoff, card] = await Promise.all([
    renderTranscript(conversation.workspaceId, [trigger], trigger.id),
    threadStatusCard(conversation.id, threadRootId),
  ])
  const where = `the #${conversation.name ?? 'channel'} channel`
  const surface = PROVIDER_SURFACE[conversation.provider] ?? 'Shogo'
  const lines = [
    `You are ${name}, an independent reviewer in ${where} of the "${workspaceName}" workspace's team chat in ${surface}.`,
    'You are deliberately given only the hand-off below, the acceptance criteria and the links. You have not seen the ' +
      'discussion that led here and must not go looking for it: do not read the channel or thread history. ' +
      'Judge the work against the criteria by inspecting it yourself (read the diff, run the checks).',
    ...chainContext(conversation, trigger, threadRootId, chain),
    '',
    'Hand-off:',
    handoff,
  ]
  if (card?.title) lines.push('', `Task: ${card.title}`)
  if (card?.criteria?.length) lines.push('', 'Acceptance criteria:', ...card.criteria.map((c) => `- ${c}`))
  else lines.push('', 'Acceptance criteria: none were recorded on the task card. Say so, and review for correctness and safety only.')
  if (card?.links?.length) lines.push('', 'Links:', ...card.links.map((l) => `- ${l.label}: ${l.url}`))
  lines.push(
    '',
    'Reply with a clear verdict: "pass" or "fail". For a fail, list each criterion that is not met and what to change.',
  )
  return lines.join('\n')
}

const TRANSCRIPT_INCLUDE = {
  authorUser: { select: { name: true, email: true } },
  attachments: { select: { id: true, name: true } },
}

async function buildPrompt(args: {
  conversation: any
  trigger: any
  threadRootId: string | null
  reusedSession: boolean
  name: string
  workspaceName: string
  chain: AgentChain
  contextMode?: string
}): Promise<string> {
  const { conversation, trigger, threadRootId, reusedSession, name, workspaceName, chain } = args
  if (args.contextMode === 'isolated') {
    return buildIsolatedPrompt({ conversation, trigger, threadRootId, name, workspaceName, chain })
  }
  let history: any[]
  if (threadRootId) {
    history = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id, OR: [{ id: threadRootId }, { threadRootId }], deletedAt: null },
      orderBy: { seq: 'desc' },
      take: CONTEXT_MESSAGES,
      include: TRANSCRIPT_INCLUDE,
    })
  } else {
    history = await db.conversationMessage.findMany({
      where: { conversationId: conversation.id, threadRootId: null, deletedAt: null, seq: { lte: trigger.seq } },
      orderBy: { seq: 'desc' },
      take: reusedSession ? 6 : CONTEXT_MESSAGES,
      include: TRANSCRIPT_INCLUDE,
    })
  }
  history = history.reverse().filter((m) =>
    (m.text?.trim() || m.attachments?.length) && !(m.authorType === 'agent' && m.agentStatus === 'running'))

  if (reusedSession) {
    const lastAgentIdx = history.map((m) => m.authorType).lastIndexOf('agent')
    const triggerIdx = history.findIndex((m) => m.id === trigger.id)
    // Normally the wake is the newest thing here, so drop what the session already
    // has. A wake queued behind a live reply can predate it (a settled reply moves
    // to the end of the thread), and then its own tail is what it needs to see —
    // never an empty prompt.
    if (lastAgentIdx >= 0 && triggerIdx >= 0) {
      history = triggerIdx > lastAgentIdx ? history.slice(lastAgentIdx + 1) : history.slice(triggerIdx)
    }
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
    ...(history.some((m) => m.attachments?.length)
      ? ['Files attached below can be read or searched with fetch_chat_files (pass the file id); download one only when you need the raw file.']
      : []),
    ...(await channelDocContext(conversation)),
    '',
    transcript,
  ]
  return lines.join('\n')
}

/** Characters of the channel doc included in an agent's prompt. */
const DOC_CONTEXT_CHARS = 8000

/** The channel doc as shared context: the channel's plans, decisions and checklists. */
async function channelDocContext(conversation: any): Promise<string[]> {
  if (conversation.kind !== 'public' && conversation.kind !== 'private') return []
  const doc = await docContextFor(conversation.id).catch(() => null)
  if (!doc) return []
  const truncated = doc.content.length > DOC_CONTEXT_CHARS
  const body = truncated ? `${doc.content.slice(0, DOC_CONTEXT_CHARS)}\n…(truncated; read the rest with team_chat_doc_read)` : doc.content
  return [
    '',
    `Channel doc${doc.title ? ` "${doc.title}"` : ''} (version ${doc.version}): the channel's shared document, kept by ` +
      'the people in the channel. Read it for context; do not edit it on your own initiative, and change it only when ' +
      'someone asks you to.',
    `${doc.budget.chars.toLocaleString('en-US')} / ${doc.budget.limit.toLocaleString('en-US')} characters (${doc.budget.pct}%, ` +
      `${doc.budget.level}). ` +
      (doc.budget.level === 'critical'
        ? 'It is nearly full: archive a finished section with mode "archive_section" before you add anything.'
        : doc.budget.level === 'warn'
          ? 'It is filling up: prefer editing an existing section over appending a new one.'
          : ''),
    '<channel_doc>',
    body,
    '</channel_doc>',
  ]
}

function chainContext(conversation: any, trigger: any, threadRootId: string | null, chain: AgentChain): string[] {
  const ids = [`channel id ${conversation.id}`]
  if (threadRootId) ids.push(`thread id ${threadRootId}`)
  if (chain.runId) ids.push(`run id ${chain.runId}`)
  const lines = [`Team chat context: ${ids.join(', ')}.`]
  if (trigger.authorType === 'agent') {
    const by = trigger.authorAgentRef?.name ?? 'Another agent'
    lines.push(
      `${by} (an agent) handed this to you. Your reply lands in this thread where everyone can read it, so do not tag ` +
        `${by} just to report back, thank it or say you are done; tag it only if it has a next step to take.`,
      'Agents tagging each other can loop. Act only if this message gives you work you have not done or information ' +
        'that changes it. If it only acknowledges, thanks, agrees, repeats what you already said or reports work that ' +
        'needs nothing from you, reply in one line and tag nobody: that ends the exchange.',
    )
    const rounds = pingPongRun(chain.hops)
    if (chain.turns > 1) {
      lines.push(
        `So far: ${chain.turns} agent replies in this thread since a person last wrote` +
          (rounds >= 3 ? `, the last ${rounds} alternating between you and ${by}` : '') + '. ' +
          'If the recent replies did not move the work forward (the same question, objection or fix again), do not ' +
          'hand it back again, even with clearer instructions: say where it is stuck and tag the person who asked ' +
          '(with @; a name without it notifies nobody) for a decision.',
      )
    }
  }
  lines.push(
    'Tagging an agent (e.g. @Planner) wakes it: it runs next in this thread. Tag an agent only to hand it a specific task ' +
      'it has to do now. Never tag agents to acknowledge, agree, thank, give an FYI or sign off; to refer to one, write its ' +
      'name without the @. Tag at most one agent per reply unless the work truly splits. ' +
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

/**
 * The model a channel run asks for. Auto routing suits a general assistant, but a project whose
 * agent was given a model on purpose (a team template pins one for its builder, say) keeps it.
 * The workspace agent uses the admin-set workspace default, while that model is still allowed.
 *
 * Delegates to `agent-run-model.service` so the profile card reports the same model this run uses.
 */
export async function agentModeFor(projectId: string | null, workspaceId?: string): Promise<string> {
  return resolveAgentRunModel(projectId, workspaceId)
}

async function invokeChat(args: InvokeArgs): Promise<Response> {
  if (config.invoke) return config.invoke(args)
  const body = JSON.stringify({
    messages: [{ role: 'user', parts: [{ type: 'text', text: args.prompt }] }],
    chatSessionId: args.sessionId,
    userId: args.userId,
    agentMode: await agentModeFor(args.projectId, args.workspaceId),
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

/** A 503 the chat route marked retryable: the runtime is waking, not broken. */
async function isRetryableUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 503) return false
  try {
    const payload = await response.clone().json()
    return payload?.error?.retryable === true
  } catch {
    return false
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The project chat route answers a cold or stale runtime with a retryable 503
 * and expects the caller to try again. A channel run has no person watching
 * the request, so retry here until the runtime answers or the budget is spent.
 * `spent` is the wait we have scheduled, not wall-clock time, so a slow invoke
 * cannot eat the budget before the next delay.
 */
async function invokeUntilReady(args: InvokeArgs, onRetry?: () => Promise<void> | void): Promise<Response> {
  const budget = config.retryBudgetMs ?? DEFAULT_START_RETRY_BUDGET_MS
  const delays = config.retryDelaysMs?.length ? config.retryDelaysMs : DEFAULT_START_RETRY_DELAYS_MS
  let spent = 0
  let last: Response | null = null
  for (let attempt = 0; attempt <= MAX_START_RETRIES; attempt++) {
    if (args.signal.aborted) throw abortError(args.signal)
    last = await invokeChat(args)
    if (!(await isRetryableUnavailable(last))) return last
    if (attempt === MAX_START_RETRIES) return last
    const delay = delays[Math.min(attempt, delays.length - 1)]!
    if (spent >= budget || spent + delay > budget) return last
    spent += delay
    await onRetry?.()
    await sleepAbortable(delay, args.signal)
  }
  return last!
}

export interface StreamProgress {
  /** The message being written now: text since the last tool call. */
  text: string
  tool: string | null
  tools: Array<{ name: string; done: boolean }>
}

export interface StreamSummary {
  /** Every text segment of the run, in order. */
  text: string
  /** What the agent said last, after its final tool call. Empty if the run ended on a tool. */
  finalText?: string
  toolCount?: number
  /** Accounts the run needed someone to connect, one per provider. */
  connect?: IntegrationConnectRequest[]
  failed: boolean
  error?: string
}

/**
 * Read an AI SDK UI-message SSE stream, reporting text and tool progress.
 * `onActivity` fires for every frame, including the runtime's turn heartbeat,
 * so a caller can tell a turn that is still alive from one that went silent.
 */
export async function readAgentStream(
  response: Response,
  onProgress: (state: StreamProgress) => void,
  onPermission?: (request: ApprovalRequest) => void,
  onActivity?: () => void,
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
  let current = ''
  let afterTool = false
  let segments = 0
  let tool: string | null = null
  const tools: Array<{ id: string; name: string; done: boolean }> = []
  const connect: IntegrationConnectRequest[] = []
  let failed = false
  let error: string | undefined

  const handle = (raw: string) => {
    if (!raw || raw === '[DONE]') return
    let chunk: any
    try { chunk = JSON.parse(raw) } catch { return }
    onActivity?.()
    const type = chunk?.type
    if (type === 'text-start') {
      segments++
      if (segments > 1 && text) text += '\n\n'
      // Text that follows a tool call starts a new message; text that follows text continues it.
      if (afterTool) { current = ''; afterTool = false } else if (current) current += '\n\n'
      tool = null
    } else if (type === 'text-delta' && typeof chunk.delta === 'string') {
      text += chunk.delta
      current += chunk.delta
    } else if (type === 'tool-input-start' || type === 'tool-call-start') {
      tool = String(chunk.toolName || chunk.name || 'a tool')
      afterTool = true
      const id = String(chunk.toolCallId || chunk.id || `${tools.length}`)
      if (!tools.some((t) => t.id === id)) tools.push({ id, name: tool, done: false })
    } else if (type === 'tool-output-available' || type === 'tool-output-error') {
      tool = null
      const done = tools.find((t) => t.id === String(chunk.toolCallId || chunk.id)) ?? tools.find((t) => !t.done)
      if (done) done.done = true
    } else if (type === 'data-permission-request') {
      // The agent is waiting on a person; ask in the thread. Not text, so no progress update.
      const request = chunk.data ?? chunk
      if (onPermission && typeof request?.id === 'string' && typeof request?.toolName === 'string') onPermission(request)
      return
    } else if (type === 'data-integration-auth-required') {
      const d = chunk.data ?? {}
      if (typeof d.provider !== 'string' || typeof d.connectUrl !== 'string') return
      const entry: IntegrationConnectRequest = { provider: d.provider, connectUrl: d.connectUrl, ...(typeof d.message === 'string' && d.message ? { message: d.message } : {}) }
      const i = connect.findIndex((c) => c.provider === d.provider)
      if (i >= 0) connect[i] = entry
      else connect.push(entry)
      return
    } else if (type === 'error') {
      failed = true
      error = String(chunk.errorText || chunk.error || 'The agent hit an error')
    } else if ((type === 'data-turn-complete' || type === 'finish') && (chunk.status || chunk.data?.status) === 'failed') {
      failed = true
    } else {
      return
    }
    onProgress({ text: afterTool ? '' : current, tool, tools: tools.map(({ name, done }) => ({ name, done })) })
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
  return {
    text,
    finalText: afterTool ? '' : current.trim(),
    toolCount: tools.length,
    ...(connect.length ? { connect } : {}),
    failed,
    error,
  }
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
    const response = await invokeUntilReady({
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

/**
 * Read a workspace file from the runtime that answered the turn: the replying
 * project's runtime, or the workspace runtime for the workspace agent. A slow
 * or missing runtime yields null, and the ref is left as the agent wrote it.
 */
async function workspaceFileFetcher(input: { workspaceId: string; projectId: string | null }): Promise<(path: string) => Promise<Response | null>> {
  const { workspaceDownloadPath } = await import('../lib/chat-attachments')
  const { fetchFromProjectRuntime, fetchFromWorkspaceRuntime } = await import('../lib/chat-runtime-fetch')
  const init: RequestInit = { method: 'GET', signal: AbortSignal.timeout(REPLY_MEDIA_FETCH_TIMEOUT_MS) }
  return async (path: string) => {
    try {
      return input.projectId
        ? await fetchFromProjectRuntime(input.projectId, workspaceDownloadPath(path), init)
        : await fetchFromWorkspaceRuntime(input.workspaceId, [], workspaceDownloadPath(path), init)
    } catch {
      return null
    }
  }
}

export async function runAgentReply(args: RunAgentReplyArgs, opts: { drained?: boolean } = {}): Promise<string | null> {
  const { conversation, trigger, target, userId } = args
  const threadRootId = replyThreadRoot(conversation, trigger)
  // Any wake that reaches this point carries its own instruction, so a move
  // hint still waiting out its window for this agent is now redundant.
  await supersedePendingMoveNudges(threadRootId, agentRefForTarget(target))
  // A workspace-wide pause stops automatic starts, not people: a person's own
  // tag still runs, and an automatic one (board hand-off, agent-to-agent tag,
  // chain continuation) is parked as a durable wake so it replays on resume.
  if (trigger.authorType !== 'user' && (await workspaceAgentsPaused(conversation.workspaceId))) {
    const held = await enqueueAgentWake({
      conversationId: conversation.id,
      threadRootId,
      triggerMessageId: trigger.id,
      agentRef: agentRefForTarget(target),
      userId,
      chain: args.chain ?? null,
      reason: 'paused',
    }).catch((err: Error) => {
      console.warn('[ChannelAgent] holding a wake for the workspace pause failed:', err.message)
      return null
    })
    console.log(`[ChannelAgent] workspace paused — held ${held ?? 'no'} wake for ${conversation.id}`)
    return null
  }
  const key = runKey(conversation.id, threadRootId, target)
  const holder = liveRuns.get(key)
  if (holder) {
    // One live run per (agent, thread): wait for it, in the thread, instead of
    // starting a second turn on the same session.
    try {
      const chain = args.chain ?? nextChain(humanChain(trigger, userId, await rootChain(trigger.threadRootId)), target, 0)
      await queueWake({ conversation, trigger, target, userId, chain, threadRootId, runningMessageId: holder.messageId })
    } catch (err: any) {
      console.error('[ChannelAgent] queueing the wake failed:', err?.message ?? err)
    }
    return null
  }
  const live: LiveAgentRun = { messageId: null, sessionId: null }
  const state = { lost: false }
  liveRuns.set(key, live)
  if (!opts.drained && trigger.authorType === 'user') {
    // A person's tag is a wake in its own right: the card records it like any
    // other, so the board's history answers "why did this agent run".
    void import('./work-boards.service')
      .then(({ noteThreadTagWake }) => noteThreadTagWake({ threadRootId, agentRef: agentRefForTarget(target), messageId: trigger.id }))
      .catch((err: Error) => console.warn('[ChannelAgent] thread-tag note failed:', err.message))
  }
  try {
    return await runReservedReply(args, threadRootId, live, state)
  } finally {
    liveRuns.delete(key)
    // A run that lost the cross-pod reservation leaves its wake to the sweep:
    // the pod holding the session drains it when its own run ends.
    if (!opts.drained && !state.lost) {
      await drainWakes(conversation.id, threadRootId, agentRefForTarget(target))
        .catch((err: Error) => console.error('[ChannelAgent] draining queued wakes failed:', err.message))
    }
  }
}

async function runReservedReply(
  args: RunAgentReplyArgs,
  threadRootId: string | null,
  live: LiveAgentRun,
  state: { lost: boolean },
): Promise<string | null> {
  const { conversation, trigger, target, userId } = args
  if (!(await inWorkspace(conversation.workspaceId, [target])).length) {
    await emitTaskEvent('agent_reply', replyTargetRef(trigger.id, target.projectId), { status: 'failed', summary: 'that agent is not in this workspace' })
    return null
  }
  const chain = args.chain ?? nextChain(humanChain(trigger, userId, await rootChain(trigger.threadRootId)), target, 0)
  const name = await agentName(conversation.workspaceId, target)
  const workspace = await db.workspace.findUnique({ where: { id: conversation.workspaceId }, select: { name: true } })

  const member = await db.conversationMember.findFirst({
    where: { conversationId: conversation.id, memberType: 'agent', projectId: target.projectId },
    select: { agentContextMode: true },
  })
  const contextMode: string = member?.agentContextMode ?? 'shared'
  // An isolated agent never resumes an earlier session, which would carry what it saw before.
  const reused = contextMode === 'isolated' ? null : await existingSession(conversation, threadRootId, target)
  const label = conversation.name ? `#${conversation.name}: ${trigger.text}` : `Chat: ${trigger.text}`
  const sessionId = reused ?? await createSession(conversation, target, renderMentionsAsText(label))

  // The run's liveness, written where another pod can see it: a reply whose
  // turn has not heartbeated inside `DEFAULT_STALE_AFTER_MS` was written by a
  // process that died. Set before the placeholder exists, so the reply is never
  // briefly running with no turn behind it.
  const turnId = await markTurnStarted(sessionId).catch((err: Error) => {
    console.warn('[ChannelAgent] marking the run turn failed:', err.message)
    return null
  })
  const stopHeartbeat = turnId ? startTurnHeartbeat(sessionId, turnId) : null
  const endTurn = async () => {
    stopHeartbeat?.()
    if (turnId) await markTurnEnded(sessionId, turnId).catch(() => {})
  }

  const reply = await startAgentReply({
    conversation,
    agent: { projectId: target.projectId, name },
    threadRootId,
    agentSessionId: sessionId,
    agentChain: chain,
  })
  const messageId = reply.messageId
  live.messageId = messageId
  live.sessionId = sessionId
  // Cross-pod guard for the same rule: the oldest running reply on this session
  // owns it. A wake that lost the in-process race on another pod queues behind
  // that placeholder instead of adding a rival one.
  const earlier = await db.conversationMessage.findFirst({
    where: {
      conversationId: conversation.id,
      authorType: 'agent',
      agentStatus: 'running',
      agentSessionId: sessionId,
      deletedAt: null,
      id: { not: messageId },
      seq: { lt: reply.row?.seq ?? 0 },
    },
    orderBy: { seq: 'asc' },
    select: { id: true },
  })
  if (earlier) {
    state.lost = true
    await db.conversationMessage.delete({ where: { id: messageId } }).catch(() => {})
    await endTurn()
    await queueWake({ conversation, trigger, target, userId, chain, threadRootId, runningMessageId: earlier.id })
    return null
  }
  let work: AgentWork | null = null
  let connect: IntegrationConnectRequest[] = []
  let endedAs: string | null = null
  const settle = async (text: string, agentStatus: string) => {
    endedAs = agentStatus
    // Media the agent embedded in its answer is published before the text lands,
    // so the thread shows the picture without the agent making a second call.
    let fetcher: ((path: string) => Promise<Response | null>) | null = null
    const media = await publishReplyMedia({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      messageId,
      agentRef: target.projectId ? `project:${target.projectId}` : 'workspace',
      text,
      fetchFile: async (path) => {
        fetcher ??= config.fetchWorkspaceFile
          ? (p) => config.fetchWorkspaceFile!({ workspaceId: conversation.workspaceId, projectId: target.projectId, path: p })
          : await workspaceFileFetcher({ workspaceId: conversation.workspaceId, projectId: target.projectId })
        return fetcher(path)
      },
    }).catch((err: Error) => {
      console.error('[ChannelAgent] reply media failed:', err.message)
      return { text, uploaded: 0, errors: [err.message] }
    })
    if (media.errors.length) console.warn(`[ChannelAgent] reply media left as written: ${media.errors.join('; ')}`)
    // External channels stay text-only: only the stored reply carries media URLs.
    await finishAgentReply(reply, { text: media.text, externalText: text, agentStatus, work, connect })
    await emitTaskEvent('agent_reply', replyTargetRef(trigger.id, target.projectId), replyEvent(agentStatus, media.text))
  }
  // After the reply's own tags are dispatched, so a card watcher knows whether the work was handed on.
  const noteRunEnded = async () => {
    if (!endedAs) return
    const { noteCardRunEnded } = await import('./work-boards.service')
    await noteCardRunEnded({ threadRootId, projectId: target.projectId, messageId, agentStatus: endedAs, startedAt })
      .catch((err: Error) => console.error('[ChannelAgent] card run-end note failed:', err.message))
  }

  const controller = new AbortController()
  running.set(messageId, controller)
  const capMs = config.replyTimeoutMs ?? AGENT_REPLY_TIMEOUT_MS
  const idleMs = config.idleTimeoutMs ?? AGENT_REPLY_IDLE_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(new ReplyTimeout('cap', capMs)), capMs)
  ;(timeout as any).unref?.()
  let idle: ReturnType<typeof setTimeout> | null = null
  const armIdle = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new ReplyTimeout('idle', idleMs)), idleMs)
    ;(idle as any).unref?.()
  }
  // A timed-out reply ends its runtime turn too, so the thread never says it ended while the agent keeps going.
  const settleAborted = async (partial: string) => {
    const reason = controller.signal.reason
    if (!(reason instanceof ReplyTimeout)) return settle(partial || (work ? '' : '_Stopped._'), 'stopped')
    await stopSession({ workspaceId: conversation.workspaceId, projectId: target.projectId, sessionId, userId })
    return settle([partial, `_${reason.describe()}_`].filter(Boolean).join('\n\n'), 'error')
  }

  let lastPublish = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  let latest: StreamProgress = { text: '', tool: null, tools: [] }
  const approvalCards: string[] = []
  const flush = () => {
    pending = null
    lastPublish = Date.now()
    void streamAgentReply(reply, latest)
  }

  const startedAt = new Date()
  let release: (() => void) | null = null
  try {
    // Saved before the slot, so opening the session while the runtime is busy
    // or still waking already shows what was asked.
    const prompt = await buildPrompt({
      conversation, trigger, threadRootId, reusedSession: !!reused, name, workspaceName: workspace?.name ?? 'workspace', chain, contextMode,
    })
    const dispatch = await channelDispatchFor({ conversation, trigger, threadRootId, name, contextMode })
    await db.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: prompt,
        parts: JSON.stringify([
          { type: 'text', text: prompt },
          { type: 'data-channel-dispatch', data: dispatch },
        ]),
        agent: 'technical',
      },
    }).catch(() => {})
    // The insert point for every wake path (tag, chained tag, card move,
    // deferred tag): a resumed session records that it was active, so the
    // heartbeat and the chat sidebar bucket follow the run that just started.
    const now = new Date()
    await db.chatSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: now, updatedAt: now },
    }).catch(() => {})
    release = await acquireSlot(conversation.workspaceId, controller.signal)
    const response = await invokeUntilReady({
      workspaceId: conversation.workspaceId,
      projectId: target.projectId,
      sessionId,
      userId,
      prompt,
      signal: controller.signal,
    }, async () => {
      await streamAgentReply(reply, { text: 'Starting up…', tool: null, tools: [] })
    })
    armIdle()
    const summary = await readAgentStream(response, (state) => {
      latest = state
      if (pending) return
      const wait = Math.max(0, DELTA_THROTTLE_MS - (Date.now() - lastPublish))
      pending = setTimeout(flush, wait)
    }, (request) => {
      // Only project agents have a runtime to answer; the workspace agent's approvals stay in its own session.
      if (!target.projectId) return
      void postApprovalCard({
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        threadRootId: reply.row?.threadRootId ?? threadRootId ?? null,
        agent: { projectId: target.projectId, name },
        sessionId,
        chain,
        request,
      })
        .then((cardId) => { if (cardId) approvalCards.push(cardId) })
        .catch((err) => console.error('[ChannelAgent] approval card failed:', err))
    }, armIdle)
    if (idle) clearTimeout(idle)
    if (pending) {
      clearTimeout(pending)
      pending = null
    }
    // Only the closing message is posted; the narration and tool calls stay in the session behind "Worked for X".
    const ranTools = (summary.toolCount ?? 0) > 0
    const finalText = ranTools
      ? summary.finalText?.trim() ?? ''
      : summary.text.trim() || (await latestAssistantText(sessionId, startedAt)) || ''
    work = await agentWorkOf(sessionId, startedAt, summary.toolCount ?? 0).catch(() => null)
    connect = summary.connect ?? []
    if (controller.signal.aborted) {
      await settleAborted(finalText || latest.text.trim())
    } else if (summary.failed && !finalText) {
      await settle(`I couldn't finish that: ${summary.error ?? 'the agent run failed'}`, 'error')
    } else if (summary.failed) {
      await settle(finalText, 'error')
    } else if (!finalText && !work && !connect.length) {
      await settle('_No response._', 'done')
    } else if (!finalText) {
      // The run ended on a tool call: nothing more to say than what it did.
      await settle('', 'done')
    } else {
      const text = (await resolveFriendlyMentions(conversation.workspaceId, finalText)).text
      const mentions = /<[@!]/.test(text) ? await replaceMentions(messageId, conversation.workspaceId, text) : []
      await settle(text, 'done')
      if (mentions.length) await afterReplySettled(reply.conversation, messageId, mentions)
    }
    return messageId
  } catch (err: any) {
    if (controller.signal.aborted) {
      work = await agentWorkOf(sessionId, startedAt, latest.tools.length).catch(() => null)
      await settleAborted(latest.text.trim()).catch(() => {})
    } else {
      await settle(`I couldn't finish that: ${err?.message ?? 'unknown error'}`, 'error').catch(() => {})
    }
    return messageId
  } finally {
    if (pending) clearTimeout(pending)
    if (idle) clearTimeout(idle)
    clearTimeout(timeout)
    running.delete(messageId)
    release?.()
    // Once the run ends nothing is waiting on an approval card any more.
    if (approvalCards.length) await expirePendingApprovals(approvalCards)
    await noteRunEnded()
    // Cleared last: the card's handling above runs while the turn is still
    // marked, so a sweep on another pod never sees this reply as an orphan.
    await endTurn()
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
 * Stop one agent reply. Aborting this pod's reader settles the reply, but the
 * chat route deliberately keeps the runtime turn alive when its reader goes
 * away, so the runtime is told to stop the session too — that ends the turn and
 * its subagents on whichever pod runs it.
 *
 * A runtime stop is session-wide, so it is only sent when nothing else is live
 * on that session: with another reply still working there it would end that one
 * as well, and its card would be left with nobody on it. Wakes queued behind
 * the stopped reply stay queued and drain as it settles.
 */
export async function stopAgentReply(message: {
  id: string
  workspaceId: string
  agentSessionId: string | null
  authorAgentRef: { projectId?: string | null } | null
}, userId: string): Promise<void> {
  running.get(message.id)?.abort(new Error('stopped'))
  const sessionId = message.agentSessionId
  if (!sessionId) return
  const siblings = await db.conversationMessage.count({
    where: {
      agentSessionId: sessionId,
      authorType: 'agent',
      agentStatus: 'running',
      deletedAt: null,
      id: { not: message.id },
    },
  }).catch(() => 0)
  if (siblings > 0) return
  await stopSession({ workspaceId: message.workspaceId, projectId: message.authorAgentRef?.projectId ?? null, sessionId, userId })
}

/** Why a reply's reader gave up on its own, as opposed to someone pressing Stop. */
class ReplyTimeout extends Error {
  constructor(readonly kind: 'idle' | 'cap', readonly afterMs: number) {
    super(kind === 'idle' ? 'idle timeout' : 'timed out')
  }

  describe(): string {
    const after = formatDuration(this.afterMs)
    return this.kind === 'idle'
      ? `The agent went quiet for ${after}, so I stopped waiting on it.`
      : `I stopped waiting after ${after} without the agent finishing.`
  }
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/** End the session's runtime turn, and keep anything it was watching from waking it again. */
async function stopSession(input: { workspaceId: string; projectId: string | null; sessionId: string; userId: string }): Promise<void> {
  await silenceSessionTasks(input.sessionId).catch((err: Error) => console.warn('[ChannelAgent] silencing stopped session failed:', err.message))
  try {
    await (config.stopRuntimeTurn ?? stopRuntimeTurn)(input)
  } catch (err) {
    console.warn(`[ChannelAgent] runtime stop for ${input.sessionId} failed:`, (err as Error).message)
  }
}

const RUNTIME_STOP_TIMEOUT_MS = 10_000

async function stopRuntimeTurn(input: { workspaceId: string; projectId: string | null; sessionId: string; userId: string }): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    'X-Chat-Session-Id': input.sessionId,
    'X-Channel-User-Id': input.userId,
  }
  const body = JSON.stringify({ chatSessionId: input.sessionId })
  const signal = AbortSignal.timeout(RUNTIME_STOP_TIMEOUT_MS)
  if (input.projectId) {
    const { projectChatRoutes } = await import('../routes/project-chat')
    await projectChatRoutes({ runtimeManager: config.runtimeManager }).fetch(
      new Request(`http://internal/projects/${encodeURIComponent(input.projectId)}/chat/stop`, { method: 'POST', headers, body, signal }),
    )
    return
  }
  const { workspaceChatRoutes } = await import('../routes/workspace-chat')
  await workspaceChatRoutes({
    runtimeManager: config.runtimeManager,
    alwaysEnabled: true,
    resolveUserId: async (c: any) => c.req.header('X-Channel-User-Id') || null,
  }).fetch(
    new Request(`http://internal/workspaces/${encodeURIComponent(input.workspaceId)}/chat/stop`, { method: 'POST', headers, body, signal }),
  )
}

/**
 * Deliver a person's answer to the runtime waiting on a permission request.
 * Same route the app and island use, so the first answer from any surface wins.
 */
export async function respondToPermission(input: { projectId: string; requestId: string; decision: 'allow_once' | 'deny' }): Promise<boolean> {
  if (config.respondToPermission) return config.respondToPermission(input)
  try {
    const { projectChatRoutes } = await import('../routes/project-chat')
    const response = await projectChatRoutes({ runtimeManager: config.runtimeManager }).fetch(
      new Request(`http://internal/projects/${encodeURIComponent(input.projectId)}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: input.requestId, decision: input.decision }),
      }),
    )
    return response.ok
  } catch (err) {
    console.warn('[ChannelAgent] permission response failed:', (err as Error).message)
    return false
  }
}

export function _resetDispatcherForTests(): void {
  running.clear()
  activeByWorkspace.clear()
  waiters.clear()
  liveRuns.clear()
  draining.clear()
  config = {}
}
