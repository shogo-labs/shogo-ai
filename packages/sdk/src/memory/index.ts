// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Memory Module
 *
 * Fast local hybrid search (SQLite FTS5 + TF-IDF) over markdown memory files per user.
 * Optional HTTP handlers match ElevenLabs client-tool payloads — import from `@shogo-ai/sdk/memory/server`.
 *
 * @example Store + search (server-side)
 * ```typescript
 * import { MemoryStore, createLlmSummarizer } from '@shogo-ai/sdk/memory'
 *
 * const memory = new MemoryStore({
 *   dir: './memory-store',
 *   userId: 'user_123',
 *   summarizer: createLlmSummarizer({ complete: async (p) => myLlm(p) }),
 * })
 *
 * await memory.add('User prefers window seats')
 * await memory.addDaily('Discussed refund for order #4821')
 * const hits = memory.search('seat preferences', { limit: 5 })
 * ```
 */

export { MemorySearchEngine } from './engine.js'
export { MemoryStore, sanitizeUserId } from './store.js'
export type { SearchOptions, IngestTranscriptOptions } from './store.js'

export {
  identitySummarizer,
  createLlmSummarizer,
  type LlmSummarizerOptions,
} from './summarizer.js'

export {
  createSqliteDriver,
  detectDriver,
  type SqliteDriver,
  type SqliteStatement,
  type CreateSqliteDriver,
} from './drivers/index.js'

export type {
  MemorySearchHit,
  MemoryChunkRecord,
  MemoryStoreConfig,
  Summarizer,
} from './types.js'
