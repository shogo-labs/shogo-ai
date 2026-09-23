// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test'
import { resolveProjectPodUrl } from '../resolve-pod-url'

const passthroughLease = <T>(_key: string, fn: () => Promise<T>) => fn()

describe('resolveProjectPodUrl', () => {
  test('always resolves through the project-anchored workspace runtime', async () => {
    const result = await resolveProjectPodUrl('proj-1', {
      _loadAnchoredArgs: async () => ({
        workspaceId: 'ws-1',
        attachedProjectIds: ['proj-1', 'proj-2'],
        localFolders: [],
        readonlyProjectIds: ['proj-2'],
      }),
      _isKubernetes: () => true,
      _workspaceK8sResolver: async () => 'http://workspace-proj-proj-1.test',
      _spawnLease: passthroughLease,
    })

    expect(result).toEqual({
      mode: 'k8s',
      url: 'http://workspace-proj-proj-1.test',
    })
  })

  test('does not depend on the removed rollout flag', async () => {
    const result = await resolveProjectPodUrl('proj-2', {
      _loadAnchoredArgs: async () => ({
        workspaceId: 'ws-2',
        attachedProjectIds: ['proj-2'],
        localFolders: [],
        readonlyProjectIds: [],
      }),
      _isKubernetes: () => true,
      _workspaceK8sResolver: async () => 'http://workspace-proj-proj-2.test',
      _spawnLease: passthroughLease,
    })
    expect(result.url).toBe('http://workspace-proj-proj-2.test')
  })

  test('uses the project anchor host start seam', async () => {
    const runtime = {
      id: 'ws:proj:proj-3',
      port: 38300,
      agentPort: 39300,
      status: 'running' as const,
      url: 'http://127.0.0.1:38300',
      startedAt: Date.now(),
    }
    let anchor: string | undefined
    const result = await resolveProjectPodUrl('proj-3', {
      _loadAnchoredArgs: async () => ({
        workspaceId: 'ws-3',
        attachedProjectIds: ['proj-3'],
        localFolders: [],
        readonlyProjectIds: [],
      }),
      _isKubernetes: () => false,
      _isMetalEnabled: () => false,
      _hostStartProject: async (anchorProjectId) => {
        anchor = anchorProjectId
        return runtime
      },
    })

    expect(anchor).toBe('proj-3')
    expect(result).toEqual({
      mode: 'host',
      url: 'http://127.0.0.1:39300',
      runtime,
    })
  })

  test('rejects projects without workspace spawn options', async () => {
    await expect(resolveProjectPodUrl('legacy-project', {
      _loadAnchoredArgs: async () => null,
    })).rejects.toThrow(/workspace-runtime is the only supported/)
  })
})
