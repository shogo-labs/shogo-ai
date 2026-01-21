/**
 * Shogo SDK Client Setup
 * 
 * Demonstrates using the SDK with Prisma pass-through.
 * shogo.db IS your Prisma client - same API, zero overhead.
 */

import { createClient, type ShogoClient } from '@shogo-ai/sdk'
import { prisma } from '../utils/db'
import type { PrismaClient } from '@prisma/client'

export const shogo: ShogoClient<PrismaClient> = createClient({
  apiUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001',
  db: prisma,
})
