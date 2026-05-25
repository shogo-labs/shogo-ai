process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-v5'
// projectAgentSync.service.ts v5 — covers decodeStoredTools string path (lines 158-161).
// decodeStoredTools is called only when entry.tools !== undefined (line 308).
// Tests pass tools in both manifest AND row so the code reaches the decode path.
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { syncProjectAgents } from '../services/projectAgentSync.service'

type Row = {
  id: string; projectId: string; workspaceId: string; name: string
  systemPrompt: string | null; toolsAllowlist: unknown; tools: unknown
  characterName: string | null; displayName: string | null
  voiceId: string | null; firstMessage: string | null
  elevenlabsAgentId: string | null; model: string | null
}
let rows: Row[] = []
let nextId = 1
const findManyMock = mock(async (_: any) => rows.slice())
const createMock = mock(async (args: any) => {
  const r: Row = {
    id: `pa_${nextId++}`, projectId: args.data.projectId, workspaceId: args.data.workspaceId,
    name: args.data.name, systemPrompt: args.data.systemPrompt ?? null,
    toolsAllowlist: args.data.toolsAllowlist ?? null, tools: args.data.tools ?? null,
    characterName: null, displayName: null, voiceId: null, firstMessage: null,
    elevenlabsAgentId: null, model: null,
  }
  rows.push(r); return r
})
const updateMock = mock(async (args: any) => {
  const r = rows.find(r => r.id === args.where.id)
  if (!r) throw new Error('not found')
  Object.assign(r, args.data); return r
})
const deleteMock = mock(async (args: any) => { rows = rows.filter(r => r.id !== args.where.id) })

mock.module('../lib/prisma', () => ({
  prisma: { projectAgent: { findMany: findManyMock, create: createMock, update: updateMock, delete: deleteMock } }
}))

const elClient = {
  createAgent: mock(async () => 'el-new'),
  patchAgent: mock(async () => undefined),
  deleteAgent: mock(async () => undefined),
}
beforeEach(() => {
  rows = []; nextId = 1
  ;[findManyMock, createMock, updateMock, deleteMock, elClient.createAgent, elClient.patchAgent, elClient.deleteAgent].forEach(m => m.mockClear())
})

const mkRow = (overrides: Partial<Row> = {}): Row => ({
  id: 'r1', projectId: 'p1', workspaceId: 'ws1', name: 'default',
  systemPrompt: null, toolsAllowlist: null, tools: null,
  characterName: null, displayName: null, voiceId: null,
  firstMessage: null, elevenlabsAgentId: null, model: null,
  ...overrides,
})

const TOOL = { name: 'bash', description: 'Run bash commands', inputSchema: { type: 'object', properties: {} } }

describe('decodeStoredTools string path (v5 coverage)', () => {
  test('row.tools as valid JSON string → JSON.parse executes (lines 158-159)', async () => {
    // Simulate SQLite row where tools was written as a JSON string, not JSONB
    rows.push(mkRow({ tools: JSON.stringify([TOOL]) }))
    const result = await syncProjectAgents({
      projectId: 'p1', workspaceId: 'ws1',
      // Include tools in manifest so the diff logic reaches decodeStoredTools (line 308)
      manifest: { default: { tools: [TOOL] } },
      prune: false, dryRun: false, elClient: elClient as any,
    })
    expect(result.errors).toEqual([])
    // tools match → no update
    expect(updateMock).not.toHaveBeenCalled()
  })

  test('row.tools as invalid JSON string → catch fires, returns null (lines 160-161)', async () => {
    rows.push(mkRow({ tools: '{INVALID}' }))
    const result = await syncProjectAgents({
      projectId: 'p1', workspaceId: 'ws1',
      // Include tools so diff reaches decodeStoredTools; stored is null (parse fails), manifest is []
      manifest: { default: { tools: [] } },
      prune: false, dryRun: false, elClient: elClient as any,
    })
    expect(result.errors).toEqual([])
    // stored decoded as null ≠ [] → update fired
    expect(updateMock).toHaveBeenCalledTimes(1)
  })
})
