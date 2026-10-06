// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * routeToHomeRegion: run a workspace-scoped write in the workspace's home
 * region, never falling back to a local write when the home region is a
 * reachable-in-principle peer that fails.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const state = {
  multi: true,
  workspace: { homeRegion: 'eu-frankfurt-1' } as { homeRegion: string | null } | null,
  lookupThrows: false,
  peers: { 'eu-frankfurt-1': { id: 'eu-frankfurt-1', label: 'EU', url: 'https://eu' } } as Record<string, any>,
  peerCalls: [] as Array<{ region: string; path: string; body: unknown }>,
  peerResult: { status: 200, ok: true, data: { resumed: true } } as any,
  peerThrows: false,
}

mock.module('../region', () => ({
  isMultiRegionActive: () => state.multi,
  PRIMARY_REGION: 'us-ashburn-1',
  RAW_REGION_ID: 'us-ashburn-1',
  getPeer: (id: string) => state.peers[id],
}))
mock.module('../region-peer-proxy', () => ({
  callPeerInternal: async (region: string, path: string, body: unknown) => {
    state.peerCalls.push({ region, path, body })
    if (state.peerThrows) throw new Error('connect timeout')
    return state.peerResult
  },
}))
mock.module('../prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => {
        if (state.lookupThrows) throw new Error('db down')
        return state.workspace
      },
    },
  },
}))

const { routeToHomeRegion } = await import('../home-region-route')

beforeEach(() => {
  state.multi = true
  state.workspace = { homeRegion: 'eu-frankfurt-1' }
  state.lookupThrows = false
  state.peers = { 'eu-frankfurt-1': { id: 'eu-frankfurt-1', label: 'EU', url: 'https://eu' } }
  state.peerCalls = []
  state.peerResult = { status: 200, ok: true, data: { resumed: true } }
  state.peerThrows = false
})

describe('routeToHomeRegion', () => {
  it('is local in single-region mode without consulting the database', async () => {
    state.multi = false
    expect(await routeToHomeRegion('ws-1', '/p', {})).toEqual({ outcome: 'local' })
    expect(state.peerCalls).toHaveLength(0)
  })

  it('is local when this region is the home region', async () => {
    state.workspace = { homeRegion: 'us-ashburn-1' }
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('local')
  })

  it('treats a null homeRegion as the primary region', async () => {
    state.workspace = { homeRegion: null }
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('local')
    expect(state.peerCalls).toHaveLength(0)
  })

  it('is local for a workspace this region does not know', async () => {
    state.workspace = null
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('local')
  })

  it('forwards to the peer home region and returns its reply', async () => {
    const routed = await routeToHomeRegion<{ resumed: boolean }>('ws-1', '/api/internal/x', { n: 1 })
    expect(routed).toEqual({ outcome: 'forwarded', data: { resumed: true } })
    expect(state.peerCalls).toEqual([{ region: 'eu-frankfurt-1', path: '/api/internal/x', body: { n: 1 } }])
  })

  it('is unavailable (never local) when the peer rejects, is unreachable, or is unconfigured', async () => {
    state.peerResult = { status: 503, ok: false, data: null }
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('unavailable')

    state.peerThrows = true
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('unavailable')

    state.peerThrows = false
    state.peers = {}
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('unavailable')
  })

  it('is unavailable when the home region lookup fails', async () => {
    state.lookupThrows = true
    expect((await routeToHomeRegion('ws-1', '/p', {})).outcome).toBe('unavailable')
    expect(state.peerCalls).toHaveLength(0)
  })
})
