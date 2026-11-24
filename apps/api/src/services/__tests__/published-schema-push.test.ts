// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The publish-time push runs the Prisma CLI from the API process, whose own
 * environment carries the platform's DATABASE_URL. These pin that a push can
 * only ever reach the database it was given (SHO-308 §1).
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  describeDatabaseFailure,
  PUSH_CONFIG,
  pushEnv,
  pushPublishedSchema,
  resolvePrismaCli,
} from '../published-schema-push'

const TARGET = 'postgres://project_x:pw@projects-pg-rw:5432/project_x'

describe('pushEnv', () => {
  it('drops every connection string the API has and sets only the published one', () => {
    const env = pushEnv(TARGET, {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://platform',
      PROJECTS_DB_ADMIN_URL: 'postgres://admin',
      DIRECT_URL: 'postgres://direct',
      PRISMA_SCHEMA_ENGINE_BINARY: '/x',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.PROJECTS_DB_ADMIN_URL).toBeUndefined()
    expect(env.DIRECT_URL).toBeUndefined()
    expect(env.PRISMA_SCHEMA_ENGINE_BINARY).toBeUndefined()
    expect(env.PUBLISHED_DATABASE_URL).toBe(TARGET)
  })
})

describe('pushPublishedSchema', () => {
  it('runs push then execute from a temp dir holding only its own schema and config', async () => {
    const calls: Array<{ args: string[]; cwd: string; files: string[]; config: string; url?: string }> = []
    const runPrisma = async (args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      calls.push({
        args,
        cwd,
        files: ['schema.prisma', 'prisma.config.ts', 'seed.sql'].filter((f) => existsSync(join(cwd, f))),
        config: readFileSync(join(cwd, 'prisma.config.ts'), 'utf-8'),
        url: env.PUBLISHED_DATABASE_URL,
      })
      return ''
    }

    const result = await pushPublishedSchema(
      { schema: 'datasource db { provider = "postgresql" }', seedSql: 'BEGIN; COMMIT;', databaseUrl: TARGET },
      { runPrisma },
    )

    expect(result).toEqual({ ok: true })
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([['db', 'push'], ['db', 'execute']])
    // Prisma 7 rejects --skip-generate on push and --schema on execute.
    for (const call of calls) {
      expect(call.args).not.toContain('--skip-generate')
      expect(call.args).not.toContain('--schema')
      expect(call.args).toContain('--config')
      expect(call.url).toBe(TARGET)
      expect(call.config).toBe(PUSH_CONFIG)
    }
    expect(calls[1]!.files).toContain('seed.sql')
    // The temp dir is gone afterwards: seed SQL is the app's data.
    expect(existsSync(calls[0]!.cwd)).toBe(false)
  })

  it('skips the load when there is no seed, and reports which step failed', async () => {
    const pushOnly: string[][] = []
    const ok = await pushPublishedSchema(
      { schema: 's', seedSql: null, databaseUrl: TARGET },
      { runPrisma: async (args) => { pushOnly.push(args); return '' } },
    )
    expect(ok.ok).toBe(true)
    expect(pushOnly).toHaveLength(1)

    const failedPush = await pushPublishedSchema(
      { schema: 's', seedSql: 'x', databaseUrl: TARGET },
      { runPrisma: async () => { throw new Error('P1001: Can\'t reach database server') } },
    )
    expect(failedPush).toMatchObject({ ok: false, code: 'schema_push_failed' })

    const failedSeed = await pushPublishedSchema(
      { schema: 's', seedSql: 'x', databaseUrl: TARGET },
      {
        runPrisma: async (args) => {
          if (args[1] === 'execute') throw new Error('duplicate key value')
          return ''
        },
      },
    )
    expect(failedSeed).toMatchObject({ ok: false, code: 'seed_failed' })
  })

  // §G4: a seed too big for one runtime response is loaded chunk by chunk, so the
  // size limit is per request instead of per database (Nada App's is 91 MB).
  it('loads a chunked seed with one db execute per chunk, in order', async () => {
    const loaded: Array<{ index: number; sql: string }> = []
    const calls: string[][] = []
    const result = await pushPublishedSchema(
      {
        schema: 'datasource db { provider = "postgresql" }',
        seedSql: null,
        seedChunks: {
          count: 3,
          fetchChunk: async (index) => ({ ok: true as const, sql: `BEGIN;\n-- chunk ${index}\nCOMMIT;` }),
        },
        databaseUrl: TARGET,
      },
      {
        runPrisma: async (args, cwd) => {
          calls.push(args)
          if (args[1] === 'execute') {
            const file = args[args.indexOf('--file') + 1]!
            loaded.push({ index: Number(/seed-(\d+)\.sql$/.exec(file)?.[1] ?? 0), sql: readFileSync(join(cwd, file.split('/').pop()!), 'utf-8') })
          }
          return ''
        },
      },
    )
    expect(result).toEqual({ ok: true })
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['db', 'push'],
      ['db', 'execute'],
      ['db', 'execute'],
      ['db', 'execute'],
    ])
    expect(loaded.map((c) => c.index)).toEqual([1, 2, 3])
    expect(loaded.map((c) => c.sql.trim())).toEqual([
      'BEGIN;\n-- chunk 0\nCOMMIT;',
      'BEGIN;\n-- chunk 1\nCOMMIT;',
      'BEGIN;\n-- chunk 2\nCOMMIT;',
    ])
  })

  it('fails the publish when a chunk cannot be read, naming which one', async () => {
    const result = await pushPublishedSchema(
      {
        schema: 's',
        seedSql: null,
        seedChunks: {
          count: 3,
          fetchChunk: async (index) =>
            index === 1
              ? { ok: false as const, code: 'seed_token_expired', message: 'the seed expired' }
              : { ok: true as const, sql: 'BEGIN; COMMIT;' },
        },
        databaseUrl: TARGET,
      },
      { runPrisma: async () => '' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('seed_failed')
      expect(result.message).toContain('chunk 2 of 3')
      expect(result.message).toContain('seed_token_expired')
    }
  })

  it('finds the Prisma CLI the API ships', () => {
    expect(existsSync(resolvePrismaCli())).toBe(true)
  })
})

// SHO-551: a seed failure must name the table and constraint, not dump a Prisma
// stack trace. describeDatabaseFailure is used for both push and seed errors.
describe('describeDatabaseFailure', () => {
  it('names the table and the foreign key of an orphaned row', () => {
    const text = describeDatabaseFailure(
      'Error: ERROR: insert or update on table "stage_changes" violates foreign key constraint "stage_changes_applicationId_fkey"\n    at Psql.raw (prisma.ts:12)',
      'seed',
    )
    expect(text).toContain('table "stage_changes"')
    expect(text).toContain('constraint "stage_changes_applicationId_fkey"')
    expect(text).not.toContain('at Psql.raw')
  })

  it('still names the constraint when the message carries no table', () => {
    const text = describeDatabaseFailure('violates foreign key constraint "payments_applicationId_fkey"', 'seed')
    expect(text).toContain('constraint "payments_applicationId_fkey"')
  })

  it('describes a missing NOT NULL value, a duplicate and a missing table', () => {
    expect(
      describeDatabaseFailure('null value in column "handledBy" of relation "applications" violates not-null constraint', 'push'),
    ).toContain('column "handledBy" of table "applications"')
    expect(
      describeDatabaseFailure('duplicate key value violates unique constraint "User_email_key"', 'seed'),
    ).toContain('constraint "User_email_key"')
    expect(describeDatabaseFailure('relation "notes" does not exist', 'push')).toContain('table "notes"')
  })

  it('falls back to a bounded tail for anything it cannot name', () => {
    const text = describeDatabaseFailure(`P1001: Can't reach database server\n${'x'.repeat(2000)}`, 'seed')
    expect(text.startsWith('the rows were refused:')).toBe(true)
    expect(text.length).toBeLessThan(500)
  })
})
