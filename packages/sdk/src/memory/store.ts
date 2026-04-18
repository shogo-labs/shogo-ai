// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemorySearchEngine } from './engine.js'
import type { MemorySearchHit, MemoryStoreConfig, Summarizer } from './types.js'
import { identitySummarizer } from './summarizer.js'
import type { CreateSqliteDriver } from './drivers/types.js'

/** Namespace user ids for safe directory names (blocks path traversal) */
export function sanitizeUserId(userId: string): string {
  const s = userId.trim()
  if (!s) throw new Error('MemoryStore: userId must be non-empty')
  const cleaned = s.replace(/[^a-zA-Z0-9._@-]+/g, '_')
  // Collapse any leading dots to avoid `.` or `..` resolving outside the root
  const safe = cleaned.replace(/^\.+/, '_')
  return safe.slice(0, 256)
}

export interface SearchOptions {
  limit?: number
}

export interface IngestTranscriptOptions {
  summarize?: boolean
}

/**
 * High-level memory API: scoped markdown files + hybrid search index per user.
 */
export class MemoryStore {
  readonly workspaceDir: string
  private readonly summarizer: Summarizer
  private readonly createDriver?: CreateSqliteDriver
  private engine: MemorySearchEngine | null = null

  constructor(config: MemoryStoreConfig) {
    const safe = sanitizeUserId(config.userId)
    this.workspaceDir = join(config.dir, safe)
    this.createDriver = config.createDriver
    this.summarizer = config.summarizer ?? identitySummarizer
  }

  private ensureWorkspace(): void {
    mkdirSync(this.workspaceDir, { recursive: true })
    mkdirSync(join(this.workspaceDir, 'memory'), { recursive: true })
  }

  private getEngine(): MemorySearchEngine {
    if (!this.engine) {
      this.engine = new MemorySearchEngine(this.workspaceDir, {
        createDriver: this.createDriver,
      })
    }
    return this.engine
  }

  /** Append a bullet to MEMORY.md with an ISO timestamp prefix */
  add(fact: string): void {
    this.ensureWorkspace()
    const memoryMd = join(this.workspaceDir, 'MEMORY.md')
    const line = `- (${new Date().toISOString()}) ${fact.trim()}\n`
    if (!existsSync(memoryMd)) {
      writeFileSync(memoryMd, `# Memory\n\n${line}`, 'utf-8')
    } else {
      appendFileSync(memoryMd, line, 'utf-8')
    }
  }

  /** Append an entry to memory/YYYY-MM-DD.md */
  addDaily(entry: string, date?: string): void {
    this.ensureWorkspace()
    const d =
      date ??
      new Date().toISOString().slice(0, 10)
    const path = join(this.workspaceDir, 'memory', `${d}.md`)
    const line = `- (${new Date().toISOString()}) ${entry.trim()}\n`
    if (!existsSync(path)) {
      writeFileSync(path, `# Daily log ${d}\n\n${line}`, 'utf-8')
    } else {
      appendFileSync(path, line, 'utf-8')
    }
  }

  /** Hybrid search across MEMORY.md and memory/*.md */
  search(query: string, options?: SearchOptions): MemorySearchHit[] {
    const limit = options?.limit ?? 10
    return this.getEngine().search(query, limit)
  }

  /**
   * Store a transcript: optionally summarize to bullets via {@link MemoryStoreConfig.summarizer},
   * then append bullets to MEMORY.md (one line per bullet from model output).
   */
  async ingestTranscript(text: string, options?: IngestTranscriptOptions): Promise<void> {
    const summarize = options?.summarize ?? false
    let body = text.trim()
    if (!body) return

    if (summarize) {
      body = (await this.summarizer.summarize(body)).trim()
    }

    const bullets = body
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('-'))
      .map(l => l.replace(/^-\s*/, ''))

    if (bullets.length === 0) {
      this.add(body)
      return
    }

    for (const b of bullets) {
      this.add(b)
    }
  }

  /** Flush index (mainly for tests); normally runs automatically before search */
  reindex(): void {
    this.getEngine().reindex()
  }

  close(): void {
    this.engine?.close()
    this.engine = null
  }
}
