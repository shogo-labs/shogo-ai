// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  resolveWorkspaceRuntimeUrl,
  WorkspaceRuntimeNotEnabledError,
} from '../resolve-workspace-runtime-url'

function enabled() {
  return true
}

describe('resolveWorkspaceRuntimeUrl', () => {
  it('throws WorkspaceRuntimeNotEnabledError when the flag is off', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('ws-1', {
        attachedProjectIds: ['p1'],
        _isEnabled: () => false,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeNotEnabledError)
  })

  it('routes K8s when isKubernetes()', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1', 'p2'],
      _isEnabled: enabled,
      _isKubernetes: () => true,
      _isVMIsolation: () => false,
      _k8sResolver: async (wsId, ids) => `http://ws.example/${wsId}/${ids.join('+')}`,
    })
    expect(res).toEqual({ mode: 'k8s', url: 'http://ws.example/ws-1/p1+p2' })
  })

  it('routes VM when SHOGO_VM_ISOLATION and K8s is off', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1'],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _isVMIsolation: () => true,
      _vmResolver: async () => 'http://localhost:39300',
    })
    expect(res).toEqual({ mode: 'vm', url: 'http://localhost:39300' })
  })

  it('routes host and builds url from runtime.agentPort', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws-1', {
      attachedProjectIds: ['p1'],
      _isEnabled: enabled,
      _isKubernetes: () => false,
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
      _isVMIsolation: () => false,
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
        _isVMIsolation: () => false,
        runtimeManager: {} as any,
      }),
    ).rejects.toThrow(/no startWorkspace/)
  })

  it('production k8s branch throws not-implemented when no resolver injected', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('ws-1', {
        attachedProjectIds: ['p1'],
        _isEnabled: enabled,
        _isKubernetes: () => true,
        _isVMIsolation: () => false,
      }),
    ).rejects.toThrow(/k8s workspace runtime not implemented/)
  })

  it('requires a workspaceId', async () => {
    await expect(
      resolveWorkspaceRuntimeUrl('', { attachedProjectIds: [], _isEnabled: enabled }),
    ).rejects.toThrow(/workspaceId is required/)
  })
})
