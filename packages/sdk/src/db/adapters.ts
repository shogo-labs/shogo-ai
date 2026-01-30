/**
 * Shogo Database Adapters
 * 
 * Provides flexible database adapter support for Prisma.
 * Allows easy switching between PostgreSQL (production) and SQLite (testing/development).
 * 
 * The adapter auto-detects the database type from DATABASE_URL or DATABASE_PROVIDER,
 * making it easy to run the same code against different databases.
 * 
 * @example
 * ```typescript
 * // In your src/lib/db.ts
 * import { createPrismaClient } from '@shogo-ai/sdk/db'
 * import { PrismaClient } from '../generated/prisma/client'
 * 
 * // Auto-detects PostgreSQL vs SQLite based on DATABASE_URL
 * export const prisma = await createPrismaClient(PrismaClient)
 * 
 * // For testing with SQLite:
 * // DATABASE_URL=file:./test.db bun test
 * ```
 */

export type DatabaseProvider = 'postgresql' | 'sqlite' | 'auto'

export interface DatabaseAdapterConfig {
  /**
   * Database provider to use
   * - 'postgresql': Use PostgreSQL adapter (requires @prisma/adapter-pg)
   * - 'sqlite': Use SQLite adapter (requires @prisma/adapter-libsql)
   * - 'auto': Auto-detect based on DATABASE_PROVIDER env var or DATABASE_URL format
   */
  provider?: DatabaseProvider
  
  /**
   * Connection string (defaults to DATABASE_URL env var)
   */
  url?: string
  
  /**
   * Prisma log levels
   */
  log?: ('query' | 'info' | 'warn' | 'error')[]
}

/**
 * Detect database provider from connection string
 */
export function detectProvider(url?: string): 'postgresql' | 'sqlite' {
  // Check explicit provider env var first
  const envProvider = process.env.DATABASE_PROVIDER?.toLowerCase()
  if (envProvider === 'sqlite') return 'sqlite'
  if (envProvider === 'postgresql' || envProvider === 'postgres') return 'postgresql'
  
  // Check URL format
  const connectionUrl = url ?? process.env.DATABASE_URL ?? ''
  if (connectionUrl.startsWith('file:') || connectionUrl.endsWith('.db')) {
    return 'sqlite'
  }
  if (connectionUrl.startsWith('postgres://') || connectionUrl.startsWith('postgresql://')) {
    return 'postgresql'
  }
  
  // Default to postgresql for production safety
  return 'postgresql'
}

/**
 * Create a database adapter based on configuration
 * 
 * @param config - Configuration options or provider string
 * @returns Promise resolving to the appropriate Prisma adapter
 */
export async function createDatabaseAdapter(
  config: DatabaseAdapterConfig | DatabaseProvider = 'auto'
): Promise<any> {
  const options: DatabaseAdapterConfig = typeof config === 'string' 
    ? { provider: config } 
    : config
  
  const url = options.url ?? process.env.DATABASE_URL ?? ''
  const provider = options.provider === 'auto' || !options.provider
    ? detectProvider(url)
    : options.provider
  
  console.log(`[shogo/db] Creating ${provider} adapter`)
  
  if (provider === 'sqlite') {
    return createSqliteAdapter(url || 'file:./dev.db')
  } else {
    return createPostgresAdapter(url)
  }
}

/**
 * Create PostgreSQL adapter
 */
async function createPostgresAdapter(connectionString: string): Promise<any> {
  try {
    // Dynamic import - @prisma/adapter-pg is an optional peer dependency
    const module = await import('@prisma/adapter-pg' as string)
    const PrismaPg = module.PrismaPg || module.default?.PrismaPg
    return new PrismaPg({ connectionString })
  } catch (error) {
    throw new Error(
      'Failed to create PostgreSQL adapter. Make sure @prisma/adapter-pg is installed.\n' +
      'Run: bun add @prisma/adapter-pg'
    )
  }
}

/**
 * Create SQLite adapter using libsql (compatible with Bun)
 */
async function createSqliteAdapter(url: string): Promise<any> {
  try {
    // Dynamic import - @prisma/adapter-libsql is an optional peer dependency
    const module = await import('@prisma/adapter-libsql' as string)
    const PrismaLibSql = module.PrismaLibSql || module.default?.PrismaLibSql
    return new PrismaLibSql({ url })
  } catch (error) {
    throw new Error(
      'Failed to create SQLite adapter. Make sure @prisma/adapter-libsql is installed.\n' +
      'Run: bun add @prisma/adapter-libsql'
    )
  }
}

// Global prisma instance cache
const globalForPrisma = globalThis as unknown as {
  __shogo_prisma: any | undefined
}

/**
 * Create a Prisma client with auto-detected adapter (async)
 * 
 * This is the main entry point for database access. It:
 * 1. Auto-detects PostgreSQL vs SQLite from DATABASE_URL
 * 2. Creates the appropriate adapter
 * 3. Caches the client globally to prevent connection exhaustion
 * 
 * @example
 * ```typescript
 * import { createPrismaClient } from '@shogo-ai/sdk/db'
 * import { PrismaClient } from '../generated/prisma/client'
 * 
 * export const prisma = await createPrismaClient(PrismaClient)
 * ```
 */
export async function createPrismaClient<T>(
  PrismaClientClass: new (options: any) => T,
  config: DatabaseAdapterConfig = {}
): Promise<T> {
  // Return cached client if available
  if (globalForPrisma.__shogo_prisma) {
    return globalForPrisma.__shogo_prisma as T
  }
  
  const adapter = await createDatabaseAdapter(config)
  const log = config.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'])
  
  const client = new PrismaClientClass({
    adapter,
    log,
  })
  
  // Cache in non-production
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__shogo_prisma = client
  }
  
  return client
}

/**
 * Create a database adapter synchronously (uses require)
 * 
 * This is useful when you need synchronous initialization.
 * Falls back gracefully if the adapter package is not installed.
 * 
 * @example
 * ```typescript
 * import { createAdapterSync } from '@shogo-ai/sdk/db'
 * import { PrismaClient } from '../generated/prisma/client'
 * 
 * const adapter = createAdapterSync()
 * export const prisma = new PrismaClient({ adapter })
 * ```
 */
export function createAdapterSync(config: DatabaseAdapterConfig = {}): any {
  const url = config.url ?? process.env.DATABASE_URL ?? ''
  const provider = config.provider === 'auto' || !config.provider
    ? detectProvider(url)
    : config.provider
  
  console.log(`[shogo/db] Creating ${provider} adapter (sync)`)
  
  if (provider === 'sqlite') {
    try {
      // Dynamic require - @prisma/adapter-libsql is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require('@prisma/adapter-libsql' as string)
      const PrismaLibSql = module.PrismaLibSql || module.default?.PrismaLibSql
      return new PrismaLibSql({ url: url || 'file:./dev.db' })
    } catch {
      throw new Error(
        'SQLite adapter not found. Install it with: bun add @prisma/adapter-libsql'
      )
    }
  } else {
    try {
      // Dynamic require - @prisma/adapter-pg is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require('@prisma/adapter-pg' as string)
      const PrismaPg = module.PrismaPg || module.default?.PrismaPg
      return new PrismaPg({ connectionString: url })
    } catch {
      throw new Error(
        'PostgreSQL adapter not found. Install it with: bun add @prisma/adapter-pg'
      )
    }
  }
}

/**
 * Create a Prisma client synchronously with auto-detected adapter
 * 
 * @example
 * ```typescript
 * import { createPrismaClientSync } from '@shogo-ai/sdk/db'
 * import { PrismaClient } from '../generated/prisma/client'
 * 
 * export const prisma = createPrismaClientSync(PrismaClient)
 * ```
 */
export function createPrismaClientSync<T>(
  PrismaClientClass: new (options: any) => T,
  config: DatabaseAdapterConfig = {}
): T {
  // Return cached client if available
  if (globalForPrisma.__shogo_prisma) {
    return globalForPrisma.__shogo_prisma as T
  }
  
  const adapter = createAdapterSync(config)
  const log = config.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'])
  
  const client = new PrismaClientClass({
    adapter,
    log,
  })
  
  // Cache in non-production
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.__shogo_prisma = client
  }
  
  return client
}

/**
 * Check if running in test/SQLite mode
 */
export function isTestMode(): boolean {
  return detectProvider() === 'sqlite'
}

/**
 * Check if running with PostgreSQL
 */
export function isPostgres(): boolean {
  return detectProvider() === 'postgresql'
}

/**
 * Get recommended DATABASE_URL for testing with SQLite
 */
export function getTestDatabaseUrl(): string {
  return 'file:./test.db'
}

/**
 * Get the current database provider
 */
export function getCurrentProvider(): DatabaseProvider {
  return detectProvider()
}
