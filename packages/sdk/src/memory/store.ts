// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
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
  /** Route transcript through {@link Summarizer.summarize} and append each `- ` bullet. */
  summarize?: boolean
  /**
   * Merge the transcript with the existing MEMORY.md via {@link Summarizer.consolidate}
   * (or a concatenated fallback) and atomically rewrite the file.
   *
   * Prefers `summarizer.consolidate` when implemented. Falls back to calling
   * `summarizer.summarize` with a composed prompt containing existing bullets + transcript.
   * If the summarizer returns zero parseable bullets the file is left untouched.
   */
  consolidate?: boolean
}

export interface IngestTranscriptResult {
  /** Number of bullets written (or appended). 0 means nothing was written. */
  bullets: number
  /** Number of bullets that were already in MEMORY.md before this call. */
  previous: number
  /** True if MEMORY.md was not modified (empty input or empty consolidator output). */
  unchanged: boolean
}

const BULLET_LINE = /^-\s*(?:\(\d{4}-\d{2}-\d{2}T[^)]+\)\s*)?(.+?)\s*$/

/** Parse lines like `- foo` or `- (ISO) foo` into their bullet text, dropping empties. */
function parseBullets(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean)
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
   * Parse current MEMORY.md into a flat list of bullet strings, stripping any
   * `(ISO)` timestamp prefix written by {@link MemoryStore.add}. Useful for passing
   * existing memory into a consolidator or inspecting state.
   */
  readMemoryBullets(): string[] {
    const memoryMd = join(this.workspaceDir, 'MEMORY.md')
    if (!existsSync(memoryMd)) return []
    const raw = readFileSync(memoryMd, 'utf-8')
    const bullets: string[] = []
    for (const line of raw.split('\n')) {
      const m = BULLET_LINE.exec(line)
      if (m && m[1]) bullets.push(m[1])
    }
    return bullets
  }

  /**
   * Store a transcript. Three modes:
   * - default / `{ summarize: false }`: append the raw transcript as a single bullet.
   * - `{ summarize: true }`: route through {@link Summarizer.summarize} and append each `- ` bullet.
   * - `{ consolidate: true }`: read existing bullets, merge with transcript via
   *   {@link Summarizer.consolidate} (or a fallback that concatenates into `summarize`),
   *   then atomically rewrite MEMORY.md and reindex.
   */
  async ingestTranscript(
    text: string,
    options?: IngestTranscriptOptions,
  ): Promise<IngestTranscriptResult> {
    const body = text.trim()
    if (!body) return { bullets: 0, previous: this.readMemoryBullets().length, unchanged: true }

    if (options?.consolidate) {
      return this.consolidateTranscript(body)
    }

    const summarize = options?.summarize ?? false
    let content = body
    if (summarize) {
      content = (await this.summarizer.summarize(content)).trim()
    }

    const previous = this.readMemoryBullets().length
    const bullets = parseBullets(content)

    if (bullets.length === 0) {
      this.add(content)
      return { bullets: 1, previous, unchanged: false }
    }

    for (const b of bullets) this.add(b)
    return { bullets: bullets.length, previous, unchanged: false }
  }

  private async consolidateTranscript(transcript: string): Promise<IngestTranscriptResult> {
    const existing = this.readMemoryBullets()
    const previous = existing.length

    let raw: string
    if (this.summarizer.consolidate) {
      raw = await this.summarizer.consolidate({ existingBullets: existing, transcript })
    } else {
      const fallbackPrompt = [
        '# Existing memory',
        existing.length ? existing.map(b => `- ${b}`).join('\n') : '(none)',
        '',
        '# New conversation transcript',
        transcript,
        '',
        '# Task',
        'Produce the updated complete memory bullet list.',
      ].join('\n')
      raw = await this.summarizer.summarize(fallbackPrompt)
    }

    const bullets = parseBullets(raw)
    if (bullets.length === 0) {
      return { bullets: 0, previous, unchanged: true }
    }

    this.rewriteMemoryMd(bullets)
    this.getEngine().reindex()
    return { bullets: bullets.length, previous, unchanged: false }
  }

  private rewriteMemoryMd(bullets: string[]): void {
    this.ensureWorkspace()
    const now = new Date().toISOString()
    const lines = bullets.map(b => `- (${now}) ${b.trim()}`)
    const content = `# Memory\n\n${lines.join('\n')}\n`
    const file = join(this.workspaceDir, 'MEMORY.md')
    const tmp = `${file}.tmp`
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, file)
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
