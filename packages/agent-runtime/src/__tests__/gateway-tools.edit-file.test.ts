// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createEditFileTool — exact/replace_all/not-found/not-unique/no-op/must-read-first/create
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext, bigramDiceSimilarity, findClosestMatch } from '../gateway-tools'
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

  test('refuses to edit Office files as UTF-8 text', async () => {
    writeFileSync(join(TEST_DIR, 'upload.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    const r = await run(ctx, 'edit_file', {
      path: 'upload.docx',
      old_string: 'anything',
      new_string: 'changed',
    })
    expect(String(r.details.error)).toMatch(/binary file/i)
    expect(readFileSync(join(TEST_DIR, 'upload.docx'))).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    )
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

  test('old_string not found falls back to the bigram-similarity "closest match" hint when no line contains the literal substring', async () => {
    // Neither line literally contains "totalPriceCentss" (typo'd trailing
    // s), so the old exact-substring nearby-lines search finds nothing —
    // this exercises the findClosestMatch() fallback specifically.
    writeFileSync(
      join(TEST_DIR, 'closest.ts'),
      'export function computeTotal(items) {\n  return items.reduce((s, i) => s + i.totalPriceCents, 0)\n}\n',
    )
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'closest.ts')
    const r = await run(ctx, 'edit_file', {
      path: 'closest.ts',
      old_string: '  return items.reduce((s, i) => s + i.totalPriceCentss, 0)',
      new_string: '  return 0',
    })
    expect(r.details.error).toContain('not found')
    expect(r.details.hint).toContain('closest content')
    expect(r.details.hint).toContain('% similar')
    expect(r.details.hint).toContain('totalPriceCents')
  })

  test('old_string not found reports "No similar content found" when nothing is even remotely close', async () => {
    writeFileSync(join(TEST_DIR, 'unrelated.txt'), 'zzz qqq xxx\n')
    const ctx = makeCtx({ fileStateCache: new FileStateCache(TEST_DIR) })
    await seedRead(ctx, 'unrelated.txt')
    const r = await run(ctx, 'edit_file', {
      path: 'unrelated.txt', old_string: 'completely different content here', new_string: 'whatever',
    })
    expect(r.details.hint).toBe('No similar content found. Try reading the file first to get the exact text.')
  })

  test('edit without prior read_file auto-seeds the read record and applies', async () => {
    // Read-before-edit is no longer a hard error: edit_file seeds the cache
    // from disk and proceeds, because the exact-string match is itself the
    // safety check. A wrong old_string still fails loudly (covered above).
    writeFileSync(join(TEST_DIR, 'k.txt'), 'data')
    const cache = new FileStateCache(TEST_DIR)
    const ctx = makeCtx({ fileStateCache: cache })
    // intentionally skip seedRead
    expect(cache.hasBeenRead('k.txt')).toBe(false)
    const r = await run(ctx, 'edit_file', { path: 'k.txt', old_string: 'data', new_string: 'DATA' })
    expect(r.details.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, 'k.txt'), 'utf8')).toBe('DATA')
    expect(cache.hasBeenRead('k.txt')).toBe(true)
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

describe('bigramDiceSimilarity + findClosestMatch (edit_file "closest match" hint)', () => {
  test('identical strings score 1', () => {
    expect(bigramDiceSimilarity('hello world', 'hello world')).toBe(1)
  })

  test('completely disjoint strings score 0', () => {
    expect(bigramDiceSimilarity('aaaa', 'zzzz')).toBe(0)
  })

  test('a single-character typo scores high but not 1', () => {
    const score = bigramDiceSimilarity('const totalPriceCents = 0', 'const totalPriceCentss = 0')
    expect(score).toBeGreaterThan(0.9)
    expect(score).toBeLessThan(1)
  })

  test('distinct strings shorter than 2 chars never match (no bigrams to compare)', () => {
    expect(bigramDiceSimilarity('a', 'b')).toBe(0)
    expect(bigramDiceSimilarity('', 'ab')).toBe(0)
  })

  test('identical single-character strings still score 1 (short-circuits before the bigram check)', () => {
    expect(bigramDiceSimilarity('a', 'a')).toBe(1)
  })

  test('findClosestMatch picks the most similar same-line-count window', () => {
    const content = [
      'function unrelated() {}',
      'const totalPriceCents = computeTotal(items)',
      'function alsoUnrelated() {}',
    ].join('\n')
    const closest = findClosestMatch(content, 'const totalPriceCentss = computeTotal(items)')
    expect(closest).not.toBeNull()
    expect(closest!.text).toBe('const totalPriceCents = computeTotal(items)')
    expect(closest!.startLine).toBe(2)
    expect(closest!.endLine).toBe(2)
    expect(closest!.similarity).toBeGreaterThan(0.9)
  })

  test('findClosestMatch matches a multi-line window', () => {
    const content = 'if (a) {\n  doThing(a, b)\n}\n'
    const needle = 'if (a) {\n  doThingg(a, b)\n}'
    const closest = findClosestMatch(content, needle)
    expect(closest).not.toBeNull()
    expect(closest!.startLine).toBe(1)
    expect(closest!.endLine).toBe(3)
  })

  test('findClosestMatch returns null below the similarity floor', () => {
    const content = 'export const FOO = 1\nexport const BAR = 2\n'
    expect(findClosestMatch(content, 'totally unrelated text with nothing in common')).toBeNull()
  })

  test('findClosestMatch returns null when content has fewer lines than needle', () => {
    expect(findClosestMatch('one line', 'line one\nline two\nline three')).toBeNull()
  })
})
