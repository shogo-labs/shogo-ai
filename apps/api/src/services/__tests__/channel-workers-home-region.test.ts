// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel background workers are home-region partitioned: in multi-region mode
 * each worker only touches workspaces homed in this region, and in
 * single-region / local mode it applies no filter at all.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const HOME = { OR: [{ homeRegion: 'us-ashburn-1' }, { homeRegion: null }] }

const state = {
  home: HOME as any,
  homeIds: new Set<string>(['ws-home']),
  calls: [] as Array<{ model: string; op: string; args: any }>,
  reminderWorkspaces: ['ws-home', 'ws-peer'],
  digestWorkspaces: ['ws-home', 'ws-peer'],
  digestClaimCount: 1,
}

function record(model: string, op: string, args: any) {
  state.calls.push({ model, op, args })
}
const calls = (model: string, op: string) => state.calls.filter((c) => c.model === model && c.op === op)

const mockPrisma = {
  scheduledMessage: {
    findMany: async (args: any) => (record('scheduledMessage', 'findMany', args), []),
  },
  chatReminder: {
    findMany: async (args: any) => {
      record('chatReminder', 'findMany', args)
      if (args.distinct) return state.reminderWorkspaces.map((workspaceId) => ({ workspaceId }))
      return []
    },
  },
  chatUserSettings: {
    findMany: async (args: any) => {
      record('chatUserSettings', 'findMany', args)
      if (args.distinct) return state.digestWorkspaces.map((workspaceId) => ({ workspaceId }))
      return [{ id: 'settings-1', workspaceId: 'ws-home', userId: 'user-1', emailDigest: 'daily', timezone: 'UTC', lastDigestAt: null }]
    },
    updateMany: async (args: any) => {
      record('chatUserSettings', 'updateMany', args)
      return { count: state.digestClaimCount }
    },
  },
  conversationMessage: {
    findMany: async (args: any) => (record('conversationMessage', 'findMany', args), []),
  },
  chatInboxItem: {
    findMany: async () => [{ title: 'Mention', preview: 'hello' }],
  },
  conversationMember: {
    findMany: async () => [],
  },
  user: {
    findUnique: async () => ({ email: 'user@example.com' }),
  },
  workspace: {
    findUnique: async () => ({ kind: 'team', chatMode: null, chatProvider: null, name: 'Team' }),
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../../lib/region', () => ({
  homeRegionWorkspaceWhere: () => state.home,
  homeWorkspaceIds: async (ids: string[]) =>
    state.home ? new Set(ids.filter((id) => state.homeIds.has(id))) : null,
}))
mock.module('../../lib/push-notifications', () => ({ sendPushToUser: async () => ({}) }))

const { sendDueScheduledMessages, fireDueReminders } = await import('../chat-items')
const { runDigestPass, _setDigestSenderForTests } = await import('../chat-digest')
const { indexPendingMessages, _setEmbeddingProviderForTests } = await import('../conversation-semantic')
const { settleOrphanedAgentReplies } = await import('../conversation-agent-dispatcher')

beforeEach(() => {
  state.calls = []
  state.home = HOME
  state.homeIds = new Set(['ws-home'])
  state.digestClaimCount = 1
})

describe('scheduled messages', () => {
  it('only selects conversations whose workspace is homed here in multi-region mode', async () => {
    await sendDueScheduledMessages()
    expect(calls('scheduledMessage', 'findMany')[0].args.where.conversation).toEqual({ workspace: HOME })
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await sendDueScheduledMessages()
    expect(calls('scheduledMessage', 'findMany')[0].args.where.conversation).toBeUndefined()
  })
})

describe('reminders', () => {
  it('restricts due reminders to home workspaces in multi-region mode', async () => {
    await fireDueReminders()
    const [candidates, due] = calls('chatReminder', 'findMany')
    expect(candidates.args.distinct).toEqual(['workspaceId'])
    expect(due.args.where.workspaceId).toEqual({ in: ['ws-home'] })
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await fireDueReminders()
    const finds = calls('chatReminder', 'findMany')
    expect(finds).toHaveLength(1)
    expect(finds[0].args.where.workspaceId).toBeUndefined()
  })
})

describe('email digest', () => {
  beforeEach(() => _setDigestSenderForTests(async () => ({ success: true }) as any))

  it('loads settings only for home workspaces in multi-region mode', async () => {
    await runDigestPass(new Date('2026-10-05T09:00:00Z'))
    const finds = calls('chatUserSettings', 'findMany')
    expect(finds[0].args.distinct).toEqual(['workspaceId'])
    expect(finds[1].args.where.workspaceId).toEqual({ in: ['ws-home'] })
  })

  it('claims the row with a conditional update so a second pod does not repeat it', async () => {
    await runDigestPass(new Date('2026-10-05T09:00:00Z'))
    const claim = calls('chatUserSettings', 'updateMany')[0]
    expect(claim.args.where).toEqual({ id: 'settings-1', lastDigestAt: null })
  })

  it('sends nothing when another pod already claimed the row', async () => {
    state.digestClaimCount = 0
    expect(await runDigestPass(new Date('2026-10-05T09:00:00Z'))).toBe(0)
  })

  it('sends once when the claim succeeds', async () => {
    expect(await runDigestPass(new Date('2026-10-05T09:00:00Z'))).toBe(1)
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await runDigestPass(new Date('2026-10-05T09:00:00Z'))
    const finds = calls('chatUserSettings', 'findMany')
    expect(finds).toHaveLength(1)
    expect(finds[0].args.where.workspaceId).toBeUndefined()
  })
})

describe('interrupted agent replies', () => {
  it('only settles replies in home workspaces in multi-region mode', async () => {
    await settleOrphanedAgentReplies()
    expect(calls('conversationMessage', 'findMany')[0].args.where.conversation).toEqual({ workspace: HOME })
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await settleOrphanedAgentReplies()
    expect(calls('conversationMessage', 'findMany')[0].args.where.conversation).toBeUndefined()
  })
})

describe('search indexer', () => {
  beforeEach(() => _setEmbeddingProviderForTests({ model: 'test', embed: async () => [] }))

  it('only indexes messages in home workspaces in multi-region mode', async () => {
    await indexPendingMessages()
    expect(calls('conversationMessage', 'findMany')[0].args.where.conversation).toEqual({ workspace: HOME })
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await indexPendingMessages()
    expect(calls('conversationMessage', 'findMany')[0].args.where.conversation).toBeUndefined()
  })
})
