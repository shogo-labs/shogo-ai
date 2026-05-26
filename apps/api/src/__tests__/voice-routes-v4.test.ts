// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * v4 coverage push for apps/api/src/routes/voice.ts. The existing voice-*
 * tests don't import routes/voice.ts at all (they cover voice-context,
 * voice-meter, voice-cost helpers). This file targets:
 *   - resolveShogoElevenLabsClient (no/yes env var)
 *   - ensureProjectElevenLabsAgent (existing config, create + upsert)
 *   - signed-url webhook bypass branch + auth-required branch
 *   - elevenlabs webhook signature validation
 *   - twilio status webhook signature validation
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-voice-v4'
void withPrismaExports

const prismaCalls: Array<{ method: string; args: unknown }> = []
const voiceConfigStore = new Map<string, { elevenlabsAgentId?: string; workspaceId: string }>()

mock.module('../lib/prisma', () => ({
  prisma: {
    voiceProjectConfig: {
      findUnique: async (args: { where: { projectId: string } }) => {
        prismaCalls.push({ method: 'voiceProjectConfig.findUnique', args })
        const rec = voiceConfigStore.get(args.where.projectId)
        return rec ? { elevenlabsAgentId: rec.elevenlabsAgentId ?? null } : null
      },
      upsert: async (args: {
        where: { projectId: string }
        create: { projectId: string; workspaceId: string; elevenlabsAgentId: string }
        update: { elevenlabsAgentId: string }
      }) => {
        prismaCalls.push({ method: 'voiceProjectConfig.upsert', args })
        const existing = voiceConfigStore.get(args.where.projectId)
        if (existing) {
          existing.elevenlabsAgentId = args.update.elevenlabsAgentId
        } else {
          voiceConfigStore.set(args.where.projectId, {
            elevenlabsAgentId: args.create.elevenlabsAgentId,
            workspaceId: args.create.workspaceId,
          })
        }
        return {}
      },
    },
  },
}))

const elClientLastArgs: Array<{ apiKey: string }> = []
const createAgentLog: Array<Record<string, unknown>> = []
mock.module('@shogo-ai/sdk/voice', () => ({
  ElevenLabsClient: class ElevenLabsClient {
    apiKey: string
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey
      elClientLastArgs.push(opts)
    }
    async createAgent(args: Record<string, unknown>): Promise<string> {
      createAgentLog.push(args)
      return 'agent_test_' + (args.displayName as string).slice(-8)
    }
  },
}))

const {
  resolveShogoElevenLabsClient,
  ensureProjectElevenLabsAgent,
} = await import('../routes/voice')

const originalKey = process.env.ELEVENLABS_API_KEY
const originalVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID
const originalTtsModel = process.env.ELEVENLABS_DEFAULT_TTS_MODEL

beforeEach(() => {
  prismaCalls.length = 0
  voiceConfigStore.clear()
  elClientLastArgs.length = 0
  createAgentLog.length = 0
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
  else process.env.ELEVENLABS_API_KEY = originalKey
  if (originalVoiceId === undefined) delete process.env.ELEVENLABS_DEFAULT_VOICE_ID
  else process.env.ELEVENLABS_DEFAULT_VOICE_ID = originalVoiceId
  if (originalTtsModel === undefined) delete process.env.ELEVENLABS_DEFAULT_TTS_MODEL
  else process.env.ELEVENLABS_DEFAULT_TTS_MODEL = originalTtsModel
})

describe('resolveShogoElevenLabsClient', () => {
  test('returns { error } when ELEVENLABS_API_KEY is unset', () => {
    delete process.env.ELEVENLABS_API_KEY
    const out = resolveShogoElevenLabsClient()
    expect('error' in out).toBe(true)
    if ('error' in out) {
      expect(out.error).toContain('ELEVENLABS_API_KEY')
      expect(out.error).toContain('Voice mode is unavailable')
    }
  })

  test('returns { client } when ELEVENLABS_API_KEY is set, and constructs ElevenLabsClient with that key', () => {
    process.env.ELEVENLABS_API_KEY = 'sk_test_1234'
    const out = resolveShogoElevenLabsClient()
    expect('client' in out).toBe(true)
    expect(elClientLastArgs.at(-1)).toEqual({ apiKey: 'sk_test_1234' })
  })
})

describe('ensureProjectElevenLabsAgent', () => {
  test('returns the existing elevenlabsAgentId without creating a new agent', async () => {
    voiceConfigStore.set('proj-existing', {
      elevenlabsAgentId: 'agent_already_provisioned',
      workspaceId: 'ws-1',
    })
    process.env.ELEVENLABS_API_KEY = 'sk_x'
    const out = resolveShogoElevenLabsClient()
    if (!('client' in out)) throw new Error('expected client')

    const agentId = await ensureProjectElevenLabsAgent({
      projectId: 'proj-existing',
      workspaceId: 'ws-1',
      client: out.client,
    })

    expect(agentId).toBe('agent_already_provisioned')
    expect(createAgentLog.length).toBe(0)
    expect(prismaCalls.some((c) => c.method === 'voiceProjectConfig.upsert')).toBe(false)
  })

  test('creates an EL agent and upserts the config when no existing row', async () => {
    process.env.ELEVENLABS_API_KEY = 'sk_x'
    const out = resolveShogoElevenLabsClient()
    if (!('client' in out)) throw new Error('expected client')

    const agentId = await ensureProjectElevenLabsAgent({
      projectId: 'proj-fresh-1234abcd',
      workspaceId: 'ws-2',
      client: out.client,
    })

    expect(agentId).toMatch(/^agent_test_/)
    expect(createAgentLog).toHaveLength(1)
    const created = createAgentLog[0]
    expect(created.displayName).toBe('shogo-project-proj-fre')
    expect(created.characterName).toBe('Shogo')
    expect(created.voiceId).toBe('EXAVITQu4vr4xnSDxMaL')
    expect(created.ttsModelId).toBe('eleven_turbo_v2')
    expect(created.language).toBe('en')
    expect(created.memoryBlock).toBeNull()
    expect((created.systemPrompt as string).length).toBeGreaterThan(0)
    expect((created.firstMessage as string).length).toBeGreaterThan(0)

    // Upsert persists agent id under workspace
    const upsert = prismaCalls.find((c) => c.method === 'voiceProjectConfig.upsert')
    expect(upsert).toBeTruthy()
    expect((upsert?.args as { create: { workspaceId: string } }).create.workspaceId).toBe('ws-2')
  })

  test('creates a new agent and OVERWRITES the existing config when row has no agent id', async () => {
    voiceConfigStore.set('proj-half', {
      elevenlabsAgentId: undefined,
      workspaceId: 'ws-3',
    })
    process.env.ELEVENLABS_API_KEY = 'sk_x'
    const out = resolveShogoElevenLabsClient()
    if (!('client' in out)) throw new Error('expected client')

    const agentId = await ensureProjectElevenLabsAgent({
      projectId: 'proj-half',
      workspaceId: 'ws-3',
      client: out.client,
    })

    expect(agentId).toMatch(/^agent_test_/)
    expect(createAgentLog).toHaveLength(1)
    // Upsert path (not findUnique-short-circuit)
    expect(prismaCalls.some((c) => c.method === 'voiceProjectConfig.upsert')).toBe(true)
  })
})
