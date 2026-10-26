// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Control-plane e2e for the metal single-runtime invariant: a project is
 * online ONLY in its own `ws:proj:<id>` runtime. Wired through the real
 * pieces (no Firecracker host):
 *
 *   resolveProjectPodUrl / resolveWorkspaceRuntimeUrl
 *     → MetalWarmPoolController.getMetalWorkspaceUrl (real buildWorkspaceEnv)
 *       → a stateful node-agent FAKE that records, per runtime key, the
 *         members it was told to mount (WORKSPACE_PROJECT_IDS on /assign)
 *   callProjectRemoteTool (the remote-tool route's service)
 *
 * Attachments are fed through the `_loadAnchoredArgs` seam as the legacy
 * mounting code would have produced them, so the assertions cover the
 * resolver + controller + env builder clamps rather than the DB read.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('../../services/billing.service', () => ({
  hasAdvancedModelAccess: async () => true,
}))

import { ForeignMemberMountError, MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry } from '../metal-placement-registry'
import { resolveProjectPodUrl, type AnchoredProjectRuntimeArgs } from '../resolve-pod-url'
import { resolveWorkspaceRuntimeUrl } from '../resolve-workspace-runtime-url'
import { callProjectRemoteTool, setProjectRuntimeUrlResolver } from '../../services/agent-call.service'

const HOST = {
  hostId: 'dal-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 8, memMiB: 16384, vcpus: 8 },
  load: { available: 8, assigned: 0, suspended: 0 },
}

const WORKSPACE = 'ws-1'

/**
 * Stateful node-agent fake. /assign records the runtime's member set from
 * the assign env; /runtimes/:key/members mounts live (and, like the real
 * agent, refuses a foreign id with 409).
 */
function fakeNodeAgent() {
  const members = new Map<string, Set<string>>()
  const assigns: string[] = []
  const memberCalls: string[] = []

  const fetchImpl = (async (url: string, init: any) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(init.body) : {}
    if (path === '/assign') {
      const key: string = body.projectId
      assigns.push(key)
      // Hold the assign open briefly so concurrent resolvers overlap.
      await new Promise((r) => setTimeout(r, 20))
      const ids = String(body.env?.WORKSPACE_PROJECT_IDS ?? '').split(',').filter(Boolean)
      members.set(key, new Set(ids))
      return new Response(JSON.stringify({ url: `http://10.8.0.2:8080/${encodeURIComponent(key)}`, mode: 'assigned' }), { status: 200 })
    }
    const live = path.match(/^\/runtimes\/([^/]+)\/members$/)
    if (live) {
      const key = decodeURIComponent(live[1])
      memberCalls.push(`${key}:${body.projectId}`)
      if (key !== `ws:proj:${body.projectId}`) {
        return new Response(JSON.stringify({ error: 'foreign_member' }), { status: 409 })
      }
      members.get(key)?.add(body.projectId)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (path === '/status') {
      return new Response(JSON.stringify({ exists: members.has(body.projectId), ready: true, replicas: 1 }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch

  return { fetchImpl, members, assigns, memberCalls }
}

/** Node-agent /members/holders + /drain-foreign-members over a member map. */
function withHolders(hostId: string, members: Map<string, Set<string>>, fallback: typeof fetch) {
  return (async (url: string, init: any) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(init.body) : {}
    if (path === '/members/holders') {
      const holders = [...members].filter(([, ids]) => ids.has(body.projectId)).map(([key]) => key)
      return new Response(JSON.stringify({ hostId, holders }), { status: 200 })
    }
    if (path === '/drain-foreign-members') {
      const results: Array<{ runtimeKey: string; projectId: string; outcome: string }> = []
      for (const [key, ids] of members) {
        for (const id of [...ids]) {
          if (key === `ws:proj:${id}`) continue
          ids.delete(id)
          results.push({ runtimeKey: key, projectId: id, outcome: 'unmounted' })
        }
      }
      return new Response(JSON.stringify({ hostId, results }), { status: 200 })
    }
    return fallback(url as any, init)
  }) as unknown as typeof fetch
}

function fakeHolderHost(hostId: string, members: Map<string, Set<string>>) {
  return withHolders(hostId, members, (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch)
}

describe('metal single-runtime invariant (control-plane e2e)', () => {
  let agent: ReturnType<typeof fakeNodeAgent>
  let registry: MetalPlacementRegistry
  let controller: MetalWarmPoolController
  const attachments = new Map<string, string[]>()
  const otherHosts = new Map<string, typeof fetch>()
  const realFetch = globalThis.fetch
  const runtimeCalls: Array<{ url: string; token: string | null; body: any }> = []

  function assertSingleHolder() {
    const holders = new Map<string, string[]>()
    for (const [key, ids] of agent.members) {
      for (const id of ids) holders.set(id, [...(holders.get(id) ?? []), key])
    }
    for (const [id, keys] of holders) {
      expect({ id, keys }).toEqual({ id, keys: [`ws:proj:${id}`] })
    }
  }

  const anchoredArgs = async (projectId: string): Promise<AnchoredProjectRuntimeArgs> => ({
    workspaceId: WORKSPACE,
    attachedProjectIds: attachments.get(projectId) ?? [],
    localFolders: [],
    readonlyProjectIds: [],
  })

  const metalSeams = () => ({
    _isMetalEnabled: () => true,
    _spawnLease: <T>(_key: string, fn: () => Promise<T>) => fn(),
    _workspaceMetalResolver: (ws: string, ids: string[], o?: { anchorProjectId?: string; readonlyProjectIds?: string[] }) =>
      controller.getMetalWorkspaceUrl(ws, ids, o),
  })

  function studioOpen(projectId: string) {
    return resolveProjectPodUrl(projectId, { ...metalSeams(), _loadAnchoredArgs: anchoredArgs, background: true })
  }

  beforeEach(() => {
    agent = fakeNodeAgent()
    registry = new MetalPlacementRegistry(() => null)
    otherHosts.clear()
    const route = ((url: string, init: any) =>
      (otherHosts.get(new URL(url).hostname) ?? withHolders('dal-1', agent.members, agent.fetchImpl))(url as any, init)) as typeof fetch
    controller = new MetalWarmPoolController(async () => ({}), route, Date.now, registry)
    controller.registerHost(HOST)
    attachments.clear()
    runtimeCalls.length = 0
    setProjectRuntimeUrlResolver(async (projectId) => (await studioOpen(projectId)).url)
    globalThis.fetch = (async (url: string, init: any) => {
      runtimeCalls.push({
        url: String(url),
        token: new Headers(init?.headers).get('x-runtime-token'),
        body: init?.body ? JSON.parse(init.body) : null,
      })
      return new Response(JSON.stringify({ ok: true, result: { content: 'hello' } }), { status: 200 })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    setProjectRuntimeUrlResolver(null)
  })

  it('opening A with attachment B mounts exactly [A] into ws:proj:A', async () => {
    attachments.set('A', ['B'])
    await studioOpen('A')
    expect(agent.assigns).toEqual(['ws:proj:A'])
    expect([...agent.members.get('ws:proj:A')!]).toEqual(['A'])
    assertSingleHolder()
  })

  it('a workspace session runtime with attachments B, C mounts nothing', async () => {
    await resolveWorkspaceRuntimeUrl(WORKSPACE, {
      attachedProjectIds: ['B', 'C'],
      readonlyProjectIds: ['C'],
      background: true,
      _isMetalEnabled: () => true,
      _spawnLease: <T>(_key: string, fn: () => Promise<T>) => fn(),
      _metalResolver: (ws, ids, o) => controller.getMetalWorkspaceUrl(ws, ids, o),
    })
    expect(agent.assigns).toEqual([`ws:${WORKSPACE}`])
    expect([...agent.members.get(`ws:${WORKSPACE}`)!]).toEqual([])
    assertSingleHolder()
  })

  it('the controller clamps members even when a caller passes foreign ids', async () => {
    await controller.getMetalWorkspaceUrl(WORKSPACE, ['A', 'B', 'C'], { anchorProjectId: 'A', readonlyProjectIds: ['C'] })
    await controller.getMetalWorkspaceUrl(WORKSPACE, ['B', 'C'])
    expect([...agent.members.get('ws:proj:A')!]).toEqual(['A'])
    expect([...agent.members.get(`ws:${WORKSPACE}`)!]).toEqual([])
    assertSingleHolder()
  })

  it('a Studio open of B racing a remote-tool call from A to B boots exactly one ws:proj:B', async () => {
    attachments.set('A', ['B'])
    await studioOpen('A')

    const [, outcome] = await Promise.all([
      studioOpen('B'),
      callProjectRemoteTool({} as any, 'B', WORKSPACE, { tool: 'read_file', args: { path: 'README.md' }, callerProjectId: 'A' }),
    ])

    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ ok: true, result: { content: 'hello' } })
    expect(agent.assigns.filter((k) => k === 'ws:proj:B')).toHaveLength(1)
    expect([...agent.members.get('ws:proj:B')!]).toEqual(['B'])
    expect(await registry.getPlacement('ws:proj:B')).toMatchObject({ hostId: 'dal-1' })

    expect(runtimeCalls).toHaveLength(1)
    expect(runtimeCalls[0].url).toBe('http://10.8.0.2:8080/ws%3Aproj%3AB/agent/remote/tool')
    expect(runtimeCalls[0].body).toEqual({ tool: 'read_file', args: { path: 'README.md' }, callerProjectId: 'A' })
    assertSingleHolder()
  })

  it('reports every runtime holding a project across live hosts', async () => {
    attachments.set('A', ['B'])
    await studioOpen('A')
    await studioOpen('B')
    const legacy = new Map([['ws:proj:C', new Set(['C', 'B'])]])
    otherHosts.set('10.8.0.3', fakeHolderHost('dal-2', legacy))
    controller.registerHost({ ...HOST, hostId: 'dal-2', meshIp: '10.8.0.3' })

    const holders = await controller.memberHolders('B')
    expect(holders.sort((a, b) => a.hostId.localeCompare(b.hostId))).toEqual([
      { hostId: 'dal-1', runtimeKey: 'ws:proj:B' },
      { hostId: 'dal-2', runtimeKey: 'ws:proj:C' },
    ])

    const drained = await controller.drainForeignMembers()
    expect(drained.sort((a, b) => a.hostId.localeCompare(b.hostId))).toEqual([
      { hostId: 'dal-1', ok: true, results: [] },
      { hostId: 'dal-2', ok: true, results: [{ runtimeKey: 'ws:proj:C', projectId: 'B', outcome: 'unmounted' }] },
    ])
    expect(await controller.memberHolders('B')).toEqual([{ hostId: 'dal-1', runtimeKey: 'ws:proj:B' }])
  })

  it('rejects a live mount of a foreign project and never reaches the host', async () => {
    await controller.getMetalWorkspaceUrl(WORKSPACE, [])
    await expect(controller.workspaceMember(WORKSPACE, 'mount', 'B', '/app/workspace/B')).rejects.toBeInstanceOf(
      ForeignMemberMountError,
    )
    expect(agent.memberCalls).toEqual([])
    assertSingleHolder()
  })
})
