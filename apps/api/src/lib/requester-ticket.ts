// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed proof of who started an agent turn.
 *
 * The API issues a ticket when it forwards a verified person's message to a
 * project runtime. The runtime hands it back when a tool needs that person's
 * own integration credentials, and the API reads the user from the ticket,
 * never from a field the runtime (or the agent's shell) could set. A ticket is
 * bound to one project and expires, so it cannot be replayed elsewhere.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const KIND = 'requester-ticket'
const TICKET_TTL_MS = 6 * 60 * 60 * 1000

export const REQUESTER_TICKET_HEADER = 'X-Requester-Ticket'

export interface RequesterTicket {
  projectId: string
  userId: string
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

export function signRequesterTicket(
  value: { projectId: string; userId: string },
  nowMs = Date.now(),
): string {
  const payload: RequesterTicket = { ...value, exp: nowMs + TICKET_TTL_MS, nonce: randomUUID() }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${mac(encoded)}`
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
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RequesterTicket
    if (typeof payload?.userId !== 'string' || !payload.userId) return null
    if (payload.projectId !== projectId) return null
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null
    return payload
  } catch {
    return null
  }
}

/** A ticket for the forwarded request, or nothing when signing isn't configured. */
export function requesterTicketHeader(projectId: string, userId: string | null | undefined): Record<string, string> {
  if (!userId || userId === 'system' || !process.env.BETTER_AUTH_SECRET) return {}
  return { [REQUESTER_TICKET_HEADER]: signRequesterTicket({ projectId, userId }) }
}
