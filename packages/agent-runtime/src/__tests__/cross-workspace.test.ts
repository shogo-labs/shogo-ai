// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-389, runtime half: the Personal workspace agent's `workspace` option.
 *
 * Covers the parts that decide whether a person is asked: the parameter is only
 * registered on the Personal workspace agent, a name resolves (and an ambiguous
 * one never guesses), a call in its own workspace is untouched, a read runs in
 * the target without a prompt, and **every** write asks whatever the security
 * mode says — deny, timeout and "nobody to ask" each answer with their own code.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const TARGETS = [
  { id: 'ws-personal', name: 'Personal', slug: 'personal', kind: 'personal', source: 'cloud', reachable: true },
  { id: 'ws-odin-ai', name: 'Odin AI', slug: 'odin-ai', kind: 'team', source: 'cloud', reachable: true },
  { id: 'ws-odin-labs', name: 'Odin Labs', slug: 'odin-labs', kind: 'team', source: 'cloud', reachable: true },
  { id: 'ws-odin-old', name: 'Odin Legacy', slug: 'odin-legacy', kind: 'team', source: 'cloud', reachable: true },
  { id: 'ws-nada', name: 'Nada', slug: 'nada', kind: 'team', source: 'cloud', reachable: true },
  {
    id: 'ws-samsara',
    name: 'Samsara Game',
    slug: 'samsara',
    kind: 'team',
    source: 'cloud',
    reachable: true,
  },
  {
    id: 'ws-desktop',
    name: 'Serendipity',
    slug: 'serendipity',
    kind: 'team',
    source: 'desktop',
    reachable: false,
    unreachableReason: 'desktop_hosted',
  },
] as const

const minted: Array<Record<string, unknown>> = []

mock.module('../gateway-tools', () => ({
  textResult: (details: unknown) => ({ details }),
}))

const realInternalApi = await import('../internal-api')
mock.module('../internal-api', () => ({
  ...realInternalApi,
  fetchCrossWorkspaceTargets: async () => ({
    ok: true,
    status: 200,
    data: { workspaces: TARGETS.map((t) => ({ ...t })) },
  }),
  mintCrossWorkspaceApproval: async (input: Record<string, unknown>) => {
    minted.push(input)
    return { ok: true, status: 201, data: { approvalId: `approval-${minted.length}` } }
  },
}))

const {
  _resetCrossWorkspaceCacheForTests,
  crossWorkspaceEnabled,
  crossWorkspaceTargetId,
  resolveTargetWorkspace,
  withCrossWorkspaceGate,
  withCrossWorkspaceParam,
} = await import('../cross-workspace')
const { crossWorkspaceHeaders, runWithCrossWorkspace } = await import('../cross-workspace-scope')

const OWN = 'ws-personal'
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: OWN,
    config: { capabilityProfile: 'personal' },
    ...over,
  }) as any

/** A tool that records what it was asked to do, so the target is observable. */
function probeTool(name = 'board_summary') {
  const seen: Array<{ params: unknown; target: string | null; headers: Record<string, string> }> = []
  const tool: any = {
    name,
    label: 'Probe',
    description: 'probe',
    parameters: { type: 'object', properties: { board: { type: 'string' } } },
    execute: async (_id: string, params: any) => {
      seen.push({ params, target: crossWorkspaceTargetId(), headers: crossWorkspaceHeaders() })
      return { details: { ok: true } }
    },
  }
  return { tool, seen }
}

function engine(outcome: 'approved' | 'denied' | 'timeout' | 'unavailable') {
  const requests: any[] = []
  return {
    requests,
    requestApprovalOutcome: async (...args: any[]) => {
      requests.push(args)
      return outcome
    },
  } as any
}

beforeEach(() => {
  _resetCrossWorkspaceCacheForTests()
  minted.length = 0
  process.env.WORKSPACE_RUNTIME = 'true'
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
})

describe('the parameter is only on the Personal workspace agent', () => {
  test('enabled for a personal workspace runtime', () => {
    expect(crossWorkspaceEnabled(ctx())).toBe(true)
    const { tool } = probeTool()
    expect((withCrossWorkspaceParam(tool, ctx()).parameters as any).properties.workspace).toBeDefined()
  })

  test('a project agent never sees it', () => {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'proj-1'
    const { tool } = probeTool()
    expect((withCrossWorkspaceParam(tool, ctx()).parameters as any).properties.workspace).toBeUndefined()
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  })

  test('a team workspace agent never sees it', () => {
    const team = ctx({ config: { capabilityProfile: 'team' } })
    const { tool } = probeTool()
    expect(crossWorkspaceEnabled(team)).toBe(false)
    expect((withCrossWorkspaceParam(tool, team).parameters as any).properties.workspace).toBeUndefined()
  })
})

describe('resolveTargetWorkspace', () => {
  test('an exact name wins, ids and slugs too', async () => {
    expect((await resolveTargetWorkspace(ctx(), 'Odin AI', OWN) as any).workspaceId).toBe('ws-odin-ai')
    expect((await resolveTargetWorkspace(ctx(), 'samsara', OWN) as any).workspaceId).toBe('ws-samsara')
    expect((await resolveTargetWorkspace(ctx(), 'ws-nada', OWN) as any).workspaceId).toBe('ws-nada')
  })

  test('"odin" is ambiguous and never picks one', async () => {
    const r: any = await resolveTargetWorkspace(ctx(), 'odin', OWN)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('workspace_ambiguous')
    expect(r.candidates.map((c: any) => c.id).sort()).toEqual(['ws-odin-ai', 'ws-odin-labs', 'ws-odin-old'])
  })

  test('a name nobody has says so', async () => {
    const r: any = await resolveTargetWorkspace(ctx(), 'Nowhere', OWN)
    expect(r.code).toBe('workspace_not_found')
  })

  test('a workspace hosted on a desktop is desktop_offline, not an empty answer', async () => {
    const r: any = await resolveTargetWorkspace(ctx(), 'Serendipity', OWN)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('desktop_offline')
  })
})

describe('withCrossWorkspaceGate', () => {
  test('a call with no workspace is untouched', async () => {
    const { tool, seen } = probeTool()
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: engine('denied') })
    await gated.execute('c1', { board: 'Ops' })
    expect(seen[0].target).toBeNull()
  })

  test('a call naming its own workspace is untouched and asks nothing', async () => {
    const { tool, seen } = probeTool()
    const e = engine('denied')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    await gated.execute('c1', { workspace: 'ws-personal', board: 'Ops' })
    expect(e.requests.length).toBe(0)
    expect(seen[0].target).toBeNull()
  })

  test('a read runs in the target workspace without a prompt', async () => {
    const { tool, seen } = probeTool('board_summary')
    const e = engine('denied')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    const result = await gated.execute('c1', { workspace: 'Samsara Game', board: 'Games' })
    expect(e.requests.length).toBe(0)
    expect(seen[0].target).toBe('ws-samsara')
    expect((seen[0].params as any).workspace).toBeUndefined()
    expect((result as any).details.ok).toBe(true)
  })

  test('every write asks, and the approval travels on the call underneath', async () => {
    const { tool, seen } = probeTool('work_item_move')
    const e = engine('approved')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    const result = await gated.execute('c1', { workspace: 'Samsara Game', item: 'SAM-12', column: 'Done' })
    expect(e.requests.length).toBe(1)
    expect(seen[0].target).toBe('ws-samsara')
    expect(seen[0].headers['X-Cross-Workspace-Approval']).toBe('approval-1')
    expect(seen[0].headers['X-Cross-Workspace-Tool']).toBe('work_item_move')
    expect(minted[0]).toMatchObject({ targetWorkspaceId: 'ws-samsara', tool: 'work_item_move' })
    expect((result as any).details.ok).toBe(true)
  })

  test('a second identical write asks again', async () => {
    const { tool } = probeTool('work_item_move')
    const e = engine('approved')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    await gated.execute('c1', { workspace: 'Samsara Game', item: 'SAM-12', column: 'Done' })
    await gated.execute('c2', { workspace: 'Samsara Game', item: 'SAM-12', column: 'Done' })
    expect(e.requests.length).toBe(2)
    expect(minted.length).toBe(2)
  })

  test('one approval cannot be spent on other arguments', async () => {
    const { tool, seen } = probeTool('work_item_move')
    const e = engine('approved')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    await gated.execute('c1', { workspace: 'Samsara Game', item: 'SAM-12', column: 'Done' })
    await gated.execute('c2', { workspace: 'Samsara Game', item: 'SAM-13', column: 'Done' })
    expect(minted[0].argsHash).not.toBe(minted[1].argsHash)
    expect(seen.length).toBe(2)
  })

  test.each(['denied', 'timeout', 'unavailable'] as const)('%s maps to its own code and writes nothing', async (outcome) => {
    const { tool, seen } = probeTool('work_item_move')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: engine(outcome) })
    const result = await gated.execute('c1', { workspace: 'Samsara Game', item: 'SAM-12', column: 'Done' })
    const details: any = (result as any).details
    expect(details.code).toBe(
      outcome === 'denied' ? 'approval_denied' : outcome === 'timeout' ? 'approval_expired' : 'approval_required',
    )
    expect(seen.length).toBe(0)
    expect(minted.length).toBe(0)
  })

  test('an ambiguous name comes back with the candidates and runs nothing', async () => {
    const { tool, seen } = probeTool('board_summary')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: engine('approved') })
    const result = await gated.execute('c1', { workspace: 'odin', board: 'Ops' })
    const details: any = (result as any).details
    expect(details.code).toBe('workspace_ambiguous')
    expect(details.candidates.length).toBe(3)
    expect(seen.length).toBe(0)
  })

  test('a destructive tool refuses rather than prompting', async () => {
    const { tool, seen } = probeTool('schedule_delete')
    const e = engine('approved')
    const gated = withCrossWorkspaceGate({ tool, ctx: ctx(), workspaceId: OWN, engine: e })
    const result = await gated.execute('c1', { workspace: 'Nada', scheduleId: 's1' })
    expect((result as any).details.code).toBe('cross_workspace_unsupported')
    expect(e.requests.length).toBe(0)
    expect(seen.length).toBe(0)
  })

  test('the scope is available to the internals of the call and gone afterwards', async () => {
    expect(crossWorkspaceTargetId()).toBeNull()
    runWithCrossWorkspace({ workspaceId: 'ws-nada', tool: 'board_list' }, () => {
      expect(crossWorkspaceTargetId()).toBe('ws-nada')
      expect(crossWorkspaceHeaders()['X-Cross-Workspace-Tool']).toBe('board_list')
    })
    expect(crossWorkspaceTargetId()).toBeNull()
  })
})
