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
    await main([])
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

describe('seed-db-models --only', () => {
  const runQuietly = async (argv: string[]) => {
    const { main } = await import('../seed-db-models')
    const log = console.log
    console.log = () => {}
    try {
      await main(argv)
    } finally {
      console.log = log
    }
  }

  it('seeds only the named model', async () => {
    const before = seeded.length
    await runQuietly(['--only=haiku-5-5'])
    expect(seeded.slice(before).map((r) => `${r.provider}:${r.apiModel}`)).toEqual(['anthropic:claude-haiku-5-5'])
  })

  it('rejects unknown seeder names before writing anything', async () => {
    const before = seeded.length
    await expect(runQuietly(['--only=haiku-5-5,nope'])).rejects.toThrow('Unknown seeder(s): nope')
    await expect(runQuietly(['--only='])).rejects.toThrow('Unknown seeder(s)')
    expect(seeded.length).toBe(before)
  })
})

describe('seed-db-models --only=gemini', () => {
  const geminiRows: Row[] = []

  beforeAll(async () => {
    // Fresh mock that records only the new creates from --only=gemini.
    const table = (rows: Row[]) => ({
      findFirst: async () => null,
      create: async ({ data }: { data: Row }) => {
        rows.push(data)
        return { id: `gid-${rows.length}`, ...data }
      },
      update: async ({ data }: { data: Row }) => data,
    })
    mock.module('../../apps/api/src/lib/prisma', () => ({
      prisma: { modelDefinition: table(geminiRows), modelProvider: table([]) },
    }))

    const log = console.log
    console.log = () => {}
    try {
      const { main } = await import('../seed-db-models')
      await main(['--only=gemini'])
    } finally {
      console.log = log
    }
  })

  it('creates 7 Google rows', () => {
    expect(geminiRows.filter((r) => r.provider === 'google').length).toBe(7)
  })

  it('all 7 rows have updatedBy = seed:db-models', () => {
    const bad = geminiRows.filter((r) => r.provider === 'google' && r.updatedBy !== 'seed:db-models')
    expect(bad).toEqual([])
  })

  it('the 6 current rows are enabled, the 1 legacy row is disabled', () => {
    const google = geminiRows.filter((r) => r.provider === 'google')
    const enabled = google.filter((r) => r.enabled)
    const disabled = google.filter((r) => !r.enabled)
    expect(enabled.length).toBe(6)
    expect(disabled.length).toBe(1)
    expect(disabled[0]!.apiModel).toBe('gemini-3.1-pro-preview')
  })

  it('copies the catalog’s video capability onto exactly the probed rows', () => {
    // The row is what the proxy guard and AGENT_MODEL_REGISTRY read, and its id
    // is a UUID the catalog cannot classify — so the flag has to be written
    // here, not left to the slug (SHO-495).
    const flagged = geminiRows
      .filter((r) => r.provider === 'google' && (r.capabilities as { supportsVideoInput?: boolean } | undefined)?.supportsVideoInput === true)
      .map((r) => r.apiModel)
      .sort()
    expect(flagged).toEqual(['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon'])

    // The two the probe never cleared must not pick the flag up by accident.
    for (const apiModel of ['gemini-3.5-flash-lite', 'gemini-3.1-pro-preview']) {
      const row = geminiRows.find((r) => r.apiModel === apiModel)!
      expect((row.capabilities as { supportsVideoInput?: boolean } | undefined)?.supportsVideoInput).toBeUndefined()
    }
  })

  it('all rates match MODEL_DOLLAR_COSTS (at seed time, before price step)', () => {
    for (const row of geminiRows.filter((r) => r.provider === 'google')) {
      const entry = catalog.find((m) => m.provider === row.provider && m.apiModel === row.apiModel)
      if (!entry) continue // legacy legacy row not in MODEL_CATALOG is fine
      const billingModel = entry.billingModel ?? row.family
      const costs = (MODEL_DOLLAR_COSTS as Record<string, Record<string, number>>)[billingModel]
      if (!costs) continue
      // Rates should be >= the base rates (may be post-step if run after Dec 1,
      // but must never be 0 — the whole point of this seeder is non-zero billing).
      expect({ apiModel: row.apiModel, nonZero: row.inputPerMillion > 0 }).toEqual({ apiModel: row.apiModel, nonZero: true })
    }
  })
})
