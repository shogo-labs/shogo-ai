// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'
import {
  resolveWorkspaceRuntimeUrl,
} from '../resolve-workspace-runtime-url'

function enabled() {
  return true
}

// Cloud branches wrap the resolver in the cross-replica spawn lease, which
// hits Postgres. Unit tests of branch logic inject a passthrough lease (the
// lease itself is tested in workspace-spawn-lease.test.ts).
const passthroughLease = <T>(_id: string, fn: () => Promise<T>) => fn()

describe('resolveWorkspaceRuntimeUrl', () => {
  it('resolves workspace runtimes even when the retired flag is off', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1'],
      _isEnabled: () => false,
      _isKubernetes: () => false,
      _isMetalEnabled: () => false,
      _hostStart: async () => ({
        projectId: 'ws-1',
        port: 37000,
        agentPort: 38000,
        status: 'running' as const,
        url: 'http://localhost:37000',
        startedAt: Date.now(),
      }),
    })
    expect(res).toMatchObject({ mode: 'host', url: 'http://localhost:38000' })
  })

  it('allows personal workspaces through when the global flag is off', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-personal', {
      attachedProjectIds: [],
      workspaceKind: 'personal',
      _isEnabled: () => false,
      _isKubernetes: () => false,
      _isMetalEnabled: () => false,
      _hostStart: async () => ({
        projectId: 'ws-personal',
        port: 37000,
        agentPort: 38000,
        status: 'running' as const,
        url: 'http://localhost:37000',
        startedAt: Date.now(),
      }),
    })
    expect(res).toMatchObject({ mode: 'host', url: 'http://localhost:38000' })
  })

  it('routes K8s when isKubernetes()', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1', 'p2'],
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _k8sResolver: async (wsId, ids) => `http://ws.example/${wsId}/${ids.join('+')}`,
    })
    expect(res).toEqual({ mode: 'k8s', url: 'http://ws.example/ws-1/p1+p2' })
  })

  it('k8s + anchor resolves and forwards anchorProjectId, leasing on the anchor', async () => {
    const leaseCalls: string[] = []
    let seenAnchor: string | undefined
    let seenReadonly: string[] | undefined
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['anchor', 'p2'],
      anchorProjectId: 'anchor',
      readonlyProjectIds: ['p2'],
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _spawnLease: (id, fn) => {
        leaseCalls.push(id)
        return fn()
      },
      _k8sResolver: async (_ws, _ids, o) => {
        seenAnchor = o?.anchorProjectId
        seenReadonly = o?.readonlyProjectIds
        return 'http://workspace-proj-anchor.svc'
      },
    })
    expect(res).toEqual({ mode: 'k8s', url: 'http://workspace-proj-anchor.svc' })
    // Anchored runtimes lease on the anchor id, not the workspace id.
    expect(leaseCalls).toEqual(['proj:anchor'])
    expect(seenAnchor).toBe('anchor')
    expect(seenReadonly).toEqual(['p2'])
  })

  it('wraps the cloud (k8s) resolver in the spawn lease but NOT host mode', async () => {
    const leaseCalls: string[] = []
    const observingLease = <T>(id: string, fn: () => Promise<T>) => {
      leaseCalls.push(id)
      return fn()
    }
    // k8s → lease engaged
    await resolveWorkspaceRuntimeUrl('ws-cloud', {
      attachedProjectIds: ['p1'],
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _spawnLease: observingLease,
      _k8sResolver: async () => 'http://ws.cloud',
    })
    expect(leaseCalls).toEqual(['ws-cloud'])

    // host → lease NOT engaged (single-process / SQLite)
    await resolveWorkspaceRuntimeUrl('ws-host', {
      attachedProjectIds: ['p1'],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _spawnLease: observingLease,
      _hostStart: async () => ({
        projectId: 'ws-host',
        port: 37000,
        agentPort: 38000,
        status: 'running' as const,
        url: 'http://localhost:37000',
        startedAt: Date.now(),
      }),
    })
    expect(leaseCalls).toEqual(['ws-cloud']) // unchanged — host took no lease
  })

  it('routes host and builds url from runtime.agentPort', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1'],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _hostStart: async () => ({
        projectId: 'ws-1',
        port: 37500,
        agentPort: 38500,
        status: 'running' as const,
        url: 'http://localhost:37500',
        startedAt: Date.now(),
      }),
    })
    expect(res.mode).toBe('host')
    expect(res.url).toBe('http://localhost:38500')
    expect((res as any).runtime).toBeDefined()
  })

  it('falls back to port+1000 when agentPort is missing', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: [],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _hostStart: async () => ({
        projectId: 'ws-1',
        port: 37000,
        agentPort: undefined,
        status: 'running' as const,
        url: 'http://localhost:37000',
        startedAt: Date.now(),
      }),
    })
    expect(res.url).toBe('http://localhost:38000')
  })

  it('default host path delegates to runtimeManager.startWorkspace', async () => {
    let receivedWs = ''
    let receivedIds: string[] = []
    const fakeManager: any = {
      startWorkspace: async (wsId: string, o: { attachedProjectIds: string[] }) => {
        receivedWs = wsId
        receivedIds = o.attachedProjectIds
        return {
          projectId: `ws:${wsId}`,
          port: 37700,
          agentPort: 38700,
          status: 'running' as const,
          url: 'http://localhost:37700',
          startedAt: Date.now(),
        }
      },
    }
    const res = await resolveWorkspaceRuntimeUrl('ws-9', {
      attachedProjectIds: ['p1', 'p2'],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      runtimeManager: fakeManager,
    })
    expect(res.mode).toBe('host')
    expect(res.url).toBe('http://localhost:38700')
    expect(receivedWs).toBe('ws-9')
    expect(receivedIds).toEqual(['p1', 'p2'])
  })

  it('default host path errors clearly when the manager lacks startWorkspace', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('ws-1', {
        attachedProjectIds: [],
        _isEnabled: enabled,
        _isKubernetes: () => false,
        runtimeManager: {} as any,
      }),
    ).rejects.toThrow(/no startWorkspace/)
  })

  it('k8s branch wires the default Knative workspace driver when no resolver injected', async () => {
    // The default _k8sResolver lazy-imports knative-workspace-manager's
    // getWorkspacePodUrl. Stub the module so we exercise the wiring without
    // pulling @kubernetes/client-node.
    const seen: { ws?: string; ids?: string[] } = {}
    mock.module('../knative-workspace-manager', () => ({
      getWorkspacePodUrl: async (ws: string, ids: string[]) => {
        seen.ws = ws
        seen.ids = ids
        return `http://workspace-${ws}.shogo-workspaces.svc.cluster.local`
      },
    }))
    const res = await resolveWorkspaceRuntimeUrl('ws-default', {
      attachedProjectIds: ['p1', 'p2'],
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
    })
    expect(res).toEqual({
      mode: 'k8s',
      url: 'http://workspace-ws-default.shogo-workspaces.svc.cluster.local',
    })
    expect(seen.ws).toBe('ws-default')
    expect(seen.ids).toEqual(['p1', 'p2'])
  })

  it('requires a workspaceId', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('', { attachedProjectIds: [], _isEnabled: enabled }),
    ).rejects.toThrow(/workspaceId is required/)
  })

  it('routes metal (over k8s) when metal is enabled and a resolver is injected', async () => {
    let sawK8s = false
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1', 'p2'],
      _isEnabled: enabled,
      _isMetalEnabled: () => true,
      _isKubernetes: () => true, // metal must take precedence, NOT build a ksvc
      _spawnLease: passthroughLease,
      _k8sResolver: async () => {
        sawK8s = true
        return 'http://should-not-be-used'
      },
      _metalResolver: async (wsId, ids) => `http://metal-ws/${wsId}/${ids.join('+')}`,
    })
    expect(res).toEqual({ mode: 'metal', url: 'http://metal-ws/ws-1/p1+p2' })
    expect(sawK8s).toBe(false)
  })

  it('metal branch forwards anchor + readonly and leases on the anchor', async () => {
    const leaseCalls: string[] = []
    let seenAnchor: string | undefined
    let seenReadonly: string[] | undefined
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['anchor', 'p2'],
      anchorProjectId: 'anchor',
      readonlyProjectIds: ['p2'],
      _isEnabled: enabled,
      _isMetalEnabled: () => true,
      _isKubernetes: () => true,
      _spawnLease: <T>(id: string, fn: () => Promise<T>) => {
        leaseCalls.push(id)
        return fn()
      },
      _metalResolver: async (wsId, _ids, o) => {
        seenAnchor = o?.anchorProjectId
        seenReadonly = o?.readonlyProjectIds
        return `http://metal-ws/${wsId}`
      },
    })
    expect(res.mode).toBe('metal')
    expect(seenAnchor).toBe('anchor')
    expect(seenReadonly).toEqual(['p2'])
    expect(leaseCalls).toEqual(['proj:anchor'])
  })

  // Regression coverage for the persistent "Project Ready" placeholder
  // (staging, 2026-09-22, project a0bea431-... and its 27 workspace
  // siblings): `resolveAnchorSpawnOpts` (runtime/manager.ts) only returns
  // the anchor's OTHER attachments in `attachedProjectIds` — never the
  // anchor itself — so an anchor with no other attachments (the common
  // case) previously produced a member list that omitted it entirely. The
  // guest's `getWorkspacePreviewManager()` treats "not an attached member"
  // as "don't start this project's preview", permanently serving the
  // placeholder even though the runtime was otherwise healthy.
  it('metal branch includes the anchor in the member list even when it has no other attachments', async () => {
    let seenIds: string[] | undefined
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: [],
      anchorProjectId: 'anchor',
      _isEnabled: enabled,
      _isMetalEnabled: () => true,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _metalResolver: async (_wsId, ids) => {
        seenIds = ids
        return 'http://metal-ws/anchor'
      },
    })
    expect(res.mode).toBe('metal')
    expect(seenIds).toEqual(['anchor'])
  })

  it('k8s branch includes the anchor in the member list even when it has no other attachments', async () => {
    let seenIds: string[] | undefined
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: [],
      anchorProjectId: 'anchor',
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _k8sResolver: async (_wsId, ids) => {
        seenIds = ids
        return 'http://workspace-proj-anchor.svc'
      },
    })
    expect(res.mode).toBe('k8s')
    expect(seenIds).toEqual(['anchor'])
  })

  it('does not duplicate the anchor when it is already present in attachedProjectIds', async () => {
    let seenIds: string[] | undefined
    await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['anchor', 'p2'],
      anchorProjectId: 'anchor',
      _isEnabled: enabled,
      _isMetalEnabled: () => true,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _metalResolver: async (_wsId, ids) => {
        seenIds = ids
        return 'http://metal-ws/anchor'
      },
    })
    expect(seenIds).toEqual(['anchor', 'p2'])
  })

  it('host + anchor path also receives the anchor-inclusive member list', async () => {
    let seenIds: string[] | undefined
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: [],
      anchorProjectId: 'anchor',
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _hostStartProject: async (anchorProjectId, opts) => {
        seenIds = opts.attachedProjectIds
        return {
          projectId: `ws:proj:${anchorProjectId}`,
          port: 37000,
          agentPort: 38000,
          status: 'running' as const,
          url: 'http://localhost:37000',
          startedAt: Date.now(),
        }
      },
    })
    expect(res.mode).toBe('host')
    expect(seenIds).toEqual(['anchor'])
  })

  it('metal branch throws not-configured when no resolver injected (never silent Knative fallthrough)', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('ws-1', {
        attachedProjectIds: ['p1'],
        _isEnabled: enabled,
        _isMetalEnabled: () => true,
        _isKubernetes: () => true,
      }),
    ).rejects.toThrow(/metal workspace runtime driver not configured/)
  })
})
