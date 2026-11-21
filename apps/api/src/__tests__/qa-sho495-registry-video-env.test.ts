// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-495 — `AGENT_MODEL_REGISTRY` is the only way a modality reaches the
 * runtime for a model the runtime receives as an opaque id.
 *
 * A seeded Gemini row is keyed by a UUID with the provider slug in `apiModel`
 * and no `capabilities` of its own, and the runtime can only classify that id
 * from what the API serializes into `AGENT_MODEL_REGISTRY`. The rest of the
 * chain is covered elsewhere (`read_file` and the attachment parser on that
 * flag: `packages/agent-runtime/src/__tests__/video-input.test.ts`; the proxy
 * guard on the merged entry: `ai-proxy-video-input.test.ts`); this file pins
 * the hop between them, so dropping the flag from the serializer — or writing
 * the entry under the slug instead of the row id — fails here instead of
 * silently making Carbon text-only again.
 *
 * Run: bun test apps/api/src/__tests__/qa-sho495-registry-video-env.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY

/** Seeded by `seedGemini` before SHO-495: UUID id, slug in `apiModel`, no capabilities. */
const CARBON_UUID = '6f1c5a2e-8f43-4b1c-9d3a-0c1b2a3d4e5f'
/** The same seeder's row for a model the probe never cleared. */
const FLASH_LITE_UUID = 'e5f6a7b8-5555-4c6d-8e3f-4a5b6c7d8e9f'
/** An admin-edited row: it declares its own capabilities, which must win. */
const OVERRIDDEN_UUID = 'f6a7b8c9-6666-4d7e-9f4a-5b6c7d8e9f0a'

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
        row(FLASH_LITE_UUID, 'gemini-3.5-flash-lite', null),
        row(OVERRIDDEN_UUID, 'gemini-4-argon', { supportsVideoInput: false }),
      ],
    },
    modelProvider: { findMany: async () => [] },
  },
}))

const { invalidateModelRegistry } = await import('../services/model-registry.service')
const { serializeModelRegistryEnv } = await import('../lib/runtime/agent-model-defaults')

type SerializedEntry = { id: string; provider: string; apiModel?: string; supportsVideoInput?: boolean }

let entries: SerializedEntry[] = []

beforeAll(async () => {
  await invalidateModelRegistry()
  const raw = serializeModelRegistryEnv()
  expect(raw).toBeTruthy()
  entries = JSON.parse(raw as string) as SerializedEntry[]
})

describe('AGENT_MODEL_REGISTRY for a seeded Carbon row', () => {
  test('carries the flag on the row id the runtime receives', () => {
    const carbon = entries.find((e) => e.id === CARBON_UUID)
    expect(carbon).toBeDefined()
    expect(carbon?.provider).toBe('google')
    // The slug is what routes upstream; the UUID is what the runtime knows the
    // model by, so the flag has to ride on the UUID entry.
    expect(carbon?.apiModel).toBe('gemini-4-carbon')
    expect(carbon?.supportsVideoInput).toBe(true)
    expect(entries.some((e) => e.id === 'gemini-4-carbon')).toBe(false)
  })

  test('a Google model the probe never cleared gets no flag', () => {
    const lite = entries.find((e) => e.id === FLASH_LITE_UUID)
    expect(lite).toBeDefined()
    expect(lite?.supportsVideoInput).toBeUndefined()
  })

  test('a row that declares its own capabilities is not overridden by the catalog', () => {
    const overridden = entries.find((e) => e.id === OVERRIDDEN_UUID)
    expect(overridden).toBeDefined()
    expect(overridden?.supportsVideoInput).toBeUndefined()
  })
})
