/**
 * Memory Search Engine
 *
 * Provides hybrid keyword + semantic search across agent memory files.
 * Uses SQLite FTS5 for full-text search with BM25 ranking and a lightweight
 * TF-IDF vector store for semantic similarity. No external embedding API needed.
 *
 * Memory entries are indexed on write and searchable immediately.
 * The index is persisted in the agent workspace as `.memory-index.db`.
 */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'

interface SearchResult {
  file: string
  chunk: string
  score: number
  lineStart: number
  lineEnd: number
  matchType: 'keyword' | 'semantic' | 'hybrid'
}

interface MemoryChunk {
  file: string
  chunk: string
  lineStart: number
  lineEnd: number
  timestamp: number
}

const CHUNK_SIZE = 6
const CHUNK_OVERLAP = 2

export class MemorySearchEngine {
  private db: Database
  private workspaceDir: string
  private initialized = false

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    const dbPath = join(workspaceDir, '.memory-index.db')
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        file, chunk, line_start, line_end,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS memory_meta (
        file TEXT PRIMARY KEY,
        last_indexed_mtime INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_terms (
        term TEXT PRIMARY KEY,
        doc_freq INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        rowid INTEGER PRIMARY KEY,
        file TEXT NOT NULL,
        chunk TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        vector_json TEXT NOT NULL
      );
    `)
    this.initialized = true
  }

  /**
   * Index all memory files that have changed since last index.
   * Called automatically before search, or can be called after writes.
   */
  reindex(): void {
    const files = this.getMemoryFiles()
    const staleFiles: string[] = []

    const getMeta = this.db.prepare('SELECT last_indexed_mtime FROM memory_meta WHERE file = ?')

    for (const { relativePath, absolutePath } of files) {
      const mtime = statSync(absolutePath).mtimeMs
      const meta = getMeta.get(relativePath) as { last_indexed_mtime: number } | undefined
      if (!meta || meta.last_indexed_mtime < mtime) {
        staleFiles.push(relativePath)
      }
    }

    if (staleFiles.length === 0) return

    const indexFile = this.db.transaction((relPath: string) => {
      const absPath = join(this.workspaceDir, relPath)
      if (!existsSync(absPath)) {
        this.db.prepare('DELETE FROM memory_fts WHERE file = ?').run(relPath)
        this.db.prepare('DELETE FROM memory_vectors WHERE file = ?').run(relPath)
        this.db.prepare('DELETE FROM memory_meta WHERE file = ?').run(relPath)
        return
      }

      const content = readFileSync(absPath, 'utf-8')
      const chunks = this.chunkText(content, relPath)

      this.db.prepare('DELETE FROM memory_fts WHERE file = ?').run(relPath)
      this.db.prepare('DELETE FROM memory_vectors WHERE file = ?').run(relPath)

      const insertFts = this.db.prepare(
        'INSERT INTO memory_fts (file, chunk, line_start, line_end) VALUES (?, ?, ?, ?)'
      )
      const insertVec = this.db.prepare(
        'INSERT INTO memory_vectors (file, chunk, line_start, line_end, vector_json) VALUES (?, ?, ?, ?, ?)'
      )

      for (const chunk of chunks) {
        insertFts.run(chunk.file, chunk.chunk, chunk.lineStart, chunk.lineEnd)
        const vector = this.computeTfIdf(chunk.chunk)
        insertVec.run(chunk.file, chunk.chunk, chunk.lineStart, chunk.lineEnd, JSON.stringify(vector))
      }

      const mtime = statSync(absPath).mtimeMs
      this.db.prepare(
        'INSERT OR REPLACE INTO memory_meta (file, last_indexed_mtime, chunk_count) VALUES (?, ?, ?)'
      ).run(relPath, mtime, chunks.length)
    })

    for (const file of staleFiles) {
      indexFile(file)
    }

    this.rebuildTermFrequencies()
  }

  /**
   * Search memory with hybrid keyword + semantic ranking.
   * Returns top-k results sorted by combined score.
   */
  search(query: string, limit = 10): SearchResult[] {
    this.reindex()

    const keywordResults = this.keywordSearch(query, limit * 2)
    const semanticResults = this.semanticSearch(query, limit * 2)

    const merged = new Map<string, SearchResult>()

    for (const r of keywordResults) {
      const key = `${r.file}:${r.lineStart}`
      merged.set(key, r)
    }

    for (const r of semanticResults) {
      const key = `${r.file}:${r.lineStart}`
      const existing = merged.get(key)
      if (existing) {
        existing.score = existing.score * 0.6 + r.score * 0.4
        existing.matchType = 'hybrid'
      } else {
        merged.set(key, r)
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Close the database connection */
  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------------------
  // Keyword Search (FTS5 + BM25)
  // ---------------------------------------------------------------------------

  private keywordSearch(query: string, limit: number): SearchResult[] {
    try {
      const escaped = query.replace(/['"]/g, ' ').trim()
      if (!escaped) return []

      const terms = escaped.split(/\s+/).filter(Boolean)
      const ftsQuery = terms.map(t => `"${t}"`).join(' OR ')

      const rows = this.db.prepare(`
        SELECT file, chunk, line_start, line_end, rank
        FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{
        file: string
        chunk: string
        line_start: number
        line_end: number
        rank: number
      }>

      if (rows.length === 0) return []
      const maxRank = Math.max(...rows.map(r => Math.abs(r.rank)))

      return rows.map(r => ({
        file: r.file,
        chunk: r.chunk,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        score: maxRank > 0 ? 1 - (Math.abs(r.rank) / maxRank) : 0.5,
        matchType: 'keyword' as const,
      }))
    } catch {
      return this.fallbackKeywordSearch(query, limit)
    }
  }

  private fallbackKeywordSearch(query: string, limit: number): SearchResult[] {
    const lower = query.toLowerCase()
    const rows = this.db.prepare(
      'SELECT file, chunk, line_start, line_end FROM memory_vectors'
    ).all() as Array<{
      file: string
      chunk: string
      line_start: number
      line_end: number
    }>

    return rows
      .filter(r => r.chunk.toLowerCase().includes(lower))
      .slice(0, limit)
      .map((r, i, arr) => ({
        file: r.file,
        chunk: r.chunk,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        score: 1 - (i / Math.max(arr.length, 1)),
        matchType: 'keyword' as const,
      }))
  }

  // ---------------------------------------------------------------------------
  // Semantic Search (TF-IDF cosine similarity)
  // ---------------------------------------------------------------------------

  private semanticSearch(query: string, limit: number): SearchResult[] {
    const queryVec = this.computeTfIdf(query)
    if (Object.keys(queryVec).length === 0) return []

    const rows = this.db.prepare(
      'SELECT file, chunk, line_start, line_end, vector_json FROM memory_vectors'
    ).all() as Array<{
      file: string
      chunk: string
      line_start: number
      line_end: number
      vector_json: string
    }>

    const scored: SearchResult[] = []
    for (const r of rows) {
      let docVec: Record<string, number>
      try {
        docVec = JSON.parse(r.vector_json)
      } catch {
        continue
      }
      const sim = cosineSimilarity(queryVec, docVec)
      if (sim > 0.05) {
        scored.push({
          file: r.file,
          chunk: r.chunk,
          lineStart: r.line_start,
          lineEnd: r.line_end,
          score: sim,
          matchType: 'semantic',
        })
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ---------------------------------------------------------------------------
  // TF-IDF Computation
  // ---------------------------------------------------------------------------

  private computeTfIdf(text: string): Record<string, number> {
    const tokens = tokenize(text)
    if (tokens.length === 0) return {}

    const tf: Record<string, number> = {}
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1
    }
    for (const t of Object.keys(tf)) {
      tf[t] = tf[t] / tokens.length
    }

    const totalDocs = this.getTotalDocCount()
    const vec: Record<string, number> = {}

    for (const [term, termFreq] of Object.entries(tf)) {
      const docFreq = this.getDocFreq(term)
      const idf = Math.log((totalDocs + 1) / (docFreq + 1)) + 1
      vec[term] = termFreq * idf
    }

    return vec
  }

  private getTotalDocCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_vectors').get() as { cnt: number }
    return row.cnt || 1
  }

  private getDocFreq(term: string): number {
    const row = this.db.prepare('SELECT doc_freq FROM memory_terms WHERE term = ?').get(term) as
      | { doc_freq: number }
      | undefined
    return row?.doc_freq || 0
  }

  private rebuildTermFrequencies(): void {
    const rows = this.db.prepare('SELECT chunk FROM memory_vectors').all() as Array<{ chunk: string }>
    const docFreqs: Record<string, number> = {}

    for (const row of rows) {
      const uniqueTerms = new Set(tokenize(row.chunk))
      for (const term of uniqueTerms) {
        docFreqs[term] = (docFreqs[term] || 0) + 1
      }
    }

    this.db.exec('DELETE FROM memory_terms')
    const insert = this.db.prepare('INSERT INTO memory_terms (term, doc_freq) VALUES (?, ?)')
    const insertAll = this.db.transaction(() => {
      for (const [term, freq] of Object.entries(docFreqs)) {
        insert.run(term, freq)
      }
    })
    insertAll()
  }

  // ---------------------------------------------------------------------------
  // Text Chunking
  // ---------------------------------------------------------------------------

  private chunkText(content: string, file: string): MemoryChunk[] {
    const lines = content.split('\n')
    if (lines.length <= CHUNK_SIZE) {
      return [{
        file,
        chunk: content.trim(),
        lineStart: 1,
        lineEnd: lines.length,
        timestamp: Date.now(),
      }]
    }

    const chunks: MemoryChunk[] = []
    for (let i = 0; i < lines.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const end = Math.min(i + CHUNK_SIZE, lines.length)
      const chunkLines = lines.slice(i, end)
      const text = chunkLines.join('\n').trim()
      if (text.length > 10) {
        chunks.push({
          file,
          chunk: text,
          lineStart: i + 1,
          lineEnd: end,
          timestamp: Date.now(),
        })
      }
      if (end >= lines.length) break
    }

    return chunks
  }

  // ---------------------------------------------------------------------------
  // File Discovery
  // ---------------------------------------------------------------------------

  private getMemoryFiles(): Array<{ relativePath: string; absolutePath: string }> {
    const files: Array<{ relativePath: string; absolutePath: string }> = []

    const memoryMd = join(this.workspaceDir, 'MEMORY.md')
    if (existsSync(memoryMd)) {
      files.push({ relativePath: 'MEMORY.md', absolutePath: memoryMd })
    }

    const memoryDir = join(this.workspaceDir, 'memory')
    if (existsSync(memoryDir)) {
      for (const f of readdirSync(memoryDir)) {
        if (f.endsWith('.md')) {
          files.push({
            relativePath: `memory/${f}`,
            absolutePath: join(memoryDir, f),
          })
        }
      }
    }

    return files
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'while', 'where', 'how', 'what', 'which', 'who',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
  'they', 'them', 'their', 'all', 'any', 'about', 'up',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem)
}

function stem(word: string): string {
  if (word.length < 4) return word
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y'
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3)
  if (word.endsWith('tion')) return word.slice(0, -4)
  if (word.endsWith('ness')) return word.slice(0, -4)
  if (word.endsWith('ment')) return word.slice(0, -4)
  if (word.endsWith('able')) return word.slice(0, -4)
  if (word.endsWith('ful')) return word.slice(0, -3)
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('er') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1)
  return word
}

function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of allKeys) {
    const va = a[key] || 0
    const vb = b[key] || 0
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }

  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
