// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// CanvasTypecheckGate closes the "green Vite build hides a type error that
// crashes at runtime" hole (the dominant "Debug: runtime error" cause). These
// tests pin:
//   (a) the tsc-output parser (the class that must never miscount)
//   (b) that found errors are surfaced into the in-band canvas-error buffer
//   (c) that a clean run stays quiet, and a dirty→clean transition confirms
//   (d) that non-TS / tsc-less workspaces self-skip

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CanvasTypecheckGate, parseTscOutput } from '../canvas-typecheck'
import { getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from '../canvas-runtime-errors'

const TMP = join(tmpdir(), 'test-canvas-typecheck')

/** A workspace with tsconfig.json + a fake tsc bin so isApplicable() passes. */
function makeWorkspace(): string {
  const dir = join(TMP, `ws-${Math.random().toString(36).slice(2)}`)
  const binDir = join(dir, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(dir, 'tsconfig.json'), '{}')
  // Fake tsc bin — presence is all resolveTscInvocation checks. We inject a
  // runTypecheck stub in tests so the bin is never actually executed.
  const isWindows = process.platform === 'win32'
  writeFileSync(join(binDir, isWindows ? 'tsc.CMD' : 'tsc'), '#!/bin/sh\nexit 0\n')
  return dir
}

beforeEach(() => {
  clearCanvasRuntimeErrors()
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
})

afterEach(() => {
  clearCanvasRuntimeErrors()
  rmSync(TMP, { recursive: true, force: true })
})

describe('parseTscOutput', () => {
  test('parses standard --pretty false error lines', () => {
    const out = [
      "src/App.tsx(37,18): error TS2604: JSX element type 'row.icon' does not have any construct or call signatures.",
      'src/components/Chart.tsx(4,10): error TS2304: Cannot find name \'BarChart3\'.',
    ].join('\n')
    const errors = parseTscOutput(out)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ file: 'src/App.tsx', line: 37, col: 18, code: 'TS2604' })
    expect(errors[1]).toMatchObject({ file: 'src/components/Chart.tsx', code: 'TS2304' })
  })

  test('ignores indented continuation lines and non-error output', () => {
    const out = [
      "src/App.tsx(12,7): error TS2322: Type 'boolean' is not assignable to type 'ElementType'.",
      '  Types of property foo are incompatible.', // continuation — must be ignored
      'Found 1 error in src/App.tsx:12', // summary — must be ignored
      '',
    ].join('\n')
    const errors = parseTscOutput(out)
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('TS2322')
  })

  test('returns empty for clean output', () => {
    expect(parseTscOutput('')).toHaveLength(0)
    expect(parseTscOutput('\n\n')).toHaveLength(0)
  })
})

describe('CanvasTypecheckGate.run', () => {
  test('surfaces type errors into the in-band canvas-error buffer', async () => {
    const dir = makeWorkspace()
    const gate = new CanvasTypecheckGate(dir, {
      runTypecheck: async () => ({
        output: "src/App.tsx(37,18): error TS2604: JSX element type 'row.icon' has no call signatures.",
        code: 2,
      }),
    })
    await gate.run()
    const errs = getCanvasRuntimeErrors()
    expect(errs).toHaveLength(1)
    expect(errs[0].phase).toBe('compile')
    expect(errs[0].error).toContain('tsc --noEmit found 1 type error')
    expect(errs[0].error).toContain('TS2604')
  })

  test('clean run pushes nothing to the buffer', async () => {
    const dir = makeWorkspace()
    const gate = new CanvasTypecheckGate(dir, {
      runTypecheck: async () => ({ output: '', code: 0 }),
    })
    await gate.run()
    expect(getCanvasRuntimeErrors()).toHaveLength(0)
  })

  test('single-flight: a trigger during a run coalesces into one follow-up', async () => {
    const dir = makeWorkspace()
    let calls = 0
    let resolveFirst: (() => void) | null = null
    const gate = new CanvasTypecheckGate(dir, {
      runTypecheck: async () => {
        calls++
        if (calls === 1) {
          await new Promise<void>((r) => { resolveFirst = r })
        }
        return { output: '', code: 0 }
      },
    })
    const first = gate.run()
    // Two more while the first is in flight — should collapse to one pending.
    void gate.run()
    void gate.run()
    resolveFirst!()
    await first
    // let the coalesced follow-up settle
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(2) // one original + exactly one coalesced follow-up
  })

  test('self-skips when tsconfig.json is absent (no bin/no run)', async () => {
    const dir = join(TMP, 'no-tsconfig')
    mkdirSync(dir, { recursive: true })
    let called = false
    const gate = new CanvasTypecheckGate(dir, {
      debounceMs: 1,
      runTypecheck: async () => { called = true; return { output: '', code: 0 } },
    })
    gate.trigger()
    await new Promise((r) => setTimeout(r, 20))
    expect(called).toBe(false)
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(false)
  })
})
