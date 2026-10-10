// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, test } from 'bun:test'
import { REQUESTER_TICKET_HEADER, signRequesterTicket, workspaceTicketKey } from '../requester-ticket'
import { resolveAgentActor } from '../authz/agent-actor'
import { _setRbacModeForTests } from '../authz/mode'

function ctx(ticket?: string) {
  return {
    req: {
      header: (name: string) => (name === REQUESTER_TICKET_HEADER ? ticket : undefined),
    },
  } as any
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'ticket-secret'
  _setRbacModeForTests('on')
})

describe('resolveAgentActor', () => {
  test('a valid workspace ticket wins over a forged userId', async () => {
    const ticket = signRequesterTicket({ projectId: workspaceTicketKey('ws-1'), userId: 'viewer' })
    const actor = await resolveAgentActor(
      ctx(ticket),
      { kind: 'workspace', workspaceId: 'ws-1' },
      { workspaceId: 'ws-1', claimedUserId: 'owner' },
    )
    expect(actor).toMatchObject({ source: 'ticket', principal: { userId: 'viewer' } })
  })

  test('a service account uses the claimed user, or stays unscoped', async () => {
    const named = await resolveAgentActor(ctx(), { kind: 'sa' }, { workspaceId: 'ws-1', claimedUserId: 'ops' })
    expect(named).toMatchObject({ source: 'claim', principal: { userId: 'ops' } })
    const bare = await resolveAgentActor(ctx(), { kind: 'sa' }, { workspaceId: 'ws-1' })
    expect(bare?.unscoped).toBe(true)
    expect(bare?.principal.userId).toBeUndefined()
  })

  test('a workspace runtime claim is ignored when enforcement is on', async () => {
    expect(
      await resolveAgentActor(
        ctx(),
        { kind: 'workspace', workspaceId: 'ws-1' },
        { workspaceId: 'ws-1', claimedUserId: 'owner' },
      ),
    ).toBeNull()
  })

  test('a workspace runtime claim is used and logged while enforcement is shadow', async () => {
    _setRbacModeForTests('shadow')
    const warnings: unknown[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const actor = await resolveAgentActor(
        ctx(),
        { kind: 'workspace', workspaceId: 'ws-1' },
        { workspaceId: 'ws-1', claimedUserId: 'member' },
      )
      expect(actor).toMatchObject({ source: 'claim', principal: { userId: 'member' } })
      expect(JSON.stringify(warnings)).toContain('agent_claim_untrusted')
    } finally {
      console.warn = orig
      _setRbacModeForTests(null)
    }
  })

  test('a project ticket in this workspace wins over the project creator', async () => {
    const ticket = signRequesterTicket({ projectId: 'proj-1', userId: 'viewer' })
    const actor = await resolveAgentActor(
      ctx(ticket),
      { kind: 'project', projectId: 'proj-1' },
      {
        workspaceId: 'ws-1',
        claimedUserId: 'owner',
        lookupProjectWorkspace: async () => 'ws-1',
        lookupProjectCreator: async () => 'owner',
      },
    )
    expect(actor).toMatchObject({ source: 'ticket', principal: { userId: 'viewer' } })
  })

  test('a project runtime with no ticket acts as the project creator', async () => {
    const actor = await resolveAgentActor(
      ctx(),
      { kind: 'project', projectId: 'proj-1' },
      { workspaceId: 'ws-1', claimedUserId: 'someone-else', lookupProjectCreator: async () => 'creator-1' },
    )
    expect(actor).toMatchObject({ source: 'creator', principal: { userId: 'creator-1' } })
  })

  test('a project ticket for another workspace is not this workspace\'s actor', async () => {
    const ticket = signRequesterTicket({ projectId: 'proj-other', userId: 'intruder' })
    const actor = await resolveAgentActor(
      ctx(ticket),
      { kind: 'workspace', workspaceId: 'ws-1' },
      { workspaceId: 'ws-1', lookupProjectWorkspace: async () => 'ws-other' },
    )
    expect(actor).toBeNull()
  })

  test('a workspace runtime with nobody to act as does not become the workspace owner', async () => {
    _setRbacModeForTests('shadow')
    try {
      expect(
        await resolveAgentActor(ctx(), { kind: 'workspace', workspaceId: 'ws-1' }, { workspaceId: 'ws-1' }),
      ).toBeNull()
    } finally {
      _setRbacModeForTests(null)
    }
  })
})
