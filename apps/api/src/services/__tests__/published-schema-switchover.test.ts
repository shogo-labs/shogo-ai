// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The SQLite→Postgres switchover, API side (SHO-514).
 *
 * `prepareEnvironmentDatabase` seeds an environment's first Postgres deploy. For
 * an environment that is ALREADY LIVE on SQLite that seed must come from the
 * archive the site is serving (`{subdomain}/data.tar.gz`), which is downloaded
 * and handed to the runtime as `seedArchive`. Seeding from `dev.db` there would
 * look completely successful while orphaning every row the live site wrote.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const PROJECT = 'b7c1d2e3-f4a5-4b6c-8d9e-0f1a2b3c4d5e'
const DB_NAME = 'project_b7c1d2e3_f4a5_4b6c_8d9e_0f1a2b3c4d5e'
const SUBDOMAIN = 'live-app'

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
  subdomain: string | null
  dbProvider: string | null
  dbSchema: string | null
  dbSchemaHash: string | null
}

let envRow: EnvRow
let ensureCalls: Array<{ environment: string; exposeToPod: boolean }>
let runtimeCalls: Array<Record<string, any>>
let pushCalls: Array<{ schema: string; seedSql: string | null; databaseUrl: string }>
let liveSeedCalls: string[]
let liveSeedResult: Awaited<ReturnType<typeof import('../published-live-seed').readLiveSeedArchive>>
/** The existence probe `data: 'empty'` runs before it starts a database (§G4). */
let archiveHead: Awaited<ReturnType<typeof import('../published-live-seed').headLiveSeedArchive>>
/** How the stubbed runtime answers an `export`. A current runtime by default. */
let runtimeReply: (body: any) => any

const LIVE_ARCHIVE = 'H4sI-live-archive-base64'

function reset() {
  envRow = {
    id: 'env_prod',
    projectId: PROJECT,
    name: 'production',
    subdomain: SUBDOMAIN,
    dbProvider: null,
    dbSchema: null,
    dbSchemaHash: null,
  }
  ensureCalls = []
  runtimeCalls = []
  pushCalls = []
  liveSeedCalls = []
  liveSeedResult = { ok: true, value: { archive: LIVE_ARCHIVE, bytes: 4096 } }
  archiveHead = { ok: true, exists: true, bytes: 4096 }
  runtimeReply = currentRuntimeReply
}

reset()

mock.module('../../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      publishedEnvironment: {
        findUnique: async () => envRow,
        update: async ({ data }: any) => {
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

mock.module('../published-schema-push', () => ({
  pushPublishedSchema: async (input: { schema: string; seedSql: string | null; databaseUrl: string }) => {
    pushCalls.push(input)
    return { ok: true as const }
  },
}))

mock.module('../published-live-seed', () => ({
  MAX_LIVE_SEED_ARCHIVE_BYTES: 64 * 1024 * 1024,
  headLiveSeedArchive: async () => archiveHead,
  readLiveSeedArchive: async (subdomain: string) => {
    liveSeedCalls.push(subdomain)
    return liveSeedResult
  },
}))

mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.internal',
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'runtime-token',
}))

function currentRuntimeReply(body: any) {
  // A CURRENT runtime: it says where the seed's rows came from, and the API
  // refuses a live-archive publish unless that is `archive` (SHO-541).
  return {
    ok: true,
    schema: { content: POSTGRES_SCHEMA, hash: 'hash-1', warnings: [] },
    seed: { sql: 'BEGIN; INSERT INTO "User" (email) VALUES (\'live@example.com\'); COMMIT;', tables: 1, rows: 1 },
    seedSource: body.seedArchive ? 'archive' : 'workspace',
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  runtimeCalls.push(body)
  if (body.mode === 'export') {
    return new Response(JSON.stringify(runtimeReply(body)), { status: 200 })
  }
  return new Response(
    JSON.stringify({ ok: true, schema: { content: POSTGRES_SCHEMA, hash: 'hash-1', warnings: [] } }),
    { status: 200 },
  )
}) as typeof fetch

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'

const { prepareEnvironmentDatabase } = await import('../published-schema.service')

beforeEach(() => reset())

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('prepareEnvironmentDatabase on a live SQLite environment', () => {
  it('seeds the first Postgres deploy from the live archive', async () => {
    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Read the archive the site is actually serving, by its subdomain.
    expect(liveSeedCalls).toEqual([SUBDOMAIN])
    const exportCall = runtimeCalls.find((call) => call.mode === 'export')
    expect(exportCall?.seed).toBe(true)
    // The rows cross over as the archive itself; the SQLite→Postgres conversion
    // stays in the runtime, which still never sees a database URL.
    expect(exportCall?.seedArchive).toBe(LIVE_ARCHIVE)
    expect(exportCall?.databaseUrl).toBeUndefined()

    expect(res.value.seeded).toBe(true)
    expect(res.value.seededFrom).toBe('live-archive')
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]!.seedSql).toContain('live@example.com')
  })

  it('falls back to the builder dev.db when the environment has no archive yet', async () => {
    liveSeedResult = { ok: true, value: null }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const exportCall = runtimeCalls.find((call) => call.mode === 'export')
    expect(exportCall?.seedArchive).toBeUndefined()
    expect(exportCall?.seed).toBe(true)
    expect(res.value.seededFrom).toBe('dev.db')
  })

  it('refuses a live-archive publish to a runtime that ignores the archive', async () => {
    // An old runtime (before SHO-514's second half) accepts `seedArchive` and
    // reads the builder's `prisma/dev.db` instead. Its reply carries a seed but
    // no `seedSource`, which is the only way the API can tell. Pushing that
    // seed would put the BUILDER's rows in Postgres and report success — the
    // exact loss SHO-514 exists to prevent (SHO-541).
    runtimeReply = (body: any) => ({
      ok: true,
      schema: { content: POSTGRES_SCHEMA, hash: 'hash-1', warnings: [] },
      seed: { sql: 'BEGIN; INSERT INTO "User" (email) VALUES (\'builder@example.com\'); COMMIT;', tables: 1, rows: 84 },
    })

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('runtime_outdated')
    expect(res.message).toContain('builder')
    // No SQL was pushed and the pod was never pointed at the database.
    expect(pushCalls).toHaveLength(0)
    expect(ensureCalls.every((call) => call.exposeToPod === false)).toBe(true)
    expect(res.details?.seedSource).toBeNull()
  })

  it('refuses the publish when the live archive cannot be carried over', async () => {
    liveSeedResult = {
      ok: false,
      code: 'live_seed_too_large',
      message: 'The live database archive is 512 MB; a switch to Postgres seeds at most 64 MB.',
    }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('live_seed_too_large')
    expect(res.status).toBe(413)
    // Nothing was pushed and the pod was never pointed at the database. The
    // describe call has already happened (it precedes the seed decision), but no
    // export — and so no SQL — is ever requested.
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe'])
    expect(pushCalls).toHaveLength(0)
    expect(ensureCalls.every((call) => call.exposeToPod === false)).toBe(true)
  })

  it('does not read the archive once the environment is on Postgres', async () => {
    envRow.dbProvider = 'postgres'
    envRow.dbSchema = POSTGRES_SCHEMA
    envRow.dbSchemaHash = 'hash-1'

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(liveSeedCalls).toHaveLength(0)
    expect(runtimeCalls.map((call) => call.mode)).toEqual(['describe'])
    expect(res.value.seeded).toBe(false)
    expect(res.value.seededFrom).toBeNull()
  })

  it('does not read the archive for an app that has never been published', async () => {
    envRow.subdomain = null

    const res = await prepareEnvironmentDatabase(PROJECT, 'production')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(liveSeedCalls).toHaveLength(0)
    expect(res.value.seededFrom).toBe('dev.db')
  })
})

describe("prepareEnvironmentDatabase with data: 'empty' (SHO-551 §G4)", () => {
  // The one build that cannot be seeded: a builder database over the seed cap
  // (Nada App's 91 MB). It may start empty ONLY where that costs nothing, so
  // every refusal below has to hold before the schema is pushed.

  it('starts the first database empty: schema only, no seed, dev.db never read', async () => {
    archiveHead = { ok: true, exists: false, bytes: 0 }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production', { data: 'empty' })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.seeded).toBe(false)
    expect(res.value.seededFrom).toBeNull()
    expect(res.value.seededRows).toBe(0)
    // Never read the archive, so never read the builder's dev.db either: the
    // seed is what was too big, and skipping it is the whole point.
    expect(liveSeedCalls).toHaveLength(0)
    const exported = runtimeCalls.find((call) => call.mode === 'export')
    expect(exported?.seed).toBe(false)
    expect(exported?.seedArchive).toBeUndefined()
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0].seedSql).toBeNull()
    // The environment still moves to Postgres, and its schema is recorded.
    expect(envRow.dbProvider).toBe('postgres')
    expect(envRow.dbSchema).toBe(POSTGRES_SCHEMA)
  })

  it('refuses an environment that is already live on SQLite', async () => {
    archiveHead = { ok: true, exists: true, bytes: 91 * 1024 * 1024 }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production', { data: 'empty' })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('data_empty_not_allowed')
    expect(res.status).toBe(400)
    expect(res.message).toContain('live on SQLite')
    // Nothing was exported, pushed or exposed: the SQLite site keeps serving.
    expect(liveSeedCalls).toHaveLength(0)
    expect(runtimeCalls.filter((call) => call.mode === 'export')).toHaveLength(0)
    expect(pushCalls).toHaveLength(0)
    expect(ensureCalls.every((call) => call.exposeToPod === false)).toBe(true)
  })

  it('refuses an environment that already has a Postgres schema, before probing storage', async () => {
    envRow.dbProvider = 'postgres'
    envRow.dbSchema = POSTGRES_SCHEMA
    envRow.dbSchemaHash = 'hash-1'
    // A storage failure here would prove the probe ran; the schema check must win.
    archiveHead = { ok: false, code: 'live_seed_unreadable', message: 'storage is down' }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production', { data: 'empty' })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('data_empty_not_allowed')
    expect(res.message).toContain('already has a Postgres schema')
    expect(pushCalls).toHaveLength(0)
  })

  it('reports a storage failure instead of starting empty', async () => {
    archiveHead = { ok: false, code: 'live_seed_unreadable', message: 'a 403 is not "no archive"' }

    const res = await prepareEnvironmentDatabase(PROJECT, 'production', { data: 'empty' })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('live_seed_unreadable')
    expect(pushCalls).toHaveLength(0)
    expect(runtimeCalls.filter((call) => call.mode === 'export')).toHaveLength(0)
  })
})
