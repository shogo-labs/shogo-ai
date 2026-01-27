/**
 * Shogo SDK Client Setup
 *
 * Production-grade configuration:
 * - shogo.auth: Real authentication (email/password, OAuth)
 * - shogo.db: Prisma pass-through for database access
 * - Proper API URL configuration
 */

import { createClient, type ShogoClient } from '@shogo-ai/sdk'
import { prisma } from './db'
import type { PrismaClient } from '../generated/prisma/client'

// Determine API URL based on environment
const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    return window.location.origin
  }
  return process.env.API_URL || 'http://localhost:3000'
}

// Create the Shogo client with full configuration
export const shogo: ShogoClient<PrismaClient> = createClient({
  apiUrl: getApiUrl(),
  db: prisma,
  auth: {
    // Use headless mode for custom UI (our LoginPage component)
    mode: 'headless',
    // Auth endpoints path (default is /api/auth)
    authPath: '/api/auth',
  },
})

// Type exports for convenience
export type { PrismaClient }
export type { ShogoUser, AuthState } from '@shogo-ai/sdk'
