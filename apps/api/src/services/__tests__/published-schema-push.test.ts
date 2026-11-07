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
import { PUSH_CONFIG, pushEnv, pushPublishedSchema, resolvePrismaCli } from '../published-schema-push'

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

  it('finds the Prisma CLI the API ships', () => {
    expect(existsSync(resolvePrismaCli())).toBe(true)
  })
})
