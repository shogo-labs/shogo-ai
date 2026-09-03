// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/lib/a2a/card.ts (buildAgentCard / getA2aBaseUrl).
// `resolveProjectAgent` and `prisma.project` are mocked; `getFrontendUrl`
// is mocked so getA2aBaseUrl's fallback path is deterministic.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let resolvedAgent: any = null
let projectRow: any = null

mock.module('../../../services/projectAgent.service', () => ({
  resolveProjectAgent: async (_params: { projectId: string }) => resolvedAgent,
}))

mock.module('../../prisma', () => ({
  prisma: {
    project: {
      findUnique: async (_args: any) => projectRow,
    },
  },
}))

mock.module('../../cloud-urls', () => ({
  getFrontendUrl: () => 'https://app.example.test/',
}))

const { buildAgentCard, getA2aBaseUrl, A2A_PROTOCOL_VERSION } = await import('../card')

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resolvedAgent = null
  projectRow = null
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('getA2aBaseUrl', () => {
  it('prefers SHOGO_A2A_BASE_URL and strips a trailing slash', () => {
    process.env.SHOGO_A2A_BASE_URL = 'https://a2a.example.com/'
    expect(getA2aBaseUrl()).toBe('https://a2a.example.com')
  })

  it('falls back to getFrontendUrl() when unset', () => {
    delete process.env.SHOGO_A2A_BASE_URL
    expect(getA2aBaseUrl()).toBe('https://app.example.test')
  })
})

describe('buildAgentCard', () => {
  it('returns null when the project does not exist and there is no ProjectAgent row', async () => {
    resolvedAgent = null
    projectRow = null
    const card = await buildAgentCard({ projectId: 'missing', baseUrl: 'https://base.test' })
    expect(card).toBeNull()
  })

  it('falls back to the bare Project row when no ProjectAgent exists', async () => {
    resolvedAgent = null
    projectRow = { name: 'My Cool App', description: 'Does cool things' }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.name).toBe('My Cool App')
    expect(card?.description).toBe('Does cool things')
    // No ProjectAgent tools -> only the built-in chat skill.
    expect(card?.skills.map((s) => s.id)).toEqual(['chat'])
  })

  it('uses Project.name as a description fallback and "Shogo Agent" as a name fallback', async () => {
    resolvedAgent = null
    projectRow = { name: '', description: '' }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.name).toBe('Shogo Agent')
    expect(card?.description).toContain('Shogo coding agent for project')
  })

  it('prefers ProjectAgent metadata (displayName, systemPrompt, tools) when present', async () => {
    resolvedAgent = {
      id: 'agent-1',
      name: 'default',
      projectId: 'p1',
      workspaceId: 'w1',
      systemPrompt: 'You are a helpful assistant that ships code fast.',
      tools: [{ name: 'read_file', description: 'Reads a file from disk' }],
      characterName: 'Ada',
      displayName: 'Ada the Coder',
      voiceId: null,
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
    }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.name).toBe('Ada the Coder')
    expect(card?.description).toBe('You are a helpful assistant that ships code fast.')
    expect(card?.skills.map((s) => s.id)).toEqual(['chat', 'read_file'])
    const toolSkill = card?.skills.find((s) => s.id === 'read_file')
    expect(toolSkill?.description).toBe('Reads a file from disk')
    expect(toolSkill?.tags).toEqual(['shogo', 'tool'])
  })

  it('falls back name to characterName, then "Shogo Agent", when displayName is unset', async () => {
    resolvedAgent = {
      id: 'agent-1', name: 'default', projectId: 'p1', workspaceId: 'w1',
      systemPrompt: null, tools: null, characterName: 'Ada', displayName: null,
      voiceId: null, firstMessage: null, elevenlabsAgentId: null, model: null,
    }
    const withCharacterName = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(withCharacterName?.name).toBe('Ada')

    resolvedAgent = { ...resolvedAgent, characterName: null }
    const withNeither = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(withNeither?.name).toBe('Shogo Agent')
  })

  it('truncates a long systemPrompt description to 500 chars', async () => {
    resolvedAgent = {
      id: 'agent-1', name: 'default', projectId: 'p1', workspaceId: 'w1',
      systemPrompt: 'x'.repeat(2000), tools: null, characterName: null, displayName: 'Ada',
      voiceId: null, firstMessage: null, elevenlabsAgentId: null, model: null,
    }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.description.length).toBe(500)
  })

  it('builds a single supportedInterfaces entry with the project-scoped RPC URL, tenant, and protocol version', async () => {
    projectRow = { name: 'p', description: '' }
    const card = await buildAgentCard({ projectId: 'proj-123', baseUrl: 'https://base.test' })
    expect(card?.supportedInterfaces).toHaveLength(1)
    expect(card?.supportedInterfaces[0]).toEqual({
      url: 'https://base.test/a2a/projects/proj-123/rpc',
      protocolBinding: 'JSONRPC',
      protocolVersion: A2A_PROTOCOL_VERSION,
      tenant: 'proj-123',
    })
  })

  it('advertises streaming capability and no push notifications', async () => {
    projectRow = { name: 'p', description: '' }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    })
  })

  it('declares a Bearer HTTP auth security scheme named bearerAuth', async () => {
    projectRow = { name: 'p', description: '' }
    const card = await buildAgentCard({ projectId: 'p1', baseUrl: 'https://base.test' })
    expect(card?.securitySchemes.bearerAuth?.scheme).toMatchObject({
      $case: 'httpAuthSecurityScheme',
      value: { scheme: 'Bearer' },
    })
    expect(card?.securityRequirements).toEqual([{ schemes: { bearerAuth: { list: [] } } }])
  })

  it('uses getA2aBaseUrl() when no baseUrl override is passed', async () => {
    process.env.SHOGO_A2A_BASE_URL = 'https://from-env.test'
    projectRow = { name: 'p', description: '' }
    const card = await buildAgentCard({ projectId: 'p1' })
    expect(card?.supportedInterfaces[0].url).toBe('https://from-env.test/a2a/projects/p1/rpc')
  })
})
