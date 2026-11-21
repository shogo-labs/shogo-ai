// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-495 — a model's modality has to survive the hop to the id each consumer
 * actually uses.
 *
 * The catalog keys models by provider slug; a DB row is keyed by a UUID with
 * the slug in `apiModel`; a cloud-connected desktop receives yet another UUID
 * from the upstream picker. Each of those is a place where `supportsVideoInput`
 * was silently dropped, so Carbon 400'd on video on staging and on a desktop
 * forwarding to cloud while every slug-keyed test stayed green.
 *
 * Run: bun test apps/api/src/__tests__/model-registry-video-capability.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
// `resolveVisibleCatalogModels` hides a model whose provider has no key; a
// Google key is enough for the picker assertions below.
process.env.GOOGLE_API_KEY = 'AIza-test-google-video-key'

/** The seeded Carbon row: UUID id, slug in `apiModel`, no capabilities. */
const CARBON_UUID = '6f1c5a2e-8f43-4b1c-9d3a-0c1b2a3d4e5f'
/** A row the seeder wrote *after* SHO-495: the flag copied into the row. */
const FLASH_38_UUID = 'd4e5f6a7-4444-4b5c-9d2e-3f4a5b6c7d8e'
/** What the connected cloud's picker sends a desktop. */
const CLOUD_CARBON_UUID = '11111111-2222-4333-8444-555555555555'
const CLOUD_PLAIN_UUID = '99999999-8888-4777-8666-555555555555'

const row = (id: string, apiModel: string, capabilities: Record<string, unknown> | null) => ({
  id,
  provider: 'google',
  providerId: null,
  apiModel,
  displayName: apiModel,
  shortDisplayName: apiModel,
  tier: 'premium',
  family: 'gemini',
  generation: 'current',
  kind: 'chat',
  maxOutputTokens: 65536,
  enabled: true,
  sortOrder: 10,
  aliases: [apiModel],
  capabilities,
  inputPerMillion: 1,
  cachedInputPerMillion: 0.1,
  cacheWritePerMillion: 1.25,
  outputPerMillion: 10,
  contextWindow: 1048576,
  reasoningEffort: 'medium',
})

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    modelDefinition: {
      findMany: async () => [
        row(CARBON_UUID, 'gemini-4-carbon', null),
        row(FLASH_38_UUID, 'gemini-3.8-flash', { supportsVideoInput: true }),
      ],
    },
    modelProvider: { findMany: async () => [] },
  },
}))

mock.module('../lib/federated-upstream', () => ({
  fetchCloudVisibleModels: async () => ({
    catalogModels: [
      {
        id: CLOUD_CARBON_UUID,
        provider: 'google',
        displayName: 'Gemini 4 Carbon',
        shortDisplayName: 'Carbon',
        tier: 'premium',
        family: 'gemini',
        maxOutputTokens: 65536,
        contextWindow: 1048576,
        supportsVideoInput: true,
      },
      {
        id: CLOUD_PLAIN_UUID,
        provider: 'google',
        displayName: 'Gemini 3.5 Flash-Lite',
        shortDisplayName: 'Flash-Lite',
        tier: 'economy',
        family: 'gemini',
        maxOutputTokens: 65536,
        contextWindow: 1048576,
      },
    ],
  }),
}))

const { getMergedModelEntrySync, getCloudModelEntriesSync, invalidateModelRegistry } =
  await import('../services/model-registry.service')
const { resolveVisibleCatalogModels } = await import('../services/visible-models.service')

beforeAll(async () => {
  await invalidateModelRegistry()
})

describe('a local DB row', () => {
  test('inherits the catalog’s modality through its apiModel', () => {
    // The row is silent, and its UUID means nothing to the catalog — the slug
    // in `apiModel` is the only link back to what the model can do.
    expect(getMergedModelEntrySync(CARBON_UUID)?.capabilities?.supportsVideoInput).toBe(true)
  })

  test('keeps the capabilities it declares itself', () => {
    expect(getMergedModelEntrySync(FLASH_38_UUID)?.capabilities?.supportsVideoInput).toBe(true)
  })

  test('projects the flag into the picker payload a desktop mirrors', async () => {
    const entries = await resolveVisibleCatalogModels(null)
    const carbon = entries.find((e) => e.id === CARBON_UUID)
    expect(carbon?.supportsVideoInput).toBe(true)
  })
})

describe('a cloud-mirrored row (cloud-proxy desktop)', () => {
  test('rebuilds capabilities from the payload flag', () => {
    const entry = getCloudModelEntriesSync().find((e) => e.id === CLOUD_CARBON_UUID)
    expect(entry?.capabilities?.supportsVideoInput).toBe(true)
    // The id the desktop's runtime and proxy guard see is this cloud UUID.
    expect(getMergedModelEntrySync(CLOUD_CARBON_UUID)?.capabilities?.supportsVideoInput).toBe(true)
  })

  test('a cloud row without the flag stays text-only', () => {
    expect(getMergedModelEntrySync(CLOUD_PLAIN_UUID)?.capabilities?.supportsVideoInput).toBeUndefined()
  })

  test('the desktop picker re-serves the flag to a nested mirror', async () => {
    const entries = await resolveVisibleCatalogModels(null)
    expect(entries.find((e) => e.id === CLOUD_CARBON_UUID)?.supportsVideoInput).toBe(true)
  })
})
