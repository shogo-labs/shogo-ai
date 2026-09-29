// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The DB model seed must agree with the static catalog it mirrors.
 *
 * Deployments with DB-defined models show ONLY the DB rows in the picker, so a
 * current model that is in MODEL_CATALOG but not seeded never ships (GPT-5.6
 * Terra and Luna, #1006), and a seeded price that drifts from
 * MODEL_DOLLAR_COSTS bills users at a different rate than analytics records.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { MODEL_CATALOG, MODEL_DOLLAR_COSTS } from '../../packages/agent/src/model-catalog'

type Row = Record<string, any> & { provider: string; apiModel: string }
const seeded: Row[] = []

/** Current native models left out of the seed, and why. */
const NOT_SEEDED: Record<string, string> = {
  'gpt-audio': "billed on a placeholder 'opus' bucket until audio tokens get their own; not shipped broadly",
  'claude-haiku-4-5-20251001':
    'basic-mode / channel / router-economy default, resolved from the static catalog; ' +
    'not user-selectable on DB-defined deployments — seed it if it should be',
}

const catalogEntry = (row: Row) =>
  catalog.find((m) => m.provider === row.provider && m.apiModel === row.apiModel)

beforeAll(async () => {
  const table = (rows: Row[]) => ({
    findFirst: async () => null,
    create: async ({ data }: { data: Row }) => {
      rows.push(data)
      return { id: `id-${rows.length}`, ...data }
    },
    update: async ({ data }: { data: Row }) => data,
  })
  mock.module('../../apps/api/src/lib/prisma', () => ({
    prisma: { modelDefinition: table(seeded), modelProvider: table([]) },
  }))
  mock.module('../../apps/api/src/lib/secret-crypto', () => ({
    encryptSecret: (s: string) => `enc:${s}`,
    isSecretCryptoConfigured: () => false,
  }))
  const log = console.log
  console.log = () => {}
  try {
    const { main } = await import('../seed-db-models')
    await main()
  } finally {
    console.log = log
  }
})

const NATIVE = new Set(['anthropic', 'openai'])
const catalog = Object.values(MODEL_CATALOG) as Array<Record<string, any>>

describe('seed-db-models vs MODEL_CATALOG / MODEL_DOLLAR_COSTS', () => {
  it('seeds at least the native models', () => {
    expect(seeded.filter((r) => NATIVE.has(r.provider)).length).toBeGreaterThan(5)
  })

  it('every current native catalog model is seeded (else it never reaches the picker)', () => {
    const seededModels = new Set(seeded.map((r) => `${r.provider}:${r.apiModel}`))
    const missing = catalog
      .filter((m) => NATIVE.has(m.provider) && m.generation === 'current' && !(m.id in NOT_SEEDED))
      .filter((m) => !seededModels.has(`${m.provider}:${m.apiModel}`))
      .map((m) => m.id)
    expect(missing).toEqual([])
  })

  it('excused models are still current catalog models (drop stale excuses)', () => {
    for (const id of Object.keys(NOT_SEEDED)) {
      expect({ id, current: (MODEL_CATALOG as Record<string, any>)[id]?.generation === 'current' }).toEqual({ id, current: true })
    }
  })

  it('a seeded native model matches its catalog entry, or is a legacy row outside the catalog', () => {
    for (const row of seeded.filter((r) => NATIVE.has(r.provider))) {
      const entry = catalogEntry(row)
      if (!entry) {
        expect({ apiModel: row.apiModel, generation: row.generation }).toEqual({ apiModel: row.apiModel, generation: 'legacy' })
        continue
      }
      expect({ apiModel: row.apiModel, generation: row.generation, tier: row.tier }).toEqual({
        apiModel: row.apiModel,
        generation: entry.generation,
        tier: entry.tier,
      })
    }
  })

  it('seeded token prices match MODEL_DOLLAR_COSTS for the billing bucket', () => {
    const fields = ['inputPerMillion', 'cachedInputPerMillion', 'cacheWritePerMillion', 'outputPerMillion'] as const
    for (const row of seeded.filter((r) => NATIVE.has(r.provider) && r.kind !== 'live')) {
      // Rows outside the catalog bill through their family bucket.
      const billingModel = catalogEntry(row)?.billingModel ?? row.family
      const costs = (MODEL_DOLLAR_COSTS as Record<string, Record<string, number>>)[billingModel]
      expect({ apiModel: row.apiModel, billingModel, hasCosts: !!costs }).toEqual({
        apiModel: row.apiModel,
        billingModel,
        hasCosts: true,
      })
      const got = Object.fromEntries(fields.map((f) => [f, row[f]]))
      const want = Object.fromEntries(fields.map((f) => [f, costs[f]]))
      expect({ apiModel: row.apiModel, ...got }).toEqual({ apiModel: row.apiModel, ...want })
    }
  })
})
