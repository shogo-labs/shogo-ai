// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-228: no process that runs project or third-party code may hold the
 * workspace runtime token (`wrt_v1_…`).
 *
 * A workspace runtime's own `RUNTIME_AUTH_SECRET` is valid for every project
 * in the workspace, and the API accepts it on the Git LFS routes only — so
 * anything user code started (an app server, a build, an MCP server) that
 * inherited it 401s on every SDK call. These tests pin the swap: the cwd
 * project's own `rt_v1_…` token, or no token at all.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildExecEnv, isWorkspaceToken } from '../sandbox-exec'
import {
  resolveProjectChildEnv,
  resolveProjectCredentialEnv,
  resolveProjectProcessEnv,
  withoutWorkspaceRuntimeToken,
  workspaceProjectForPath,
} from '../project-process-env'

const WORKSPACE_ID = 'ws-1'
const WORKSPACE_TOKEN = `wrt_v1_${WORKSPACE_ID}_workspacehmac`
const PROJECT_A_TOKEN = 'rt_v1_proj-a_projecthmac'
const PROJECT_B_TOKEN = 'rt_v1_proj-b_projecthmac'

const MOUNTS = JSON.stringify([
  { mount: 'proj-a', path: '/srv/workspaces/proj-a', projectId: 'proj-a', kind: 'managed' },
  { mount: 'proj-b', path: '/Users/russell/code/proj-b', projectId: 'proj-b', kind: 'external' },
  { mount: 'notes', path: '/Users/russell/notes', projectId: 'proj-a', kind: 'folder' },
])

const SAVED = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!SAVED.has(key)) SAVED.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function restoreEnv(): void {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  SAVED.clear()
}

/** Boot env of a workspace runtime (what the API's RuntimeManager spawns). */
function enterWorkspaceRuntime(workspaceDir: string): void {
  setEnv('WORKSPACE_RUNTIME', 'true')
  setEnv('WORKSPACE_ID', WORKSPACE_ID)
  setEnv('WORKSPACE_DIR', workspaceDir)
  setEnv('WORKSPACE_MOUNTS', MOUNTS)
  setEnv('WORKSPACE_ANCHOR_PROJECT_ID', 'proj-a')
  setEnv('PROJECT_ID', 'proj-a')
  setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
}

/** Boot env of a single-project runtime: its token already IS the project token. */
function enterSingleProjectRuntime(): void {
  setEnv('WORKSPACE_RUNTIME', undefined)
  setEnv('WORKSPACE_ID', undefined)
  setEnv('WORKSPACE_DIR', undefined)
  setEnv('WORKSPACE_MOUNTS', undefined)
  setEnv('WORKSPACE_ANCHOR_PROJECT_ID', undefined)
  setEnv('PROJECT_ID', 'proj-a')
  setEnv('RUNTIME_AUTH_SECRET', PROJECT_A_TOKEN)
}

const fetchTokens = async (projectId: string): Promise<string | null> => {
  if (projectId === 'proj-a') return PROJECT_A_TOKEN
  if (projectId === 'proj-b') return PROJECT_B_TOKEN
  return null
}

let root: string

beforeEach(() => {
  root = join(tmpdir(), `shogo-project-env-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  for (const dir of ['proj-a', 'proj-b', 'notes']) mkdirSync(join(root, dir), { recursive: true })
})

afterEach(() => {
  restoreEnv()
  rmSync(root, { recursive: true, force: true })
})

describe('workspaceProjectForPath', () => {
  test('maps a top-level mount (and its subdirectories) to its project', () => {
    enterWorkspaceRuntime(root)
    expect(workspaceProjectForPath(root, join(root, 'proj-a'))).toBe('proj-a')
    expect(workspaceProjectForPath(root, join(root, 'proj-a', 'src', 'deep'))).toBe('proj-a')
  })

  test('a folder-linked project and an extra host folder belong to their project', () => {
    enterWorkspaceRuntime(root)
    expect(workspaceProjectForPath(root, join(root, 'proj-b', 'app'))).toBe('proj-b')
    expect(workspaceProjectForPath(root, join(root, 'notes', 'today.md'))).toBe('proj-a')
  })

  test('the merged root itself and paths outside it have no project', () => {
    enterWorkspaceRuntime(root)
    expect(workspaceProjectForPath(root, root)).toBeNull()
    expect(workspaceProjectForPath(root, '/somewhere/else')).toBeNull()
    expect(workspaceProjectForPath(root, join(root, 'unmounted-dir'))).toBeNull()
  })

  test('a single-project runtime has no workspace mounts', () => {
    enterSingleProjectRuntime()
    expect(workspaceProjectForPath(root, join(root, 'proj-a'))).toBeNull()
  })
})

describe('resolveProjectCredentialEnv', () => {
  test('a workspace shell inside a project gets that project token, never the workspace one', async () => {
    enterWorkspaceRuntime(root)

    const a = await resolveProjectCredentialEnv({ workspaceDir: root, cwd: join(root, 'proj-a'), fetchToken: fetchTokens })
    expect(a.projectId).toBe('proj-a')
    expect(a.env).toEqual({ PROJECT_ID: 'proj-a', RUNTIME_AUTH_SECRET: PROJECT_A_TOKEN })
    expect(a.unset).toEqual(['RUNTIME_AUTH_SECRET'])

    const b = await resolveProjectCredentialEnv({ workspaceDir: root, cwd: join(root, 'proj-b'), fetchToken: fetchTokens })
    expect(b.env.RUNTIME_AUTH_SECRET).toBe(PROJECT_B_TOKEN)
  })

  test('at the workspace root there is no project and no token', async () => {
    enterWorkspaceRuntime(root)

    const creds = await resolveProjectCredentialEnv({ workspaceDir: root, cwd: root, fetchToken: fetchTokens })
    expect(creds.projectId).toBeNull()
    expect(creds.env.RUNTIME_AUTH_SECRET).toBeUndefined()
    expect(creds.unset).toContain('RUNTIME_AUTH_SECRET')
  })

  test('a project whose token cannot be fetched gets PROJECT_ID and no token', async () => {
    enterWorkspaceRuntime(root)

    const creds = await resolveProjectCredentialEnv({
      workspaceDir: root,
      cwd: join(root, 'proj-b'),
      fetchToken: async () => null,
    })
    expect(creds.env).toEqual({ PROJECT_ID: 'proj-b' })
    expect(creds.unset).toEqual(['RUNTIME_AUTH_SECRET'])
  })

  test('a single-project runtime is left alone', async () => {
    enterSingleProjectRuntime()

    const creds = await resolveProjectCredentialEnv({ workspaceDir: root, cwd: join(root, 'proj-a'), fetchToken: fetchTokens })
    expect(creds).toEqual({ projectId: null, env: {}, unset: [] })
  })
})

describe('resolveProjectChildEnv', () => {
  test('a project build/typecheck env carries the project token, not the workspace one', async () => {
    enterWorkspaceRuntime(root)

    const env = await resolveProjectChildEnv({ cwd: join(root, 'proj-b'), workspaceDir: root, fetchToken: fetchTokens })
    expect(env.PROJECT_ID).toBe('proj-b')
    expect(env.RUNTIME_AUTH_SECRET).toBe(PROJECT_B_TOKEN)
    expect(env.RUNTIME_AUTH_SECRET?.startsWith('wrt_v1_')).toBe(false)
  })

  test('at the merged root the workspace token is removed entirely', async () => {
    enterWorkspaceRuntime(root)

    const env = await resolveProjectChildEnv({ cwd: root, workspaceDir: root, fetchToken: fetchTokens })
    expect(env.RUNTIME_AUTH_SECRET).toBeUndefined()
  })

  test('a single-project runtime keeps its own token', async () => {
    enterSingleProjectRuntime()

    const env = await resolveProjectChildEnv({ cwd: root, workspaceDir: root, fetchToken: fetchTokens })
    expect(env.RUNTIME_AUTH_SECRET).toBe(PROJECT_A_TOKEN)
  })
})

describe('buildExecEnv', () => {
  test('an inherited workspace token never reaches the shell', () => {
    enterWorkspaceRuntime(root)

    const env = buildExecEnv(root)
    expect(env.RUNTIME_AUTH_SECRET).toBeUndefined()
  })

  test('unsetEnv clears the inherited value before extraEnv overlays the project token', () => {
    enterWorkspaceRuntime(root)

    const env = buildExecEnv(root, {
      unsetEnv: ['RUNTIME_AUTH_SECRET'],
      extraEnv: { PROJECT_ID: 'proj-a', RUNTIME_AUTH_SECRET: PROJECT_A_TOKEN },
    })
    expect(env.RUNTIME_AUTH_SECRET).toBe(PROJECT_A_TOKEN)
    expect(env.PROJECT_ID).toBe('proj-a')
  })

  test('a workspace token saved in the project .env is dropped too', () => {
    enterWorkspaceRuntime(root)
    writeFileSync(join(root, '.env'), `RUNTIME_AUTH_SECRET=${WORKSPACE_TOKEN}\n`)

    expect(buildExecEnv(root).RUNTIME_AUTH_SECRET).toBeUndefined()
  })

  test('a single-project runtime still hands its own token to the shell', () => {
    enterSingleProjectRuntime()

    expect(buildExecEnv(root).RUNTIME_AUTH_SECRET).toBe(PROJECT_A_TOKEN)
  })
})

describe('withoutWorkspaceRuntimeToken', () => {
  test('third-party (MCP) env loses the workspace token on a workspace runtime', () => {
    enterWorkspaceRuntime(root)

    const env = withoutWorkspaceRuntimeToken({ RUNTIME_AUTH_SECRET: WORKSPACE_TOKEN, PATH: '/usr/bin' })
    expect(env.RUNTIME_AUTH_SECRET).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  test('a single-project runtime keeps its own token', () => {
    enterSingleProjectRuntime()

    expect(withoutWorkspaceRuntimeToken({ RUNTIME_AUTH_SECRET: PROJECT_A_TOKEN }).RUNTIME_AUTH_SECRET).toBe(
      PROJECT_A_TOKEN,
    )
  })
})

describe('isWorkspaceToken', () => {
  test('distinguishes the two token kinds', () => {
    expect(isWorkspaceToken(WORKSPACE_TOKEN)).toBe(true)
    expect(isWorkspaceToken(PROJECT_A_TOKEN)).toBe(false)
    expect(isWorkspaceToken(undefined)).toBe(false)
  })
})

describe('resolveProjectProcessEnv', () => {
  test('workspace runtime: swaps the workspace token for the project token', () => {
    const env = resolveProjectProcessEnv({
      parentEnv: { WORKSPACE_RUNTIME: 'true', PROJECT_ID: 'proj-a', RUNTIME_AUTH_SECRET: WORKSPACE_TOKEN },
      projectId: 'proj-b',
      appRuntimeToken: PROJECT_B_TOKEN,
    })
    expect(env.PROJECT_ID).toBe('proj-b')
    expect(env.RUNTIME_AUTH_SECRET).toBe(PROJECT_B_TOKEN)
  })
})
