/**
 * Database client with auto-detected adapter
 * 
 * Supports both PostgreSQL and SQLite based on DATABASE_URL:
 * - PostgreSQL: postgres://user:pass@localhost:5432/db
 * - SQLite: file:./dev.db
 * 
 * Note: The Prisma schema provider must match the adapter type.
 * To test with SQLite, update prisma/schema.prisma to use provider = "sqlite"
 */
import { createPrismaClientSync } from '@shogo-ai/sdk/db'
import { PrismaClient } from '../generated/prisma/client'

export const prisma = createPrismaClientSync(PrismaClient)
