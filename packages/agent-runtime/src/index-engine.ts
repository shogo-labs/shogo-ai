// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified Index Engine
 *
 * Provides hybrid keyword + vector search across multiple scan sources
 * (workspace code, user-uploaded files, etc.) using a single SQLite database.
 * Uses FTS5 for full-text search with BM25 ranking and optionally sqlite-vec
 * for vector similarity search with OpenAI embeddings.
 *
 * Replaces the former CodeIndexEngine and FileIndexEngine with a single
 * config-driven class. Each scan source defines its own root directory,
 * extension filter, skip patterns, and chunk size.
 */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, type Dirent } from 'fs'
import { join, extname } from 'path'
import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  source: string
  path: string
  chunk: string
  score: number
  lineStart: number
  lineEnd: number
  matchType: 'keyword' | 'vector' | 'hybrid'
}

export interface SearchOptions {
  source?: string
  limit?: number
  pathFilter?: string
  extensions?: string[]
}

interface Chunk {
  source: string
  path: string
  chunk: string
  chunkIdx: number
  lineStart: number
  lineEnd: number
}

// ---------------------------------------------------------------------------
// Source Config
// ---------------------------------------------------------------------------

export interface ScanSource {
  id: string
  scanDir: string
  extensions?: Set<string>
  skipDirs?: Set<string>
  skipFilePatterns?: RegExp[]
  maxFileSize?: number
  chunkLines?: number
}

export interface IndexEngineConfig {
  dbPath: string
  sources: ScanSource[]
  chunkOverlap?: number
  enableEmbeddings?: boolean
}

// ---------------------------------------------------------------------------
// Built-in source presets
// ---------------------------------------------------------------------------

export const CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php', '.swift', '.m',
  '.yml', '.yaml', '.toml', '.cfg', '.ini', '.conf',
  '.json', '.md', '.rst', '.txt',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.proto',
  '.css', '.scss', '.less', '.html', '.xml', '.svg',
])

export const CODE_SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', '.nox', '.eggs', '.egg-info', 'dist', 'build', '.build',
  'venv', '.venv', 'env', '.env', '.cache',
  '.next', '.nuxt', '.svelte-kit', '.turbo',
  'target', 'out', 'coverage', '.coverage',
  '.swe-bench',
])

export const CODE_SKIP_FILE_PATTERNS = [/\.pyc$/, /\.pyo$/, /\.so$/, /\.dylib$/, /\.wasm$/, /\.min\.js$/, /\.map$/]

export const FILE_EXTENSIONS = new Set(['.txt', '.csv', '.md'])

export function createCodeSource(workspaceDir: string): ScanSource {
  return {
    id: 'code',
    scanDir: workspaceDir,
    extensions: CODE_EXTENSIONS,
    skipDirs: CODE_SKIP_DIRS,
    skipFilePatterns: CODE_SKIP_FILE_PATTERNS,
    maxFileSize: 512 * 1024,
    chunkLines: 40,
  }
}

export function createFilesSource(workspaceDir: string): ScanSource {
  return {
    id: 'files',
    scanDir: join(workspaceDir, 'files'),
    extensions: FILE_EXTENSIONS,
    chunkLines: 30,
  }
}

export function createDefaultConfig(workspaceDir: string): IndexEngineConfig {
  const dbDir = join(workspaceDir, '.shogo')
  mkdirSync(dbDir, { recursive: true })
  return {
    dbPath: join(dbDir, 'index.db'),
    sources: [createCodeSource(workspaceDir), createFilesSource(workspaceDir)],
    chunkOverlap: 10,
    enableEmbeddings: false,
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSIONS = 256
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_BATCH_SIZE = 64
const DEFAULT_CHUNK_LINES = 40
const DEFAULT_CHUNK_OVERLAP = 10
const MAX_EMBEDDING_FAILURES = 3

// ---------------------------------------------------------------------------
// IndexEngine
// ---------------------------------------------------------------------------

export class IndexEngine {
  private db: Database
  private dbPath: string
  private sources: Map<string, ScanSource>
  private chunkOverlap: number
  private openai: OpenAI | null = null
  private embeddingsEnabled: boolean
  private vecExtensionLoaded: boolean = false
  private indexing: Promise<any> | null = null
  private consecutiveEmbeddingFailures = 0
  private graph: { queryNeighbors(qn: string, edgeKinds?: string[], depth?: number): Array<{ filePath: string }> } | null = null

  constructor(config: IndexEngineConfig) {
    this.dbPath = config.dbPath
    const dbDir = config.dbPath.substring(0, config.dbPath.lastIndexOf('/'))
    if (dbDir) mkdirSync(dbDir, { recursive: true })

    this.db = new Database(config.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

    this.sources = new Map(config.sources.map(s => [s.id, s]))
    this.chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP

    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(this.db)
      this.vecExtensionLoaded = true
    } catch {
      this.vecExtensionLoaded = false
    }

    const directKey = process.env.OPENAI_API_KEY
    const proxyUrl = process.env.TOOLS_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    const effectiveKey = directKey || proxyToken

    if (config.enableEmbeddings && effectiveKey && this.vecExtensionLoaded) {
      this.openai = new OpenAI({
        apiKey: effectiveKey,
        baseURL: process.env.OPENAI_BASE_URL || (
          !directKey && proxyUrl ? `${proxyUrl}/openai` : undefined
        ),
      })
      this.embeddingsEnabled = true
    } else {
      this.embeddingsEnabled = false
    }

    // Ensure scan directories exist for writable sources (e.g. files/)
    for (const src of config.sources) {
      if (src.id === 'files') {
        mkdirSync(src.scanDir, { recursive: true })
      }
    }

    this.initSchema()
  }

  /**
   * Close and reopen the database connection. Call when the underlying
   * database file may have been deleted or replaced (e.g. between eval runs).
   */
  reconnect(): void {
    try { this.db.close() } catch { /* already closed or broken */ }

    const dbDir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'))
    if (dbDir) mkdirSync(dbDir, { recursive: true })

    this.db = new Database(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(this.db)
      this.vecExtensionLoaded = true
    } catch {
      this.vecExtensionLoaded = false
    }

    this.indexing = null
    this.initSchema()
  }

  /** Expose the underlying Database handle for co-located tables (e.g. WorkspaceGraph). */
  getDatabase(): Database {
    return this.db
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

      CREATE TABLE IF NOT EXISTS meta (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meta_source ON meta(source);
    `)

    const ftsExists = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks_fts'`
    ).get()
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          path, chunk, source,
          content=chunks, content_rowid=id,
          tokenize='porter unicode61'
        );
      `)
    }

    if (this.embeddingsEnabled) {
      const vecExists = this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks_vec'`
      ).get()
      if (!vecExists) {
        this.db.exec(
          `CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${EMBEDDING_DIMENSIONS}])`
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  async reindex(sourceId?: string): Promise<{ indexed: number; removed: number; total: number }> {
    let totalIndexed = 0
    let totalRemoved = 0

    const sourcesToIndex = sourceId
      ? [this.sources.get(sourceId)].filter(Boolean) as ScanSource[]
      : [...this.sources.values()]

    for (const src of sourcesToIndex) {
      const diskFiles = this.discoverFiles(src)
      const getMeta = this.db.prepare('SELECT mtime_ms FROM meta WHERE path = ? AND source = ?')

      const toIndex: string[] = []
      const diskPaths = new Set(diskFiles.map(f => f.relativePath))

      for (const { relativePath, absolutePath } of diskFiles) {
        try {
          const stat = statSync(absolutePath)
          const meta = getMeta.get(relativePath, src.id) as { mtime_ms: number } | undefined
          if (!meta || meta.mtime_ms < stat.mtimeMs) {
            toIndex.push(relativePath)
          }
        } catch { /* file disappeared between discover and stat */ }
      }

      const indexedPaths = this.db.prepare('SELECT path FROM meta WHERE source = ?').all(src.id) as { path: string }[]
      const toRemove = indexedPaths.filter(r => !diskPaths.has(r.path)).map(r => r.path)

      for (const path of toRemove) {
        this.removeFromIndex(path, src.id)
      }

      for (const relPath of toIndex) {
        await this.indexFileInternal(src, relPath)
      }

      totalIndexed += toIndex.length
      totalRemoved += toRemove.length
    }

    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM meta').get() as { cnt: number }).cnt
    return { indexed: totalIndexed, removed: totalRemoved, total }
  }

  /** Fire-and-forget reindex that deduplicates concurrent calls. */
  reindexBackground(sourceId?: string): void {
    if (this.indexing) return
    this.indexing = this.reindex(sourceId)
      .catch(err => console.warn(`[index-engine] Background reindex failed: ${err.message}`))
      .finally(() => { this.indexing = null })
  }

  /**
   * Index a single file by source ID and relative path.
   * Used for best-effort indexing on file upload (server.ts).
   */
  async indexFile(sourceId: string, relPath: string): Promise<void> {
    const src = this.sources.get(sourceId)
    if (!src) return
    await this.indexFileInternal(src, relPath)
  }

  private async indexFileInternal(src: ScanSource, relPath: string): Promise<void> {
    if (src.skipDirs) {
      const segments = relPath.split('/')
      if (segments.some(s => src.skipDirs!.has(s))) return
    }

    const absPath = join(src.scanDir, relPath)
    if (!existsSync(absPath)) return

    if (src.skipFilePatterns?.some(p => p.test(relPath))) return

    if (src.maxFileSize) {
      try {
        const stat = statSync(absPath)
        if (stat.size > src.maxFileSize) return
      } catch { return }
    }

    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch { return }

    const stat = statSync(absPath)
    const chunkLines = src.chunkLines ?? DEFAULT_CHUNK_LINES
    const chunks = this.chunkText(content, relPath, src.id, chunkLines)

    this.removeFromIndex(relPath, src.id)

    const insertChunk = this.db.prepare(
      'INSERT INTO chunks (source, path, chunk, chunk_idx, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertFts = this.db.prepare(
      'INSERT INTO chunks_fts (rowid, path, chunk, source) VALUES (?, ?, ?, ?)'
    )

    const chunkIds: number[] = []

    const insertAll = this.db.transaction(() => {
      for (const chunk of chunks) {
        const result = insertChunk.run(chunk.source, chunk.path, chunk.chunk, chunk.chunkIdx, chunk.lineStart, chunk.lineEnd)
        const rowId = Number(result.lastInsertRowid)
        chunkIds.push(rowId)
        insertFts.run(rowId, chunk.path, chunk.chunk, chunk.source)
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO meta (path, source, mtime_ms, size_bytes, chunk_count) VALUES (?, ?, ?, ?, ?)'
      ).run(relPath, src.id, stat.mtimeMs, stat.size, chunks.length)
    })

    insertAll()

    if (this.embeddingsEnabled && chunks.length > 0) {
      await this.embedAndStore(chunks, chunkIds)
    }
  }

  private async embedAndStore(chunks: Chunk[], chunkIds: number[]): Promise<void> {
    if (!this.openai) return
    if (this.consecutiveEmbeddingFailures >= MAX_EMBEDDING_FAILURES) return

    const texts = chunks.map(c => c.chunk)
    const insertVec = this.db.prepare(
      'INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)'
    )

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      if (this.consecutiveEmbeddingFailures >= MAX_EMBEDDING_FAILURES) return

      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
      const batchIds = chunkIds.slice(i, i + EMBEDDING_BATCH_SIZE)

      try {
        const response = await this.openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        })

        this.consecutiveEmbeddingFailures = 0

        const insertBatch = this.db.transaction(() => {
          for (let j = 0; j < response.data.length; j++) {
            const embedding = new Float32Array(response.data[j].embedding)
            insertVec.run(batchIds[j], embedding)
          }
        })
        insertBatch()
      } catch (err: any) {
        this.consecutiveEmbeddingFailures++
        if (this.consecutiveEmbeddingFailures >= MAX_EMBEDDING_FAILURES) {
          console.warn(`[index-engine] Embedding disabled after ${MAX_EMBEDDING_FAILURES} consecutive failures (last: ${err.message})`)
        }
      }
    }
  }

  private removeFromIndex(relPath: string, sourceId: string): void {
    const chunkRows = this.db.prepare(
      'SELECT id FROM chunks WHERE path = ? AND source = ?'
    ).all(relPath, sourceId) as { id: number }[]
    if (chunkRows.length > 0) {
      for (const { id } of chunkRows) {
        this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(id)
        if (this.embeddingsEnabled) {
          this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(id)
        }
      }
    }
    this.db.prepare('DELETE FROM chunks WHERE path = ? AND source = ?').run(relPath, sourceId)
    this.db.prepare('DELETE FROM meta WHERE path = ? AND source = ?').run(relPath, sourceId)
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Attach a WorkspaceGraph for graph-neighbor score boosting in search results.
   * The graph is optional — when absent, search uses pure FTS5/vector scoring.
   */
  setGraph(graph: { queryNeighbors(qn: string, edgeKinds?: string[], depth?: number): Array<{ filePath: string }> } | null): void {
    this.graph = graph
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const { source, limit = 10, pathFilter, extensions } = opts

    if (this.indexing) await this.indexing
    await this.reindex(source)

    const keywordResults = this.keywordSearch(query, limit * 2, source, pathFilter, extensions)

    let vectorResults: SearchResult[] = []
    if (this.embeddingsEnabled) {
      vectorResults = await this.vectorSearch(query, limit * 2, source, pathFilter, extensions)
    }

    if (vectorResults.length === 0) {
      const boosted = this.applyGraphBoost(keywordResults)
      return boosted.slice(0, limit)
    }

    const merged = new Map<string, SearchResult>()

    for (const r of keywordResults) {
      merged.set(`${r.source}:${r.path}:${r.lineStart}`, r)
    }

    for (const r of vectorResults) {
      const key = `${r.source}:${r.path}:${r.lineStart}`
      const existing = merged.get(key)
      if (existing) {
        existing.score = existing.score * 0.4 + r.score * 0.6
        existing.matchType = 'hybrid'
      } else {
        merged.set(key, r)
      }
    }

    const results = [...merged.values()]
    const boosted = this.applyGraphBoost(results)
    return boosted
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * Boost scores for results whose files are graph-neighbors of top-scoring results.
   * Files within 2 edges of a top hit get a +0.2 score boost.
   */
  private applyGraphBoost(results: SearchResult[]): SearchResult[] {
    if (!this.graph || results.length === 0) return results

    try {
      const sorted = [...results].sort((a, b) => b.score - a.score)
      const topPaths = new Set(sorted.slice(0, 3).map(r => r.path))
      const neighborPaths = new Set<string>()

      for (const topPath of topPaths) {
        const topSource = sorted.find(r => r.path === topPath)?.source
        if (!topSource) continue
        const qn = `${topSource}::${topPath}`
        const neighbors = this.graph.queryNeighbors(qn, undefined, 2)
        for (const n of neighbors) {
          if (!topPaths.has(n.filePath)) {
            neighborPaths.add(n.filePath)
          }
        }
      }

      if (neighborPaths.size === 0) return results

      const GRAPH_BOOST = 0.2
      for (const r of results) {
        if (neighborPaths.has(r.path)) {
          r.score = Math.min(1.0, r.score + GRAPH_BOOST)
        }
      }
    } catch { /* graph query failed — return unboosted results */ }

    return results
  }

  private keywordSearch(
    query: string, limit: number, source?: string, pathFilter?: string, extensions?: string[],
  ): SearchResult[] {
    try {
      const escaped = query.replace(/['"]/g, ' ').trim()
      if (!escaped) return []

      const terms = escaped.split(/\s+/).filter(Boolean)
      const ftsQuery = terms.map(t => `"${t}"`).join(' OR ')

      let sql = `
        SELECT c.source, c.path, c.chunk, c.line_start, c.line_end, f.rank
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH ?
      `
      const params: any[] = [ftsQuery]

      if (source) {
        sql += ` AND c.source = ?`
        params.push(source)
      }

      if (pathFilter) {
        sql += ` AND c.path LIKE ?`
        params.push(`%${pathFilter}%`)
      }

      sql += ` ORDER BY f.rank LIMIT ?`
      params.push(limit * 3)

      let rows = this.db.prepare(sql).all(...params) as Array<{
        source: string; path: string; chunk: string; line_start: number; line_end: number; rank: number
      }>

      if (extensions && extensions.length > 0) {
        const extSet = new Set(extensions.map(e => e.startsWith('.') ? e : `.${e}`))
        rows = rows.filter(r => extSet.has(extname(r.path).toLowerCase()))
      }

      rows = rows.slice(0, limit)
      if (rows.length === 0) return []
      const maxRank = Math.max(...rows.map(r => Math.abs(r.rank)))

      return rows.map(r => ({
        source: r.source,
        path: r.path,
        chunk: r.chunk,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        score: maxRank > 0 ? 1 - (Math.abs(r.rank) / maxRank) : 0.5,
        matchType: 'keyword' as const,
      }))
    } catch {
      return []
    }
  }

  private async vectorSearch(
    query: string, limit: number, source?: string, pathFilter?: string, extensions?: string[],
  ): Promise<SearchResult[]> {
    if (!this.openai) return []

    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: [query],
        dimensions: EMBEDDING_DIMENSIONS,
      })

      const queryEmbedding = new Float32Array(response.data[0].embedding)

      let sql = `
        SELECT v.chunk_id, v.distance, c.source, c.path, c.chunk, c.line_start, c.line_end
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = ?
      `
      const params: any[] = [queryEmbedding, limit * 3]

      if (source) {
        sql += ` AND c.source = ?`
        params.push(source)
      }

      if (pathFilter) {
        sql += ` AND c.path LIKE ?`
        params.push(`%${pathFilter}%`)
      }

      sql += ` ORDER BY v.distance`

      let rows = this.db.prepare(sql).all(...params) as Array<{
        chunk_id: number; distance: number; source: string; path: string; chunk: string; line_start: number; line_end: number
      }>

      if (extensions && extensions.length > 0) {
        const extSet = new Set(extensions.map(e => e.startsWith('.') ? e : `.${e}`))
        rows = rows.filter(r => extSet.has(extname(r.path).toLowerCase()))
      }

      rows = rows.slice(0, limit)
      if (rows.length === 0) return []
      const maxDist = Math.max(...rows.map(r => r.distance), 0.001)

      return rows.map(r => ({
        source: r.source,
        path: r.path,
        chunk: r.chunk,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        score: 1 - (r.distance / maxDist),
        matchType: 'vector' as const,
      }))
    } catch (err: any) {
      console.warn(`[index-engine] Vector search failed: ${err.message}`)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // File Discovery
  // ---------------------------------------------------------------------------

  private discoverFiles(src: ScanSource): Array<{ relativePath: string; absolutePath: string }> {
    if (!existsSync(src.scanDir)) return []
    return this.walkDir(src, src.scanDir, '')
  }

  private walkDir(src: ScanSource, dir: string, prefix: string): Array<{ relativePath: string; absolutePath: string }> {
    const results: Array<{ relativePath: string; absolutePath: string }> = []

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as Dirent[]
    } catch { return results }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const absPath = join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (src.skipDirs?.has(entry.name)) continue
        if (entry.name === 'node_modules') continue
        results.push(...this.walkDir(src, absPath, relPath))
      } else if (this.shouldIndex(src, entry.name, absPath)) {
        results.push({ relativePath: relPath, absolutePath: absPath })
      }
    }

    return results
  }

  private shouldIndex(src: ScanSource, name: string, absPath: string): boolean {
    if (src.extensions) {
      const ext = extname(name).toLowerCase()
      if (!src.extensions.has(ext)) return false
    }
    if (src.skipFilePatterns?.some(p => p.test(name))) return false
    if (src.maxFileSize) {
      try {
        const stat = statSync(absPath)
        if (stat.size > src.maxFileSize) return false
      } catch { return false }
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Text Chunking
  // ---------------------------------------------------------------------------

  private chunkText(content: string, filePath: string, source: string, chunkLines: number): Chunk[] {
    const lines = content.split('\n')

    if (lines.length <= chunkLines) {
      return [{
        source,
        path: filePath,
        chunk: content.trim(),
        chunkIdx: 0,
        lineStart: 1,
        lineEnd: lines.length,
      }]
    }

    const chunks: Chunk[] = []
    let chunkIdx = 0
    const step = chunkLines - this.chunkOverlap

    for (let i = 0; i < lines.length; i += step) {
      const end = Math.min(i + chunkLines, lines.length)
      const text = lines.slice(i, end).join('\n').trim()
      if (text.length > 20) {
        chunks.push({
          source,
          path: filePath,
          chunk: text,
          chunkIdx,
          lineStart: i + 1,
          lineEnd: end,
        })
        chunkIdx++
      }
      if (end >= lines.length) break
    }

    return chunks
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  getStats(sourceId?: string): { totalFiles: number; totalChunks: number; embeddingsEnabled: boolean } {
    if (sourceId) {
      const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM meta WHERE source = ?').get(sourceId) as { cnt: number }).cnt
      const chunks = (this.db.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE source = ?').get(sourceId) as { cnt: number }).cnt
      return { totalFiles: files, totalChunks: chunks, embeddingsEnabled: this.embeddingsEnabled }
    }
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM meta').get() as { cnt: number }).cnt
    const chunks = (this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt
    return { totalFiles: files, totalChunks: chunks, embeddingsEnabled: this.embeddingsEnabled }
  }

  getSource(sourceId: string): ScanSource | undefined {
    return this.sources.get(sourceId)
  }

  close(): void {
    this.db.close()
  }
}
