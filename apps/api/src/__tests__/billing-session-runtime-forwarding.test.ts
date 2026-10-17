// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop with Shogo Cloud forwarding: the local AI proxy relays every call
 * to cloud and records nothing, so a chat turn reaches the local workspace's
 * analytics only through its stream-reported usage. Without forwarding the
 * local AI proxy records each call itself, so the seam must stay silent to
 * avoid double counting.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const previousEnv = {
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
  SHOGO_API_KEY: process.env.SHOGO_API_KEY,
  AI_MODE: process.env.AI_MODE,
}
process.env.SHOGO_LOCAL_MODE = 'true'

const recorded: any[] = []
mock.module('../lib/local-turn-usage', () => ({
  recordLocalTurnUsage: async (turn: any) => {
    recorded.push(turn)
    return { billedUsd: 0, rawUsd: 0.01, totalTokens: 30 }
  },
}))

const session = await import('../lib/proxy-billing-session-runtime')

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const usage = { model: 'claude-sonnet-4-6', inputTokens: 10, outputTokens: 20 }

beforeEach(() => {
  recorded.length = 0
  process.env.SHOGO_API_KEY = 'shogo_sk_test'
  delete process.env.AI_MODE
})

describe('local billing seam with cloud forwarding', () => {
  test('a project turn records its stream usage with the opener and quality signals', async () => {
    await session.openSession('proj', 'ws', 'user', 'chat')
    await session.setQualitySignals('proj', { success: true, loopDetected: true }, 'chat')
    const result = await session.closeSession('proj', { chatSessionId: 'chat', fallbackUsage: usage })

    expect(result.totalTokens).toBe(30)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual(expect.objectContaining({
      workspaceId: 'ws',
      projectId: 'proj',
      userId: 'user',
      chatSessionId: 'chat',
      usage,
      quality: { success: true, loopDetected: true },
    }))
  })

  test('a turn with no project records against its workspace', async () => {
    await session.recordTurnUsage({ workspaceId: 'ws', userId: 'user', chatSessionId: 'chat', usage })
    expect(recorded).toEqual([expect.objectContaining({ workspaceId: 'ws', projectId: null, userId: 'user' })])
  })

  test('discarded partials, bookkeeping closes, and unopened sessions record nothing', async () => {
    await session.openSession('proj', 'ws', 'user', 'a')
    await session.closeSession('proj', { chatSessionId: 'a', fallbackUsage: usage, discardPartial: true })
    await session.openSession('proj', 'ws', 'user', 'b')
    await session.closeSession('proj', { chatSessionId: 'b', fallbackUsage: usage, bookkeeping: true })
    await session.closeSession('proj', { chatSessionId: 'never-opened', fallbackUsage: usage })
    expect(recorded).toHaveLength(0)
  })

  test('without forwarding the local AI proxy records per call, so the seam stays silent', async () => {
    for (const setup of [() => delete process.env.SHOGO_API_KEY, () => { process.env.AI_MODE = 'api-keys' }]) {
      setup()
      await session.openSession('proj', 'ws', 'user', 'chat')
      expect(await session.closeSession('proj', { chatSessionId: 'chat', fallbackUsage: usage })).toEqual({ billedUsd: 0, rawUsd: 0, totalTokens: 0 })
      await session.recordTurnUsage({ workspaceId: 'ws', userId: 'user', usage })
    }
    expect(recorded).toHaveLength(0)
  })
})
