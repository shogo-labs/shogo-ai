// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * IndexEngine — Unit Tests
 *
 * Tests the unified IndexEngine across multiple scan sources:
 * - Multi-source configuration (code + files in one DB)
 * - Per-source reindex, search scoping, cross-cutting search
 * - Incremental reindex (add, modify, remove files)
 * - Graph boost integration via setGraph()
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { IndexEngine, createCodeSource, createFilesSource, type IndexEngineConfig, type ScanSource } from '../index-engine'

const TEST_DIR = '/tmp/test-index-engine-unit'
const CODE_DIR = TEST_DIR
const FILES_DIR = join(TEST_DIR, 'files')
const DB_DIR = join(TEST_DIR, '.shogo')

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(DB_DIR, { recursive: true })
  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
}

function writeCode(relPath: string, content: string) {
  const abs = join(TEST_DIR, relPath)
  const dir = abs.substring(0, abs.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

function writeFile(relPath: string, content: string) {
  const abs = join(FILES_DIR, relPath)
  const dir = abs.substring(0, abs.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

function makeConfig(): IndexEngineConfig {
  return {
    dbPath: join(DB_DIR, 'index.db'),
    sources: [createCodeSource(TEST_DIR), createFilesSource(TEST_DIR)],
  }
}

// ============================================================================
// Multi-source indexing
// ============================================================================

describe('IndexEngine: multi-source indexing', () => {
  let engine: IndexEngine

  beforeAll(() => {
    setup()

    writeCode('src/main.ts', 'export function main() { console.log("hello") }')
    writeCode('src/utils.ts', 'export function add(a: number, b: number) { return a + b }')
    writeCode('README.md', '# My Project\n\nA test project for indexing.')

    writeFile('report.md', '# Sales Report\n\nQ1 revenue was $5M.\n## Key Metrics\n- ARR: $20M')
    writeFile('data.csv', 'name,value\nalpha,100\nbeta,200')
    writeFile('notes.txt', 'Remember to update the database schema before deploy.')

    engine = new IndexEngine(makeConfig())
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('reindex all sources indexes both code and files', async () => {
    const result = await engine.reindex()
    expect(result.indexed).toBeGreaterThan(0)
    expect(result.total).toBeGreaterThanOrEqual(6)
  })

  test('getStats without source returns combined totals', () => {
    const stats = engine.getStats()
    expect(stats.totalFiles).toBeGreaterThanOrEqual(6)
    expect(stats.totalChunks).toBeGreaterThanOrEqual(6)
  })

  test('getStats with source filters correctly', () => {
    const codeStats = engine.getStats('code')
    const fileStats = engine.getStats('files')
    expect(codeStats.totalFiles).toBeGreaterThanOrEqual(3)
    expect(fileStats.totalFiles).toBe(3)
    expect(codeStats.totalFiles + fileStats.totalFiles).toBe(engine.getStats().totalFiles)
  })

  test('reindex single source only touches that source', async () => {
    writeFile('extra.txt', 'Extra file for files only')
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(1)
    const fileStats = engine.getStats('files')
    expect(fileStats.totalFiles).toBe(4)
  })
})

// ============================================================================
// Scoped and cross-cutting search
// ============================================================================

describe('IndexEngine: search scoping', () => {
  let engine: IndexEngine

  beforeAll(async () => {
    setup()

    writeCode('src/database.ts', 'export function connectDatabase() { return pg.connect("postgres://localhost") }')
    writeCode('src/api.ts', 'import { connectDatabase } from "./database"\nexport function startApi() { connectDatabase() }')

    writeFile('deploy-notes.md', '# Deployment\n\nMake sure the database connection string is correct.')
    writeFile('schema.txt', 'Table: users\nColumns: id, name, email, created_at')

    engine = new IndexEngine(makeConfig())
    await engine.reindex()
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('search scoped to code source only returns code files', async () => {
    const results = await engine.search('database', { source: 'code', limit: 10 })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.source).toBe('code')
    }
  })

  test('search scoped to files source only returns user files', async () => {
    const results = await engine.search('database', { source: 'files', limit: 10 })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.source).toBe('files')
    }
  })

  test('cross-cutting search (no source filter) returns both', async () => {
    const results = await engine.search('database', { limit: 20 })
    const sources = new Set(results.map(r => r.source))
    expect(sources.size).toBe(2)
    expect(sources.has('code')).toBe(true)
    expect(sources.has('files')).toBe(true)
  })

  test('pathFilter narrows within a source', async () => {
    const results = await engine.search('connectDatabase', { source: 'code', pathFilter: 'api' })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.path).toContain('api')
    }
  })

  test('extensions filter works', async () => {
    const results = await engine.search('database', { source: 'code', extensions: ['.ts'] })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.path.endsWith('.ts')).toBe(true)
    }
  })

  test('empty query returns empty results', async () => {
    const results = await engine.search('', { limit: 10 })
    expect(results.length).toBe(0)
  })
})

// ============================================================================
// Incremental reindex
// ============================================================================

describe('IndexEngine: incremental reindex', () => {
  let engine: IndexEngine

  beforeAll(async () => {
    setup()
    writeCode('src/app.ts', 'console.log("version 1")')
    writeFile('readme.md', '# Version 1')
    engine = new IndexEngine(makeConfig())
    await engine.reindex()
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('no changes means zero indexed', async () => {
    const result = await engine.reindex()
    expect(result.indexed).toBe(0)
    expect(result.removed).toBe(0)
  })

  test('modified file is re-indexed', async () => {
    await new Promise(r => setTimeout(r, 50))
    writeCode('src/app.ts', 'console.log("version 2 with new features")')
    const result = await engine.reindex('code')
    expect(result.indexed).toBe(1)
  })

  test('search finds updated content', async () => {
    const results = await engine.search('new features', { source: 'code' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].chunk).toContain('new features')
  })

  test('deleted file is removed from index', async () => {
    rmSync(join(FILES_DIR, 'readme.md'))
    const result = await engine.reindex('files')
    expect(result.removed).toBe(1)
  })

  test('new file is indexed', async () => {
    writeFile('changelog.md', '# Changelog\n- Added new feature')
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(1)
  })

  test('indexFile method works for single file', async () => {
    writeFile('quick.txt', 'Quick indexed content about Kubernetes')
    await engine.indexFile('files', 'quick.txt')
    const results = await engine.search('Kubernetes', { source: 'files' })
    expect(results.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// Graph boost integration
// ============================================================================

describe('IndexEngine: graph boost', () => {
  let engine: IndexEngine

  beforeAll(async () => {
    setup()
    writeCode('src/auth.ts', 'export function authenticate() { return true }')
    writeCode('src/login.ts', 'import { authenticate } from "./auth"\nexport function login() { authenticate() }')
    writeCode('src/register.ts', 'import { authenticate } from "./auth"\nexport function register() { authenticate() }')
    writeCode('src/unrelated.ts', 'export function formatDate() { return new Date().toISOString() }')
    engine = new IndexEngine(makeConfig())
    await engine.reindex('code')
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('setGraph enables graph-based score boosting', async () => {
    const mockGraph = {
      queryNeighbors: (qn: string) => {
        if (qn.includes('auth.ts')) {
          return [
            { filePath: 'src/login.ts' },
            { filePath: 'src/register.ts' },
          ]
        }
        return []
      },
    }

    engine.setGraph(mockGraph)

    const results = await engine.search('authenticate', { source: 'code', limit: 10 })
    expect(results.length).toBeGreaterThan(0)

    const authResult = results.find(r => r.path.includes('auth.ts'))
    expect(authResult).toBeDefined()
  })

  test('setGraph(null) disables boosting', async () => {
    engine.setGraph(null)
    const results = await engine.search('authenticate', { source: 'code', limit: 10 })
    expect(results.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// Source configuration
// ============================================================================

describe('IndexEngine: source configuration', () => {
  let engine: IndexEngine

  beforeAll(() => {
    setup()
    engine = new IndexEngine(makeConfig())
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('getSource returns correct source config', () => {
    const codeSrc = engine.getSource('code')
    expect(codeSrc).toBeDefined()
    expect(codeSrc!.id).toBe('code')
    expect(codeSrc!.scanDir).toBe(TEST_DIR)

    const filesSrc = engine.getSource('files')
    expect(filesSrc).toBeDefined()
    expect(filesSrc!.id).toBe('files')
    expect(filesSrc!.scanDir).toBe(FILES_DIR)
  })

  test('getSource returns undefined for unknown source', () => {
    expect(engine.getSource('nonexistent')).toBeUndefined()
  })

  test('getDatabase returns a valid database handle', () => {
    const db = engine.getDatabase()
    expect(db).toBeDefined()
    const result = db.prepare('SELECT 1 as one').get() as { one: number }
    expect(result.one).toBe(1)
  })
})
