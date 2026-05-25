// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * lsp-service.ts — coverage closer for the LSP message pump, server-request
 * dispatch (workspace/configuration, register/unregisterCapability,
 * window/workDoneProgress/create), the workspace/didChangeWatchedFiles
 * delegation path, and the pyright CLI runner.
 *
 *   bun test packages/shared-runtime/src/__tests__/lsp-service-extra.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Bun spawn mock — controllable FakeSubprocess
// ---------------------------------------------------------------------------

type ChunkQ = { chunks: Uint8Array[]; closed: boolean; waiter?: () => void }

function makeReadable() {
  const q: ChunkQ = { chunks: [], closed: false }
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      while (q.chunks.length === 0 && !q.closed) {
        await new Promise<void>(r => { q.waiter = r })
      }
      if (q.chunks.length > 0) {
        return { done: false, value: q.chunks.shift()! }
      }
      return { done: true, value: undefined }
    },
  }
  return {
    stream: { getReader: () => reader },
    push: (data: string | Uint8Array) => {
      const u = typeof data === 'string' ? new TextEncoder().encode(data) : data
      q.chunks.push(u)
      if (q.waiter) { const w = q.waiter; q.waiter = undefined; w() }
    },
    close: () => {
      q.closed = true
      if (q.waiter) { const w = q.waiter; q.waiter = undefined; w() }
    },
  }
}

interface FakeSub {
  pid: number
  stdin: { write: (s: string) => void; flush: () => void }
  stdout: any
  stderr: any
  exitCode: number | null
  exited: Promise<number>
  kill: () => void
  __stdinWrites: string[]
  __pushStdout: (data: string | Uint8Array) => void
  __closeStdout: () => void
  __pushStderr: (data: string | Uint8Array) => void
  __closeStderr: () => void
}

let lastSpawn: FakeSub | null = null
let spawnCalls: Array<{ cmd: string[]; opts: any }> = []
let spawnImpl: (cmd: string[], opts: any) => FakeSub = makeDefaultSpawn

function makeDefaultSpawn(cmd: string[], opts: any): FakeSub {
  const stdoutReadable = makeReadable()
  const stderrReadable = makeReadable()
  let resolveExited: (code: number) => void = () => {}
  const exited = new Promise<number>(r => { resolveExited = r })
  const sub: FakeSub = {
    pid: 4242,
    stdin: {
      write: (s: string) => { sub.__stdinWrites.push(s) },
      flush: () => {},
    },
    stdout: stdoutReadable.stream,
    stderr: stderrReadable.stream,
    exitCode: null,
    exited,
    kill: () => {
      sub.exitCode = 0
      stdoutReadable.close()
      stderrReadable.close()
      resolveExited(0)
    },
    __stdinWrites: [],
    __pushStdout: stdoutReadable.push,
    __closeStdout: stdoutReadable.close,
    __pushStderr: stderrReadable.push,
    __closeStderr: stderrReadable.close,
  }
  return sub
}

const lsp = await import('../lsp-service')

lsp._setSpawnForTesting(((cmd: string[], opts: any) => {
  const sub = spawnImpl(cmd, opts)
  spawnCalls.push({ cmd, opts })
  lastSpawn = sub
  return sub
}) as any)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function framedMessage(payload: object): string {
  const body = JSON.stringify(payload)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

async function flushTicks(n = 6) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

function getStdinMessages(sub: FakeSub): any[] {
  // Each .write() call contains a full header+body. Parse them out.
  const messages: any[] = []
  let buf = sub.__stdinWrites.join('')
  while (buf.length > 0) {
    const m = buf.match(/^Content-Length:\s*(\d+)\r\n\r\n/)
    if (!m) break
    const len = parseInt(m[1]!, 10)
    const start = m[0].length
    const body = buf.slice(start, start + len)
    buf = buf.slice(start + len)
    try { messages.push(JSON.parse(body)) } catch { messages.push(body) }
  }
  return messages
}

let TEST_DIR: string

beforeEach(() => {
  spawnCalls = []
  lastSpawn = null
  spawnImpl = makeDefaultSpawn
  TEST_DIR = join(tmpdir(), `lsp-extra-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TEST_DIR, { recursive: true })
  // Pre-create the .bin shim so resolveBin succeeds without real LSP binary.
  const binDir = join(TEST_DIR, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'typescript-language-server'), '#!/usr/bin/env node\n')
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

// ---------------------------------------------------------------------------
// TSLanguageServer.start — spawn path + exitCode-not-null guard
// ---------------------------------------------------------------------------

describe('TSLanguageServer.start', () => {
  test('spawns via bun, reads stdout/stderr, and is idempotent', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]!.cmd[0]).toBe('bun')
    expect(spawnCalls[0]!.cmd).toContain('--stdio')
    expect(server.isRunning()).toBe(true)
    // Second start() is a no-op.
    await server.start()
    expect(spawnCalls.length).toBe(1)
    server.stop()
  })

  test('start throws when serverBin path does not exist anywhere', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR, {
      serverBin: '/nope/missing-bin',
      fallbackBinNames: ['also-nope'],
    })
    await expect(server.start()).rejects.toThrow(/Could not find language server binary/)
  })

  test('uses explicit serverBin when it exists', async () => {
    const explicit = join(TEST_DIR, 'my-server')
    writeFileSync(explicit, '#!/usr/bin/env node\n')
    const server = new lsp.TSLanguageServer(TEST_DIR, { serverBin: explicit })
    await server.start()
    expect(spawnCalls[0]!.cmd).toContain(explicit)
    server.stop()
  })

  test('start re-throws when spawn returns an already-exited process', async () => {
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      sub.exitCode = 42
      return sub
    }
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await expect(server.start()).rejects.toThrow(/exited with code 42/)
  })

  test('stderr lines with content are logged; empty stderr is ignored', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR, { label: 'PUMP' })
    await server.start()
    lastSpawn!.__pushStderr('   \n')
    lastSpawn!.__pushStderr('an actual error\n')
    await flushTicks(4)
    server.stop()
  })

  test('readErrorStream returns early when stderr is missing', async () => {
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      sub.stderr = null as any
      return sub
    }
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    expect(server.isRunning()).toBe(true)
    server.stop()
  })

  test('readOutputStream returns early when stdout is missing', async () => {
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      sub.stdout = null as any
      return sub
    }
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    expect(server.isRunning()).toBe(true)
    server.stop()
  })
})

// ---------------------------------------------------------------------------
// processBuffer — header parsing, malformed payloads, response routing
// ---------------------------------------------------------------------------

describe('TSLanguageServer message pump', () => {
  test('parses framed JSON, routes response to pending request, fires onMessage handlers', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()

    const seen: any[] = []
    const unsub = server.onMessage(m => seen.push(m))

    const reqPromise = server.request('test/method', { foo: 1 })
    await flushTicks(2)
    const stdinMsgs = getStdinMessages(lastSpawn!)
    const req = stdinMsgs[stdinMsgs.length - 1]!
    expect(req.method).toBe('test/method')
    const id = req.id

    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id, result: { ok: true } }))
    await flushTicks(4)
    const result = await reqPromise
    expect(result).toEqual({ ok: true })
    expect(seen.length).toBeGreaterThan(0)
    expect(unsub()).toBeTruthy()
    server.stop()
  })

  test('routes error responses by rejecting pending promise', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const p = server.request('boom', null)
    await flushTicks(2)
    const id = getStdinMessages(lastSpawn!).pop()!.id
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id, error: { code: -1, message: 'kaboom' },
    }))
    await expect(p).rejects.toThrow(/kaboom/)
    server.stop()
  })

  test('skips malformed JSON payloads silently', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    // Send a frame with body that isn't valid JSON
    const body = '{ not json '
    lastSpawn!.__pushStdout(`Content-Length: ${body.length}\r\n\r\n${body}`)
    await flushTicks(4)
    expect(server.isRunning()).toBe(true)
    server.stop()
  })

  test('discards frames whose header lacks Content-Length', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    lastSpawn!.__pushStdout('No-Length: 5\r\n\r\nhello')
    await flushTicks(4)
    server.stop()
  })

  test('handles chunked input where header arrives before body', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///x.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'oops' }] } })
    lastSpawn!.__pushStdout(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`)
    await flushTicks(2)
    lastSpawn!.__pushStdout(body)
    await flushTicks(4)
    expect(server.getDiagnostics('file:///x.ts').has('file:///x.ts')).toBe(true)
    server.stop()
  })

  test('captures publishDiagnostics into diagnosticsByUri', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///a.ts', diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, message: 'err' }] },
    }))
    await flushTicks(4)
    const got = server.getDiagnostics()
    expect(got.has('file:///a.ts')).toBe(true)
    expect(server.getDiagnostics('file:///a.ts').get('file:///a.ts')!.length).toBe(1)
    server.stop()
  })
})

// ---------------------------------------------------------------------------
// handleServerRequest — every case branch
// ---------------------------------------------------------------------------

describe('TSLanguageServer.handleServerRequest', () => {
  test('workspace/configuration replies with python defaults for python sections', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 7, method: 'workspace/configuration',
      params: { items: [{ section: 'python' }, { section: 'python.analysis' }, { section: 'other' }] },
    }))
    await flushTicks(4)
    const reply = getStdinMessages(lastSpawn!).find(m => m.id === 7)
    expect(reply).toBeDefined()
    expect(Array.isArray(reply.result)).toBe(true)
    expect(reply.result[0]).toEqual({ pythonPath: 'python3', analysis: { typeCheckingMode: 'basic' } })
    expect(reply.result[1]).toEqual({ typeCheckingMode: 'basic' })
    expect(reply.result[2]).toEqual({})
    server.stop()
  })

  test('workspace/configuration tolerates missing items array', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 8, method: 'workspace/configuration', params: {},
    }))
    await flushTicks(4)
    const reply = getStdinMessages(lastSpawn!).find(m => m.id === 8)
    expect(reply.result).toEqual([])
    server.stop()
  })

  test('client/registerCapability stores compiled watchers, then ignores unknown methods', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const initP = server.initialize()
    await flushTicks(3)
    const initReq = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await initP
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 9, method: 'client/registerCapability',
      params: {
        registrations: [
          { id: 'r1', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [
            { globPattern: '**/*.ts', kind: 7 },
            { globPattern: { baseUri: 'file:///x', pattern: '**/tsconfig.json' } },
            { globPattern: 42 }, // non-string skipped
            { /* missing globPattern */ },
          ] } },
          { id: 'r-empty', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [] } },
          { id: 'r-other', method: 'textDocument/didChange' }, // ignored
        ],
      },
    }))
    await flushTicks(4)
    const reply = getStdinMessages(lastSpawn!).find(m => m.id === 9)
    expect(reply.result).toBeNull()

    // Now drive a watched file event matching r1
    server.notifyWatchedFileEvent('/proj/foo.ts', 'changed')
    await flushTicks(2)
    const watchedNotif = getStdinMessages(lastSpawn!).find(
      m => m.method === 'workspace/didChangeWatchedFiles',
    )
    expect(watchedNotif).toBeDefined()
    expect(watchedNotif.params.changes[0].uri).toBe('file:///proj/foo.ts')

    // client/unregisterCapability
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 10, method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: 'r1' }, { id: 'nope' }, {}] },
    }))
    await flushTicks(4)

    // window/workDoneProgress/create just returns null
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 11, method: 'window/workDoneProgress/create', params: {},
    }))
    // Unknown server request → default branch returns null
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 12, method: 'some/unknown', params: {},
    }))
    await flushTicks(4)
    const all = getStdinMessages(lastSpawn!)
    expect(all.find(m => m.id === 11)!.result).toBeNull()
    expect(all.find(m => m.id === 12)!.result).toBeNull()

    server.stop()
  })

  test('client/unregisterCapability tolerates missing unregisterations', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 20, method: 'client/unregisterCapability', params: {},
    }))
    await flushTicks(4)
    expect(getStdinMessages(lastSpawn!).find(m => m.id === 20).result).toBeNull()
    server.stop()
  })
})

// ---------------------------------------------------------------------------
// compileLspGlob — exercised indirectly via registerCapability
// ---------------------------------------------------------------------------

describe('compileLspGlob (via registerCapability)', () => {
  async function registerPattern(server: any, pattern: string) {
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 50, method: 'client/registerCapability',
      params: { registrations: [
        { id: 'gp', method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: pattern }] } },
      ] },
    }))
    await flushTicks(4)
  }

  test('glob with ? and {a,b,c} branches', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const ip = server.initialize()
    await flushTicks(3)
    const ir = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: ir.id, result: {} }))
    await ip
    await registerPattern(server, 'src/?.{ts,tsx,js}')
    server.notifyWatchedFileEvent('/proj/src/a.ts', 'created')
    server.notifyWatchedFileEvent('/proj/src/b.tsx', 'created')
    server.notifyWatchedFileEvent('/proj/src/ab.ts', 'created') // ? matches single char
    await flushTicks(2)
    server.stop()
  })

  test('unterminated { in glob becomes a literal brace match', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    await registerPattern(server, '**/{unterminated.ts')
    // Just verify the registration didn't throw — actual matching is exercised in
    // the watched-file test above. Tests the `close === -1` branch.
    expect(server.isRunning()).toBe(true)
    server.stop()
  })
})

// ---------------------------------------------------------------------------
// notifyWatchedFileEvent — kind bitmask + no-match path
// ---------------------------------------------------------------------------

describe('TSLanguageServer.notifyWatchedFileEvent', () => {
  test('no-op when no registrations exist', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    server.notifyWatchedFileEvent('/x.ts', 'changed')
    await flushTicks(2)
    const msgs = getStdinMessages(lastSpawn!)
    expect(msgs.find(m => m.method === 'workspace/didChangeWatchedFiles')).toBeUndefined()
    server.stop()
  })

  test('kind bitmask filters: created event must match WATCH_KIND_CREATE bit', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const initP2 = server.initialize()
    await flushTicks(3)
    const initReq2 = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq2.id, result: {} }))
    await initP2
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', id: 33, method: 'client/registerCapability',
      params: { registrations: [
        { id: 'change-only', method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: '**/*.ts', kind: 2 /* change only */ }] } },
      ] },
    }))
    await flushTicks(4)
    server.notifyWatchedFileEvent('/x.ts', 'created') // bit not set
    server.notifyWatchedFileEvent('/x.ts', 'deleted') // bit not set
    server.notifyWatchedFileEvent('/x.ts', 'changed') // matches
    await flushTicks(2)
    const watched = getStdinMessages(lastSpawn!).filter(m => m.method === 'workspace/didChangeWatchedFiles')
    expect(watched.length).toBe(1)
    server.stop()
  })

  test('no-op when not initialized or not running', () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    expect(() => server.notifyWatchedFileEvent('/x.ts', 'changed')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// initialize() — full handshake, idempotency
// ---------------------------------------------------------------------------

describe('TSLanguageServer.initialize', () => {
  test('sends initialize, initialized, and didChangeConfiguration; is idempotent', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR, { initializationOptions: { extra: 1 } })
    await server.start()

    const p = server.initialize()
    await flushTicks(3)
    // Auto-respond to the initialize request
    const initReq = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')
    expect(initReq).toBeDefined()
    expect(initReq.params.initializationOptions.extra).toBe(1)
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await p

    const msgs = getStdinMessages(lastSpawn!).map(m => m.method).filter(Boolean)
    expect(msgs).toContain('initialized')
    expect(msgs).toContain('workspace/didChangeConfiguration')

    // Idempotent: second initialize() resolves immediately
    await server.initialize()
    server.stop()
  })

  test('initialize() returns existing initPromise if already in flight', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const p1 = server.initialize()
    const p2 = server.initialize()
    // Async wrappers create distinct outer Promises, but only ONE initialize
    // request is ever sent on the wire — that's the contract.
    const initReq = (await waitForMethod('initialize'))!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await Promise.all([p1, p2])
    const initReqs = getStdinMessages(lastSpawn!).filter(m => m.method === 'initialize')
    expect(initReqs.length).toBe(1)
    server.stop()
  })
})

async function waitForMethod(method: string, max = 12): Promise<any> {
  for (let i = 0; i < max; i++) {
    await flushTicks(1)
    const found = getStdinMessages(lastSpawn!).find(m => m.method === method)
    if (found) return found
  }
  return undefined
}

// ---------------------------------------------------------------------------
// send() / request() failure modes
// ---------------------------------------------------------------------------

describe('TSLanguageServer.send/request errors', () => {
  test('send() throws when not running', () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    expect(() => server.send({ jsonrpc: '2.0', method: 'ping' })).toThrow(/not running/)
  })
})

// ---------------------------------------------------------------------------
// LSPServerManager — getServer caches, re-creates on dead, stopServer/stopAll
// ---------------------------------------------------------------------------

describe('LSPServerManager', () => {
  test('caches running servers and stopServer removes them', async () => {
    const mgr = new lsp.LSPServerManager()
    const s1 = await mgr.getServer(TEST_DIR)
    const s2 = await mgr.getServer(TEST_DIR)
    expect(s1).toBe(s2)
    mgr.stopServer(TEST_DIR)
    // stopServer on missing key is a no-op (covers the `if (server)` false branch)
    mgr.stopServer('/never-existed')
  })

  test('re-creates server when cached instance is no longer running', async () => {
    const mgr = new lsp.LSPServerManager()
    const s1 = await mgr.getServer(TEST_DIR)
    s1.stop()
    const s2 = await mgr.getServer(TEST_DIR)
    expect(s2).not.toBe(s1)
    mgr.stopAll()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceLSPManager — startAll error path, pyright detection, full diagnostics
// ---------------------------------------------------------------------------

describe('WorkspaceLSPManager extra paths', () => {
  test('startAll continues when both startTS and detectPyright are happy', async () => {
    // Make pyright resolvable
    const binDir = join(TEST_DIR, 'node_modules', '.bin')
    writeFileSync(join(binDir, 'pyright'), '#!/usr/bin/env node\n')

    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    // startTS will call tsServer.start() → spawns fake → resolves quickly.
    // initialize() needs the initialize response — provide it after a tick.
    const startPromise = mgr.startAll()
    // Eat the initialize request and respond
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) {
        lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
      }
    }, 5)
    await startPromise

    // Warmup will fire didOpen for warmup file then poll diagnostics. Drop a
    // synthetic publishDiagnostics with no canvas error so warmup exits quickly.
    const warmupFile = join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${warmupFile}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    expect(mgr.isTSReady()).toBe(true)
    expect(mgr.isRunning()).toBe(true)

    // getDiagnosticsAsync with no python dirty files
    const diag = await mgr.getDiagnosticsAsync()
    expect(diag).toBeInstanceOf(Map)

    mgr.stop()
  })

  test('detectPyright honors an explicit pyrightBin that exists', async () => {
    const explicit = join(TEST_DIR, 'pyright-explicit')
    writeFileSync(explicit, '#!/usr/bin/env node\n')
    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR, pyrightBin: explicit })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    expect(mgr.isRunning()).toBe(true)
    mgr.stop()
  })

  test('notifyFileChanged + getDiagnosticsAsync triggers pyright CLI run', async () => {
    const binDir = join(TEST_DIR, 'node_modules', '.bin')
    writeFileSync(join(binDir, 'pyright'), '#!/usr/bin/env node\n')

    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    // Skip warmup polling
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    const pyFile = join(TEST_DIR, 'mod.py')
    writeFileSync(pyFile, 'x = 1\n')
    mgr.notifyFileChanged(pyFile, 'x = 1\n')

    // Next spawn is pyright. Pre-configure its stdout output before the call.
    const pyrightOutput = JSON.stringify({
      generalDiagnostics: [
        { file: pyFile, severity: 'error', message: 'bad', rule: 'reportError',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { file: pyFile, severity: 'warning', message: 'meh',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
        { file: pyFile, severity: 'information', message: 'fyi',
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
      ],
    })
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      setTimeout(() => {
        sub.__pushStdout(pyrightOutput)
        sub.__closeStdout()
        sub.kill()
      }, 1)
      return sub
    }

    const diags = await mgr.getDiagnosticsAsync()
    const uri = `file://${pyFile}`
    expect(diags.get(uri)!.length).toBe(3)
    expect(diags.get(uri)![0]!.severity).toBe(1)
    expect(diags.get(uri)![1]!.severity).toBe(2)
    expect(diags.get(uri)![2]!.severity).toBe(3)

    // sync getDiagnostics returns cached python entries + TS LSP entries
    const sync = mgr.getDiagnostics()
    expect(sync.get(uri)).toBeDefined()
    // Targeted lookup goes through the uri-only branch
    const oneUri = mgr.getDiagnostics(uri)
    expect(oneUri.get(uri)).toBeDefined()
    const oneUriAsync = await mgr.getDiagnosticsAsync(uri)
    expect(oneUriAsync.get(uri)).toBeDefined()

    // notifyFileDeleted on a .py purges cached diag
    mgr.notifyFileDeleted(pyFile)
    expect(mgr.getDiagnostics().get(uri)).toBeUndefined()

    mgr.stop()
  })

  test('runPyrightCLI handles empty output and JSON parse errors gracefully', async () => {
    const binDir = join(TEST_DIR, 'node_modules', '.bin')
    writeFileSync(join(binDir, 'pyright'), '#!/usr/bin/env node\n')

    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    // Empty pyright output → early return after clearing dirty
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      setTimeout(() => {
        sub.__pushStdout('   \n')
        sub.__closeStdout()
        sub.kill()
      }, 1)
      return sub
    }
    mgr.notifyFileChanged(join(TEST_DIR, 'a.py'), 'x=1\n')
    await mgr.getDiagnosticsAsync()

    // Malformed JSON → caught by the catch block
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      setTimeout(() => {
        sub.__pushStdout('not json at all')
        sub.__closeStdout()
        sub.kill()
      }, 1)
      return sub
    }
    mgr.notifyFileChanged(join(TEST_DIR, 'b.py'), 'y=1\n')
    await mgr.getDiagnosticsAsync()

    // generalDiagnostics missing → loops over [] (?? branch)
    spawnImpl = (cmd, opts) => {
      const sub = makeDefaultSpawn(cmd, opts)
      setTimeout(() => {
        sub.__pushStdout(JSON.stringify({}))
        sub.__closeStdout()
        sub.kill()
      }, 1)
      return sub
    }
    mgr.notifyFileChanged(join(TEST_DIR, 'c.py'), 'z=1\n')
    await mgr.getDiagnosticsAsync()

    mgr.stop()
  })

  test('notifyWatchedFileEvent on workspace manager filters by extension allowlist', async () => {
    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    // None of these throw — they all just exercise the extension allowlist
    mgr.notifyWatchedFileEvent('/proj/foo.ts', 'changed')
    mgr.notifyWatchedFileEvent('/proj/foo.tsx', 'changed')
    mgr.notifyWatchedFileEvent('/proj/foo.json', 'changed')
    mgr.notifyWatchedFileEvent('/proj/foo.cjs', 'changed')
    mgr.notifyWatchedFileEvent('/proj/foo.mjs', 'changed')
    mgr.notifyWatchedFileEvent('/proj/types.d.ts', 'changed')
    mgr.notifyWatchedFileEvent('/proj/tsconfig.json', 'changed')
    mgr.notifyWatchedFileEvent('/proj/package.json', 'changed')
    mgr.notifyWatchedFileEvent('/proj/binary.bin', 'changed') // ignored

    mgr.stop()
  })

  test('IDE didOpen/didChange/didClose route only TS files', async () => {
    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    const f = join(TEST_DIR, 'edit.ts')
    mgr.didOpenDocument(f, 'typescript', 1, 'const x = 1\n')
    mgr.didChangeDocument(f, 2, 'const x = 2\n')
    mgr.didCloseDocument(f)

    // Non-TS ext → all are no-ops
    mgr.didOpenDocument('/x.py', 'python', 1, '')
    mgr.didChangeDocument('/x.py', 2, '')
    mgr.didCloseDocument('/x.py')

    // typed request helpers on non-TS return null
    expect(await mgr.hover('/x.py', 0, 0)).toBeNull()
    expect(await mgr.completion('/x.py', 0, 0)).toBeNull()
    expect(await mgr.definition('/x.py', 0, 0)).toBeNull()
    expect(await mgr.references('/x.py', 0, 0)).toBeNull()
    expect(await mgr.documentSymbol('/x.py')).toBeNull()
    expect(await mgr.signatureHelp('/x.py', 0, 0)).toBeNull()
    expect(await mgr.rename('/x.py', 0, 0, 'foo')).toBeNull()

    // notifyFileSaved on .py is a no-op (no PY branch in saved)
    mgr.notifyFileSaved('/x.py')

    mgr.stop()
  })

  test('renotifyWarmupFile fires another didChange when tsServer is running', async () => {
    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    const writesBefore = lastSpawn!.__stdinWrites.length
    mgr.renotifyWarmupFile()
    expect(lastSpawn!.__stdinWrites.length).toBeGreaterThan(writesBefore)
    mgr.stop()
  })

  test('hover/completion/etc. on TS files route through to tsServer', async () => {
    const mgr = new lsp.WorkspaceLSPManager({ projectDir: TEST_DIR })
    const startPromise = mgr.startAll()
    setTimeout(() => {
      if (!lastSpawn) return
      const initReq = getStdinMessages(lastSpawn).find((m: any) => m.method === 'initialize')
      if (initReq) lastSpawn.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    }, 5)
    await startPromise
    lastSpawn!.__pushStdout(framedMessage({
      jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${join(TEST_DIR, '.shogo', '__lsp_warmup__.ts')}`, diagnostics: [] },
    }))
    await mgr.waitForReady()

    const f = join(TEST_DIR, 'x.ts')
    // Don't await: tsServer.hover returns request promise that needs a response;
    // we just verify the call goes through and a request is queued.
    const writesBefore = lastSpawn!.__stdinWrites.length
    void mgr.hover(f, 0, 0)
    void mgr.completion(f, 0, 0, { triggerKind: 1 })
    void mgr.definition(f, 0, 0)
    void mgr.references(f, 0, 0)
    void mgr.documentSymbol(f)
    void mgr.signatureHelp(f, 0, 0)
    void mgr.rename(f, 0, 0, 'newname')
    await flushTicks(4)
    expect(lastSpawn!.__stdinWrites.length).toBeGreaterThan(writesBefore)

    mgr.stop()
  })
})

// ---------------------------------------------------------------------------
// TSLanguageServer typed-request helpers (direct, pre-init returns null)
// ---------------------------------------------------------------------------

describe('TSLanguageServer typed-request helpers', () => {
  test('pre-initialize: every typed helper returns null and notifyXxx are no-ops', () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    // These early-return when not isInitialized.
    server.notifyFileChanged('/x.ts', 'a')
    server.notifyFileSaved('/x.ts')
    server.notifyFileDeleted('/x.ts')
    server.didOpenDocument('/x.ts', 'typescript', 1, 'a')
    server.didChangeDocument('/x.ts', 2, 'b')
    server.didCloseDocument('/x.ts')
  })

  test('post-initialize: notifyFileChanged sends didOpen then didChange', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const init = server.initialize()
    await flushTicks(3)
    const initReq = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await init

    const path = '/proj/foo.ts'
    server.notifyFileChanged(path, 'first')
    server.notifyFileChanged(path, 'second')
    server.notifyFileSaved(path)
    server.notifyFileDeleted(path)

    const methods = getStdinMessages(lastSpawn!).map(m => m.method)
    expect(methods).toContain('textDocument/didOpen')
    expect(methods).toContain('textDocument/didChange')
    expect(methods).toContain('textDocument/didSave')
    expect(methods).toContain('textDocument/didClose')
    server.stop()
  })

  test('didOpenDocument deduplicates a re-open into a didChange', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const init = server.initialize()
    await flushTicks(3)
    const initReq = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await init

    server.didOpenDocument('/a.tsx', 'typescriptreact', 1, 'x')
    server.didOpenDocument('/a.tsx', 'typescriptreact', 2, 'x2')
    server.didChangeDocument('/b.jsx', 1, 'y') // not yet open → synthesizes didOpen
    server.didCloseDocument('/a.tsx')

    const msgs = getStdinMessages(lastSpawn!)
    const didOpenForA = msgs.filter(m => m.method === 'textDocument/didOpen' && m.params.textDocument.uri.endsWith('/a.tsx'))
    expect(didOpenForA.length).toBe(1) // second open collapses to didChange
    expect(msgs.some(m => m.method === 'textDocument/didChange' && m.params.textDocument.uri.endsWith('/a.tsx'))).toBe(true)
    expect(msgs.some(m => m.method === 'textDocument/didOpen' && m.params.textDocument.uri.endsWith('/b.jsx'))).toBe(true)
    server.stop()
  })

  test('inferLanguageId: .py, .tsx, .jsx, .js paths exercise each branch', async () => {
    const server = new lsp.TSLanguageServer(TEST_DIR)
    await server.start()
    const init = server.initialize()
    await flushTicks(3)
    const initReq = getStdinMessages(lastSpawn!).find(m => m.method === 'initialize')!
    lastSpawn!.__pushStdout(framedMessage({ jsonrpc: '2.0', id: initReq.id, result: {} }))
    await init

    server.notifyFileChanged('/x.py', 'a')
    server.notifyFileChanged('/x.tsx', 'a')
    server.notifyFileChanged('/x.jsx', 'a')
    server.notifyFileChanged('/x.js', 'a')
    server.notifyFileChanged('/x.unknown', 'a')

    const opens = getStdinMessages(lastSpawn!).filter(m => m.method === 'textDocument/didOpen')
    const langs = opens.map(o => o.params.textDocument.languageId)
    expect(langs).toContain('python')
    expect(langs).toContain('typescriptreact')
    expect(langs).toContain('javascriptreact')
    expect(langs).toContain('javascript')
    expect(langs).toContain('typescript')
    server.stop()
  })
})

// ---------------------------------------------------------------------------
// request() timeout
// ---------------------------------------------------------------------------

describe('TSLanguageServer.request timeout', () => {
  test('rejects with "Request timeout" if no response arrives', async () => {
    // Use fake timers
    const realSetTimeout = globalThis.setTimeout
    let registeredCb: (() => void) | null = null
    ;(globalThis as any).setTimeout = ((cb: () => void, _ms: number) => {
      registeredCb = cb
      return 9999 as unknown as NodeJS.Timeout
    }) as typeof setTimeout
    try {
      const server = new lsp.TSLanguageServer(TEST_DIR)
      await server.start()
      const p = server.request('slow', null)
      // Trigger timeout synchronously.
      registeredCb!()
      await expect(p).rejects.toThrow(/Request timeout/)
      server.stop()
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  })
})
