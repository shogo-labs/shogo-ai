// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inbound provider events belong to the workspace's home region: events for a
 * peer-homed workspace are forwarded instead of written here, and an
 * unreachable home region surfaces as `unavailable` so the webhook can 503.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const state = {
  tenants: { 'tenant-home': 'ws-home', 'tenant-peer': 'ws-peer' } as Record<string, string>,
  outcomes: { 'ws-home': 'local', 'ws-peer': 'forwarded' } as Record<string, 'local' | 'forwarded' | 'unavailable'>,
  resumeData: { resumed: true } as any,
  routed: [] as Array<{ workspaceId: string; path: string; body: any }>,
}

mock.module('../../lib/prisma', () => ({ prisma: {} }))
mock.module('../../lib/home-region-route', () => ({
  routeToHomeRegion: async (workspaceId: string, path: string, body: any) => {
    state.routed.push({ workspaceId, path, body })
    return { outcome: state.outcomes[workspaceId] ?? 'local', data: state.resumeData }
  },
}))
mock.module('../chat-providers/installations', () => ({
  InstallationConflictError: class extends Error {},
  installationForTenant: async (_provider: string, tenantId: string) =>
    state.tenants[tenantId] ? { id: `inst-${tenantId}`, workspaceId: state.tenants[tenantId] } : null,
  linkedUserId: async () => null,
  linkIdentity: async () => ({}),
  mergeInstallationConfig: async () => ({}),
  upsertInstallation: async () => ({}),
  toInstallationRecord: (row: any) => row,
  installationForWorkspace: async () => null,
  listInstallations: async () => [],
  removeInstallation: async () => {},
  externalIdentityFor: async () => null,
}))
mock.module('../chat-providers/link', () => ({
  parseConnectCommand: (text: string) => /^\s*connect\s+(\S+)\s*$/i.exec(text)?.[1] ?? null,
  createConnectCode: () => ({ code: 'x', expiresAt: new Date() }),
  createLinkState: () => 'state',
  verifyLinkState: () => null,
  chatLinkUrl: () => 'https://example.com',
  verifyConnectCode: (code: string) => (code === 'good-code' ? { provider: 'teams', workspaceId: 'ws-peer', userId: 'u' } : null),
}))

const { routeInboundEvents, resumeAfterLinkInHomeRegion } = await import('../chat-providers/inbound')

const provider = { kind: 'teams' } as any

function message(tenantId: string, text = 'hello', messageId = 'm1') {
  return { type: 'message', tenantId, channelId: 'c1', messageId, text } as any
}

beforeEach(() => {
  state.outcomes = { 'ws-home': 'local', 'ws-peer': 'forwarded' }
  state.resumeData = { resumed: true }
  state.routed = []
})

describe('routeInboundEvents', () => {
  it('keeps events for home workspaces local and forwards the rest to their home region', async () => {
    const home = message('tenant-home', 'hi', 'm1')
    const peer = message('tenant-peer', 'hi', 'm2')
    const result = await routeInboundEvents(provider, [home, peer])
    expect(result.local).toEqual([home])
    expect(result.unavailable).toBe(false)
    expect(state.routed.find((r) => r.workspaceId === 'ws-peer')).toEqual({
      workspaceId: 'ws-peer',
      path: '/api/internal/chat-providers/teams/inbound',
      body: { events: [peer] },
    })
  })

  it('batches events for the same peer workspace into one call', async () => {
    await routeInboundEvents(provider, [message('tenant-peer', 'a', 'm1'), message('tenant-peer', 'b', 'm2')])
    expect(state.routed).toHaveLength(1)
    expect(state.routed[0].body.events).toHaveLength(2)
  })

  it('reports unavailable and drops nothing locally when the home region cannot be reached', async () => {
    state.outcomes['ws-peer'] = 'unavailable'
    const result = await routeInboundEvents(provider, [message('tenant-peer')])
    expect(result.unavailable).toBe(true)
    expect(result.local).toEqual([])
  })

  it('handles events for unknown tenants locally', async () => {
    const stray = message('tenant-unknown')
    const result = await routeInboundEvents(provider, [stray])
    expect(result.local).toEqual([stray])
    expect(state.routed).toHaveLength(0)
  })

  it('routes a connect command by the workspace named in its code', async () => {
    const connect = message('tenant-new', 'connect good-code')
    const result = await routeInboundEvents(provider, [connect])
    expect(result.local).toEqual([])
    expect(state.routed[0].workspaceId).toBe('ws-peer')

    state.routed = []
    const invalid = message('tenant-new', 'connect bad-code')
    expect((await routeInboundEvents(provider, [invalid])).local).toEqual([invalid])
    expect(state.routed).toHaveLength(0)
  })
})

describe('resumeAfterLinkInHomeRegion', () => {
  const pending = { tenantId: 'tenant-peer', channelId: 'c1', messageId: 'm1' }

  it('forwards to the home region and returns its answer', async () => {
    expect(await resumeAfterLinkInHomeRegion(provider, pending, 'user-1')).toBe(true)
    expect(state.routed[0]).toEqual({
      workspaceId: 'ws-peer',
      path: '/api/internal/chat-providers/teams/resume',
      body: { ...pending, userId: 'user-1' },
    })
    state.resumeData = { resumed: false }
    expect(await resumeAfterLinkInHomeRegion(provider, pending, 'user-1')).toBe(false)
  })

  it('does not resume when the home region is unavailable or the tenant is unknown', async () => {
    state.outcomes['ws-peer'] = 'unavailable'
    expect(await resumeAfterLinkInHomeRegion(provider, pending, 'user-1')).toBe(false)
    expect(await resumeAfterLinkInHomeRegion(provider, { ...pending, tenantId: 'nope' }, 'user-1')).toBe(false)
  })
})
