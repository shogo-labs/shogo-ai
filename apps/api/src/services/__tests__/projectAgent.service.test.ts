// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── mocks ───────────────────────────────────────────────────────────────────

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

const rows = new Map<string, Row>() // keyed by composite "projectId|name"
const updates: Array<{ where: any; data: any }> = []
const legacyFallbackCalls: any[] = []
let legacyFallbackImpl: (params: any) => Promise<string> = async () => 'legacy_agent_id'

function key(projectId: string, name: string) {
  return `${projectId}|${name}`
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    projectAgent: {
      findUnique: async ({ where }: any) => {
        if (where.projectId_name) {
          return rows.get(key(where.projectId_name.projectId, where.projectId_name.name)) ?? null
        }
        return null
      },
      findMany: async ({ where, select, orderBy }: any) => {
        let out = [...rows.values()].filter((r) => r.projectId === where.projectId)
        if (orderBy?.name === 'asc') out.sort((a, b) => a.name.localeCompare(b.name))
        if (select) {
          return out.map((r) => {
            const o: any = {}
            for (const k of Object.keys(select)) if (select[k]) o[k] = (r as any)[k]
            return o
          })
        }
        return out
      },
      update: async ({ where, data }: any) => {
        updates.push({ where, data })
        for (const r of rows.values()) {
          if (r.id === where.id) {
            Object.assign(r, data)
            return r
          }
        }
        return null
      },
    },
  },
}))

mock.module('../../routes/voice', () => ({
  ensureProjectElevenLabsAgent: async (params: any) => {
    legacyFallbackCalls.push(params)
    return legacyFallbackImpl(params)
  },
}))

const svc = await import('../projectAgent.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

let id = 0
function seedRow(o: Partial<Row> & { projectId: string; name: string }): Row {
  const r: Row = {
    id: `pa_${++id}`,
    workspaceId: 'ws_1',
    systemPrompt: null,
    toolsAllowlist: null,
    tools: null,
    characterName: null,
    displayName: null,
    voiceId: null,
    firstMessage: null,
    elevenlabsAgentId: null,
    model: null,
    ...o,
  }
  rows.set(key(r.projectId, r.name), r)
  return r
}

function makeElClient(overrides: Partial<{
  createAgent: (...a: any[]) => Promise<string>
  patchAgent: (...a: any[]) => Promise<void>
  deleteAgent: (...a: any[]) => Promise<void>
}> = {}) {
  return {
    createAgent: async () => 'created_agent_id',
    patchAgent: async () => {},
    deleteAgent: async () => {},
    ...overrides,
  } as any
}

beforeEach(() => {
  rows.clear()
  updates.length = 0
  legacyFallbackCalls.length = 0
  legacyFallbackImpl = async () => 'legacy_agent_id'
  id = 0
})

// ─── resolveProjectAgent ─────────────────────────────────────────────────────

describe('resolveProjectAgent', () => {
  it("defaults agentName to 'default'", async () => {
    seedRow({ projectId: 'p1', name: 'default', systemPrompt: 'hi' })
    const out = await svc.resolveProjectAgent({ projectId: 'p1' })
    expect(out?.name).toBe('default')
    expect(out?.systemPrompt).toBe('hi')
  })

  it('returns null when no row matches', async () => {
    expect(await svc.resolveProjectAgent({ projectId: 'p1' })).toBeNull()
  })

  it('returns null when explicitly named agent is missing', async () => {
    seedRow({ projectId: 'p1', name: 'default' })
    expect(
      await svc.resolveProjectAgent({ projectId: 'p1', agentName: 'support' }),
    ).toBeNull()
  })
})

// ─── normalizeTools (exercised via resolveProjectAgent) ─────────────────────

describe('normalizeTools (via resolveProjectAgent)', () => {
  async function load(toolsRaw: unknown, allowlistRaw: unknown = null) {
    seedRow({
      projectId: 'p1',
      name: 'default',
      tools: toolsRaw,
      toolsAllowlist: allowlistRaw,
    })
    return (await svc.resolveProjectAgent({ projectId: 'p1' }))!.tools
  }

  it('returns null when both tools and toolsAllowlist are null', async () => {
    expect(await load(null, null)).toBeNull()
  })

  it('parses a JSON string into the structured form', async () => {
    const out = await load(JSON.stringify([{ name: 'lookup', description: 'd' }]))
    expect(out).toEqual([{ name: 'lookup', description: 'd' }])
  })

  it('falls back to legacy toolsAllowlist when tools JSON is malformed', async () => {
    const out = await load('{not json', ['a', 'b'])
    expect(out).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('expands a bare string entry to { name }', async () => {
    expect(await load(['lookup'])).toEqual([{ name: 'lookup' }])
  })

  it('drops empty strings', async () => {
    expect(await load(['', 'real'])).toEqual([{ name: 'real' }])
  })

  it('drops entries without a name', async () => {
    expect(
      await load([{ description: 'orphan' }, { name: 'kept' }]),
    ).toEqual([{ name: 'kept' }])
  })

  it('drops null / non-object entries', async () => {
    expect(
      await load([null, undefined, 1, [{ wrong: true }], { name: 'kept' }]),
    ).toEqual([{ name: 'kept' }])
  })

  it('keeps inputSchema only when it is a plain object', async () => {
    const out = await load([
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: [1, 2] }, // array → dropped
      { name: 'c', inputSchema: null }, // null → dropped
    ])
    expect(out).toEqual([
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b' },
      { name: 'c' },
    ])
  })

  it('returns null when tools array contains no valid entries', async () => {
    expect(await load([{ description: 'orphan' }, { name: '' }])).toBeNull()
  })

  it('falls back to allowlist when tools is null', async () => {
    expect(await load(null, ['m', 'n'])).toEqual([{ name: 'm' }, { name: 'n' }])
  })

  it('returns null when allowlist itself is malformed JSON', async () => {
    expect(await load(null, '{busted')).toBeNull()
  })

  it('drops non-string allowlist entries', async () => {
    expect(await load(null, ['ok', 42, null, ''])).toEqual([{ name: 'ok' }])
  })

  it('returns null when allowlist resolves to empty', async () => {
    expect(await load(null, [])).toBeNull()
  })

  it('parses allowlist from a JSON string', async () => {
    expect(await load(null, '["a","b"]')).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('returns the structured array directly when tools is already an array', async () => {
    expect(await load([{ name: 'a' }])).toEqual([{ name: 'a' }])
  })
})

// ─── listProjectAgentNames ───────────────────────────────────────────────────

describe('listProjectAgentNames', () => {
  it('returns names sorted ascending', async () => {
    seedRow({ projectId: 'p1', name: 'zed' })
    seedRow({ projectId: 'p1', name: 'alpha' })
    seedRow({ projectId: 'p1', name: 'mid' })
    expect(await svc.listProjectAgentNames('p1')).toEqual(['alpha', 'mid', 'zed'])
  })

  it('returns empty when the project has no agents', async () => {
    expect(await svc.listProjectAgentNames('nope')).toEqual([])
  })

  it('does not leak names from other projects', async () => {
    seedRow({ projectId: 'p1', name: 'a' })
    seedRow({ projectId: 'p2', name: 'b' })
    expect(await svc.listProjectAgentNames('p1')).toEqual(['a'])
  })
})

// ─── ensureVoiceAgentId ──────────────────────────────────────────────────────

describe('ensureVoiceAgentId', () => {
  it('returns the cached id without calling EL when already set', async () => {
    let called = 0
    const client = makeElClient({ createAgent: async () => { called++; return 'X' } })
    const agent: any = {
      id: 'pa_1',
      name: 'default',
      projectId: 'p1',
      elevenlabsAgentId: 'el_cached',
      voiceId: 'v',
    }
    expect(await svc.ensureVoiceAgentId({ agent, client })).toBe('el_cached')
    expect(called).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('throws when the agent has no voiceId', async () => {
    const client = makeElClient()
    const agent: any = { id: 'pa_1', name: 'chat-only', voiceId: null, elevenlabsAgentId: null }
    await expect(svc.ensureVoiceAgentId({ agent, client })).rejects.toThrow(
      /not voice-capable/,
    )
  })

  it('provisions an EL agent and persists the id', async () => {
    let received: any = null
    const client = makeElClient({
      createAgent: async (args: any) => {
        received = args
        return 'el_new'
      },
    })
    seedRow({ projectId: 'p1', name: 'default' })
    const agent: any = {
      id: 'pa_1',
      name: 'default',
      projectId: 'project_abcdef0123',
      workspaceId: 'ws_1',
      systemPrompt: null,
      tools: null,
      characterName: null,
      displayName: null,
      voiceId: 'v_xxx',
      firstMessage: null,
      elevenlabsAgentId: null,
      model: null,
    }
    const out = await svc.ensureVoiceAgentId({ agent, client })
    expect(out).toBe('el_new')
    expect(received.voiceId).toBe('v_xxx')
    expect(received.characterName).toBe('Shogo') // default
    expect(received.displayName).toMatch(/^shogo-project-project_/)
    expect(received.systemPrompt).toBe('')
    expect(received.firstMessage).toBe('')
    expect(received.memoryBlock).toBeNull()
    expect(received.language).toBe('en')
    expect(updates).toEqual([{ where: { id: 'pa_1' }, data: { elevenlabsAgentId: 'el_new' } }])
  })

  it('uses provided display/character/system/first fields when set', async () => {
    let received: any = null
    const client = makeElClient({
      createAgent: async (args: any) => {
        received = args
        return 'el_z'
      },
    })
    const agent: any = {
      id: 'pa_1',
      name: 'default',
      projectId: 'p1',
      workspaceId: 'ws',
      systemPrompt: 'sys',
      tools: null,
      characterName: 'Ada',
      displayName: 'AdaAgent',
      voiceId: 'v',
      firstMessage: 'hello',
      elevenlabsAgentId: null,
      model: null,
    }
    await svc.ensureVoiceAgentId({ agent, client })
    expect(received).toMatchObject({
      displayName: 'AdaAgent',
      characterName: 'Ada',
      systemPrompt: 'sys',
      firstMessage: 'hello',
    })
  })
})

// ─── resolveVoiceAgentForSignedUrl ───────────────────────────────────────────

describe('resolveVoiceAgentForSignedUrl', () => {
  it('returns the EL agent id when row is voice-ready', async () => {
    seedRow({
      projectId: 'p1',
      name: 'default',
      voiceId: 'v',
      elevenlabsAgentId: 'el_x',
    })
    const client = makeElClient()
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      client,
    })
    expect(out).toEqual({ agentId: 'el_x', agentName: 'default' })
    expect(legacyFallbackCalls).toHaveLength(0)
  })

  it('lazily provisions when row has voiceId but no agent id yet', async () => {
    seedRow({
      projectId: 'p1',
      name: 'default',
      voiceId: 'v',
      elevenlabsAgentId: null,
    })
    const client = makeElClient({ createAgent: async () => 'el_lazy' })
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      client,
    })
    expect(out).toEqual({ agentId: 'el_lazy', agentName: 'default' })
  })

  it('returns null when row exists but is chat-only', async () => {
    seedRow({
      projectId: 'p1',
      name: 'chat',
      voiceId: null,
      elevenlabsAgentId: null,
    })
    const client = makeElClient()
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      agentName: 'chat',
      client,
    })
    expect(out).toBeNull()
    expect(legacyFallbackCalls).toHaveLength(0)
  })

  it("falls back to the legacy voice_project_configs lookup when no row + name === 'default'", async () => {
    legacyFallbackImpl = async () => 'el_legacy'
    const client = makeElClient()
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      client,
    })
    expect(out).toEqual({ agentId: 'el_legacy', agentName: 'default' })
    expect(legacyFallbackCalls[0]).toMatchObject({ projectId: 'p1', workspaceId: 'ws' })
  })

  it('returns null when no row AND name is not default', async () => {
    const client = makeElClient()
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      agentName: 'voice-bot',
      client,
    })
    expect(out).toBeNull()
    expect(legacyFallbackCalls).toHaveLength(0)
  })

  it('treats chat-only rows as 404 even for the default name (no legacy fallback)', async () => {
    seedRow({
      projectId: 'p1',
      name: 'default',
      voiceId: null,
      elevenlabsAgentId: null,
    })
    const client = makeElClient()
    const out = await svc.resolveVoiceAgentForSignedUrl({
      projectId: 'p1',
      workspaceId: 'ws',
      client,
    })
    expect(out).toBeNull()
    expect(legacyFallbackCalls).toHaveLength(0)
  })
})
