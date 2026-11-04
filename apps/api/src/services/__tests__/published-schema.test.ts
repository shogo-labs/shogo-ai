// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Schema + seed at publish (SHO-308 §1).
 *
 * The service's job is ordering and refusal: provision, classify, push, seed,
 * then expose. Each test below pins one of those steps, because getting the
 * order wrong is what would hand a pod a DATABASE_URL for a database whose
 * schema is not on it yet.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const PROJECT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const DB_NAME = 'project_a1b2c3d4_e5f6_4a7b_8c9d_0e1f2a3b4c5d'

const SQLITE_SCHEMA = `datasource db {
  provider = "sqlite"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`
const POSTGRES_SCHEMA = SQLITE_SCHEMA.replace('provider = "sqlite"', 'provider = "postgresql"')

type EnvRow = {
  id: string
  projectId: string
  name: string
  dbProvider: string | null
  dbName: string | null
  dbSchema: string | null
  dbSchemaHash: string | null
}

let envRow: EnvRow
let envUpdates: any[]
let ensureCalls: Array<{ environment: string; exposeToPod: boolean }>
let runtimeCalls: Array<{ mode: string; databaseUrl?: string; seed?: boolean; expectedHash?: string }>
let runtimeDescribe: any
let runtimeApply: { ok: boolean; status: number; data: any }

function resetEnv() {
  envRow = {
    id: 'env_prod',
    projectId: PROJECT,
    name: 'production',
    dbProvider: null,
    dbName: null,
    dbSchema: null,
    dbSchemaHash: null,
  }
  envUpdates = []
  ensureCalls = []
  runtimeCalls = []
  runtimeDescribe = {
    ok: true,
    status: 200,
    data: { ok: true, schema: { content: POSTGRES_SCHEMA, hash: 'hash-1', warnings: [] } },
  }
  runtimeApply = { ok: true, status: 200, data: { ok: true, hash: 'hash-1', warnings: [], seeded: { tables: 1, rows: 3 } } }
}

resetEnv()

mock.module('../../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      publishedEnvironment: {
        findUnique: async () => envRow,
        update: async ({ data }: any) => {
          envUpdates.push(data)
          Object.assign(envRow, data)
          return envRow
        },
      },
    },
  }),
)

mock.module('../published-database.service', () => ({
  ensureEnvironmentDatabase: async (
    projectId: string,
    environment: string,
    opts: { exposeToPod?: boolean } = {},
  ) => {
    ensureCalls.push({ environment, exposeToPod: opts.exposeToPod === true })
    return {
      ok: true,
      value: {
        databaseName: DB_NAME,
        secretName: `published-db-${projectId}-${environment}`,
        url: `postgres://shogo:secret@projects-pg-pooler-rw:5432/${DB_NAME}?pgbouncer=true&connection_limit=5`,
        directUrl: `postgres://shogo:secret@projects-pg-rw:5432/${DB_NAME}`,
        provider: 'postgres',
      },
    }
  },
}))

mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.internal',
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'runtime-token',
}))

const realFetch = globalThis.fetch
globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  runtimeCalls.push(body)
  const result = body.mode === 'apply' ? runtimeApply : runtimeDescribe
  return new Response(JSON.stringify(result.data), { status: result.status })
}) as typeof fetch

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'

const { prepareEnvironmentDatabase } = await import('../published-schema.service')

beforeEach(() => {
  resetEnv()
})

describe('prepareEnvironmentDatabase', () => {
  it('pushes the schema, seeds the first deploy, then writes the Secret', async () => {
    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.applied).toBe(true)
      expect(res.value.seeded).toBe(true)
      expect(res.value.seededRows).toBe(3)
      expect(res.value.schemaHash).toBe('hash-1')
    }

    // Describe, then apply — the apply carries the hash the describe returned, so
    // the runtime can refuse a schema that changed mid-publish.
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe', 'apply'])
    const apply = runtimeCalls[1]!
    expect(apply.expectedHash).toBe('hash-1')
    expect(apply.seed).toBe(true)
    // DDL runs against the primary, never the pooler.
    expect(apply.databaseUrl).toContain('projects-pg-rw')

    // The Secret is written last: it is what makes a pod read Postgres.
    expect(ensureCalls).toEqual([
      { environment: 'production', exposeToPod: false },
      { environment: 'production', exposeToPod: true },
    ])

    // The row now records the schema, which is what the next publish classifies
    // against and what the replica guard reads.
    expect(envUpdates.at(-1)).toMatchObject({
      dbProvider: 'postgres',
      dbSchema: POSTGRES_SCHEMA,
      dbSchemaHash: 'hash-1',
    })
  })

  it('skips the push when the schema has not changed, and never re-seeds', async () => {
    envRow.dbProvider = 'postgres'
    envRow.dbName = DB_NAME
    envRow.dbSchema = POSTGRES_SCHEMA
    envRow.dbSchemaHash = 'hash-1'

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.applied).toBe(false)
      expect(res.value.seeded).toBe(false)
    }
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe'])
    expect(ensureCalls.at(-1)?.exposeToPod).toBe(true)
  })

  it('refuses a destructive change with the affected fields', async () => {
    envRow.dbProvider = 'postgres'
    envRow.dbName = DB_NAME
    envRow.dbSchema = `datasource db {
  provider = "postgresql"
}

model User {
  id       Int    @id @default(autoincrement())
  email    String @unique
  nickname String?
}
`
    envRow.dbSchemaHash = 'hash-0'

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('destructive_schema_change')
      expect(res.status).toBe(409)
      expect(res.message).toContain('allow_data_loss')
      const changes = (res.details?.changes ?? []) as Array<{ kind: string; name?: string }>
      expect(changes.map((change) => change.kind)).toContain('dropped_field')
      expect(changes.map((change) => change.name)).toContain('User.nickname')
    }
    // Nothing was pushed, and the pod was never told to use the database.
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe'])
    expect(ensureCalls.every((call) => call.exposeToPod === false)).toBe(true)
  })

  it('applies the destructive change when the caller accepts data loss', async () => {
    envRow.dbProvider = 'postgres'
    envRow.dbSchema = `datasource db {
  provider = "postgresql"
}

model User {
  id       Int    @id @default(autoincrement())
  email    String @unique
  nickname String?
}
`
    envRow.dbSchemaHash = 'hash-0'

    const res = await prepareEnvironmentDatabase(PROJECT, 'production', { allowDataLoss: true })
    expect(res.ok).toBe(true)
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe', 'apply'])
    // Accepting data loss accepts the dropped column; it must NOT re-seed. A seed
    // is a plain INSERT with the seeded ids into a database that already has rows,
    // so it would fail on a duplicate key *after* the drop had been applied —
    // leaving the column gone and the publish reporting seed_failed.
    expect(runtimeCalls[1]!.seed).toBe(false)
  })

  it('surfaces a runtime push failure as schema_push_failed and does not expose the database', async () => {
    runtimeApply = {
      ok: false,
      status: 400,
      data: { ok: false, code: 'schema_push_failed', message: 'relation "User" already exists' },
    }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('schema_push_failed')
      expect(res.message).toContain('already exists')
    }
    expect(ensureCalls.some((call) => call.exposeToPod)).toBe(false)
    expect(envUpdates).toHaveLength(0)
  })

  it('is a no-op in local/desktop mode: nothing to provision, nothing to push', async () => {
    // A desktop publish keeps SQLite. The service must not try to reach
    // projects-pg (it would fail `database_unavailable` and break publish there).
    delete process.env.KUBERNETES_SERVICE_HOST
    try {
      const res = await prepareEnvironmentDatabase(PROJECT, 'production')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.database).toBeNull()
        expect(res.value.applied).toBe(false)
      }
      expect(ensureCalls).toHaveLength(0)
      expect(runtimeCalls).toHaveLength(0)
    } finally {
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    }
  })

  it('seeds nothing for an app with no Prisma models', async () => {
    runtimeDescribe = { ok: true, status: 200, data: { ok: true, schema: null } }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.applied).toBe(false)
      expect(res.value.seeded).toBe(false)
    }
    // An app with no models has nothing to read from Postgres, so it is NOT
    // moved off SQLite: pointing a pod at an empty database it never uses would
    // only be one more thing to go wrong.
    expect(ensureCalls.every((call) => call.exposeToPod === false)).toBe(true)
  })
})

// Restore the global once the suite is done, not at module evaluation — a
// top-level restore would run before the first test and put the real fetch back.
afterAll(() => {
  globalThis.fetch = realFetch
})
