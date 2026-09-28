// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// RuntimeManager.startWorkspace() — workspace (merged-root) runtime spawn.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deriveWebhookToken } from '../lib/runtime-token'

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

const { RuntimeManager, workspaceRuntimeKey, projectWorkspaceRuntimeKey, upsertMountGitignore } = await import(
  '../lib/runtime/manager'
)

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

type ProjectInfo = {
  workingMode?: 'managed' | 'external'
  runtimeEnabled?: boolean
  folders?: { path: string; isPrimary: boolean }[]
}

function makeManager(opts: { agentStatus?: any; agentThrows?: Error; projectInfo?: Record<string, ProjectInfo> } = {}) {
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
  // Mirrors the real method's external branch: a folder-linked project's
  // directory IS its primary folder, and nothing is seeded.
  rm.ensureProjectDirectory = mock(async (id: string, _techStackId?: string, external?: { primaryPath: string }) => {
    if (external?.primaryPath) return external.primaryPath
    const d = join(workspacesDir, id)
    mkdirSync(d, { recursive: true })
    return d
  })
  rm.getProjectInfo = mock(async (id: string) => opts.projectInfo?.[id] ?? { workingMode: 'managed' })
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

  // Regression: WorkerRuntimeManager.buildEnv() defaults the spawned
  // process's PROJECT_ID env var to whatever registry key it was called
  // with — which for this path is `ensureRunning(projectWorkspaceRuntimeKey(...))`,
  // i.e. `ws:proj:<anchor>`, not a real project id. Every internal API call
  // the runtime makes with `projectId: process.env.PROJECT_ID` (cost
  // metrics, heartbeat sync, checkpoints, ...) 401s against
  // `resolveProjectWorkspaceId()` unless `extraEnv.PROJECT_ID` explicitly
  // overrides it back to the bare anchor id. See manager.ts's
  // `doStartMergedRuntime` for the full explanation.
  test('overrides PROJECT_ID to the bare anchor id, not the ws:proj: registry key', async () => {
    const { rm } = makeManager()
    await rm.startProjectWorkspace('anchor-1', {
      workspaceId: 'ws-1',
      attachedProjectIds: ['p2'],
    })
    const spawnConfig = rm.agentManager.ensureRunning.mock.calls[0][1]
    expect(spawnConfig.extraEnv.PROJECT_ID).toBe('anchor-1')
    expect(spawnConfig.extraEnv.PROJECT_ID).not.toBe(projectWorkspaceRuntimeKey('anchor-1'))
  })

  test('ships a WEBHOOK_TOKEN the API can authenticate refresh-trust pings with', async () => {
    const { rm } = makeManager()
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
    const spawnConfig = rm.agentManager.ensureRunning.mock.calls[0][1]
    expect(spawnConfig.extraEnv.WEBHOOK_TOKEN).toBe(deriveWebhookToken('anchor-1'))
  })
})

/** The real directory a link resolves to, compared the way the filesystem does. */
function realOf(p: string): string {
  const real = realpathSync(p)
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
}

function makeUserFolder(workspacesDir: string, name = 'alignment-project-server'): string {
  const folder = join(workspacesDir, '..', name)
  mkdirSync(join(folder, 'agents'), { recursive: true })
  writeFileSync(join(folder, 'app.py'), 'app = 1\n')
  return folder
}

describe('RuntimeManager merged root for folder-linked projects', () => {
  function externalInfo(folder: string, runtimeEnabled = false): ProjectInfo {
    return { workingMode: 'external', runtimeEnabled, folders: [{ path: folder, isPrimary: true }] }
  }

  test("mounts the anchor at the user's folder without seeding a managed template", async () => {
    const { rm, workspacesDir } = makeManager()
    const own = makeUserFolder(workspacesDir)
    rm.getProjectInfo = mock(async () => externalInfo(own))

    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1', localFolders: [own] })

    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    expect(realOf(join(mergedRoot, 'anchor-1'))).toBe(realOf(own))
    expect(existsSync(join(mergedRoot, 'anchor-1', 'app.py'))).toBe(true)
    // No template dir, and the primary folder is not mounted a second time by basename.
    expect(existsSync(join(workspacesDir, 'anchor-1'))).toBe(false)
    expect(existsSync(join(mergedRoot, 'alignment-project-server'))).toBe(false)
    expect(rm.ensureProjectDirectory.mock.calls[0]).toEqual(['anchor-1', undefined, { primaryPath: own }])

    const env = rm.agentManager.ensureRunning.mock.calls[0][1].extraEnv
    expect(JSON.parse(env.WORKSPACE_MOUNTS)).toEqual([
      { mount: 'anchor-1', path: resolve(own), projectId: 'anchor-1', kind: 'external', runtimeEnabled: false },
    ])
    expect(env.RUNTIME_ENABLED).toBe('false')
    expect(JSON.parse(env.LINKED_FOLDERS)).toEqual([resolve(own)])
    // The merged root itself stays a Shogo-owned (managed) workspace.
    expect(env.WORKING_MODE).toBe('managed')
    // The user's repo is kept out of the merged root's checkpoint repo.
    expect(readFileSync(join(mergedRoot, '.gitignore'), 'utf8')).toContain('\n/anchor-1\n')
  })

  test('passes RUNTIME_ENABLED through when the user opted the folder into preview', async () => {
    const { rm, workspacesDir } = makeManager()
    const folder = makeUserFolder(workspacesDir)
    rm.getProjectInfo = mock(async () => externalInfo(folder, true))
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
    expect(rm.agentManager.ensureRunning.mock.calls[0][1].extraEnv.RUNTIME_ENABLED).toBe('true')
  })

  test('self-heals a merged root built by an earlier build (template mount + basename link)', async () => {
    const { rm, workspacesDir } = makeManager()
    const folder = makeUserFolder(workspacesDir)
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    const template = join(workspacesDir, 'anchor-1')
    mkdirSync(join(template, 'src'), { recursive: true })
    mkdirSync(mergedRoot, { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(template, join(mergedRoot, 'anchor-1'), linkType)
    symlinkSync(folder, join(mergedRoot, 'alignment-project-server'), linkType)
    rm.getProjectInfo = mock(async () => externalInfo(folder))

    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1', localFolders: [folder] })

    expect(realOf(join(mergedRoot, 'anchor-1'))).toBe(realOf(folder))
    expect(existsSync(join(mergedRoot, 'alignment-project-server'))).toBe(false)
    // The old template dir is left alone: it may hold edits made under 2.0.
    expect(existsSync(join(template, 'src'))).toBe(true)
  })

  test('skips a folder-linked member whose folder is gone instead of seeding a template', async () => {
    const { rm, workspacesDir } = makeManager()
    const missing = join(workspacesDir, '..', 'deleted-folder')
    rm.getProjectInfo = mock(async () => externalInfo(missing))
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    expect(existsSync(join(mergedRoot, 'anchor-1'))).toBe(false)
    expect(existsSync(join(workspacesDir, 'anchor-1'))).toBe(false)
  })

  test('extra linked folders of a managed anchor are mounted by basename and git-ignored', async () => {
    const { rm, workspacesDir } = makeManager()
    const folder = makeUserFolder(workspacesDir, 'shared-lib')
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1', localFolders: [folder] })
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    const env = rm.agentManager.ensureRunning.mock.calls[0][1].extraEnv
    expect(JSON.parse(env.WORKSPACE_MOUNTS).map((m: any) => [m.mount, m.kind, m.projectId])).toEqual([
      ['anchor-1', 'managed', 'anchor-1'],
      ['shared-lib', 'folder', 'anchor-1'],
    ])
    expect(env.RUNTIME_ENABLED).toBeUndefined()
    const gitignore = readFileSync(join(mergedRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('/shared-lib')
    expect(gitignore).not.toContain('/anchor-1')
  })
})

describe('RuntimeManager merged-root refresh on warm reuse', () => {
  const linkIdentity = (p: string) => {
    const st = lstatSync(p)
    return `${st.ino}:${st.birthtimeMs}`
  }

  test('leaves links that already point at their target untouched', async () => {
    const { rm, workspacesDir } = makeManager()
    const folder = makeUserFolder(workspacesDir, 'shared-lib')
    const opts = { workspaceId: 'ws-1', localFolders: [folder] }
    await rm.startProjectWorkspace('anchor-1', opts)
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    const before = [linkIdentity(join(mergedRoot, 'anchor-1')), linkIdentity(join(mergedRoot, 'shared-lib'))]

    await new Promise((r) => setTimeout(r, 50))
    await rm.startProjectWorkspace('anchor-1', opts) // warm reuse → refresh
    await Promise.all(Array.from({ length: 10 }, () => rm.startProjectWorkspace('anchor-1', opts)))

    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(1)
    expect([linkIdentity(join(mergedRoot, 'anchor-1')), linkIdentity(join(mergedRoot, 'shared-lib'))]).toEqual(before)
  })

  test('re-points a link whose target changed', async () => {
    const { rm, workspacesDir } = makeManager()
    const first = makeUserFolder(workspacesDir, 'first')
    const second = makeUserFolder(workspacesDir, 'second')
    rm.getProjectInfo = mock(async () => ({ workingMode: 'external', folders: [{ path: first, isPrimary: true }] }))
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
    rm.getProjectInfo = mock(async () => ({ workingMode: 'external', folders: [{ path: second, isPrimary: true }] }))
    await rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
    const mergedRoot = join(workspacesDir, '.workspace-roots', 'proj-anchor-1')
    expect(realOf(join(mergedRoot, 'anchor-1'))).toBe(realOf(second))
  })
})

describe('RuntimeManager stale agent-runtime after worker teardown', () => {
  const key = projectWorkspaceRuntimeKey('anchor-1')
  const open = (rm: any) => rm.startProjectWorkspace('anchor-1', { workspaceId: 'ws-1' })
  const flush = () => new Promise((r) => setTimeout(r, 0))

  test('wires onRuntimeGone into the embedded worker', () => {
    const rm = new RuntimeManager({}) as any
    expect(typeof rm.agentManager.opts.onRuntimeGone).toBe('function')
  })

  test('respawns instead of reusing when the worker no longer has the runtime (idle-evicted)', async () => {
    const { rm } = makeManager()
    await open(rm)
    rm.agentManager.status = mock(() => null)

    await open(rm)

    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(2)
    expect(rm.agentManager.stop.mock.calls.length).toBe(0)
    expect(rm.status(key)?.status).toBe('running')
  })

  test('respawns when the worker reports a different port than the cached one', async () => {
    const { rm } = makeManager()
    await open(rm)
    rm.agentManager.status = mock(() => ({ status: 'running', agentPort: 39999 }))

    await open(rm)

    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(2)
  })

  test('does not stop a breaker-tripped worker slot when dropping the stale entry', async () => {
    const { rm } = makeManager()
    await open(rm)
    rm.agentManager.status = mock(() => ({ status: 'failed', agentPort: 0 }))

    await open(rm)

    expect(rm.agentManager.stop.mock.calls.length).toBe(0)
    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(2)
  })

  test('keeps reusing while the worker restarts the runtime on the same port', async () => {
    const { rm } = makeManager()
    await open(rm)
    rm.agentManager.status = mock(() => ({ status: 'restarting', agentPort: 38100 }))

    await open(rm)

    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(1)
  })

  test('startWorkspace also respawns a stale runtime', async () => {
    const { rm } = makeManager()
    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })
    rm.agentManager.status = mock(() => null)

    await rm.startWorkspace('ws-1', { attachedProjectIds: [] })

    expect(rm.agentManager.ensureRunning.mock.calls.length).toBe(2)
  })

  test('onRuntimeGone drops the cached runtime so status() stops advertising the dead port', async () => {
    const { rm } = makeManager()
    await open(rm)

    rm.handleAgentRuntimeGone(key, { reason: 'idle-evict' })
    await flush()

    expect(rm.status(key)).toBeNull()
    expect(rm.agentManager.stop.mock.calls.length).toBe(0)
  })

  test('onRuntimeGone during an API-initiated stop is ignored (no re-entry)', async () => {
    const { rm } = makeManager()
    await open(rm)
    rm.agentManager.stop = mock(async (k: string) => rm.handleAgentRuntimeGone(k, { reason: 'stop' }))

    await rm.stop(key)
    await flush()

    expect(rm.agentManager.stop.mock.calls.length).toBe(1)
    expect(rm.status(key)).toBeNull()
  })

  test('onRuntimeGone for an unknown key is a no-op', () => {
    const { rm } = makeManager()
    expect(() => rm.handleAgentRuntimeGone('ws:proj:nope', { reason: 'exited', code: 0 })).not.toThrow()
  })
})

describe('upsertMountGitignore', () => {
  test('keeps user content, replaces the managed block, and removes it when empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-gitignore-'))
    dirs.push(dir)
    const file = join(dir, '.gitignore')
    writeFileSync(file, 'node_modules\n')
    upsertMountGitignore(dir, ['a', 'b'])
    upsertMountGitignore(dir, ['b'])
    expect(readFileSync(file, 'utf8')).toBe(
      'node_modules\n# >>> shogo workspace mounts (managed) >>>\n/b\n# <<< shogo workspace mounts (managed) <<<\n',
    )
    upsertMountGitignore(dir, [])
    expect(readFileSync(file, 'utf8')).toBe('node_modules\n')
  })
})
