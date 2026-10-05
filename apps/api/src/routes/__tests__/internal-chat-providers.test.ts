// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-region internal endpoints for chat providers: authenticated with the
 * shared secret, and they run the work locally without re-routing.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const state = {
  handled: [] as any[],
  resumed: [] as any[],
  resumeResult: true,
}

mock.module('../../services/chat-providers/inbound', () => ({
  bridgeActive: async () => false,
  inboundForwardPath: (kind: string) => `/api/internal/chat-providers/${kind}/inbound`,
  resumeForwardPath: (kind: string) => `/api/internal/chat-providers/${kind}/resume`,
  routeInboundEvents: async (_p: any, events: any[]) => ({ local: events, unavailable: false }),
  handleInboundEvent: async () => null,
  ensureShadowConversation: async () => null,
  addressAgents: async () => [],
  resumeAfterLinkInHomeRegion: async () => false,
  handleInboundEvents: async (provider: any, events: any[]) => {
    state.handled.push({ provider: provider.kind, events })
  },
  resumeAfterLink: async (provider: any, pending: any, userId: string) => {
    state.resumed.push({ provider: provider.kind, pending, userId })
    return state.resumeResult
  },
}))
mock.module('../../services/chat-providers/registry', () => ({
  getChatProvider: (kind: string) => (kind === 'teams' ? { kind: 'teams' } : null),
}))

process.env.SHOGO_INTERNAL_SECRET = 'peer-secret'
const { default: internal } = await import('../internal')
const bus = await import('../../lib/conversation-bus')
const presence = await import('../../services/conversation-presence')

const call = (path: string, body: unknown, secret: string | null = 'peer-secret') =>
  internal.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-shogo-internal-secret': secret } : {}) },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  state.handled = []
  state.resumed = []
  state.resumeResult = true
})

describe('POST /chat-providers/:provider/inbound', () => {
  const events = [{ type: 'message', tenantId: 't', channelId: 'c', messageId: 'm', text: 'hi' }]

  it('rejects calls without the shared secret', async () => {
    expect((await call('/chat-providers/teams/inbound', { events }, null)).status).toBe(401)
    expect((await call('/chat-providers/teams/inbound', { events }, 'wrong')).status).toBe(401)
    expect(state.handled).toHaveLength(0)
  })

  it('runs forwarded events locally', async () => {
    const res = await call('/chat-providers/teams/inbound', { events })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 0))
    expect(state.handled).toEqual([{ provider: 'teams', events }])
  })

  it('validates the provider and body', async () => {
    expect((await call('/chat-providers/nope/inbound', { events })).status).toBe(404)
    expect((await call('/chat-providers/teams/inbound', { events: 'x' })).status).toBe(400)
  })
})

describe('POST /chat-providers/:provider/resume', () => {
  const body = { tenantId: 't', channelId: 'c', messageId: 'm', userId: 'u' }

  it('rejects calls without the shared secret', async () => {
    expect((await call('/chat-providers/teams/resume', body, 'wrong')).status).toBe(401)
    expect(state.resumed).toHaveLength(0)
  })

  it('resumes locally and reports the result', async () => {
    const res = await call('/chat-providers/teams/resume', body)
    expect(await res.json()).toEqual({ resumed: true })
    expect(state.resumed[0]).toEqual({
      provider: 'teams',
      pending: { tenantId: 't', channelId: 'c', messageId: 'm' },
      userId: 'u',
    })
    state.resumeResult = false
    expect(await (await call('/chat-providers/teams/resume', body)).json()).toEqual({ resumed: false })
  })

  it('validates params', async () => {
    expect((await call('/chat-providers/teams/resume', { tenantId: 't' })).status).toBe(400)
  })
})

describe('POST /conversation-bus/relay', () => {
  it('rejects calls without the shared secret', async () => {
    const res = await call('/conversation-bus/relay', { envelopes: [], presence: [] }, 'wrong')
    expect(res.status).toBe(401)
  })

  it('delivers relayed events to local sockets and applies presence', async () => {
    const seen: any[] = []
    const unsubscribe = bus.subscribeWorkspaceEvents('ws-relay', (e) => seen.push(e))
    const res = await call('/conversation-bus/relay', {
      envelopes: [
        { workspaceId: 'ws-relay', event: { type: 'message.created' }, audience: null, origin: 'eu-pod' },
        { nope: true },
      ],
      presence: [
        { workspaceId: 'ws-relay', userId: 'remote-user', status: 'active' },
        { workspaceId: 'ws-relay', userId: 'bad', status: 'sleeping' },
      ],
    })
    unsubscribe()
    expect(await res.json()).toEqual({ ok: true, envelopes: 1, presence: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0].event.type).toBe('message.created')
    expect((await presence.getPresence('ws-relay', ['remote-user', 'bad']))).toEqual({
      'remote-user': 'active',
      bad: 'offline',
    })
  })

  it('refuses oversized batches', async () => {
    const envelopes = Array.from({ length: 501 }, () => ({ workspaceId: 'w', event: { type: 't' }, audience: null, origin: 'x' }))
    expect((await call('/conversation-bus/relay', { envelopes, presence: [] })).status).toBe(400)
  })
})
