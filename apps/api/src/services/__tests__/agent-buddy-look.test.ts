// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's Shogo buddy look: who may change it, validation, reset, and that
 * the agent card and mentionables report it.
 *
 *   bun test apps/api/src/services/__tests__/agent-buddy-look.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const s = {
  role: 'member' as string | null,
  project: { id: 'p1', name: 'Docs bot', description: 'Writes docs', createdBy: 'creator', buddyLook: null as string | null },
  profile: { name: 'Shogo', tagline: 'Workspace agent', buddyLook: null as string | null, avatarUrl: null as string | null },
  projectUpdates: [] as any[],
  profileUpserts: [] as any[],
  events: [] as any[],
}

mock.module('../../lib/prisma', () => withPrismaExports({
  prisma: {
    member: {
      findFirst: async () => (s.role ? { role: s.role } : null),
      findMany: async () => (s.role ? [{ role: s.role, workspaceId: 'w1', projectId: null, isBillingAdmin: false }] : []),
    },
    project: {
      findFirst: async (args: any) => (args.where.id === s.project.id ? s.project : null),
      findUnique: async () => ({ id: s.project.id, workspaceId: 'w1', visibility: 'workspace', thumbnailUrl: null }),
      findMany: async () => [s.project],
      update: async (args: any) => {
        s.projectUpdates.push(args)
        s.project.buddyLook = args.data.buddyLook
        return s.project
      },
    },
    workspaceAgentProfile: {
      findUnique: async () => s.profile,
      upsert: async (args: any) => {
        s.profileUpserts.push(args)
        return s.profile
      },
    },
    user: { findUnique: async () => ({ id: 'creator', name: 'Casey', email: 'c@example.com' }) },
    conversationMember: { findMany: async () => [] },
  },
}))

mock.module('../../lib/conversation-bus', () => ({
  publishConversationEvent: (workspaceId: string, event: any) => {
    s.events.push({ workspaceId, event })
  },
}))

const { setAgentBuddyLook, loadAgentCard, agentKeyToProjectId } = await import('../conversation-directory')
const { listMentionables } = await import('../conversation.service')

const WIZARD = {
  topper: 'wizard', face: 'classic', tail: 'none', eyewear: 'none', neck: 'none',
  bolts: false, blush: true, color: '#7c3aed', finish: 'classic',
}

beforeEach(() => {
  s.role = 'member'
  s.project.buddyLook = null
  s.profile.buddyLook = null
  s.projectUpdates = []
  s.profileUpserts = []
  s.events = []
})

describe('agentKeyToProjectId', () => {
  test('maps ws, bare ids and mention keys', () => {
    expect(agentKeyToProjectId('ws')).toBeNull()
    expect(agentKeyToProjectId('p1')).toBe('p1')
    expect(agentKeyToProjectId('p:p1')).toBe('p1')
  })
})

describe('setAgentBuddyLook', () => {
  test('lets the project creator save a look, normalised and announced', async () => {
    const res = await setAgentBuddyLook('w1', 'creator', 'p1', WIZARD)
    expect(res.buddyLook?.color).toBe('#7C3AED')
    expect(JSON.parse(s.projectUpdates[0].data.buddyLook).topper).toBe('wizard')
    expect(s.events).toEqual([{ workspaceId: 'w1', event: { type: 'agent.updated', projectId: 'p1' } }])
  })

  test('lets workspace admins and owners save', async () => {
    s.role = 'admin'
    await setAgentBuddyLook('w1', 'someone', 'p1', WIZARD)
    s.role = 'owner'
    await setAgentBuddyLook('w1', 'someone', 'p:p1', WIZARD)
    expect(s.projectUpdates).toHaveLength(2)
  })

  test('rejects other members', async () => {
    await expect(setAgentBuddyLook('w1', 'someone', 'p1', WIZARD)).rejects.toMatchObject({ status: 403 })
    expect(s.projectUpdates).toHaveLength(0)
    expect(s.events).toHaveLength(0)
  })

  test('rejects invalid looks before touching anything', async () => {
    s.role = 'owner'
    await expect(setAgentBuddyLook('w1', 'someone', 'p1', { ...WIZARD, topper: 'jetpack' })).rejects.toMatchObject({ status: 400 })
    await expect(setAgentBuddyLook('w1', 'someone', 'p1', { ...WIZARD, extra: 1 })).rejects.toMatchObject({ status: 400 })
    expect(s.projectUpdates).toHaveLength(0)
  })

  test('null resets to the generated look', async () => {
    s.role = 'owner'
    const res = await setAgentBuddyLook('w1', 'someone', 'p1', null)
    expect(res.buddyLook).toBeNull()
    expect(s.projectUpdates[0].data.buddyLook).toBeNull()
  })

  test('404s for a project outside the workspace', async () => {
    s.role = 'owner'
    await expect(setAgentBuddyLook('w1', 'someone', 'nope', WIZARD)).rejects.toMatchObject({ status: 404 })
  })

  test('the workspace agent is admin-only, even for a project creator', async () => {
    await expect(setAgentBuddyLook('w1', 'creator', 'ws', WIZARD)).rejects.toMatchObject({ status: 403 })
    s.role = 'admin'
    await setAgentBuddyLook('w1', 'someone', 'ws', WIZARD)
    expect(s.profileUpserts[0].where).toEqual({ workspaceId: 'w1' })
    expect(s.events[0].event.projectId).toBeNull()
  })
})

describe('reading a look', () => {
  test('the agent card carries the look and whether the viewer can edit it', async () => {
    s.project.buddyLook = JSON.stringify(WIZARD)
    const asCreator = await loadAgentCard('w1', 'p1', 'creator')
    expect(asCreator?.buddyLook?.topper).toBe('wizard')
    expect(asCreator?.canEdit).toBe(true)
    const asMember = await loadAgentCard('w1', 'p1', 'someone')
    expect(asMember?.canEdit).toBe(false)
    s.role = 'admin'
    expect((await loadAgentCard('w1', 'p1', 'someone'))?.canEdit).toBe(true)
  })

  test('an unset or corrupt look reads as null', async () => {
    expect((await loadAgentCard('w1', 'p1', 'creator'))?.buddyLook).toBeNull()
    s.project.buddyLook = '{not json'
    expect((await loadAgentCard('w1', 'p1', 'creator'))?.buddyLook).toBeNull()
  })

  test('mentionables list each agent with its look', async () => {
    s.project.buddyLook = JSON.stringify(WIZARD)
    const { agents } = await listMentionables('w1', 'someone')
    expect(agents.find((a: any) => a.key === 'ws')?.buddyLook).toBeNull()
    expect(agents.find((a: any) => a.key === 'p:p1')?.buddyLook?.topper).toBe('wizard')
  })
})
