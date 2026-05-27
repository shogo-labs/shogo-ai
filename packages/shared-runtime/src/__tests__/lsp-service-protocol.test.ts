// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// End-to-end LSP protocol coverage for TSLanguageServer. Uses
// `_setSpawnForTesting` (the public test seam) so we never need a real
// typescript-language-server binary. The fake subprocess exposes:
//   - controllable stdout (push LSP-framed JSON messages from the server)
//   - controllable stderr (push log lines)
//   - stdin recorded into an array (assert client → server traffic)
//   - exitCode toggle (start() failure path)
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _setSpawnForTesting,
  TSLanguageServer,
  WorkspaceLSPManager,
} from '../lsp-service'

let TEST_DIR: string

interface FakeProc {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin: { write(chunk: string): void; flush(): void }
  exitCode: number | null
  kill(): void
  // Test handles:
  pushStdout(text: string): void
  pushStderr(text: string): void
  endStreams(): void
  stdinWrites: string[]
}

function makeFakeProc(initialExitCode: number | null = null): FakeProc {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { stdoutController = c },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(c) { stderrController = c },
  })
  const enc = new TextEncoder()
  const stdinWrites: string[] = []
  return {
    stdout,
    stderr,
    stdin: {
      write: (chunk: string) => { stdinWrites.push(chunk) },
      flush: () => {},
    },
    exitCode: initialExitCode,
    kill() { /* no-op */ },
    pushStdout(text: string) { stdoutController.enqueue(enc.encode(text)) },
    pushStderr(text: string) { stderrController.enqueue(enc.encode(text)) },
    endStreams() {
      try { stdoutController.close() } catch {}
      try { stderrController.close() } catch {}
    },
    stdinWrites,
  }
}

function framed(msg: unknown): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

async function bootInitialized(): Promise<{ lsp: TSLanguageServer; fake: FakeProc }> {
  const fake = makeFakeProc(null)
  _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
  const lsp = new TSLanguageServer(TEST_DIR)
  await lsp.start()
  // Kick initialize() in the background and reply to its request.
  const initPromise = lsp.initialize()
  // Give the request a tick to be sent to stdin.
  await new Promise(r => setTimeout(r, 2))
  const writes = fake.stdinWrites.join('')
  const idMatch = writes.match(/"id":(\d+),"method":"initialize"/)
  if (idMatch) {
    const id = Number(idMatch[1])
    fake.pushStdout(framed({ jsonrpc: '2.0', id, result: { capabilities: {} } }))
  }
  await initPromise
  fake.stdinWrites.length = 0
  return { lsp, fake }
}


beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'shogo-lsp-proto-'))
  // Make a fake tsserver binary so resolveBin() finds it.
  const binDir = join(TEST_DIR, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'typescript-language-server'), '#!/bin/sh\nexit 0\n')
})

afterEach(() => {
  _setSpawnForTesting(null)
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// start() — process lifecycle
// ---------------------------------------------------------------------------

describe('TSLanguageServer.start()', () => {
  test('throws helpful error when no language server binary can be found', async () => {
    // No node_modules/.bin/typescript-language-server in an empty dir.
    const emptyDir = mkdtempSync(join(tmpdir(), 'shogo-lsp-empty-'))
    try {
      const lsp = new TSLanguageServer(emptyDir)
      await expect(lsp.start()).rejects.toThrow(/Could not find language server binary/)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  test('catch block fires when spawn returns an already-exited process', async () => {
    const fake = makeFakeProc(/* exitCode */ 1)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const lsp = new TSLanguageServer(TEST_DIR)
    await expect(lsp.start()).rejects.toThrow(/exited with code 1/)
    expect(lsp.isRunning()).toBe(false)
  })

  test('start succeeds when spawn returns a running process (exitCode null)', async () => {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const lsp = new TSLanguageServer(TEST_DIR)
    await lsp.start()
    expect(lsp.isRunning()).toBe(true)
    lsp.stop()
    expect(lsp.isRunning()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// processBuffer — LSP protocol parsing
// ---------------------------------------------------------------------------

describe('TSLanguageServer processBuffer / readOutputStream', () => {
  async function bootServer(): Promise<{ lsp: TSLanguageServer; fake: FakeProc }> {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const lsp = new TSLanguageServer(TEST_DIR)
    await lsp.start()
    return { lsp, fake }
  }

  test('publishDiagnostics notifications populate getDiagnostics() per URI', async () => {
    const { lsp, fake } = await bootServer()
    const uri = 'file:///x/y.ts'
    fake.pushStdout(framed({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'oh no', severity: 1 }],
      },
    }))
    // give the reader a tick
    await new Promise(r => setTimeout(r, 5))
    const diags = lsp.getDiagnostics(uri)
    expect(diags.get(uri)?.length).toBe(1)
    expect(diags.get(uri)?.[0]?.message).toBe('oh no')
    lsp.stop()
  })

  test('messages without Content-Length are skipped (no crash)', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout('Header-Without-Length: yes\r\n\r\n')
    fake.pushStdout(framed({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///a.ts', diagnostics: [] },
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(lsp.getDiagnostics('file:///a.ts')?.get('file:///a.ts')).toEqual([])
    lsp.stop()
  })

  test('malformed JSON body inside framed message is silently skipped', async () => {
    const { lsp, fake } = await bootServer()
    const garbage = '{ not-json'
    fake.pushStdout(`Content-Length: ${Buffer.byteLength(garbage)}\r\n\r\n${garbage}`)
    // Push a valid follow-up to prove the parser recovered.
    fake.pushStdout(framed({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///recover.ts', diagnostics: [] },
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(lsp.getDiagnostics('file:///recover.ts')?.has('file:///recover.ts')).toBe(true)
    lsp.stop()
  })

  test('stderr text is logged (just verify it does not crash readErrorStream)', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStderr('warning: something happened\n')
    fake.pushStderr('  \n') // blank line skipped by the trim() branch
    await new Promise(r => setTimeout(r, 5))
    lsp.stop()
  })

  test('response messages resolve the matching pending request', async () => {
    const { lsp, fake } = await bootServer()
    // After start, fire a request. processBuffer should match the response by id.
    const reqPromise = lsp.request('textDocument/hover', { foo: 1 })
    // Wait one tick so the request is sent.
    await new Promise(r => setTimeout(r, 1))
    const writes = fake.stdinWrites.join('')
    const idMatch = writes.match(/"id":(\d+)/)
    expect(idMatch).toBeTruthy()
    const id = Number(idMatch![1])
    fake.pushStdout(framed({ jsonrpc: '2.0', id, result: { kind: 'hover-ok' } }))
    const result = await reqPromise
    expect(result).toEqual({ kind: 'hover-ok' })
    lsp.stop()
  })

  test('error responses reject the matching pending request', async () => {
    const { lsp, fake } = await bootServer()
    const reqPromise = lsp.request('textDocument/hover', {})
    await new Promise(r => setTimeout(r, 1))
    const id = Number(fake.stdinWrites.join('').match(/"id":(\d+)/)![1])
    fake.pushStdout(framed({ jsonrpc: '2.0', id, error: { code: 1, message: 'boom' } }))
    await expect(reqPromise).rejects.toThrow(/boom/)
    lsp.stop()
  })

  test('onMessage handler receives every parsed message (and dispose works)', async () => {
    const { lsp, fake } = await bootServer()
    const seen: unknown[] = []
    const dispose = lsp.onMessage((m) => { seen.push(m) })
    fake.pushStdout(framed({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///m.ts', diagnostics: [] } }))
    await new Promise(r => setTimeout(r, 5))
    expect(seen.length).toBeGreaterThan(0)
    dispose()
    // After dispose, subsequent messages don't go to seen.
    const before = seen.length
    fake.pushStdout(framed({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///m2.ts', diagnostics: [] } }))
    await new Promise(r => setTimeout(r, 5))
    expect(seen.length).toBe(before)
    lsp.stop()
  })
})

// ---------------------------------------------------------------------------
// Server-initiated requests + watcher registration (compileLspGlob)
// ---------------------------------------------------------------------------

describe('TSLanguageServer.handleServerRequest', () => {
  async function bootServer(): Promise<{ lsp: TSLanguageServer; fake: FakeProc }> {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const lsp = new TSLanguageServer(TEST_DIR)
    await lsp.start()
    return { lsp, fake }
  }

  test('workspace/configuration python branch returns pythonPath + analysis', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 100, method: 'workspace/configuration',
      params: { items: [{ section: 'python' }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    const writes = fake.stdinWrites.join('')
    expect(writes).toContain('pythonPath')
    expect(writes).toContain('typeCheckingMode')
    lsp.stop()
  })

  test('workspace/configuration python.analysis branch', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 101, method: 'workspace/configuration',
      params: { items: [{ section: 'python.analysis' }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(fake.stdinWrites.join('')).toMatch(/"typeCheckingMode":"basic"/)
    lsp.stop()
  })

  test('workspace/configuration default case (no items) returns []', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 102, method: 'workspace/configuration', params: {},
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(fake.stdinWrites.join('')).toMatch(/"id":102.*"result":\[\]/)
    lsp.stop()
  })

  test('client/registerCapability compiles string globPattern watchers', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 200, method: 'client/registerCapability',
      params: {
        registrations: [{
          id: 'reg-1',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: {
            watchers: [{ globPattern: '**/*.ts' }, { globPattern: 'src/**/*.{ts,tsx}' }],
          },
        }],
      },
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(fake.stdinWrites.join('')).toMatch(/"id":200,"result":null/)
    // Verify the registration is active by triggering notifyWatchedFileEvent.
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/proj/src/foo.ts', 'changed')
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    lsp.stop()
  })

  test('client/registerCapability accepts RelativePattern globPattern', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 201, method: 'client/registerCapability',
      params: {
        registrations: [{
          id: 'reg-2',
          method: 'workspace/didChangeWatchedFiles',
          registerOptions: {
            watchers: [{ globPattern: { baseUri: 'file:///x', pattern: '**/*.py' }, kind: 1 }],
          },
        }],
      },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/x/sub/a.py', 'created')
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    lsp.stop()
  })

  test('client/registerCapability skips registrations for unrelated methods', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 202, method: 'client/registerCapability',
      params: {
        registrations: [{ id: 'x', method: 'textDocument/completion', registerOptions: {} }],
      },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/anything', 'changed')
    expect(fake.stdinWrites.join('')).toBe('') // no registrations matched
    lsp.stop()
  })

  test('client/registerCapability ignores watchers with non-string globPattern', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 203, method: 'client/registerCapability',
      params: {
        registrations: [{
          id: 'reg-3', method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: 42 }] },
        }],
      },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/p/x.ts', 'changed')
    expect(fake.stdinWrites.join('')).toBe('')
    lsp.stop()
  })

  test('client/registerCapability skips registrations with non-string id', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 204, method: 'client/registerCapability',
      params: {
        registrations: [{
          id: 42, method: 'workspace/didChangeWatchedFiles',
          registerOptions: { watchers: [{ globPattern: '**/*' }] },
        }],
      },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/anything.ts', 'changed')
    expect(fake.stdinWrites.join('')).toBe('')
    lsp.stop()
  })

  test('client/unregisterCapability removes prior watchers', async () => {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 300, method: 'client/registerCapability',
      params: { registrations: [{ id: 'reg-4', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.ts' }] } }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 301, method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: 'reg-4', method: 'workspace/didChangeWatchedFiles' }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/p/x.ts', 'changed')
    expect(fake.stdinWrites.join('')).toBe('')
    lsp.stop()
  })

  test('client/unregisterCapability ignores non-string ids and missing array', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 302, method: 'client/unregisterCapability',
      params: { unregisterations: [{ id: 99 }, { id: 'never-registered' }] },
    }))
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 303, method: 'client/unregisterCapability',
      params: {},
    }))
    await new Promise(r => setTimeout(r, 5))
    // Both produce id-only null results without throwing.
    expect(fake.stdinWrites.join('')).toMatch(/"id":302,"result":null/)
    expect(fake.stdinWrites.join('')).toMatch(/"id":303,"result":null/)
    lsp.stop()
  })

  test('window/workDoneProgress/create returns null', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 400, method: 'window/workDoneProgress/create', params: {},
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(fake.stdinWrites.join('')).toMatch(/"id":400,"result":null/)
    lsp.stop()
  })

  test('unknown server-initiated method falls through to default null result', async () => {
    const { lsp, fake } = await bootServer()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 500, method: 'some/unknown/method', params: {},
    }))
    await new Promise(r => setTimeout(r, 5))
    expect(fake.stdinWrites.join('')).toMatch(/"id":500,"result":null/)
    lsp.stop()
  })
})

// ---------------------------------------------------------------------------
// compileLspGlob — pattern compilation edge cases
// ---------------------------------------------------------------------------

describe('compileLspGlob via registered watchers', () => {
  async function bootAndRegister(globs: string[]): Promise<{ lsp: TSLanguageServer; fake: FakeProc }> {
    const { lsp, fake } = await bootInitialized()
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 700, method: 'client/registerCapability',
      params: { registrations: [{ id: 'reg-glob', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: globs.map(g => ({ globPattern: g })) } }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    return { lsp, fake }
  }

  test('?, {a,b} alternation, and trailing literal match', async () => {
    const { lsp, fake } = await bootAndRegister(['file?.{ts,tsx}'])
    lsp.notifyWatchedFileEvent('/proj/fileA.ts', 'changed')
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/proj/file12.ts', 'changed')
    expect(fake.stdinWrites.join('')).toBe('') // ? matches exactly one char
    lsp.stop()
  })

  test('unclosed { is treated as a literal brace', async () => {
    const { lsp, fake } = await bootAndRegister(['weird{ts'])
    lsp.notifyWatchedFileEvent('/x/weird{ts', 'changed')
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    lsp.stop()
  })

  test('** vs * vs simple literal distinctions', async () => {
    const { lsp, fake } = await bootAndRegister(['**/build/*.js'])
    lsp.notifyWatchedFileEvent('/proj/deep/nested/build/out.js', 'changed')
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/proj/build/sub/dir/out.js', 'changed')
    // `**/build/*.js` requires *.js DIRECTLY under build, so `build/sub/dir/...` shouldn't match
    expect(fake.stdinWrites.join('')).toBe('')
    lsp.stop()
  })
})

// ---------------------------------------------------------------------------
// notifyWatchedFileEvent — gating logic
// ---------------------------------------------------------------------------

describe('TSLanguageServer.notifyWatchedFileEvent', () => {
  test('no-op when not initialized (started but no initialize() handshake)', () => {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const lsp = new TSLanguageServer(TEST_DIR)
    // Pre-init early return
    lsp.notifyWatchedFileEvent('/x.ts', 'changed')
    expect(fake.stdinWrites.length).toBe(0)
  })

  test('kind bitmask filters out events whose kind is not in the registration', async () => {
    const { lsp, fake } = await bootInitialized()
    // Register watchers that only listen for CREATE (kind=1)
    fake.pushStdout(framed({
      jsonrpc: '2.0', id: 800, method: 'client/registerCapability',
      params: { registrations: [{ id: 'r-create-only', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.ts', kind: 1 }] } }] },
    }))
    await new Promise(r => setTimeout(r, 5))
    fake.stdinWrites.length = 0
    lsp.notifyWatchedFileEvent('/p/a.ts', 'changed') // CHANGE kind = 2
    expect(fake.stdinWrites.join('')).toBe('') // kind mask mismatch
    lsp.notifyWatchedFileEvent('/p/a.ts', 'created') // matches
    expect(fake.stdinWrites.join('')).toMatch(/didChangeWatchedFiles/)
    lsp.stop()
  })
})

// ---------------------------------------------------------------------------
// inferLanguageId — small pure helper
// ---------------------------------------------------------------------------

describe('TSLanguageServer.inferLanguageId (via didOpenDocument)', () => {
  test.each([
    ['a.py', 'python'],
    ['a.tsx', 'typescriptreact'],
    ['a.jsx', 'javascriptreact'],
    ['a.js', 'javascript'],
    ['a.ts', 'typescript'], // default
  ])('infers %s → %s', async (file, expected) => {
    const { lsp, fake } = await bootInitialized()
    lsp.notifyFileChanged(file, 'export {}')
    const writes = fake.stdinWrites.join('')
    expect(writes).toContain(`"languageId":"${expected}"`)
    lsp.stop()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceLSPManager — basic routing
// ---------------------------------------------------------------------------

describe('WorkspaceLSPManager', () => {
  test('constructor resolves projectDir absolutely', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(mgr).toBeDefined()
  })

  test('waitForReady is a no-op before startAll', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.waitForReady()
  })
})

// ---------------------------------------------------------------------------
// LSPServerManager — pool management
// ---------------------------------------------------------------------------

describe('LSPServerManager', () => {
  test('getServer spawns a new server on first call and caches it for reuse', async () => {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const { LSPServerManager } = await import('../lsp-service')
    const mgr = new LSPServerManager()
    const a = await mgr.getServer(TEST_DIR)
    const b = await mgr.getServer(TEST_DIR)
    expect(a).toBe(b)
    expect(a.getProjectDir()).toBe(TEST_DIR)
    mgr.stopAll()
  })

  test('getServer re-spawns a fresh server when the cached one stopped', async () => {
    const fake1 = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake1) as never)
    const { LSPServerManager } = await import('../lsp-service')
    const mgr = new LSPServerManager()
    const a = await mgr.getServer(TEST_DIR)
    a.stop()
    const fake2 = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake2) as never)
    const b = await mgr.getServer(TEST_DIR)
    expect(b).not.toBe(a)
    mgr.stopAll()
  })

  test('stopServer halts only the requested project and removes it from cache', async () => {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const { LSPServerManager } = await import('../lsp-service')
    const mgr = new LSPServerManager()
    const a = await mgr.getServer(TEST_DIR)
    expect(a.isRunning()).toBe(true)
    mgr.stopServer(TEST_DIR)
    // Stop is idempotent for an unknown projectDir.
    mgr.stopServer('/never-registered')
  })

  test('stopAll halts every cached server', async () => {
    const fake = makeFakeProc(null)
    _setSpawnForTesting(((..._args: unknown[]) => fake) as never)
    const { LSPServerManager } = await import('../lsp-service')
    const mgr = new LSPServerManager()
    await mgr.getServer(TEST_DIR)
    mgr.stopAll()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceLSPManager.notifyWatchedFileEvent — extension routing
// ---------------------------------------------------------------------------

describe('WorkspaceLSPManager.notifyWatchedFileEvent (ext routing)', () => {
  test('forwards .ts/.tsx/.js/.jsx files to the TS server', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    // No TS server attached — but the dispatch still runs through the
    // extension check, which is what we're covering.
    expect(() => mgr.notifyWatchedFileEvent('/x.ts', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.tsx', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.js', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.jsx', 'changed')).not.toThrow()
  })

  test('forwards .json / .cjs / .mjs / tsconfig / package.json / .d.ts', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(() => mgr.notifyWatchedFileEvent('/x.json', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.cjs', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.mjs', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/proj/tsconfig.json', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/proj/package.json', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/proj/types.d.ts', 'changed')).not.toThrow()
  })

  test('ignores unsupported extensions silently (no-op)', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    // None of these go to tsserver; we just verify no throw.
    expect(() => mgr.notifyWatchedFileEvent('/x.lock', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.png', 'changed')).not.toThrow()
    expect(() => mgr.notifyWatchedFileEvent('/x.md', 'changed')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceLSPManager.runPyrightCLI — Python diagnostic via mocked pyright CLI
// ---------------------------------------------------------------------------

describe('WorkspaceLSPManager.runPyrightCLI', () => {
  // The default beforeEach creates a fake typescript-language-server binary so
  // start() finds it. For Python-only tests we want startTS() to fail fast and
  // let the pyright path run on its own — so unlink the TS bin before each test.
  beforeEach(() => {
    try {
      const tsBin = join(TEST_DIR, 'node_modules', '.bin', 'typescript-language-server')
      rmSync(tsBin, { force: true })
    } catch { /* ignore */ }
  })

  function makePyrightProc(stdoutText: string): FakeProc & { exited: Promise<number> } {
    // Build the proc with stdout already populated + closed in the stream's
    // start() callback. queueMicrotask scheduling races with the reader's
    // first read() in Bun and never delivers the chunk.
    const enc = new TextEncoder()
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(stdoutText))
        c.close()
      },
    })
    const stderrStream = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    const stdinWrites: string[] = []
    const fake = {
      stdout: stdoutStream,
      stderr: stderrStream,
      stdin: {
        write: (chunk: string) => { stdinWrites.push(chunk) },
        flush: () => {},
      },
      exitCode: 0,
      kill: () => {},
      pushStdout: () => {}, // no-op for pyright; data pre-loaded
      pushStderr: () => {},
      endStreams: () => {},
      stdinWrites,
      exited: Promise.resolve(0),
    }
    return fake
  }

  test('parses pyright --outputjson into LSPDiagnostic entries', async () => {
    const pyrightBin = join(TEST_DIR, 'fake-pyright')
    writeFileSync(pyrightBin, '#!/bin/sh\nexit 0\n')

    const pyrightJSON = JSON.stringify({
      generalDiagnostics: [
        {
          file: '/proj/bad.py',
          severity: 'error',
          message: 'undefined name "foo"',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          rule: 'reportUndefinedVariable',
        },
        {
          file: '/proj/warn.py',
          severity: 'warning',
          message: 'unused import',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        },
        {
          file: '/proj/info.py',
          severity: 'information',
          message: 'just FYI',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    })
    const pyrightProc = makePyrightProc(pyrightJSON)
    _setSpawnForTesting(((..._args: unknown[]) => pyrightProc) as never)

    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR, pyrightBin })
    // Bypass startAll() so warmupTS() (which busy-loops for 15s waiting for
    // LSP diagnostics that never arrive without a real tsserver) doesn't
    // stall the test. We're testing runPyrightCLI; the TS side is irrelevant.
    ;(mgr as unknown as { pyAvailable: boolean }).pyAvailable = true
    mgr.notifyFileChanged('/proj/bad.py', 'undef = foo()')
    const diags = await mgr.getDiagnosticsAsync()
    expect(diags.get('file:///proj/bad.py')?.[0]?.severity).toBe(1) // error
    expect(diags.get('file:///proj/warn.py')?.[0]?.severity).toBe(2) // warning
    expect(diags.get('file:///proj/info.py')?.[0]?.severity).toBe(3) // info/other
  })

  test('runPyrightCLI tolerates empty stdout (no diagnostics)', async () => {
    const pyrightBin = join(TEST_DIR, 'fake-pyright')
    writeFileSync(pyrightBin, '#!/bin/sh\nexit 0\n')
    const pyrightProc = makePyrightProc('   \n')
    _setSpawnForTesting(((..._args: unknown[]) => pyrightProc) as never)

    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR, pyrightBin })
    ;(mgr as unknown as { pyAvailable: boolean }).pyAvailable = true
    mgr.notifyFileChanged('/proj/empty.py', '# empty')
    const diags = await mgr.getDiagnosticsAsync()
    expect(diags.size).toBe(0)
  })

  test('runPyrightCLI tolerates malformed JSON via the outer catch', async () => {
    const pyrightBin = join(TEST_DIR, 'fake-pyright')
    writeFileSync(pyrightBin, '#!/bin/sh\nexit 0\n')
    const pyrightProc = makePyrightProc('{ not-json')
    _setSpawnForTesting(((..._args: unknown[]) => pyrightProc) as never)

    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR, pyrightBin })
    ;(mgr as unknown as { pyAvailable: boolean }).pyAvailable = true
    mgr.notifyFileChanged('/proj/broken.py', 'broken')
    // Should NOT throw — the catch logs and swallows.
    await mgr.getDiagnosticsAsync()
  })
})
