// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { BUILT_IN_MATCHERS, MatcherEngine } from '../problem-matchers'

describe('MatcherEngine — tsc', () => {
  const engine = new MatcherEngine()
  it('parses a canonical tsc error line', () => {
    const out = engine.run(1, 'src/foo.ts(12,5): error TS2304: Cannot find name \'bar\'.')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      file: 'src/foo.ts',
      line: 12,
      column: 5,
      severity: 'error',
      code: 'TS2304',
      message: "Cannot find name 'bar'.",
      source: 'terminal',
    })
  })
  it('flags warnings as warnings', () => {
    const out = engine.run(2, 'a.ts(1,1): warning TS9000: heads up')
    expect(out[0].severity).toBe('warning')
  })
})

describe('MatcherEngine — unix style', () => {
  const engine = new MatcherEngine()
  it('parses gcc-style errors', () => {
    const out = engine.run(1, 'main.c:42:7: error: undeclared identifier \'foo\'')
    expect(out[0]).toMatchObject({
      file: 'main.c', line: 42, column: 7, severity: 'error',
    })
  })
  it('maps "note" severity to info', () => {
    const out = engine.run(1, 'main.c:1:1: note: previously declared here')
    expect(out[0].severity).toBe('info')
  })
})

describe('MatcherEngine — python traceback', () => {
  const engine = new MatcherEngine()
  it('parses File "..." line N entries with column 0 → fallback 1', () => {
    const out = engine.run(1, '  File "app/main.py", line 17, in handler')
    expect(out[0].file).toBe('app/main.py')
    expect(out[0].line).toBe(17)
    expect(out[0].column).toBe(1)
    expect(out[0].severity).toBe('error')
  })
})

describe('MatcherEngine — go', () => {
  const engine = new MatcherEngine()
  it('parses standard go vet/compile errors', () => {
    const out = engine.run(1, 'pkg/foo.go:23:4: undefined: bar')
    expect(out[0].file).toBe('pkg/foo.go')
    expect(out[0].severity).toBe('error')
  })
})

describe('MatcherEngine — rustc', () => {
  const engine = new MatcherEngine()
  it('parses --> file:line:col arrow', () => {
    const out = engine.run(1, '   --> src/lib.rs:8:13')
    expect(out[0].file).toBe('src/lib.rs')
    expect(out[0].line).toBe(8)
    expect(out[0].column).toBe(13)
    expect(out[0].severity).toBe('error')
  })
})

describe('MatcherEngine — multi-line and de-dup', () => {
  const engine = new MatcherEngine()
  it('reports independent diagnostics per matching line', () => {
    const out = engine.run(1, [
      'a.ts(1,1): error TS1: x',
      'b.ts(2,2): error TS2: y',
    ].join('\n'))
    expect(out).toHaveLength(2)
    expect(out[0].file).toBe('a.ts')
    expect(out[1].file).toBe('b.ts')
  })
  it('dedupes identical file:line:col:message entries', () => {
    const dup = 'a.ts(1,1): error TS1: x'
    const out = engine.run(1, `${dup}\n${dup}`)
    expect(out).toHaveLength(1)
  })
  it('attaches an incrementing local id per diagnostic in the same command', () => {
    const out = engine.run(7, [
      'a.ts(1,1): error TS1: x',
      'b.ts(2,2): error TS2: y',
    ].join('\n'))
    expect(out[0].id).toBe('terminal-7-0')
    expect(out[1].id).toBe('terminal-7-1')
  })
  it('ignores lines with no file capture', () => {
    const out = engine.run(1, 'just a log line, no diagnostic here')
    expect(out).toHaveLength(0)
  })
  it('handles CRLF as well as LF line breaks', () => {
    const out = engine.run(1, 'a.ts(1,1): error TS1: x\r\nb.ts(2,2): error TS2: y\r\n')
    expect(out).toHaveLength(2)
  })
  it('falls back to fallback=1 when the line/column capture is not a positive integer', () => {
    // Use a custom matcher to force degenerate captures.
    const engine2 = new MatcherEngine([{
      id: 'weird',
      pattern: /^(.+?):(.+?):(.+?):\s+(.+)$/,
      file: 1, line: 2, column: 3, severity: 'error', message: 4,
    }])
    const out = engine2.run(1, 'x.ts:abc:def: oops')
    expect(out[0].line).toBe(1)
    expect(out[0].column).toBe(1)
  })
})

describe('MatcherEngine — BUILT_IN_MATCHERS', () => {
  it('exposes a non-empty matcher list', () => {
    expect(BUILT_IN_MATCHERS.length).toBeGreaterThan(0)
  })
  it('each matcher has a non-empty id and a RegExp pattern', () => {
    for (const m of BUILT_IN_MATCHERS) {
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      expect(m.pattern).toBeInstanceOf(RegExp)
    }
  })
})
