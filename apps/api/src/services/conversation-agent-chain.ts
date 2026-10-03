// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent @mention chains: when an agent's message tags another agent, that
 * agent runs too. Every agent-authored message stores the chain it belongs to
 * (`ConversationMessage.agentChain`) so the next hop can be billed to the
 * person who started it and stopped before it loops or runs away.
 *
 * A person's message starts a fresh chain at depth 0. Each agent reply is one
 * hop deeper. Tool posts (`team_chat_post`) carry the chain of the reply the
 * agent is running in; heartbeat and webhook turns start a new one.
 */

import { prisma } from '../lib/prisma'
import { getProjectUser } from '../lib/project-user-context'
import { agentKey, type AgentTarget } from './conversation-mentions'

const db = prisma as any

export function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export const MAX_AGENT_CHAIN_DEPTH = envInt('SHOGO_AGENT_CHAIN_MAX_DEPTH', 12)
export const MAX_AGENT_TURNS_PER_THREAD = envInt('SHOGO_AGENT_CHAIN_MAX_THREAD_TURNS', 40)
/** Consecutive turns allowed between the same two agents (A→B→A→B). */
export const MAX_AGENT_PING_PONG_TURNS = envInt('SHOGO_AGENT_CHAIN_MAX_PING_PONG', 4)
const MAX_HOPS_KEPT = 32

export interface AgentChain {
  rootMessageId: string
  originUserId: string
  depth: number
  /** Agent keys (`agentKey`) in the order they ran, most recent last. */
  hops: string[]
  /** Agent turns in this thread since the last human message, including this one. */
  turns: number
  runId?: string
  owner?: AgentTarget
}

export type ChainLimit = 'depth' | 'thread_turns' | 'ping_pong'

export function readChain(value: unknown): AgentChain | null {
  let raw = value
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, any>
  if (typeof c.rootMessageId !== 'string' || typeof c.originUserId !== 'string') return null
  return {
    rootMessageId: c.rootMessageId,
    originUserId: c.originUserId,
    depth: Number(c.depth) || 0,
    hops: Array.isArray(c.hops) ? c.hops.filter((h: unknown): h is string => typeof h === 'string') : [],
    turns: Number(c.turns) || 0,
    ...(typeof c.runId === 'string' && c.runId ? { runId: c.runId } : {}),
    ...(c.owner && typeof c.owner === 'object' ? { owner: { projectId: c.owner.projectId ?? null } } : {}),
  }
}

/** Chain state at a person's message: nobody has run yet. */
export function humanChain(row: { id: string; threadRootId?: string | null }, originUserId: string, root?: AgentChain | null): AgentChain {
  return {
    rootMessageId: row.threadRootId ?? row.id,
    originUserId,
    depth: 0,
    hops: [],
    turns: 0,
    ...(root?.runId ? { runId: root.runId } : {}),
  }
}

/** Chain state after `target` takes the next turn. */
export function nextChain(chain: AgentChain, target: AgentTarget, threadTurns: number): AgentChain {
  const { owner: _owner, ...rest } = chain
  return {
    ...rest,
    depth: chain.depth + 1,
    hops: [...chain.hops, agentKey(target)].slice(-MAX_HOPS_KEPT),
    turns: threadTurns + 1,
  }
}

/** Length of the alternating two-agent run at the end of `hops`. */
export function pingPongRun(hops: string[]): number {
  const n = hops.length
  if (n < 2 || hops[n - 1] === hops[n - 2]) return Math.min(n, 1)
  const a = hops[n - 1]
  const b = hops[n - 2]
  let run = 2
  for (let i = n - 3; i >= 0; i--) {
    if (hops[i] !== ((n - 1 - i) % 2 === 0 ? a : b)) break
    run++
  }
  return run
}

/** Which limit, if any, the proposed next turn trips. */
export function chainLimitHit(next: AgentChain): ChainLimit | null {
  if (next.depth > MAX_AGENT_CHAIN_DEPTH) return 'depth'
  if (next.turns > MAX_AGENT_TURNS_PER_THREAD) return 'thread_turns'
  if (pingPongRun(next.hops) > MAX_AGENT_PING_PONG_TURNS) return 'ping_pong'
  return null
}

/**
 * Agent turns in a thread (or an agent DM's top level) since the last message
 * from a person. A person replying resets the count.
 */
export async function agentTurnsSinceHuman(conversationId: string, threadRootId: string | null): Promise<number> {
  const scope = threadRootId
    ? { conversationId, OR: [{ id: threadRootId }, { threadRootId }] }
    : { conversationId, threadRootId: null }
  const lastHuman = await db.conversationMessage.findFirst({
    where: { ...scope, authorType: 'user', deletedAt: null },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  return db.conversationMessage.count({
    where: { ...scope, authorType: 'agent', ...(lastHuman ? { seq: { gt: lastHuman.seq } } : {}) },
  })
}

/** Chain stored on a thread's root message (owner, run id), if any. */
export async function rootChain(rootMessageId: string | null | undefined): Promise<AgentChain | null> {
  if (!rootMessageId) return null
  const root = await db.conversationMessage.findUnique({ where: { id: rootMessageId }, select: { agentChain: true } })
  return readChain(root?.agentChain)
}

/** Thread owner: the agent that answers unaddressed human replies in the thread. */
export async function threadOwner(rootMessageId: string | null | undefined): Promise<AgentTarget | null> {
  return (await rootChain(rootMessageId))?.owner ?? null
}

/** Mark `owner` as the agent that owns a thread (stored on the root's chain). */
export async function setThreadOwner(rootMessageId: string, owner: AgentTarget, runId?: string | null): Promise<void> {
  const root = await db.conversationMessage.findUnique({
    where: { id: rootMessageId },
    select: { agentChain: true, authorUserId: true, workspaceId: true },
  })
  if (!root) return
  const chain = readChain(root.agentChain) ?? {
    rootMessageId,
    originUserId: root.authorUserId ?? (await fallbackBillingUser(root.workspaceId, owner.projectId)) ?? '',
    depth: 0,
    hops: [],
    turns: 0,
  }
  const next: AgentChain = { ...chain, owner: { projectId: owner.projectId ?? null }, ...(runId ? { runId } : {}) }
  await db.conversationMessage.update({ where: { id: rootMessageId }, data: { agentChain: next } })
}

/** Who pays for a chain no person started (heartbeats, webhooks): the project's last user, else the workspace owner. */
export async function fallbackBillingUser(workspaceId: string, projectId: string | null): Promise<string | null> {
  const recent = projectId ? getProjectUser(projectId) : undefined
  if (recent) return recent
  const owner = await db.member.findFirst({
    where: { workspaceId, role: 'owner' },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  })
  return owner?.userId ?? null
}

/**
 * Chain for a tool post (`team_chat_post` / `team_chat_dm`) from `agent`. When
 * the runtime is serving a channel reply, the post joins that reply's chain;
 * otherwise it starts a new one billed to the fallback user.
 */
export async function chainForAgentPost(args: {
  workspaceId: string
  agent: AgentTarget
  sessionId?: string | null
  runId?: string | null
}): Promise<AgentChain | null> {
  const { workspaceId, agent, sessionId } = args
  const runId = args.runId?.trim() || undefined
  if (sessionId) {
    const replies = await db.conversationMessage.findMany({
      where: { workspaceId, agentSessionId: sessionId, authorType: 'agent' },
      orderBy: { seq: 'desc' },
      take: 10,
      select: { agentChain: true, authorAgentRef: true },
    }).catch(() => [])
    for (const reply of replies) {
      const chain = readChain(reply.agentChain)
      if (chain && agentKey({ projectId: reply.authorAgentRef?.projectId ?? null }) === agentKey(agent)) {
        return runId ? { ...chain, runId } : chain
      }
    }
  }
  const originUserId = await fallbackBillingUser(workspaceId, agent.projectId)
  if (!originUserId) return null
  return { rootMessageId: '', originUserId, depth: 1, hops: [agentKey(agent)], turns: 1, ...(runId ? { runId } : {}) }
}
