/**
 * Persistence layer for schema and data storage
 *
 * Supports multiple backends:
 * - Filesystem (default): Local JSON files
 * - S3: AWS S3 bucket storage (set SCHEMA_STORAGE=s3)
 *
 * Unit 1 additions: Pluggable persistence abstraction
 * Phase 8 additions: Nested persistence helpers
 */

export * from './io'
export * from './schema-io'
export * from './data-io'

// Unit 1: Persistence abstraction layer
export * from './types'
export * from './filesystem'
export * from './null'

// S3 persistence support
export * from './s3-io'
export * from './s3-schema-io'
// Note: s3-sqlite is server-only (uses bun:sqlite) - import directly from:
// import { S3SqliteManager } from '@shogo/state-api/persistence/s3-sqlite'

// Phase 8: Nested persistence helpers
export * from './helpers'
