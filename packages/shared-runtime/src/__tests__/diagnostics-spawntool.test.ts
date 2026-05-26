// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage additions for diagnostics.ts — paths reachable only when
 * child_process.spawn is actually invoked.
 *
 * The existing diagnostics.test.ts always uses source=build or short-circuits
 * before runTool() is called. This file mocks child_process so we can control
 * the spawned-process lifecycle without running real bun / tsc / eslint.
 *
 * Lines covered:
 *   L223-225  runTool timeout callback (timedOut=true + child.kill)
 *   L229-232  done() function body (settled, clearTimeout, resolve)
 *   L296-297  runTsc: timedOut note
 *   L299-301  runTsc: stderr "command not found" note
 *   L383-384  runEslint: timedOut note
 *   L385-387  runEslint: stderr "command not found" note
 *   L388      runEslint: normal return (eslint config + spawn succeeds)
 *   L412-413  readBuildErrors catch (getBuildErrors throws)
 *   L582-586  POST /refresh route catch (spawn throws -> getOrCompute rejects)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mock state — declared BEFORE mock.module factories so they close over live refs
// ---------------------------------------------------------------------------

type SpawnMode = 'normal' | 'timeout' | 'stderr-notfound' | 'throw-sync'
let _spawnMode: SpawnMode = 'normal'
let _spawnStdout = ''
let _spawnStderr = ''
let _buildErrorsShouldThrow = false

// ---------------------------------------------------------------------------
// child_process mock — installed BEFORE diagnostics.ts is imported
// ---------------------------------------------------------------------------

mock.module('child_process', () => {
  const { EventEmitter } = require('events')
  return {
    spawn: (_cmd: string, _args: string[], _opts: unknown) => {
      if (_spawnMode === 'throw-sync') {
        // Synchronous throw inside the Promise constructor -> promise rejects.
        // This propagates through runTsc -> Promise.all -> getOrCompute and
        // surfaces as a rejection caught by the route handler (L582-586).
        throw new Error('spawn ENOENT: command not found')
      }
      const child = new EventEmitter() as any
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      // kill() immediately emits close so done() fires and promises always resolve.
      // Without this the timeout test would hang waiting for the child to die.
      child.kill = (_sig?: string) => {
        setImmediate(() => child.emit('close', null))
      }
      if (_spawnMode === 'normal') {
        setImmediate(() => {
          if (_spawnStdout) child.stdout.emit('data', Buffer.from(_spawnStdout))
          if (_spawnStderr) child.stderr.emit('data', Buffer.from(_spawnStderr))
          child.emit('close', 0)
        })
      } else if (_spawnMode === 'timeout') {
        // Never auto-emits close — let the toolTimeoutMs timer fire, which
        // calls kill(), which in turn emits close via the mock above.
      } else if (_spawnMode === 'stderr-notfound') {
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('command not found: bun'))
          child.emit('close', 127)
        })
      }
      return child
    },
  }
})

// ---------------------------------------------------------------------------
// diagnostics-build-buffer mock — controls whether getBuildErrors() throws
// ---------------------------------------------------------------------------

mock.module('../diagnostics-build-buffer', () => ({
  getBuildErrors: (_projectId: string) => {
    if (_buildErrorsShouldThrow) throw new Error('getBuildErrors exploded intentionally')
    return []
  },
  recordBuildError: () => {},
  _resetBuildBufferForTests: () => {},
}))

// ---------------------------------------------------------------------------
// Import diagnostics AFTER mocks are installed
// ---------------------------------------------------------------------------

import { diagnosticsRoutes, _clearDiagnosticsCacheForTests } from '../diagnostics'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let workspacesDir: string
let projectId: string
let projectDir: string

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-diag-spawn-'))
  projectId = 'proj_spawn'
  projectDir = join(workspacesDir, projectId)
  mkdirSync(projectDir, { recursive: true })
  _clearDiagnosticsCacheForTests()
  _spawnMode = 'normal'
  _spawnStdout = ''
  _spawnStderr = ''
  _buildErrorsShouldThrow = false
})

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true })
  _spawnMode = 'normal'
  _buildErrorsShouldThrow = false
})

// ---------------------------------------------------------------------------
// L229-232: done() fires on child 'close' event
// ---------------------------------------------------------------------------

describe('runTool — done() fires on child close (L229-232)', () => {
  test('tsc: spawn emits close -> done() resolves, returns empty diags', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'normal'
    _spawnStdout = ''
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics).toEqual([])
  })

  test('tsc: spawn emits close with tsc errors in stdout -> parsed correctly', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'normal'
    _spawnStdout = `src/App.tsx(10,3): error TS2304: Cannot find name 'foo'.`
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    const body = await res.json()
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0].message).toBe("Cannot find name 'foo'.")
  })

  test('eslint: spawn emits close with JSON stdout -> parsed and L388 covered', async () => {
    writeFileSync(join(projectDir, 'eslint.config.js'), 'export default []')
    _spawnMode = 'normal'
    _spawnStdout = JSON.stringify([{
      filePath: `${projectDir}/src/x.ts`,
      messages: [{
        ruleId: 'no-undef',
        severity: 2,
        message: "'x' is not defined.",
        line: 5,
        column: 3,
      }],
    }])
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=eslint`),
    )
    const body = await res.json()
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0].source).toBe('eslint')
    expect(body.diagnostics[0].message).toBe("'x' is not defined.")
  })
})

// ---------------------------------------------------------------------------
// L223-225 + L296-297 + L383-384: timeout callback fires
// ---------------------------------------------------------------------------

describe('runTool — timeout fires (L223-225)', () => {
  test('tsc: 60ms timeout -> timedOut note in response (L296-297)', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'timeout'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 60 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const note = body.notes?.find((n: any) => n.source === 'ts')
    expect(note?.message).toMatch(/timed out/i)
  }, 3_000)

  test('eslint: 60ms timeout -> timedOut note in response (L383-384)', async () => {
    writeFileSync(join(projectDir, 'eslint.config.js'), 'export default []')
    _spawnMode = 'timeout'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 60 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=eslint`),
    )
    const body = await res.json()
    const note = body.notes?.find((n: any) => n.source === 'eslint')
    expect(note?.message).toMatch(/timed out/i)
  }, 3_000)
})

// ---------------------------------------------------------------------------
// L299-301 + L385-387: stderr "command not found" path
// ---------------------------------------------------------------------------

describe('runTool — stderr not-found path (L299-301, L385-387)', () => {
  test('tsc: stderr "command not found" + empty stdout -> unavailable note (L299)', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'stderr-notfound'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    const body = await res.json()
    const note = body.notes?.find((n: any) => n.source === 'ts')
    expect(note?.message).toMatch(/tsc unavailable/i)
  })

  test('eslint: stderr "command not found" + empty stdout -> unavailable note (L385)', async () => {
    writeFileSync(join(projectDir, 'eslint.config.js'), 'export default []')
    _spawnMode = 'stderr-notfound'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=eslint`),
    )
    const body = await res.json()
    const note = body.notes?.find((n: any) => n.source === 'eslint')
    expect(note?.message).toMatch(/eslint unavailable/i)
  })
})

// ---------------------------------------------------------------------------
// L412-413: readBuildErrors catch when getBuildErrors throws
// ---------------------------------------------------------------------------

describe('readBuildErrors catch (L412-413)', () => {
  test('getBuildErrors throws -> build note "build errors unavailable"', async () => {
    _buildErrorsShouldThrow = true
    const router = diagnosticsRoutes({ workspacesDir })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const note = body.notes?.find((n: any) => n.source === 'build')
    expect(note?.message).toMatch(/build errors unavailable/i)
  })
})

// ---------------------------------------------------------------------------
// L582-586: POST /refresh route catch — getOrCompute rejects
//
// spawn() throws synchronously inside runTool's Promise constructor ->
// the constructor rejects -> runTsc rejects -> Promise.all rejects ->
// computeDiagnostics rejects -> getOrCompute's async IIFE rejects ->
// route catch at L582 fires -> 500 response.
// ---------------------------------------------------------------------------

describe('POST /refresh route error handler (L582-586)', () => {
  test('spawn throws sync -> 500 with diagnostics_failed code', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'throw-sync'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['ts'] }),
      }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('diagnostics_failed')
  })
})

// ---------------------------------------------------------------------------
// L226: SIGKILL retry callback fires 2000ms after the initial timeout
// ---------------------------------------------------------------------------

describe('runTool — SIGKILL retry callback (L226)', () => {
  test('SIGKILL setTimeout fires 2s after initial timeout, then done() no-ops (settled)', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    _spawnMode = 'timeout'
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 60 })
    // Fire the request — the 60ms timeout runs, SIGTERM is sent (mock emits close),
    // done() resolves the promise. The SIGKILL retry is scheduled for 2000ms later.
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    expect(res.status).toBe(200)
    // Wait for the SIGKILL retry callback to fire (scheduled 2000ms after the 60ms timeout).
    await new Promise((r) => setTimeout(r, 2100))
    // done() is idempotent — the settled flag prevents a double-resolve.
    // Coverage: the anonymous () => { try { child.kill("SIGKILL") } catch {} } at L226 is now entered.
  }, 5_000) // 5s test timeout to accommodate the 2.1s wait
})

// ---------------------------------------------------------------------------
// L237: child 'error' event handler () => done(null) fires
// ---------------------------------------------------------------------------

describe('runTool — child error event fires done(null) (L237)', () => {
  test('spawn emits error -> done(null) called, runTsc resolves with empty diags', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    // Patch spawn factory to emit 'error' instead of 'close'
    mock.module('child_process', () => {
      const { EventEmitter } = require('events')
      return {
        spawn: (_cmd: string, _args: string[], _opts: unknown) => {
          const child = new EventEmitter() as any
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = () => {}
          setImmediate(() => child.emit('error', new Error('ENOENT: bun not found')))
          return child
        },
      }
    })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 5_000 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    // error -> done(null) -> resolve({ code: null, timedOut: false })
    // parseTscOutput('') returns [] -> no diags, no note
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics).toEqual([])
    // Restore the original mock so subsequent tests use normal spawn behaviour
    mock.module('child_process', () => {
      const { EventEmitter } = require('events')
      return {
        spawn: (_cmd: string, _args: string[], _opts: unknown) => {
          if (_spawnMode === 'throw-sync') throw new Error('spawn ENOENT: command not found')
          const child = new EventEmitter() as any
          child.stdout = new EventEmitter()
          child.stderr = new EventEmitter()
          child.kill = (_sig?: string) => { setImmediate(() => child.emit('close', null)) }
          if (_spawnMode === 'normal') {
            setImmediate(() => {
              if (_spawnStdout) child.stdout.emit('data', Buffer.from(_spawnStdout))
              if (_spawnStderr) child.stderr.emit('data', Buffer.from(_spawnStderr))
              child.emit('close', 0)
            })
          } else if (_spawnMode === 'stderr-notfound') {
            setImmediate(() => {
              child.stderr.emit('data', Buffer.from('command not found: bun'))
              child.emit('close', 127)
            })
          }
          return child
        },
      }
    })
  })
})
