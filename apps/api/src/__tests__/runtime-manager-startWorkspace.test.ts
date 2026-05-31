// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// RuntimeManager.startWorkspace() — workspace (merged-root) runtime spawn.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stub the workspace env builder so the spawn path never touches the DB.
mock.module('../lib/runtime/build-workspace-env', () => ({
  buildWorkspaceEnv: async (workspaceId: string, attachedProjectIds: string[]) => ({
    WORKSPACE_ID: workspaceId,
    WORKSPACE_PROJECT_IDS: attachedProjectIds.join(','),
    AGENT_NAME: 'Test WS',
  }),
}))

const { RuntimeManager, workspaceRuntimeKey } = await import('../lib/runtime/manager')

let dirs: string[] = []
const origEnv = { ...process.env }

beforeEach(() => {
  dirs = []
  process.env.AI_PROXY_SECRET = 'test-proxy-secret-fixed-test-only'
})

afterEach(() => {
  process.env = { ...origEnv }
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
})

function makeManager(opts: { agentStatus?: any; agentThrows?: Error } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rm-ws-'))
  dirs.push(root)
  const workspacesDir = join(root, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  const runtimeServerPath = join(root, 'runtime-server.ts')
  writeFileSync(runtimeServerPath, 'export {}\n')
  process.env.AGENT_RUNTIME_ENTRY = runtimeServerPath

  const rm = new RuntimeManager({ workspacesDir }) as any
  rm.allocatePortAsync = mock(async () => 37100)
  rm.buildUrl = (_id: string, port: number) => `http://localhost:${port}`
  rm.startHealthCheck = mock(() => {})
  rm.agentManager = {
    ensureRunning: mock(async () => {
      if (opts.agentThrows) throw opts.agentThrows
      return opts.agentStatus ?? { status: 'running', agentPort: 38100 }
    }),
    stop: mock(async () => {}),
    status: mock(() => ({ status: 'running', agentPort: 38100 })),
    touch: mock(() => {}),
  }
  return { rm, workspacesDir }
}

describe('RuntimeManager.startWorkspace', () => {
  test('spawns a workspace runtime rooted at the workspaces parent', async () => {
    const { rm, workspacesDir } = makeManager()
    const res = await rm.startWorkspace('ws-1', { attachedProjectIds: ['p1', 'p2'] })

    expect(res.status).toBe('running')
    expect(res.url).toBe('http://localhost:38100')

    const call = rm.agentManager.ensureRunning.mock.calls[0]
    expect(call[0]).toBe(workspaceRuntimeKey('ws-1')) // key = ws:ws-1
    const spawnConfig = call[1]
    expect(spawnConfig.projectDir).toBe(workspacesDir)
    expect(spawnConfig.workspaceId).toBe('ws-1')
    expect(spawnConfig.extraEnv.WORKSPACE_RUNTIME).toBe('true')
    expect(spawnConfig.extraEnv.WORKING_MODE).toBe('managed')
    expect(spawnConfig.extraEnv.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
  })

  test('keys the runtime under ws:<id> (no collision with a project of same id)', async () => {
    const { rm } = makeManager()
    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })
    expect(rm.runtimes.has('ws:ws-1')).toBe(true)
    expect(rm.runtimes.has('ws-1')).toBe(false)
  })

  test('short-circuits when already running', async () => {
    const { rm } = makeManager()
    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })
    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })
    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(1)
  })

  test('dedupes concurrent starts', async () => {
    const { rm } = makeManager()
    const [a, b] = await Promise.all([
      rm.startWorkspace('ws-1', { attachedProjectIds: [] }),
      rm.startWorkspace('ws-1', { attachedProjectIds: [] }),
    ])
    expect(a.port).toBe(b.port)
    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(1)
  })

  test('throws when the agent returns no port', async () => {
    const { rm } = makeManager({ agentStatus: { status: 'error', agentPort: 0, lastError: 'boom' } })
    await expect(rm.startWorkspace('ws-1', { attachedProjectIds: [] })).rejects.toThrow(/no port/)
  })

  test('requires a workspaceId', async () => {
    const { rm } = makeManager()
    await expect(rm.startWorkspace('', { attachedProjectIds: [] })).rejects.toThrow(/workspaceId is required/)
  })

  test('workspaceStatus reflects the running runtime; stopWorkspace tears it down', async () => {
    const { rm } = makeManager()
    expect(rm.workspaceStatus('ws-1')).toBeNull()

    await rm.startWorkspace('ws-1', { attachedProjectIds: ['p1'] })
    const status = rm.workspaceStatus('ws-1')
    expect(status).not.toBeNull()
    expect(status.status).toBe('running')

    await rm.stopWorkspace('ws-1')
    expect(rm.workspaceStatus('ws-1')).toBeNull()
    expect(rm.runtimes.has('ws:ws-1')).toBe(false)
    expect(rm.agentManager.stop.mock.calls.length).toBe(1)
  })

  test('stopWorkspace is idempotent when nothing is running', async () => {
    const { rm } = makeManager()
    await rm.stopWorkspace('ws-unknown') // must not throw
    expect(rm.workspaceStatus('ws-unknown')).toBeNull()
  })

  test('stopAll tears down workspace runtimes too', async () => {
    const { rm } = makeManager()
    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })
    expect(rm.runtimes.has('ws:ws-1')).toBe(true)
    await rm.stopAll()
    expect(rm.runtimes.size).toBe(0)
  })
})
