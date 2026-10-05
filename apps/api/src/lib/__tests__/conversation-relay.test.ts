// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-region relay of chat realtime events and presence: each published
 * envelope reaches a sibling region exactly once, relayed envelopes are
 * delivered locally without bouncing back, and relayed presence is visible to
 * `getPresence`.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const state = {
  calls: [] as Array<{ region: string; path: string; body: any }>,
  ok: true,
}

mock.module('../region', () => ({
  RAW_REGION_ID: 'us-ashburn-1',
  REGION_PEERS: [{ id: 'eu-frankfurt-1', label: 'EU', url: 'https://eu' }],
  isMultiRegionActive: () => true,
}))
mock.module('../region-peer-proxy', () => ({
  callPeerInternal: async (region: string, path: string, body: any) => {
    state.calls.push({ region, path, body })
    return { status: state.ok ? 200 : 503, ok: state.ok, data: null }
  },
}))

const bus = await import('../conversation-bus')
const presence = await import('../../services/conversation-presence')
const relay = await import('../conversation-relay')

const sentEnvelopes = () => state.calls.flatMap((c) => c.body.envelopes)
const sentPresence = () => state.calls.flatMap((c) => c.body.presence)

beforeEach(async () => {
  state.calls = []
  state.ok = true
  await bus._resetConversationBusForTests(null)
  presence._resetPresenceForTests()
  relay.stopConversationRelay()
  relay._installConversationRelayForTests()
})

describe('event relay', () => {
  it('sends each published envelope to the sibling region exactly once', async () => {
    bus.publishConversationEvent('ws-1', { type: 'message.created', conversationId: 'c1' }, ['user-1'])
    await relay.flushConversationRelay()
    await relay.flushConversationRelay()

    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].region).toBe('eu-frankfurt-1')
    expect(state.calls[0].path).toBe(relay.RELAY_PATH)
    expect(sentEnvelopes()).toHaveLength(1)
    expect(sentEnvelopes()[0]).toMatchObject({ workspaceId: 'ws-1', audience: ['user-1'], event: { type: 'message.created' } })
  })

  it('still delivers locally and never throws when the peer is down', async () => {
    state.ok = false
    const seen: any[] = []
    bus.subscribeWorkspaceEvents('ws-1', (e) => seen.push(e))
    bus.publishConversationEvent('ws-1', { type: 'message.created' })
    await relay.flushConversationRelay()
    expect(seen).toHaveLength(1)
    // The failed batch is dropped, not retried forever.
    await relay.flushConversationRelay()
    expect(state.calls).toHaveLength(1)
  })

  it('delivers relayed envelopes to local listeners without relaying them again', async () => {
    const seen: any[] = []
    bus.subscribeWorkspaceEvents('ws-1', (e) => seen.push(e))
    bus.publishRelayed([
      { workspaceId: 'ws-1', event: { type: 'typing', userId: 'u2' }, audience: null, origin: 'pod-in-eu' },
    ])
    await relay.flushConversationRelay()

    expect(seen).toHaveLength(1)
    expect(seen[0].event).toEqual({ type: 'typing', userId: 'u2' })
    expect(state.calls).toHaveLength(0)
  })

  it('under backpressure drops typing before real messages and stays bounded', async () => {
    state.ok = false
    const original = state.calls
    for (let i = 0; i < 2100; i++) bus.publishConversationEvent('ws-1', { type: 'typing', userId: `u${i}` })
    bus.publishConversationEvent('ws-1', { type: 'message.created', conversationId: 'c1' })
    state.ok = true
    state.calls = original
    for (let i = 0; i < 20; i++) await relay.flushConversationRelay()

    const envelopes = sentEnvelopes()
    expect(envelopes.length).toBeLessThanOrEqual(2000)
    expect(envelopes.some((e) => e.event.type === 'message.created')).toBe(true)
  })
})

describe('presence relay', () => {
  it('relays heartbeats so the sibling region can refresh its copy', async () => {
    presence.registerPresenceSocket('ws-1', 'user-1')
    await presence.recordPresence('ws-1', 'user-1', 'active')
    await presence.recordPresence('ws-1', 'user-1', 'active')
    await relay.flushConversationRelay()

    // Heartbeats collapse to the latest state per person.
    expect(sentPresence()).toEqual([{ workspaceId: 'ws-1', userId: 'user-1', status: 'active' }])
  })

  it('makes presence relayed from a sibling region visible to getPresence', async () => {
    await presence.applyRelayedPresence([{ workspaceId: 'ws-1', userId: 'remote-user', status: 'active' }])
    expect(await presence.getPresence('ws-1', ['remote-user', 'nobody'])).toEqual({
      'remote-user': 'active',
      nobody: 'offline',
    })

    await presence.applyRelayedPresence([{ workspaceId: 'ws-1', userId: 'remote-user', status: 'offline' }])
    expect((await presence.getPresence('ws-1', ['remote-user']))['remote-user']).toBe('offline')
  })

  it('does not let relayed presence overwrite or clear a live local socket', async () => {
    presence.registerPresenceSocket('ws-1', 'user-1')
    await presence.recordPresence('ws-1', 'user-1', 'active')

    await presence.applyRelayedPresence([{ workspaceId: 'ws-1', userId: 'user-1', status: 'away' }])
    expect((await presence.getPresence('ws-1', ['user-1']))['user-1']).toBe('active')

    await presence.applyRelayedPresence([{ workspaceId: 'ws-1', userId: 'user-1', status: 'offline' }])
    expect((await presence.getPresence('ws-1', ['user-1']))['user-1']).toBe('active')
  })

  it('does not relay presence that arrived from a sibling region', async () => {
    await presence.applyRelayedPresence([{ workspaceId: 'ws-1', userId: 'remote-user', status: 'active' }])
    await relay.flushConversationRelay()
    expect(state.calls).toHaveLength(0)
  })
})
