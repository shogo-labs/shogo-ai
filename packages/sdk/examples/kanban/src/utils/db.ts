/**
 * Prisma Client Setup
 * 
 * Single instance for the application.
 */

import { PrismaClient } from '@prisma/client'

declare global {
  var prisma: PrismaClient | undefined
}

export const prisma = globalThis.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma
