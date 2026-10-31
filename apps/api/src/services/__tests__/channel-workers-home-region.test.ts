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
  /** Workspace ids the cloud holds as a machine copy (`machineInstanceId` set). */
  machineWorkspaces: [] as string[],
  calls: [] as Array<{ model: string; op: string; args: any }>,
  reminderWorkspaces: ['ws-home', 'ws-peer'],
  digestWorkspaces: ['ws-home', 'ws-peer'],
  digestRows: [
    { id: 'settings-1', workspaceId: 'ws-home', userId: 'user-1', emailDigest: 'daily', timezone: 'UTC', lastDigestAt: null },
  ] as any[],
  digestClaimCount: 1,
}

function record(model: string, op: string, args: any) {
  state.calls.push({ model, op, args })
}
const calls = (model: string, op: string) => state.calls.filter((c) => c.model === model && c.op === op)

/**
 * The slice of Prisma `where` these workers build, enough to answer the only
 * question the copy guard is about: would this query return that row?
 *
 * The workers exclude a machine copy either by `workspaceId: { notIn: … }` or by
 * narrowing to `{ in: […home ids minus the copies…] }`, so both are read here.
 */
function wouldReturn(where: any, row: { workspaceId: string }): boolean {
  const scope = where?.workspaceId
  if (scope?.notIn && scope.notIn.includes(row.workspaceId)) return false
  if (scope?.in && !scope.in.includes(row.workspaceId)) return false
  return true
}

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
      return state.digestRows
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
    // Both the shared `machineWorkspaceIds()` and the digest's own scan ask for
    // the copies; the real query filters on `machineInstanceId: { not: null }`,
    // so answering with the paired set is what the client would return.
    findMany: async (args: any) => {
      record('workspace', 'findMany', args)
      return state.machineWorkspaces.map((id) => ({ id }))
    },
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))
// `mock.module` replaces the whole module, so override on top of the real
// exports. Without the spread, any transitively-imported module that needs
// another region export (billing.service reads `getPeer`) dies with
// "Export named 'getPeer' not found" — which is what a partial mock here did
// to the required check once `project-lifecycle.service.ts` reached
// `model-access` → `billing.service` (SHO-264).
const realRegion = await import('../../lib/region')
mock.module('../../lib/region', () => ({
  ...realRegion,
  homeRegionWorkspaceWhere: () => state.home,
  homeWorkspaceIds: async (ids: string[]) =>
    state.home ? new Set(ids.filter((id) => state.homeIds.has(id))) : null,
}))
mock.module('../../lib/push-notifications', () => ({ sendPushToUser: async () => ({}) }))

const { sendDueScheduledMessages, fireDueReminders } = await import('../chat-items')
const { runDigestPass, _setDigestSenderForTests } = await import('../chat-digest')
const { indexPendingMessages, _setEmbeddingProviderForTests } = await import('../conversation-semantic')
const { settleOrphanedAgentReplies, sweepDeadAgentReplies } = await import('../conversation-agent-dispatcher')
const { invalidateMachineWorkspaceIds } = await import('../../lib/machine-workspace')

beforeEach(() => {
  invalidateMachineWorkspaceIds()
  state.calls = []
  state.home = HOME
  state.homeIds = new Set(['ws-home'])
  state.machineWorkspaces = []
  state.digestRows = [
    { id: 'settings-1', workspaceId: 'ws-home', userId: 'user-1', emailDigest: 'daily', timezone: 'UTC', lastDigestAt: null },
  ]
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

  it('never picks up a queued message whose workspace is a machine copy', async () => {
    state.machineWorkspaces = ['ws-machine']
    await sendDueScheduledMessages()
    const { where } = calls('scheduledMessage', 'findMany')[0].args
    expect(wouldReturn(where, { workspaceId: 'ws-machine' })).toBe(false)
    expect(wouldReturn(where, { workspaceId: 'ws-cloud' })).toBe(true)
    // …and the copy guard does not replace the region narrowing it merges with.
    expect(where.conversation).toEqual({ workspace: HOME })
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

  it('leaves a machine copy out of both narrowings', async () => {
    state.machineWorkspaces = ['ws-machine']
    // The copy's workspace is homed here too, so the region pass alone would
    // keep it: the machine filter has to remove it a second time.
    state.homeIds = new Set(['ws-home', 'ws-machine'])
    state.reminderWorkspaces = ['ws-home', 'ws-machine', 'ws-peer']
    await fireDueReminders()
    const [candidates, due] = calls('chatReminder', 'findMany')
    expect(wouldReturn(candidates.args.where, { workspaceId: 'ws-machine' })).toBe(false)
    expect(wouldReturn(candidates.args.where, { workspaceId: 'ws-home' })).toBe(true)
    expect(due.args.where.workspaceId).toEqual({ in: ['ws-home'] })
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

  it('links through the /c/settings redirect, not a bare /settings URL', async () => {
    const sent: Array<{ settingsUrl?: string }> = []
    _setDigestSenderForTests((async (params: { settingsUrl: string }) => {
      sent.push(params)
      return { success: true }
    }) as any)
    await runDigestPass(new Date('2026-10-05T09:00:00Z'))
    expect(sent).toHaveLength(1)
    // `/settings?tab=chat` is the admin console on web (it bounces to
    // /projects); `/c/settings` redirects to the same tab from anywhere.
    expect(sent[0].settingsUrl).toEndWith('/c/settings')
  })

  it('applies no region filter in single-region mode', async () => {
    state.home = null
    await runDigestPass(new Date('2026-10-05T09:00:00Z'))
    const finds = calls('chatUserSettings', 'findMany')
    expect(finds).toHaveLength(1)
    expect(finds[0].args.where.workspaceId).toBeUndefined()
  })

  it('emails the plain workspace and skips the one that is a machine copy', async () => {
    // Single-region, so the copy filter is the only thing narrowing the pass.
    state.home = null
    state.machineWorkspaces = ['ws-machine']
    const row = { emailDigest: 'daily', userId: 'user-1', timezone: 'UTC', lastDigestAt: null }
    state.digestRows = [
      { ...row, id: 'settings-machine', workspaceId: 'ws-machine' },
      { ...row, id: 'settings-cloud', workspaceId: 'ws-cloud' },
    ]
    expect(await runDigestPass(new Date('2026-10-05T09:00:00Z'))).toBe(1)
    const claims = calls('chatUserSettings', 'updateMany')
    expect(claims).toHaveLength(1)
    expect(claims[0].args.where.id).toBe('settings-cloud')
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

  it('does not settle a reply that is running on a machine, nor a card run it owns', async () => {
    state.machineWorkspaces = ['ws-machine']
    await settleOrphanedAgentReplies()
    const restart = calls('conversationMessage', 'findMany')[0].args.where
    expect(wouldReturn(restart, { workspaceId: 'ws-machine' })).toBe(false)
    expect(wouldReturn(restart, { workspaceId: 'ws-home' })).toBe(true)
    expect(restart.conversation).toEqual({ workspace: HOME })

    await sweepDeadAgentReplies()
    const deadRun = calls('conversationMessage', 'findMany')[1].args.where
    expect(wouldReturn(deadRun, { workspaceId: 'ws-machine' })).toBe(false)
    expect(wouldReturn(deadRun, { workspaceId: 'ws-home' })).toBe(true)
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

  it('does not index messages the desktop owns', async () => {
    state.machineWorkspaces = ['ws-machine']
    await indexPendingMessages()
    const { where } = calls('conversationMessage', 'findMany')[0].args
    expect(wouldReturn(where, { workspaceId: 'ws-machine' })).toBe(false)
    expect(wouldReturn(where, { workspaceId: 'ws-home' })).toBe(true)
    expect(where.conversation).toEqual({ workspace: HOME })
  })
})
