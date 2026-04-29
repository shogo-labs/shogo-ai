// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the shared diagnostics router (TS + ESLint + build buffer).
 *
 * What we cover here:
 *   - Pure parser tests (parseTscOutput, parseEslintOutput) — fastest signal,
 *     no spawn, no fs.
 *   - Router behavior on a synthetic on-disk project: 404 for unknown
 *     project, cache hit on second call, refresh bypasses cache.
 *   - Build-buffer integration: pushed errors surface as `source: "build"`
 *     diagnostics.
 *
 * The actual `tsc` / `eslint` spawns are exercised by an opt-in integration
 * test gated on `RUN_DIAGNOSTICS_INTEGRATION=1` (skipped by default — those
 * binaries are not always installed in CI, and we don't want to flake the
 * unit suite). The parser tests cover the parsing surface that's most likely
 * to break.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  diagnosticsRoutes,
  parseTscOutput,
  parseEslintOutput,
  _clearDiagnosticsCacheForTests,
} from '../diagnostics'
import {
  recordBuildError,
  _resetBuildBufferForTests,
} from '../diagnostics-build-buffer'

let workspacesDir: string
let projectId: string
let projectDir: string

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-diag-'))
  projectId = 'proj_test'
  projectDir = join(workspacesDir, projectId)
  mkdirSync(projectDir, { recursive: true })
  _clearDiagnosticsCacheForTests()
  _resetBuildBufferForTests()
})

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Parser unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTscOutput', () => {
  test('parses a single error line with absolute path', () => {
    const out = parseTscOutput(
      `${projectDir}/src/App.tsx(12,5): error TS2304: Cannot find name 'foo'.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'ts',
      severity: 'error',
      file: 'src/App.tsx',
      line: 12,
      column: 5,
      code: 'TS2304',
      message: "Cannot find name 'foo'.",
    })
    expect(out[0].id).toBeTruthy()
  })

  test('parses a relative-path error line', () => {
    const out = parseTscOutput(
      `src/lib/db.ts(45,3): error TS1234: Object literal issue.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].file).toBe('src/lib/db.ts')
    expect(out[0].line).toBe(45)
    expect(out[0].column).toBe(3)
  })

  test('skips noise lines and parses multiple', () => {
    const out = parseTscOutput(
      [
        '> tsc',
        'src/a.ts(1,1): error TS1: A',
        'something unrelated',
        'src/b.ts(2,2): warning TS2: B',
        '',
      ].join('\n'),
      projectDir,
    )
    expect(out).toHaveLength(2)
    expect(out[0].severity).toBe('error')
    expect(out[1].severity).toBe('warning')
  })

  test('produces stable ids across runs (de-dupe key)', () => {
    const a = parseTscOutput('src/a.ts(1,1): error TS1: msg', projectDir)[0]
    const b = parseTscOutput('src/a.ts(1,1): error TS1: msg', projectDir)[0]
    expect(a.id).toBe(b.id)
  })
})

describe('parseEslintOutput', () => {
  test('parses ESLint JSON format', () => {
    const json = JSON.stringify([
      {
        filePath: `${projectDir}/src/App.tsx`,
        messages: [
          {
            ruleId: 'no-unused-vars',
            severity: 1,
            message: "'bar' is unused.",
            line: 3,
            column: 9,
            endLine: 3,
            endColumn: 12,
          },
          {
            ruleId: 'no-undef',
            severity: 2,
            message: "'foo' not defined.",
            line: 12,
            column: 5,
          },
        ],
      },
    ])
    const out = parseEslintOutput(json, projectDir)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: 'eslint',
      severity: 'warning',
      file: 'src/App.tsx',
      line: 3,
      code: 'no-unused-vars',
      ruleUri: 'https://eslint.org/docs/latest/rules/no-unused-vars',
    })
    expect(out[1]).toMatchObject({
      severity: 'error',
      code: 'no-undef',
    })
  })

  test('returns [] for empty / non-JSON input', () => {
    expect(parseEslintOutput('', projectDir)).toEqual([])
    expect(parseEslintOutput('not json', projectDir)).toEqual([])
  })

  test('recovers JSON when prefixed with stray output', () => {
    const json = `Warning: deprecation\n[{"filePath":"${projectDir}/x.ts","messages":[{"ruleId":"r","severity":2,"message":"m","line":1,"column":1}]}]`
    const out = parseEslintOutput(json, projectDir)
    expect(out).toHaveLength(1)
    expect(out[0].file).toBe('x.ts')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Router behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnosticsRoutes — endpoints', () => {
  test('GET returns 404 for unknown project', async () => {
    const router = diagnosticsRoutes({ workspacesDir })
    const res = await router.fetch(
      new Request(`http://x/projects/does-not-exist/diagnostics`),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('project_not_found')
  })

  test('GET with build-only source returns build buffer entries', async () => {
    recordBuildError(projectId, {
      file: 'src/App.tsx',
      line: 7,
      column: 2,
      code: 'vite:react',
      message: 'Unexpected token',
    })
    const router = diagnosticsRoutes({ workspacesDir })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0]).toMatchObject({
      source: 'build',
      file: 'src/App.tsx',
      line: 7,
      message: 'Unexpected token',
    })
  })

  test('second GET hits the cache (fromCache: true) and is fast', async () => {
    recordBuildError(projectId, { message: 'boom' })
    const router = diagnosticsRoutes({ workspacesDir })

    const url = `http://x/projects/${projectId}/diagnostics?source=build`
    const r1 = await router.fetch(new Request(url))
    expect(r1.status).toBe(200)
    const b1 = await r1.json()
    expect(b1.fromCache).toBe(false)

    const start = performance.now()
    const r2 = await router.fetch(new Request(url))
    const elapsed = performance.now() - start
    const b2 = await r2.json()
    expect(b2.fromCache).toBe(true)
    expect(b2.lastRunAt).toBe(b1.lastRunAt) // same run reused
    expect(elapsed).toBeLessThan(50)
  })

  test('POST /refresh bypasses cache and recomputes', async () => {
    recordBuildError(projectId, { message: 'first' })
    const router = diagnosticsRoutes({ workspacesDir })

    const r1 = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )
    const b1 = await r1.json()
    expect(b1.diagnostics[0].message).toBe('first')

    // Add another build error and force refresh — should now contain both.
    recordBuildError(projectId, { message: 'second' })
    const r2 = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['build'] }),
      }),
    )
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.fromCache).toBe(false)
    expect(b2.diagnostics).toHaveLength(2)
    expect(b2.diagnostics.map((d: any) => d.message)).toEqual(['first', 'second'])
    // lastRunAt advances on refresh.
    expect(new Date(b2.lastRunAt).getTime()).toBeGreaterThanOrEqual(new Date(b1.lastRunAt).getTime())
  })

  test('GET with `since` newer than lastRunAt returns unchanged', async () => {
    recordBuildError(projectId, { message: 'x' })
    const router = diagnosticsRoutes({ workspacesDir })
    const r1 = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )
    const b1 = await r1.json()

    const future = new Date(Date.now() + 60_000).toISOString()
    const r2 = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build&since=${encodeURIComponent(future)}`),
    )
    const b2 = await r2.json()
    expect(b2.unchanged).toBe(true)
    expect(b2.lastRunAt).toBe(b1.lastRunAt)
  })

  test('skips tsc when no tsconfig.json and surfaces a note', async () => {
    // No tsconfig.json on disk → tsc source returns empty + note.
    const router = diagnosticsRoutes({ workspacesDir })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts`),
    )
    const body = await res.json()
    expect(body.diagnostics).toEqual([])
    expect(body.notes).toBeDefined()
    expect(body.notes[0].source).toBe('ts')
    expect(body.notes[0].message).toMatch(/no tsconfig/i)
  })

  test('skips eslint when no config file and surfaces a note', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=eslint`),
    )
    const body = await res.json()
    expect(body.notes?.find((n: any) => n.source === 'eslint')?.message).toMatch(/no config/i)
  })

  // MF2 regression test — refresh must NOT silently return a stale inflight pass.
  test('POST /refresh while a non-force pass is inflight returns fresh data, not the inflight result', async () => {
    recordBuildError(projectId, { message: 'first' })
    const router = diagnosticsRoutes({ workspacesDir })

    // Kick off a non-force GET (becomes inflight). Don't await yet — we want
    // to fire /refresh while it is still running.
    const p1 = router.fetch(new Request(`http://x/projects/${projectId}/diagnostics?source=build`))
    // While that's inflight, add a new error and force-refresh.
    recordBuildError(projectId, { message: 'second' })
    const r2 = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['build'] }),
      }),
    )
    await p1 // drain
    const b2 = await r2.json()
    // Force MUST see BOTH errors. Pre-fix this would have returned only `first`
    // because force=true silently joined the inflight non-force pass.
    expect(b2.fromCache).toBe(false)
    expect(b2.diagnostics).toHaveLength(2)
    expect(b2.diagnostics.map((d: any) => d.message).sort()).toEqual(['first', 'second'])
  })

  // MF3 regression test — diagnostic ids are source-independent so cross-source
  // de-dup actually collapses duplicates instead of being dead code.
  test('diagnostic ids are source-independent so cross-source de-dup is real', () => {
    const tsDiag = parseTscOutput(`src/x.ts(1,1): error TS9999: same.`, projectDir)
    const esDiag = parseEslintOutput(JSON.stringify([{
      filePath: `${projectDir}/src/x.ts`,
      messages: [{ ruleId: 'TS9999', severity: 2, message: 'same.', line: 1, column: 1 }],
    }]), projectDir)
    expect(tsDiag).toHaveLength(1)
    expect(esDiag).toHaveLength(1)
    // Pre-fix the ids would differ because they included the source prefix;
    // post-fix they collapse on the same id so the aggregator's de-dup works.
    expect(tsDiag[0].id).toBe(esDiag[0].id)
    // The Diagnostic objects still carry their distinct `source` for the UI badge.
    expect(tsDiag[0].source).toBe('ts')
    expect(esDiag[0].source).toBe('eslint')
  })
})
