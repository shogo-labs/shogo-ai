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
  buildWorkspaceEnv: async (
    workspaceId: string,
    attachedProjectIds: string[],
    opts?: { anchorProjectId?: string },
  ) => ({
    WORKSPACE_ID: workspaceId,
    WORKSPACE_PROJECT_IDS: attachedProjectIds.join(','),
    ...(opts?.anchorProjectId ? { WORKSPACE_ANCHOR_PROJECT_ID: opts.anchorProjectId } : {}),
    AGENT_NAME: 'Test WS',
  }),
}))

const { RuntimeManager, workspaceRuntimeKey, projectWorkspaceRuntimeKey } = await import('../lib/runtime/manager')

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
  // Hermetic seeding: create the member project dir without the real
  // template-copy + `bun install` so the merged-root symlinks resolve.
  rm.ensureProjectDirectory = mock(async (id: string) => {
    const d = join(workspacesDir, id)
    mkdirSync(d, { recursive: true })
    return d
  })
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
  test('spawns a workspace runtime rooted at the per-workspace merged root', async () => {
    const { rm, workspacesDir } = makeManager()
    const res = await rm.startWorkspace('ws-1', { attachedProjectIds: ['p1', 'p2'] })

    expect(res.status).toBe('running')
    expect(res.url).toBe('http://localhost:38100')

    const call = rm.agentManager.ensureRunning.mock.calls[0]
    expect(call[0]).toBe(workspaceRuntimeKey('ws-1')) // key = ws:ws-1
    const spawnConfig = call[1]
    // projectDir is now the per-workspace merged root (symlinks to the
    // attached projects), NOT the shared workspaces parent.
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'ws-1')
    expect(spawnConfig.projectDir).toBe(mergedRoot)
    expect(spawnConfig.workspaceId).toBe('ws-1')
    expect(spawnConfig.extraEnv.WORKSPACE_RUNTIME).toBe('true')
    expect(spawnConfig.extraEnv.WORKING_MODE).toBe('managed')
    expect(spawnConfig.extraEnv.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
    // The merged root holds one symlink per attached project, and the real
    // dirs are shipped as LINKED_FOLDERS for path-allowance.
    expect(existsSync(join(mergedRoot, 'p1'))).toBe(true)
    expect(existsSync(join(mergedRoot, 'p2'))).toBe(true)
    const linked = JSON.parse(spawnConfig.extraEnv.LINKED_FOLDERS)
    expect(linked).toContain(join(workspacesDir, 'p1'))
    expect(linked).toContain(join(workspacesDir, 'p2'))
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

describe('RuntimeManager.startProjectWorkspace (anchor-keyed merged root)', () => {
  test('keys the runtime by the anchor project (ws:proj:<anchor>)', async () => {
    const { rm } = makeManager()
    await rm.startProjectWorkspace('anchor-1', {
      workspaceId: 'ws-1',
      attachedProjectIds: ['p2'],
    })
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('anchor-1'))).toBe(true)
    // Distinct from both the plain project key and the workspace-session key.
    expect(rm.runtimes.has('anchor-1')).toBe(false)
    expect(rm.runtimes.has('ws:ws-1')).toBe(false)
  })

  test('mounts the anchor first plus its attachments as subfolders', async () => {
    const { rm, workspacesDir } = makeManager()
    await rm.startProjectWorkspace('anchor-1', {
      workspaceId: 'ws-1',
      attachedProjectIds: ['anchor-1', 'p2'], // anchor duplicated → deduped
    })
    const call = rm.agentManager.ensureRunning.mock.calls[0]
    expect(call[0]).toBe(projectWorkspaceRuntimeKey('anchor-1'))
    const spawnConfig = call[1]
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    expect(spawnConfig.projectDir).toBe(mergedRoot)
    expect(existsSync(join(mergedRoot, 'anchor-1'))).toBe(true)
    expect(existsSync(join(mergedRoot, 'p2'))).toBe(true)
    expect(spawnConfig.extraEnv.WORKSPACE_ANCHOR_PROJECT_ID).toBe('anchor-1')
    expect(spawnConfig.extraEnv.WORKSPACE_PROJECT_IDS).toBe('anchor-1,p2')
  })

  test('symlinks linked local folders by basename and ships them as LINKED_FOLDERS', async () => {
    const { rm, workspacesDir } = makeManager()
    const localFolder = join(workspacesDir, '..', 'my-local-folder')
    mkdirSync(localFolder, { recursive: true })
    await rm.startProjectWorkspace('anchor-1', {
      workspaceId: 'ws-1',
      attachedProjectIds: [],
      localFolders: [localFolder],
    })
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    expect(existsSync(join(mergedRoot, 'my-local-folder'))).toBe(true)
    const spawnConfig = rm.agentManager.ensureRunning.mock.calls[0][1]
    const linked = JSON.parse(spawnConfig.extraEnv.LINKED_FOLDERS)
    expect(linked.some((p: string) => p.endsWith('my-local-folder'))).toBe(true)
  })

  test('emits READONLY_ROOTS for read-only attachments', async () => {
    const { rm, workspacesDir } = makeManager()
    await rm.startProjectWorkspace('anchor-1', {
      workspaceId: 'ws-1',
      attachedProjectIds: ['p2', 'p3'],
      readonlyProjectIds: ['p3'],
    })
    const spawnConfig = rm.agentManager.ensureRunning.mock.calls[0][1]
    const readonly = JSON.parse(spawnConfig.extraEnv.READONLY_ROOTS)
    expect(readonly).toEqual([join(workspacesDir, 'p3')])
    // The anchor + read-write attachment are NOT read-only.
    expect(readonly).not.toContain(join(workspacesDir, 'anchor-1'))
    expect(readonly).not.toContain(join(workspacesDir, 'p2'))
  })

  test('requires an anchorProjectId and a workspaceId', async () => {
    const { rm } = makeManager()
    await expect(rm.startProjectWorkspace('', { workspaceId: 'ws-1' })).rejects.toThrow(/anchorProjectId is required/)
    await expect(rm.startProjectWorkspace('anchor-1', { workspaceId: '' })).rejects.toThrow(/workspaceId is required/)
  })
})
