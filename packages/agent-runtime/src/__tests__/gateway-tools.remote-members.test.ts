// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Remote workspace members (metal). A remote member lives only in its own
 * project's runtime; the workspace agent's file tools and `exec` with a
 * `projectId` reach into that runtime through the API instead of a copy.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createMemberTool, createTools, type ToolContext } from '../gateway-tools'
import { initWorkspaceMembers } from '../workspace-members'
import { CommandRegistry } from '../command-registry'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-remote-members'
const ENV_KEYS = [
  'WORKSPACE_RUNTIME',
  'WORKSPACE_ID',
  'WORKSPACE_DIR',
  'WORKSPACE_PROJECT_IDS',
  'WORKSPACE_REMOTE_PROJECT_IDS',
  'WORKSPACE_READONLY_PROJECT_IDS',
  'WORKSPACE_ANCHOR_PROJECT_ID',
  'WORKSPACE_AVAILABLE_PROJECTS',
  'SHOGO_API_URL',
] as const

type Call = { method: string; path: string; body?: any }

function makeCtx(): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'ws-1',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    commandRegistry: new CommandRegistry(),
  }
}

function tool(ctx: ToolContext, name: string) {
  const t = createTools(ctx).find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  return (await tool(ctx, name).execute('call', params)).details as any
}

const remoteResult = (details: Record<string, unknown>) => ({
  result: { content: [{ type: 'text', text: JSON.stringify(details) }], details },
})

/** Fake API: records calls and answers the member-tool proxy and member routes. */
function fakeApi(calls: Call[]) {
  globalThis.fetch = mock(async (url: any, init: any) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: u.pathname, body })
    const tool = /\/members\/[^/]+\/tools\/([^/]+)$/.exec(u.pathname)?.[1]
    if (method === 'POST' && tool === 'exec') return Response.json(remoteResult({ run_id: 'cmd_1', exitCode: 0 }))
    if (method === 'POST' && tool === 'exec_wait') return Response.json(remoteResult({ run_id: 'cmd_1', status: 'done' }))
    if (method === 'POST' && tool === 'exec_list') {
      return Response.json(remoteResult({ processes: [{ runId: 'cmd_1', command: 'bun dev' }] }))
    }
    if (method === 'POST' && tool) return Response.json(remoteResult({ ok: true, tool }))
    if (method === 'POST' && u.pathname.endsWith('/members')) {
      return Response.json({ ok: true, previewUrl: `https://${body.projectId}.preview.test` })
    }
    return Response.json({ ok: true })
  }) as any
}

describe('remote workspace members', () => {
  const realFetch = globalThis.fetch
  const prevEnv: Record<string, string | undefined> = {}
  let calls: Call[]

  beforeEach(() => {
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key]
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_DIR, 'local'), { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-1'
    process.env.WORKSPACE_DIR = TEST_DIR
    process.env.WORKSPACE_PROJECT_IDS = 'local'
    process.env.WORKSPACE_REMOTE_PROJECT_IDS = 'site,ro'
    process.env.WORKSPACE_READONLY_PROJECT_IDS = 'ro'
    process.env.SHOGO_API_URL = 'http://api.test'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.WORKSPACE_AVAILABLE_PROJECTS
    initWorkspaceMembers()
    calls = []
    fakeApi(calls)
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key]
      else process.env[key] = prevEnv[key]
    }
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterAll(() => clearTrustForTests())

  const toolPath = (projectId: string, name: string) =>
    `/api/internal/workspaces/ws-1/sessions/sess-1/members/${projectId}/tools/${name}`

  describe('exec projectId', () => {
    test('is offered only in the workspace agent runtime', () => {
      const props = (name: string) => Object.keys((tool(makeCtx(), name).parameters as any).properties)
      expect(props('exec')).toContain('projectId')
      expect(props('exec_list')).toContain('projectId')

      process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'site'
      expect(props('exec')).not.toContain('projectId')
      expect(props('exec_list')).not.toContain('projectId')
      expect(tool(makeCtx(), 'exec').description).not.toContain('projectId')
    })

    test('runs the command in the project runtime and tags the run id with the project', async () => {
      const result = await run(makeCtx(), 'exec', { command: 'bun test', timeout: 5000, projectId: 'site' })
      expect(calls).toEqual([
        { method: 'POST', path: toolPath('site', 'exec'), body: expect.objectContaining({ params: { command: 'bun test', timeout: 5000 } }) },
      ])
      expect(result.run_id).toBe('p:site:cmd_1')
      expect(result.projectId).toBe('site')
    })

    test('exec_wait sends a tagged run id back to its project', async () => {
      const result = await run(makeCtx(), 'exec_wait', { run_id: 'p:site:cmd_1', timeout_ms: 1000 })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.path).toBe(toolPath('site', 'exec_wait'))
      expect(calls[0]!.body.params).toEqual({ run_id: 'cmd_1', timeout_ms: 1000 })
      expect(result.run_id).toBe('p:site:cmd_1')
    })

    test('exec_list with projectId lists the project runs, tagged', async () => {
      const result = await run(makeCtx(), 'exec_list', { projectId: 'site' })
      expect(calls[0]!.path).toBe(toolPath('site', 'exec_list'))
      expect(result.processes).toEqual([{ runId: 'p:site:cmd_1', command: 'bun dev' }])
    })

    test('refuses read-only, local, and unmounted projects without calling the API', async () => {
      const ctx = makeCtx()
      expect((await run(ctx, 'exec', { command: 'ls', projectId: 'ro' })).error).toContain('read-only')
      expect((await run(ctx, 'exec', { command: 'ls', projectId: 'local' })).error).toContain('without projectId')
      expect((await run(ctx, 'exec', { command: 'ls', projectId: 'nope' })).error).toContain('mount_project')
      expect(calls).toEqual([])
    })

    test('unmounting a project ends this session shell there first', async () => {
      const ctx = makeCtx()
      await run(ctx, 'exec', { command: 'bun dev', projectId: 'site' })
      calls.length = 0
      await run(ctx, 'unmount_project', { projectId: 'site' })
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `DELETE ${toolPath('site', 'session')}`,
        'DELETE /api/internal/workspaces/ws-1/sessions/sess-1/members/site',
      ])
    })
  })

  describe('file tools', () => {
    test('a path inside a remote member runs in its runtime', async () => {
      const result = await run(makeCtx(), 'read_file', { path: 'site/src/app.ts' })
      expect(calls[0]!.path).toBe(toolPath('site', 'read_file'))
      expect(calls[0]!.body.params).toEqual({ path: 'site/src/app.ts' })
      expect(result).toEqual({ ok: true, tool: 'read_file' })
    })

    test('a read-only remote member can be read but not changed', async () => {
      const ctx = makeCtx()
      expect((await run(ctx, 'read_file', { path: 'ro/README.md' })).tool).toBe('read_file')
      expect((await run(ctx, 'write_file', { path: 'ro/x.txt', content: 'x' })).error).toContain('read-only')
      expect((await run(ctx, 'edit_file', { path: 'ro/x.txt', old_string: 'a', new_string: 'b' })).error).toContain(
        'read-only',
      )
      expect(calls).toHaveLength(1)
    })

    test('other paths stay local', async () => {
      await run(makeCtx(), 'write_file', { path: 'local/notes.txt', content: 'hello' })
      expect(readFileSync(join(TEST_DIR, 'local', 'notes.txt'), 'utf8')).toBe('hello')
      expect(calls).toEqual([])
    })
  })

  test('the manifest tells the agent how to reach mounted projects', () => {
    const manifest = readFileSync(join(TEST_DIR, 'WORKSPACE.md'), 'utf8')
    expect(manifest).toContain('Mounted projects are live')
    expect(manifest).toContain('with `projectId: "<id>"`')
  })

  test('preview_project returns the project runtime preview URL', async () => {
    const result = await run(makeCtx(), 'preview_project', { projectId: 'site' })
    expect(result.url).toBe('https://site.preview.test')
    expect(calls.map((c) => c.path)).toEqual(['/api/internal/workspaces/ws-1/sessions/sess-1/members'])
  })
})

describe('one copy of a remote member', () => {
  const realFetch = globalThis.fetch
  const prevEnv: Record<string, string | undefined> = {}
  const projectRoot = '/tmp/test-gw-remote-project-root'

  beforeEach(() => {
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key]
    for (const d of [TEST_DIR, projectRoot]) {
      rmSync(d, { recursive: true, force: true })
      mkdirSync(d, { recursive: true })
      trustWorkspaceForTests(d)
    }
    mkdirSync(join(projectRoot, 'site'), { recursive: true })
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-1'
    process.env.WORKSPACE_DIR = TEST_DIR
    process.env.WORKSPACE_PROJECT_IDS = ''
    process.env.WORKSPACE_REMOTE_PROJECT_IDS = 'site'
    process.env.WORKSPACE_READONLY_PROJECT_IDS = ''
    process.env.SHOGO_API_URL = 'http://api.test'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    initWorkspaceMembers()
    // The API and the project's runtime endpoint, collapsed: run the member
    // tool against the project runtime's merged root.
    const projectCtx = { ...makeCtx(), workspaceDir: projectRoot }
    globalThis.fetch = mock(async (url: any, init: any) => {
      const name = /\/members\/site\/tools\/([^/]+)$/.exec(new URL(String(url)).pathname)?.[1]
      if (!name) return Response.json({ ok: true })
      const { params } = JSON.parse(init.body)
      return Response.json({ result: await createMemberTool(name, projectCtx)!.execute('call', params) })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key]
      else process.env[key] = prevEnv[key]
    }
    rmSync(TEST_DIR, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  test("the workspace agent's writes land in the project runtime, and it reads the project's own edits", async () => {
    const ctx = makeCtx()
    await run(ctx, 'write_file', { path: 'site/notes.md', content: 'from workspace agent\n' })
    expect(readFileSync(join(projectRoot, 'site', 'notes.md'), 'utf8')).toBe('from workspace agent\n')
    expect(existsSync(join(TEST_DIR, 'site'))).toBe(false)

    writeFileSync(join(projectRoot, 'site', 'notes.md'), 'edited by project agent\n')
    await run(ctx, 'edit_file', {
      path: 'site/notes.md',
      old_string: 'edited by project agent',
      new_string: 'edited by both',
    })
    expect(readFileSync(join(projectRoot, 'site', 'notes.md'), 'utf8')).toBe('edited by both\n')
  })
})

describe('member tool endpoint builder', () => {
  const dir = '/tmp/test-gw-member-tool'
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    trustWorkspaceForTests(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('builds only allowlisted tools, and they act on this runtime', async () => {
    const ctx = { ...makeCtx(), workspaceDir: dir }
    expect(createMemberTool('delete_file', ctx)).toBeNull()
    expect(createMemberTool('mount_project', ctx)).toBeNull()
    writeFileSync(join(dir, 'a.txt'), 'one')
    const edit = createMemberTool('edit_file', ctx)!
    await edit.execute('call', { path: 'a.txt', old_string: 'one', new_string: 'two' })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two')
  })
})
