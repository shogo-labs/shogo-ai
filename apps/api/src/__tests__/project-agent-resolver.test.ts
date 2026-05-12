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
const ensureLegacyMock = mock(
  async (_args: any) => 'agent_legacy' as string,
)

mock.module('../lib/prisma', () => ({
  prisma: {
    projectAgent: {
      findUnique: findUniqueMock,
      findMany: findManyMock,
      update: mock(async () => null),
    },
  },
}))

mock.module('../routes/voice', () => ({
  ensureProjectElevenLabsAgent: ensureLegacyMock,
}))

const {
  resolveProjectAgent,
  resolveVoiceAgentForSignedUrl,
} = await import('../services/projectAgent.service')

beforeEach(() => {
  findUniqueMock.mockClear()
  findManyMock.mockClear()
  ensureLegacyMock.mockClear()
})

describe('resolveProjectAgent', () => {
  test('returns the row when present (full tool descriptors)', async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      id: 'pa_x',
      projectId: 'p',
      workspaceId: 'ws',
      name: 'architect',
      systemPrompt: 'arch',
      toolsAllowlist: null,
      tools: [
        {
          name: 'lookup_user',
          description: 'Find a user',
          inputSchema: { type: 'object' },
        },
      ],
      characterName: null,
      displayName: null,
      voiceId: null,
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
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
    findUniqueMock.mockImplementationOnce(async () => ({
      id: 'pa_x',
      projectId: 'p',
      workspaceId: 'ws',
      name: 'default',
      systemPrompt: null,
      toolsAllowlist: null,
      tools: JSON.stringify([{ name: 'a' }, { name: 'b' }]),
      characterName: null,
      displayName: null,
      voiceId: null,
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
    }))
    const out = await resolveProjectAgent({ projectId: 'p' })
    expect(out?.tools).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  test('falls back to legacy toolsAllowlist when `tools` is null', async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      id: 'pa_x',
      projectId: 'p',
      workspaceId: 'ws',
      name: 'default',
      systemPrompt: null,
      toolsAllowlist: ['legacy_a', 'legacy_b'],
      tools: null,
      characterName: null,
      displayName: null,
      voiceId: null,
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
    }))
    const out = await resolveProjectAgent({ projectId: 'p' })
    expect(out?.tools).toEqual([{ name: 'legacy_a' }, { name: 'legacy_b' }])
  })
})

describe('resolveVoiceAgentForSignedUrl', () => {
  const fakeClient = {
    createAgent: mock(async () => 'agent_new'),
  } as any

  test('returns the row\u2019s agent id when one is already provisioned', async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      id: 'pa_default',
      projectId: 'p',
      workspaceId: 'ws',
      name: 'default',
      systemPrompt: null,
      toolsAllowlist: null,
      tools: null,
      characterName: null,
      displayName: null,
      voiceId: 'voice_xx',
      firstMessage: null,
      elevenlabsAgentId: 'agent_existing',
      model: null,
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
    findUniqueMock.mockImplementationOnce(async () => ({
      id: 'pa_x',
      projectId: 'p',
      workspaceId: 'ws',
      name: 'architect',
      systemPrompt: null,
      toolsAllowlist: null,
      tools: null,
      characterName: null,
      displayName: null,
      voiceId: null,
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
    }))
    const out = await resolveVoiceAgentForSignedUrl({
      projectId: 'p',
      workspaceId: 'ws',
      agentName: 'architect',
      client: fakeClient,
    })
    expect(out).toBeNull()
  })
})
