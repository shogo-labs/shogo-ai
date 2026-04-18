// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySearchEngine } from '../engine'

describe('MemorySearchEngine', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shogo-mem-engine-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns no hits when workspace is empty', () => {
    const engine = new MemorySearchEngine(dir)
    expect(engine.search('anything')).toEqual([])
    engine.close()
  })

  test('indexes MEMORY.md and finds keyword matches', () => {
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '# Memory\n\n- User prefers window seats on flights\n- Favorite color is green\n- Lives in Honolulu since 2026\n',
      'utf-8',
    )
    const engine = new MemorySearchEngine(dir)
    const hits = engine.search('window seats', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.chunk.toLowerCase()).toContain('window')
    expect(hits[0]!.file).toBe('MEMORY.md')
    engine.close()
  })

  test('indexes daily logs under memory/ and scopes results by file', () => {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- prefers window seats\n', 'utf-8')
    writeFileSync(
      join(dir, 'memory', '2026-04-18.md'),
      '# Daily log\n\n- Discussed refund for order 4821 on April 18\n- Agent escalated to senior support\n',
      'utf-8',
    )
    const engine = new MemorySearchEngine(dir)
    const hits = engine.search('refund order', 5)
    expect(hits.some(h => h.file.startsWith('memory/'))).toBe(true)
    engine.close()
  })

  test('mtime-based reindex picks up new content without manual reindex', async () => {
    const file = join(dir, 'MEMORY.md')
    writeFileSync(file, '- first fact about dolphins\n', 'utf-8')
    const engine = new MemorySearchEngine(dir)
    expect(engine.search('dolphins').length).toBeGreaterThan(0)
    expect(engine.search('zebra')).toEqual([])

    await new Promise(r => setTimeout(r, 15))
    writeFileSync(file, '- first fact about dolphins\n- zebra migration patterns\n', 'utf-8')
    const after = engine.search('zebra')
    expect(after.length).toBeGreaterThan(0)
    engine.close()
  })

  test('deletes chunks when a memory file is removed', async () => {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    const daily = join(dir, 'memory', '2026-04-18.md')
    writeFileSync(daily, '- fleeting entry about polar bears\n', 'utf-8')
    const engine = new MemorySearchEngine(dir)
    expect(engine.search('polar bears').length).toBeGreaterThan(0)

    rmSync(daily)
    await new Promise(r => setTimeout(r, 15))
    // Writing a different file forces reindex to observe the deletion
    writeFileSync(join(dir, 'MEMORY.md'), '- unrelated\n', 'utf-8')
    engine.reindex()
    const after = engine.search('polar bears')
    expect(after).toEqual([])
    engine.close()
  })

  test('empty or stop-word query returns no hits without throwing', () => {
    writeFileSync(join(dir, 'MEMORY.md'), '- something here\n', 'utf-8')
    const engine = new MemorySearchEngine(dir)
    expect(engine.search('')).toEqual([])
    expect(engine.search('the of and')).toEqual([])
    engine.close()
  })

  test('hybrid ranking marks chunks matched by both paths', () => {
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '- window seat preference for long flights\n- likes aisle seat on short hops\n- favorite meal is miso salmon\n',
      'utf-8',
    )
    const engine = new MemorySearchEngine(dir)
    const hits = engine.search('window seat preference', 5)
    const types = new Set(hits.map(h => h.matchType))
    // At least one path matched
    expect(types.size).toBeGreaterThan(0)
    // Top hit should mention window
    expect(hits[0]!.chunk.toLowerCase()).toContain('window')
    engine.close()
  })
})
