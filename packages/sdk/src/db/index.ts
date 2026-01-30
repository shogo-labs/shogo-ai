/**
 * Shogo Database Module
 *
 * Provides flexible database adapter support for Prisma, allowing
 * easy switching between PostgreSQL (production) and SQLite (testing).
 *
 * @example
 * ```typescript
 * // In your src/lib/db.ts
 * import { createPrismaClient } from '@shogo-ai/sdk/db'
 * import { PrismaClient } from '../generated/prisma/client'
 *
 * // Auto-detects PostgreSQL vs SQLite from DATABASE_URL
 * export const prisma = await createPrismaClient(PrismaClient)
 * 
 * // For production (PostgreSQL):
 * // DATABASE_URL=postgres://user:pass@localhost:5432/mydb
 * 
 * // For testing (SQLite):
 * // DATABASE_URL=file:./test.db bun test
 * ```
 */

export {
  // Main entry points (async)
  createPrismaClient,
  createDatabaseAdapter,
  
  // Synchronous alternatives
  createPrismaClientSync,
  createAdapterSync,
  
  // Utility functions
  detectProvider,
  isTestMode,
  isPostgres,
  getTestDatabaseUrl,
  getCurrentProvider,
  
  // Types
  type DatabaseProvider,
  type DatabaseAdapterConfig,
} from './adapters'
