// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { CreateSqliteDriver } from './drivers/types.js'

/** Single search hit from hybrid FTS5 + TF-IDF ranking */
export interface MemorySearchHit {
  file: string
  chunk: string
  score: number
  lineStart: number
  lineEnd: number
  matchType: 'keyword' | 'semantic' | 'hybrid'
}

/** Internal chunk representation during indexing */
export interface MemoryChunkRecord {
  file: string
  chunk: string
  lineStart: number
  lineEnd: number
  timestamp: number
}

/** Configuration for {@link MemoryStore} */
export interface MemoryStoreConfig {
  /** Root directory containing per-user namespaces */
  dir: string
  /** Stable user identifier (scopes MEMORY.md / memory/*.md / index db) */
  userId: string
  /** Optional SQLite driver factory (defaults to Bun `bun:sqlite` or Node `better-sqlite3`) */
  createDriver?: CreateSqliteDriver
  /** Used by {@link MemoryStore.ingestTranscript} when summarization is enabled */
  summarizer?: Summarizer
}

/** Input passed to {@link Summarizer.consolidate}. */
export interface ConsolidateInput {
  /** Current durable bullets from MEMORY.md, with any `(ISO)` timestamp prefix stripped. */
  existingBullets: string[]
  /** Raw transcript of the new conversation to merge in. */
  transcript: string
}

/**
 * Turns raw text (e.g. transcript) into bullet lines for MEMORY.md.
 *
 * `summarize` is extractive-only: one transcript → bullets. Implement the optional
 * `consolidate` method if the summarizer should also merge, dedupe, and resolve
 * conflicts against the existing long-term memory. {@link MemoryStore.ingestTranscript}
 * with `{ consolidate: true }` will prefer `consolidate` when present and fall back
 * to a string-concatenated `summarize` call otherwise.
 */
export interface Summarizer {
  summarize(text: string): Promise<string>
  consolidate?(input: ConsolidateInput): Promise<string>
}
