// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const usageEvents: any[] = []
const metrics: any[] = []
mock.module('../services/billing-local', () => ({
  recordLocalUsage: async (params: any) => {
    usageEvents.push(params)
    return { success: true, remainingIncludedUsd: Infinity, overageChargedUsd: 0, source: 'daily' }
  },
}))
mock.module('../services/cost-analytics.service', () => ({
  recordAgentCostMetric: async (data: any) => { metrics.push(data) },
}))

const { recordLocalTurnUsage } = await import('../lib/local-turn-usage')

beforeEach(() => {
  usageEvents.length = 0
  metrics.length = 0
})

describe('recordLocalTurnUsage', () => {
  test('writes a chat_message usage event and a main-chat cost metric, never billed', async () => {
    const result = await recordLocalTurnUsage({
      workspaceId: 'ws',
      projectId: null,
      userId: 'user',
      chatSessionId: 'chat',
      usage: { model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 },
      quality: { success: true },
    })

    expect(result.billedUsd).toBe(0)
    expect(result.totalTokens).toBe(1700)
    expect(result.rawUsd).toBeGreaterThan(0)

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toEqual(expect.objectContaining({
      workspaceId: 'ws', projectId: null, memberId: 'user', actionType: 'chat_message', billedUsd: 0, rawUsd: result.rawUsd,
    }))
    expect(usageEvents[0].actionMetadata).toEqual(expect.objectContaining({
      model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, totalTokens: 1700, chatSessionId: 'chat', usageSource: 'stream-fallback',
    }))

    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toEqual(expect.objectContaining({
      workspaceId: 'ws', projectId: undefined, agentType: 'main-chat', model: 'claude-sonnet-4-6', success: true,
    }))
  })

  test('records nothing for a turn with no tokens', async () => {
    const result = await recordLocalTurnUsage({ workspaceId: 'ws', projectId: 'p', userId: 'u', usage: {} })
    expect(result).toEqual({ billedUsd: 0, rawUsd: 0, totalTokens: 0 })
    expect(usageEvents).toHaveLength(0)
    expect(metrics).toHaveLength(0)
  })
})
