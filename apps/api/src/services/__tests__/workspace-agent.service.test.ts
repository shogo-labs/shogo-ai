// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface State {
  events: Record<string, { id: string; goalId: string; kind: string; metadata: unknown }>
  updateCalls: any[]
}

const s: State = {
  events: {},
  updateCalls: [],
}

interface S3State {
  putCalls: any[]
  failSend: boolean
}

const s3State: S3State = { putCalls: [], failSend: false }

mock.module('../../lib/s3', () => ({
  getArtifactS3Client: () => ({
    send: async (command: any) => {
      if (s3State.failSend) throw new Error('s3 unavailable')
      s3State.putCalls.push(command.input)
      return {}
    },
  }),
  getArtifactBucket: () => 'artifacts-bucket',
  buildArtifactKey: (...parts: string[]) => `artifacts/${parts.join('/')}`,
  getArtifactPresignedReadUrl: async (key: string) => `https://artifacts.example.com/${key}`,
}))

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
  },
}))

const { resolveGoalEventApproval, isApprovalPending, saveAgentAvatar } = await import('../workspace-agent.service')

beforeEach(() => {
  s3State.putCalls = []
  s3State.failSend = false
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
  it('uploads to artifact S3 keyed by workspace id and returns a presigned URL', async () => {
    const url = await saveAgentAvatar('workspace-1', Buffer.from([1, 2, 3]))
    expect(url).toBe('https://artifacts.example.com/artifacts/avatars/workspace-1.png')
    expect(s3State.putCalls).toHaveLength(1)
    expect(s3State.putCalls[0]).toMatchObject({
      Bucket: 'artifacts-bucket',
      Key: 'artifacts/avatars/workspace-1.png',
      ContentType: 'image/png',
    })
  })

  it('falls back to a base64 data URL when S3 is unreachable', async () => {
    s3State.failSend = true
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
