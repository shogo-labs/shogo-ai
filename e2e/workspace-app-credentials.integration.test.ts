// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration coverage for the credentials a workspace runtime gives the
 * project code it runs.
 *
 * Two projects share one workspace runtime. Each one's app server and build
 * are real child processes spawned by a real PreviewManager, and both use the
 * real `@shogo-ai/sdk` for `client.llm` and the tools client. The API's
 * internal routes and token signing run as themselves, behind a real HTTP
 * server; only the database lookup is stubbed. The LLM gateway applies the AI
 * proxy's credential rule (project tokens only) with the real verifier, and
 * the runtime's tool routes sit behind the real `createRuntimeApp` auth.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'

const WORKSPACE_ID = 'ws-int'
const OTHER_WORKSPACE_ID = 'ws-other'
const PROJECT_WORKSPACES = new Map([
  ['proj-a', WORKSPACE_ID],
  ['proj-b', WORKSPACE_ID],
  ['proj-foreign', OTHER_WORKSPACE_ID],
])

mock.module('../apps/api/src/lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const workspaceId = PROJECT_WORKSPACES.get(where.id)
        return workspaceId ? { id: where.id, workspaceId } : null
      },
    },
  },
}))
mock.module('../apps/api/src/lib/k8s-auth', () => ({
  validatePodToken: async () => null,
}))

const SDK_SRC = resolve(import.meta.dir, '../packages/sdk/src')

const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

setEnv('AI_PROXY_SECRET', 'workspace-app-credentials-signing-secret')
setEnv('NODE_ENV', 'test')

const { deriveRuntimeToken, verifyRuntimeToken } = await import('../apps/api/src/lib/runtime-token')
const { deriveWorkspaceRuntimeToken } = await import('../apps/api/src/lib/workspace-runtime-token')
const internalApp = (await import('../apps/api/src/routes/internal')).default
const { createRuntimeApp } = await import('../packages/shared-runtime/src/server-framework')
const { PreviewManager } = await import('../packages/agent-runtime/src/preview-manager')
const { runWorkspaceInstall } = await import('../packages/agent-runtime/src/workspace-defaults')
const { acceptsAppToolToken, _resetAppRuntimeTokensForTests } = await import(
  '../packages/agent-runtime/src/app-runtime-token'
)
const { voiceMediaRoutes } = await import('../apps/api/src/routes/voice-media')
const { createTools } = await import('../packages/agent-runtime/src/gateway-tools')
const { CommandRegistry } = await import('../packages/agent-runtime/src/command-registry')

const WORKSPACE_TOKEN = deriveWorkspaceRuntimeToken(WORKSPACE_ID)

type LlmCall = { authorization: string | null; projectId: string | null }
type ToolCall = { path: string; token: string | null; tool?: string }

const llmCalls: LlmCall[] = []
const toolCalls: ToolCall[] = []
type VoiceCall = { path: string; via: string | null; tokenProject: string | null; projectId: string | null }
const voiceCalls: VoiceCall[] = []
const elCalls: { url: string; key: string | null }[] = []
const MUSIC_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x2a])
const tempDirs: string[] = []
const managers: InstanceType<typeof PreviewManager>[] = []
let apiServer: ReturnType<typeof Bun.serve>
let runtimeServer: ReturnType<typeof Bun.serve>
let stopRuntime: () => void = () => {}

/**
 * Mirrors the AI proxy's `validateProxyAuthImpl`: a bearer token is accepted
 * only when it is a project runtime token that verifies. A workspace token
 * has no branch there and falls through to a 401.
 */
function llmGateway(req: Request): Response {
  const authorization = req.headers.get('authorization')
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  const verified = token.startsWith('rt_v1_') ? verifyRuntimeToken(token) : null
  llmCalls.push({ authorization, projectId: verified?.ok ? verified.projectId : null })
  if (!verified?.ok) return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 })
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [
      { index: 0, message: { role: 'assistant', content: `hello ${verified.projectId}` }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })
}

/**
 * The hosted voice routes, mounted on the test API with the real executor and
 * the real router. Only the runtime-token middleware is mirrored here (same
 * shape `authMiddleware` sets for an `rt_v1_` caller), and the project check
 * stays the router's own `runtimeScopeViolation`: a workspace token is not a
 * project token, so `verifyRuntimeToken` refuses it before any of this runs.
 */
function voiceApi() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const token = c.req.header('x-runtime-token') ?? ''
    const verified = verifyRuntimeToken(token)
    if (!verified.ok) return c.json({ error: 'unauthorized' }, 401)
    c.set('auth', {
      isAuthenticated: true,
      userId: 'user-owner',
      workspaceId: WORKSPACE_ID,
      projectId: verified.projectId,
      via: 'runtimeToken',
    } as never)
    voiceCalls.push({
      path: c.req.path,
      via: 'runtimeToken',
      tokenProject: verified.projectId,
      projectId: c.req.query('projectId')?.trim() || null,
    })
    await next()
  })
  app.route(
    '/api',
    voiceMediaRoutes({
      authorize: async (_c, projectId) => ({ ok: true, status: 200, workspaceId: PROJECT_WORKSPACES.get(projectId) }),
      resolveVoiceId: async () => 'voice-default',
      recordUsage: async () => {},
    }),
  )
  return app
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

/**
 * The SDK calls a project's code makes in a Shogo pod. Reported by the app
 * server over HTTP and written to disk by the build.
 */
const SDK_PROBE = `
import { createClient } from ${JSON.stringify(join(SDK_SRC, 'index.ts'))}
import { getServerToolsClient } from ${JSON.stringify(join(SDK_SRC, 'tools/client.ts'))}

export async function probe() {
  const secret = process.env.RUNTIME_AUTH_SECRET ?? null
  const out: Record<string, unknown> = {
    projectId: process.env.PROJECT_ID ?? null,
    secretKind: secret === null ? null : secret.startsWith('wrt_') ? 'workspace' : secret.startsWith('rt_v1_') ? 'project' : 'other',
  }
  const client = createClient({ apiUrl: 'http://unused', shogoCloudUrl: process.env.SHOGO_API_URL })
  if (!client.llm) {
    out.llm = { error: 'client.llm is null' }
  } else {
    try {
      const result = await client.llm('test-model').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      out.llm = { text: result.content.filter((p) => p.type === 'text').map((p) => p.text).join('') }
    } catch (err) {
      out.llm = { error: String(err?.statusCode ?? err?.message ?? err) }
    }
  }
  try {
    const tools = getServerToolsClient()
    const schemas = await tools.listTools()
    const executed = await tools.execute('ECHO', { from: process.env.PROJECT_ID })
    out.tools = { schemas: schemas.map((s) => s.name), executed }
  } catch (err) {
    out.tools = { error: String(err?.message ?? err) }
  }
  const install = await fetch('http://127.0.0.1:' + process.env.RUNTIME_PORT + '/agent/tools/install', {
    method: 'POST',
    headers: { 'x-runtime-token': secret ?? '', 'content-type': 'application/json' },
    body: '{}',
  })
  out.installStatus = install.status
  return out
}
`

const SERVER_TSX = `
import { probe } from './sdk-probe'
Bun.serve({
  port: Number(process.env.PORT),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/health') return new Response('ok')
    if (pathname === '/probe') return Response.json(await probe())
    return new Response('not found', { status: 404 })
  },
})
`

/**
 * A project app server whose only job is a hosted voice call. It runs the real
 * `createVoiceHandlers` in runtime-token proxy mode, so whether the call works
 * is decided entirely by the credentials the runtime handed this process.
 */
const VOICE_SRC = resolve(import.meta.dir, '../packages/voice/src')
const MUSIC_SERVER_TSX = `
import { createVoiceHandlers } from ${JSON.stringify(join(VOICE_SRC, 'server.ts'))}
const voice = createVoiceHandlers({})
Bun.serve({
  port: Number(process.env.PORT),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/health') return new Response('ok')
    if (pathname === '/music') return voice.music(req)
    return new Response('not found', { status: 404 })
  },
})
`

const BUILD_TS = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { probe } from './sdk-probe'
const result = await probe()
writeFileSync('build-probe.json', JSON.stringify(result))
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.html', '<p>built</p>')
`

function writeProject(root: string, projectId: string): string {
  const dir = join(root, projectId)
  mkdirSync(join(dir, 'src', 'generated'), { recursive: true })
  writeFileSync(join(dir, '.tech-stack'), 'custom')
  writeFileSync(join(dir, 'sdk-probe.ts'), SDK_PROBE)
  writeFileSync(join(dir, 'server.tsx'), SERVER_TSX)
  writeFileSync(join(dir, 'src', 'generated', 'index.ts'), 'export {}\n')
  writeFileSync(join(dir, 'build.ts'), BUILD_TS)
  writeFileSync(join(dir, 'shogo.preview.json'), JSON.stringify({ build: 'bun build.ts', outDir: 'dist' }))
  return dir
}

async function startProjectAt(dir: string, projectId: string) {
  const pm = new PreviewManager({
    workspaceDir: dir,
    runtimePort: runtimeServer.port!,
    apiPort: await freePort(),
    projectId,
  })
  managers.push(pm)
  return pm
}

async function startProject(root: string, projectId: string) {
  return startProjectAt(writeProject(root, projectId), projectId)
}

async function serverProbe(pm: InstanceType<typeof PreviewManager>): Promise<any> {
  await pm.restartApiServerOnly()
  const res = await fetch(`${pm.apiServerUrl}/probe`)
  expect(res.status).toBe(200)
  return res.json()
}

async function buildProbe(pm: InstanceType<typeof PreviewManager>): Promise<any> {
  const result = await pm.buildForPublish()
  expect(result).toEqual({ ok: true })
  return JSON.parse(readFileSync(join(pm.getStatus().workspaceDir, 'build-probe.json'), 'utf8'))
}

beforeAll(async () => {
  const voiceApp = voiceApi()
  apiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/api/ai/v1/chat/completions') return llmGateway(req)
      if (url.pathname.startsWith('/api/voice/')) {
        return req
          .text()
          .then((body) =>
            voiceApp.fetch(
              new Request(url, {
                method: req.method,
                headers: req.headers,
                ...(body ? { body } : {}),
              }),
            ),
          )
      }
      if (url.pathname.startsWith('/api/internal/')) {
        url.pathname = url.pathname.slice('/api/internal'.length)
        return internalApp.fetch(new Request(url, req))
      }
      return new Response('not found', { status: 404 })
    },
  })

  setEnv('SHOGO_API_URL', `http://127.0.0.1:${apiServer.port}`)
  setEnv('WORKSPACE_RUNTIME', 'true')
  setEnv('WORKSPACE_ID', WORKSPACE_ID)
  setEnv('PROJECT_ID', `ws:${WORKSPACE_ID}`)
  setEnv('RUNTIME_AUTH_SECRET', WORKSPACE_TOKEN)
  setEnv('SHOGO_LOCAL_MODE', undefined)
  setEnv('TECH_STACK_ID', undefined)
  setEnv('WORKSPACE_DATABASE_URLS', undefined)

  const runtimeDir = mkdtempSync(join(tmpdir(), 'ws-app-creds-runtime-'))
  tempDirs.push(runtimeDir)
  const { app, state } = await createRuntimeApp({
    name: 'workspace-app-credentials',
    workDir: runtimeDir,
    runtimeType: 'unified',
    authPrefixes: ['/agent', '/pool', '/diagnostics', '/terminal'],
    acceptsScopedToken: acceptsAppToolToken,
    async onAssign() {},
  })
  state.tokenRefresh?.stop()
  const record = (c: any, tool?: string) =>
    toolCalls.push({ path: c.req.path, token: c.req.header('x-runtime-token') ?? null, tool })
  app.get('/agent/tools/schemas', (c) => {
    record(c)
    return c.json({ tools: [{ name: 'ECHO', description: 'echo', parameters: {} }] })
  })
  app.post('/agent/tools/execute', async (c) => {
    const body = await c.req.json()
    record(c, body.tool)
    return c.json({ ok: true, data: { echoed: body.args } })
  })
  app.post('/agent/tools/install', (c) => {
    record(c)
    return c.json({ ok: true })
  })
  runtimeServer = Bun.serve({ port: 0, fetch: app.fetch })
  setEnv('PORT', String(runtimeServer.port))
  stopRuntime = () => runtimeServer.stop(true)
})

afterAll(() => {
  apiServer?.stop(true)
  stopRuntime()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

let workspaceRoot = ''
beforeEach(() => {
  _resetAppRuntimeTokensForTests()
  llmCalls.length = 0
  toolCalls.length = 0
  voiceCalls.length = 0
  elCalls.length = 0
  workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-app-creds-'))
  tempDirs.push(workspaceRoot)
})

afterEach(async () => {
  for (const pm of managers.splice(0)) pm.stop()
})

describe('workspace runtime app credentials', () => {
  test('each project app server reaches the LLM and tools as its own project', async () => {
    const a = await startProject(workspaceRoot, 'proj-a')
    const b = await startProject(workspaceRoot, 'proj-b')

    const probeA = await serverProbe(a)
    const probeB = await serverProbe(b)

    for (const [probe, projectId] of [[probeA, 'proj-a'], [probeB, 'proj-b']] as const) {
      expect(probe.projectId).toBe(projectId)
      expect(probe.secretKind).toBe('project')
      expect(probe.llm).toEqual({ text: `hello ${projectId}` })
      expect(probe.tools).toEqual({
        schemas: ['ECHO'],
        executed: { ok: true, data: { echoed: { from: projectId } } },
      })
      expect(probe.installStatus).toBe(401)
    }

    expect(llmCalls.map((c) => c.projectId)).toEqual(['proj-a', 'proj-b'])
    expect(llmCalls.every((c) => !c.authorization?.includes(WORKSPACE_TOKEN))).toBe(true)
    const tokensUsed = toolCalls.map((c) => c.token)
    expect(tokensUsed).toEqual([
      deriveRuntimeToken('proj-a'),
      deriveRuntimeToken('proj-a'),
      deriveRuntimeToken('proj-b'),
      deriveRuntimeToken('proj-b'),
    ])
    expect(toolCalls.some((c) => c.path === '/agent/tools/install')).toBe(false)
  }, 60_000)

  test('each project build reaches the LLM and tools as its own project', async () => {
    const a = await startProject(workspaceRoot, 'proj-a')
    const b = await startProject(workspaceRoot, 'proj-b')

    const buildA = await buildProbe(a)
    const buildB = await buildProbe(b)

    for (const [probe, projectId] of [[buildA, 'proj-a'], [buildB, 'proj-b']] as const) {
      expect(probe.projectId).toBe(projectId)
      expect(probe.secretKind).toBe('project')
      expect(probe.llm).toEqual({ text: `hello ${projectId}` })
      expect(probe.tools.executed).toEqual({ ok: true, data: { echoed: { from: projectId } } })
      expect(probe.installStatus).toBe(401)
    }
    expect(llmCalls.map((c) => c.projectId)).toEqual(['proj-a', 'proj-b'])
  }, 60_000)

  test('a project outside the workspace gets no runtime secret, never the workspace token', async () => {
    const foreign = await startProject(workspaceRoot, 'proj-foreign')

    const probe = await serverProbe(foreign)
    expect(probe.projectId).toBe('proj-foreign')
    expect(probe.secretKind).toBeNull()
    expect(probe.llm).toEqual({ error: 'client.llm is null' })
    expect(probe.tools.error).toContain('RUNTIME_AUTH_SECRET')
    expect(probe.installStatus).toBe(401)
    expect(llmCalls).toHaveLength(0)
  }, 60_000)

  test('install scripts do not see the workspace token', async () => {
    const dir = join(workspaceRoot, 'proj-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'install-probe',
        private: true,
        scripts: {
          postinstall: `bun -e "require('fs').writeFileSync('install-env.json', JSON.stringify({ secret: process.env.RUNTIME_AUTH_SECRET ?? null }))"`,
        },
      }),
    )
    await runWorkspaceInstall(dir, { frozen: false })
    expect(JSON.parse(readFileSync(join(dir, 'install-env.json'), 'utf8'))).toEqual({ secret: null })
  }, 60_000)

  test('the workspace token itself is refused by the LLM gateway', async () => {
    const res = await fetch(`${process.env.SHOGO_API_URL}/api/ai/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKSPACE_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})

/**
 * SHO-228 — the workspace token must not reach code the runtime runs for a
 * project. These are the paths the SDK never sees: an agent `exec` shell, a
 * background task, and a project's voice/music call. The leak is planted, not
 * hypothetical: `RUNTIME_AUTH_SECRET` is the workspace token for this whole
 * file, exactly as it is in a real workspace runtime.
 */
describe('project credentials for runtime-spawned code', () => {
  const realFetch = globalThis.fetch

  beforeAll(() => {
    setEnv('ELEVENLABS_API_KEY', 'test-elevenlabs-key')
    setEnv(
      'WORKSPACE_MOUNTS',
      JSON.stringify([
        { mount: 'proj-a', path: join(tmpdir(), 'unused-a'), projectId: 'proj-a', kind: 'managed' },
        { mount: 'proj-b', path: join(tmpdir(), 'unused-b'), projectId: 'proj-b', kind: 'managed' },
      ]),
    )
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://api.elevenlabs.io/')) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        elCalls.push({ url, key: headers.get('xi-api-key') })
        return new Response(MUSIC_BYTES, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      }
      return realFetch(input, init)
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  function shellCtx(workspaceDir: string, cwd: string) {
    return {
      workspaceDir,
      channels: new Map(),
      config: { model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
      projectId: `ws:${WORKSPACE_ID}`,
      commandRegistry: new CommandRegistry(),
      shellState: { getCwd: () => cwd, setCwd: () => {}, initialCwd: cwd },
    } as any
  }

  /**
   * The env a spawned command actually saw, written by the command itself into
   * its own cwd (the shell's `cd` target), so no path quoting can hide a
   * failure.
   */
  const ENV_PROBE = `bun -e "require('fs').writeFileSync('exec-env.json', JSON.stringify({ projectId: process.env.PROJECT_ID ?? null, secret: process.env.RUNTIME_AUTH_SECRET ?? null }))"`
  const PROBE_FILE = 'exec-env.json'

  async function runExec(ctx: any, params: Record<string, unknown>) {
    const tool = createTools(ctx).find((t) => t.name === 'exec')!
    expect(tool).toBeDefined()
    return (await tool.execute('exec-call', params)) as any
  }

  async function waitForFile(path: string, timeoutMs = 30_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error(`timed out waiting for ${path}`)
  }

  test('an agent shell runs project code with the cwd project token, not the workspace token', async () => {
    const dirA = writeProject(workspaceRoot, 'proj-a')

    await runExec(shellCtx(workspaceRoot, dirA), { command: ENV_PROBE })

    const seen = await waitForFile(join(dirA, PROBE_FILE))
    expect(seen.projectId).toBe('proj-a')
    expect(seen.secret).toBe(deriveRuntimeToken('proj-a'))
    expect(seen.secret).not.toBe(WORKSPACE_TOKEN)
  }, 60_000)

  test('a background task gets the same project credentials as a foreground one', async () => {
    const dirB = writeProject(workspaceRoot, 'proj-b')

    const result = await runExec(shellCtx(workspaceRoot, dirB), {
      command: ENV_PROBE,
      background: true,
    })
    expect(JSON.stringify(result)).toContain('task_id')

    const seen = await waitForFile(join(dirB, PROBE_FILE))
    expect(seen.projectId).toBe('proj-b')
    expect(seen.secret).toBe(deriveRuntimeToken('proj-b'))
  }, 60_000)

  test('a shell outside any project gets no runtime token at all', async () => {
    await runExec(shellCtx(workspaceRoot, workspaceRoot), { command: ENV_PROBE })

    const seen = await waitForFile(join(workspaceRoot, PROBE_FILE))
    expect(seen.secret).toBeNull()
    expect(seen.secret).not.toBe(WORKSPACE_TOKEN)
  }, 60_000)

  test('a project app server calls hosted voice as its own project', async () => {
    const dir = writeProject(workspaceRoot, 'proj-a')
    writeFileSync(join(dir, 'server.tsx'), MUSIC_SERVER_TSX)
    const pm = await startProjectAt(dir, 'proj-a')

    await pm.restartApiServerOnly()
    const res = await fetch(`${pm.apiServerUrl}/music`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'lofi beats for a build log' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MUSIC_BYTES)

    expect(voiceCalls).toHaveLength(1)
    expect(voiceCalls[0]).toEqual({
      path: '/api/voice/music',
      via: 'runtimeToken',
      tokenProject: 'proj-a',
      projectId: 'proj-a',
    })
    expect(elCalls).toHaveLength(1)
    expect(elCalls[0].key).toBe('test-elevenlabs-key')
  }, 60_000)

  test('the workspace token cannot call hosted voice for a project', async () => {
    const res = await fetch(`${process.env.SHOGO_API_URL}/api/voice/music?projectId=proj-a`, {
      method: 'POST',
      headers: { 'x-runtime-token': WORKSPACE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'lofi' }),
    })
    expect(res.status).toBe(401)
    expect(elCalls).toHaveLength(0)
  })

  test("one project's token cannot spend on a sibling project", async () => {
    const res = await fetch(`${process.env.SHOGO_API_URL}/api/voice/music?projectId=proj-b`, {
      method: 'POST',
      headers: {
        'x-runtime-token': deriveRuntimeToken('proj-a'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'lofi' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', detail: 'Runtime token scope mismatch' })
    expect(elCalls).toHaveLength(0)
  })
})
