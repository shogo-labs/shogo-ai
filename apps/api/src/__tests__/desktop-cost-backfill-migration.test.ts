// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop `backfill_agent_cost_metrics_cache_costs` migration repairs
 * Cost Analytics history on installed apps. It runs once, on every install,
 * against real user data, so it is exercised here against the full replayed
 * desktop migration history.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../desktop/prisma/migrations')
const BACKFILL = '20261018120000_backfill_agent_cost_metrics_cache_costs'
const backfillSql = readFileSync(resolve(MIGRATIONS_DIR, BACKFILL, 'migration.sql'), 'utf-8')

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  for (const dir of readdirSync(MIGRATIONS_DIR).filter((d) => /^\d+_/.test(d)).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'))
  }
  db.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO "workspaces" ("id","name","slug","updatedAt") VALUES ('ws','Personal','personal','2026-01-01T00:00:00.000+00:00');
    INSERT INTO "projects" ("id","name","workspaceId","updatedAt") VALUES ('proj','App','ws','2026-01-01T00:00:00.000+00:00');`)
})

const T0 = Date.parse('2026-09-20T12:00:00.000Z')
/** Prisma's SQLite DateTime text format. */
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString().replace('Z', '+00:00')
const SEC = 1000
const MIN = 60 * SEC

let seq = 0
function usageEvent(actionType: string, offsetMs: number, meta: Record<string, unknown> | string, extra: { rawUsd?: number; projectId?: string | null } = {}) {
  db.query(`INSERT INTO "usage_events"
    ("id","workspaceId","projectId","memberId","actionType","actionMetadata","rawUsd","billedUsd","source","balanceBefore","balanceAfter","createdAt")
    VALUES (?,?,?,?,?,?,?,0,'daily',0,0,?)`).run(
    `ev${++seq}`, 'ws', extra.projectId === undefined ? 'proj' : extra.projectId, 'user', actionType,
    typeof meta === 'string' ? meta : JSON.stringify(meta), extra.rawUsd ?? null, at(offsetMs),
  )
}

function metric(row: Record<string, unknown>) {
  const r = {
    id: `m${++seq}`, projectId: 'proj', agentType: 'main-chat', model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, creditCost: 0, wallTimeMs: 0,
    metadata: null, offsetMs: 0, ...row,
  }
  db.query(`INSERT INTO "agent_cost_metrics"
    ("id","workspaceId","projectId","agentType","model","inputTokens","outputTokens","cachedInputTokens","creditCost","wallTimeMs","metadata","createdAt")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r.id, 'ws', r.projectId, r.agentType, r.model, r.inputTokens, r.outputTokens, r.cachedInputTokens,
    r.creditCost, r.wallTimeMs, r.metadata, at(r.offsetMs as number),
  )
  return r.id as string
}

const row = (id: string) => db.query('SELECT * FROM "agent_cost_metrics" WHERE "id" = ?').get(id) as any
const backfilledTurns = () =>
  db.query(`SELECT * FROM "agent_cost_metrics" WHERE "id" LIKE 'backfill-%' ORDER BY "createdAt"`).all() as any[]

describe('desktop cost backfill migration', () => {
  test('main-chat rows from stream usage take cache writes and cost from their usage event', () => {
    const tokens = { inputTokens: 10, outputTokens: 20, cachedInputTokens: 300 }
    const id = metric({ ...tokens, creditCost: 0.1, metadata: '{"chatSessionId":"c1","usageSource":"stream-fallback"}' })
    usageEvent('chat_message', 1, { ...tokens, cacheWriteTokens: 40, tokenRawUsd: 0.5, chatSessionId: 'c1' }, { rawUsd: 0.5 })
    usageEvent('chat_message', MIN, { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 99, tokenRawUsd: 9, chatSessionId: 'c1' })

    db.exec(backfillSql)

    expect(row(id)).toEqual(expect.objectContaining({ cacheWriteTokens: 40, creditCost: 0.5 }))
  })

  test('a main-chat row is left alone unless its usage event has identical token counts', () => {
    const id = metric({ inputTokens: 10, outputTokens: 20, creditCost: 0.1, metadata: '{"chatSessionId":"c1"}' })
    usageEvent('chat_message', 1, { inputTokens: 11, outputTokens: 20, cacheWriteTokens: 40, tokenRawUsd: 0.5, chatSessionId: 'c1' })

    db.exec(backfillSql)

    expect(row(id)).toEqual(expect.objectContaining({ cacheWriteTokens: 0, creditCost: 0.1 }))
  })

  test('per-call history becomes one main-chat row per turn, excluding sub-agent calls', () => {
    const call = (offsetMs: number, i: number, cw: number, raw: number, model = 'claude-sonnet-4-6') =>
      usageEvent('ai_proxy_completion', offsetMs, { model, inputTokens: i, outputTokens: 1, cachedInputTokens: 100, cacheWriteTokens: cw }, { rawUsd: raw })

    // Turn 1: three calls 30s apart.
    call(0, 1, 10, 0.1)
    call(30 * SEC, 2, 0, 0.2)
    call(60 * SEC, 3, 5, 0.3, 'claude-haiku-4-5')
    // Turn 2: 20 minutes later.
    call(20 * MIN, 4, 0, 0.4)
    // A sub-agent run whose two calls must not be folded into main chat.
    call(39 * MIN + 30 * SEC, 5, 7, 0.5)
    call(39 * MIN + 50 * SEC, 6, 0, 0.6)
    const sub = metric({
      agentType: 'explore', inputTokens: 11, outputTokens: 2, cachedInputTokens: 200,
      wallTimeMs: 60 * SEC, offsetMs: 40 * MIN,
    })

    db.exec(backfillSql)

    const turns = backfilledTurns()
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual(expect.objectContaining({
      agentType: 'main-chat', projectId: 'proj', model: 'claude-haiku-4-5',
      inputTokens: 6, outputTokens: 3, cachedInputTokens: 300, cacheWriteTokens: 15,
      toolCalls: 3, wallTimeMs: 60 * SEC, createdAt: at(60 * SEC),
    }))
    expect(turns[0].creditCost).toBeCloseTo(0.6, 9)
    expect(JSON.parse(turns[0].metadata)).toEqual({ usageSource: 'local-proxy', backfill: 'cache-cost-2026-10', qualityUnknown: true })
    expect(turns[1]).toEqual(expect.objectContaining({ inputTokens: 4, toolCalls: 1, wallTimeMs: 0 }))

    expect(row(sub)).toEqual(expect.objectContaining({ cacheWriteTokens: 7 }))
    expect(row(sub).creditCost).toBeCloseTo(1.1, 9)
  })

  test('a sub-agent row is left alone when its window does not account for every token', () => {
    usageEvent('ai_proxy_completion', 39 * MIN + 30 * SEC, { model: 'm', inputTokens: 5, outputTokens: 1, cacheWriteTokens: 7 }, { rawUsd: 0.5 })
    const sub = metric({ agentType: 'explore', inputTokens: 50, outputTokens: 1, creditCost: 0.2, wallTimeMs: 60 * SEC, offsetMs: 40 * MIN })

    db.exec(backfillSql)

    expect(row(sub)).toEqual(expect.objectContaining({ cacheWriteTokens: 0, creditCost: 0.2 }))
  })

  test('malformed metadata does not fail the migration, and re-running it changes nothing', () => {
    usageEvent('ai_proxy_completion', 0, 'not json', { rawUsd: 0.25 })
    usageEvent('chat_message', 0, '{broken')
    metric({ metadata: '{also broken' })
    usageEvent('ai_proxy_completion', 10 * MIN, { model: 'm', inputTokens: 1, outputTokens: 1 }, { rawUsd: 0.1, projectId: null })

    db.exec(backfillSql)
    const first = backfilledTurns()
    db.exec(backfillSql)

    expect(backfilledTurns()).toEqual(first)
    expect(first.map((t) => t.projectId)).toEqual([null])
  })
})
