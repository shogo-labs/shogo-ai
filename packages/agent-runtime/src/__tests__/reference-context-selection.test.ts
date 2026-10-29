// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('@shogo/shared-runtime', () => ({ isBinaryFilePath: () => false }))
const { buildReferencedContext, MAX_SELECTION_CHARS } = await import('../reference-context')

let dir: string
const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ref-selection-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'big.ts'), lines.join('\n'))
  writeFileSync(join(dir, 'src', 'crlf.ts'), lines.join('\r\n'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sel = (over: Record<string, unknown>) => ({
  type: 'selection',
  path: 'src/big.ts',
  name: 'big.ts',
  startLine: 10,
  endLine: 12,
  text: lines.slice(9, 12).join('\n'),
  languageId: 'typescript',
  ...over,
})

describe('selection references', () => {
  test('renders header, line range, language and the text, with no flags when it matches disk', () => {
    const out = buildReferencedContext([sel({})], dir)
    expect(out).toContain('[Referenced Selection: src/big.ts lines 10-12 (typescript)]\nline 10\nline 11\nline 12\n[End of Referenced Selection]')
    expect(out).not.toContain('unsaved')
    expect(out).not.toContain('editor snapshot')
  })

  test('a mid-line selection that occurs in the saved lines is not flagged', () => {
    const out = buildReferencedContext([sel({ text: 'ne 10\nline 1' })], dir)
    expect(out).not.toContain('unsaved')
  })

  test('flags unsaved editor changes when the text differs from disk', () => {
    const out = buildReferencedContext([sel({ text: 'line 10\nEDITED\nline 12' })], dir)
    expect(out).toContain('lines 10-12 (typescript) (includes unsaved editor changes)]')
  })

  test('CRLF files compare after line-ending normalization', () => {
    const out = buildReferencedContext([sel({ path: 'src/crlf.ts', text: lines.slice(9, 12).join('\r\n') })], dir)
    expect(out).not.toContain('unsaved')
  })

  test('a very large saved file is not read for the comparison, and is not called out of workspace', () => {
    writeFileSync(join(dir, 'src', 'huge.ts'), `${lines.join('\n')}\n${'x'.repeat(3 * 1024 * 1024)}`)
    const out = buildReferencedContext([sel({ path: 'src/huge.ts', text: 'line 10\nEDITED\nline 12' })], dir)
    expect(out).toContain('[Referenced Selection: src/huge.ts lines 10-12 (typescript)]')
    expect(out).not.toContain('unsaved')
    expect(out).not.toContain('editor snapshot')
  })

  test('a trailing newline in the selection does not count as a change', () => {
    const out = buildReferencedContext([sel({ text: `${lines.slice(9, 12).join('\n')}\n` })], dir)
    expect(out).not.toContain('unsaved')
  })

  test('missing or outside-workspace paths are an editor snapshot', () => {
    const missing = buildReferencedContext([sel({ path: 'src/nope.ts' })], dir)
    expect(missing).toContain('(not in agent workspace — editor snapshot)')
    const outside = buildReferencedContext([sel({ path: '../../etc/passwd' })], dir)
    expect(outside).toContain('(not in agent workspace — editor snapshot)')
    expect(outside).toContain('line 10')
  })

  test('truncates at MAX_SELECTION_CHARS and flags it', () => {
    const out = buildReferencedContext([sel({ text: 'x'.repeat(MAX_SELECTION_CHARS + 50) })], dir)
    expect(out).toContain('(truncated)')
    const body = out.split('\n').find((l) => l.startsWith('xxx'))!
    expect(body.length).toBe(MAX_SELECTION_CHARS)
  })

  test('a client-side truncated flag is preserved', () => {
    expect(buildReferencedContext([sel({ truncated: true })], dir)).toContain('(truncated)')
  })

  test('invalid line numbers render as "lines ?"', () => {
    for (const bad of [{ startLine: 0 }, { startLine: 5, endLine: 3 }, { startLine: 1.5 }, { startLine: 'x' }]) {
      expect(buildReferencedContext([sel(bad)], dir)).toContain('[Referenced Selection: src/big.ts lines ? (typescript)')
    }
  })

  test('empty or whitespace text is skipped', () => {
    expect(buildReferencedContext([sel({ text: '   \n ' })], dir)).toBe('')
    expect(buildReferencedContext([sel({ text: undefined })], dir)).toBe('')
  })

  test('shares the total budget with file references', () => {
    writeFileSync(join(dir, 'huge.txt'), 'y'.repeat(64 * 1024))
    const files = Array.from({ length: 4 }, () => ({ type: 'file', path: 'huge.txt', name: 'huge.txt' }))
    const out = buildReferencedContext([...files, sel({})], dir)
    expect(out).toContain('[Referenced Selection: src/big.ts lines 10-12] Skipped — reference context size limit reached.')
  })
})
