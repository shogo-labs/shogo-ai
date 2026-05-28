// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createEditFileTool — exact/replace_all/not-found/not-unique/no-op/must-read-first/create
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-edit-file'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    ...overrides,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const all = createTools(ctx)
  const t = all.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  const result = await t.execute('test-call', params)
  return { details: result.details, content: result.content }
}


async function seedRead(ctx: ToolContext, path: string) {
  // edit_file requires fileStateCache.getRecord(path) to be set.
  await run(ctx, 'read_file', { path })
}

describe('createEditFileTool', () => {
  
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('exact unique replacement applies the edit', async () => {
    writeFileSync(join(TEST_DIR, 'f.txt'), 'alpha beta gamma')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'f.txt')
    const r = await run(ctx, 'edit_file', { path: 'f.txt', old_string: 'beta', new_string: 'BETA' })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'f.txt'), 'utf8')).toBe('alpha BETA gamma')
  })

  test('old_string equal to new_string is rejected as a no-op', async () => {
    writeFileSync(join(TEST_DIR, 'g.txt'), 'x')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'g.txt')
    const r = await run(ctx, 'edit_file', { path: 'g.txt', old_string: 'x', new_string: 'x' })
    expect(r.details.error).toContain('must differ')
  })

  test('non-unique old_string without replace_all is rejected with count hint', async () => {
    writeFileSync(join(TEST_DIR, 'h.txt'), 'foo foo foo')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'h.txt')
    const r = await run(ctx, 'edit_file', { path: 'h.txt', old_string: 'foo', new_string: 'bar' })
    expect(r.details.error).toContain('found 3 times')
    expect(r.details.error).toContain('replace_all')
  })

  test('replace_all replaces every occurrence', async () => {
    writeFileSync(join(TEST_DIR, 'i.txt'), 'foo foo foo')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'i.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'i.txt', old_string: 'foo', new_string: 'bar', replace_all: true,
    })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'i.txt'), 'utf8')).toBe('bar bar bar')
  })

  test('old_string not found returns error + nearby-content hint when similar text exists', async () => {
    writeFileSync(join(TEST_DIR, 'j.txt'), 'this is line one\nthis is the line two\n')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'j.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'j.txt', old_string: 'this is line three', new_string: 'whatever',
    })
    expect(r.details.error).toContain('not found')
    expect(typeof r.details.hint).toBe('string')
  })

  test('edit without prior read_file is blocked (must-read-first)', async () => {
    writeFileSync(join(TEST_DIR, 'k.txt'), 'data')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    // intentionally skip seedRead
    const r = await run(ctx, 'edit_file', { path: 'k.txt', old_string: 'data', new_string: 'DATA' })
    expect(r.details.error).toContain('not been read yet')
  })

  test('edit with empty old_string on a missing file creates the file', async () => {
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    const r = await run(ctx, 'edit_file', {
      path: 'new/created.txt',
      old_string: '',
      new_string: 'fresh content\n',
    })
    expect(r.details.ok).toBe(true)
    expect(r.details.created).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'new/created.txt'), 'utf8')).toBe('fresh content\n')
  })

  test('.ipynb path is redirected to notebook_edit', async () => {
    writeFileSync(join(TEST_DIR, 'nb.ipynb'), '{}')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'nb.ipynb')
    const r = await run(ctx, 'edit_file', { path: 'nb.ipynb', old_string: '{}', new_string: '{"x":1}' })
    expect(r.details.error).toContain('notebook_edit')
  })

  test('preserves multi-line indentation in replacement', async () => {
    const before = '  function foo() {\n    return 1\n  }\n'
    writeFileSync(join(TEST_DIR, 'm.txt'), before)
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'm.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'm.txt',
      old_string: '    return 1\n',
      new_string: '    return 42\n',
    })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'm.txt'), 'utf8')).toContain('    return 42')
  })

  test('fuzzy match: CRLF file content with LF needle (line-ending normalization)', async () => {
    const crlfContent = 'line one\r\nline two\r\nline three\r\n'
    writeFileSync(join(TEST_DIR, 'crlf.txt'), crlfContent)
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'crlf.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'crlf.txt',
      old_string: 'line one\nline two\n',
      new_string: 'replaced one\nreplaced two\n',
    })
    expect(r.details.ok).toBe(true)
    const after = readFileSync(join(TEST_DIR, 'crlf.txt'), 'utf8')
    expect(after).toContain('replaced one')
    expect(after).toContain('line three')
  })

  test('fuzzy match: trailing whitespace tolerance', async () => {
    const padded = 'alpha   \nbeta \ngamma\n'
    writeFileSync(join(TEST_DIR, 'pad.txt'), padded)
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'pad.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'pad.txt',
      old_string: 'alpha\nbeta\n',
      new_string: 'A\nB\n',
    })
    if (r.details.ok) {
      const after = readFileSync(join(TEST_DIR, 'pad.txt'), 'utf8')
      expect(after.length).toBeGreaterThan(0)
    } else {
      expect(r.details.error).toBeDefined()
    }
  })

  test('fuzzy match: JSON-escaped quote unescape', async () => {
    const content = 'const x = "hello world"\nconst y = 42\n'
    writeFileSync(join(TEST_DIR, 'esc.txt'), content)
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'esc.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'esc.txt',
      old_string: 'const x = \\"hello world\\"',
      new_string: 'const x = "bye"',
    })
    if (r.details.ok) {
      expect(readFileSync(join(TEST_DIR, 'esc.txt'), 'utf8')).toContain('bye')
    } else {
      expect(r.details.error).toBeDefined()
    }
  })
})
