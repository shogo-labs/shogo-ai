// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed proof of who an agent turn is for, and where it came from.
 *
 * The API issues a ticket when it starts a turn on a project runtime: for a
 * verified person's chat message, or when one project's agent calls another
 * (`project_call`) on that person's behalf. The runtime hands it back when a
 * tool needs that person's own integration credentials, and the API reads the
 * person from the ticket, never from a field the runtime (or the agent's
 * shell) could set. A ticket is bound to one project and expires, so it
 * cannot be replayed elsewhere.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const KIND = 'requester-ticket'
const TICKET_TTL_MS = 6 * 60 * 60 * 1000
/** Longest chain of agent-to-agent calls a person's identity is carried through. */
export const MAX_TICKET_HOPS = 8

export const REQUESTER_TICKET_HEADER = 'X-Requester-Ticket'

/** Where the turn started. Hops keep the original origin and add to `via`. */
export type TicketOrigin = { kind: 'chat'; chatSessionId?: string }

export interface RequesterTicket {
  projectId: string
  userId: string
  origin: TicketOrigin
  /** Projects the turn was handed through before reaching `projectId`, oldest first. */
  via: string[]
  exp: number
  nonce: string
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET || ''
  if (!value) throw new Error('BETTER_AUTH_SECRET is required to sign requester tickets')
  return value
}

function mac(encoded: string): string {
  return createHmac('sha256', secret()).update(`${KIND}.${encoded}`).digest('base64url')
}

function encode(payload: RequesterTicket): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${mac(encoded)}`
}

export function signRequesterTicket(
  value: { projectId: string; userId: string; origin?: TicketOrigin },
  nowMs = Date.now(),
): string {
  return encode({
    projectId: value.projectId,
    userId: value.userId,
    origin: value.origin ?? { kind: 'chat' },
    via: [],
    exp: nowMs + TICKET_TTL_MS,
    nonce: randomUUID(),
  })
}

/** The ticket's payload when it is genuine, unexpired, and for `projectId`. */
export function verifyRequesterTicket(
  ticket: string | null | undefined,
  projectId: string,
  nowMs = Date.now(),
): RequesterTicket | null {
  const [encoded, given] = (ticket ?? '').trim().split('.')
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
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<RequesterTicket>
    if (typeof payload?.userId !== 'string' || !payload.userId) return null
    if (payload.projectId !== projectId) return null
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null
    return {
      projectId: payload.projectId,
      userId: payload.userId,
      origin: payload.origin?.kind === 'chat' ? payload.origin : { kind: 'chat' },
      via: Array.isArray(payload.via) ? payload.via.filter((p): p is string => typeof p === 'string') : [],
      exp: payload.exp,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : '',
    }
  } catch {
    return null
  }
}

/**
 * The ticket for the next project in an agent-to-agent call, carrying the
 * same person and origin. It never outlives the ticket it came from. Null
 * past `MAX_TICKET_HOPS` or when the call loops back to a project already
 * on the path.
 */
export function handOffRequesterTicket(parent: RequesterTicket, toProjectId: string): string | null {
  const via = [...parent.via, parent.projectId]
  if (via.length > MAX_TICKET_HOPS || via.includes(toProjectId)) return null
  return encode({
    projectId: toProjectId,
    userId: parent.userId,
    origin: parent.origin,
    via,
    exp: parent.exp,
    nonce: randomUUID(),
  })
}

/** A ticket for the forwarded request, or nothing when signing isn't configured. */
export function requesterTicketHeader(
  projectId: string,
  userId: string | null | undefined,
  origin?: TicketOrigin,
): Record<string, string> {
  if (!userId || userId === 'system' || !process.env.BETTER_AUTH_SECRET) return {}
  return { [REQUESTER_TICKET_HEADER]: signRequesterTicket({ projectId, userId, origin }) }
}
