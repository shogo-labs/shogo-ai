// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Requester tickets: the API's signed proof of who started an agent turn.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  handOffRequesterTicket,
  MAX_TICKET_HOPS,
  REQUESTER_TICKET_HEADER,
  requesterTicketHeader,
  signRequesterTicket,
  verifyRequesterTicket,
} from '../requester-ticket'

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'ticket-secret'
})

describe('requester tickets', () => {
  test('round-trips the user for the project it was issued for', () => {
    const ticket = signRequesterTicket({ projectId: 'p1', userId: 'u1' })
    expect(verifyRequesterTicket(ticket, 'p1')).toMatchObject({ projectId: 'p1', userId: 'u1' })
  })

  test('is bound to one project', () => {
    expect(verifyRequesterTicket(signRequesterTicket({ projectId: 'p1', userId: 'u1' }), 'p2')).toBeNull()
  })

  test('expires after six hours', () => {
    const now = Date.now()
    const ticket = signRequesterTicket({ projectId: 'p1', userId: 'u1' }, now)
    expect(verifyRequesterTicket(ticket, 'p1', now + 5 * 60 * 60 * 1000)).not.toBeNull()
    expect(verifyRequesterTicket(ticket, 'p1', now + 7 * 60 * 60 * 1000)).toBeNull()
  })

  test('rejects a payload edited to name someone else, another secret, and junk', () => {
    const ticket = signRequesterTicket({ projectId: 'p1', userId: 'u1' })
    const [encoded, mac] = ticket.split('.')
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: 'admin' })).toString('base64url')
    expect(verifyRequesterTicket(`${forged}.${mac}`, 'p1')).toBeNull()

    process.env.BETTER_AUTH_SECRET = 'other-secret'
    expect(verifyRequesterTicket(ticket, 'p1')).toBeNull()

    for (const junk of [undefined, null, '', 'u1', 'a.b', `${encoded}.`]) {
      expect(verifyRequesterTicket(junk as any, 'p1')).toBeNull()
    }
  })

  test('carries where the turn started; old tickets without it read as a chat', () => {
    const origin = { kind: 'chat' as const, chatSessionId: 'cs-1' }
    expect(verifyRequesterTicket(signRequesterTicket({ projectId: 'p1', userId: 'u1', origin }), 'p1')).toMatchObject({
      origin,
      via: [],
    })
    const legacy = Buffer.from(JSON.stringify({ projectId: 'p1', userId: 'u1', exp: Date.now() + 60_000, nonce: 'n' })).toString('base64url')
    const mac = createHmac('sha256', 'ticket-secret').update(`requester-ticket.${legacy}`).digest('base64url')
    expect(verifyRequesterTicket(`${legacy}.${mac}`, 'p1')).toMatchObject({ userId: 'u1', origin: { kind: 'chat' }, via: [] })
  })

  test('hands off to the next project with the same person, origin and expiry', () => {
    const now = Date.now()
    const origin = { kind: 'chat' as const, chatSessionId: 'cs-1' }
    const a = verifyRequesterTicket(signRequesterTicket({ projectId: 'A', userId: 'bob', origin }, now), 'A', now)!
    const toB = handOffRequesterTicket(a, 'B')!
    expect(verifyRequesterTicket(toB, 'A')).toBeNull()
    const b = verifyRequesterTicket(toB, 'B', now)!
    expect(b).toMatchObject({ projectId: 'B', userId: 'bob', origin, via: ['A'], exp: a.exp })
    const c = verifyRequesterTicket(handOffRequesterTicket(b, 'C'), 'C', now)!
    expect(c.via).toEqual(['A', 'B'])
    expect(verifyRequesterTicket(toB, 'B', a.exp + 1)).toBeNull()
  })

  test('refuses hand-offs that loop back or go past the hop limit', () => {
    const a = verifyRequesterTicket(signRequesterTicket({ projectId: 'A', userId: 'bob' }), 'A')!
    const b = verifyRequesterTicket(handOffRequesterTicket(a, 'B'), 'B')!
    expect(handOffRequesterTicket(b, 'A')).toBeNull()
    expect(handOffRequesterTicket(b, 'B')).toBeNull()

    let ticket = a
    for (let i = 1; i <= MAX_TICKET_HOPS; i++) {
      const next = handOffRequesterTicket(ticket, `P${i}`)
      expect(next).not.toBeNull()
      ticket = verifyRequesterTicket(next, `P${i}`)!
    }
    expect(ticket.via).toHaveLength(MAX_TICKET_HOPS)
    expect(handOffRequesterTicket(ticket, 'one-too-many')).toBeNull()
  })

  test('the forwarding header is skipped for system turns and when signing is not configured', () => {
    expect(Object.keys(requesterTicketHeader('p1', 'u1'))).toEqual([REQUESTER_TICKET_HEADER])
    expect(requesterTicketHeader('p1', 'system')).toEqual({})
    expect(requesterTicketHeader('p1', null)).toEqual({})
    delete process.env.BETTER_AUTH_SECRET
    expect(requesterTicketHeader('p1', 'u1')).toEqual({})
  })
})
