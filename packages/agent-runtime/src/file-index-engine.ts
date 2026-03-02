/**
 * File Index Engine
 *
 * Provides hybrid keyword + vector search across workspace files.
 * Uses SQLite FTS5 for full-text search with BM25 ranking and
 * sqlite-vec for vector similarity search with OpenAI embeddings.
 *
 * Supported file types: .txt, .csv, .md
 * Files are chunked into overlapping windows and indexed incrementally.
 */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, relative, extname } from 'path'
import OpenAI from 'openai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileSearchResult {
  path: string
  chunk: string
  score: number
  lineStart: number
  lineEnd: number
  matchType: 'keyword' | 'vector' | 'hybrid'
}

interface FileChunk {
  path: string
  chunk: string
  chunkIdx: number
  lineStart: number
  lineEnd: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.csv', '.md'])
const CHUNK_LINES = 30
const CHUNK_OVERLAP = 10
const EMBEDDING_DIMENSIONS = 256
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_BATCH_SIZE = 64

// ---------------------------------------------------------------------------
// FileIndexEngine
// ---------------------------------------------------------------------------

export class FileIndexEngine {
  private db: Database
  private filesDir: string
  private openai: OpenAI | null = null
  private embeddingsEnabled: boolean
  private vecExtensionLoaded: boolean = false

  constructor(workspaceDir: string) {
    this.filesDir = join(workspaceDir, 'files')
    mkdirSync(this.filesDir, { recursive: true })

    const dbPath = join(workspaceDir, '.file-index.db')
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

    // Attempt to load sqlite-vec; falls back to FTS5-only on macOS or when unavailable
    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(this.db)
      this.vecExtensionLoaded = true
    } catch (err: any) {
      console.warn(`[file-index] sqlite-vec not available (${err.message}). Using FTS5-only search.`)
      this.vecExtensionLoaded = false
    }

    const directKey = process.env.OPENAI_API_KEY
    const proxyUrl = process.env.TOOLS_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    const effectiveKey = directKey || proxyToken

    if (effectiveKey && this.vecExtensionLoaded) {
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

    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        chunk TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_chunks_path ON file_chunks(path);

      CREATE TABLE IF NOT EXISTS file_meta (
        path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL
      );
    `)

    // FTS5 virtual table
    const ftsExists = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_fts'`
    ).get()
    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE file_fts USING fts5(
          path, chunk,
          content=file_chunks,
          content_rowid=id,
          tokenize='porter unicode61'
        );
      `)
    }

    // sqlite-vec virtual table
    if (this.embeddingsEnabled) {
      const vecExists = this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_vec'`
      ).get()
      if (!vecExists) {
        this.db.exec(
          `CREATE VIRTUAL TABLE file_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${EMBEDDING_DIMENSIONS}])`
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  /**
   * Re-index any files that have changed since last index.
   * Only processes files with supported extensions under the files/ directory.
   */
  async reindex(): Promise<{ indexed: number; removed: number; total: number }> {
    const diskFiles = this.discoverFiles()
    const getMeta = this.db.prepare('SELECT mtime_ms FROM file_meta WHERE path = ?')

    const toIndex: string[] = []
    const diskPaths = new Set(diskFiles.map(f => f.relativePath))

    for (const { relativePath, absolutePath } of diskFiles) {
      const stat = statSync(absolutePath)
      const meta = getMeta.get(relativePath) as { mtime_ms: number } | undefined
      if (!meta || meta.mtime_ms < stat.mtimeMs) {
        toIndex.push(relativePath)
      }
    }

    // Find removed files
    const indexedPaths = this.db.prepare('SELECT path FROM file_meta').all() as { path: string }[]
    const toRemove = indexedPaths.filter(r => !diskPaths.has(r.path)).map(r => r.path)

    if (toIndex.length === 0 && toRemove.length === 0) {
      const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM file_meta').get() as { cnt: number }).cnt
      return { indexed: 0, removed: 0, total }
    }

    // Remove deleted files
    for (const path of toRemove) {
      this.removeFileFromIndex(path)
    }

    // Index changed/new files
    for (const relPath of toIndex) {
      await this.indexFile(relPath)
    }

    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM file_meta').get() as { cnt: number }).cnt
    return { indexed: toIndex.length, removed: toRemove.length, total }
  }

  private async indexFile(relPath: string): Promise<void> {
    const absPath = join(this.filesDir, relPath)
    if (!existsSync(absPath)) return

    const content = readFileSync(absPath, 'utf-8')
    const stat = statSync(absPath)
    const chunks = this.chunkText(content, relPath)

    // Remove old data for this file
    this.removeFileFromIndex(relPath)

    // Insert chunks
    const insertChunk = this.db.prepare(
      'INSERT INTO file_chunks (path, chunk, chunk_idx, line_start, line_end) VALUES (?, ?, ?, ?, ?)'
    )
    const insertFts = this.db.prepare(
      'INSERT INTO file_fts (rowid, path, chunk) VALUES (?, ?, ?)'
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
        'INSERT OR REPLACE INTO file_meta (path, mtime_ms, size_bytes, chunk_count) VALUES (?, ?, ?, ?)'
      ).run(relPath, stat.mtimeMs, stat.size, chunks.length)
    })

    insertAll()

    // Compute and store embeddings
    if (this.embeddingsEnabled && chunks.length > 0) {
      await this.embedAndStore(chunks, chunkIds)
    }
  }

  private async embedAndStore(chunks: FileChunk[], chunkIds: number[]): Promise<void> {
    if (!this.openai) return

    const texts = chunks.map(c => c.chunk)
    const insertVec = this.db.prepare(
      'INSERT INTO file_vec (chunk_id, embedding) VALUES (?, ?)'
    )

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
      const batchIds = chunkIds.slice(i, i + EMBEDDING_BATCH_SIZE)

      try {
        const response = await this.openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        })

        const insertBatch = this.db.transaction(() => {
          for (let j = 0; j < response.data.length; j++) {
            const embedding = new Float32Array(response.data[j].embedding)
            insertVec.run(batchIds[j], embedding)
          }
        })
        insertBatch()
      } catch (err: any) {
        console.warn(`[file-index] Embedding batch failed: ${err.message}`)
      }
    }
  }

  private removeFileFromIndex(relPath: string): void {
    const chunkRows = this.db.prepare('SELECT id FROM file_chunks WHERE path = ?').all(relPath) as { id: number }[]
    if (chunkRows.length > 0) {
      const ids = chunkRows.map(r => r.id)
      for (const id of ids) {
        this.db.prepare('DELETE FROM file_fts WHERE rowid = ?').run(id)
        if (this.embeddingsEnabled) {
          this.db.prepare('DELETE FROM file_vec WHERE chunk_id = ?').run(id)
        }
      }
    }
    this.db.prepare('DELETE FROM file_chunks WHERE path = ?').run(relPath)
    this.db.prepare('DELETE FROM file_meta WHERE path = ?').run(relPath)
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(query: string, limit = 10, pathFilter?: string): Promise<FileSearchResult[]> {
    await this.reindex()

    const keywordResults = this.keywordSearch(query, limit * 2, pathFilter)

    let vectorResults: FileSearchResult[] = []
    if (this.embeddingsEnabled) {
      vectorResults = await this.vectorSearch(query, limit * 2, pathFilter)
    }

    if (vectorResults.length === 0) {
      return keywordResults.slice(0, limit)
    }

    // Merge with hybrid scoring
    const merged = new Map<string, FileSearchResult>()

    for (const r of keywordResults) {
      const key = `${r.path}:${r.lineStart}`
      merged.set(key, r)
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

  private keywordSearch(query: string, limit: number, pathFilter?: string): FileSearchResult[] {
    try {
      const escaped = query.replace(/['"]/g, ' ').trim()
      if (!escaped) return []

      const terms = escaped.split(/\s+/).filter(Boolean)
      const ftsQuery = terms.map(t => `"${t}"`).join(' OR ')

      let sql = `
        SELECT c.path, c.chunk, c.line_start, c.line_end, f.rank
        FROM file_fts f
        JOIN file_chunks c ON c.id = f.rowid
        WHERE file_fts MATCH ?
      `
      const params: any[] = [ftsQuery]

      if (pathFilter) {
        sql += ` AND c.path LIKE ?`
        params.push(`%${pathFilter}%`)
      }

      sql += ` ORDER BY f.rank LIMIT ?`
      params.push(limit)

      const rows = this.db.prepare(sql).all(...params) as Array<{
        path: string; chunk: string; line_start: number; line_end: number; rank: number
      }>

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

  private async vectorSearch(query: string, limit: number, pathFilter?: string): Promise<FileSearchResult[]> {
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
          FROM file_vec v
          JOIN file_chunks c ON c.id = v.chunk_id
          WHERE v.embedding MATCH ? AND k = ? AND c.path LIKE ?
          ORDER BY v.distance
        `
        params = [queryEmbedding, limit, `%${pathFilter}%`]
      } else {
        sql = `
          SELECT v.chunk_id, v.distance, c.path, c.chunk, c.line_start, c.line_end
          FROM file_vec v
          JOIN file_chunks c ON c.id = v.chunk_id
          WHERE v.embedding MATCH ? AND k = ?
          ORDER BY v.distance
        `
        params = [queryEmbedding, limit]
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        chunk_id: number; distance: number; path: string; chunk: string; line_start: number; line_end: number
      }>

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
      console.warn(`[file-index] Vector search failed: ${err.message}`)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // File Discovery
  // ---------------------------------------------------------------------------

  private discoverFiles(): Array<{ relativePath: string; absolutePath: string }> {
    if (!existsSync(this.filesDir)) return []
    return this.walkDir(this.filesDir, '')
  }

  private walkDir(dir: string, prefix: string): Array<{ relativePath: string; absolutePath: string }> {
    const results: Array<{ relativePath: string; absolutePath: string }> = []

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue

      const absPath = join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        results.push(...this.walkDir(absPath, relPath))
      } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push({ relativePath: relPath, absolutePath: absPath })
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Text Chunking
  // ---------------------------------------------------------------------------

  private chunkText(content: string, filePath: string): FileChunk[] {
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

    const chunks: FileChunk[] = []
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

  /** Get the absolute path to the files directory */
  getFilesDir(): string {
    return this.filesDir
  }

  /** Get stats about the index */
  getStats(): { totalFiles: number; totalChunks: number; embeddingsEnabled: boolean } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM file_meta').get() as { cnt: number }).cnt
    const chunks = (this.db.prepare('SELECT COUNT(*) as cnt FROM file_chunks').get() as { cnt: number }).cnt
    return { totalFiles: files, totalChunks: chunks, embeddingsEnabled: this.embeddingsEnabled }
  }

  close(): void {
    this.db.close()
  }
}
