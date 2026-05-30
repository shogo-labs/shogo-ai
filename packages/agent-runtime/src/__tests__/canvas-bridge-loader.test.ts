// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit suite for `loadCanvasBridgeSource()` — the helper that backs the
 * `GET /agent/canvas/bridge.js` route the agent-runtime injects into
 * every workspace HTML response.
 *
 * Context: in May 2026 the Desktop build shipped without
 * `packages/agent-runtime/static/canvas-bridge.js` (bundle script omitted
 * the `static/` folder). The loader fell through to its silent
 * `'/* canvas-bridge.js missing *\u002F (function () {})();'` stub, the
 * SSE listener was never installed inside the iframe, and the
 * "Update available — Refresh" pill stopped appearing on Desktop while
 * still working on Cloud.
 *
 * These tests pin three invariants that together would have caught the
 * regression in CI:
 *
 *   1. The loader returns the **real file bytes** when the path resolves.
 *   2. The loader returns a **valid-JS stub** (not throws, not undefined)
 *      when the path is missing, AND logs a warning so the regression is
 *      observable in stderr.
 *   3. `CANVAS_BRIDGE_PATH` resolves to the file that actually ships in
 *      the source tree — i.e. the runtime and the source layout agree
 *      about where the bridge lives. (The desktop-bundle counterpart
 *      lives in `binary-ships-canvas-bridge.integration.test.ts`.)
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadCanvasBridgeSource,
  resolveCanvasBridgePath,
  CANVAS_BRIDGE_PATH,
  CANVAS_BRIDGE_MISSING_STUB,
  CANVAS_BRIDGE_URL,
  CANVAS_BRIDGE_SCRIPT_TAG,
} from '../canvas-bridge'

const STUB_MARKER = 'canvas-bridge.js missing'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'shogo-canvas-bridge-loader-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadCanvasBridgeSource', () => {
  test('returns the real bridge content when CANVAS_BRIDGE_PATH points at a readable file', () => {
    // No args = uses CANVAS_BRIDGE_PATH = packages/agent-runtime/static/canvas-bridge.js
    // That file is checked into the repo, so this should return the real source.
    const src = loadCanvasBridgeSource()
    expect(typeof src).toBe('string')
    expect(src.length).toBeGreaterThan(1_000)
    expect(src).not.toContain(STUB_MARKER)
    // Cheap proof we got the actual bridge, not some other JS file.
    expect(src).toMatch(/canvas/i)
  })

  test('CANVAS_BRIDGE_PATH resolves to the real source file in the repo (runtime ↔ source agree)', () => {
    // If this drifts (e.g. the source file is moved without updating the
    // const), every workspace iframe quietly loses its update toast.
    expect(existsSync(CANVAS_BRIDGE_PATH)).toBe(true)
    const stat = statSync(CANVAS_BRIDGE_PATH)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
    expect(CANVAS_BRIDGE_PATH.endsWith('canvas-bridge.js')).toBe(true)
    // Sanity: file ends in `/static/canvas-bridge.js`, not e.g.
    // `/canvas-runtime/canvas-bridge.js`. Cross-platform: avoid hard-coded `/`.
    expect(CANVAS_BRIDGE_PATH).toMatch(/[\\/]static[\\/]canvas-bridge\.js$/)
  })

  test('loader output for the real path is byte-identical to the source file (no re-encoding)', () => {
    const fromLoader = loadCanvasBridgeSource()
    const fromDisk = readFileSync(CANVAS_BRIDGE_PATH, 'utf-8')
    expect(fromLoader).toBe(fromDisk)
  })

  test('explicit path argument is honored (custom file)', () => {
    const fake = join(tmpDir, 'fake-bridge.js')
    const body = '/* fake bridge */ window.__FAKE__ = 1;\n'
    writeFileSync(fake, body, 'utf-8')
    expect(loadCanvasBridgeSource(fake)).toBe(body)
  })

  test('falls back to a valid-JS stub when the file is missing (no throw)', () => {
    const ghost = join(tmpDir, 'does-not-exist.js')
    expect(existsSync(ghost)).toBe(false)
    // Suppress the expected warning so the test output stays clean,
    // then assert we *also* exercised the warn path (invariant #2).
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = loadCanvasBridgeSource(ghost)
      expect(typeof src).toBe('string')
      expect(src).toContain(STUB_MARKER)
      // Must be parseable JS — the route serves it as application/javascript
      // and a SyntaxError would 200 a broken script into every iframe.
      expect(() => new Function(src)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [msg, detail] = warnSpy.mock.calls[0]!
      expect(String(msg)).toContain('[canvas-bridge]')
      expect(String(msg)).toContain(ghost)
      // ENOENT message format varies by platform — just assert *something*
      // useful (path or error string) got logged for ops to grep.
      expect(detail).toBeDefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('falls back to stub when the path is a directory, not a file (EISDIR)', () => {
    // Edge case: someone replaces canvas-bridge.js with a directory
    // (e.g. a botched git merge). readFileSync throws EISDIR, not ENOENT.
    // The loader must still degrade gracefully.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = loadCanvasBridgeSource(tmpDir) // tmpDir is a directory
      expect(src).toContain(STUB_MARKER)
      expect(() => new Function(src)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('stub is exactly the canonical sentinel (kept stable for grep-ability in production logs)', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stub = loadCanvasBridgeSource(join(tmpDir, 'ghost.js'))
      // Ops greps `canvas-bridge.js missing` to find this regression class
      // in shipped builds. Don't reshape the string casually.
      expect(stub).toBe(CANVAS_BRIDGE_MISSING_STUB)
      expect(stub).toBe('/* canvas-bridge.js missing */ (function () {})();\n')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('CANVAS_BRIDGE_DIR env override is honored (Desktop microVM path)', () => {
    // The bundled runtime boots from /opt/shogo/server.js inside the VM, so
    // the sibling formula would resolve to /opt/static (never shipped). The
    // VM boot sets CANVAS_BRIDGE_DIR=/opt/shogo/static; the loader must read
    // the bridge from there. Without this the in-VM runtime serves the empty
    // stub and the "Update available - Refresh" pill never appears - the
    // exact regression that survived PR #677 (which only fixed host exec).
    expect(resolveCanvasBridgePath({ CANVAS_BRIDGE_DIR: '/opt/shogo/static' }))
      .toBe(join('/opt/shogo/static', 'canvas-bridge.js'))
    // Whitespace-only / empty override is ignored (falls back to sibling).
    expect(resolveCanvasBridgePath({ CANVAS_BRIDGE_DIR: '   ' }))
      .toMatch(/[\\/]static[\\/]canvas-bridge\.js$/)
    // No override -> unchanged sibling-of-runtime-dir layout (Cloud + Desktop
    // host execution behave exactly as before).
    expect(resolveCanvasBridgePath({})).toBe(CANVAS_BRIDGE_PATH)
    // `undefined` env value is treated as "no override" (defensive: the VM
    // env block could omit the var on an older app build).
    expect(resolveCanvasBridgePath({ CANVAS_BRIDGE_DIR: undefined }))
      .toMatch(/[\\/]static[\\/]canvas-bridge\.js$/)
  })

  test('end-to-end: a CANVAS_BRIDGE_DIR override resolves AND loads the real file', () => {
    // This is the VM path in miniature: the bridge lives in an arbitrary
    // directory (in the VM, /opt/shogo/static) and the runtime is told about
    // it via CANVAS_BRIDGE_DIR. resolve + load must return the real bytes,
    // not the missing-file stub.
    const body = '/* vm bridge */ window.__VM_BRIDGE__ = 1;\n'
    writeFileSync(join(tmpDir, 'canvas-bridge.js'), body, 'utf-8')
    const resolved = resolveCanvasBridgePath({ CANVAS_BRIDGE_DIR: tmpDir })
    expect(resolved).toBe(join(tmpDir, 'canvas-bridge.js'))
    const loaded = loadCanvasBridgeSource(resolved)
    expect(loaded).toBe(body)
    expect(loaded).not.toContain(STUB_MARKER)
  })

  test('exported URL + script-tag constants are coherent (injection points line up)', () => {
    // The `<script src="...">` injected into workspace HTML must point at
    // the URL the runtime serves. A typo here breaks the bridge on every
    // page load, not just on missing-file regressions.
    expect(CANVAS_BRIDGE_URL).toBe('/agent/canvas/bridge.js')
    expect(CANVAS_BRIDGE_SCRIPT_TAG).toContain(CANVAS_BRIDGE_URL)
    expect(CANVAS_BRIDGE_SCRIPT_TAG).toMatch(/^<script\s/)
    expect(CANVAS_BRIDGE_SCRIPT_TAG).toContain('defer')
  })
})
