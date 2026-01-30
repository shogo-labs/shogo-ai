/**
 * Database client with auto-detected adapter
 * 
 * Supports both PostgreSQL and SQLite based on DATABASE_URL:
 * - PostgreSQL: postgres://user:pass@localhost:5432/db
 * - SQLite: file:./dev.db (great for testing!)
 * 
 * For testing with SQLite:
 *   DATABASE_URL=file:./test.db bun test
 */
import { createPrismaClientSync } from '@shogo-ai/sdk/db'
import { PrismaClient } from '../generated/prisma/client'

export const prisma = createPrismaClientSync(PrismaClient)
