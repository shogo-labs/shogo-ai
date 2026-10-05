// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Requester tickets: the API's signed proof of who started an agent turn.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
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

  test('the forwarding header is skipped for system turns and when signing is not configured', () => {
    expect(Object.keys(requesterTicketHeader('p1', 'u1'))).toEqual([REQUESTER_TICKET_HEADER])
    expect(requesterTicketHeader('p1', 'system')).toEqual({})
    expect(requesterTicketHeader('p1', null)).toEqual({})
    delete process.env.BETTER_AUTH_SECRET
    expect(requesterTicketHeader('p1', 'u1')).toEqual({})
  })
})
