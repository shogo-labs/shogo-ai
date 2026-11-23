// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop resolver serving a workspace-targeted tunnel request (SHO-526).
 *
 * A workspace chat names no project, so the resolver has to find the workspace's
 * runtime itself — in the `ws:<id>` slot or in the project-anchored
 * `ws:proj:<anchor>` one (SHO-107), never in whichever runtime happens to be up.
 * Another workspace's runtime has no token for this one and answers 401.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const manager = {
  runningWorkspaceRuntime: mock((_workspaceId: string) => null as any),
  status: mock((_projectId: string) => null as any),
  getActiveProjects: mock(() => [] as string[]),
  start: mock(async (_projectId: string) => ({}) as any),
}

const started: string[] = []
const resolves: string[] = []
const resolveCalls: Array<{ workspaceId: string; attachedProjectIds: string[] }> = []
let startFails = false

mock.module('../runtime', () => ({ getRuntimeManager: () => manager }))
mock.module('../local-api-port', () => ({ resolveLocalApiPort: () => 8002 }))
mock.module('../cloud-key-wipe', () => ({ wipeCloudKey: async () => ({ wiped: true }) }))
mock.module('../machine-snapshot', () => ({ collectMachineSnapshot: async () => null }))
mock.module('../project-runtime-token', () => ({
  deriveProjectRuntimeToken: async (projectId: string) => `rt:${projectId}`,
}))
mock.module('../workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: (workspaceId: string) => `wrt:${workspaceId}`,
}))
mock.module('../resolve-workspace-runtime-url', () => ({
  resolveWorkspaceRuntimeUrl: async (workspaceId: string, opts: any) => {
    resolveCalls.push({ workspaceId, attachedProjectIds: opts.attachedProjectIds })
    if (startFails) throw new Error('spawn failed')
    return { mode: 'host', url: 'http://localhost:4200', runtime: {} }
  },
}))

const { _desktopResolver } = await import('../instance-tunnel')

beforeEach(() => {
  manager.runningWorkspaceRuntime.mockReset()
  manager.runningWorkspaceRuntime.mockImplementation(() => null)
  manager.status.mockReset()
  manager.status.mockImplementation(() => null)
  manager.getActiveProjects.mockReset()
  manager.getActiveProjects.mockImplementation(() => [])
  manager.start.mockReset()
  manager.start.mockImplementation(async (projectId: string) => {
    started.push(projectId)
    return {}
  })
  started.length = 0
  resolves.length = 0
  resolveCalls.length = 0
  startFails = false
})

describe('workspace target', () => {
  test('serves the workspace runtime that is up, keeping the path and query', async () => {
    manager.runningWorkspaceRuntime.mockImplementation((workspaceId: string) =>
      workspaceId === 'ws-1' ? { status: 'running', agentPort: 4100 } : null,
    )

    const url = await _desktopResolver.resolveLocalUrl(
      '/agent/workspace/download/shots/a.png?w=320',
      undefined,
      'ws-1',
    )

    expect(url).toBe('http://localhost:4100/agent/workspace/download/shots/a.png?w=320')
    expect(manager.runningWorkspaceRuntime).toHaveBeenCalledWith('ws-1')
  })

  test('asks for the anchored runtime too — the manager is what knows about ws:proj:<anchor>', async () => {
    // A workspace with an attached project is served by that project's anchored
    // runtime, so `workspaceStatus(id)` alone would answer "not running" forever.
    // This is that anchored runtime, reached through the same accessor.
    manager.runningWorkspaceRuntime.mockImplementation(() => ({ status: 'running', agentPort: 4101 }))

    const url = await _desktopResolver.resolveLocalUrl('/agent/status', undefined, 'ws-team')

    expect(url).toBe('http://localhost:4101/agent/status')
  })

  test('never falls back to an unrelated runtime, and reports RUNTIME_STARTING', async () => {
    // Some other project's runtime is up and warm; it must not be borrowed.
    manager.getActiveProjects.mockImplementation(() => ['other-project'])
    manager.status.mockImplementation(() => ({ status: 'running', agentPort: 4999 }))

    const url = await _desktopResolver.resolveLocalUrl('/agent/workspace/download/a.png', undefined, 'ws-1')

    expect(url).toBeNull()
    expect(manager.status).not.toHaveBeenCalledWith('other-project')
    expect(started).toEqual([])

    const rejection = await _desktopResolver.describeRejection!(
      '/agent/workspace/download/a.png',
      undefined,
      'ws-1',
    )
    expect(rejection).toMatchObject({ code: 'RUNTIME_STARTING' })
    expect(rejection.message).toContain('workspace ws-1')
  })

  test('starts the workspace runtime in the background, the same way the local route does', async () => {
    // A workspace the earlier tests have not asked about: the resolver asks for
    // one start per starting window, which is module state.
    const url = await _desktopResolver.resolveLocalUrl('/agent/status', undefined, 'ws-fresh')
    expect(url).toBeNull()

    // Fire-and-forget: the resolver must never await a spawn (SHO-185).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolveCalls).toEqual([{ workspaceId: 'ws-fresh', attachedProjectIds: [] }])
  })

  test('a failed background start does not throw into the request', async () => {
    startFails = true
    const url = await _desktopResolver.resolveLocalUrl('/agent/status', undefined, 'ws-fails')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(url).toBeNull()
  })

  test('non-agent paths still go to the local API', async () => {
    const url = await _desktopResolver.resolveLocalUrl('/api/workspaces/ws-1/projects', undefined, 'ws-1')
    expect(url).toBe('http://localhost:8002/api/workspaces/ws-1/projects')
  })

  test('mints the workspace runtime token', async () => {
    expect(await _desktopResolver.deriveWorkspaceRuntimeToken!('ws-1')).toBe('wrt:ws-1')
  })
})

describe('project target', () => {
  test('a project whose runtime is down answers RUNTIME_STARTING, not another project', async () => {
    manager.getActiveProjects.mockImplementation(() => ['other-project'])
    manager.status.mockImplementation((projectId: string) =>
      projectId === 'other-project' ? { status: 'running', agentPort: 4999 } : null,
    )

    const url = await _desktopResolver.resolveLocalUrl('/agent/status', 'p-1')
    expect(url).toBeNull()

    const rejection = await _desktopResolver.describeRejection!('/agent/status', 'p-1')
    expect(rejection).toMatchObject({ code: 'RUNTIME_STARTING' })
    expect(rejection.message).toContain('project p-1')
  })
})
