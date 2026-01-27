/**
 * Shogo SDK Client Setup
 * 
 * This demonstrates the SDK's Prisma pass-through pattern:
 * - shogo.db IS your Prisma client
 * - Same API you know, zero overhead
 * - Unified access through the SDK
 */

import { createClient, type ShogoClient } from '@shogo-ai/sdk'
import { prisma } from './db'
import type { PrismaClient } from '../generated/prisma/client'

// Create the Shogo client with Prisma pass-through
export const shogo: ShogoClient<PrismaClient> = createClient({
  apiUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  db: prisma,
})

// Type for convenience
export type { PrismaClient }
