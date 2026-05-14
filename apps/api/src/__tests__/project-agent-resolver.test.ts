// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `services/projectAgent.service` — the resolver
 * shared by both the voice signed-URL handler and the chat turn
 * handler.
 *
 * Exercises:
 *   1. `resolveProjectAgent` returns the row when present.
 *   2. `resolveProjectAgent` defaults to `default` when no name is
 *      passed.
 *   3. `resolveVoiceAgentForSignedUrl` falls back to the legacy
 *      `voice_project_configs.elevenlabsAgentId` column when the
 *      named agent is `default` and no row exists.
 *   4. Chat-only agents (no `voiceId`, no `elevenlabsAgentId`)
 *      return `null` from the voice resolver — voice routes 404.
 *   5. `toolsAllowlist` is normalized whether stored as a JSON array
 *      (Postgres) or JSON-encoded string (SQLite).
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const findUniqueMock = mock(async (_args: any) => null as any)
const findManyMock = mock(async (_args: any) => [] as any[])
const updateMock = mock(async (_args: any) => null as any)
const ensureLegacyMock = mock(
  async (_args: any) => 'agent_legacy' as string,
)

mock.module('../lib/prisma', () => ({
  prisma: {
    projectAgent: {
      findUnique: findUniqueMock,
      findMany: findManyMock,
      update: updateMock,
    },
  },
}))

mock.module('../routes/voice', () => ({
  ensureProjectElevenLabsAgent: ensureLegacyMock,
}))

const {
  ensureVoiceAgentId,
  listProjectAgentNames,
  resolveProjectAgent,
  resolveVoiceAgentForSignedUrl,
} = await import('../services/projectAgent.service')

beforeEach(() => {
  findUniqueMock.mockClear()
  findManyMock.mockClear()
  updateMock.mockClear()
  ensureLegacyMock.mockClear()
})

function projectAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa_x',
    projectId: 'p',
    workspaceId: 'ws',
    name: 'default',
    systemPrompt: null,
    toolsAllowlist: null,
    tools: null,
    characterName: null,
    displayName: null,
    voiceId: null,
    firstMessage: null,
    elevenlabsAgentId: null,
    model: null,
    ...overrides,
  }
}

describe('resolveProjectAgent', () => {
  test('returns the row when present (full tool descriptors)', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      name: 'architect',
      systemPrompt: 'arch',
      tools: [
        {
          name: 'lookup_user',
          description: 'Find a user',
          inputSchema: { type: 'object' },
        },
      ],
    }))
    const out = await resolveProjectAgent({
      projectId: 'p',
      agentName: 'architect',
    })
    expect(out?.name).toBe('architect')
    expect(out?.systemPrompt).toBe('arch')
    expect(out?.tools).toEqual([
      {
        name: 'lookup_user',
        description: 'Find a user',
        inputSchema: { type: 'object' },
      },
    ])
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { projectId_name: { projectId: 'p', name: 'architect' } },
    })
  })

  test('defaults to `default` when no name is passed', async () => {
    findUniqueMock.mockImplementationOnce(async () => null)
    await resolveProjectAgent({ projectId: 'p' })
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { projectId_name: { projectId: 'p', name: 'default' } },
    })
  })

  test('decodes a JSON-encoded `tools` value (SQLite shape)', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      tools: JSON.stringify([{ name: 'a' }, { name: 'b' }]),
    }))
    const out = await resolveProjectAgent({ projectId: 'p' })
    expect(out?.tools).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  test('falls back to legacy toolsAllowlist when `tools` is null', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      toolsAllowlist: ['legacy_a', 'legacy_b'],
    }))
    const out = await resolveProjectAgent({ projectId: 'p' })
    expect(out?.tools).toEqual([{ name: 'legacy_a' }, { name: 'legacy_b' }])
  })

  test('filters malformed structured tools and preserves valid object fields', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      tools: [
        'string_tool',
        '',
        null,
        ['array-is-invalid'],
        { name: '' },
        { name: 'object_tool', description: 123, inputSchema: [] },
        { name: 'schema_tool', description: 'Has schema', inputSchema: { type: 'object' } },
      ],
    }))

    const out = await resolveProjectAgent({ projectId: 'p' })

    expect(out?.tools).toEqual([
      { name: 'string_tool' },
      { name: 'object_tool' },
      { name: 'schema_tool', description: 'Has schema', inputSchema: { type: 'object' } },
    ])
  })

  test('returns null tools for invalid JSON, empty arrays, and non-array allowlists', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      tools: '{not-json',
      toolsAllowlist: JSON.stringify({ not: 'an array' }),
    }))
    expect((await resolveProjectAgent({ projectId: 'p' }))?.tools).toBeNull()

    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      tools: [null, '', { name: '' }],
    }))
    expect((await resolveProjectAgent({ projectId: 'p' }))?.tools).toBeNull()
  })

  test('decodes JSON-encoded legacy allowlist and drops empty names', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      toolsAllowlist: JSON.stringify(['legacy_a', '', 42, 'legacy_b']),
    }))

    const out = await resolveProjectAgent({ projectId: 'p' })

    expect(out?.tools).toEqual([{ name: 'legacy_a' }, { name: 'legacy_b' }])
  })

  test('returns null when no project agent row exists', async () => {
    findUniqueMock.mockImplementationOnce(async () => null)
    await expect(resolveProjectAgent({ projectId: 'p', agentName: 'missing' })).resolves.toBeNull()
  })
})

describe('listProjectAgentNames', () => {
  test('returns names ordered by prisma query', async () => {
    findManyMock.mockImplementationOnce(async () => [{ name: 'architect' }, { name: 'default' }])

    const names = await listProjectAgentNames('p')

    expect(names).toEqual(['architect', 'default'])
    expect(findManyMock).toHaveBeenCalledWith({
      where: { projectId: 'p' },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
  })
})

describe('ensureVoiceAgentId', () => {
  const fakeClient = {
    createAgent: mock(async () => 'agent_new'),
  } as any

  beforeEach(() => {
    fakeClient.createAgent.mockClear()
  })

  test('returns an existing ElevenLabs agent id without updating prisma', async () => {
    const id = await ensureVoiceAgentId({
      agent: projectAgentRow({ elevenlabsAgentId: 'agent_existing' }) as any,
      client: fakeClient,
    })

    expect(id).toBe('agent_existing')
    expect(fakeClient.createAgent).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('throws when the agent has no voiceId', async () => {
    await expect(ensureVoiceAgentId({
      agent: projectAgentRow({ name: 'chat-only' }) as any,
      client: fakeClient,
    })).rejects.toThrow("Agent 'chat-only' is not voice-capable")
  })

  test('creates an ElevenLabs agent with defaults and stores the id', async () => {
    const id = await ensureVoiceAgentId({
      agent: projectAgentRow({
        id: 'pa_voice',
        projectId: 'project-abcdef123',
        voiceId: 'voice_1',
      }) as any,
      client: fakeClient,
    })

    expect(id).toBe('agent_new')
    expect(fakeClient.createAgent).toHaveBeenCalledWith({
      displayName: 'shogo-project-project-',
      characterName: 'Shogo',
      voiceId: 'voice_1',
      systemPrompt: '',
      firstMessage: '',
      memoryBlock: null,
      language: 'en',
    })
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'pa_voice' },
      data: { elevenlabsAgentId: 'agent_new' },
    })
  })

  test('creates an ElevenLabs agent with configured persona fields', async () => {
    await ensureVoiceAgentId({
      agent: projectAgentRow({
        id: 'pa_voice',
        displayName: 'Support Agent',
        characterName: 'Ada',
        voiceId: 'voice_1',
        systemPrompt: 'Be concise',
        firstMessage: 'Hello',
      }) as any,
      client: fakeClient,
    })

    expect(fakeClient.createAgent).toHaveBeenCalledWith({
      displayName: 'Support Agent',
      characterName: 'Ada',
      voiceId: 'voice_1',
      systemPrompt: 'Be concise',
      firstMessage: 'Hello',
      memoryBlock: null,
      language: 'en',
    })
  })
})

describe('resolveVoiceAgentForSignedUrl', () => {
  const fakeClient = {
    createAgent: mock(async () => 'agent_new'),
  } as any

  beforeEach(() => {
    fakeClient.createAgent.mockClear()
  })

  test('returns the row\u2019s agent id when one is already provisioned', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      voiceId: 'voice_xx',
      elevenlabsAgentId: 'agent_existing',
    }))
    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      client: fakeClient,
    })
    expect(out).toEqual({ agentId: 'agent_existing', agentName: 'default' })
    expect(ensureLegacyMock).not.toHaveBeenCalled()
  })

  test('falls back to legacy ensureProjectElevenLabsAgent when default row is missing', async () => {
    findUniqueMock.mockImplementationOnce(async () => null)
    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      client: fakeClient,
    })
    expect(out).toEqual({ agentId: 'agent_legacy', agentName: 'default' })
    expect(ensureLegacyMock).toHaveBeenCalledTimes(1)
  })

  test('returns null when a NAMED (non-default) agent is missing — caller 404s with knownAgents', async () => {
    findUniqueMock.mockImplementationOnce(async () => null)
    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      agentName: 'architect',
      client: fakeClient,
    })
    expect(out).toBeNull()
    expect(ensureLegacyMock).not.toHaveBeenCalled()
  })

  test('returns null when row exists but is chat-only (no voiceId, no agent id)', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      name: 'architect',
    }))
    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      agentName: 'architect',
      client: fakeClient,
    })
    expect(out).toBeNull()
  })

  test('lazily provisions a voice-capable named agent with no existing agent id', async () => {
    findUniqueMock.mockImplementationOnce(async () => projectAgentRow({
      name: 'sales',
      voiceId: 'voice_sales',
      elevenlabsAgentId: null,
    }))

    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      agentName: 'sales',
      client: fakeClient,
    })

    expect(out).toEqual({ agentId: 'agent_new', agentName: 'sales' })
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'pa_x' },
      data: { elevenlabsAgentId: 'agent_new' },
    })
  })
})
