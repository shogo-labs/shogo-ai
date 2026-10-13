// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration coverage for the workspace-agent tool failure fixes.
 *
 * The network boundary is a real HTTP server. Tools, path checks, the file
 * cache, git, the project archive, subagent merge, runtime auth, and the
 * Composio reconnect card all run as themselves.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const handlers = {
  toolkitsGet: async () => [],
  create: async () => ({ authorize: async () => ({ redirectUrl: 'https://oauth.example/reconnect' }) }),
  toolsExecute: async () => ({ successful: true, data: {} }),
  connectedAccountsList: async () => ({ items: [] }),
}
class FakeComposio {
  toolkits = { get: (...a: any[]) => handlers.toolkitsGet(...a) }
  tools = { execute: (...a: any[]) => handlers.toolsExecute(...a) }
  connectedAccounts = { list: (...a: any[]) => handlers.connectedAccountsList(...a) }
  create = (...a: any[]) => handlers.create(...a)
  constructor(_opts: any) {}
}
mock.module('../packages/agent-runtime/node_modules/@composio/core', () => ({ Composio: FakeComposio }))
mock.module('../packages/agent-runtime/src/composio-auto-bind', () => ({
  fetchComposioToolSchemas: async () => mockedSchemas,
}))

import { createTools, type ToolContext } from '../packages/agent-runtime/src/gateway-tools'
import { FileStateCache } from '../packages/agent-runtime/src/file-state-cache'
import { runSubagent } from '../packages/agent-runtime/src/subagent'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from '../packages/agent-runtime/src/__tests__/helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from '../packages/agent-runtime/src/__tests__/helpers/test-trust'
import { MCPClientManager } from '../packages/agent-runtime/src/mcp-client'
import { S3Sync } from '../packages/shared-runtime/src/s3-sync'
import { createRuntimeApp } from '../packages/shared-runtime/src/server-framework'
import { publishRequestTimeoutMs } from '../packages/shared-runtime/src/publish-timeouts'
import { initRepo, commit } from '../apps/api/src/services/git.service'
import { deriveWorkspaceRuntimeToken, verifyWorkspaceRuntimeToken } from '../apps/api/src/lib/workspace-runtime-token'
import { withIntegrationCredentials } from '../packages/agent-runtime/src/integration-credentials'
import { initComposioSession, registerToolkitProxyTools, resetComposioSession } from '../packages/agent-runtime/src/composio'

let mockedSchemas: any[] = []

type Hit = { method: string; url: string; body: any }
type Mode = 'share' | 'notify' | 'publish' | 'mount' | 'preview' | 'token'

const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
}

let server: Server
let origin = ''
let port = 0
const hits: Hit[] = []
let mode: Mode = 'share'
let mountAttempts = 0
let previewStarts = 0
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': type })
  res.end(payload)
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req)
    let body: any = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = { raw } }
    const url = req.url || ''
    hits.push({ method: req.method || 'GET', url, body })

    if (url.includes('/validate-runtime-token')) {
      const verified = verifyWorkspaceRuntimeToken(String(body.token || ''))
      if (!verified.ok) return send(res, 200, { valid: false, reason: verified.reason })
      return send(res, 200, { valid: true, workspaceId: verified.workspaceId, format: 'wrt_v1' })
    }

    if (mode === 'mount' && url.includes('/members') && req.method === 'POST') {
      mountAttempts++
      if (mountAttempts === 1) return send(res, 502, '<html><body>cloudflare</body></html>', 'text/html')
      return send(res, 200, { ok: true, mounted: true })
    }

    if (mode === 'preview' && url.includes('/preview/start')) {
      previewStarts++
      if (previewStarts === 1) return send(res, 404, { error: 'project_not_attached' })
      return send(res, 200, { ready: true })
    }
    if (mode === 'preview' && url.includes('/members') && req.method === 'POST') {
      mountAttempts++
      return send(res, 200, { ok: true, mounted: true })
    }

    if (url.includes('/shared-files') && req.method === 'POST') {
      return send(res, 200, { url: 'https://files.test/report', expiresAt: '2026-10-17T00:00:00.000Z', path: body.path })
    }
    if (url.includes('/publish') && req.method === 'GET') {
      return send(res, 200, { published: false, subdomain: null, publishedAt: null, accessLevel: null, hasPassword: false, publishStatus: null })
    }
    if (url.includes('/publish') && req.method === 'POST') {
      return send(res, 200, { url: 'https://demo.shogo.one', subdomain: body.subdomain, publishedAt: Date.now() })
    }
    if (url.includes('/reminders/notify') && req.method === 'POST') {
      return send(res, 200, { ok: true, delivered: true })
    }
    send(res, 404, { error: 'unhandled', url })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server failed to bind')
  port = address.port
  origin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  clearTrustForTests()
  restoreEnv()
  resetComposioSession()
})

beforeEach(() => {
  hits.length = 0
  mountAttempts = 0
  previewStarts = 0
  mode = 'share'
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function workspace(dir: string, projectId = 'ws:ws-int'): ToolContext {
  trustWorkspaceForTests(dir)
  const cache = new FileStateCache(dir)
  return {
    workspaceDir: dir,
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId,
    sessionId: 'sess-1',
    userId: 'user-1',
    workspaceId: 'ws-int',
    fileStateCache: cache,
    autoRouting: false,
  }
}

function tool(ctx: ToolContext, name: string) {
  const found = createTools(ctx).find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function armWorkspaceEnv(extra: Record<string, string | undefined> = {}) {
  setEnv('SHOGO_API_URL', origin)
  setEnv('RUNTIME_AUTH_SECRET', 'pod-secret')
  setEnv('WORKSPACE_RUNTIME', 'true')
  setEnv('WORKSPACE_ID', 'ws-int')
  setEnv('SANDBOX_EXEC_ENABLED', 'false')
  for (const [key, value] of Object.entries(extra)) setEnv(key, value)
}

describe('workspace tools talk to a real API with a real project id', () => {
  test('share_file and publish send the anchor id, never ws:', async () => {
    armWorkspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: 'proj-anchor', WORKSPACE_PROJECT_IDS: 'proj-anchor,proj-other' })
    const dir = tempDir('ws-tools-')
    writeFileSync(join(dir, 'report.pdf'), 'pdf')
    const ctx = workspace(dir)
    mode = 'share'
    const shared = await tool(ctx, 'share_file').execute('t', { path: 'report.pdf' })
    expect(shared.details.url).toBe('https://files.test/report')
    expect(hits.some((h) => h.url === '/api/internal/projects/proj-anchor/shared-files')).toBe(true)
    expect(hits.some((h) => h.url.includes('/projects/ws:'))).toBe(false)

    const timeouts: number[] = []
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = ((ms: number) => {
      timeouts.push(ms)
      return realTimeout(ms)
    }) as typeof AbortSignal.timeout
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof url === 'string' && url.includes('.shogo.one')) return new Response(null, { status: 204 })
      return realFetch(input, init)
    }) as typeof fetch
    try {
      mode = 'publish'
      hits.length = 0
      const published = await tool(ctx, 'publish').execute('t', { subdomain: 'demo' })
      expect(published.details.published).toBe(true)
      expect(published.details.url).toBe('https://demo.shogo.one')
      expect(hits.some((h) => h.method === 'POST' && h.url === '/api/internal/projects/proj-anchor/publish' && h.body.subdomain === 'demo')).toBe(true)
      expect(timeouts).toContain(publishRequestTimeoutMs())
    } finally {
      AbortSignal.timeout = realTimeout
      globalThis.fetch = realFetch
    }
  })

  test('notify_user omits projectId when the runtime id is ws:', async () => {
    armWorkspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: undefined, WORKSPACE_PROJECT_IDS: undefined })
    const dir = tempDir('ws-notify-')
    mode = 'notify'
    const result = await tool(workspace(dir), 'notify_user').execute('t', { title: 'Due', body: 'Stand up' })
    expect(result.details.delivered).toBe(true)
    const notify = hits.find((h) => h.url === '/api/internal/reminders/notify')
    expect(notify?.body.workspaceId).toBe('ws-int')
    expect(notify?.body.projectId).toBeUndefined()
    expect(notify?.body.title).toBe('Due')
  })

  test('share_file asks for project_id when several projects are attached', async () => {
    armWorkspaceEnv({
      WORKSPACE_ANCHOR_PROJECT_ID: undefined,
      WORKSPACE_PROJECT_IDS: 'proj-a,proj-b',
    })
    const dir = tempDir('ws-ask-')
    writeFileSync(join(dir, 'a.txt'), 'a')
    const result = await tool(workspace(dir), 'share_file').execute('t', { path: 'a.txt' })
    expect(result.details.error).toMatch(/project_id/)
    expect(hits.filter((h) => h.url.includes('/shared-files'))).toHaveLength(0)
  })
})

describe('mount and preview against the workspace API', () => {
  test('mount_project retries an HTML 502 and hides the proxy page', async () => {
    armWorkspaceEnv()
    const dir = tempDir('ws-mount-')
    mode = 'mount'
    const result = await tool(workspace(dir), 'mount_project').execute('t', { projectId: 'proj-anchor' })
    expect(result.details.mounted).toBe(true)
    expect(mountAttempts).toBe(2)
    expect(JSON.stringify(result.details)).not.toMatch(/cloudflare|<html/i)
  })

  test('preview_project mounts once after project_not_attached, then starts', async () => {
    armWorkspaceEnv()
    setEnv('PORT', String(port))
    const dir = tempDir('ws-preview-')
    mode = 'preview'
    const result = await tool(workspace(dir), 'preview_project').execute('t', { projectId: 'proj-anchor' })
    expect(previewStarts).toBe(2)
    expect(mountAttempts).toBe(1)
    expect(result.details.ready).toBe(true)
    expect(result.details.url).toBe(`http://localhost:${port}/p/proj-anchor/`)
  })
})

describe('edit and write on a real workspace', () => {
  test('a stale unique edit applies, and a non-unique one refreshes the cache', async () => {
    const dir = tempDir('ws-edit-')
    const ctx = workspace(dir, 'proj-anchor')
    writeFileSync(join(dir, 'note.txt'), 'alpha\nbeta\n')
    await tool(ctx, 'read_file').execute('t', { path: 'note.txt' })
    const bumped = new Date(Date.now() + 5_000)
    writeFileSync(join(dir, 'note.txt'), 'alpha\nbeta changed\n')
    // Force a new mtime so the stale guard actually runs.
    const { utimesSync } = await import('node:fs')
    utimesSync(join(dir, 'note.txt'), bumped, bumped)

    const applied = await tool(ctx, 'edit_file').execute('t', {
      path: 'note.txt',
      old_string: 'beta changed',
      new_string: 'beta done',
    })
    expect(applied.details.error).toBeUndefined()
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toContain('beta done')

    await tool(ctx, 'read_file').execute('t', { path: 'note.txt' })
    writeFileSync(join(dir, 'note.txt'), 'completely different\n')
    utimesSync(join(dir, 'note.txt'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
    const stale = await tool(ctx, 'edit_file').execute('t', {
      path: 'note.txt',
      old_string: 'beta done',
      new_string: 'nope',
    })
    expect(stale.details.error).toMatch(/modified since last read/)
    expect(stale.details.hint).toBeTruthy()
    expect(ctx.fileStateCache!.getRecord('note.txt')?.content).toContain('completely different')
  })

  test('exec re-stats tracked files so the next edit sees the command output', async () => {
    armWorkspaceEnv()
    const dir = tempDir('ws-exec-')
    const ctx = workspace(dir)
    writeFileSync(join(dir, 'note.txt'), 'before')
    await tool(ctx, 'read_file').execute('t', { path: 'note.txt' })
    expect(ctx.fileStateCache!.getRecord('note.txt')?.content).toBe('before')

    const ran = await tool(ctx, 'exec').execute('t', {
      command: `node -e "const fs=require('fs'); fs.writeFileSync('note.txt','after exec'); const t=new Date(Date.now()+8000); fs.utimesSync('note.txt', t, t)"`,
      timeout: 10_000,
    })
    expect(ran.details.exitCode).toBe(0)
    expect(ctx.fileStateCache!.getRecord('note.txt')?.content).toBeUndefined()
    expect(ctx.fileStateCache!.getRecord('note.txt')?.mtime).toBe(Math.floor(statSync(join(dir, 'note.txt')).mtimeMs))

    const edited = await tool(ctx, 'edit_file').execute('t', {
      path: 'note.txt',
      old_string: 'after exec',
      new_string: 'final',
    })
    expect(edited.details.error).toBeUndefined()
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('final')
  })

  test('a subagent edit stays on the parent cache after the clone is merged', async () => {
    const dir = tempDir('ws-sub-')
    const ctx = workspace(dir, 'proj-anchor')
    writeFileSync(join(dir, 'note.txt'), 'hello world')
    await tool(ctx, 'read_file').execute('t', { path: 'note.txt' })
    const before = ctx.fileStateCache!.getRecord('note.txt')!
    const streamFn = createMockStreamFn([
      buildToolUseResponse([{ name: 'edit_file', arguments: { path: 'note.txt', old_string: 'hello', new_string: 'goodbye' }, id: 'toolu_edit' }]),
      buildTextResponse('edited'),
    ])
    const result = await runSubagent(
      {
        name: 'scratch-editor',
        description: 'edits one file',
        systemPrompt: 'edit the file',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        toolNames: ['edit_file'],
        maxTurns: 3,
      },
      'change hello to goodbye',
      ctx,
      createTools(ctx),
      undefined,
      { streamFn },
    )
    expect(result.responseText).toContain('edited')
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toContain('goodbye')
    const after = ctx.fileStateCache!.getRecord('note.txt')
    expect(after?.content).toContain('goodbye')
    expect(after!.readAt).toBeGreaterThanOrEqual(before.readAt)
  })

  test('write_file base64 of /tmp lands in .tmp and is left out of git and the project archive', async () => {
    const dir = tempDir('ws-write-')
    const ctx = workspace(dir, 'proj-anchor')
    const pdf = Buffer.from('%PDF-1.1 fake')
    const wrote = await tool(ctx, 'write_file').execute('t', {
      path: '/tmp/report.pdf',
      encoding: 'base64',
      content: pdf.toString('base64'),
    })
    expect(wrote.details.remappedFrom).toBe('/tmp/report.pdf')
    expect(wrote.details.note).toMatch(/\.tmp/)
    expect(readFileSync(join(dir, '.tmp', 'report.pdf')).equals(pdf)).toBe(true)

    await initRepo(dir)
    writeFileSync(join(dir, 'keep.txt'), 'keep')
    await commit(dir, { message: 'keep the source' })
    const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
    expect(tracked).toContain('keep.txt')
    expect(tracked).not.toContain('.tmp/')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.tmp/')

    const packed = join(dir, 'project-src.tar.gz')
    const sync = new S3Sync({
      bucket: 'test-bucket',
      prefix: 'proj-anchor',
      localDir: dir,
      watchEnabled: false,
      syncInterval: 0,
    })
    const archive = await sync.packProjectArchive(packed)
    expect(archive?.bytes).toBeGreaterThan(0)
    const extracted = tempDir('ws-extract-')
    execFileSync('tar', ['-xzf', packed, '-C', extracted])
    expect(readFileSync(join(extracted, 'keep.txt'), 'utf8')).toBe('keep')
    expect(() => statSync(join(extracted, '.tmp', 'report.pdf'))).toThrow()
  })

  test('a one-character project-folder typo points at the path that exists', async () => {
    const dir = tempDir('ws-hint-')
    mkdirSync(join(dir, 'proj-111', 'src'), { recursive: true })
    writeFileSync(join(dir, 'proj-111', 'src', 'App.tsx'), 'export {}\n')
    const missing = await tool(workspace(dir, 'proj-anchor'), 'read_file').execute('t', { path: 'proj-112/src/App.tsx' })
    expect(missing.details.error).toMatch(/did you mean "proj-111\/src\/App\.tsx"/)
  })
})

describe('runtime auth accepts the workspace token the API verifies', () => {
  test('a real wrt token passes and a different workspace does not call the API', async () => {
    setEnv('AI_PROXY_SECRET', 'integration-signing-secret')
    setEnv('SHOGO_API_URL', origin)
    setEnv('RUNTIME_AUTH_SECRET', 'pod-secret')
    setEnv('WORKSPACE_RUNTIME', 'true')
    setEnv('WORKSPACE_ID', 'ws-int')
    setEnv('PROJECT_ID', undefined)
    mode = 'token'
    const { app, state } = await createRuntimeApp({
      name: 'workspace-tool-failures',
      workDir: tempDir('ws-runtime-'),
      runtimeType: 'unified',
      authPrefixes: ['/agent'],
      async onAssign() {},
    })
    state.tokenRefresh?.stop()
    app.get('/agent/ping', (c) => c.json({ ok: true }))

    const token = deriveWorkspaceRuntimeToken('ws-int')
    const ok = await app.request('/agent/ping', { headers: { 'x-runtime-token': token } })
    expect(ok.status).toBe(200)
    expect(hits.some((h) => h.url === '/api/internal/validate-runtime-token' && h.body.token === token)).toBe(true)

    hits.length = 0
    const other = await app.request('/agent/ping', {
      headers: { 'x-runtime-token': `wrt_v1_other_${'ab'.repeat(32)}` },
    })
    expect(other.status).toBe(401)
    expect(hits.filter((h) => h.url.includes('validate-runtime-token'))).toHaveLength(0)

    const forged = token.slice(0, -4) + (token.endsWith('0000') ? '1111' : '0000')
    const bad = await app.request('/agent/ping', { headers: { 'x-runtime-token': forged } })
    expect(bad.status).toBe(401)
  })
})

describe('connect and composio reconnect', () => {
  test('connect filesystem and computer-use point at the built-in tools', async () => {
    setEnv('SHOGO_LOCAL_MODE', undefined)
    const dir = tempDir('ws-connect-')
    const ctx = workspace(dir, 'proj-anchor')
    ctx.mcpClientManager = new MCPClientManager()
    const files = await tool(ctx, 'connect').execute('t', { name: 'filesystem', source: 'mcp' })
    expect(files.details.error).toMatch(/read_file/)
    const computer = await tool(ctx, 'connect').execute('t', { name: 'computer-use', source: 'mcp' })
    expect(computer.details.error).toMatch(/Use exec/)
  })

  test('an expired Shopify token raises the reconnect card through the credential wrapper', async () => {
    setEnv('SHOGO_API_URL', origin)
    setEnv('COMPOSIO_API_KEY', 'integration-key')
    resetComposioSession()
    await initComposioSession('user-1', 'ws-int', 'proj-anchor')
    mockedSchemas = [{ slug: 'SHOPIFY_GET_ORDERS', description: 'orders', is_deprecated: false }]
    handlers.toolsExecute = async () => ({ successful: false, error: 'Invalid API key or access token' })
    const mgr = { calls: [] as any[], addProxyTools(_g: string, tools: any[]) { this.calls.push({ tools }) } }
    await registerToolkitProxyTools(mgr as any, 'shopify')
    const writes: any[] = []
    const wrapped = withIntegrationCredentials(mgr.calls[0].tools[0], {
      projectId: 'proj-anchor',
      uiWriter: { write: (chunk) => writes.push(chunk) },
    })
    const result = await wrapped.execute('tc', {})
    expect(result.details.needs_reconnect).toBe(true)
    expect(result.details.errorKind).toBe('auth')
    expect(writes).toEqual([
      {
        type: 'data-integration-auth-required',
        data: {
          provider: 'composio:shopify',
          connectUrl: 'https://oauth.example/reconnect',
          message: "The integration's OAuth session is expired or invalid. Ask the user to reconnect the integration, then retry.",
        },
      },
    ])
  })
})
