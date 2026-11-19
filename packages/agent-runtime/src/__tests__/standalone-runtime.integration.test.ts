// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Standalone runtime, end to end (SHO-418).
 *
 * Boots the real `server.ts` with `SHOGO_STANDALONE=1`, no `SHOGO_API_URL` and
 * `KUBERNETES_SERVICE_HOST` set (so the process looks like a pod on a partner's
 * cluster), against a mock OpenAI-compatible endpoint, and asserts the whole
 * contract:
 *
 *   - `/health` is 200 and `/agent/*` is byte-compare auth only;
 *   - a chat turn streams `data-turn-start` … `finish` and runs a real tool call;
 *   - the turn can be reattached with `fromSeq`;
 *   - the files API round-trips text and base64 with a byte count;
 *   - **no outbound connection goes anywhere but the model endpoint** — the
 *     whole point of the mode, and the bug that made Odin patch the image;
 *   - a misconfigured pod fails at boot with one message naming every missing
 *     variable, and `WARM_POOL_MODE=true` is refused;
 *   - SIGTERM during an active stream drains it and exits inside the bound.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SECRET = 'standalone-integration-secret'
const workspace = mkdtempSync(join(tmpdir(), 'shogo-standalone-it-'))

// ---------------------------------------------------------------------------
// Outbound guard — installed BEFORE the server module is imported, so every
// fetch the runtime makes (including module-level ones) is recorded.
// ---------------------------------------------------------------------------

const outbound: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url ?? input)
  outbound.push(url)
  return realFetch(input, init)
}) as typeof fetch

// Console capture, so a swallowed ENOTFOUND / trust-resolver warning fails the
// test instead of scrolling past.
const logs: string[] = []
const realConsole = { log: console.log, warn: console.warn, error: console.error }
for (const level of ['log', 'warn', 'error'] as const) {
  console[level] = (...args: any[]) => {
    logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    realConsole[level](...args)
  }
}

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible endpoint: first call asks for a tool, second answers.
// ---------------------------------------------------------------------------

let modelCalls = 0
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
    await req.json()
    modelCalls++
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-it',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'qwen3-coder',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`

    const frames: string[] = []
    if (modelCalls === 1) {
      frames.push(chunk({ role: 'assistant', content: '' }))
      frames.push(
        chunk({
          tool_calls: [
            { index: 0, id: 'call_it_1', type: 'function', function: { name: 'write_file', arguments: '' } },
          ],
        }),
      )
      frames.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: JSON.stringify({ path: 'from-turn.txt', content: 'written by the turn\n' }) },
            },
          ],
        }),
      )
      frames.push(chunk({}, 'tool_calls'))
    } else {
      frames.push(chunk({ role: 'assistant', content: 'Wrote from-turn.txt.' }))
      frames.push(chunk({}, 'stop'))
    }
    frames.push('data: [DONE]\n\n')
    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })
  },
})

const MODEL_ORIGIN = `http://127.0.0.1:${mock.port}`

let server: { fetch: (req: Request, srv: any) => Promise<Response> }

beforeAll(async () => {
  mkdirSync(join(workspace, '.shogo'), { recursive: true })
  process.env.WORKSPACE_DIR = workspace
  process.env.SHOGO_STANDALONE = '1'
  process.env.RUNTIME_AUTH_SECRET = SECRET
  process.env.AGENT_MODEL = 'local:qwen3-coder'
  process.env.OPENAI_BASE_URL = `${MODEL_ORIGIN}/v1`
  process.env.OPENAI_API_KEY = 'local'
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
  process.env.NODE_ENV = 'production'
  process.env.PROJECT_ID = 'standalone'
  delete process.env.SHOGO_API_URL
  delete process.env.API_URL
  delete process.env.AI_PROXY_URL
  delete process.env.WARM_POOL_MODE

  server = (await import('../server')).default as any

  // The gateway starts asynchronously; a turn needs it up.
  for (let i = 0; i < 120; i++) {
    const res = await server.fetch(new Request('http://runtime.test/health'), {} as any)
    const body = (await res.json()) as { gateway?: { running?: boolean } }
    if (body.gateway?.running) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('agent gateway never started')
}, 60_000)

afterAll(() => {
  mock.stop(true)
  globalThis.fetch = realFetch
  console.log = realConsole.log
  console.warn = realConsole.warn
  console.error = realConsole.error
  // The gateway's background install may have populated node_modules, so this
  // is not instant. Best-effort: a leftover temp dir must not fail the suite.
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    /* temp dir */
  }
}, 120_000)

const authed = (path: string, init: RequestInit = {}) =>
  server.fetch(
    new Request(`http://runtime.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${SECRET}`, ...(init.headers as Record<string, string>) },
    }),
    {} as any,
  )

describe('boot and auth', () => {
  test('/health is 200 without a token', async () => {
    const res = await server.fetch(new Request('http://runtime.test/health'), {} as any)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; projectId: string }
    expect(body.status).toBe('ok')
    expect(body.projectId).toBe('standalone')
  })

  test('/agent/* refuses a request with no token, and says why', async () => {
    const res = await server.fetch(new Request('http://runtime.test/agent/status'), {} as any)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string; apiVerdict: string }
    expect(body.code).toBe('auth_mismatch')
    // No API round-trip happened: the verdict is the mode itself.
    expect(body.apiVerdict).toBe('standalone')
  })

  test('/agent/* accepts the byte-compared secret', async () => {
    const res = await authed('/agent/status')
    expect(res.status).toBe(200)
  })

  test('a wrong token is refused', async () => {
    const res = await server.fetch(
      new Request('http://runtime.test/agent/status', { headers: { authorization: 'Bearer nope' } }),
      {} as any,
    )
    expect(res.status).toBe(401)
  })
})

describe('files API', () => {
  test('text round-trip reports a byte count', async () => {
    const text = 'héllo — 世界\n'
    const put = await authed('/agent/workspace/files/notes/unicode.txt', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { bytes: number }).bytes).toBe(Buffer.byteLength(text, 'utf-8'))

    const get = await authed('/agent/workspace/files/notes/unicode.txt')
    expect(await get.json()).toEqual({
      path: 'notes/unicode.txt',
      content: text,
      encoding: 'utf-8',
      bytes: Buffer.byteLength(text, 'utf-8'),
    })
  })

  test('base64 round-trip', async () => {
    const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe])
    const put = await authed('/agent/workspace/files/notes/blob.bin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentBase64: raw.toString('base64') }),
    })
    expect(put.status).toBe(200)
    const get = await authed('/agent/workspace/files/notes/blob.bin')
    expect(await get.json()).toEqual({
      path: 'notes/blob.bin',
      contentBase64: raw.toString('base64'),
      encoding: 'base64',
      bytes: raw.length,
    })
  })
})

describe('a full turn', () => {
  let frames: string[] = []
  let turnId = ''

  test('streams data-turn-start … finish and runs a tool call', async () => {
    const res = await authed('/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatSessionId: 'it-chat',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'write from-turn.txt' }] }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    frames = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))

    const types = frames.map((f) => {
      try {
        return (JSON.parse(f) as { type?: string }).type
      } catch {
        return undefined
      }
    })
    expect(types).toContain('data-turn-start')
    expect(types).toContain('finish')
    expect(types).toContain('tool-input-available')
    expect(types).toContain('tool-output-available')

    const start = frames.find((f) => f.includes('"data-turn-start"'))!
    turnId = (JSON.parse(start) as { data: { turnId: string } }).data.turnId
    expect(turnId).toBeTruthy()

    // The tool call really ran: the file is on disk with the right bytes.
    const written = await authed('/agent/workspace/files/from-turn.txt')
    expect(written.status).toBe(200)
    expect(((await written.json()) as { content: string }).content).toBe('written by the turn\n')
  }, 60_000)

  test('reattaches with fromSeq and replays only later frames', async () => {
    const res = await authed('/agent/chat/it-chat/stream?fromSeq=0')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Turn-Id')).toBe(turnId)
    const body = await res.text()
    expect(body).toContain('data-turn-start')
    expect(body).toContain('finish')
  }, 30_000)
})

describe('no outbound calls to Shogo', () => {
  test('every fetch went to the model endpoint', () => {
    const foreign = outbound.filter((url) => !url.startsWith(MODEL_ORIGIN))
    expect(foreign).toEqual([])
  })

  test('nothing dialled the in-cluster ClusterIP', () => {
    expect(outbound.filter((url) => url.includes('.svc.cluster.local'))).toEqual([])
  })

  test('the log has no DNS / connection / trust-resolver noise', () => {
    const noise = logs.filter((line) =>
      /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|\[trust-resolver\]|svc\.cluster\.local/.test(line),
    )
    expect(noise).toEqual([])
  })

  test('the model endpoint was actually used', () => {
    expect(modelCalls).toBeGreaterThan(0)
    expect(outbound.some((url) => url.startsWith(MODEL_ORIGIN))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Boot-time validation, in a child process (the module is already loaded here).
// ---------------------------------------------------------------------------

const SERVER_ENTRY = resolve(import.meta.dir, '../server.ts')

function bootWith(env: Record<string, string>): { code: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--no-env-file', '--conditions=development', 'run', SERVER_ENTRY],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      NODE_ENV: 'production',
      SHOGO_STANDALONE: '1',
      WORKSPACE_DIR: workspace,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  return {
    code: proc.exitCode ?? -1,
    output: `${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`,
  }
}

describe('boot-time validation', () => {
  test('missing required env fails with one message naming each variable', () => {
    const { code, output } = bootWith({})
    expect(code).not.toBe(0)
    expect(output).toContain('StandaloneConfigError')
    expect(output).toContain('RUNTIME_AUTH_SECRET')
    expect(output).toContain('AGENT_MODEL')
  }, 90_000)

  test('WARM_POOL_MODE=true is refused', () => {
    const { code, output } = bootWith({
      RUNTIME_AUTH_SECRET: 'x',
      AGENT_MODEL: 'local:qwen3-coder',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      WARM_POOL_MODE: 'true',
    })
    expect(code).not.toBe(0)
    expect(output).toContain('WARM_POOL_MODE')
  }, 90_000)
})

// ---------------------------------------------------------------------------
// SIGTERM during an active stream.
// ---------------------------------------------------------------------------

describe('SIGTERM drain', () => {
  test('drains the open stream and exits inside the documented bound', async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '--no-env-file',
        '--conditions=development',
        'run',
        resolve(import.meta.dir, 'fixtures/standalone-child.ts'),
      ],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const decoder = new TextDecoder()
    let seen = ''
    const reader = child.stdout.getReader()
    const waitFor = async (marker: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (seen.includes(marker)) return true
        const { value, done } = await reader.read()
        if (done) return seen.includes(marker)
        seen += decoder.decode(value, { stream: true })
      }
      return seen.includes(marker)
    }

    try {
      expect(await waitFor('READY', 30_000)).toBe(true)
      expect(await waitFor('GATEWAY', 60_000)).toBe(true)
      expect(await waitFor('TURN_STARTED', 60_000)).toBe(true)

      const signalledAt = Date.now()
      child.kill('SIGTERM')
      // Keep draining stdout until the process closes it, or the drain message
      // (and anything after it) is lost.
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value, { stream: true })
      }
      const exitCode = await child.exited
      const elapsed = Date.now() - signalledAt

      // The documented worst case is ~32 s; the grace period we recommend is
      // 60 s. A drain that ignores SIGTERM would hang until the test timeout.
      expect(elapsed).toBeLessThan(45_000)
      expect(seen).toContain('SIGTERM received')
      expect(exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 180_000)
})
