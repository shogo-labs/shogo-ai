// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Builds the app database client (SQLite in local mode, Postgres otherwise).
 *
 * Split out of `lib/prisma` so a test can construct its own handle from this
 * module: `lib/prisma` is the module other test files `mock.module(...)`, and a
 * mock there is process-global — importing this factory instead keeps a test
 * independent of that registry.
 */

// PG types are the canonical TypeScript interface. The SQLite client is
// structurally compatible at runtime thanks to wrapForSqlite.
import type { PrismaClient } from '../generated/prisma-pg/client';

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

const DEFAULT_SQLITE_URL = 'file:./shogo.db'

/**
 * The app's own database connection string. Prefer SHOGO_APP_DATABASE_URL —
 * the Shogo-specific name the desktop app uses so the value can't be inherited
 * by project agents through the generic `DATABASE_URL` they expect (which an
 * agent's `prisma` command would otherwise run against the app DB). Falls back
 * to DATABASE_URL for cloud/dev/CI, which still set the generic name.
 */
export function appDatabaseUrl(): string | undefined {
  return process.env.SHOGO_APP_DATABASE_URL ?? process.env.DATABASE_URL
}

function getSqliteUrl(): string {
  const url = appDatabaseUrl()
  if (!url || url.startsWith('postgres')) return DEFAULT_SQLITE_URL
  return url
}

// Fields that are String[] in PostgreSQL but stored as JSON strings in SQLite.
const ARRAY_FIELDS = new Set([
  'schemas', 'affectedPackages', 'applicablePatterns', 'acceptanceCriteria',
  'given', 'then', 'completedTasks', 'failedTasks', 'tags', 'supportedConfig',
  'screenshotUrls',
  // Social automation keywords (String[] on PG, JSON String on SQLite)
  'keywords',
  // ProjectAuthConfig allowlist fields
  'allowedEmails', 'allowedDomains',
  // ModelDefinition alias list (Json? on PG, String? JSON on SQLite)
  'aliases',
  // User granular admin permission scopes (String[] on PG, JSON String on SQLite)
  'adminScopes',
  // ConversationMessageEmbedding vector (Float[] on PG, JSON String on SQLite)
  'embedding',
  // AppInstallGrant / ApiKey app scopes
  'grantedScopes', 'grantedToolkits', 'pendingScopes',
])

// Fields that are Json? in PostgreSQL but stored as String? in SQLite.
const JSON_OBJECT_FIELDS = new Set([
  'summary', 'cost', 'byCategory', 'resources', 'progress',
  'tokens', 'phaseScores', 'criteria', 'antiPatterns',
  'workspaceSnapshot', 'metadata', 'settings', 'channels',
  'actionMetadata', 'transcript', 'examples',
  'plan', 'deliverables',
  // UsageWallet per-period alert dedupe ledger (Json? on PG, String? on SQLite)
  'alertsSentThisPeriod',
  'baselineManifest', 'auditFindings',
  // ModelDefinition capability ratings (Json? on PG, String? JSON on SQLite)
  'capabilities',
  // ConversationMessage structured content and agent author reference
  'blocks', 'authorAgentRef', 'agentChain',
  // ConversationAttachment display preview (Json? on PG, JSON String on SQLite).
  // Deliberately NOT 'preview': ChatInboxItem.preview is a plain String, and this
  // set is global, so a shared name would JSON-parse inbox previews on read.
  'previewData',
  // Workspace event platform
  'payload', 'filter', 'triggerConfig', 'appManifest', 'actor',
  // Integration credential approvals and audit
  'origin',
  // Work boards
  'fieldsSchema', 'fields', 'eventData', 'occurrenceContext', 'workItemTarget',
  // Per-column rules (BoardColumn.rules: Json? on PG, JSON String on SQLite)
  'rules',
  // Marketplace agent packs (Json? on PG, JSON String on SQLite): the parsed
  // pack.yaml on a listing version, the answers an install collected, and the
  // ids it created. Missing these made publishing and installing a pack throw
  // PrismaClientValidationError on the desktop/SQLite client while PG was fine.
  'systemPack', 'answers', 'packBindings',
  // Background task destination (Json? on PG, JSON String on SQLite): where the
  // dock opens the agent's thread for a task that handed work off.
  'link',
  // Social posts / targets keep their media URL list as JSON on both sides.
  'mediaJson',
])

// In SQLite mode, String[] fields are stored as JSON strings, and
// Json? fields are stored as String?. This recursively converts values
// in create/update data payloads so callers don't need to know about
// the storage difference.
function stringifyArrays(data: any): any {
  if (data == null || typeof data !== 'object') return data
  if (data instanceof Date || data instanceof Buffer || data instanceof Uint8Array) return data
  if (Array.isArray(data)) {
    if (data.every((v: any) => typeof v === 'string' || typeof v === 'number')) {
      return JSON.stringify(data)
    }
    return data.map(stringifyArrays)
  }
  const result: any = {}
  for (const [key, value] of Object.entries(data)) {
    if (JSON_OBJECT_FIELDS.has(key) && value != null && typeof value === 'object') {
      result[key] = JSON.stringify(value)
    } else {
      result[key] = stringifyArrays(value)
    }
  }
  return result
}

function parseArrayFields(record: any): any {
  if (record == null || typeof record !== 'object') return record
  if (Array.isArray(record)) return record.map(parseArrayFields)
  for (const [key, value] of Object.entries(record)) {
    if ((ARRAY_FIELDS.has(key) || JSON_OBJECT_FIELDS.has(key)) && typeof value === 'string') {
      try { record[key] = JSON.parse(value) } catch { /* leave as-is */ }
    } else if (value && typeof value === 'object') {
      record[key] = parseArrayFields(value)
    }
  }
  return record
}

function wrapForSqlite(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async create({ args, query }: any) {
          if (args.data) args.data = stringifyArrays(args.data)
          const result = await query(args)
          return parseArrayFields(result)
        },
        async createMany({ args, query }: any) {
          if (Array.isArray(args.data)) {
            args.data = args.data.map(stringifyArrays)
          } else if (args.data) {
            args.data = stringifyArrays(args.data)
          }
          return query(args)
        },
        async update({ args, query }: any) {
          if (args.data) args.data = stringifyArrays(args.data)
          const result = await query(args)
          return parseArrayFields(result)
        },
        async updateMany({ args, query }: any) {
          if (args.data) args.data = stringifyArrays(args.data)
          return query(args)
        },
        async upsert({ args, query }: any) {
          if (args.create) args.create = stringifyArrays(args.create)
          if (args.update) args.update = stringifyArrays(args.update)
          const result = await query(args)
          return parseArrayFields(result)
        },
        async findUnique({ args, query }: any) {
          const result = await query(args)
          return parseArrayFields(result)
        },
        async findFirst({ args, query }: any) {
          const result = await query(args)
          return parseArrayFields(result)
        },
        async findMany({ args, query }: any) {
          const result = await query(args)
          return parseArrayFields(result)
        },
      },
    },
  }) as unknown as PrismaClient
}

/**
 * Switch a SQLite file to WAL mode and report whether it took. Every local
 * query runs synchronously on the API thread, and in rollback-journal mode
 * each commit syncs a journal file and locks out readers, which stalls every
 * request (health checks included) while it waits. A file another process
 * holds open can refuse the switch; it then stays in rollback-journal mode
 * rather than failing startup.
 */
export async function enableSqliteWal(url: string): Promise<boolean> {
  const file = url.replace(/^file:/, '')
  if (file === ':memory:') return false
  const { Database } = await import('bun:sqlite')
  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(file)
    db.run('PRAGMA busy_timeout = 5000')
    const row = db.query('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | null
    return row?.journal_mode?.toLowerCase() === 'wal'
  } catch (err) {
    console.warn(`[prisma] SQLite stays in rollback-journal mode: ${(err as Error).message}`)
    return false
  } finally {
    db?.close()
  }
}

export async function createPrismaClient(): Promise<PrismaClient> {
  const logConfig = process.env.NODE_ENV === 'development' ? ['error', 'warn'] as const : ['error'] as const

  if (isLocalMode) {
    const { PrismaClient: SqliteClient } = await import('../generated/prisma-sqlite/client')
    const { PrismaBunSqlite } = await import('prisma-adapter-bun-sqlite')
    const url = getSqliteUrl()
    const wal = await enableSqliteWal(url)
    const adapter = new PrismaBunSqlite({
      url,
      ...(wal ? { wal: { enabled: true, synchronous: 'NORMAL' as const, busyTimeout: 5000 } } : {}),
    })
    const client = new SqliteClient({ adapter, log: [...logConfig] })
    return wrapForSqlite(client as unknown as PrismaClient)
  }

  const { PrismaClient: PgClient } = await import('../generated/prisma-pg/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({
    connectionString: appDatabaseUrl(),
    max: parseInt(process.env.PRISMA_POOL_SIZE || '80', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  })
  return new PgClient({
    adapter,
    log: [...logConfig],
    transactionOptions: {
      maxWait: 10_000,
      timeout: 30_000,
    },
  })
}
