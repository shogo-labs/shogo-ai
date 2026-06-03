// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the model-id → UUID migration (scripts/migrate-model-ids-to-uuid.ts).
 *
 *   bun test scripts/__tests__/migrate-model-ids.test.ts
 *
 * Backed by a small in-memory prisma store so we can assert the full re-key:
 * slug-keyed `model_definitions` rows become UUIDs, the old slug is preserved
 * as an alias, and every reference column (incl. the visible-models config and
 * usage_events JSON) is repointed at the new id.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── In-memory tables ───────────────────────────────────────────────────────
interface Row {
  [k: string]: any
}
const db = {
  modelDefinition: [] as Row[],
  agentConfig: [] as Row[],
  projectAgent: [] as Row[],
  subagentModelOverride: [] as Row[],
  agentCostMetric: [] as Row[],
  agentEvalResult: [] as Row[],
  evalRun: [] as Row[],
  modelExperiment: [] as Row[],
  platformSetting: [] as Row[],
  usageEvent: [] as Row[],
}

function makeTable(rows: () => Row[]) {
  return {
    findMany: async (_args?: any) => rows(),
    findUnique: async ({ where }: any) =>
      rows().find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    update: async ({ where, data }: any) => {
      const row = rows().find((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' })
      Object.assign(row, data)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const r of rows()) {
        const match = Object.entries(where).every(([k, v]) => r[k] === v)
        if (match) {
          Object.assign(r, data)
          count++
        }
      }
      return { count }
    },
  }
}

const prismaMock: any = {
  modelDefinition: makeTable(() => db.modelDefinition),
  agentConfig: makeTable(() => db.agentConfig),
  projectAgent: makeTable(() => db.projectAgent),
  subagentModelOverride: makeTable(() => db.subagentModelOverride),
  agentCostMetric: makeTable(() => db.agentCostMetric),
  agentEvalResult: makeTable(() => db.agentEvalResult),
  evalRun: makeTable(() => db.evalRun),
  modelExperiment: makeTable(() => db.modelExperiment),
  platformSetting: makeTable(() => db.platformSetting),
  usageEvent: makeTable(() => db.usageEvent),
  // Interactive transaction: hand the same mock client to the callback.
  $transaction: async (fn: any) => fn(prismaMock),
}

mock.module('../../apps/api/src/lib/prisma', () => ({ prisma: prismaMock }))

const { runMigration, isUuid } = await import('../migrate-model-ids-to-uuid')

beforeEach(() => {
  for (const key of Object.keys(db) as Array<keyof typeof db>) db[key].length = 0
})

describe('migrate-model-ids', () => {
  test('re-keys slug-id models to UUIDs and backfills every reference', async () => {
    db.modelDefinition.push({ id: 'mimo-v2.5', provider: 'custom', apiModel: 'mimo-v2.5', aliases: ['mimo'] })
    db.agentConfig.push({ id: 'ac1', modelName: 'mimo-v2.5' })
    db.projectAgent.push({ id: 'pa1', model: 'mimo-v2.5' })
    db.subagentModelOverride.push({ id: 'so1', model: 'mimo-v2.5' })
    db.agentCostMetric.push({ id: 'cm1', model: 'mimo-v2.5' })
    db.agentEvalResult.push({ id: 'er1', model: 'mimo-v2.5' })
    db.evalRun.push({ id: 'ev1', model: 'mimo-v2.5' })
    db.modelExperiment.push({ id: 'mx1', modelA: 'mimo-v2.5', modelB: 'claude-sonnet-4-6' })
    db.platformSetting.push({
      key: 'models.visible',
      value: JSON.stringify({ catalogIds: ['mimo-v2.5', 'claude-sonnet-4-6'], openrouterModels: [] }),
    })
    db.usageEvent.push({ id: 'ue1', actionMetadata: { model: 'mimo-v2.5', billingModel: 'sonnet' } })
    // A row whose JSON is a string (SQLite shape) must also be rewritten.
    db.usageEvent.push({ id: 'ue2', actionMetadata: JSON.stringify({ model: 'mimo-v2.5' }) })
    // An unrelated usage event must be left untouched.
    db.usageEvent.push({ id: 'ue3', actionMetadata: { model: 'claude-sonnet-4-6' } })

    const { migrated } = await runMigration(false)
    expect(migrated).toBe(1)

    const model = db.modelDefinition[0]
    expect(isUuid(model.id)).toBe(true)
    const newId = model.id
    // Old slug preserved as an alias.
    expect(model.aliases).toContain('mimo-v2.5')
    expect(model.aliases).toContain('mimo')

    // Simple references repointed.
    expect(db.agentConfig[0].modelName).toBe(newId)
    expect(db.projectAgent[0].model).toBe(newId)
    expect(db.subagentModelOverride[0].model).toBe(newId)
    expect(db.agentCostMetric[0].model).toBe(newId)
    expect(db.agentEvalResult[0].model).toBe(newId)
    expect(db.evalRun[0].model).toBe(newId)
    expect(db.modelExperiment[0].modelA).toBe(newId)
    // The non-migrated id stays as-is.
    expect(db.modelExperiment[0].modelB).toBe('claude-sonnet-4-6')

    // visible-models config remapped (only the migrated id).
    const visible = JSON.parse(db.platformSetting[0].value)
    expect(visible.catalogIds).toEqual([newId, 'claude-sonnet-4-6'])

    // usage_events JSON rewritten for both object + string shapes.
    expect((db.usageEvent[0].actionMetadata as any).model).toBe(newId)
    expect((db.usageEvent[1].actionMetadata as any).model).toBe(newId)
    // Unrelated event untouched.
    expect((db.usageEvent[2].actionMetadata as any).model).toBe('claude-sonnet-4-6')
  })

  test('is idempotent: rows already keyed by a UUID are skipped', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    db.modelDefinition.push({ id: uuid, provider: 'custom', apiModel: 'mimo-v2.5', aliases: ['mimo-v2.5'] })
    db.agentConfig.push({ id: 'ac1', modelName: uuid })

    const { migrated } = await runMigration(false)
    expect(migrated).toBe(0)
    expect(db.modelDefinition[0].id).toBe(uuid)
    expect(db.agentConfig[0].modelName).toBe(uuid)
  })

  test('dry run reports the plan without writing', async () => {
    db.modelDefinition.push({ id: 'gpt-5', provider: 'openai', apiModel: 'gpt-5', aliases: [] })
    db.agentConfig.push({ id: 'ac1', modelName: 'gpt-5' })

    const { migrated } = await runMigration(true)
    expect(migrated).toBe(0)
    // Nothing mutated.
    expect(db.modelDefinition[0].id).toBe('gpt-5')
    expect(db.agentConfig[0].modelName).toBe('gpt-5')
  })
})
