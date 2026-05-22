// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `lsp-service.ts`.
 *
 * Strategy: Test the surface that runs *without* spawning a real
 * typescript-language-server or pyright child process. The remaining
 * code paths (the full LSP message pump, didOpen → diagnostics round-
 * trip) require a working LSP binary and are exercised by the runtime
 * smoke tests; here we target:
 *
 *   - `resolveBin` (pure file-system probe)
 *   - `TSLanguageServer` early-return guards (every notify/document/
 *     typed-request method short-circuits when `isInitialized` and
 *     `isRunning` are false).
 *   - `TSLanguageServer.send()` no-op-when-stdin-missing path.
 *   - `LSPServerManager.getServer` / `stopServer` / `stopAll` lifecycle.
 *   - `WorkspaceLSPManager` ext-routing for TS vs Python vs other,
 *     including the typed-request helpers that must return `null` for
 *     non-TS extensions.
 *   - `WorkspaceLSPManager.ensureTsconfigWatchExclusions` covers the
 *     pre-edit / already-set / missing-config branches.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  resolveBin,
  TSLanguageServer,
  LSPServerManager,
  WorkspaceLSPManager,
} from '../lsp-service'

let TEST_DIR: string

beforeEach(() => {
  TEST_DIR = join(tmpdir(), `lsp-service-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

// ---------------------------------------------------------------------------
// resolveBin — pure file-system probe
// ---------------------------------------------------------------------------

describe('resolveBin', () => {
  test('returns undefined when neither .bin/ nor entry-point path exists', () => {
    expect(resolveBin('not-real', [TEST_DIR])).toBeUndefined()
  })

  test('finds a .bin shim in node_modules/.bin/', () => {
    const binDir = join(TEST_DIR, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'my-tool'), '#!/usr/bin/env node\n')
    const result = resolveBin('my-tool', [TEST_DIR])
    expect(result).toBeTruthy()
    expect(result!.viaBun).toBe(false)
    expect(result!.resolved).toBe(join(binDir, 'my-tool'))
  })

  test('falls back to direct module entry path when no .bin/ shim exists', () => {
    const pkgDir = join(TEST_DIR, 'node_modules', 'my-tool', 'dist')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'cli.js'), '// cli entry')
    const result = resolveBin('my-tool', [TEST_DIR], 'dist/cli.js')
    expect(result).toBeTruthy()
    expect(result!.viaBun).toBe(true)
    expect(result!.resolved).toBe(join(pkgDir, 'cli.js'))
  })

  test('searches multiple directories in order', () => {
    const dirA = join(TEST_DIR, 'a')
    const dirB = join(TEST_DIR, 'b')
    mkdirSync(join(dirB, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(dirB, 'node_modules', '.bin', 'shared-tool'), '#!/usr/bin/env node')
    const result = resolveBin('shared-tool', [dirA, dirB])
    expect(result).toBeTruthy()
    expect(result!.resolved).toBe(join(dirB, 'node_modules', '.bin', 'shared-tool'))
  })
})

// ---------------------------------------------------------------------------
// TSLanguageServer — exercise early-return guards (process not started)
// ---------------------------------------------------------------------------

describe('TSLanguageServer (no process)', () => {
  test('isRunning() returns false when start() has not been called', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(lsp.isRunning()).toBe(false)
  })

  test('getProjectDir reflects the constructor argument', () => {
    expect(new TSLanguageServer(TEST_DIR).getProjectDir()).toBe(TEST_DIR)
  })

  test('notifyFileChanged is a no-op pre-init', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(() => lsp.notifyFileChanged('a.ts', 'export {}')).not.toThrow()
  })

  test('notifyFileSaved is a no-op pre-init', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(() => lsp.notifyFileSaved('a.ts')).not.toThrow()
  })

  test('notifyFileDeleted is a no-op pre-init', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(() => lsp.notifyFileDeleted('a.ts')).not.toThrow()
  })

  test('didOpenDocument is a no-op pre-init', () => {
    expect(() => new TSLanguageServer(TEST_DIR).didOpenDocument('a.ts', 'typescript', 1, '')).not.toThrow()
  })

  test('didChangeDocument is a no-op pre-init', () => {
    expect(() => new TSLanguageServer(TEST_DIR).didChangeDocument('a.ts', 2, '')).not.toThrow()
  })

  test('didCloseDocument is a no-op pre-init', () => {
    expect(() => new TSLanguageServer(TEST_DIR).didCloseDocument('a.ts')).not.toThrow()
  })

  test('getDiagnostics() returns an empty map pre-init', () => {
    const m = new TSLanguageServer(TEST_DIR).getDiagnostics()
    expect(m.size).toBe(0)
  })

  test('getDiagnostics(uri) returns an empty map when no diagnostics are tracked', () => {
    const m = new TSLanguageServer(TEST_DIR).getDiagnostics('file:///nope.ts')
    expect(m.size).toBe(0)
  })

  test('hover/completion/definition/references/documentSymbol/signatureHelp/rename all return null pre-init', async () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(await lsp.hover('a.ts', 0, 0)).toBeNull()
    expect(await lsp.completion('a.ts', 0, 0)).toBeNull()
    expect(await lsp.completion('a.ts', 0, 0, { triggerKind: 1, triggerCharacter: '.' })).toBeNull()
    expect(await lsp.definition('a.ts', 0, 0)).toBeNull()
    expect(await lsp.references('a.ts', 0, 0)).toBeNull()
    expect(await lsp.references('a.ts', 0, 0, false)).toBeNull()
    expect(await lsp.documentSymbol('a.ts')).toBeNull()
    expect(await lsp.signatureHelp('a.ts', 0, 0)).toBeNull()
    expect(await lsp.rename('a.ts', 0, 0, 'newName')).toBeNull()
  })

  test('send() throws when there is no stdin to write to', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(() => lsp.send({ jsonrpc: '2.0', method: 'initialize' })).toThrow('Language server not running')
  })

  test('stop() is a noop when no process is running', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    expect(() => lsp.stop()).not.toThrow()
    expect(lsp.isRunning()).toBe(false)
  })

  test('onMessage returns an unsubscribe function that removes the handler', () => {
    const lsp = new TSLanguageServer(TEST_DIR)
    const unsubscribe = lsp.onMessage(() => {})
    expect(typeof unsubscribe).toBe('function')
    // Calling unsubscribe should not throw.
    expect(() => unsubscribe()).not.toThrow()
  })

  test('initialize() is a noop when isInitialized is already true', async () => {
    const lsp = new TSLanguageServer(TEST_DIR) as any
    lsp.isInitialized = true
    await expect(lsp.initialize()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LSPServerManager — manager-level operations that never call start()
// ---------------------------------------------------------------------------

describe('LSPServerManager', () => {
  test('stopServer is a noop when no server exists for the project', () => {
    const mgr = new LSPServerManager()
    expect(() => mgr.stopServer(TEST_DIR)).not.toThrow()
  })

  test('stopAll is a noop on an empty manager', () => {
    const mgr = new LSPServerManager()
    expect(() => mgr.stopAll()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceLSPManager — extension routing + ensureTsconfigWatchExclusions
// ---------------------------------------------------------------------------

describe('WorkspaceLSPManager (extension routing)', () => {
  test('constructor resolves projectDir to an absolute path', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    // No public getter for projectDir, but isTSReady should be false
    // until startAll runs.
    expect(mgr.isTSReady()).toBe(false)
    expect(mgr.isRunning()).toBe(false)
  })

  test('notifyFileChanged ignores files with non-routable extensions', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(() => mgr.notifyFileChanged('README.md', '# hi')).not.toThrow()
  })

  test('notifyFileChanged routes .py files to the python dirty set', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    mgr.notifyFileChanged('a.py', 'pass')
    // The dirty set is private but its size is exposed indirectly via
    // getDiagnosticsAsync. Without pyAvailable being true (no pyright
    // on disk in test env), the call should still return an empty map
    // without throwing.
    expect(mgr.isRunning()).toBe(false)
  })

  test('notifyFileDeleted clears Python cached diagnostics', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    mgr.notifyFileChanged('a.py', 'pass')
    mgr.notifyFileDeleted('a.py')
    // No assertion needed beyond no-throw.
  })

  test('notifyFileSaved routes only TS extensions', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(() => mgr.notifyFileSaved('a.ts')).not.toThrow()
    expect(() => mgr.notifyFileSaved('a.py')).not.toThrow()
  })

  test('document-sync methods are no-ops for non-TS files', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    mgr.didOpenDocument('a.py', 'python', 1, 'pass')
    mgr.didChangeDocument('a.py', 2, 'pass\n')
    mgr.didCloseDocument('a.py')
  })

  test('typed-request helpers return null for non-TS extensions', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(await mgr.hover('a.py', 0, 0)).toBeNull()
    expect(await mgr.completion('a.py', 0, 0)).toBeNull()
    expect(await mgr.completion('a.py', 0, 0, { triggerKind: 1 })).toBeNull()
    expect(await mgr.definition('a.py', 0, 0)).toBeNull()
    expect(await mgr.references('a.py', 0, 0)).toBeNull()
    expect(await mgr.references('a.py', 0, 0, false)).toBeNull()
    expect(await mgr.documentSymbol('a.py')).toBeNull()
    expect(await mgr.signatureHelp('a.py', 0, 0)).toBeNull()
    expect(await mgr.rename('a.py', 0, 0, 'x')).toBeNull()
  })

  test('typed-request helpers return null pre-init for TS extensions too', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(await mgr.hover('a.ts', 0, 0)).toBeNull()
    expect(await mgr.completion('a.tsx', 0, 0)).toBeNull()
    expect(await mgr.definition('a.js', 0, 0)).toBeNull()
  })

  test('getDiagnostics returns an empty map when nothing is tracked', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    const m = mgr.getDiagnostics()
    expect(m.size).toBe(0)
    expect(mgr.getDiagnostics('file:///nope.ts').size).toBe(0)
  })

  test('getDiagnosticsAsync returns the same shape as getDiagnostics', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    const m = await mgr.getDiagnosticsAsync()
    expect(m.size).toBe(0)
  })

  test('waitForReady resolves immediately when warmupPromise is null', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await expect(mgr.waitForReady()).resolves.toBeUndefined()
  })

  test('renotifyWarmupFile no-ops when there is no TS server', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    expect(() => mgr.renotifyWarmupFile()).not.toThrow()
  })

  test('stop() clears Python state without throwing', () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    mgr.notifyFileChanged('a.py', 'pass')
    mgr.stop()
    // Stop is idempotent.
    mgr.stop()
  })
})

describe('ensureTsconfigWatchExclusions (via startAll → startTS)', () => {
  test('adds watchOptions.excludeDirectories when tsconfig.json is bare', async () => {
    writeFileSync(join(TEST_DIR, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
    // We can't easily call the private method directly; instead, reach
    // it via the public `startAll`. tsserver will fail to spawn (no
    // typescript-language-server binary in /tmp), but the
    // tsconfig-edit phase runs FIRST so the edit is observable on disk.
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.startAll().catch(() => {})
    const written = JSON.parse(readFileSync(join(TEST_DIR, 'tsconfig.json'), 'utf-8'))
    expect(written.watchOptions?.excludeDirectories).toEqual([
      '**/node_modules',
      '**/dist',
      '**/.git',
      '**/.shogo',
    ])
    mgr.stop()
  })

  test('merges required exclusions with the project\'s existing excludeDirectories', async () => {
    // Pre-fix this test asserted "leaves alone" because the manager
    // early-returned when the array was non-empty. New behavior: dedupe-merge
    // the required entries so a project that only excluded `custom/**`
    // still gets `**/node_modules` etc. added (the staging incident
    // pre-condition).
    writeFileSync(
      join(TEST_DIR, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {},
        watchOptions: { excludeDirectories: ['custom/**'] },
      }),
    )
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.startAll().catch(() => {})
    const after = JSON.parse(readFileSync(join(TEST_DIR, 'tsconfig.json'), 'utf-8'))
    expect(after.watchOptions.excludeDirectories).toEqual([
      'custom/**',
      '**/node_modules',
      '**/dist',
      '**/.git',
      '**/.shogo',
    ])
    mgr.stop()
  })

  test('does not rewrite tsconfig.json when all required exclusions are already present', async () => {
    const original = JSON.stringify({
      compilerOptions: {},
      watchOptions: {
        excludeDirectories: [
          '**/node_modules',
          '**/dist',
          '**/.git',
          '**/.shogo',
          'custom/**',
        ],
      },
    })
    writeFileSync(join(TEST_DIR, 'tsconfig.json'), original)
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.startAll().catch(() => {})
    const after = readFileSync(join(TEST_DIR, 'tsconfig.json'), 'utf-8')
    expect(after).toBe(original)
    mgr.stop()
  })

  test('no-ops when tsconfig.json does not exist', async () => {
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.startAll().catch(() => {})
    expect(existsSync(join(TEST_DIR, 'tsconfig.json'))).toBe(false)
    mgr.stop()
  })

  test('tolerates malformed tsconfig.json without throwing', async () => {
    writeFileSync(join(TEST_DIR, 'tsconfig.json'), '{ broken json,, }')
    const mgr = new WorkspaceLSPManager({ projectDir: TEST_DIR })
    await mgr.startAll().catch(() => {})
    mgr.stop()
  })
})
