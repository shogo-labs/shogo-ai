// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `repriceLocalUsage` rewrites stored desktop cost once a model's real rates
 * are known. Runs its SQL against the replayed desktop migration history.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prisma } from '../generated/prisma-sqlite/client'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../desktop/prisma/migrations')
let db: Database

const bind = (values: unknown[]) => values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) as any[]

mock.module('../lib/prisma', () => withPrismaExports({
  Prisma,
  prisma: {
    $queryRaw: async (q: Prisma.Sql) => db.query(q.sql).all(...bind(q.values)),
    $executeRaw: async (q: Prisma.Sql) => db.query(q.sql).run(...bind(q.values)).changes,
    localConfig: {
      findMany: async ({ where }: any) =>
        db.query(`SELECT "key" FROM "local_config" WHERE "key" LIKE ? || '%'`).all(where.key.startsWith),
      upsert: async ({ create }: any) =>
        db.query(`INSERT INTO "local_config" ("key","value","updatedAt") VALUES (?,?,?)
          ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`).run(create.key, create.value, new Date().toISOString()),
    },
  },
}))

const { repriceLocalUsage } = await import('../lib/local-usage-repricing')

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
beforeAll(() => { process.env.SHOGO_LOCAL_MODE = 'true' })
afterAll(() => {
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
})

beforeEach(() => {
  db = new Database(':memory:')
  for (const dir of readdirSync(MIGRATIONS_DIR).filter((d) => /^\d+_/.test(d)).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'))
  }
  db.exec(`INSERT INTO "workspaces" ("id","name","slug","updatedAt") VALUES ('ws','Personal','personal','2026-01-01T00:00:00.000+00:00');`)
})

const HOSHI = '4fa677d1-e4a6-4ea1-88b5-e57101e810cd'
const HOSHI_RATES = { inputPerMillion: 0.15, cachedInputPerMillion: 0.001, cacheWritePerMillion: 0.15, outputPerMillion: 0.3 }
const LOCAL = 'local-db-model'
const LOCAL_RATES = { inputPerMillion: 2, cachedInputPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 }
/** 1M uncached input, 10M cache reads, 1M output. */
const TOKENS = { inputTokens: 1_000_000, cachedInputTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 }
const hoshiCost = 0.15 + 10 * 0.001 + 0.3

let seq = 0
function metric(model: string, creditCost: number, metadata: string | null = null) {
  const id = `m${++seq}`
  db.query(`INSERT INTO "agent_cost_metrics"
    ("id","workspaceId","agentType","model","inputTokens","cachedInputTokens","cacheWriteTokens","outputTokens","creditCost","metadata","createdAt")
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 'ws', 'main-chat', model, TOKENS.inputTokens, TOKENS.cachedInputTokens, TOKENS.cacheWriteTokens, TOKENS.outputTokens,
    creditCost, metadata, '2026-10-18T10:00:00.000+00:00',
  )
  return id
}
function usageEvent(model: string, rawUsd: number, extra: Record<string, unknown> = {}, actionType = 'chat_message') {
  const id = `e${++seq}`
  db.query(`INSERT INTO "usage_events"
    ("id","workspaceId","memberId","actionType","actionMetadata","rawUsd","billedUsd","source","balanceBefore","balanceAfter","createdAt")
    VALUES (?,?,?,?,?,?,0,'daily',0,0,?)`).run(
    id, 'ws', 'user', actionType, JSON.stringify({ model, ...TOKENS, rawUsd, ...extra }), rawUsd, '2026-10-18T10:00:00.000+00:00',
  )
  return id
}
const metricRow = (id: string) => db.query('SELECT * FROM "agent_cost_metrics" WHERE "id" = ?').get(id) as any
const eventRow = (id: string) => {
  const r = db.query('SELECT * FROM "usage_events" WHERE "id" = ?').get(id) as any
  return { ...r, meta: JSON.parse(r.actionMetadata) }
}

describe('repriceLocalUsage', () => {
  test('first time a cloud model has rates, all of its history is repriced, once', async () => {
    const m = metric(HOSHI, 52.5, '{"chatSessionId":"c1"}')
    const chat = usageEvent(HOSHI, 52.5, { tokenRawUsd: 52.5, tokenBilledUsd: 63 })
    const call = usageEvent(HOSHI, 7, {}, 'ai_proxy_completion')
    const other = metric('claude-sonnet-5', 9)

    await repriceLocalUsage(new Map([[HOSHI, HOSHI_RATES]]), new Set([HOSHI]))

    expect(metricRow(m).creditCost).toBeCloseTo(hoshiCost, 9)
    expect(JSON.parse(metricRow(m).metadata)).toEqual({ chatSessionId: 'c1' })
    expect(eventRow(chat).rawUsd).toBeCloseTo(hoshiCost, 9)
    expect(eventRow(chat).meta.rawUsd).toBeCloseTo(hoshiCost, 9)
    expect(eventRow(chat).meta.tokenRawUsd).toBeCloseTo(hoshiCost, 9)
    expect(eventRow(chat).meta.tokenBilledUsd).toBeCloseTo(hoshiCost * 1.2, 9)
    expect(eventRow(call).rawUsd).toBeCloseTo(hoshiCost, 9)
    expect(eventRow(call).meta.tokenRawUsd).toBeUndefined()
    expect(metricRow(other).creditCost).toBe(9)

    // Rows written after the first pass were priced from real rates and are left alone.
    const later = metric(HOSHI, 1.23)
    await repriceLocalUsage(new Map([[HOSHI, HOSHI_RATES]]), new Set([HOSHI]))
    expect(metricRow(later).creditCost).toBe(1.23)
  })

  test('rows recorded without rates are repriced and unmarked, for local and cloud models', async () => {
    db.exec(`INSERT INTO "local_config" ("key","value","updatedAt") VALUES ('usage-repriced:${HOSHI}','{}','2026-01-01')`)
    const unmarked = metric(HOSHI, 1.23)
    const marked = metric(HOSHI, 0, '{"usageSource":"local-proxy","pricingUnknown":true}')
    const markedEvent = usageEvent(HOSHI, 0, { pricingUnknown: true })
    const local = metric(LOCAL, 0, '{"pricingUnknown":true}')
    const localPriced = metric(LOCAL, 4)

    await repriceLocalUsage(new Map([[HOSHI, HOSHI_RATES], [LOCAL, LOCAL_RATES]]), new Set([HOSHI]))

    expect(metricRow(unmarked).creditCost).toBe(1.23)
    expect(metricRow(marked).creditCost).toBeCloseTo(hoshiCost, 9)
    expect(JSON.parse(metricRow(marked).metadata)).toEqual({ usageSource: 'local-proxy' })
    expect(eventRow(markedEvent).rawUsd).toBeCloseTo(hoshiCost, 9)
    expect(eventRow(markedEvent).meta.pricingUnknown).toBeUndefined()
    expect(metricRow(local).creditCost).toBeCloseTo(2 + 10 * 0.2 + 10, 9)
    expect(metricRow(localPriced).creditCost).toBe(4)
  })

  test('malformed metadata is skipped without failing the pass', async () => {
    const broken = metric(HOSHI, 5, '{broken')
    db.query(`INSERT INTO "usage_events"
      ("id","workspaceId","memberId","actionType","actionMetadata","rawUsd","billedUsd","source","balanceBefore","balanceAfter","createdAt")
      VALUES ('bad','ws','user','chat_message','not json',1,0,'daily',0,0,'2026-10-18')`).run()

    await repriceLocalUsage(new Map([[HOSHI, HOSHI_RATES]]), new Set([HOSHI]))

    expect(metricRow(broken).creditCost).toBeCloseTo(hoshiCost, 9)
    expect((db.query(`SELECT "rawUsd" FROM "usage_events" WHERE "id" = 'bad'`).get() as any).rawUsd).toBe(1)
  })
})
