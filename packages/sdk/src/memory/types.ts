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

/** Turns raw text (e.g. transcript) into bullet lines for MEMORY.md */
export interface Summarizer {
  summarize(text: string): Promise<string>
}
