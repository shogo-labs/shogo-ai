// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'

const anchoredArgs = {
  workspaceId: 'workspace-1',
  attachedProjectIds: ['project-1', 'project-2'],
  localFolders: ['/tmp/shared'],
  readonlyProjectIds: ['project-2'],
}

const runtime = {
  projectId: 'ws:proj:project-1',
  status: 'running',
  port: 8000,
  agentPort: 9000,
  url: 'http://127.0.0.1:8000',
} as any

function testOptions(overrides: Record<string, unknown> = {}) {
  const leaseKeys: string[] = []
  return {
    _loadAnchoredArgs: async () => anchoredArgs,
    _spawnLease: async (key: string, fn: () => Promise<unknown>) => {
      leaseKeys.push(key)
      return fn()
    },
    _isMetalEnabled: () => false,
    _isKubernetes: () => false,
    leaseKeys,
    ...overrides,
  }
}

describe('resolveProjectPodUrl — anchored workspace runtime', () => {
  test('always resolves through the anchored k8s workspace driver when enabled', async () => {
    const resolver = mock(async (
      workspaceId: string,
      projectIds: string[],
      options?: { anchorProjectId?: string; readonlyProjectIds?: string[] },
    ) => {
      expect(workspaceId).toBe('workspace-1')
      expect(projectIds).toEqual(['project-1', 'project-2'])
      expect(options).toEqual({
        anchorProjectId: 'project-1',
        readonlyProjectIds: ['project-2'],
      })
      return 'http://workspace.svc'
    })
    const opts = testOptions({
      _isKubernetes: () => true,
      _workspaceK8sResolver: resolver,
    })

    await expect(resolveProjectPodUrl('project-1', opts)).resolves.toEqual({
      mode: 'k8s',
      url: 'http://workspace.svc',
    })
    expect(opts.leaseKeys).toEqual(['proj:project-1'])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  test('uses the project anchor host start seam with the full workspace options', async () => {
    const startProject = mock(async (
      anchorProjectId: string,
      options: typeof anchoredArgs & { openAttemptId?: string },
    ) => {
      expect(anchorProjectId).toBe('project-1')
      expect(options).toEqual({
        ...anchoredArgs,
        openAttemptId: 'attempt-1',
      })
      return runtime
    })
    const opts = testOptions({
      openAttemptId: 'attempt-1',
      _hostStartProject: startProject,
    })

    await expect(resolveProjectPodUrl('project-1', opts)).resolves.toEqual({
      mode: 'host',
      url: 'http://127.0.0.1:9000',
      runtime,
    })
    expect(startProject).toHaveBeenCalledTimes(1)
    expect(opts.leaseKeys).toEqual([])
  })

  test('uses RuntimeManager.startProjectWorkspace in the default host path', async () => {
    const startProjectWorkspace = mock(async (
      anchorProjectId: string,
      options: Record<string, unknown>,
    ) => {
      expect(anchorProjectId).toBe('project-1')
      expect(options).toEqual({
        workspaceId: 'workspace-1',
        attachedProjectIds: ['project-1', 'project-2'],
        localFolders: ['/tmp/shared'],
        readonlyProjectIds: ['project-2'],
      })
      return runtime
    })
    const opts = testOptions({
      runtimeManager: { startProjectWorkspace },
    })

    const result = await resolveProjectPodUrl('project-1', opts)
    expect(result.mode).toBe('host')
    expect(result.url).toBe('http://127.0.0.1:9000')
    expect(startProjectWorkspace).toHaveBeenCalledTimes(1)
  })

  test('uses the anchored metal driver before the k8s driver', async () => {
    const metalResolver = mock(async (
      workspaceId: string,
      projectIds: string[],
      options?: { anchorProjectId?: string },
    ) => {
      expect(workspaceId).toBe('workspace-1')
      expect(projectIds).toEqual(['project-1', 'project-2'])
      expect(options).toEqual({ anchorProjectId: 'project-1', readonlyProjectIds: ['project-2'] })
      return 'http://metal-runtime'
    })
    const opts = testOptions({
      _isMetalEnabled: () => true,
      _workspaceMetalResolver: metalResolver,
      _isKubernetes: () => true,
    })

    await expect(resolveProjectPodUrl('project-1', opts)).resolves.toEqual({
      mode: 'metal',
      url: 'http://metal-runtime',
    })
    expect(opts.leaseKeys).toEqual(['proj:project-1'])
    expect(metalResolver).toHaveBeenCalledTimes(1)
  })

  test('does not depend on the retired workspace rollout flag', async () => {
    const opts = testOptions({
      _isKubernetes: () => true,
      _workspaceK8sResolver: async () => 'http://workspace.svc',
    })
    await expect(resolveProjectPodUrl('project-1', opts)).resolves.toMatchObject({
      mode: 'k8s',
    })
  })

  test('rejects projects without workspace spawn options', async () => {
    await expect(resolveProjectPodUrl('missing', {
      ...testOptions(),
      _loadAnchoredArgs: async () => null,
    })).rejects.toThrow('has no workspace spawn options')
  })
})
