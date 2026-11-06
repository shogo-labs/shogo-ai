// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-355 — every billed cost reaches the Usage dashboard.
 *
 * A turn that generates an image is charged as **one** `chat_message` row whose
 * `actionMetadata` itemises the media (`imageBilledUsd`, `imageModels`, …). The
 * dashboard used to render that row as "Claude Opus $0.42", hiding the image
 * spend behind the chat model, and it dropped perfectly ordinary media rows
 * (an `ai_image_generation` charge) because its allow-list never named them.
 *
 * This file pins both halves: `expandUsageEvent` re-attributes folded media to
 * its own line without changing the total, and the read paths (log, summary,
 * dashboard breakdown) show the media line with its real model, provider and
 * category — never chat's vendor by default.
 *
 *   bun --no-env-file test apps/api/src/services/__tests__/analytics-media-spend.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const analytics = await import('../analytics.service')
const db = prisma as any

const WORKSPACE_SLUG = `media-spend-${crypto.randomUUID().slice(0, 8)}`
const PERIOD = '30d' as const

/**
 * The row `proxy-billing-session.ts` writes for a turn that made one image on
 * top of the chat: $0.40 of tokens plus $0.12 of image generation.
 */
const FOLDED_CHAT_ROW = {
  actionType: 'chat_message',
  billedUsd: 0.52,
  rawUsd: 0.4,
  actionMetadata: {
    model: 'claude-opus-4-1',
    provider: 'anthropic',
    inputTokens: 120_000,
    outputTokens: 4_000,
    totalTokens: 124_000,
    // The itemisation the billing session adds when media rides along.
    tokenBilledUsd: 0.4,
    imageBilledUsd: 0.12,
    imageRawUsd: 0.1,
    imageGenerationCount: 1,
    imageModel: 'gpt-image-1',
    imageModels: ['gpt-image-1'],
  },
}

describe('expandUsageEvent', () => {
  test('a plain chat turn stays one line, untouched', () => {
    const lines = analytics.expandUsageEvent({
      actionType: 'chat_message',
      billedUsd: 0.4,
      rawUsd: 0.3,
      actionMetadata: { model: 'claude-opus-4-1', provider: 'anthropic', totalTokens: 100 },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].actionType).toBe('chat_message')
    expect(lines[0].billedUsd).toBeCloseTo(0.4, 9)
  })

  test('a standalone media row is one line and keeps its own model', () => {
    const lines = analytics.expandUsageEvent({
      actionType: 'ai_image_generation',
      billedUsd: 0.12,
      rawUsd: 0.1,
      actionMetadata: { model: 'gpt-image-1', provider: 'openai', imageGenerationCount: 1 },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].actionType).toBe('ai_image_generation')
    expect(lines[0].meta.model).toBe('gpt-image-1')
    expect(lines[0].billedUsd).toBeCloseTo(0.12, 9)
  })

  test('image spend folded into a chat turn becomes its own line', () => {
    const lines = analytics.expandUsageEvent(FOLDED_CHAT_ROW)
    expect(lines).toHaveLength(2)

    const chat = lines.find((l) => l.actionType === 'chat_message')!
    const image = lines.find((l) => l.actionType === 'ai_image_generation')!

    // The chat line keeps only its tokens; the image dollars move off it.
    expect(chat.billedUsd).toBeCloseTo(0.4, 9)
    expect(chat.meta.model).toBe('claude-opus-4-1')

    // The media line carries the media model, its generation count, and the
    // marker that says it came out of a folded turn.
    expect(image.billedUsd).toBeCloseTo(0.12, 9)
    expect(image.rawUsd).toBeCloseTo(0.1, 9)
    expect(image.meta.model).toBe('gpt-image-1')
    expect(image.meta.foldedIntoChatTurn).toBe(true)
    expect(image.requests).toBe(1)

    // Splitting only moves dollars between lines.
    const total = lines.reduce((sum, l) => sum + l.billedUsd, 0)
    expect(total).toBeCloseTo(FOLDED_CHAT_ROW.billedUsd, 9)
  })

  test('two media kinds in one turn become two lines, and the count drives requests', () => {
    const lines = analytics.expandUsageEvent({
      actionType: 'chat_message',
      billedUsd: 1.5,
      rawUsd: 1.2,
      actionMetadata: {
        model: 'claude-opus-4-1',
        provider: 'anthropic',
        tokenBilledUsd: 0.5,
        imageBilledUsd: 0.4,
        imageGenerationCount: 1,
        imageModel: 'gpt-image-1',
        videoBilledUsd: 0.6,
        videoGenerationCount: 4,
        videoModel: 'veo-3',
      },
    })
    expect(lines.map((l) => l.actionType)).toEqual([
      'chat_message',
      'ai_image_generation',
      'ai_video_generation',
    ])
    const video = lines.find((l) => l.actionType === 'ai_video_generation')!
    // Four generations billed in one row, not one.
    expect(video.requests).toBe(4)
    expect(video.meta.model).toBe('veo-3')
    expect(lines.reduce((sum, l) => sum + l.billedUsd, 0)).toBeCloseTo(1.5, 9)
  })

  test('a pre-itemisation chat row (no media keys) is not split', () => {
    const lines = analytics.expandUsageEvent({
      actionType: 'chat_message',
      billedUsd: 0.2,
      rawUsd: 0.15,
      actionMetadata: { model: 'claude-sonnet-4-5', provider: 'anthropic', totalTokens: 900 },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].billedUsd).toBeCloseTo(0.2, 9)
  })
})

describe('a media line reaches the read paths', () => {
  let scope: { workspaceId: string }
  let memberId: string

  beforeAll(async () => {
    const suffix = crypto.randomUUID().slice(0, 8)
    const user = await db.user.create({
      data: { name: 'Media User', email: `media-${suffix}@example.com` },
    })
    memberId = user.id
    const workspace = await db.workspace.create({
      data: { name: 'Media Usage', slug: WORKSPACE_SLUG, kind: 'team' },
    })
    scope = { workspaceId: workspace.id }
    const now = Date.now()
    await db.usageEvent.createMany({
      data: [
        {
          workspaceId: workspace.id,
          projectId: null,
          memberId,
          source: 'daily',
          balanceBefore: 0,
          balanceAfter: 0,
          createdAt: new Date(now - 60_000),
          ...FOLDED_CHAT_ROW,
        },
        {
          workspaceId: workspace.id,
          projectId: null,
          memberId,
          actionType: 'ai_video_generation',
          source: 'daily',
          billedUsd: 0.75,
          rawUsd: 0.6,
          balanceBefore: 0,
          balanceAfter: 0,
          createdAt: new Date(now - 120_000),
          actionMetadata: { model: 'veo-3', provider: 'google', videoGenerationCount: 2 },
        },
      ],
    })
  })

  test('the log shows the split image line with its own model and category', async () => {
    const log = await analytics.getUsageLog(scope, PERIOD)
    const image = log.entries.find((e: any) => e.actionType === 'ai_image_generation')
    expect(image).toBeDefined()
    expect(image!.model).toBe('gpt-image-1')
    expect(image!.category).toBe('image')
    // The image was generated by OpenAI — it must not inherit the chat vendor.
    expect(image!.provider).not.toBe('anthropic')
    expect(image!.billedUsd).toBeCloseTo(0.12, 9)

    // The chat line remains, with the token cost only.
    const chat = log.entries.find((e: any) => e.actionType === 'chat_message')
    expect(chat!.billedUsd).toBeCloseTo(0.4, 9)
  })

  test('the summary reports a separate image row', async () => {
    const summary = await analytics.getUsageSummary(scope, PERIOD)
    const image = summary.summaries.find((row: any) => row.category === 'image')
    expect(image).toBeDefined()
    expect(image!.totalBilledUsd).toBeCloseTo(0.12, 9)
    expect(image!.model).toBe('gpt-image-1')
  })

  test('the dashboard breakdown bills the media under image/video', async () => {
    const dashboard = await analytics.getUsageDashboard(scope, { period: PERIOD })
    expect(dashboard.usage.byActionType.ai_image_generation.count).toBe(1)
    expect(dashboard.usage.byActionType.ai_video_generation.count).toBe(1)
    expect(dashboard.usage.byCategory.image.totalSpendUsd).toBeCloseTo(0.12, 9)
    expect(dashboard.usage.byCategory.video.totalSpendUsd).toBeCloseTo(0.75, 9)
    // Nothing was lost: the whole window still adds up.
    expect(dashboard.usage.totalSpendUsd).toBeCloseTo(0.52 + 0.75, 9)
  })

  test('a voice_* row never renders as its raw tag, and a model-less chat row is unknown', () => {
    expect(analytics.usageLabelFor('voice_minutes_inbound', {}).model).toBe('Voice · inbound')
    expect(analytics.usageLabelFor('voice_something_new', {}).model).toBe('Voice')
    expect(analytics.usageLabelFor('voice_something_new', {}).provider).toBe('elevenlabs')
    // A billed completion with no recorded model has no better name than this.
    expect(analytics.usageLabelFor('ai_proxy_completion', {}).model).toBe('unknown')
  })
})
