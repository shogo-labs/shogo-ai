import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetState, state } from './test-state'

mock.module('../../prisma', () => ({
  prisma: {
    proxyTurn: {
      updateMany: async (args: any) => {
        state.updates.push(args)
        return { count: 1 }
      },
    },
    workspace: { findUnique: async () => state.workspace },
  },
}))

mock.module('../../../services/billing.service', () => ({
  getEffectivePlanId: async () => state.plan,
}))

class PutObjectCommand {
  constructor(public input: any) {}
}

mock.module('@aws-sdk/client-s3', () => ({ PutObjectCommand }))
mock.module('../../s3', () => ({
  getLlmCaptureBucket: () => 'capture-bucket',
  getS3Client: () => ({
    send: async (command: any) => {
      if (state.fail) throw new Error('bucket unavailable')
      state.sends.push(command)
      return {}
    },
  }),
}))

const { markProjectTurnsReverted, updateTurnFeedback } = await import('../index')

beforeEach(resetState)

describe('proxy turn outcome signals', () => {
  test('writes thumbs feedback to nearby proxy turns', async () => {
    const messageAt = new Date('2026-09-26T05:00:00.000Z')
    await updateTurnFeedback('session-1', messageAt, 'up')
    expect(state.updates[0]).toMatchObject({
      where: { chatSessionId: 'session-1', lastAt: { gte: expect.any(Date), lte: expect.any(Date) } },
      data: { feedback: 'up' },
    })
  })

  test('marks turns after a rollback point as reverted', async () => {
    const since = new Date('2026-09-26T05:00:00.000Z')
    await markProjectTurnsReverted('project-1', since)
    expect(state.updates[0]).toMatchObject({
      where: { projectId: 'project-1', lastAt: { gt: since } },
      data: { revertedAt: expect.any(Date) },
    })
  })
})
