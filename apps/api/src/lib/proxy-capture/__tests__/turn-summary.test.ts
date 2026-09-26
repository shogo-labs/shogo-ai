import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
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

const { beginCapture } = await import('../index')
const { clearConsentCache } = await import('../consent')
const { flushArchive } = await import('../archive-writer')

const token = {
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  userId: 'user-1',
  authKind: 'runtime',
} as any

beforeEach(() => {
  process.env.PROXY_CAPTURE_ENABLED = 'true'
  process.env.SHOGO_LOCAL_MODE = 'false'
  resetState()
  clearConsentCache()
})

afterEach(async () => {
  await flushArchive()
})

describe('proxy turn summaries', () => {
  test('upserts compact usage and text summaries without blocking the response', async () => {
    const capture = await beginCapture({
      tokenPayload: token,
      endpoint: 'chat.completions',
      requestBody: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'How do I deploy this?' }],
      },
      requestedModel: 'gpt-5',
      resolvedModel: 'gpt-5',
      provider: 'openai',
      chatSessionId: 'session-1',
    })

    expect(capture).not.toBeNull()
    capture!.recordResponse({
      status: 200,
      body: {
        choices: [{ message: { role: 'assistant', content: 'Use the deploy command.' } }],
      },
      usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 2 },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.upserts).toHaveLength(1)
    expect(state.upserts[0].create).toMatchObject({
      workspaceId: 'workspace-1',
      chatSessionId: 'session-1',
      userText: 'How do I deploy this?',
      assistantText: 'Use the deploy command.',
      inputTokens: 12,
      outputTokens: 8,
      reasoningTokens: 2,
    })
  })
})
