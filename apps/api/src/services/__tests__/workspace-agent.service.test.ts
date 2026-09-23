// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  events: Record<string, { id: string; goalId: string; kind: string; metadata: unknown }>
  updateCalls: any[]
  scheduleUpdates: any[]
}

const s: State = {
  events: {},
  updateCalls: [],
  scheduleUpdates: [],
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    goalEvent: {
      findFirst: async (args: any) => {
        const event = s.events[args.where.id]
        if (!event) return null
        if (event.goalId !== args.where.goalId) return null
        return event
      },
      update: async (args: any) => {
        s.updateCalls.push(args)
        const event = s.events[args.where.id]
        return { ...event, metadata: args.data.metadata }
      },
    },
    goal: {
      findFirst: async (args: any) => (args.where.id === 'goal-1' ? { id: 'goal-1' } : null),
      update: async (args: any) => ({ id: args.where.id, ...args.data }),
    },
    agentSchedule: {
      updateMany: async (args: any) => {
        s.scheduleUpdates.push(args)
        return { count: 1 }
      },
    },
  },
}))

const { resolveGoalEventApproval, isApprovalPending, saveAgentAvatar, updateGoal } = await import('../workspace-agent.service')

beforeEach(() => {
  s.events = {
    'event-approval': { id: 'event-approval', goalId: 'goal-1', kind: 'approval', metadata: null },
    'event-progress': { id: 'event-progress', goalId: 'goal-1', kind: 'progress', metadata: null },
    'event-with-metadata': {
      id: 'event-with-metadata',
      goalId: 'goal-1',
      kind: 'approval',
      metadata: { note: 'from the agent' },
    },
  }
  s.updateCalls = []
  s.scheduleUpdates = []
})

describe('updateGoal', () => {
  it('disables the goal\'s enabled schedules when the goal is marked done', async () => {
    await updateGoal('workspace-1', 'goal-1', { status: 'done' })
    expect(s.scheduleUpdates).toEqual([
      expect.objectContaining({
        where: { goalId: 'goal-1', enabled: true },
        data: expect.objectContaining({ enabled: false }),
      }),
    ])
  })

  it('leaves schedules alone for other status changes', async () => {
    await updateGoal('workspace-1', 'goal-1', { status: 'paused' })
    expect(s.scheduleUpdates).toEqual([])
  })
})

describe('resolveGoalEventApproval', () => {
  it('stamps decision + resolvedAt on an approval event', async () => {
    const result = await resolveGoalEventApproval('workspace-1', 'goal-1', 'event-approval', 'approved')
    expect(result).not.toBeNull()
    expect(result?.metadata).toMatchObject({ decision: 'approved' })
    expect(typeof (result?.metadata as any).resolvedAt).toBe('string')
  })

  it('preserves existing metadata fields when stamping the decision', async () => {
    const result = await resolveGoalEventApproval('workspace-1', 'goal-1', 'event-with-metadata', 'declined')
    expect(result?.metadata).toMatchObject({ note: 'from the agent', decision: 'declined' })
  })

  it('returns null for a non-approval event (nothing to approve)', async () => {
    const result = await resolveGoalEventApproval('workspace-1', 'goal-1', 'event-progress', 'approved')
    expect(result).toBeNull()
    expect(s.updateCalls).toHaveLength(0)
  })

  it('returns null when the event does not exist or belongs to a different goal', async () => {
    expect(await resolveGoalEventApproval('workspace-1', 'goal-1', 'does-not-exist', 'approved')).toBeNull()
    expect(await resolveGoalEventApproval('workspace-1', 'goal-2', 'event-approval', 'approved')).toBeNull()
  })
})

describe('saveAgentAvatar', () => {
  it('returns a local data URL without loading cloud artifact storage', async () => {
    const url = await saveAgentAvatar('workspace-1', Buffer.from([1, 2, 3]))
    expect(url).toBe('data:image/png;base64,AQID')
  })

  it('returns a base64 data URL for arbitrary image bytes', async () => {
    const url = await saveAgentAvatar('workspace-1', Buffer.from('hi'))
    expect(url).toBe(`data:image/png;base64,${Buffer.from('hi').toString('base64')}`)
  })
})

describe('isApprovalPending', () => {
  it('is true for an approval event with no resolvedAt', () => {
    expect(isApprovalPending({ kind: 'approval', metadata: null })).toBe(true)
    expect(isApprovalPending({ kind: 'approval', metadata: { note: 'hi' } })).toBe(true)
  })

  it('is false once metadata.resolvedAt is stamped', () => {
    expect(isApprovalPending({ kind: 'approval', metadata: { resolvedAt: '2026-01-01T00:00:00.000Z' } })).toBe(false)
  })

  it('is false for non-approval event kinds regardless of metadata', () => {
    expect(isApprovalPending({ kind: 'progress', metadata: null })).toBe(false)
    expect(isApprovalPending({ kind: 'note', metadata: {} })).toBe(false)
  })
})
