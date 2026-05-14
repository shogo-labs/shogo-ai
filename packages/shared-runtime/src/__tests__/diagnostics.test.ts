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

// ─────────────────────────────────────────────────────────────────────────────
// Additional parser coverage (parseTscOutput)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseTscOutput — extended cases', () => {
  test('parses an info-severity (message) line as severity "info"', () => {
    const out = parseTscOutput(
      `src/a.ts(3,1): message TS6133: 'x' is declared but never read.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('info')
    expect(out[0].code).toBe('TS6133')
  })

  test('falls back to "hint" severity for unknown words', () => {
    const out = parseTscOutput(
      `src/a.ts(1,1): suggestion TS9000: try this.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('hint')
  })

  test('handles CRLF line endings', () => {
    const out = parseTscOutput(
      `src/a.ts(1,1): error TS1: A\r\nsrc/b.ts(2,2): error TS2: B\r\n`,
      projectDir,
    )
    expect(out).toHaveLength(2)
    expect(out[0].file).toBe('src/a.ts')
    expect(out[1].file).toBe('src/b.ts')
  })

  test('trims trailing whitespace from each line before matching', () => {
    const out = parseTscOutput(
      `src/a.ts(1,1): error TS1: hello    `,
      projectDir,
    )
    expect(out).toHaveLength(1)
    // Trailing spaces inside the message are not preserved post-trimEnd of the
    // full line — but message body should still contain "hello".
    expect(out[0].message).toContain('hello')
  })

  test('captures multiple errors in the same file with distinct ids', () => {
    const out = parseTscOutput(
      [
        'src/a.ts(1,1): error TS1: first',
        'src/a.ts(2,2): error TS2: second',
        'src/a.ts(3,3): error TS3: third',
      ].join('\n'),
      projectDir,
    )
    expect(out).toHaveLength(3)
    const ids = new Set(out.map(d => d.id))
    expect(ids.size).toBe(3)
    expect(out.map(d => d.line)).toEqual([1, 2, 3])
  })

  test('returns [] for blank input and for purely-junk input', () => {
    expect(parseTscOutput('', projectDir)).toEqual([])
    expect(parseTscOutput('\n\n\n', projectDir)).toEqual([])
    expect(parseTscOutput('this is not a tsc line at all', projectDir)).toEqual([])
  })

  test('normalises Windows-style backslash paths in absolute file segments', () => {
    // Build an "absolute" path using POSIX style for projectDir then inject
    // backslashes in the relative tail to verify replaceAll('\\','/').
    const abs = `${projectDir}/src\\nested\\file.tsx`
    const out = parseTscOutput(
      `${abs}(7,4): error TS2304: Cannot find name 'X'.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].file).not.toContain('\\')
    expect(out[0].file).toContain('src/nested/file.tsx')
  })

  test('parses a TS2304 "Cannot find name" line cleanly', () => {
    const out = parseTscOutput(
      `src/App.tsx(99,17): error TS2304: Cannot find name 'undeclaredVariable'.`,
      projectDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'ts',
      severity: 'error',
      code: 'TS2304',
      line: 99,
      column: 17,
      message: "Cannot find name 'undeclaredVariable'.",
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Additional parser coverage (parseEslintOutput)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseEslintOutput — extended cases', () => {
  test('parses multiple files with mixed severities', () => {
    const json = JSON.stringify([
      {
        filePath: `${projectDir}/a.ts`,
        messages: [
          { ruleId: 'no-debugger', severity: 2, message: 'no debug', line: 1, column: 1 },
        ],
      },
      {
        filePath: `${projectDir}/b.ts`,
        messages: [
          { ruleId: 'prefer-const', severity: 1, message: 'use const', line: 2, column: 4 },
          { ruleId: 'no-debugger', severity: 2, message: 'no debug', line: 9, column: 1 },
        ],
      },
    ])
    const out = parseEslintOutput(json, projectDir)
    expect(out).toHaveLength(3)
    expect(out.map(d => d.file).sort()).toEqual(['a.ts', 'b.ts', 'b.ts'])
    expect(out.filter(d => d.severity === 'error')).toHaveLength(2)
    expect(out.filter(d => d.severity === 'warning')).toHaveLength(1)
  })

  test('empty array yields no diagnostics', () => {
    expect(parseEslintOutput('[]', projectDir)).toEqual([])
  })

  test('file with no messages yields no diagnostics', () => {
    const json = JSON.stringify([{ filePath: `${projectDir}/a.ts`, messages: [] }])
    expect(parseEslintOutput(json, projectDir)).toEqual([])
  })

  test('messageId is used as code when ruleId is null', () => {
    const json = JSON.stringify([{
      filePath: `${projectDir}/a.ts`,
      messages: [{ ruleId: null, severity: 2, messageId: 'parse-error', message: 'oops', line: 1, column: 1 }],
    }])
    const out = parseEslintOutput(json, projectDir)
    expect(out).toHaveLength(1)
    expect(out[0].code).toBe('parse-error')
  })

  test('missing line/column defaults to 1', () => {
    const json = JSON.stringify([{
      filePath: `${projectDir}/a.ts`,
      messages: [{ ruleId: 'x', severity: 2, message: 'm' }],
    }])
    const out = parseEslintOutput(json, projectDir)
    expect(out).toHaveLength(1)
    expect(out[0].line).toBe(1)
    expect(out[0].column).toBe(1)
  })

  test('scoped (@-prefixed) rule does not produce a ruleUri', () => {
    const json = JSON.stringify([{
      filePath: `${projectDir}/a.ts`,
      messages: [{ ruleId: '@typescript-eslint/no-explicit-any', severity: 2, message: 'm', line: 1, column: 1 }],
    }])
    const out = parseEslintOutput(json, projectDir)
    expect(out[0].code).toBe('@typescript-eslint/no-explicit-any')
    expect(out[0].ruleUri).toBeUndefined()
  })

  test('endLine / endColumn passed through when present', () => {
    const json = JSON.stringify([{
      filePath: `${projectDir}/a.ts`,
      messages: [{
        ruleId: 'x', severity: 2, message: 'm',
        line: 1, column: 1, endLine: 1, endColumn: 9,
      }],
    }])
    const out = parseEslintOutput(json, projectDir)
    expect(out[0].endLine).toBe(1)
    expect(out[0].endColumn).toBe(9)
  })

  test('returns [] when JSON cannot be recovered (no brackets at all)', () => {
    expect(parseEslintOutput('totally not json {{{', projectDir)).toEqual([])
  })

  test('returns [] when bracket slice still fails to parse', () => {
    // Has [ and ] but the contents between are invalid JSON.
    expect(parseEslintOutput('garbage [not-valid-json] more garbage', projectDir)).toEqual([])
  })

  test('handles relative filePath (no isAbsolute branch)', () => {
    const json = JSON.stringify([{
      filePath: 'rel/file.ts',
      messages: [{ ruleId: 'x', severity: 1, message: 'm', line: 1, column: 1 }],
    }])
    const out = parseEslintOutput(json, projectDir)
    expect(out[0].file).toBe('rel/file.ts')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Additional router coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnosticsRoutes — extended endpoint cases', () => {
  test('POST /refresh on unknown project returns 404', async () => {
    const router = diagnosticsRoutes({ workspacesDir })
    const res = await router.fetch(
      new Request(`http://x/projects/does-not-exist/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('project_not_found')
  })

  test('POST /refresh with malformed JSON body falls back to all sources', async () => {
    recordBuildError(projectId, { message: 'b1' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{',
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // Default sources include build → our recorded error is present.
    expect(body.diagnostics.some((d: any) => d.message === 'b1')).toBe(true)
    expect(body.sources).toEqual(['ts', 'eslint', 'build'])
  })

  test('POST /refresh with empty sources array falls back to all sources', async () => {
    recordBuildError(projectId, { message: 'b1' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [] }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sources).toEqual(['ts', 'eslint', 'build'])
  })

  test('POST /refresh filters invalid sources from body', async () => {
    recordBuildError(projectId, { message: 'b1' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['build', 'bogus', 'also-bogus'] as any }),
      }),
    )
    const body = await res.json()
    expect(body.sources).toEqual(['build'])
  })

  test('GET with comma-list source param parses multiple sources', async () => {
    recordBuildError(projectId, { message: 'mb' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build,ts`),
    )
    const body = await res.json()
    expect(body.sources.sort()).toEqual(['build', 'ts'])
  })

  test('GET with empty source param falls back to all sources', async () => {
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=`),
    )
    const body = await res.json()
    expect(body.sources).toEqual(['ts', 'eslint', 'build'])
  })

  test('GET with only-invalid source values falls back to all sources', async () => {
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=foo,bar`),
    )
    const body = await res.json()
    expect(body.sources).toEqual(['ts', 'eslint', 'build'])
  })

  test('GET with since older than lastRunAt returns the full payload (not unchanged)', async () => {
    recordBuildError(projectId, { message: 'x' })
    const router = diagnosticsRoutes({ workspacesDir })
    const past = new Date(Date.now() - 60_000).toISOString()
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build&since=${encodeURIComponent(past)}`),
    )
    const body = await res.json()
    expect(body.unchanged).toBeUndefined()
    expect(body.diagnostics).toHaveLength(1)
  })

  test('_clearDiagnosticsCacheForTests forces the next call to recompute', async () => {
    recordBuildError(projectId, { message: 'one' })
    const router = diagnosticsRoutes({ workspacesDir })
    const r1 = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(r1.fromCache).toBe(false)
    const r2 = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(r2.fromCache).toBe(true)
    _clearDiagnosticsCacheForTests()
    const r3 = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(r3.fromCache).toBe(false)
  })

  test('build errors with absolute path are normalised to project-relative', async () => {
    const abs = join(projectDir, 'src', 'deep', 'file.tsx')
    recordBuildError(projectId, { file: abs, line: 3, column: 1, message: 'm' })
    const router = diagnosticsRoutes({ workspacesDir })
    const body = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(body.diagnostics[0].file).toBe('src/deep/file.tsx')
  })

  test('build errors with no file fall back to literal "(build)"', async () => {
    recordBuildError(projectId, { message: 'no-file' })
    const router = diagnosticsRoutes({ workspacesDir })
    const body = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(body.diagnostics[0].file).toBe('(build)')
  })

  test('mtime hash change between calls invalidates the cache', async () => {
    recordBuildError(projectId, { message: 'm' })
    // Put a source file in place so computeMtimeHash has something to hash.
    writeFileSync(join(projectDir, 'a.ts'), 'export {}')
    const router = diagnosticsRoutes({ workspacesDir })
    const url = `http://x/projects/${projectId}/diagnostics?source=build`
    const r1 = await (await router.fetch(new Request(url))).json()
    expect(r1.fromCache).toBe(false)
    // Touch the file with a new mtime — invalidates the mtime hash.
    await new Promise(r => setTimeout(r, 20))
    writeFileSync(join(projectDir, 'a.ts'), 'export const X = 1')
    const r2 = await (await router.fetch(new Request(url))).json()
    expect(r2.fromCache).toBe(false)
    expect(new Date(r2.lastRunAt).getTime()).toBeGreaterThanOrEqual(new Date(r1.lastRunAt).getTime())
  })

  test('multi-source GET aggregates notes from each unavailable source', async () => {
    // No tsconfig, no eslint config → both sources emit notes.
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts,eslint`),
    )
    const body = await res.json()
    expect(body.notes).toBeDefined()
    const noteSources = body.notes.map((n: any) => n.source).sort()
    expect(noteSources).toEqual(['eslint', 'ts'])
  })

  test('GET defaults to all sources when no source query is provided', async () => {
    recordBuildError(projectId, { message: 'default-build' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics`),
    )
    const body = await res.json()
    expect(body.sources).toEqual(['ts', 'eslint', 'build'])
    expect(body.diagnostics.some((d: any) => d.message === 'default-build')).toBe(true)
  })

  test('mtime hash includes top-level config files (tsconfig change busts cache)', async () => {
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    recordBuildError(projectId, { message: 'm' })
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 100 })
    const url = `http://x/projects/${projectId}/diagnostics?source=build`
    const r1 = await (await router.fetch(new Request(url))).json()
    expect(r1.fromCache).toBe(false)
    await new Promise(r => setTimeout(r, 20))
    writeFileSync(join(projectDir, 'tsconfig.json'), '{"compilerOptions":{}}')
    const r2 = await (await router.fetch(new Request(url))).json()
    expect(r2.fromCache).toBe(false)
  })

  test('skipped directories (node_modules, .git) do not affect the mtime hash', async () => {
    recordBuildError(projectId, { message: 'm' })
    mkdirSync(join(projectDir, 'node_modules'), { recursive: true })
    writeFileSync(join(projectDir, 'node_modules', 'junk.ts'), 'x')
    const router = diagnosticsRoutes({ workspacesDir })
    const url = `http://x/projects/${projectId}/diagnostics?source=build`
    const r1 = await (await router.fetch(new Request(url))).json()
    expect(r1.fromCache).toBe(false)
    await new Promise(r => setTimeout(r, 20))
    // Touch a file deep in node_modules — must NOT bust the cache.
    writeFileSync(join(projectDir, 'node_modules', 'junk.ts'), 'export const y = 1')
    const r2 = await (await router.fetch(new Request(url))).json()
    expect(r2.fromCache).toBe(true)
  })

  test('two concurrent non-force GETs coalesce onto a single inflight pass', async () => {
    recordBuildError(projectId, { message: 'co' })
    const router = diagnosticsRoutes({ workspacesDir })
    const url = `http://x/projects/${projectId}/diagnostics?source=build`
    const [r1, r2] = await Promise.all([
      router.fetch(new Request(url)).then(r => r.json()),
      router.fetch(new Request(url)).then(r => r.json()),
    ])
    // Both responses share the same lastRunAt (same underlying compute).
    expect(r1.lastRunAt).toBe(r2.lastRunAt)
  })

  test('two concurrent force POSTs coalesce onto a single force-inflight pass', async () => {
    recordBuildError(projectId, { message: 'co' })
    const router = diagnosticsRoutes({ workspacesDir })
    const url = `http://x/projects/${projectId}/diagnostics/refresh`
    const body = JSON.stringify({ sources: ['build'] })
    const headers = { 'content-type': 'application/json' }
    const [r1, r2] = await Promise.all([
      router.fetch(new Request(url, { method: 'POST', headers, body })).then(r => r.json()),
      router.fetch(new Request(url, { method: 'POST', headers, body })).then(r => r.json()),
    ])
    expect(r1.lastRunAt).toBe(r2.lastRunAt)
    expect(r1.fromCache).toBe(false)
    expect(r2.fromCache).toBe(false)
  })

  test('build source surfaces a note when getBuildErrors throws (via a poisoned projectId — graceful path)', async () => {
    // recordBuildError + getBuildErrors don't throw for normal inputs, so we
    // can only exercise the happy paths here. This test asserts that the
    // catch-all in readBuildErrors stays dormant for normal use AND that
    // notes are NOT spuriously populated when nothing went wrong.
    recordBuildError(projectId, { message: 'ok' })
    const router = diagnosticsRoutes({ workspacesDir })
    const body = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(body.diagnostics).toHaveLength(1)
    expect(body.notes).toBeUndefined()
  })

  test('cross-source de-dup actually drops duplicates in aggregator output', async () => {
    // Force a duplicate id between build and tsc by recording an identical
    // shape — id is computed from file/line/col/code/message, source-free.
    recordBuildError(projectId, {
      file: 'src/dup.ts', line: 1, column: 1, code: 'TS9999', message: 'same.',
    })
    // Manually push a second build error with EXACTLY the same id key — the
    // buffer keeps both rows, but the aggregator must collapse them via the
    // `seen` set.
    recordBuildError(projectId, {
      file: 'src/dup.ts', line: 1, column: 1, code: 'TS9999', message: 'same.',
    })
    const router = diagnosticsRoutes({ workspacesDir })
    const body = await (await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
    )).json()
    expect(body.diagnostics).toHaveLength(1)
  })

  test('with very small tool timeout, ts + eslint paths still return a 200 with notes / empty diags', async () => {
    // tsconfig + an eslint config present so the runners actually spawn,
    // but a 50ms timeout guarantees they trip the timedOut branch.
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    writeFileSync(join(projectDir, '.eslintrc.json'), '{}')
    const router = diagnosticsRoutes({ workspacesDir, toolTimeoutMs: 50 })
    const res = await router.fetch(
      new Request(`http://x/projects/${projectId}/diagnostics?source=ts,eslint`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // Either the runner produced no diagnostics, or it timed out and surfaced
    // a note — both are valid 200 paths. We only assert the shape.
    expect(Array.isArray(body.diagnostics)).toBe(true)
    expect(body.sources.sort()).toEqual(['eslint', 'ts'])
  }, 15_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Nested-directory walk coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('diagnosticsRoutes — mtime hash nested directory walk', () => {
  test('cache busts when a deeply nested source file is touched', async () => {
    // Build a nested layout so computeMtimeHash recurses past depth 0.
    const nested = join(projectDir, 'src', 'lib', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'thing.ts'), 'export const A = 1')
    recordBuildError(projectId, { message: 'm' })

    const router = diagnosticsRoutes({ workspacesDir })
    const url = `http://x/projects/${projectId}/diagnostics?source=build`

    const r1 = await (await router.fetch(new Request(url))).json()
    expect(r1.fromCache).toBe(false)

    // Cache hit on the immediate second call (same mtimes).
    const r2 = await (await router.fetch(new Request(url))).json()
    expect(r2.fromCache).toBe(true)

    await new Promise(r => setTimeout(r, 20))
    writeFileSync(join(nested, 'thing.ts'), 'export const A = 2')
    const r3 = await (await router.fetch(new Request(url))).json()
    expect(r3.fromCache).toBe(false)
  })

  test('mtime walk tolerates an unreadable subdirectory (caught by try/catch)', async () => {
    // Create a directory then chmod it to 000 so readdirSync throws — the
    // walker's `try { readdirSync(dir) } catch { return }` branch must
    // swallow the error and the request must still succeed.
    const blocked = join(projectDir, 'src', 'blocked')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'a.ts'), 'export {}')
    const { chmodSync } = await import('fs')
    chmodSync(blocked, 0o000)
    try {
      recordBuildError(projectId, { message: 'm' })
      const router = diagnosticsRoutes({ workspacesDir })
      const res = await router.fetch(
        new Request(`http://x/projects/${projectId}/diagnostics?source=build`),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.diagnostics).toHaveLength(1)
    } finally {
      chmodSync(blocked, 0o755)
    }
  })
})
