// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * File Workspace & RAG — End-to-End Tests
 *
 * Tests the full file management and search flow:
 * 1. IndexEngine (files source) — indexing, FTS5 search, incremental reindex
 * 2. API endpoints — CRUD, upload, download, tree, search
 * 3. Agent tools — list_files, delete_file, search
 *
 * Runs against a real temp workspace with actual SQLite databases.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { IndexEngine, createFilesSource } from '../index-engine'
import { createTools } from '../gateway-tools'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = '/tmp/test-file-workspace-e2e'
const FILES_DIR = join(TEST_DIR, 'files')

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(FILES_DIR, { recursive: true })
}

function writeTestFile(relPath: string, content: string) {
  const absPath = join(FILES_DIR, relPath)
  const dir = absPath.substring(0, absPath.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(absPath, content, 'utf-8')
}

// ============================================================================
// 1. IndexEngine (files source) — Core RAG Engine
// ============================================================================

describe('IndexEngine (files source)', () => {
  let engine: IndexEngine

  beforeAll(() => {
    setupWorkspace()

    writeTestFile('readme.md', [
      '# Project Documentation',
      '',
      'This project implements a RAG system using SQLite.',
      'It supports .txt, .csv, and .md files.',
      '',
      '## Features',
      '- Full-text search with FTS5',
      '- Vector search with sqlite-vec',
      '- Incremental indexing',
      '- Hybrid ranking',
    ].join('\n'))

    writeTestFile('team.csv', [
      'name,role,department',
      'Alice,Engineer,Platform',
      'Bob,Designer,Product',
      'Charlie,PM,Product',
      'Diana,Engineer,Infrastructure',
      'Eve,Analyst,Data Science',
    ].join('\n'))

    writeTestFile('notes.txt', [
      'Meeting notes from sprint planning',
      '',
      'Topics discussed:',
      '- Database migration strategy',
      '- API versioning approach',
      '- Performance benchmarks for search queries',
      '- User feedback on file management UI',
      '',
      'Action items:',
      '1. Complete sqlite-vec integration',
      '2. Add upload/download endpoints',
      '3. Build file browser component',
    ].join('\n'))

    writeTestFile('reports/q1-summary.md', [
      '# Q1 2026 Summary',
      '',
      'Revenue: $5.2M (up 18% YoY)',
      'Active users: 12,400',
      'Churn rate: 2.1%',
      '',
      '## Highlights',
      '- Launched RAG file search feature',
      '- Improved agent response time by 30%',
      '- Added 5 new MCP integrations',
    ].join('\n'))

    const dbDir = join(TEST_DIR, '.shogo')
    mkdirSync(dbDir, { recursive: true })
    engine = new IndexEngine({
      dbPath: join(dbDir, 'index.db'),
      sources: [createFilesSource(TEST_DIR)],
    })
  })

  afterAll(() => {
    engine.close()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('reindex discovers and indexes all supported files', async () => {
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(4)
    expect(result.removed).toBe(0)
    expect(result.total).toBe(4)
  })

  test('getStats returns correct counts', () => {
    const stats = engine.getStats('files')
    expect(stats.totalFiles).toBe(4)
    expect(stats.totalChunks).toBeGreaterThanOrEqual(4)
    expect(typeof stats.embeddingsEnabled).toBe('boolean')
  })

  test('keyword search finds relevant documents', async () => {
    const results = await engine.search('database migration', { source: 'files', limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    const noteResult = results.find(r => r.path === 'notes.txt')
    expect(noteResult).toBeDefined()
    expect(noteResult!.chunk).toContain('Database migration')
  })

  test('search matches CSV content', async () => {
    const results = await engine.search('Alice Engineer Platform', { source: 'files', limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    const csvResult = results.find(r => r.path === 'team.csv')
    expect(csvResult).toBeDefined()
  })

  test('search finds content in subdirectories', async () => {
    const results = await engine.search('revenue churn rate', { source: 'files', limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    const reportResult = results.find(r => r.path === 'reports/q1-summary.md')
    expect(reportResult).toBeDefined()
  })

  test('search with path_filter narrows results', async () => {
    const results = await engine.search('search', { source: 'files', limit: 10, pathFilter: 'reports' })
    const allInReports = results.every(r => r.path.includes('reports'))
    expect(allInReports).toBe(true)
  })

  test('incremental reindex skips unchanged files', async () => {
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(0)
    expect(result.removed).toBe(0)
  })

  test('reindex detects modified files', async () => {
    await new Promise(r => setTimeout(r, 50))
    writeTestFile('notes.txt', 'Updated content: new sprint notes about Kubernetes deployment.')
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(1)
  })

  test('reindex detects deleted files', async () => {
    rmSync(join(FILES_DIR, 'team.csv'))
    const result = await engine.reindex('files')
    expect(result.removed).toBe(1)
    expect(result.total).toBe(3)
  })

  test('search after delete no longer returns deleted file', async () => {
    const results = await engine.search('Alice Engineer', { source: 'files', limit: 10 })
    const csvResult = results.find(r => r.path === 'team.csv')
    expect(csvResult).toBeUndefined()
  })

  test('reindex detects new files', async () => {
    writeTestFile('changelog.md', '# Changelog\n\n## v1.0\n- Initial release with file search')
    const result = await engine.reindex('files')
    expect(result.indexed).toBe(1)
    expect(result.total).toBe(4)
  })

  test('search returns results with scores', async () => {
    const results = await engine.search('sqlite search', { source: 'files', limit: 10 })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(typeof r.score).toBe('number')
      expect(r.path).toBeDefined()
      expect(r.chunk).toBeDefined()
    }
  })

  test('empty query returns empty results', async () => {
    const results = await engine.search('', { source: 'files', limit: 10 })
    expect(results.length).toBe(0)
  })

  test('getSource returns files source config', () => {
    const src = engine.getSource('files')
    expect(src).toBeDefined()
    expect(src!.scanDir).toBe(FILES_DIR)
  })
})

// ============================================================================
// 2. HTTP API Endpoints (via Hono app.request)
// ============================================================================

describe('Workspace API Endpoints', () => {
  let baseUrl: string
  let server: any

  beforeAll(async () => {
    setupWorkspace()

    // Start a minimal agent runtime server for testing
    const port = 19876
    baseUrl = `http://localhost:${port}`

    // Set env before importing server
    process.env.AGENT_DIR = TEST_DIR
    process.env.PORT = String(port)
    process.env.PROJECT_ID = 'test-file-workspace'

    // We test against the running server via fetch
    // The server is started in the beforeAll hook
    const { Hono } = await import('hono')
    const { serve } = await import('bun')

    // Instead of importing the full server (which has many side effects),
    // we test the endpoint logic via direct HTTP calls to the running server.
    // If the server is not running, skip these tests.
    try {
      await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
    } catch {
      console.log('Agent runtime not running on port 19876 — skipping API tests')
      return
    }
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // Skip API tests if server isn't running — the IndexEngine tests above
  // cover the core logic. API tests can be run when the server is started separately.
})

// ============================================================================
// 3. Agent Tools (gateway-tools integration)
// ============================================================================

describe('File Management Agent Tools', () => {
  beforeAll(() => {
    setupWorkspace()
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('list_files tool returns directory contents', async () => {
    writeTestFile('doc.md', '# Hello')
    writeTestFile('data.csv', 'a,b\n1,2')
    writeTestFile('sub/nested.txt', 'nested content')

    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const listTool = tools.find(t => t.name === 'list_files')
    expect(listTool).toBeDefined()

    const result = await listTool!.execute('test-call', {})
    const data = JSON.parse((result.content[0] as any).text)
    expect(data.entries.length).toBeGreaterThanOrEqual(3)
    expect(data.entries.some((e: any) => e.name === 'doc.md')).toBe(true)
    expect(data.entries.some((e: any) => e.type === 'directory')).toBe(true)
  })

  test('list_files with recursive shows nested files', async () => {
    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const listTool = tools.find(t => t.name === 'list_files')!

    const result = await listTool.execute('test-call', { recursive: true })
    const data = JSON.parse((result.content[0] as any).text)
    const paths = data.entries.map((e: any) => e.path)
    expect(paths.some((p: string) => p.includes('sub/'))).toBe(true)
  })

  test('delete_file removes a file', async () => {
    writeTestFile('to-delete.txt', 'delete me')
    expect(existsSync(join(FILES_DIR, 'to-delete.txt'))).toBe(true)

    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const deleteTool = tools.find(t => t.name === 'delete_file')!

    const result = await deleteTool.execute('test-call', { path: 'to-delete.txt' })
    const data = JSON.parse((result.content[0] as any).text)
    expect(data.ok).toBe(true)
    expect(existsSync(join(FILES_DIR, 'to-delete.txt'))).toBe(false)
  })

  test('delete_file rejects path traversal', async () => {
    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const deleteTool = tools.find(t => t.name === 'delete_file')!

    const result = await deleteTool.execute('test-call', { path: '../../etc/passwd' })
    const data = JSON.parse((result.content[0] as any).text)
    expect(data.error).toBeDefined()
  })

  test('search tool returns search results', async () => {
    writeTestFile('searchable.md', '# SQLite Vector Search\n\nThis document covers sqlite-vec integration for RAG.')

    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const searchTool = tools.find(t => t.name === 'search')!

    const result = await searchTool.execute('test-call', { query: 'sqlite vector RAG' })
    const data = JSON.parse((result.content[0] as any).text)
    expect(data.results.length).toBeGreaterThan(0)
    expect(data.stats).toBeDefined()
    expect(data.stats.totalFiles).toBeGreaterThan(0)
  })

  test('search with path_filter', async () => {
    const ctx: any = {
      workspaceDir: TEST_DIR,
      channels: new Map(),
      config: { heartbeatInterval: 1800, heartbeatEnabled: false, channels: [] },
      projectId: 'test',
    }

    const tools = createTools(ctx)
    const searchTool = tools.find(t => t.name === 'search')!

    const result = await searchTool.execute('test-call', {
      query: 'content',
      path_filter: 'sub',
    })
    const data = JSON.parse((result.content[0] as any).text)
    const allFiltered = data.results.every((r: any) => r.path.includes('sub'))
    expect(allFiltered).toBe(true)
  })
})

// ============================================================================
// 4. HTTP API Integration Tests (against running server)
// ============================================================================

describe('Workspace HTTP API Integration', () => {
  const TEST_API_DIR = '/tmp/test-file-api-e2e'
  const PORT = 19877
  const BASE = `http://localhost:${PORT}`
  let proc: any

  beforeAll(async () => {
    rmSync(TEST_API_DIR, { recursive: true, force: true })
    mkdirSync(join(TEST_API_DIR, 'files'), { recursive: true })
    mkdirSync(join(TEST_API_DIR, 'memory'), { recursive: true })
    mkdirSync(join(TEST_API_DIR, 'skills'), { recursive: true })
    writeFileSync(join(TEST_API_DIR, 'config.json'), JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      loopDetection: false,
    }))
    writeFileSync(join(TEST_API_DIR, 'AGENTS.md'), '# Identity\nTest Agent\n\n# Personality\nTest persona\n\n# User\nTest user\n\n# Operating Instructions\nTest agent')
    writeFileSync(join(TEST_API_DIR, 'MEMORY.md'), '# Memory')

    // Start the server as a subprocess
    proc = Bun.spawn(
      ['bun', 'run', 'src/server.ts'],
      {
        cwd: join(import.meta.dir, '..', '..'),
        env: {
          ...process.env,
          AGENT_DIR: TEST_API_DIR,
          PORT: String(PORT),
          PROJECT_ID: 'test-api-e2e',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )

    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) })
        if (res.ok) break
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
  })

  afterAll(async () => {
    if (proc) {
      proc.kill()
      await proc.exited
    }
    rmSync(TEST_API_DIR, { recursive: true, force: true })
  })

  test('GET /agent/workspace/tree returns empty tree', async () => {
    const res = await fetch(`${BASE}/agent/workspace/tree`)
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.tree).toBeInstanceOf(Array)
  })

  test('PUT /agent/workspace/files/* creates a file', async () => {
    const res = await fetch(`${BASE}/agent/workspace/files/test.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Test File\n\nHello world.' }),
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.path).toBe('test.md')
  })

  test('GET /agent/workspace/files/* reads a file', async () => {
    const res = await fetch(`${BASE}/agent/workspace/files/test.md`)
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.content).toContain('Hello world')
    expect(data.path).toBe('test.md')
  })

  test('GET /agent/workspace/tree shows created file', async () => {
    const res = await fetch(`${BASE}/agent/workspace/tree`)
    const data = await res.json() as any
    const file = data.tree.find((e: any) => e.name === 'test.md')
    expect(file).toBeDefined()
    expect(file.type).toBe('file')
  })

  test('POST /agent/workspace/mkdir creates a directory', async () => {
    const res = await fetch(`${BASE}/agent/workspace/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'reports' }),
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })

  test('PUT file in subdirectory', async () => {
    const res = await fetch(`${BASE}/agent/workspace/files/reports/q1.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Q1 Report\n\nRevenue: $5.2M\nGrowth: 18%' }),
    })
    expect(res.ok).toBe(true)
  })

  test('tree shows nested directories', async () => {
    const res = await fetch(`${BASE}/agent/workspace/tree`)
    const data = await res.json() as any
    const reportsDir = data.tree.find((e: any) => e.name === 'reports')
    expect(reportsDir).toBeDefined()
    expect(reportsDir.type).toBe('directory')
    expect(reportsDir.children.length).toBeGreaterThan(0)
  })

  test('POST /agent/workspace/search returns keyword results', async () => {
    // Create searchable content
    await fetch(`${BASE}/agent/workspace/files/search-target.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'The quick brown fox jumps over the lazy dog. SQLite database engine.' }),
    })

    // Small delay for indexing
    await new Promise(r => setTimeout(r, 100))

    const res = await fetch(`${BASE}/agent/workspace/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SQLite database', limit: 5 }),
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.results.length).toBeGreaterThan(0)
    expect(data.stats).toBeDefined()
  })

  test('GET /agent/workspace/download/* returns file content', async () => {
    const res = await fetch(`${BASE}/agent/workspace/download/test.md`)
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const text = await res.text()
    expect(text).toContain('Hello world')
  })

  test('DELETE /agent/workspace/files/* removes a file', async () => {
    // Create then delete
    await fetch(`${BASE}/agent/workspace/files/deleteme.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'to be deleted' }),
    })

    const res = await fetch(`${BASE}/agent/workspace/files/deleteme.txt`, {
      method: 'DELETE',
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.ok).toBe(true)

    // Verify gone
    const res2 = await fetch(`${BASE}/agent/workspace/files/deleteme.txt`)
    expect(res2.status).toBe(404)
  })

  test('POST /agent/workspace/upload handles multipart upload', async () => {
    const formData = new FormData()
    formData.append('files', new File(['uploaded content here'], 'uploaded.txt', { type: 'text/plain' }))

    const res = await fetch(`${BASE}/agent/workspace/upload`, {
      method: 'POST',
      body: formData,
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.uploaded).toContain('uploaded.txt')

    // Verify file exists
    const readRes = await fetch(`${BASE}/agent/workspace/files/uploaded.txt`)
    const readData = await readRes.json() as any
    expect(readData.content).toBe('uploaded content here')
  })

  test('POST /agent/workspace/reindex triggers manual reindex', async () => {
    const res = await fetch(`${BASE}/agent/workspace/reindex`, {
      method: 'POST',
    })
    expect(res.ok).toBe(true)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(typeof data.total).toBe('number')
  })

  test('path traversal is blocked', async () => {
    const res = await fetch(`${BASE}/agent/workspace/files/../../../etc/passwd`)
    expect(res.ok).toBe(false)
  })
})
