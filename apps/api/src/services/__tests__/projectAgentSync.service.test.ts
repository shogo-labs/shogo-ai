// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── prisma mock ─────────────────────────────────────────────────────────────

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

const rows = new Map<string, Row>()
const calls: { create: any[]; update: any[]; delete: any[] } = {
  create: [],
  update: [],
  delete: [],
}

let id = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    projectAgent: {
      findMany: async ({ where }: any) =>
        [...rows.values()].filter((r) => r.projectId === where.projectId),
      create: async ({ data }: any) => {
        calls.create.push(data)
        const r: Row = {
          id: `pa_${++id}`,
          systemPrompt: null,
          toolsAllowlist: null,
          tools: null,
          characterName: null,
          displayName: null,
          voiceId: null,
          firstMessage: null,
          elevenlabsAgentId: null,
          model: null,
          ...data,
        }
        rows.set(r.id, r)
        return r
      },
      update: async ({ where, data }: any) => {
        calls.update.push({ where, data })
        for (const r of rows.values()) {
          if (r.id === where.id) {
            Object.assign(r, data)
            return r
          }
        }
        return null
      },
      delete: async ({ where }: any) => {
        calls.delete.push(where)
        for (const r of rows.values()) {
          if (r.id === where.id) {
            rows.delete(r.id)
            return r
          }
        }
        return null
      },
    },
  },
}))

const svc = await import('../projectAgentSync.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  rows.set(r.id, r)
  return r
}

function makeElClient(overrides: any = {}) {
  return {
    createAgent: async () => 'el_created',
    patchAgent: async () => {},
    deleteAgent: async () => {},
    ...overrides,
  } as any
}

beforeEach(() => {
  rows.clear()
  calls.create.length = 0
  calls.update.length = 0
  calls.delete.length = 0
  id = 0
})

// ─── toConvaiTools (exported) ───────────────────────────────────────────────

describe('toConvaiTools', () => {
  it('converts a structured tool list to EL convai shape with empty default description', () => {
    expect(svc.toConvaiTools([{ name: 'lookup' }])).toEqual([
      { type: 'client', name: 'lookup', description: '' },
    ])
  })

  it('preserves description and inputSchema when present', () => {
    expect(
      svc.toConvaiTools([
        { name: 'a', description: 'do a', inputSchema: { type: 'object' } },
      ]),
    ).toEqual([
      { type: 'client', name: 'a', description: 'do a', parameters: { type: 'object' } },
    ])
  })

  it('omits parameters when inputSchema is absent', () => {
    const out = svc.toConvaiTools([{ name: 'a' }])
    expect((out[0] as any).parameters).toBeUndefined()
  })
})

// ─── syncProjectAgents: manifest validation ─────────────────────────────────

describe('syncProjectAgents — manifest validation', () => {
  it('rejects names that do not match the pattern (uppercase, digits-first, too long)', async () => {
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        BADUPPER: {},
        '1leading': {},
        ['x'.repeat(80)]: {},
        ok_name: {},
      },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    const names = res.errors.map((e) => e.name)
    expect(names).toContain('BADUPPER')
    expect(names).toContain('1leading')
    expect(names.some((n) => n.length === 80)).toBe(true)
    expect(res.created).toEqual(['ok_name'])
  })

  it("reports a non-object value error but still creates an empty row from the name", async () => {
    // parseManifestEntry returns { entry: {}, errors: [...] } when raw is
    // not an object — the name still passes NAME_PATTERN so the service
    // proceeds with an all-default row. The validation error is surfaced
    // alongside the create.
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { foo: 'not-an-object' as any },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(res.errors[0]).toMatchObject({ name: 'foo' })
    expect(res.errors[0]!.message).toContain('must be an object')
    expect(res.created).toEqual(['foo'])
  })

  it('warns when voiceId is set without a firstMessage but still creates', async () => {
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { greeter: { voiceId: 'v', firstMessage: '' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({ createAgent: async () => 'el_v' }),
    })
    expect(res.errors[0]?.message).toMatch(/empty greeting/)
    expect(res.created).toEqual(['greeter'])
  })
})

// ─── syncProjectAgents: CREATE branch ───────────────────────────────────────

describe('syncProjectAgents — CREATE', () => {
  it('creates a chat-only row without calling EL', async () => {
    let elCalls = 0
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { systemPrompt: 'be terse', model: 'haiku' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({ createAgent: async () => { elCalls++; return 'x' } }),
    })
    expect(res.created).toEqual(['writer'])
    expect(elCalls).toBe(0)
    expect(calls.create[0]).toMatchObject({
      name: 'writer',
      systemPrompt: 'be terse',
      model: 'haiku',
      elevenlabsAgentId: null,
    })
  })

  it('persists without an EL agent id when voiceId is set but elClient is null', async () => {
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { greeter: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(res.created).toEqual(['greeter'])
    expect(res.errors[0]?.message).toMatch(/ELEVENLABS_API_KEY is not configured/)
    expect(calls.create[0].elevenlabsAgentId).toBeNull()
  })

  it('provisions and persists EL agent id for voice agent + elClient', async () => {
    let received: any = null
    const res = await svc.syncProjectAgents({
      projectId: 'pabc12345',
      workspaceId: 'ws',
      manifest: {
        greeter: {
          voiceId: 'v',
          firstMessage: 'hi',
          tools: [{ name: 'lookup', description: 'look it up' }],
        },
      },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async (args: any) => { received = args; return 'el_g' },
      }),
    })
    expect(res.created).toEqual(['greeter'])
    expect(received.voiceId).toBe('v')
    expect(received.tools).toEqual([
      { type: 'client', name: 'lookup', description: 'look it up' },
    ])
    expect(received.displayName).toMatch(/^shogo-project-pabc1234-greeter$/)
    expect(calls.create[0].elevenlabsAgentId).toBe('el_g')
  })

  it('dryRun skips both EL create and DB create', async () => {
    let elCalls = 0
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: true,
      elClient: makeElClient({ createAgent: async () => { elCalls++; return 'x' } }),
    })
    expect(res.created).toEqual(['writer'])
    expect(res.dryRun).toBe(true)
    expect(elCalls).toBe(0)
    expect(calls.create).toHaveLength(0)
  })

  it('normalizes legacy toolsAllowlist string[] into [{ name }]', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { toolsAllowlist: ['a', 'b'] } as any },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].tools).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('deduplicates tools by name', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { tools: [{ name: 'x' }, { name: 'x' }, 'x'] as any } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].tools).toEqual([{ name: 'x' }])
  })

  it('drops invalid tool entries', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        writer: {
          tools: [null, [], { description: 'orphan' }, { name: 'ok' }] as any,
        },
      },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].tools).toEqual([{ name: 'ok' }])
  })

  it('drops tool entries with empty name', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        writer: {
          tools: ['', { name: '' }, { name: 'good' }] as any,
        },
      },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].tools).toEqual([{ name: 'good' }])
  })

  it('accepts tools = null to clear the field', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { tools: null } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].tools).toBeUndefined() // null tools → entry.tools = null → service stores undefined
  })

  it('treats empty-string fields as null', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { systemPrompt: '', characterName: '' } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(calls.create[0].systemPrompt).toBeNull()
    expect(calls.create[0].characterName).toBeNull()
  })

  it('ignores tools input that is not an array', async () => {
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { tools: 'lookup' as any } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    // Non-array tools → asToolDescriptorArray returns undefined → entry.tools stays undefined.
    expect(calls.create[0].tools).toBeUndefined()
  })
})

// ─── syncProjectAgents: UPDATE branch ───────────────────────────────────────

describe('syncProjectAgents — UPDATE', () => {
  it('skips when nothing changed', async () => {
    seedRow({
      projectId: 'p1',
      name: 'writer',
      systemPrompt: 'same',
    })
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { systemPrompt: 'same' } },
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(res.updated).toEqual([])
    expect(calls.update).toHaveLength(0)
  })

  it('updates DB fields without calling EL when row is chat-only', async () => {
    seedRow({
      projectId: 'p1',
      name: 'writer',
      systemPrompt: 'old',
      elevenlabsAgentId: null,
    })
    let elPatchCalls = 0
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { systemPrompt: 'new', model: 'haiku' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        patchAgent: async () => { elPatchCalls++ },
      }),
    })
    expect(res.updated).toEqual(['writer'])
    expect(elPatchCalls).toBe(0)
    expect(calls.update[0].data).toMatchObject({ systemPrompt: 'new', model: 'haiku' })
  })

  it('patches EL with only the changed fields when row has an EL agent', async () => {
    seedRow({
      projectId: 'p1',
      name: 'greeter',
      systemPrompt: 'old',
      firstMessage: 'hi',
      voiceId: 'v',
      characterName: 'Shogo',
      displayName: 'g',
      elevenlabsAgentId: 'el_existing',
    })
    let received: any = null
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        greeter: { systemPrompt: 'new', firstMessage: 'hi' /* unchanged */ },
      },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        patchAgent: async (id: string, patch: any) => { received = { id, patch } },
      }),
    })
    expect(res.updated).toEqual(['greeter'])
    expect(received.id).toBe('el_existing')
    expect(received.patch).toEqual({ systemPrompt: 'new' })
  })

  it('forwards tools, voiceId, characterName, displayName, firstMessage when they changed', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      systemPrompt: 'sp',
      firstMessage: 'old-msg',
      voiceId: 'old-v',
      characterName: 'old-cn',
      displayName: 'old-dn',
      tools: JSON.stringify([{ name: 'old-tool' }]),
      elevenlabsAgentId: 'el',
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        g: {
          firstMessage: 'new-msg',
          voiceId: 'new-v',
          characterName: 'new-cn',
          displayName: 'new-dn',
          tools: [{ name: 'new-tool' }],
        },
      },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        patchAgent: async (id: string, patch: any) => { received = patch },
      }),
    })
    expect(received).toEqual({
      firstMessage: 'new-msg',
      voiceId: 'new-v',
      characterName: 'new-cn',
      displayName: 'new-dn',
      tools: [{ type: 'client', name: 'new-tool', description: '' }],
    })
  })

  it('uses empty string when nulled fields are forwarded to EL', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      systemPrompt: 'old',
      firstMessage: 'old',
      characterName: 'old',
      displayName: 'old',
      voiceId: 'v',
      elevenlabsAgentId: 'el',
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        g: {
          systemPrompt: null,
          firstMessage: null,
          characterName: null,
          displayName: null,
        },
      },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        patchAgent: async (id: string, patch: any) => { received = patch },
      }),
    })
    expect(received).toEqual({
      systemPrompt: '',
      firstMessage: '',
      characterName: '',
      displayName: '',
    })
  })

  it('skips EL patch when only chat-only fields (model) changed', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      model: 'old',
      elevenlabsAgentId: 'el',
    })
    let elPatchCalls = 0
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { model: 'new' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({ patchAgent: async () => { elPatchCalls++ } }),
    })
    expect(elPatchCalls).toBe(0)
    expect(calls.update[0].data).toEqual({ model: 'new' })
  })

  it('promotes a chat-only row to voice (creates EL agent)', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      systemPrompt: 'be helpful',
      elevenlabsAgentId: null,
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { voiceId: 'v_new', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async (args: any) => { received = args; return 'el_promoted' },
      }),
    })
    expect(received.voiceId).toBe('v_new')
    expect(received.systemPrompt).toBe('be helpful')
    expect(calls.update[0].data.elevenlabsAgentId).toBe('el_promoted')
  })

  it('uses manifest tools first, then row tools, then null when promoting', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      tools: JSON.stringify([{ name: 'stored' }]),
      elevenlabsAgentId: null,
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async (args: any) => { received = args; return 'el_p' },
      }),
    })
    expect(received.tools).toEqual([
      { type: 'client', name: 'stored', description: '' },
    ])
  })

  it('falls back to toolsAllowlist when tools column is unparseable on promotion', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      tools: '{not-json',
      toolsAllowlist: JSON.stringify(['legacy_tool']),
      elevenlabsAgentId: null,
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async (args: any) => { received = args; return 'el_p' },
      }),
    })
    expect(received.tools).toEqual([
      { type: 'client', name: 'legacy_tool', description: '' },
    ])
  })

  it('omits tools entirely on promotion when none exist', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      elevenlabsAgentId: null,
    })
    let received: any = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async (args: any) => { received = args; return 'el_p' },
      }),
    })
    expect(received.tools).toBeUndefined()
  })

  it('dryRun skips EL patch + DB update', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      systemPrompt: 'old',
      elevenlabsAgentId: 'el',
    })
    let elPatchCalls = 0
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { systemPrompt: 'new' } },
      prune: false,
      dryRun: true,
      elClient: makeElClient({ patchAgent: async () => { elPatchCalls++ } }),
    })
    expect(res.updated).toEqual(['g'])
    expect(elPatchCalls).toBe(0)
    expect(calls.update).toHaveLength(0)
  })

  it('detects tools-changed via deep compare (order matters)', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      tools: JSON.stringify([{ name: 'a' }, { name: 'b' }]),
      elevenlabsAgentId: 'el',
    })
    let patched = false
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { tools: [{ name: 'b' }, { name: 'a' }] } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({ patchAgent: async () => { patched = true } }),
    })
    expect(patched).toBe(true)
  })

  it('detects tools-changed when description differs', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      tools: JSON.stringify([{ name: 'a', description: 'one' }]),
      elevenlabsAgentId: 'el',
    })
    let patched = false
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { g: { tools: [{ name: 'a', description: 'two' }] } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({ patchAgent: async () => { patched = true } }),
    })
    expect(patched).toBe(true)
  })

  it('skips update when tools are equal (object form)', async () => {
    seedRow({
      projectId: 'p1',
      name: 'g',
      tools: [{ name: 'a', description: 'one', inputSchema: { x: 1 } }] as any,
      elevenlabsAgentId: 'el',
    })
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {
        g: { tools: [{ name: 'a', description: 'one', inputSchema: { x: 1 } }] },
      },
      prune: false,
      dryRun: false,
      elClient: makeElClient(),
    })
    expect(res.updated).toEqual([])
  })
})

// ─── syncProjectAgents: error handling ──────────────────────────────────────

describe('syncProjectAgents — error handling', () => {
  it('captures status + upstreamBody from an ElevenLabsApiError-shaped throw', async () => {
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const res = await svc.syncProjectAgents({
        projectId: 'p1',
        workspaceId: 'ws',
        manifest: { greeter: { voiceId: 'v', firstMessage: 'hi' } },
        prune: false,
        dryRun: false,
        elClient: makeElClient({
          createAgent: async () => {
            const e: any = new Error('voice id invalid')
            e.status = 400
            e.body = '{"detail":"bad voice"}'
            throw e
          },
        }),
      })
      expect(res.errors[0]).toMatchObject({
        name: 'greeter',
        message: 'voice id invalid',
        status: 400,
        upstreamBody: '{"detail":"bad voice"}',
      })
      expect(warns.some((w) => w.includes('greeter failed (status=400)'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  it('captures plain errors without status/body', async () => {
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async () => { throw new Error('boom') },
      }),
    })
    expect(res.errors[0]).toEqual({ name: 'writer', message: 'boom' })
  })

  it('stringifies non-Error throws', async () => {
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: { writer: { voiceId: 'v', firstMessage: 'hi' } },
      prune: false,
      dryRun: false,
      elClient: makeElClient({
        createAgent: async () => { throw 'oops' as any },
      }),
    })
    expect(res.errors[0]).toEqual({ name: 'writer', message: 'oops' })
  })
})

// ─── syncProjectAgents: DELETE / prune ──────────────────────────────────────

describe('syncProjectAgents — DELETE / prune', () => {
  it('does not delete when prune=false', async () => {
    seedRow({ projectId: 'p1', name: 'orphan' })
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: false,
      dryRun: false,
      elClient: null,
    })
    expect(res.deleted).toEqual([])
    expect(calls.delete).toHaveLength(0)
  })

  it("never prunes the 'default' agent", async () => {
    seedRow({ projectId: 'p1', name: 'default' })
    seedRow({ projectId: 'p1', name: 'orphan' })
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: null,
    })
    expect(res.deleted).toEqual(['orphan'])
  })

  it('calls EL.deleteAgent for rows with an EL agent id', async () => {
    seedRow({
      projectId: 'p1',
      name: 'orphan',
      elevenlabsAgentId: 'el_to_delete',
    })
    let deleted: string | null = null
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: makeElClient({
        deleteAgent: async (id: string) => { deleted = id },
      }),
    })
    expect(deleted).toBe('el_to_delete')
  })

  it('logs and continues when EL.deleteAgent fails', async () => {
    seedRow({
      projectId: 'p1',
      name: 'orphan',
      elevenlabsAgentId: 'el_x',
    })
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const res = await svc.syncProjectAgents({
        projectId: 'p1',
        workspaceId: 'ws',
        manifest: {},
        prune: true,
        dryRun: false,
        elClient: makeElClient({
          deleteAgent: async () => { throw new Error('EL outage') },
        }),
      })
      expect(res.deleted).toEqual(['orphan'])
      expect(warns.some((w) => w.includes('EL deleteAgent failed for orphan'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  it('captures status/body on prisma.delete failure with EL error shape', async () => {
    seedRow({ projectId: 'p1', name: 'orphan' })
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const mockedPrisma = (await import('../../lib/prisma')).prisma as any
      const orig = mockedPrisma.projectAgent.delete
      mockedPrisma.projectAgent.delete = async () => {
        const e: any = new Error('db fail')
        e.status = 500
        e.body = 'internal'
        throw e
      }
      try {
        const res = await svc.syncProjectAgents({
          projectId: 'p1',
          workspaceId: 'ws',
          manifest: {},
          prune: true,
          dryRun: false,
          elClient: null,
        })
        expect(res.deleted).toEqual([])
        expect(res.errors[0]).toMatchObject({
          name: 'orphan',
          status: 500,
          upstreamBody: 'internal',
        })
        expect(warns.some((w) => w.includes('orphan delete failed (status=500)'))).toBe(true)
      } finally {
        mockedPrisma.projectAgent.delete = orig
      }
    } finally {
      console.warn = origWarn
    }
  })

  it('captures plain errors on delete failure', async () => {
    seedRow({ projectId: 'p1', name: 'orphan' })
    const mockedPrisma = (await import('../../lib/prisma')).prisma as any
    const orig = mockedPrisma.projectAgent.delete
    mockedPrisma.projectAgent.delete = async () => { throw new Error('plain db fail') }
    try {
      const res = await svc.syncProjectAgents({
        projectId: 'p1',
        workspaceId: 'ws',
        manifest: {},
        prune: true,
        dryRun: false,
        elClient: null,
      })
      expect(res.errors[0]).toEqual({ name: 'orphan', message: 'plain db fail' })
    } finally {
      mockedPrisma.projectAgent.delete = orig
    }
  })

  it('stringifies non-Error throws on delete', async () => {
    seedRow({ projectId: 'p1', name: 'orphan' })
    const mockedPrisma = (await import('../../lib/prisma')).prisma as any
    const orig = mockedPrisma.projectAgent.delete
    mockedPrisma.projectAgent.delete = async () => { throw 'nope' as any }
    try {
      const res = await svc.syncProjectAgents({
        projectId: 'p1',
        workspaceId: 'ws',
        manifest: {},
        prune: true,
        dryRun: false,
        elClient: null,
      })
      expect(res.errors[0]).toEqual({ name: 'orphan', message: 'nope' })
    } finally {
      mockedPrisma.projectAgent.delete = orig
    }
  })

  it('dryRun skips EL deleteAgent + DB delete but still reports in result', async () => {
    seedRow({
      projectId: 'p1',
      name: 'orphan',
      elevenlabsAgentId: 'el_x',
    })
    let elDeletes = 0
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: true,
      elClient: makeElClient({
        deleteAgent: async () => { elDeletes++ },
      }),
    })
    expect(res.deleted).toEqual(['orphan'])
    expect(elDeletes).toBe(0)
    expect(calls.delete).toHaveLength(0)
  })

  it('skips EL deleteAgent when row has no elevenlabsAgentId', async () => {
    seedRow({ projectId: 'p1', name: 'orphan', elevenlabsAgentId: null })
    let elDeletes = 0
    await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: makeElClient({
        deleteAgent: async () => { elDeletes++ },
      }),
    })
    expect(elDeletes).toBe(0)
  })

  it('does not call EL.deleteAgent when elClient is null', async () => {
    seedRow({
      projectId: 'p1',
      name: 'orphan',
      elevenlabsAgentId: 'el_x',
    })
    const res = await svc.syncProjectAgents({
      projectId: 'p1',
      workspaceId: 'ws',
      manifest: {},
      prune: true,
      dryRun: false,
      elClient: null,
    })
    expect(res.deleted).toEqual(['orphan'])
  })
})
