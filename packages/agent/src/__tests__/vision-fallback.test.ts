// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Contract for the SHO-58 vision fallback.
 *
 * Everything here runs with an injected `describeFn`: no network, no billing.
 * The bytes only ever need to be base64 — this layer hashes, sizes and
 * mime-checks the payload but never decodes it (decode validation happens in
 * `image-size-guard`, upstream). The real encoder fixture is exercised by
 * `packages/agent-runtime/src/__tests__/vision-fallback-loop.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ImageContent } from '@mariozechner/pi-ai'
import {
  createVisionDescriber,
  rankVisionModels,
  resolveVisionFallbackOptions,
  resolveVisionModel,
  type DescribeContext,
} from '../vision-fallback'

/** A real 1×1 PNG, base64 — enough for size/hash semantics at this layer. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function png(seed = 0): ImageContent {
  // Distinct payloads so each one gets its own cache key.
  return { type: 'image', data: `${TINY_PNG}${'A'.repeat(seed * 4)}`, mimeType: 'image/png' }
}

const ctx = (over: Partial<DescribeContext> = {}): DescribeContext => ({
  provider: 'openai',
  modelId: 'gpt-4',
  ...over,
})

afterEach(() => {
  delete process.env.SHOGO_VISION_FALLBACK
  delete process.env.SHOGO_VISION_FALLBACK_MODEL
})

describe('vision model pick', () => {
  it('prefers the active provider, then current generation, then economy', () => {
    const anthropic = rankVisionModels('anthropic')[0]
    expect(anthropic.provider).toBe('anthropic')
    expect(anthropic.modelId).toBe('claude-haiku-5-5')

    const openai = rankVisionModels('openai')[0]
    expect(openai.provider).toBe('openai')
    expect(openai.modelId).toBe('gpt-6-luna')

    // No hardcoded id: every candidate is a catalog chat entry with image input.
    expect(rankVisionModels('anthropic').length).toBeGreaterThan(1)
  })

  it('falls back to another provider when the active one has no vision entry', () => {
    // A grok session has no vision-capable catalog entry of its own; rather than
    // stay blind it describes through the best vision entry available.
    const picked = resolveVisionModel({ preferredProvider: 'xai' })
    expect(picked).not.toBeNull()
    expect(['anthropic', 'openai']).toContain(picked!.provider)
  })

  it('honours an explicit override and ignores one that cannot take images', () => {
    expect(resolveVisionModel({ preferredProvider: 'openai', override: 'claude-sonnet-5' })?.modelId).toBe(
      'claude-sonnet-5',
    )
    expect(
      resolveVisionModel({ preferredProvider: 'openai', override: 'anthropic:claude-opus-5-5' }),
    ).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5' })
    // gpt-4 takes text only — the override is ignored, the catalog pick stands.
    expect(resolveVisionModel({ preferredProvider: 'openai', override: 'gpt-4' })?.modelId).toBe('gpt-6-luna')
  })

  it('reads SHOGO_VISION_FALLBACK_MODEL and the SHOGO_VISION_FALLBACK=0 kill switch', () => {
    process.env.SHOGO_VISION_FALLBACK_MODEL = 'claude-opus-5-5'
    expect(resolveVisionModel({ preferredProvider: 'openai' })?.modelId).toBe('claude-opus-5-5')
    delete process.env.SHOGO_VISION_FALLBACK_MODEL

    expect(resolveVisionFallbackOptions(undefined)).toEqual({})
    expect(resolveVisionFallbackOptions(false)).toBe(false)
    process.env.SHOGO_VISION_FALLBACK = '0'
    expect(resolveVisionFallbackOptions({ maxImagesPerRun: 1 })).toBe(false)
  })
})

describe('createVisionDescriber', () => {
  it('describes an image once and reuses the cached text (prompt-cache stability)', async () => {
    let calls = 0
    const describer = createVisionDescriber({
      log: () => {},
      describeFn: async () => {
        calls += 1
        return 'A white page with the heading SHOGO-VISION-FIXTURE.'
      },
    })

    const first = await describer.describe(png(1), ctx())
    const second = await describer.describe(png(1), ctx())

    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(calls).toBe(1)
    expect(describer.stats()).toEqual({ described: 1, skipped: 1, failed: 0 })
  })

  it('caps describe calls per run and degrades the rest', async () => {
    let calls = 0
    const logs: string[] = []
    const describer = createVisionDescriber({
      maxImagesPerRun: 2,
      log: (line) => logs.push(line),
      describeFn: async () => {
        calls += 1
        return `description ${calls}`
      },
    })

    expect((await describer.describe(png(1), ctx())).ok).toBe(true)
    expect((await describer.describe(png(2), ctx())).ok).toBe(true)
    const third = await describer.describe(png(3), ctx())

    expect(third).toEqual({ ok: false, reason: 'cap-reached' })
    expect(calls).toBe(2)
    expect(logs.filter((line) => line.includes('cap-reached'))).toHaveLength(1)
  })

  it('rejects an oversized payload and an unsupported format without calling the model', async () => {
    let calls = 0
    const describer = createVisionDescriber({
      maxImageBytes: 16,
      log: () => {},
      describeFn: async () => {
        calls += 1
        return 'too late'
      },
    })

    expect(await describer.describe(png(10), ctx())).toEqual({ ok: false, reason: 'too-large' })
    expect(
      await describer.describe({ type: 'image', data: TINY_PNG, mimeType: 'image/tiff' }, ctx()),
    ).toEqual({ ok: false, reason: 'unsupported-format' })
    expect(calls).toBe(0)
  })

  it('degrades a failed describe call instead of failing the turn', async () => {
    const logs: string[] = []
    const describer = createVisionDescriber({
      log: (line) => logs.push(line),
      describeFn: async () => {
        throw new Error('vision model refused')
      },
    })

    expect(await describer.describe(png(1), ctx())).toEqual({ ok: false, reason: 'describe-failed' })
    expect(describer.stats().failed).toBe(1)
    expect(logs.some((line) => line.includes('MODEL_VISION_UNAVAILABLE') && line.includes('describe-failed'))).toBe(
      true,
    )
    // Cached, so a second pass of the same turn does not retry (and does not
    // shift the prompt-cache prefix).
    expect(await describer.describe(png(1), ctx())).toEqual({ ok: false, reason: 'describe-failed' })
    expect(describer.stats().failed).toBe(1)
  })

  it('logs MODEL_VISION_FALLBACK once per described image', async () => {
    const logs: string[] = []
    const describer = createVisionDescriber({
      log: (line) => logs.push(line),
      describeFn: async () => 'a green rectangle',
    })

    await describer.describe(png(1), ctx())

    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^MODEL_VISION_FALLBACK model=\S+ for=gpt-4 images=1 bytes=\d+ ms=\d+$/)
  })
})
