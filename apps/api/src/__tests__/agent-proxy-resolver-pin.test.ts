// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage extras for src/lib/agent-proxy-resolver.ts targeting the
// preferredInstance pin / tunnel branches (lines 139-178), which the
// existing test file doesn't exercise.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  resolveAgentProxyPodUrl,
  type AgentProxyResolverDeps,
  type ProjectRoutingRecord,
} from '../lib/agent-proxy-resolver'

let warnSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

function baseDeps(over: Partial<AgentProxyResolverDeps> = {}): AgentProxyResolverDeps {
  return {
    isVMIsolation: () => false,
    isKubernetes: () => false,
    resolver: mock(async () => ({ url: 'http://10.0.0.5:3001' })) as any,
    loadProject: async () => null,
    isTunnelOnline: async () => false,
    ...over,
  }
}

function project(over: Partial<ProjectRoutingRecord> = {}): ProjectRoutingRecord {
  return {
    workspaceId: 'ws_default',
    preferredInstanceId: 'inst_1',
    preferredInstancePolicy: 'pinned',
    ...over,
  }
}

// ─── pinned instance online → 'tunnel' resolution ─────────────────────

describe('preferredInstance — online tunnel wins over cloud + cluster routing', () => {
  test('returns kind="tunnel" with instanceId, workspaceId, projectId when the pin is online', async () => {
    const resolver = mock(async () => ({ url: 'should-not-be-called' }))
    const isTunnelOnline = mock(async () => true)
    const out = await resolveAgentProxyPodUrl('proj_pin_online', baseDeps({
      loadProject: async () => project({ workspaceId: 'ws_42', preferredInstanceId: 'inst_xyz' }),
      isTunnelOnline,
      resolver: resolver as any,
    }))
    expect(out).toEqual({
      ok: true,
      kind: 'tunnel',
      instanceId: 'inst_xyz',
      workspaceId: 'ws_42',
      projectId: 'proj_pin_online',
    })
    expect(isTunnelOnline).toHaveBeenCalledWith('inst_xyz')
    // The cloud resolver MUST NOT be touched when the tunnel is online.
    expect(resolver).not.toHaveBeenCalled()
  })

  test('tunnel branch wins even when isVMIsolation + isKubernetes are both true', async () => {
    const resolver = mock(async () => ({ url: 'unreachable' }))
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      isVMIsolation: () => true,
      isKubernetes: () => true,
      loadProject: async () => project(),
      isTunnelOnline: async () => true,
      resolver: resolver as any,
    }))
    expect(out.ok).toBe(true)
    expect((out as any).kind).toBe('tunnel')
    expect(resolver).not.toHaveBeenCalled()
  })
})

// ─── pinned + offline + policy variations ─────────────────────────────

describe('preferredInstance — offline tunnel with policy variations', () => {
  test('policy="pinned" (default) + offline → 503 instance_offline with helpful message', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'pinned' }),
      isTunnelOnline: async () => false,
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(503)
      expect(out.body.error.code).toBe('instance_offline')
      expect(out.body.error.message).toMatch(/pinned to is offline/)
      expect(out.body.error.message).toMatch(/shogo worker start/)
      expect(out.body.error.message).toMatch(/policy=prefer/)
    }
  })

  test('policy="prefer" + offline → falls through to cloud resolver (returns pod URL)', async () => {
    const resolver = mock(async () => ({ url: 'http://cloud.example/agent' }))
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'prefer' }),
      isTunnelOnline: async () => false,
      resolver: resolver as any,
    }))
    expect(out).toEqual({ ok: true, kind: 'pod', url: 'http://cloud.example/agent' })
    expect(resolver).toHaveBeenCalledTimes(1)
    // We emit a warn line explaining why we fell back to cloud.
    expect(warnSpy).toHaveBeenCalled()
  })

  test('policy="prefer" + offline + cloud resolver throws → cascades into 503 agent_start_failed', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'prefer' }),
      isTunnelOnline: async () => false,
      resolver: mock(async () => { throw new Error('host start failed') }) as any,
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(503)
      expect(out.body.error.code).toBe('agent_start_failed')
    }
  })

  test('unknown policy value (e.g. "weird") fails closed like "pinned"', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'weird' }),
      isTunnelOnline: async () => false,
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(503)
      expect(out.body.error.code).toBe('instance_offline')
    }
  })
})

// ─── isTunnelOnline failure paths ─────────────────────────────────────

describe('isTunnelOnline failure paths', () => {
  test('isTunnelOnline throws → treated as offline → 503 under default policy', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'pinned' }),
      isTunnelOnline: mock(async () => { throw new Error('redis ECONNREFUSED') }),
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.body.error.code).toBe('instance_offline')
    // We logged the redis failure as a warning.
    expect(warnSpy).toHaveBeenCalled()
  })

  test('isTunnelOnline throws + policy="prefer" → falls back to cloud resolver', async () => {
    const resolver = mock(async () => ({ url: 'http://cloud' }))
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'prefer' }),
      isTunnelOnline: async () => { throw new Error('redis down') },
      resolver: resolver as any,
    }))
    expect(out).toEqual({ ok: true, kind: 'pod', url: 'http://cloud' })
  })

  test('isTunnelOnline throws non-Error (string) — still treated as offline without crashing', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'pinned' }),
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      isTunnelOnline: async () => { throw 'bare string' as any },
    }))
    expect(out.ok).toBe(false)
  })
})

// ─── loadProject failure / null paths ─────────────────────────────────

describe('loadProject failure paths', () => {
  test('loadProject throws → falls through to cloud resolver (treated as "no pin")', async () => {
    const resolver = mock(async () => ({ url: 'http://cloud-fallback' }))
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => { throw new Error('prisma down') },
      resolver: resolver as any,
    }))
    expect(out).toEqual({ ok: true, kind: 'pod', url: 'http://cloud-fallback' })
    expect(warnSpy).toHaveBeenCalled()
  })

  test('loadProject throws a non-Error (string) — warned + falls through to cloud', async () => {
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      loadProject: async () => { throw 'no-message-here' as any },
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    expect(out.ok).toBe(true)
  })

  test('loadProject returns null → goes straight to cloud resolver (no isTunnelOnline call)', async () => {
    const isTunnelOnline = mock(async () => true)
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => null,
      isTunnelOnline,
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    expect(out.ok).toBe(true)
    expect(isTunnelOnline).not.toHaveBeenCalled()
  })

  test('loadProject returns project with preferredInstanceId=null → skips tunnel check, uses cloud', async () => {
    const isTunnelOnline = mock(async () => true)
    const out = await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => ({
        workspaceId: 'ws', preferredInstanceId: null, preferredInstancePolicy: 'pinned',
      }),
      isTunnelOnline,
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    expect(out.ok).toBe(true)
    expect((out as any).kind).toBe('pod')
    expect(isTunnelOnline).not.toHaveBeenCalled()
  })
})

// ─── logTag forwarding ────────────────────────────────────────────────

describe('logTag forwarding', () => {
  test('custom logTag appears in the warn line when loadProject fails', async () => {
    await resolveAgentProxyPodUrl('p', baseDeps({
      logTag: 'WebhookProxy',
      loadProject: async () => { throw new Error('prisma kaboom') },
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    const calls = warnSpy.mock.calls.flat().map(String).join('\n')
    expect(calls).toContain('WebhookProxy')
  })

  test('custom logTag appears in the warn line when tunnel check fails', async () => {
    await resolveAgentProxyPodUrl('p', baseDeps({
      logTag: 'WebhookProxy',
      loadProject: async () => project({ preferredInstancePolicy: 'prefer' }),
      isTunnelOnline: async () => { throw new Error('redis down') },
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    const calls = warnSpy.mock.calls.flat().map(String).join('\n')
    expect(calls).toContain('WebhookProxy')
  })

  test('default logTag "AgentProxy" is used when none is provided', async () => {
    await resolveAgentProxyPodUrl('p', baseDeps({
      loadProject: async () => project({ preferredInstancePolicy: 'prefer' }),
      isTunnelOnline: async () => false,
      resolver: mock(async () => ({ url: 'http://cloud' })) as any,
    }))
    const calls = warnSpy.mock.calls.flat().map(String).join('\n')
    expect(calls).toContain('AgentProxy')
  })
})
