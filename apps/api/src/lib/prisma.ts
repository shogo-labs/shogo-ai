// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// PG types are the canonical TypeScript interface. The SQLite client is
// structurally compatible at runtime thanks to wrapForSqlite.
import type { PrismaClient } from '../generated/prisma-pg/client';

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

const DEFAULT_SQLITE_URL = 'file:./shogo.db'

function getSqliteUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url || url.startsWith('postgres')) return DEFAULT_SQLITE_URL
  return url
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Fields that are String[] in PostgreSQL but stored as JSON strings in SQLite.
const ARRAY_FIELDS = new Set([
  'schemas', 'affectedPackages', 'applicablePatterns', 'acceptanceCriteria',
  'given', 'then', 'completedTasks', 'failedTasks', 'tags', 'supportedConfig',
  'screenshotUrls',
])

// Fields that are Json? in PostgreSQL but stored as String? in SQLite.
const JSON_OBJECT_FIELDS = new Set([
  'summary', 'cost', 'byCategory', 'resources', 'progress',
  'tokens', 'phaseScores', 'criteria', 'antiPatterns',
  'workspaceSnapshot', 'metadata', 'settings', 'channels',
  'actionMetadata', 'transcript', 'examples',
  'baselineManifest', 'auditFindings',
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

async function createPrismaClient(): Promise<PrismaClient> {
  const logConfig = process.env.NODE_ENV === 'development' ? ['error', 'warn'] as const : ['error'] as const

  if (isLocalMode) {
    const { PrismaClient: SqliteClient } = await import('../generated/prisma-sqlite/client')
    const { PrismaBunSqlite } = await import('prisma-adapter-bun-sqlite')
    // WAL + a generous busy_timeout reduces the rate of transient
    // SQLITE_BUSY / SQLITE_IOERR faults dramatically vs. the default
    // rollback journal: WAL lets readers run while one writer holds
    // the lock, and a 15s timeout absorbs Time Machine / Spotlight /
    // AV-scanner blips that previously caused immediate failures.
    const adapter = new PrismaBunSqlite({
      url: getSqliteUrl(),
      wal: { enabled: true, busyTimeout: 15_000, synchronous: 'NORMAL' },
    })
    const client = new SqliteClient({ adapter, log: [...logConfig] })
    return wrapForSqlite(client as unknown as PrismaClient)
  }

  const { PrismaClient: PgClient } = await import('../generated/prisma-pg/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
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

// ─── Auto-recovering Prisma proxy ────────────────────────────────────────
//
// Why this exists
// ---------------
// The bun:sqlite driver behind prisma-adapter-bun-sqlite holds a single
// long-lived Database handle for the lifetime of the process. When that
// handle hits SQLITE_IOERR (raw text "disk I/O error") — typically from a
// brief macOS sleep/wake fd invalidation, a Spotlight/AV scanner touching
// the WAL, a Time Machine snapshot, or a transient FS hiccup — bun:sqlite
// surfaces the error to Prisma, but every SUBSEQUENT statement on the same
// handle also returns SQLITE_IOERR. The handle is poisoned for the rest of
// the process.
//
// In Shogo Desktop this showed up as a "disk I/O error" toast in the chat
// panel with a Retry button that did nothing. Retry re-issued the same
// HTTP request which hit the same poisoned client → same error. The only
// recovery path users had was Quit + relaunch.
//
// Root fix: detect a disk-I/O error at the Prisma boundary, dispose the
// underlying adapter (which closes the broken Database handle), build a
// fresh PrismaClient, and re-issue the failed call once against the new
// client. Subsequent calls then go straight through. Side effects:
//
//   - The Retry button now works on the first click — there's nothing
//     to "retry" by then because the next call already succeeded, but
//     pressing it is safe and fast.
//   - Even without Retry, the next user message (or background poll)
//     transparently recovers the connection.
//   - If the underlying fault is persistent (genuinely out of disk,
//     permissions revoked), the recycled client also fails on its first
//     query and we propagate the error normally — no infinite loop.
//
// Why a Proxy and not a wrapper class
// -----------------------------------
// Prisma's generated client surface is large (every model × every method)
// and the SQLite path is further wrapped by `$extends`. Listing every
// callable by hand is fragile. The Proxy below intercepts ALL model
// accessors (`prisma.user`, `prisma.project`, ...) and ALL of their
// methods (`findFirst`, `create`, `update`, ...), plus top-level methods
// (`$transaction`, `$queryRaw`, etc.), and applies recovery uniformly.

const IO_ERROR_PATTERNS = [
  /disk\s*i\/?o\s*error/i,
  /SQLITE_IOERR/i,
  /database\s+disk\s+image\s+is\s+malformed/i,
  /database\s+is\s+locked/i, // SQLITE_BUSY past busy_timeout — also handle-level
]

function isRecoverableDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = String((err as any).message ?? '')
  const cause = String((err as any).cause?.message ?? '')
  return IO_ERROR_PATTERNS.some((p) => p.test(msg) || p.test(cause))
}

interface PrismaSlot {
  client: PrismaClient
  // Monotonic id so concurrent in-flight callers can tell whether the
  // client they failed against has already been recycled by someone
  // else and avoid stampeding the rebuild.
  generation: number
}

let slot: PrismaSlot = {
  client: globalForPrisma.prisma ?? await createPrismaClient(),
  generation: 0,
}

let recycleInFlight: Promise<PrismaSlot> | null = null

async function recyclePrismaClient(failedGeneration: number): Promise<PrismaSlot> {
  // Coalesce concurrent recovery attempts. The first caller does the
  // rebuild; everyone else awaits the same promise.
  if (recycleInFlight) return recycleInFlight
  if (slot.generation > failedGeneration) return slot

  recycleInFlight = (async () => {
    const broken = slot.client
    try {
      // $disconnect calls the adapter's dispose(), which closes the
      // underlying bun:sqlite Database. Swallow errors here — the
      // handle is already poisoned; we just want to release the fd.
      await broken.$disconnect().catch(() => {})
    } finally {
      const fresh = await createPrismaClient()
      slot = { client: fresh, generation: slot.generation + 1 }
      if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.prisma = fresh
      }
      console.warn(
        `[prisma] Recycled database connection after I/O fault ` +
        `(generation ${slot.generation}).`,
      )
    }
    return slot
  })().finally(() => {
    recycleInFlight = null
  })

  return recycleInFlight
}

function wrapMethod<T extends (...args: any[]) => any>(
  modelName: string | null,
  methodName: string,
  capturedGeneration: number,
  fn: T,
  thisArg: unknown,
): T {
  return (async (...args: any[]) => {
    try {
      return await fn.apply(thisArg, args)
    } catch (err) {
      if (!isRecoverableDbError(err)) throw err
      console.warn(
        `[prisma] disk I/O error on ${modelName ?? '$client'}.${methodName} ` +
        `— recycling connection and retrying once.`,
      )
      const next = await recyclePrismaClient(capturedGeneration)
      // Re-resolve the method against the fresh client and retry exactly
      // once. If THIS call also fails (real disk full, etc.) we let the
      // error propagate so the API returns its normal proxy_error response
      // and the UI surfaces it — no infinite loop.
      const target: any = modelName ? (next.client as any)[modelName] : next.client
      const retryFn = target?.[methodName]
      if (typeof retryFn !== 'function') throw err
      return await retryFn.apply(target, args)
    }
  }) as T
}

function makeModelProxy(modelName: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, methodKey) {
        if (typeof methodKey !== 'string') return undefined
        const captured = slot
        const target: any = (captured.client as any)[modelName]
        if (!target) return undefined
        const value = target[methodKey]
        if (typeof value !== 'function') return value
        return wrapMethod(modelName, methodKey, captured.generation, value, target)
      },
    },
  )
}

const TOP_LEVEL_RECOVERABLE_METHODS = new Set([
  '$transaction',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
])

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined
    const captured = slot
    const value = (captured.client as any)[key]
    if (typeof value === 'function') {
      // Top-level helpers: only wrap the ones that issue queries —
      // wrapping $extends / $on would break Prisma's builder API.
      if (TOP_LEVEL_RECOVERABLE_METHODS.has(key)) {
        return wrapMethod(null, key, captured.generation, value, captured.client)
      }
      return value.bind(captured.client)
    }
    if (value && typeof value === 'object') {
      // Model delegate (prisma.user, prisma.project, ...). Return a
      // per-call proxy so the captured generation is always fresh.
      return makeModelProxy(key)
    }
    return value
  },
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = slot.client
}

/** Test-only: force a recovery cycle. Not part of the public surface. */
export async function __recyclePrismaForTest(): Promise<void> {
  await recyclePrismaClient(slot.generation)
}

export type { PrismaClient } from '../generated/prisma-pg/client';
export * from '../generated/prisma-pg/client';
