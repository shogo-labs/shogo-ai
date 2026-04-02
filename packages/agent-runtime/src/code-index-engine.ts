// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Index Engine
 *
 * Provides hybrid keyword + vector search across all source files in the
 * workspace. Uses SQLite FTS5 for full-text search with BM25 ranking and
 * optionally sqlite-vec for vector similarity search with OpenAI embeddings.
 *
 * Unlike FileIndexEngine (which only indexes files/ with .txt/.csv/.md),
 * this indexes the full workspace tree with code-aware extensions and
 * skip patterns (node_modules, .git, __pycache__, etc.).
 */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeSearchResult {
  path: string
  chunk: string
  score: number
  lineStart: number
  lineEnd: number
  matchType: 'keyword' | 'vector' | 'hybrid'
}

interface CodeChunk {
  path: string
  chunk: string
  chunkIdx: number
  lineStart: number
  lineEnd: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
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

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', '.nox', '.eggs', '.egg-info', 'dist', 'build', '.build',
  'venv', '.venv', 'env', '.env', '.cache',
  '.next', '.nuxt', '.svelte-kit', '.turbo',
  'target', 'out', 'coverage', '.coverage',
  '.swe-bench',
])

function isInsideSkippedDir(relPath: string): boolean {
  const segments = relPath.split('/')
  return segments.some(s => SKIP_DIRS.has(s))
}

const SKIP_FILE_PATTERNS = [/\.pyc$/, /\.pyo$/, /\.so$/, /\.dylib$/, /\.wasm$/, /\.min\.js$/, /\.map$/]

const MAX_FILE_SIZE = 512 * 1024 // 512KB — skip very large files
const CHUNK_LINES = 40
const CHUNK_OVERLAP = 10
const EMBEDDING_DIMENSIONS = 256
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_BATCH_SIZE = 64

// ---------------------------------------------------------------------------
// CodeIndexEngine
// ---------------------------------------------------------------------------

export class CodeIndexEngine {
  private db: Database
  private workspaceDir: string
  private openai: OpenAI | null = null
  private embeddingsEnabled: boolean
  private vecExtensionLoaded: boolean = false
  private indexing: Promise<any> | null = null

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir

    const dbDir = join(workspaceDir, '.shogo')
    mkdirSync(dbDir, { recursive: true })

    const dbPath = join(dbDir, 'code-index.db')
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

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

    // Embeddings disabled — FTS5 keyword search is sufficient and avoids
    // the memory/latency cost of embedding API calls during indexing.
    this.embeddingsEnabled = false

    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        chunk TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_chunks_path ON code_chunks(path);

      CREATE TABLE IF NOT EXISTS code_meta (
        path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL
      );
    `)

    const ftsExists = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_fts'`
    ).get()
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE code_fts USING fts5(
          path, chunk,
          content=code_chunks,
          content_rowid=id,
          tokenize='porter unicode61'
        );
      `)
    }

    if (this.embeddingsEnabled) {
      const vecExists = this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_vec'`
      ).get()
      if (!vecExists) {
        this.db.exec(
          `CREATE VIRTUAL TABLE code_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${EMBEDDING_DIMENSIONS}])`
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  async reindex(): Promise<{ indexed: number; removed: number; total: number }> {
    const diskFiles = this.discoverFiles()
    console.log(`[code-index] Discovered ${diskFiles.length} files to consider`)
    const getMeta = this.db.prepare('SELECT mtime_ms FROM code_meta WHERE path = ?')

    const toIndex: string[] = []
    const diskPaths = new Set(diskFiles.map(f => f.relativePath))

    for (const { relativePath, absolutePath } of diskFiles) {
      try {
        const stat = statSync(absolutePath)
        const meta = getMeta.get(relativePath) as { mtime_ms: number } | undefined
        if (!meta || meta.mtime_ms < stat.mtimeMs) {
          toIndex.push(relativePath)
        }
      } catch { /* file disappeared between discover and stat */ }
    }

    const indexedPaths = this.db.prepare('SELECT path FROM code_meta').all() as { path: string }[]
    const toRemove = indexedPaths.filter(r => !diskPaths.has(r.path)).map(r => r.path)

    if (toIndex.length === 0 && toRemove.length === 0) {
      const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM code_meta').get() as { cnt: number }).cnt
      return { indexed: 0, removed: 0, total }
    }

    for (const path of toRemove) {
      this.removeFromIndex(path)
    }

    for (const relPath of toIndex) {
      await this.indexFile(relPath)
    }

    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM code_meta').get() as { cnt: number }).cnt
    return { indexed: toIndex.length, removed: toRemove.length, total }
  }

  /** Fire-and-forget reindex that deduplicates concurrent calls */
  reindexBackground(): void {
    if (this.indexing) return
    this.indexing = this.reindex()
      .catch(err => console.warn(`[code-index] Background reindex failed: ${err.message}`))
      .finally(() => { this.indexing = null })
  }

  private async indexFile(relPath: string): Promise<void> {
    if (isInsideSkippedDir(relPath)) return
    const absPath = join(this.workspaceDir, relPath)
    if (!existsSync(absPath)) return

    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch { return }

    const stat = statSync(absPath)
    const chunks = this.chunkText(content, relPath)

    this.removeFromIndex(relPath)

    const insertChunk = this.db.prepare(
      'INSERT INTO code_chunks (path, chunk, chunk_idx, line_start, line_end) VALUES (?, ?, ?, ?, ?)'
    )
    const insertFts = this.db.prepare(
      'INSERT INTO code_fts (rowid, path, chunk) VALUES (?, ?, ?)'
    )

    const chunkIds: number[] = []

    const insertAll = this.db.transaction(() => {
      for (const chunk of chunks) {
        const result = insertChunk.run(chunk.path, chunk.chunk, chunk.chunkIdx, chunk.lineStart, chunk.lineEnd)
        const rowId = Number(result.lastInsertRowid)
        chunkIds.push(rowId)
        insertFts.run(rowId, chunk.path, chunk.chunk)
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO code_meta (path, mtime_ms, size_bytes, chunk_count) VALUES (?, ?, ?, ?)'
      ).run(relPath, stat.mtimeMs, stat.size, chunks.length)
    })

    insertAll()

    if (this.embeddingsEnabled && chunks.length > 0) {
      await this.embedAndStore(chunks, chunkIds)
    }
  }

  private consecutiveEmbeddingFailures = 0
  private static readonly MAX_EMBEDDING_FAILURES = 2

  private async embedAndStore(chunks: CodeChunk[], chunkIds: number[]): Promise<void> {
    if (!this.openai) return
    if (this.consecutiveEmbeddingFailures >= CodeIndexEngine.MAX_EMBEDDING_FAILURES) return

    const texts = chunks.map(c => c.chunk)
    const insertVec = this.db.prepare(
      'INSERT INTO code_vec (chunk_id, embedding) VALUES (?, ?)'
    )

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      if (this.consecutiveEmbeddingFailures >= CodeIndexEngine.MAX_EMBEDDING_FAILURES) return

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
        if (this.consecutiveEmbeddingFailures >= CodeIndexEngine.MAX_EMBEDDING_FAILURES) {
          console.warn(`[code-index] Embedding disabled after ${CodeIndexEngine.MAX_EMBEDDING_FAILURES} consecutive failures (last: ${err.message})`)
        }
      }
    }
  }

  private removeFromIndex(relPath: string): void {
    const chunkRows = this.db.prepare('SELECT id FROM code_chunks WHERE path = ?').all(relPath) as { id: number }[]
    if (chunkRows.length > 0) {
      for (const { id } of chunkRows) {
        this.db.prepare('DELETE FROM code_fts WHERE rowid = ?').run(id)
        if (this.embeddingsEnabled) {
          this.db.prepare('DELETE FROM code_vec WHERE chunk_id = ?').run(id)
        }
      }
    }
    this.db.prepare('DELETE FROM code_chunks WHERE path = ?').run(relPath)
    this.db.prepare('DELETE FROM code_meta WHERE path = ?').run(relPath)
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(
    query: string,
    limit = 10,
    pathFilter?: string,
    extensions?: string[],
  ): Promise<CodeSearchResult[]> {
    if (this.indexing) await this.indexing
    await this.reindex()

    const keywordResults = this.keywordSearch(query, limit * 2, pathFilter, extensions)

    let vectorResults: CodeSearchResult[] = []
    if (this.embeddingsEnabled) {
      vectorResults = await this.vectorSearch(query, limit * 2, pathFilter, extensions)
    }

    if (vectorResults.length === 0) {
      return keywordResults.slice(0, limit)
    }

    const merged = new Map<string, CodeSearchResult>()

    for (const r of keywordResults) {
      merged.set(`${r.path}:${r.lineStart}`, r)
    }

    for (const r of vectorResults) {
      const key = `${r.path}:${r.lineStart}`
      const existing = merged.get(key)
      if (existing) {
        existing.score = existing.score * 0.4 + r.score * 0.6
        existing.matchType = 'hybrid'
      } else {
        merged.set(key, r)
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  private keywordSearch(
    query: string, limit: number, pathFilter?: string, extensions?: string[],
  ): CodeSearchResult[] {
    try {
      const escaped = query.replace(/['"]/g, ' ').trim()
      if (!escaped) return []

      const terms = escaped.split(/\s+/).filter(Boolean)
      const ftsQuery = terms.map(t => `"${t}"`).join(' OR ')

      let sql = `
        SELECT c.path, c.chunk, c.line_start, c.line_end, f.rank
        FROM code_fts f
        JOIN code_chunks c ON c.id = f.rowid
        WHERE code_fts MATCH ?
      `
      const params: any[] = [ftsQuery]

      if (pathFilter) {
        sql += ` AND c.path LIKE ?`
        params.push(`%${pathFilter}%`)
      }

      sql += ` ORDER BY f.rank LIMIT ?`
      params.push(limit * 3)

      let rows = this.db.prepare(sql).all(...params) as Array<{
        path: string; chunk: string; line_start: number; line_end: number; rank: number
      }>

      if (extensions && extensions.length > 0) {
        const extSet = new Set(extensions.map(e => e.startsWith('.') ? e : `.${e}`))
        rows = rows.filter(r => {
          const ext = extname(r.path).toLowerCase()
          return extSet.has(ext)
        })
      }

      rows = rows.slice(0, limit)
      if (rows.length === 0) return []
      const maxRank = Math.max(...rows.map(r => Math.abs(r.rank)))

      return rows.map(r => ({
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
    query: string, limit: number, pathFilter?: string, extensions?: string[],
  ): Promise<CodeSearchResult[]> {
    if (!this.openai) return []

    try {
      const response = await this.openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: [query],
        dimensions: EMBEDDING_DIMENSIONS,
      })

      const queryEmbedding = new Float32Array(response.data[0].embedding)

      let sql: string
      let params: any[]

      if (pathFilter) {
        sql = `
          SELECT v.chunk_id, v.distance, c.path, c.chunk, c.line_start, c.line_end
          FROM code_vec v
          JOIN code_chunks c ON c.id = v.chunk_id
          WHERE v.embedding MATCH ? AND k = ? AND c.path LIKE ?
          ORDER BY v.distance
        `
        params = [queryEmbedding, limit * 3, `%${pathFilter}%`]
      } else {
        sql = `
          SELECT v.chunk_id, v.distance, c.path, c.chunk, c.line_start, c.line_end
          FROM code_vec v
          JOIN code_chunks c ON c.id = v.chunk_id
          WHERE v.embedding MATCH ? AND k = ?
          ORDER BY v.distance
        `
        params = [queryEmbedding, limit * 3]
      }

      let rows = this.db.prepare(sql).all(...params) as Array<{
        chunk_id: number; distance: number; path: string; chunk: string; line_start: number; line_end: number
      }>

      if (extensions && extensions.length > 0) {
        const extSet = new Set(extensions.map(e => e.startsWith('.') ? e : `.${e}`))
        rows = rows.filter(r => extSet.has(extname(r.path).toLowerCase()))
      }

      rows = rows.slice(0, limit)
      if (rows.length === 0) return []
      const maxDist = Math.max(...rows.map(r => r.distance), 0.001)

      return rows.map(r => ({
        path: r.path,
        chunk: r.chunk,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        score: 1 - (r.distance / maxDist),
        matchType: 'vector' as const,
      }))
    } catch (err: any) {
      console.warn(`[code-index] Vector search failed: ${err.message}`)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // File Discovery
  // ---------------------------------------------------------------------------

  private discoverFiles(): Array<{ relativePath: string; absolutePath: string }> {
    return this.walkDir(this.workspaceDir, '')
  }

  private walkDir(dir: string, prefix: string): Array<{ relativePath: string; absolutePath: string }> {
    const results: Array<{ relativePath: string; absolutePath: string }> = []

    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch { return results }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const absPath = join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        results.push(...this.walkDir(absPath, relPath))
      } else if (this.shouldIndex(entry.name, absPath)) {
        results.push({ relativePath: relPath, absolutePath: absPath })
      }
    }

    return results
  }

  private shouldIndex(name: string, absPath: string): boolean {
    if (absPath.includes('/node_modules/')) return false
    const ext = extname(name).toLowerCase()
    if (!CODE_EXTENSIONS.has(ext)) return false
    if (SKIP_FILE_PATTERNS.some(p => p.test(name))) return false
    try {
      const stat = statSync(absPath)
      if (stat.size > MAX_FILE_SIZE) return false
    } catch { return false }
    return true
  }

  // ---------------------------------------------------------------------------
  // Text Chunking
  // ---------------------------------------------------------------------------

  private chunkText(content: string, filePath: string): CodeChunk[] {
    const lines = content.split('\n')

    if (lines.length <= CHUNK_LINES) {
      return [{
        path: filePath,
        chunk: content.trim(),
        chunkIdx: 0,
        lineStart: 1,
        lineEnd: lines.length,
      }]
    }

    const chunks: CodeChunk[] = []
    let chunkIdx = 0

    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      const end = Math.min(i + CHUNK_LINES, lines.length)
      const text = lines.slice(i, end).join('\n').trim()
      if (text.length > 20) {
        chunks.push({
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

  getStats(): { totalFiles: number; totalChunks: number; embeddingsEnabled: boolean } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM code_meta').get() as { cnt: number }).cnt
    const chunks = (this.db.prepare('SELECT COUNT(*) as cnt FROM code_chunks').get() as { cnt: number }).cnt
    return { totalFiles: files, totalChunks: chunks, embeddingsEnabled: this.embeddingsEnabled }
  }

  close(): void {
    this.db.close()
  }
}
