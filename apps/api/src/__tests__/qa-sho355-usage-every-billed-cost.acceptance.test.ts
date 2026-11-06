// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-355 QA acceptance — every billed cost shows up, labelled honestly.
 *
 * The card's seven acceptance criteria, exercised end to end against a real
 * SQLite database (the desktop migration track) through the same read paths the
 * Usage tab calls: `getUsageLog`, `getUsageSummary`, `getUsageDashboard` and
 * `getMemberInsights`.
 *
 * Each fixture row carries the `actionMetadata` its real producer writes (see
 * `apps/api/src/jobs/published-usage.ts`, `routes/ai-proxy.ts`,
 * `services/social/usage.service.ts`), so a label that is right only for the
 * synthetic `{ model: 'x' }` case still fails here.
 *
 *   bun --no-env-file test apps/api/src/__tests__/qa-sho355-usage-every-billed-cost.acceptance.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const { usageCategoryFor, BILLED_USAGE_ACTION_TYPE_LIST, USAGE_CATEGORY_LABELS, USAGE_CATEGORY_ORDER, usageActionLabel } =
  await import('../config/usage-action-types')
const db = prisma as any

const PERIOD = '30d' as const
const SLUG = `qa-sho355-${crypto.randomUUID().slice(0, 8)}`

let scope: { workspaceId: string }
let memberId: string

/**
 * One row per billed action type, with the metadata its producer actually
 * writes — including the types that record **no model at all** (hosting and
 * every social charge), because those are the ones the dashboard used to label
 * `unknown` / `anthropic`.
 */
const FIXTURES: Array<{ actionType: string; billedUsd: number; rawUsd: number; meta: Record<string, unknown> }> = [
  { actionType: 'ai_proxy_completion', billedUsd: 0.10, rawUsd: 0.08, meta: { model: 'claude-sonnet-4-5', provider: 'anthropic', inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
  { actionType: 'chat_message', billedUsd: 0.10, rawUsd: 0.08, meta: { model: 'claude-opus-4-1', provider: 'anthropic', inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
  { actionType: 'ai_image_generation', billedUsd: 0.12, rawUsd: 0.10, meta: { model: 'gpt-image-1', imageGenerationCount: 1 } },
  { actionType: 'ai_video_generation', billedUsd: 0.30, rawUsd: 0.25, meta: { model: 'veo-3', videoGenerationCount: 1, videoSeconds: 8 } },
  { actionType: 'ai_3d_generation', billedUsd: 0.20, rawUsd: 0.18, meta: { model: 'tripo-3d', threeDGenerationCount: 1 } },
  { actionType: 'ai_music_generation', billedUsd: 0.05, rawUsd: 0.04, meta: { model: 'lyria-3', musicGenerationCount: 1 } },
  { actionType: 'ai_audio_transcription', billedUsd: 0.02, rawUsd: 0.015, meta: { model: 'whisper-1', durationSeconds: 30 } },
  { actionType: 'voice_minutes_inbound', billedUsd: 0.03, rawUsd: 0.02, meta: { durationSeconds: 120 } },
  { actionType: 'voice_minutes_outbound', billedUsd: 0.03, rawUsd: 0.02, meta: { durationSeconds: 120 } },
  { actionType: 'voice_number_setup', billedUsd: 0.01, rawUsd: 0.008, meta: { number: '+15550000001' } },
  { actionType: 'voice_number_monthly', billedUsd: 0.01, rawUsd: 0.008, meta: { number: '+15550000001' } },
  { actionType: 'ai_live_session_minutes', billedUsd: 0.02, rawUsd: 0.015, meta: { durationSeconds: 60 } },
  { actionType: 'voice_media_usage', billedUsd: 0, rawUsd: 0, meta: { unit: 'request', units: 3 } },
  // Hosting: no model, no provider — the label must still be human.
  { actionType: 'published_hosting', billedUsd: 0.40, rawUsd: 0.35, meta: { environment: 'prod', podSeconds: 3600, egressGB: 0.4, dbGB: 0.1 } },
  // Social: no model, no provider either.
  { actionType: 'social_account_monthly', billedUsd: 0.15, rawUsd: 0.12, meta: { periodStart: new Date().toISOString(), accounts: 2, inventory: 2, band: 20 } },
  { actionType: 'social_dm', billedUsd: 0.02, rawUsd: 0.015, meta: { messageId: 'msg_1', units: 1, usedThisMonth: 40 } },
  { actionType: 'social_x_api', billedUsd: 0.03, rawUsd: 0.02, meta: { targetId: 'tgt_1', withLink: false } },
  { actionType: 'social_media_lookup', billedUsd: 0.04, rawUsd: 0.03, meta: { platform: 'instagram', op: 'profile', limit: 10, units: 1 } },
  // Native release meters (SHO-323, landed on main after this registry): billed
  // and model-less, so they must read as their own charges, never as hosting.
  { actionType: 'native_build', billedUsd: 0.60, rawUsd: 0.55, meta: { easBuildId: 'eas_1', platform: 'ios', resourceClass: 'm-medium' } },
  { actionType: 'native_test_run', billedUsd: 0.25, rawUsd: 0.22, meta: { releaseId: 'rel_1', maestroRuns: 1, ciMinutes: 4 } },
  { actionType: 'native_update_mau', billedUsd: 0.05, rawUsd: 0.04, meta: { mau: 5 } },
]

/** Row types that must never reach the dashboard. */
const EXCLUDED: Array<{ actionType: string; meta: Record<string, unknown> }> = [
  { actionType: 'ai_proxy_internal', meta: { model: 'claude-sonnet-4-5', totalTokens: 10 } },
  { actionType: 'signup_credit_expired', meta: { reason: 'monthly reset' } },
  { actionType: 'signup_credit_revoked', meta: { reason: 'chargeback' } },
]

/** A chat turn that generated one image: $0.40 of tokens + $0.12 of image. */
const FOLDED_TURN = {
  actionType: 'chat_message',
  billedUsd: 0.52,
  rawUsd: 0.4,
  actionMetadata: {
    model: 'claude-opus-4-1',
    provider: 'anthropic',
    inputTokens: 120_000,
    outputTokens: 4_000,
    totalTokens: 124_000,
    tokenBilledUsd: 0.4,
    imageBilledUsd: 0.12,
    imageRawUsd: 0.1,
    imageGenerationCount: 1,
    imageModel: 'gpt-image-1',
    imageModels: ['gpt-image-1'],
  },
}

const fixtureTotal = FIXTURES.reduce((sum, f) => sum + f.billedUsd, 0)
const foldedTotal = fixtureTotal + FOLDED_TURN.billedUsd

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const user = await db.user.create({ data: { name: 'SHO-355 QA', email: `qa355-${suffix}@example.com` } })
  memberId = user.id
  const workspace = await db.workspace.create({ data: { name: 'SHO-355 QA', slug: SLUG, kind: 'team' } })
  scope = { workspaceId: workspace.id }

  const now = Date.now()
  const rows = [
    ...FIXTURES.map((fixture, index) => ({
      actionType: fixture.actionType,
      billedUsd: fixture.billedUsd,
      rawUsd: fixture.rawUsd,
      actionMetadata: fixture.meta,
      createdAt: new Date(now - (index + 2) * 60_000),
    })),
    ...EXCLUDED.map((row, index) => ({
      actionType: row.actionType,
      billedUsd: 0.5,
      rawUsd: 0.4,
      actionMetadata: row.meta,
      createdAt: new Date(now - (index + 40) * 60_000),
    })),
    { ...FOLDED_TURN, createdAt: new Date(now - 60_000) },
  ]

  await db.usageEvent.createMany({
    data: rows.map((row) => ({
      workspaceId: workspace.id,
      projectId: null,
      memberId,
      source: 'daily',
      balanceBefore: 0,
      balanceAfter: 0,
      ...row,
    })),
  })
  await db.member.create({ data: { workspaceId: workspace.id, userId: memberId, role: 'owner' } }).catch(() => {})
})

describe('SHO-355 AC1 — every billed type reaches every reader', () => {
  test('the usage log shows a row for every billed action type', async () => {
    const log = await analytics.getUsageLog(scope, PERIOD)
    const present = new Set(log.entries.map((entry: any) => entry.actionType))
    const missing = [...FIXTURES.map((f) => f.actionType), 'ai_image_generation']
      .filter((type, index, all) => all.indexOf(type) === index)
      .filter((type) => !present.has(type))
    // the folded image line is also an ai_image_generation row
    expect(missing).toEqual([])
  })

  test('the usage summary and the dashboard breakdown bill every type', async () => {
    const summary = await analytics.getUsageSummary(scope, PERIOD)
    const summaryCategories = new Set(summary.summaries.map((row: any) => row.category))
    const dashboard = await analytics.getUsageDashboard(scope, { period: PERIOD })

    for (const fixture of FIXTURES) {
      const action = dashboard.usage.byActionType[fixture.actionType]
      expect(action, `breakdown is missing ${fixture.actionType}`).toBeDefined()
      expect(action.count).toBeGreaterThanOrEqual(1)
    }
    for (const category of ['chat', 'image', 'video', '3d', 'music', 'transcription', 'voice', 'hosting', 'social', 'native']) {
      expect(summaryCategories.has(category), `summary has no ${category} row`).toBe(true)
      expect(dashboard.usage.byCategory[category], `dashboard has no ${category} bucket`).toBeDefined()
    }
    expect(dashboard.usage.totalSpendUsd).toBeCloseTo(foldedTotal, 6)
  })

  test('member insights and the spend chart include media spend', async () => {
    const insights = await analytics.getMemberInsights(scope.workspaceId, PERIOD)
    expect(insights.rows).toHaveLength(1)
    expect(insights.rows[0].spendUsd).toBeCloseTo(foldedTotal, 6)

    const spend = await analytics.getSpendTimeseries(scope, PERIOD, { groupBy: 'category' })
    expect(spend.totals.totalSpendUsd).toBeCloseTo(foldedTotal, 6)
  })
})

describe('SHO-355 AC2 — media folded into a chat turn is its own line', () => {
  test('the log splits the turn and keeps the window total', async () => {
    const log = await analytics.getUsageLog(scope, PERIOD)
    const chatLines = log.entries.filter((entry: any) => entry.actionType === 'chat_message')
    // the standalone chat row + the folded turn's token-only chat line
    expect(chatLines).toHaveLength(2)
    const foldedTurn = chatLines.find((entry: any) => entry.totalTokens === 124_000)!
    expect(foldedTurn.billedUsd).toBeCloseTo(0.4, 9)

    const mediaLine = log.entries.find((entry: any) => entry.actionType === 'ai_image_generation' && entry.model === 'gpt-image-1')
    expect(mediaLine).toBeDefined()
    expect(mediaLine!.billedUsd).toBeCloseTo(0.12, 9)
    expect(mediaLine!.category).toBe('image')
  })

  test('the summary bills the image against the image model, not Claude', async () => {
    const summary = await analytics.getUsageSummary(scope, PERIOD)
    const imageRows = summary.summaries.filter((row: any) => row.category === 'image')
    expect(imageRows.length).toBeGreaterThanOrEqual(1)
    const total = imageRows.reduce((sum: number, row: any) => sum + row.totalBilledUsd, 0)
    // 0.12 standalone + 0.12 folded out of the chat turn
    expect(total).toBeCloseTo(0.24, 6)
    for (const row of imageRows) {
      expect(row.provider).not.toBe('anthropic')
    }
  })
})

describe('SHO-355 AC3 — no known category is labelled unknown, no non-chat row is anthropic', () => {
  test('the label resolver never says unknown for a registered category', () => {
    for (const fixture of FIXTURES) {
      const label = analytics.usageLabelFor(fixture.actionType, fixture.meta)
      const category = usageCategoryFor(fixture.actionType)
      expect(label.category, `${fixture.actionType} has no category`).not.toBeNull()
      if (category !== null) {
        expect(label.model, `${fixture.actionType} is labelled unknown`).not.toBe('unknown')
        if (label.category !== 'chat') expect(label.provider).not.toBe('anthropic')
      }
    }
  })

  test('every log row carries a human model and provider', async () => {
    const log = await analytics.getUsageLog(scope, PERIOD)
    const broken = log.entries
      .filter((entry: any) => entry.category !== null)
      .filter((entry: any) => entry.model === 'unknown' || (entry.category !== 'chat' ? entry.provider === 'anthropic' : false))
      .map((entry: any) => `${entry.actionType} → ${entry.model} / ${entry.provider}`)
    expect(broken).toEqual([])
  })

  test('the summary never shows an empty or anthropic provider off chat', async () => {
    const summary = await analytics.getUsageSummary(scope, PERIOD)
    const broken = summary.summaries
      .filter((row: any) => row.category !== null && row.category !== 'chat')
      .filter((row: any) => !row.provider || row.provider === 'anthropic')
      .map((row: any) => `${row.category}:${row.model} → ${row.provider}`)
    expect(broken).toEqual([])
  })

  /**
   * The scan stores a model-less row as the literal `'unknown'`. That sentinel
   * is not a model: a reader that hands it to the shared resolver gets
   * `'unknown'` straight back (the resolver only falls back when the field is
   * *absent*), which is how the summary table kept saying "unknown" for
   * hosting/social while the log beside it said "Published hosting".
   */
  test('no summary row is labelled unknown outside chat', async () => {
    const summary = await analytics.getUsageSummary(scope, PERIOD)
    const broken = summary.summaries
      .filter((row: any) => row.category !== null && row.category !== 'chat')
      .filter((row: any) => row.model === 'unknown')
      .map((row: any) => row.category)
    expect(broken).toEqual([])
  })

  test('the model-grouped spend chart has no "unknown" series for a known category', async () => {
    // This fixture has no model-less *chat* row, so `unknown` can only come from
    // a known non-chat category — the series label must use the same resolver.
    const spend = await analytics.getSpendTimeseries(scope, PERIOD, { groupBy: 'model' })
    expect(spend.models).not.toContain('unknown')
  })
})

describe('SHO-355 AC4 — group by category is a first-class dimension', () => {
  test('the dashboard chart draws categories when asked', async () => {
    const dashboard = await analytics.getUsageDashboard(scope, { period: PERIOD, groupBy: 'category' })
    expect(dashboard.timeseries.groupBy).toBe('category')
    expect(dashboard.timeseries.models).toEqual(expect.arrayContaining(['Chat', 'Image', 'Video', 'Hosting', 'Social']))
  })

  test('the spend timeseries draws categories when asked', async () => {
    const spend = await analytics.getSpendTimeseries(scope, PERIOD, { groupBy: 'category' })
    expect(spend.groupBy).toBe('category')
    expect(spend.models).toEqual(expect.arrayContaining(['Chat', 'Image', 'Hosting', 'Social']))
  })
})

describe('SHO-355 AC6 — internal and wallet-adjustment rows never appear', () => {
  test('no reader returns a non-billed type', async () => {
    const excluded = new Set(EXCLUDED.map((row) => row.actionType))
    const log = await analytics.getUsageLog(scope, PERIOD)
    expect(log.entries.filter((entry: any) => excluded.has(entry.actionType))).toEqual([])

    const summary = await analytics.getUsageSummary(scope, PERIOD)
    expect(summary.summaries.filter((row: any) => excluded.has(row.model))).toEqual([])

    const dashboard = await analytics.getUsageDashboard(scope, { period: PERIOD })
    expect(Object.keys(dashboard.usage.byActionType).filter((type) => excluded.has(type))).toEqual([])
  })
})

/**
 * The registry is the contract, so assert it for **every** registered type
 * rather than the ones this file happens to name: a type added on main (SHO-323's
 * native meters were) must arrive with a category, a human label and a provider
 * instead of turning up as `unknown` on the dashboard.
 */
describe('SHO-355 AC1/AC3 — the registry itself is complete', () => {
  test('every billed type resolves to a category, a human label and a provider', () => {
    for (const actionType of BILLED_USAGE_ACTION_TYPE_LIST) {
      const category = usageCategoryFor(actionType)
      expect(category, actionType).not.toBeNull()

      // A model-less row of this type: what the dashboard shows when the
      // producer recorded no model (hosting, social, native meters).
      const row = analytics.usageLabelFor(actionType, {})
      expect(row.model, actionType).toBeTruthy()
      expect(row.provider, actionType).toBeTruthy()
      expect(row.provider, actionType).not.toBe('')
      if (category !== 'chat') {
        // Non-chat types never have a model in the catalog, so a model-less row
        // must fall back to its own name — never the `unknown` sentinel.
        expect(row.model, actionType).not.toBe('unknown')
        expect(row.model, actionType).not.toBe(actionType)
      }

      // A per-type name is what a model-less row shows; it must never be the raw tag.
      expect(usageActionLabel(actionType), actionType).not.toBe(actionType)
    }
  })

  test('every category has a label and a place in the legend order', () => {
    const categories = new Set(BILLED_USAGE_ACTION_TYPE_LIST.map((type) => usageCategoryFor(type)))
    for (const category of categories) {
      expect(USAGE_CATEGORY_LABELS[category!], String(category)).toBeTruthy()
      expect(USAGE_CATEGORY_ORDER, String(category)).toContain(category!)
    }
  })

  test('a native release row is its own charge, not hosting', async () => {
    const log = await analytics.getUsageLog(scope, PERIOD)
    const build = log.entries.find((entry: any) => entry.actionType === 'native_build')
    expect(build).toBeDefined()
    expect(build.model).toBe('EAS build')
    expect(build.provider).toBe('expo')

    const spend = await analytics.getSpendTimeseries(scope, PERIOD, { groupBy: 'category' })
    expect(spend.models).toContain('Native')
    // "Hosting" must stay hosting-only: an EAS build is not published hosting.
    const hosting = spend.totals.bySeries?.['Hosting']
    expect(spend.models).not.toContain('EAS build')
    if (hosting !== undefined) expect(hosting).toBeLessThan(foldedTotal)
  })
})
