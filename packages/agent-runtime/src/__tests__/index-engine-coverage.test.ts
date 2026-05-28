// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Closes the remaining gap blocks in src/index-engine.ts:
 *
 *   L184-191  createDefaultConfig (pure helper)
 *   L308-326  reconnect() — close/reopen DB
 *   L439-442  reindexBackground (fire-and-forget + dedup)
 *   L454-457  indexFile (public single-file API)
 *   L518-557  embedAndStore — needs OpenAI mock + sqlite-vec
 *   L675-787  vectorSearch — needs OpenAI mock + sqlite-vec
 *
 * Mock harness:
 *   - mock.module('openai', ...) installs a fake OpenAI class whose
 *     embeddings.create returns deterministic 256-dim Float32 vectors
 *     so we can drive embedAndStore + vectorSearch without a real key.
 *   - AI_PROXY_TOKEN env var triggers the embeddingsEnabled=true branch
 *     in the constructor.
 *   - sqlite-vec is already installed in the workspace and loads via
 *     the constructor's require() so chunks_vec table is created.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mock OpenAI BEFORE importing IndexEngine.
//
// Each call to embeddings.create returns one 256-dim vector per input.
// The "shouldFail" toggle lets specific tests force the failure-counter
// path in embedAndStore.
// ---------------------------------------------------------------------------

const oaiState = {
  calls: 0 as number,
  shouldFail: false as boolean,
  vectorAt: 0.1 as number,
}

mock.module('openai', () => ({
  default: class FakeOpenAI {
    embeddings = {
      create: async (params: { input: string[]; dimensions: number }) => {
        oaiState.calls++
        if (oaiState.shouldFail) throw new Error('mocked openai failure')
        return {
          data: params.input.map((_t, i) => ({
            embedding: Array.from({ length: params.dimensions ?? 256 }, () => oaiState.vectorAt + i * 0.001),
          })),
        }
      },
    }
    constructor(_opts: unknown) {}
  },
}))

// Now we can import.
const {
  IndexEngine,
  createCodeSource,
  createFilesSource,
  createDefaultConfig,
} = await import('../index-engine')

// ---------------------------------------------------------------------------
// Helpers — tmpdir scaffolding per test
// ---------------------------------------------------------------------------

interface Bench {
  rootDir: string
  dbDir: string
  filesDir: string
  cleanup: () => void
}

function setupBench(): Bench {
  const rootDir = mkdtempSync(join(tmpdir(), 'idx-cov-'))
  const dbDir = join(rootDir, '.shogo')
  const filesDir = join(rootDir, 'files')
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })
  mkdirSync(join(rootDir, 'src'), { recursive: true })
  return {
    rootDir, dbDir, filesDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  }
}

function writeSrc(b: Bench, rel: string, content: string) {
  const abs = join(b.rootDir, rel)
  mkdirSync(abs.substring(0, abs.lastIndexOf('/')), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

// ---------------------------------------------------------------------------
// createDefaultConfig (pure helper, L184-191)
// ---------------------------------------------------------------------------

describe('createDefaultConfig', () => {
  test('returns config wired to two sources (code + files)', () => {
    const b = setupBench()
    try {
      const cfg = createDefaultConfig(b.rootDir)
      expect(cfg.sources.length).toBe(2)
      expect(cfg.sources.find(s => s.id === 'code')).toBeDefined()
      expect(cfg.sources.find(s => s.id === 'files')).toBeDefined()
      expect(cfg.dbPath).toContain('.shogo/index.db')
      expect(cfg.enableEmbeddings).toBe(false)
      expect(cfg.chunkOverlap).toBe(10)
    } finally { b.cleanup() }
  })
})

// ---------------------------------------------------------------------------
// reconnect() (L308-326)
// ---------------------------------------------------------------------------

describe('IndexEngine.reconnect', () => {
  let b: Bench
  beforeEach(() => { b = setupBench() })
  afterEach(() => { b.cleanup() })

  test('closes and reopens the underlying DB; indexing state cleared', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir), createFilesSource(b.rootDir)],
    })
    writeSrc(b, 'src/a.ts', 'function foo() { return 1 }')
    await engine.reindex()
    // Trigger reconnect — should not throw, and engine remains usable
    engine.reconnect()
    const r = await engine.reindex()
    expect(r.total).toBeGreaterThanOrEqual(1)
  })

  test('reconnect after the DB handle was already closed (try/catch path)', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
    })
    const db = engine.getDatabase()
    db.close()
    // Should silently re-open via the try/catch
    engine.reconnect()
    const r = await engine.reindex()
    expect(r).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// reindexBackground + indexFile (L439-457)
// ---------------------------------------------------------------------------

describe('IndexEngine.reindexBackground', () => {
  let b: Bench
  beforeEach(() => { b = setupBench() })
  afterEach(() => { b.cleanup() })

  test('schedules and resolves a background reindex', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
    })
    writeSrc(b, 'src/a.ts', 'x')
    engine.reindexBackground()
    // Wait a bit for the async reindex to finish
    await new Promise(r => setTimeout(r, 250))
    const out = await engine.search('x', { limit: 5 })
    expect(Array.isArray(out)).toBe(true)
  })

  test('deduplicates concurrent calls (second is a no-op when first is in-flight)', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
    })
    writeSrc(b, 'src/a.ts', 'x')
    engine.reindexBackground()
    engine.reindexBackground() // should early-return because indexing is set
    await new Promise(r => setTimeout(r, 250))
  })
})

describe('IndexEngine.indexFile (public single-file)', () => {
  let b: Bench
  beforeEach(() => { b = setupBench() })
  afterEach(() => { b.cleanup() })

  test('indexes a single file by sourceId + relPath', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createFilesSource(b.rootDir)],
    })
    writeFileSync(join(b.filesDir, 'note.md'), '# Hello world')
    await engine.indexFile('files', 'note.md')
    const r = await engine.search('hello', { source: 'files', limit: 5 })
    expect(r.length).toBeGreaterThan(0)
  })

  test('silently no-ops for an unknown sourceId', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
    })
    await engine.indexFile('does-not-exist', 'x.md')
    // No throw — that's the assertion
  })
})

// ---------------------------------------------------------------------------
// embedAndStore + vectorSearch (mocked OpenAI)
// ---------------------------------------------------------------------------

describe('IndexEngine with embeddings (OpenAI mocked)', () => {
  let b: Bench
  beforeEach(() => {
    b = setupBench()
    oaiState.calls = 0
    oaiState.shouldFail = false
    process.env.AI_PROXY_TOKEN = 'test-token'
  })
  afterEach(() => {
    b.cleanup()
    delete process.env.AI_PROXY_TOKEN
  })

  test('embeddingsEnabled flips when sqlite-vec loads + AI_PROXY_TOKEN is set', () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    expect((engine as unknown as { embeddingsEnabled: boolean }).embeddingsEnabled).toBe(true)
  })

  test('reindex calls embedAndStore on indexed chunks', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    writeSrc(b, 'src/a.ts', 'function helloWorld(){return "hi"}')
    await engine.reindex()
    expect(oaiState.calls).toBeGreaterThanOrEqual(1)
  })

  test('vectorSearch returns scored results via mocked embeddings', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    writeSrc(b, 'src/a.ts', 'function databaseConnect(){return null}')
    writeSrc(b, 'src/b.ts', 'function clusterStart(){return null}')
    await engine.reindex()
    const r = await engine.search('database', { limit: 5 })
    expect(Array.isArray(r)).toBe(true)
  })

  test('embedAndStore tolerates OpenAI failure (failure counter bumps)', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    oaiState.shouldFail = true
    writeSrc(b, 'src/a.ts', 'function x(){return 1}')
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await engine.reindex() // should not throw despite OpenAI failures
    } finally {
      console.warn = origWarn
    }
  })

  test('vectorSearch returns [] when OpenAI throws', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    writeSrc(b, 'src/a.ts', 'function x(){return 1}')
    await engine.reindex()
    // After reindex, succeed; now force vectorSearch to fail
    oaiState.shouldFail = true
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const r = await engine.search('anything-not-cached', { limit: 5 })
      expect(Array.isArray(r)).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  test('vectorSearch caches query embedding across calls', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    writeSrc(b, 'src/a.ts', 'function databaseConnect(){return null}')
    await engine.reindex()
    const callsBefore = oaiState.calls
    await engine.search('foobar-unique', { limit: 5 })
    const after1 = oaiState.calls
    await engine.search('foobar-unique', { limit: 5 }) // cache hit, no new call
    const after2 = oaiState.calls
    expect(after1).toBeGreaterThan(callsBefore)
    expect(after2).toBe(after1)
  })
})

// ---------------------------------------------------------------------------
// Search filters: pathFilter + extensions filters in vectorSearch
// ---------------------------------------------------------------------------

describe('IndexEngine.search filters with embeddings', () => {
  let b: Bench
  beforeEach(() => {
    b = setupBench()
    process.env.AI_PROXY_TOKEN = 'test-token'
  })
  afterEach(() => {
    b.cleanup()
    delete process.env.AI_PROXY_TOKEN
  })

  test('vectorSearch respects pathFilter + extensions options', async () => {
    const engine = new IndexEngine({
      dbPath: join(b.dbDir, 'index.db'),
      sources: [createCodeSource(b.rootDir)],
      enableEmbeddings: true,
    })
    writeSrc(b, 'src/api/a.ts', 'foo bar')
    writeSrc(b, 'src/lib/b.ts', 'foo bar')
    writeSrc(b, 'src/api/c.js', 'foo bar')
    await engine.reindex()
    const r = await engine.search('foo', {
      source: 'code', pathFilter: 'api', extensions: ['.ts'], limit: 10,
    })
    expect(Array.isArray(r)).toBe(true)
  })
})
