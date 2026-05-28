// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the hardcoded-port lint pass.
 *
 * The runtime injects two env vars (RUNTIME_PORT, API_SERVER_PORT) into the
 * sidecar so generated code can reference them instead of hardcoding 8080 /
 * 3001. This pass detects and rewrites the hardcoded form.
 */
import { describe, test, expect } from 'bun:test'
import {
  scanAndFixFile,
  getRuntimePortEnvMap,
  PROJECT_API_PORT,
  DEFAULT_RUNTIME_PORT,
} from '../lint-hardcoded-ports'

const ENV_MAP = new Map<string, string>([
  [PROJECT_API_PORT, 'API_SERVER_PORT'],
  [DEFAULT_RUNTIME_PORT, 'RUNTIME_PORT'],
])

describe('scanAndFixFile — autofix for known runtime ports in TS/JS', () => {
  test('rewrites double-quoted string with port 3001 to template literal with API_SERVER_PORT', () => {
    const before = `const url = "http://localhost:3001/api/foo"`
    const result = scanAndFixFile('src/foo.tsx', before, ENV_MAP)
    expect(result.fixes).toHaveLength(1)
    expect(result.fixes[0].envVar).toBe('API_SERVER_PORT')
    expect(result.fixes[0].line).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.newContent).toBe(
      'const url = `http://localhost:${process.env.API_SERVER_PORT}/api/foo`',
    )
  })

  test('rewrites single-quoted string with 127.0.0.1:8080 to template literal with RUNTIME_PORT', () => {
    const before = `fetch('http://127.0.0.1:8080/foo')`
    const result = scanAndFixFile('src/api.ts', before, ENV_MAP)
    expect(result.fixes).toHaveLength(1)
    expect(result.fixes[0].envVar).toBe('RUNTIME_PORT')
    expect(result.newContent).toBe(
      'fetch(`http://localhost:${process.env.RUNTIME_PORT}/foo`)',
    )
  })

  test('rewrites already-template-literal: swaps only the port, preserves other interpolations', () => {
    const before = 'const url = `http://localhost:3001/api/${id}`'
    const result = scanAndFixFile('src/foo.tsx', before, ENV_MAP)
    expect(result.fixes).toHaveLength(1)
    expect(result.newContent).toBe(
      'const url = `http://localhost:${process.env.API_SERVER_PORT}/api/${id}`',
    )
  })

  test('handles a URL with no path (bare host:port)', () => {
    const before = `const base = "http://localhost:3001"`
    const result = scanAndFixFile('src/cfg.ts', before, ENV_MAP)
    expect(result.fixes).toHaveLength(1)
    expect(result.newContent).toBe(
      'const base = `http://localhost:${process.env.API_SERVER_PORT}`',
    )
  })

  test('rewrites multiple occurrences in one file independently', () => {
    const before = [
      `const api = "http://localhost:3001/api"`,
      `const rt = 'http://localhost:8080/rt'`,
    ].join('\n')
    const result = scanAndFixFile('src/multi.ts', before, ENV_MAP)
    expect(result.fixes).toHaveLength(2)
    expect(result.fixes[0].envVar).toBe('API_SERVER_PORT')
    expect(result.fixes[1].envVar).toBe('RUNTIME_PORT')
    expect(result.fixes[1].line).toBe(2)
    expect(result.newContent).toBe(
      [
        'const api = `http://localhost:${process.env.API_SERVER_PORT}/api`',
        'const rt = `http://localhost:${process.env.RUNTIME_PORT}/rt`',
      ].join('\n'),
    )
  })

  test('reports correct 1-based line numbers', () => {
    const before = [
      `// header`,
      `// more`,
      `const url = "http://localhost:3001/x"`,
    ].join('\n')
    const result = scanAndFixFile('src/lines.ts', before, ENV_MAP)
    expect(result.fixes).toHaveLength(1)
    expect(result.fixes[0].line).toBe(3)
  })
})

describe('scanAndFixFile — errors for Python files with runtime ports', () => {
  test('returns error (no autofix) when .py file hardcodes 3001', () => {
    const before = `URL = "http://localhost:3001/api"\n`
    const result = scanAndFixFile('scripts/seed.py', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.newContent).toBeUndefined()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].reason).toContain("os.environ['API_SERVER_PORT']")
    expect(result.errors[0].line).toBe(1)
  })

  test('returns error (no autofix) when .py file hardcodes 8080', () => {
    const before = `URL = "http://localhost:8080/x"`
    const result = scanAndFixFile('script.py', before, ENV_MAP)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].reason).toContain("os.environ['RUNTIME_PORT']")
  })
})

describe('scanAndFixFile — warnings for unknown ports', () => {
  test('warns (no rewrite, no error) on http://localhost:5432 (unknown service port)', () => {
    const before = `const db = "http://localhost:5432/x"`
    const result = scanAndFixFile('src/db.ts', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].reason).toContain('5432')
    expect(result.newContent).toBeUndefined()
  })

  test('does not match non-http schemes like postgres://', () => {
    const before = `const db = "postgres://localhost:5432/x"`
    const result = scanAndFixFile('src/db.ts', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('warns on unknown port in .py too (no error, since not a runtime port)', () => {
    const before = `db = "http://localhost:5432/x"`
    const result = scanAndFixFile('scripts/db.py', before, ENV_MAP)
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })
})

describe('scanAndFixFile — non-matches', () => {
  test('leaves unrelated URLs alone', () => {
    const before = `const url = "http://api.example.com/x"`
    const result = scanAndFixFile('src/x.ts', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.newContent).toBeUndefined()
  })

  test('ignores bare port numbers that are not inside a URL string', () => {
    const before = `const port = 3001\nconst other = 8080\n`
    const result = scanAndFixFile('src/cfg.ts', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('ignores localhost:port appearing only in a comment (not a string literal)', () => {
    const before = `// see http://localhost:3001/api for the route\nconst x = 1`
    const result = scanAndFixFile('src/cfg.ts', before, ENV_MAP)
    expect(result.fixes).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.errors).toEqual([])
  })
})

describe('scanAndFixFile — idempotence', () => {
  test('re-running on rewritten content produces zero new fixes', () => {
    const before = `const url = "http://localhost:3001/api/foo"`
    const first = scanAndFixFile('src/foo.tsx', before, ENV_MAP)
    expect(first.newContent).toBeDefined()
    const second = scanAndFixFile('src/foo.tsx', first.newContent!, ENV_MAP)
    expect(second.fixes).toEqual([])
    expect(second.warnings).toEqual([])
    expect(second.errors).toEqual([])
    expect(second.newContent).toBeUndefined()
  })
})

describe('getRuntimePortEnvMap', () => {
  test('always includes the project API port mapping', () => {
    const map = getRuntimePortEnvMap()
    expect(map.get(PROJECT_API_PORT)).toBe('API_SERVER_PORT')
  })

  test('picks up process.env.PORT override for the runtime port slot', () => {
    const saved = process.env.PORT
    try {
      process.env.PORT = '9999'
      const map = getRuntimePortEnvMap()
      expect(map.get('9999')).toBe('RUNTIME_PORT')
    } finally {
      if (saved !== undefined) process.env.PORT = saved
      else delete process.env.PORT
    }
  })

  test('falls back to 8080 when process.env.PORT is unset', () => {
    const saved = process.env.PORT
    try {
      delete process.env.PORT
      const map = getRuntimePortEnvMap()
      expect(map.get('8080')).toBe('RUNTIME_PORT')
    } finally {
      if (saved !== undefined) process.env.PORT = saved
    }
  })
})
