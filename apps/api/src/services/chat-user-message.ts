// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Write the person's message before the turn starts (SHO-274).
 *
 * The send path used to persist the user row from a *separate* client POST that
 * nothing awaited, so a process that died right after Send — or a client that
 * was closed while that POST was in flight — left the agent with a turn and the
 * transcript with no question in it. The chat POST carries the same message id
 * the client's bubble already has (`messageId`, from the AI SDK), so the route
 * can write the row itself and wait for the commit before it proxies.
 *
 * That also removes the guesswork on the client: the bubble's id *is* the row
 * id, so nothing has to match a just-sent row back to a bubble by its text.
 */
import { prisma } from '../lib/prisma'
import { bumpChatSessionActivity } from '../generated/chat-message.hooks'

interface UiPart {
  type?: string
  text?: string
  [key: string]: unknown
}

interface UiMessage {
  id?: string
  role?: string
  content?: unknown
  parts?: unknown
}

/** The text of a message, from its parts or a plain `content` string. */
function messageText(message: UiMessage): string {
  if (Array.isArray(message.parts)) {
    return (message.parts as UiPart[])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
  }
  return typeof message.content === 'string' ? message.content : ''
}

/** The message the turn is about: the one the client named, else the last user. */
function findUserMessage(body: Record<string, unknown>): UiMessage | null {
  const messages = Array.isArray(body.messages) ? (body.messages as UiMessage[]) : []
  const wanted = typeof body.messageId === 'string' ? body.messageId : null
  if (wanted) {
    const named = messages.find((message) => message?.id === wanted)
    if (named && named.role === 'user') return named
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
}

export interface PersistUserMessageResult {
  /** Row id written (or already present). Null when the body had no user message. */
  id: string | null
  /** True when this call created the row; false when it was already there. */
  created: boolean
}

/**
 * Upsert the user message for this turn and wait for the commit.
 *
 * Idempotent by construction: the id comes from the client, so a retried POST
 * (or a reconnect that replays the same body) updates nothing instead of
 * appending a second copy of the question.
 *
 * Never throws. A database that is down must not swallow the person's turn —
 * the caller logs and streams anyway, and the runtime still has the message in
 * the request body, so the agent can answer; only the durable copy is missing.
 */
export async function persistUserMessageForTurn(
  sessionId: string | null | undefined,
  body: Record<string, unknown>,
): Promise<PersistUserMessageResult> {
  if (!sessionId) return { id: null, created: false }
  const message = findUserMessage(body)
  if (!message) return { id: null, created: false }

  const id = typeof message.id === 'string' && message.id ? message.id : null
  if (!id) return { id: null, created: false }

  const content = messageText(message).trim()
  const parts = Array.isArray(message.parts) ? JSON.stringify(message.parts) : null

  try {
    const existing = await prisma.chatMessage.findUnique({ where: { id }, select: { sessionId: true } })
    // Already written by an earlier attempt (or a retry of this same send).
    if (existing && existing.sessionId === sessionId) return { id, created: false }
    // Same id, another session: a collision, so this message needs its own row.
    if (existing) return createWithFreshId(sessionId, content, parts)
    await prisma.chatMessage.create({
      data: {
        id,
        sessionId,
        role: 'user',
        content,
        ...(parts ? { parts } : {}),
      },
    })
    // Same side effect the generated create route's `afterCreate` runs, so the
    // history sidebar and project row still move on a send (SHO-190).
    await bumpChatSessionActivity({ sessionId }, { prisma } as any).catch(() => {})
    return { id, created: true }
  } catch (error: any) {
    // P2002: a concurrent attempt (the same send retried, or a reconnect) won
    // the insert. The row is exactly what this call would have written — unless
    // the id it claimed belongs to another session, in which case it is a
    // collision and this message still needs a row of its own.
    if (error?.code === 'P2002') {
      const existing = await prisma.chatMessage
        .findUnique({ where: { id }, select: { sessionId: true } })
        .catch(() => null)
      if (!existing || existing.sessionId === sessionId) return { id, created: false }
      return createWithFreshId(sessionId, content, parts)
    }
    console.warn(
      `[ChatUserMessage] USER ROW WRITE FAILED session=${sessionId} id=${id}:`,
      error?.message ?? error,
    )
    return { id: null, created: false }
  }
}

/** Last resort after an id collision: let the database mint the row's id. */
async function createWithFreshId(
  sessionId: string,
  content: string,
  parts: string | null,
): Promise<PersistUserMessageResult> {
  try {
    const row = await prisma.chatMessage.create({
      data: { sessionId, role: 'user', content, ...(parts ? { parts } : {}) },
      select: { id: true },
    })
    await bumpChatSessionActivity({ sessionId }, { prisma } as any).catch(() => {})
    return { id: row.id, created: true }
  } catch (error: any) {
    console.warn(`[ChatUserMessage] USER ROW WRITE FAILED session=${sessionId}:`, error?.message ?? error)
    return { id: null, created: false }
  }
}
