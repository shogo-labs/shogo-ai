import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetState, state } from './test-state'

mock.module('../../prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => state.workspace,
    },
    proxyTurn: {
      upsert: async (args: any) => {
        state.upserts.push(args)
        return args.create
      },
      updateMany: async (args: any) => {
        state.updates.push(args)
        return { count: 1 }
      },
    },
  },
}))

mock.module('../../../services/billing.service', () => ({
  getEffectivePlanId: async () => state.plan,
}))

const { clearConsentCache, shouldCapture } = await import('../consent')

const token = {
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  userId: 'user-1',
  type: 'ai-proxy',
  authKind: 'runtime',
  iat: 1,
  exp: 2,
} as any

beforeEach(() => {
  process.env.PROXY_CAPTURE_ENABLED = 'true'
  process.env.SHOGO_LOCAL_MODE = 'false'
  resetState()
  clearConsentCache()
})

describe('proxy capture consent', () => {
  test('enables the default mode for non-enterprise workspaces', async () => {
    expect(await shouldCapture(token)).toBe(true)
  })

  test('disables the default mode for enterprise workspaces', async () => {
    state.plan = 'enterprise'
    expect(await shouldCapture(token)).toBe(false)
  })

  test('honors explicit workspace choices and caches them briefly', async () => {
    state.workspace = { trainingDataMode: 'disabled' }
    expect(await shouldCapture(token)).toBe(false)
    state.workspace = { trainingDataMode: 'enabled' }
    expect(await shouldCapture(token)).toBe(false)
    clearConsentCache('workspace-1')
    expect(await shouldCapture(token)).toBe(true)
  })
})
