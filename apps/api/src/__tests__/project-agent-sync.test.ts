// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `services/projectAgentSync.service` — exercises the
 * reconciliation engine that powers `POST /api/projects/:id/agents/sync`.
 *
 * Pinned semantics:
 *   1. Names that don't exist yet → CREATE, with EL.createAgent for
 *      voice-bearing entries.
 *   2. Names whose manifest fields differ from the row → UPDATE, with
 *      EL.patchAgent for fields that EL cares about.
 *   3. Names absent from the manifest are pruned only when
 *      `prune: true` AND the name isn't `default`.
 *   4. Validation errors (bad name regex, malformed value) are
 *      surfaced in `result.errors[]` per name without aborting the
 *      whole run.
 *   5. `dryRun: true` returns the same diff shape but performs no
 *      writes against Prisma or EL.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

type Row = {
  id: string
  projectId: string
  workspaceId: string
  name: string
  systemPrompt: string | null
  toolsAllowlist: unknown
  tools: unknown
  characterName: string | null
  displayName: string | null
  voiceId: string | null
  firstMessage: string | null
  elevenlabsAgentId: string | null
  model: string | null
}

let rows: Row[] = []
let nextId = 1

const findManyMock = mock(async (_args: any) => rows.slice())
const createMock = mock(async (args: any) => {
  const row: Row = {
    id: `pa_${nextId++}`,
    projectId: args.data.projectId,
    workspaceId: args.data.workspaceId,
    name: args.data.name,
    systemPrompt: args.data.systemPrompt ?? null,
    toolsAllowlist: args.data.toolsAllowlist ?? null,
    tools: args.data.tools ?? null,
    characterName: args.data.characterName ?? null,
    displayName: args.data.displayName ?? null,
    voiceId: args.data.voiceId ?? null,
    firstMessage: args.data.firstMessage ?? null,
    elevenlabsAgentId: args.data.elevenlabsAgentId ?? null,
    model: args.data.model ?? null,
  }
  rows.push(row)
  return row
})
const updateMock = mock(async (args: any) => {
  const row = rows.find((r) => r.id === args.where.id)
  if (!row) throw new Error('not found')
  Object.assign(row, args.data)
  return row
})
const deleteMock = mock(async (args: any) => {
  rows = rows.filter((r) => r.id !== args.where.id)
})

mock.module('../lib/prisma', () => ({
  prisma: {
    projectAgent: {
      findMany: findManyMock,
      create: createMock,
      update: updateMock,
      delete: deleteMock,
    },
  },
}))

const { syncProjectAgents } = await import(
  '../services/projectAgentSync.service'
)

beforeEach(() => {
  rows = []
  nextId = 1
  findManyMock.mockClear()
  createMock.mockClear()
  updateMock.mockClear()
  deleteMock.mockClear()
})

function makeClient() {
  return {
    createAgent: mock(async () => 'agent_created'),
    patchAgent: mock(async () => undefined),
    deleteAgent: mock(async () => undefined),
  } as any
}

describe('syncProjectAgents — create branch', () => {
  test('creates new rows and provisions EL for voice-bearing entries', async () => {
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        architect: { systemPrompt: 'arch' }, // chat-only
        narrator: {
          systemPrompt: 'narr',
          voiceId: 'voice_a',
          firstMessage: 'hello',
        },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.created.sort()).toEqual(['architect', 'narrator'])
    expect(out.updated).toEqual([])
    expect(out.deleted).toEqual([])
    expect(client.createAgent).toHaveBeenCalledTimes(1)
    const narratorRow = rows.find((r) => r.name === 'narrator')!
    expect(narratorRow.elevenlabsAgentId).toBe('agent_created')
    const architectRow = rows.find((r) => r.name === 'architect')!
    expect(architectRow.elevenlabsAgentId).toBeNull()
  })

  test('dryRun: collects diff but writes nothing', async () => {
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: { architect: { systemPrompt: 'arch' } },
      prune: false,
      dryRun: true,
      elClient: client,
    })
    expect(out.dryRun).toBe(true)
    expect(out.created).toEqual(['architect'])
    expect(rows).toEqual([])
    expect(createMock).not.toHaveBeenCalled()
    expect(client.createAgent).not.toHaveBeenCalled()
  })

  test('rejects bad agent names with a per-name error', async () => {
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: { 'Bad Name!': { systemPrompt: 'x' } },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.errors.length).toBeGreaterThan(0)
    expect(out.errors[0]!.name).toBe('Bad Name!')
    expect(out.created).toEqual([])
    expect(rows).toEqual([])
  })
})

describe('syncProjectAgents — update branch', () => {
  test('updates only changed fields and patches EL when the change matters to it', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'architect',
        systemPrompt: 'old',
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: 'voice_a',
        firstMessage: 'old hi',
        elevenlabsAgentId: 'agent_pre',
        model: null,
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        architect: {
          systemPrompt: 'new prompt',
          voiceId: 'voice_a',
          firstMessage: 'old hi',
        },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.updated).toEqual(['architect'])
    expect(client.patchAgent).toHaveBeenCalledTimes(1)
    const [agentId, patch] = client.patchAgent.mock.calls[0]!
    expect(agentId).toBe('agent_pre')
    expect(patch.systemPrompt).toBe('new prompt')
    // firstMessage unchanged → not part of patch payload
    expect('firstMessage' in patch).toBe(false)
    expect(rows[0]!.systemPrompt).toBe('new prompt')
  })

  test('promotes a chat-only row to voice-capable on first deploy with voiceId', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'architect',
        systemPrompt: 'arch',
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        architect: { systemPrompt: 'arch', voiceId: 'voice_a' },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.updated).toEqual(['architect'])
    expect(client.createAgent).toHaveBeenCalledTimes(1)
    expect(client.patchAgent).not.toHaveBeenCalled()
    expect(rows[0]!.elevenlabsAgentId).toBe('agent_created')
  })

  test('patches EL tools when the manifest tools change', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'narrator',
        systemPrompt: 'narr',
        toolsAllowlist: null,
        tools: [{ name: 'add_memory' }] as any,
        characterName: null,
        displayName: null,
        voiceId: 'voice_a',
        firstMessage: 'hi',
        elevenlabsAgentId: 'agent_pre',
        model: null,
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        narrator: {
          voiceId: 'voice_a',
          firstMessage: 'hi',
          tools: [
            'add_memory',
            { name: 'set_palette', description: 'Pick a UI palette' },
          ],
        },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.updated).toEqual(['narrator'])
    expect(client.patchAgent).toHaveBeenCalledTimes(1)
    const [, patch] = client.patchAgent.mock.calls[0]!
    expect(patch.tools).toEqual([
      { type: 'client', name: 'add_memory', description: '' },
      { type: 'client', name: 'set_palette', description: 'Pick a UI palette' },
    ])
    expect(rows[0]!.tools).toEqual([
      { name: 'add_memory' },
      { name: 'set_palette', description: 'Pick a UI palette' },
    ] as any)
  })

  test('does NOT patch EL tools when the manifest tools match the stored value', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'narrator',
        systemPrompt: 'narr',
        toolsAllowlist: null,
        tools: [
          { name: 'add_memory', description: 'Persist a fact' },
        ] as any,
        characterName: null,
        displayName: null,
        voiceId: 'voice_a',
        firstMessage: 'hi',
        elevenlabsAgentId: 'agent_pre',
        model: null,
      },
    ]
    const client = makeClient()
    await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        narrator: {
          voiceId: 'voice_a',
          firstMessage: 'hi',
          tools: [{ name: 'add_memory', description: 'Persist a fact' }],
        },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(client.patchAgent).not.toHaveBeenCalled()
  })

  test('promotion to voice forwards stored tools when manifest omits them', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'architect',
        systemPrompt: 'arch',
        toolsAllowlist: null,
        tools: [{ name: 'add_memory' }] as any,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ]
    const client = makeClient()
    await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        architect: { systemPrompt: 'arch', voiceId: 'voice_a' },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    const [createParams] = client.createAgent.mock.calls[0]!
    expect(createParams.tools).toEqual([
      { type: 'client', name: 'add_memory', description: '' },
    ])
  })

  test('promotion to voice falls back to legacy `toolsAllowlist` when `tools` is null', async () => {
    rows = [
      {
        id: 'pa_legacy',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'legacy_chat',
        systemPrompt: 'l',
        toolsAllowlist: ['add_memory', 'set_palette'] as any,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ]
    const client = makeClient()
    await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        legacy_chat: { systemPrompt: 'l', voiceId: 'voice_a' },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    const [createParams] = client.createAgent.mock.calls[0]!
    expect(createParams.tools).toEqual([
      { type: 'client', name: 'add_memory', description: '' },
      { type: 'client', name: 'set_palette', description: '' },
    ])
  })

  test('no-op when manifest matches the row exactly', async () => {
    rows = [
      {
        id: 'pa_existing',
        projectId: 'p',
        workspaceId: 'ws',
        name: 'default',
        systemPrompt: 'same',
        toolsAllowlist: null,
        tools: null,
        characterName: null,
        displayName: null,
        voiceId: null,
        firstMessage: null,
        elevenlabsAgentId: null,
        model: null,
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: { default: { systemPrompt: 'same' } },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.created).toEqual([])
    expect(out.updated).toEqual([])
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe('syncProjectAgents — prune branch', () => {
  test('drops rows missing from the manifest only when prune=true', async () => {
    rows = [
      {
        id: 'pa_a',
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
        elevenlabsAgentId: 'agent_a',
        model: null,
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: client,
    })
    expect(out.deleted).toEqual(['architect'])
    expect(client.deleteAgent).toHaveBeenCalledWith('agent_a')
    expect(rows).toEqual([])
  })

  test('does NOT prune the `default` row even when missing from the manifest', async () => {
    rows = [
      {
        id: 'pa_default',
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
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: client,
    })
    expect(out.deleted).toEqual([])
    expect(rows.length).toBe(1)
  })

  test('forwards tool descriptors to EL on create + persists `tools` column', async () => {
    const client = makeClient()
    await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {
        narrator: {
          systemPrompt: 'narr',
          voiceId: 'voice_a',
          firstMessage: 'hi',
          tools: [
            { name: 'add_memory', description: 'Persist a fact' },
            {
              name: 'lookup_user',
              description: 'Find a user',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
        },
      },
      prune: false,
      dryRun: false,
      elClient: client,
    })
    const [createParams] = client.createAgent.mock.calls[0]!
    expect(createParams.tools).toEqual([
      { type: 'client', name: 'add_memory', description: 'Persist a fact' },
      {
        type: 'client',
        name: 'lookup_user',
        description: 'Find a user',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ])
    const row = rows.find((r) => r.name === 'narrator')!
    expect(row.tools).toEqual([
      { name: 'add_memory', description: 'Persist a fact' },
      {
        name: 'lookup_user',
        description: 'Find a user',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ] as any)
  })

  test('does NOT prune anything when prune=false', async () => {
    rows = [
      {
        id: 'pa_a',
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
      },
    ]
    const client = makeClient()
    const out = await syncProjectAgents({
      projectId: 'p',
      workspaceId: 'ws',
      manifest: {},
      prune: false,
      dryRun: false,
      elClient: client,
    })
    expect(out.deleted).toEqual([])
    expect(rows.length).toBe(1)
  })
})
