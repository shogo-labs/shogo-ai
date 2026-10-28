// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote tool channel (remote-tools.ts): a runtime runs file/shell tools
 * inside another project's own runtime instead of mounting a second
 * writable copy of it.
 *
 * The two-runtime suite runs project B as a real `server.ts` child process
 * (the module reads its env once at load, so two servers cannot share one
 * process) behind a stub API that forwards `/remote-tool` to B's
 * `/agent/remote/tool` with B's runtime token. Project A is the tool layer
 * in this process. Gated on RUN_INTEGRATION=1 like the other server suites.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { createTools, resetRemoteTargetCache, type ToolContext } from '../gateway-tools'
import {
  REMOTE_READONLY_TOOLS,
  REMOTE_TOOL_ALLOWLIST,
  RemoteToolError,
  callRemoteTool,
  executeRemoteTool,
  isMetalRuntime,
} from '../remote-tools'

const integration = process.env.RUN_INTEGRATION === '1'

const WORKSPACE_ID = 'ws-remote-test'
const PROJECT_A = 'proj-a'
const PROJECT_B = 'proj-b'
const TOKEN_B = 'tok-remote-b'
const GRAPH = [
  { id: PROJECT_A, name: 'Alpha', description: null, workingMode: 'managed', settings: {}, attachments: [], agent: null },
  { id: PROJECT_B, name: 'Beta', description: null, workingMode: 'managed', settings: {}, attachments: [], agent: null },
]

const ENV_KEYS = ['PROJECT_ID', 'WORKSPACE_ID', 'SHOGO_API_URL', 'WORKSPACE_ANCHOR_PROJECT_ID', 'WORKSPACE_RUNTIME', 'RUNTIME_AUTH_SECRET', 'SHOGO_RUNTIME_SUBSTRATE']

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function toolCtx(workspaceDir: string): ToolContext {
  return {
    workspaceDir,
    channels: new Map(),
    config: {} as any,
    projectId: PROJECT_A,
    workspaceId: WORKSPACE_ID,
  }
}

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

describe('remote tool routing (unit)', () => {
  test('every remotable tool gains an optional project param; others do not', () => {
    const tools = createTools(toolCtx('/tmp/remote-routing-unit'))
    for (const name of REMOTE_TOOL_ALLOWLIST) {
      const tool = tools.find((t) => t.name === name)
      if (!tool) continue // search is registered only with SHOGO_SEARCH_ENABLED
      const schema = tool.parameters as any
      expect(schema.properties.project?.type).toBe('string')
      expect(schema.required ?? []).not.toContain('project')
    }
    const exec = toolNamed(tools, 'exec').parameters as any
    expect(exec.required).toContain('command')
    expect((toolNamed(tools, 'project_call').parameters as any).properties.project.description).not.toContain('Omit for the current')
    expect(toolNamed(tools, 'connect_project')).toBeDefined()
    expect(REMOTE_READONLY_TOOLS.every((n) => (REMOTE_TOOL_ALLOWLIST as readonly string[]).includes(n))).toBe(true)
  })

  test('project omitted, or naming the current project, runs locally without calling the API', async () => {
    const saved = snapshotEnv()
    const originalFetch = globalThis.fetch
    const dir = mkdtempSync(join('/tmp', 'shogo-remote-unit-'))
    const calls: string[] = []
    try {
      process.env.PROJECT_ID = PROJECT_A
      process.env.WORKSPACE_ID = WORKSPACE_ID
      process.env.SHOGO_API_URL = 'http://api.test'
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      resetRemoteTargetCache()
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/projects/graph')) return Response.json({ projects: GRAPH })
        return Response.json({ ok: false, error: 'should not be called' }, { status: 500 })
      }) as typeof fetch

      const tools = createTools(toolCtx(dir))
      const write = toolNamed(tools, 'write_file')
      const read = toolNamed(tools, 'read_file')

      await write.execute('w1', { path: 'local.txt', content: 'omitted' })
      expect(readFileSync(join(dir, 'local.txt'), 'utf-8')).toBe('omitted')
      expect(calls).toEqual([])

      await write.execute('w2', { path: 'self.txt', content: 'self-by-id', project: PROJECT_A })
      expect(readFileSync(join(dir, 'self.txt'), 'utf-8')).toBe('self-by-id')
      expect(calls).toEqual([])

      const byName = await read.execute('r1', { path: 'self.txt', project: 'Alpha' })
      expect(JSON.stringify(byName.content)).toContain('self-by-id')
      expect(calls.every((url) => url.endsWith('/projects/graph'))).toBe(true)
      expect(calls.some((url) => url.includes('/remote-tool'))).toBe(false)

      const unknown = await read.execute('r2', { path: 'self.txt', project: 'Nope' })
      expect((unknown.details as any).code).toBe('not_found')
    } finally {
      globalThis.fetch = originalFetch
      restoreEnv(saved)
      resetRemoteTargetCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a remote file result says which project it ran in; a local result is unchanged', async () => {
    const saved = snapshotEnv()
    const originalFetch = globalThis.fetch
    const originalSearchFlag = process.env.SHOGO_SEARCH_ENABLED
    const dir = mkdtempSync(join('/tmp', 'shogo-remote-chatpath-'))
    const remoteDetails = { path: 'plans/x.md', bytes: 12 }
    try {
      process.env.PROJECT_ID = PROJECT_A
      process.env.WORKSPACE_ID = WORKSPACE_ID
      process.env.SHOGO_API_URL = 'http://api.test'
      process.env.SHOGO_SEARCH_ENABLED = '1'
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      resetRemoteTargetCache()
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/projects/graph')) return Response.json({ projects: GRAPH })
        if (url.includes('/remote-tool')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string }
          const details =
            body.tool === 'search'
              ? { query: 'plan', results: [{ path: 'plans/x.md', chunk: 'body', score: 0.9 }], count: 1 }
              : remoteDetails
          return Response.json({
            ok: true,
            result: { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details },
          })
        }
        return Response.json({ ok: false, error: 'unexpected call' }, { status: 500 })
      }) as typeof fetch

      const tools = createTools(toolCtx(dir))
      const write = toolNamed(tools, 'write_file')
      const search = toolNamed(tools, 'search')

      const remote = await write.execute('w1', { path: 'plans/x.md', content: 'x', project: 'Beta' })
      expect((remote.details as any).project).toEqual({ id: PROJECT_B, name: 'Beta' })
      expect((remote.details as any).chatPath).toBe(`${PROJECT_B}/plans/x.md`)
      // The model reads `content`, not `details`, so the path it quotes is there too.
      expect(JSON.stringify(remote.content)).toContain(`${PROJECT_B}/plans/x.md`)

      const hits = await search.execute('s1', { query: 'plan', project: PROJECT_B })
      expect((hits.details as any).project).toEqual({ id: PROJECT_B, name: 'Beta' })
      expect((hits.details as any).results[0].chatPath).toBe(`${PROJECT_B}/plans/x.md`)

      const local = await write.execute('w2', { path: 'local.md', content: 'y' })
      expect((local.details as any).project).toBeUndefined()
      expect((local.details as any).chatPath).toBeUndefined()
      expect(readFileSync(join(dir, 'local.md'), 'utf-8')).toBe('y')
    } finally {
      globalThis.fetch = originalFetch
      if (originalSearchFlag === undefined) delete process.env.SHOGO_SEARCH_ENABLED
      else process.env.SHOGO_SEARCH_ENABLED = originalSearchFlag
      restoreEnv(saved)
      resetRemoteTargetCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stopping the turn cancels an in-flight remote call', async () => {
    const saved = snapshotEnv()
    const originalFetch = globalThis.fetch
    try {
      process.env.PROJECT_ID = PROJECT_A
      process.env.WORKSPACE_ID = WORKSPACE_ID
      process.env.SHOGO_API_URL = 'http://api.test'
      delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      resetRemoteTargetCache()
      let remoteStarted!: () => void
      const started = new Promise<void>((resolve) => { remoteStarted = resolve })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/projects/graph')) return Response.json({ projects: GRAPH })
        remoteStarted()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }) as typeof fetch

      const exec = toolNamed(createTools(toolCtx('/tmp/remote-abort-unit')), 'exec')
      const turn = new AbortController()
      const pending = exec.execute('e1', { command: 'sleep 600', project: PROJECT_B }, turn.signal)
      await started
      turn.abort()
      const result = await pending
      expect(result.details).toMatchObject({ code: 'aborted', project: { id: PROJECT_B } })
    } finally {
      globalThis.fetch = originalFetch
      restoreEnv(saved)
      resetRemoteTargetCache()
    }
  })

  test('executeRemoteTool: 400 / 403 / 404 / strips project / 500', async () => {
    const seen: unknown[] = []
    const fake = (name: string, impl?: () => Promise<any>): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: {} as any,
      execute: async (_id, params) => {
        seen.push(params)
        return impl ? impl() : { content: [{ type: 'text', text: 'ok' }], details: { ok: true } }
      },
    })
    const tools = [fake('read_file'), fake('exec', async () => { throw new Error('boom') }), fake('agent_list')]

    expect((await executeRemoteTool(tools, null)).status).toBe(400)
    expect(await executeRemoteTool(tools, { tool: 'agent_list' })).toEqual({ status: 403, body: { ok: false, error: 'tool_not_remotable' } })
    expect(await executeRemoteTool(tools, { tool: 'mount_project' })).toEqual({ status: 403, body: { ok: false, error: 'tool_not_remotable' } })
    expect(await executeRemoteTool(tools, { tool: 'no_such_tool' })).toEqual({ status: 404, body: { ok: false, error: 'unknown_tool' } })
    expect(await executeRemoteTool(tools, { tool: 'write_file' })).toEqual({ status: 404, body: { ok: false, error: 'unknown_tool' } })

    const ok = await executeRemoteTool(tools, { tool: 'read_file', args: { path: 'a', project: 'elsewhere' }, callerProjectId: 'x' })
    expect(ok.status).toBe(200)
    expect(seen.at(-1)).toEqual({ path: 'a' })

    expect(await executeRemoteTool(tools, { tool: 'exec', args: { command: 'x' } })).toEqual({ status: 500, body: { ok: false, error: 'boom' } })
  })

  test('isMetalRuntime: explicit substrate wins, else host-mediated durability', () => {
    expect(isMetalRuntime({})).toBe(false)
    expect(isMetalRuntime({ SHOGO_DURABILITY_HOST_MEDIATED: '1' })).toBe(true)
    expect(isMetalRuntime({ SHOGO_RUNTIME_SUBSTRATE: 'metal' })).toBe(true)
    expect(isMetalRuntime({ SHOGO_RUNTIME_SUBSTRATE: 'k8s', SHOGO_DURABILITY_HOST_MEDIATED: '1' })).toBe(false)
  })
})

describe.skipIf(!integration)('remote tool channel across two runtimes', () => {
  const saved = snapshotEnv()
  let aDir = ''
  let bDir = ''
  let runtimeB: ReturnType<typeof Bun.spawn> | null = null
  let api: ReturnType<typeof Bun.serve> | null = null
  let bUrl = ''
  let tools: AgentTool[] = []
  const forwarded: Array<{ tool: string; status: number }> = []

  async function freePort(): Promise<number> {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = probe.port!
    probe.stop(true)
    return port
  }

  async function waitForRuntime(): Promise<void> {
    const deadline = Date.now() + 120_000
    let last = ''
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${bUrl}/agent/remote/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN_B },
          body: JSON.stringify({ tool: 'exec_list', args: {} }),
        })
        if (res.status === 200) return
        last = `HTTP ${res.status}`
      } catch (err: any) {
        last = err?.message ?? String(err)
      }
      await Bun.sleep(500)
    }
    throw new Error(`runtime B never became ready: ${last}`)
  }

  beforeAll(async () => {
    aDir = mkdtempSync(join('/tmp', 'shogo-remote-a-'))
    bDir = mkdtempSync(join('/tmp', 'shogo-remote-b-'))
    const bPort = await freePort()
    bUrl = `http://127.0.0.1:${bPort}`
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('WORKSPACE_') || k === 'PROJECT_ID') continue
      childEnv[k] = v
    }
    runtimeB = Bun.spawn([process.execPath, '--conditions=development', 'src/server.ts'], {
      cwd: resolve(import.meta.dir, '../..'),
      env: {
        ...childEnv,
        WORKSPACE_DIR: bDir,
        PORT: String(bPort),
        PROJECT_ID: PROJECT_B,
        WORKSPACE_ID,
        RUNTIME_AUTH_SECRET: TOKEN_B,
        SHOGO_API_URL: 'http://127.0.0.1:9',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    api = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        if (req.method === 'GET' && url.pathname === `/api/internal/workspaces/${WORKSPACE_ID}/projects/graph`) {
          return Response.json({ projects: GRAPH })
        }
        const m = url.pathname.match(/^\/api\/internal\/projects\/([^/]+)\/remote-tool$/)
        if (req.method === 'POST' && m) {
          if (m[1] !== PROJECT_B) return Response.json({ error: { code: 'not_found', message: 'Project not found' } }, { status: 404 })
          const body = (await req.json()) as { tool: string; args: Record<string, unknown> }
          const res = await fetch(`${bUrl}/agent/remote/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN_B },
            body: JSON.stringify({ ...body, callerProjectId: PROJECT_A }),
          })
          forwarded.push({ tool: body.tool, status: res.status })
          return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
        }
        const imp = url.pathname.match(/^\/api\/internal\/projects\/([^/]+)\/files\/import$/)
        if (req.method === 'POST' && imp) {
          if (imp[1] !== PROJECT_B) return Response.json({ error: { code: 'not_found', message: 'Project not found' } }, { status: 404 })
          const body = (await req.json()) as Record<string, unknown>
          const res = await fetch(`${bUrl}/agent/remote/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-runtime-token': TOKEN_B },
            body: JSON.stringify({ ...body, callerProjectId: PROJECT_A }),
          })
          forwarded.push({ tool: 'copy_to_project', status: res.status })
          return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } })
        }
        return Response.json({ error: { code: 'not_found', message: url.pathname } }, { status: 404 })
      },
    })

    process.env.PROJECT_ID = PROJECT_A
    process.env.WORKSPACE_ID = WORKSPACE_ID
    process.env.SHOGO_API_URL = `http://127.0.0.1:${api.port}`
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    // After B is spawned: A is the metal workspace agent (no anchor), the
    // only runtime that registers copy_to_project.
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'metal'
    resetRemoteTargetCache()
    tools = createTools(toolCtx(aDir))

    await waitForRuntime()
  }, 150_000)

  afterAll(async () => {
    runtimeB?.kill()
    await runtimeB?.exited
    api?.stop(true)
    restoreEnv(saved)
    resetRemoteTargetCache()
    if (aDir) rmSync(aDir, { recursive: true, force: true })
    if (bDir) rmSync(bDir, { recursive: true, force: true })
  })

  const run = (name: string, params: Record<string, unknown>) => toolNamed(tools, name).execute(`t-${name}`, params as any)
  const details = (r: { details: any }) => r.details

  test('write_file then read_file round-trips through B, by id and by name', async () => {
    const written = await run('write_file', { path: 'notes/remote.txt', content: 'hello from A\n', project: PROJECT_B })
    expect(details(written).error).toBeUndefined()
    const read = await run('read_file', { path: 'notes/remote.txt', project: 'Beta' })
    expect(JSON.stringify(read.content)).toContain('hello from A')
  })

  test('edit_file changes the file in B', async () => {
    const edited = await run('edit_file', {
      path: 'notes/remote.txt',
      old_string: 'hello from A',
      new_string: 'edited by A',
      project: PROJECT_B,
    })
    expect(details(edited).error).toBeUndefined()
    expect(readFileSync(join(bDir, 'notes/remote.txt'), 'utf-8')).toBe('edited by A\n')
  })

  test('exec runs in B and sees its files', async () => {
    const cat = await run('exec', { command: 'cat notes/remote.txt && ls notes', project: PROJECT_B })
    expect(details(cat).exitCode).toBe(0)
    expect(details(cat).stdout).toContain('edited by A')
    expect(details(cat).stdout).toContain('remote.txt')
    expect([bDir, realpathSync(bDir)]).toContain(details(cat).cwd)
  })

  test('files land only in B', () => {
    expect(existsSync(join(bDir, 'notes/remote.txt'))).toBe(true)
    expect(existsSync(join(aDir, 'notes'))).toBe(false)
    expect(existsSync(join(aDir, PROJECT_B))).toBe(false)
    expect(readdirSync(aDir).filter((f) => !f.startsWith('.'))).toEqual([])
  })

  test('exec soft timeout comes back running and exec_wait finishes it over the channel', async () => {
    const started = await run('exec', { command: 'sleep 1.5 && echo finished', timeout: 100, project: PROJECT_B })
    expect(details(started).status).toBe('running')
    const runId = details(started).run_id
    const listed = await run('exec_list', { project: PROJECT_B })
    expect(JSON.stringify(details(listed))).toContain(runId)
    const waited = await run('exec_wait', { run_id: runId, timeout_ms: 15_000, project: PROJECT_B })
    expect(details(waited).exitCode).toBe(0)
    expect(details(waited).stdout).toBe('finished')
  }, 30_000)

  test('delete_file removes the file in B (paths relative to files/)', async () => {
    await run('write_file', { path: 'files/doomed.txt', content: 'bye', project: PROJECT_B })
    expect(existsSync(join(bDir, 'files/doomed.txt'))).toBe(true)
    const deleted = await run('delete_file', { path: 'doomed.txt', project: PROJECT_B })
    expect(details(deleted).error).toBeUndefined()
    expect(existsSync(join(bDir, 'files/doomed.txt'))).toBe(false)
    expect(existsSync(join(aDir, 'files'))).toBe(false)
  })

  test('connect_project wakes B and lists the remotable tools', async () => {
    const connected = await run('connect_project', { project: 'Beta' })
    expect(details(connected)).toMatchObject({ ok: true, reachable: true, project: { id: PROJECT_B, name: 'Beta' } })
    expect((connected.content[0] as any).text).toContain('read_file')
  })

  test('copy_to_project ships a binary folder into B, readable there over the channel', async () => {
    // Dot-prefixed so the "files land only in B" check above ignores the source.
    mkdirSync(join(aDir, '.pack/cab2/img'), { recursive: true })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 7])
    writeFileSync(join(aDir, '.pack/cab2/img/hero.png'), png)
    writeFileSync(join(aDir, '.pack/cab2/data.json'), '{"cab":2}\n')

    const copied = await run('copy_to_project', { project: 'Beta', paths: ['.pack/cab2'], dest: 'public/assets' })
    expect(details(copied)).toMatchObject({ ok: true, project: { id: PROJECT_B }, fileCount: 2, dest: 'public/assets' })
    expect(forwarded.at(-1)).toEqual({ tool: 'copy_to_project', status: 200 })
    expect(readFileSync(join(bDir, 'public/assets/cab2/img/hero.png'))).toEqual(png)

    const read = await run('read_file', { path: 'public/assets/cab2/data.json', project: PROJECT_B })
    expect(JSON.stringify(read.content)).toContain('cab')

    const again = await run('copy_to_project', { project: PROJECT_B, paths: ['.pack/cab2'], dest: 'public/assets' })
    expect(details(again)).toMatchObject({ code: 'conflict', status: 409 })
    expect(details(again).conflicts).toContain('public/assets/cab2/data.json')
  })

  test('copy_to_project is never remotable', async () => {
    const err = await callRemoteTool(PROJECT_B, 'copy_to_project', { project: PROJECT_A, paths: ['.'] }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteToolError)
    expect(err.status).toBe(403)
    expect(err.code).toBe('tool_not_remotable')
  })

  test('the import route requires the runtime token', async () => {
    const res = await fetch(`${bUrl}/agent/remote/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archive: 'aGk=' }),
    })
    expect(res.status).toBe(401)
  })

  test('non-allow-listed tool is 403 tool_not_remotable', async () => {
    const err = await callRemoteTool(PROJECT_B, 'mount_project', { projectId: PROJECT_A }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteToolError)
    expect(err.status).toBe(403)
    expect(err.code).toBe('tool_not_remotable')
    expect(forwarded.at(-1)).toEqual({ tool: 'mount_project', status: 403 })
  })

  test('unknown tool is 404 unknown_tool', async () => {
    const err = await callRemoteTool(PROJECT_B, 'definitely_not_a_tool', {}).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteToolError)
    expect(err.status).toBe(404)
    expect(err.code).toBe('unknown_tool')
  })

  test('the runtime route requires the runtime token', async () => {
    const res = await fetch(`${bUrl}/agent/remote/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', args: { path: 'package.json' } }),
    })
    expect(res.status).toBe(401)
    const wrong = await fetch(`${bUrl}/agent/remote/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': 'nope' },
      body: JSON.stringify({ tool: 'read_file', args: { path: 'package.json' } }),
    })
    expect(wrong.status).toBe(401)
  })

  test('API-shaped errors are parsed, and unresolvable projects are tool errors', async () => {
    const err = await callRemoteTool('proj-unknown', 'read_file', { path: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteToolError)
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
    expect(err.message).toContain('Project not found')
    const missing = await run('read_file', { path: 'x', project: 'NoSuchProject' })
    expect(details(missing).code).toBe('not_found')
  })
})
