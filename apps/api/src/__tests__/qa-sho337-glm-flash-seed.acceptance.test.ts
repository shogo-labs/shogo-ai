// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// A real 32-byte master key so the seed can encrypt the provider key.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
process.env.OPENROUTER_API_KEY = 'sk-or-qa-sho337-seed-contract'

/**
 * SHO-337 AC2 — the seed and the live GLM 5.3 Flash row must agree.
 *
 * The live row (`92ff11e6…`) was pinned by hand on staging and in prod:
 * `{ order: ['Friendli', 'NextBit'], allow_fallbacks: false }`, Friendli prices,
 * `maxOutputTokens: 128_000`. `seedGlmFlash` has to write the same thing, or the
 * next operator who re-runs the seeder silently hands GLM back to OpenRouter's
 * own routing — where Venice accepts `video_url` and then drops the clip.
 *
 * These tests drive the **real** seeder (via `main(['--only=glm-5-3-flash'])`)
 * against a mocked prisma and assert on the row it would write, so a future
 * edit that reintroduces `sort: 'price'`, the old Relace prices or the 131_072
 * output cap fails here instead of in production.
 *
 *   bun test apps/api/src/__tests__/qa-sho337-glm-flash-seed.acceptance.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

const PIN = { order: ['Friendli', 'NextBit'], allow_fallbacks: false }

interface UpsertCall { where: { id: string }; data: Record<string, any> }
const updates: UpsertCall[] = []
const creates: Array<{ data: Record<string, any> }> = []
let existingRow: Record<string, any> | null = null

mock.module('../lib/prisma', () => ({
  prisma: {
    modelProvider: {
      findFirst: async () => ({ id: 'prov-openrouter' }),
      update: async () => ({ id: 'prov-openrouter' }),
      create: async () => ({ id: 'prov-openrouter' }),
    },
    modelDefinition: {
      findFirst: async () => existingRow,
      update: async (args: UpsertCall) => {
        updates.push(args)
        return args
      },
      create: async (args: { data: Record<string, any> }) => {
        creates.push(args)
        return args
      },
    },
  },
}))

// Imported after the prisma mock so the seeder binds to it.
const { main } = await import('../../../../scripts/seed-db-models')

async function seedGlmFlash(): Promise<void> {
  await main(['--only=glm-5-3-flash'])
}

describe('SHO-337 GLM 5.3 Flash seed ↔ live row contract', () => {
  beforeEach(() => {
    updates.length = 0
    creates.length = 0
    existingRow = { id: 'row-glm-flash', capabilities: { supportsVideoInput: true } }
  })

  test('a re-run keeps the Friendli → NextBit pin with fallbacks off', async () => {
    await seedGlmFlash()
    expect(updates).toHaveLength(1)
    const data = updates[0].data
    expect(data.capabilities.supportsVideoInput).toBe(true)
    expect(data.capabilities.openrouterProvider).toEqual(PIN)
    // Russell (2026-11-05): pin two providers, do not sort by price.
    expect(Object.keys(data.capabilities.openrouterProvider)).not.toContain('sort')
    expect(data.capabilities.openrouterProvider.allow_fallbacks).toBe(false)
  })

  test('a re-run keeps Friendli prices and NextBit’s 128k output cap', async () => {
    await seedGlmFlash()
    const data = updates[0].data
    expect(data.maxOutputTokens).toBe(128_000)
    expect(data).toMatchObject({
      inputPerMillion: 0.15,
      cachedInputPerMillion: 0.03,
      cacheWritePerMillion: 0.15,
      outputPerMillion: 0.5,
    })
  })

  test('a re-run never re-enables a row an operator switched off', async () => {
    await seedGlmFlash()
    // prod-US is deliberately disabled until this fix is deployed; the update
    // branch must not touch `enabled` or the seeder would turn it back on.
    expect('enabled' in updates[0].data).toBe(false)
  })

  test('a fresh install creates the same routing row', async () => {
    existingRow = null
    await seedGlmFlash()
    expect(creates).toHaveLength(1)
    const data = creates[0].data
    expect(data).toMatchObject({
      provider: 'custom',
      apiModel: 'z-ai/glm-5.3-flash',
      providerId: 'prov-openrouter',
      maxOutputTokens: 128_000,
      enabled: true,
    })
    expect(data.capabilities.openrouterProvider).toEqual(PIN)
  })
})
