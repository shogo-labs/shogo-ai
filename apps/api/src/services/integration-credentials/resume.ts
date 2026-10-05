// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Picking a conversation back up after someone connects an account.
 *
 * When an agent hands out a connect link, the link carries a signed resume
 * token naming the person and the chat session the turn ran in. Once they
 * have connected and allowed the agent, we find the team-chat thread behind
 * that session and post a short note there as them, which wakes the agent
 * like any other reply. App chat sessions (no thread behind them) resume
 * from the in-app connect card instead.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../lib/prisma'

const KIND = 'integration-resume'
const RESUME_TTL_MS = 6 * 60 * 60 * 1000

const db = prisma as any

export interface ResumeToken {
  userId: string
  chatSessionId: string
  exp: number
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET || ''
  if (!value) throw new Error('BETTER_AUTH_SECRET is required to sign resume tokens')
  return value
}

function mac(encoded: string): string {
  return createHmac('sha256', secret()).update(`${KIND}.${encoded}`).digest('base64url')
}

export function signResumeToken(value: { userId: string; chatSessionId: string }, nowMs = Date.now()): string {
  const encoded = Buffer.from(JSON.stringify({ ...value, exp: nowMs + RESUME_TTL_MS })).toString('base64url')
  return `${encoded}.${mac(encoded)}`
}

export function verifyResumeToken(token: string | null | undefined, nowMs = Date.now()): ResumeToken | null {
  const [encoded, given] = (token ?? '').trim().split('.')
  if (!encoded || !given) return null
  let expected: Buffer
  try {
    expected = Buffer.from(mac(encoded))
  } catch {
    return null
  }
  const actual = Buffer.from(given)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ResumeToken>
    if (typeof payload.userId !== 'string' || !payload.userId) return null
    if (typeof payload.chatSessionId !== 'string' || !payload.chatSessionId) return null
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null
    return payload as ResumeToken
  } catch {
    return null
  }
}

function parseAgentRef(value: unknown): { projectId?: string | null } | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? (value as { projectId?: string | null }) : null
}

export type ResumeOutcome =
  | { resumed: true; conversationId: string; conversationName: string | null }
  | { resumed: false }

/**
 * Post "I connected <label>" as `userId` into the thread behind the token's
 * chat session, which wakes the agent there. Only for the person the link
 * was made for; anything else (an app chat session, an expired or foreign
 * token) resumes nothing.
 */
export async function resumeAfterConnect(args: {
  userId: string
  resume: string | null | undefined
  label: string
  login?: string | null
}): Promise<ResumeOutcome> {
  const token = verifyResumeToken(args.resume)
  if (!token || token.userId !== args.userId) return { resumed: false }
  const reply = await db.conversationMessage.findFirst({
    where: { agentSessionId: token.chatSessionId, authorType: 'agent', deletedAt: null },
    orderBy: { seq: 'desc' },
    select: { id: true, conversationId: true, threadRootId: true, authorAgentRef: true },
  })
  if (!reply) return { resumed: false }
  const conversation = await db.conversation.findUnique({
    where: { id: reply.conversationId },
    select: { id: true, name: true, workspaceId: true, kind: true },
  })
  if (!conversation) return { resumed: false }
  const member = await db.member.findFirst({ where: { userId: args.userId, workspaceId: conversation.workspaceId }, select: { id: true } })
  if (!member) return { resumed: false }

  const { postMessage } = await import('../conversation.service')
  const { afterMessagePosted } = await import('../conversation-pipeline')
  const as = args.login ? ` as @${args.login}` : ''
  // Outside a DM with the agent, it only answers when mentioned.
  const agentProjectId = parseAgentRef(reply.authorAgentRef)?.projectId
  const mention = conversation.kind !== 'dm' && agentProjectId ? `<@a:p:${agentProjectId}> ` : ''
  const result = await postMessage({
    conversationId: conversation.id,
    text: `${mention}I connected ${args.label}${as}. Please go ahead.`,
    authorType: 'user',
    authorUserId: args.userId,
    threadRootId: reply.threadRootId ?? null,
    clientMsgId: `integration-connected:${token.chatSessionId}:${token.exp}`,
  })
  if (!result.duplicate) await afterMessagePosted(result, { actorUserId: args.userId, origin: 'app' })
  return { resumed: true, conversationId: conversation.id, conversationName: conversation.name ?? null }
}
