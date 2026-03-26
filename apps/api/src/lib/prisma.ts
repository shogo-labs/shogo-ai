// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// PG types are the canonical TypeScript interface. The SQLite client is
// structurally compatible at runtime thanks to wrapForSqlite.
import type { PrismaClient } from '../generated/prisma-pg/client';

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// In SQLite mode, String[] fields are stored as JSON strings.
// This recursively converts any array values in create/update data payloads
// so callers don't need to know about the storage difference.
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
    result[key] = stringifyArrays(value)
  }
  return result
}

// Fields that are String[] in PostgreSQL but stored as JSON strings in SQLite.
// We parse them back into arrays on read so the API returns the same shape.
const ARRAY_FIELDS = new Set([
  'schemas', 'affectedPackages', 'applicablePatterns', 'acceptanceCriteria',
  'given', 'then', 'completedTasks', 'failedTasks', 'tags', 'supportedConfig',
])

function parseArrayFields(record: any): any {
  if (record == null || typeof record !== 'object') return record
  if (Array.isArray(record)) return record.map(parseArrayFields)
  for (const [key, value] of Object.entries(record)) {
    if (ARRAY_FIELDS.has(key) && typeof value === 'string') {
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
  const logConfig = process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] as const : ['error'] as const

  if (isLocalMode) {
    const { PrismaClient: SqliteClient } = await import('../generated/prisma-sqlite/client')
    const { PrismaBunSqlite } = await import('prisma-adapter-bun-sqlite')
    const dbUrl = process.env.DATABASE_URL || 'file:./shogo.db'
    const adapter = new PrismaBunSqlite({ url: dbUrl })
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

export const prisma = globalForPrisma.prisma ?? await createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from '../generated/prisma-pg/client';
export * from '../generated/prisma-pg/client';
