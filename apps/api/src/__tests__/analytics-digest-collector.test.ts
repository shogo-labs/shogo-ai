// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const analyticsFixtures = {
  funnel: {
    signups: 3,
    onboarded: 2,
    createdProject: 2,
    sentMessage: 1,
    engaged: 1,
    avgMinToFirstProject: 4,
    avgMinToFirstMessage: 9,
  },
  activity: {
    total: 2,
    users: [
      { spendUsd: 1.25, toolCalls: 3, messages: 7, sessions: 2 },
      { spendUsd: 2.75, toolCalls: 4, messages: 5, sessions: 1 },
    ],
  },
  templates: { templates: [{ id: 'template-1', uses: 4 }] },
  sources: { sources: [{ tag: 'organic', count: 2 }] },
  conversations: {
    conversations: [{
      userName: 'Ada',
      projectName: 'Planner',
      templateId: 'tpl',
      messages: [
        { role: 'user', content: 'Build a planner' },
        { role: 'assistant', content: 'Done' },
      ],
    }],
  },
}

mock.module('../services/analytics.service', () => ({
  getUserFunnel: mock(async () => analyticsFixtures.funnel),
  getUserActivityTable: mock(async () => analyticsFixtures.activity),
  getTemplateEngagement: mock(async () => analyticsFixtures.templates),
  getSourceBreakdown: mock(async () => analyticsFixtures.sources),
  getChatConversations: mock(async () => analyticsFixtures.conversations),
}))

let chunkConversations: typeof import('../lib/analytics-digest-collector').chunkConversations
let mergeAnalyses: typeof import('../lib/analytics-digest-collector').mergeAnalyses
let generateDigest: typeof import('../lib/analytics-digest-collector').generateDigest
let startAnalyticsDigestCollector: typeof import('../lib/analytics-digest-collector').startAnalyticsDigestCollector
let stopAnalyticsDigestCollector: typeof import('../lib/analytics-digest-collector').stopAnalyticsDigestCollector

beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  globalThis.fetch = (async () => Response.json({
    content: [{
      text: JSON.stringify({
        takeaways: ['users build planners'],
        intents: [{ category: 'planning', count: 2, examples: ['planner'] }],
        painPoints: ['none'],
        securityFlags: [],
      }),
    }],
  })) as any
  const mod = await import('../lib/analytics-digest-collector')
  chunkConversations = mod.chunkConversations
  mergeAnalyses = mod.mergeAnalyses
  generateDigest = mod.generateDigest
  startAnalyticsDigestCollector = mod.startAnalyticsDigestCollector
  stopAnalyticsDigestCollector = mod.stopAnalyticsDigestCollector
})

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete (globalThis as any).fetch
  stopAnalyticsDigestCollector?.()
})

describe('analytics digest helpers', () => {
  test('chunks conversations with headers and separators', () => {
    const chunks = chunkConversations([
      {
        userName: 'Grace',
        projectName: 'CRM',
        templateId: 'crm-template',
        messages: [
          { role: 'user', content: 'Need contacts' },
          { role: 'assistant', content: 'Added contacts' },
        ],
      },
      {
        userName: '',
        projectName: 'Inventory',
        messages: [{ role: 'user', content: 'Track stock' }],
      },
    ] as any)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('[Grace / CRM (template: crm-template)]')
    expect(chunks[0]).toContain('---')
    expect(chunks[0]).toContain('[Unknown / Inventory]')
  })

  test('mergeAnalyses dedupes lists and combines matching intents', () => {
    const merged = mergeAnalyses([
      {
        takeaways: ['a', 'b', 'a'],
        intents: [{ category: 'crm', count: 1, examples: ['one', 'two'] }],
        painPoints: ['slow', 'slow'],
        securityFlags: ['secret'],
      },
      {
        takeaways: ['c'],
        intents: [{ category: 'crm', count: 2, examples: ['three', 'four'] }],
        painPoints: ['confusing'],
        securityFlags: ['secret', 'pii'],
      },
    ])

    expect(merged.takeaways).toEqual(['a', 'b', 'c'])
    expect(merged.painPoints).toEqual(['slow', 'confusing'])
    expect(merged.securityFlags).toEqual(['secret', 'pii'])
    expect(merged.intents).toEqual([
      { category: 'crm', count: 3, examples: ['one', 'two', 'three'] },
    ])
  })
})

describe('generateDigest', () => {
  test('upserts daily metrics and AI insights', async () => {
    const upsert = mock(async (args: any) => ({ id: 'digest-1', ...args.create }))
    const digest = await generateDigest({ analyticsDigest: { upsert } } as any)

    expect(digest.id).toBe('digest-1')
    expect(upsert).toHaveBeenCalledTimes(1)
    const create = upsert.mock.calls[0][0].create
    expect(create).toMatchObject({
      period: '24h',
      funnelSignups: 3,
      activeUsers: 2,
      totalSpendUsd: 4,
      totalToolCalls: 7,
      totalMessages: 12,
      totalSessions: 3,
      chunksProcessed: 1,
      messagesAnalyzed: 1,
    })
    expect(create.aiInsights.takeaways).toEqual(['users build planners'])
  })

  test('scheduler starts and can be stopped without generating immediately', () => {
    const prisma = { analyticsDigest: { upsert: mock(async () => ({})) } } as any
    startAnalyticsDigestCollector(prisma)
    stopAnalyticsDigestCollector()
    expect(prisma.analyticsDigest.upsert).not.toHaveBeenCalled()
  })
})
