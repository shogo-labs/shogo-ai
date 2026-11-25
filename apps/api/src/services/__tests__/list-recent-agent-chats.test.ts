// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Service tests for `listRecentAgentChats` (AC §1).
 *
 * Uses a real SQLite database (desktop migration history) so the Prisma query
 * runs against an actual schema — mock-based tests can't catch column errors.
 *
 *   bun test apps/api/src/services/__tests__/list-recent-agent-chats.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb, seedWorkspace } from '../../__tests__/helpers/channels-test-db'

// Must run before any import that touches lib/prisma.
setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { listRecentAgentChats } = await import('../agent-chat.service')

// ─── constants ───────────────────────────────────────────────────────────────

const PROJECT_CALL_MSG = 'project_call'

// ─── helpers ─────────────────────────────────────────────────────────────────

async function mkSession(
  db: typeof prisma,
  overrides: {
    contextType: 'workspace' | 'project'
    workspaceId?: string
    contextId?: string
    createdByUserId?: string
    isArchived?: boolean
    isPinned?: boolean
    lastActiveAt?: Date
    activeTurnStartedAt?: Date
    activeTurnHeartbeatAt?: Date
  },
) {
  return db.chatSession.create({
    data: {
      contextType: overrides.contextType,
      ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
      ...(overrides.contextId ? { contextId: overrides.contextId } : {}),
      ...(overrides.createdByUserId ? { createdByUserId: overrides.createdByUserId } : {}),
      inferredName: "test session",
      isArchived: overrides.isArchived ?? false,
      isPinned: overrides.isPinned ?? false,
      lastActiveAt: overrides.lastActiveAt ?? new Date(),
      ...(overrides.activeTurnStartedAt
        ? { activeTurnId: `turn-${Math.random().toString(36).slice(2)}`, activeTurnStartedAt: overrides.activeTurnStartedAt }
        : {}),
      ...(overrides.activeTurnHeartbeatAt ? { activeTurnHeartbeatAt: overrides.activeTurnHeartbeatAt } : {}),
    },
  })
}

async function addUserMsg(db: typeof prisma, sessionId: string, userId: string, content = 'hello') {
  return db.chatMessage.create({
    data: { sessionId, role: 'user', content, authorUserId: userId },
  })
}

async function addPcMsg(db: typeof prisma, sessionId: string) {
  return db.chatMessage.create({
    data: { sessionId, role: 'user', content: 'pc', agent: PROJECT_CALL_MSG, authorUserId: null },
  })
}

// ─── seed ────────────────────────────────────────────────────────────────────

let seed: Awaited<ReturnType<typeof seedWorkspace>>

beforeAll(async () => {
  seed = await seedWorkspace(prisma)
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('listRecentAgentChats — real DB (AC §1)', () => {
  test('returns a workspace chat the caller owns', async () => {
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      createdByUserId: seed.owner,
    })
    await addUserMsg(prisma, sess.id, seed.owner)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 10 })
    expect(result.map((r) => r.chatSessionId)).toContain(sess.id)
  })

  test('AC§1 exclusion: another member workspace chat is not returned', async () => {
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      createdByUserId: seed.member, // member owns this, not owner
    })
    await addUserMsg(prisma, sess.id, seed.member)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).not.toContain(sess.id)
  })

  test('AC§1 exclusion: project chat in a project the caller cannot see is not returned', async () => {
    // foreignProjectId belongs to another workspace entirely — caller can't see it.
    // Project sessions have createdByUserId null; authorship is tracked via ChatMessage.authorUserId.
    const sess = await mkSession(prisma, {
      contextType: 'project',
      contextId: seed.foreignProjectId,
    })
    await addUserMsg(prisma, sess.id, seed.owner)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).not.toContain(sess.id)
  })

  test('AC§1 exclusion: project_call-only session is not returned', async () => {
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      createdByUserId: seed.owner,
    })
    await addPcMsg(prisma, sess.id) // only project_call messages — no real user message

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).not.toContain(sess.id)
  })

  test('AC§1 exclusion: archived session is not returned', async () => {
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      createdByUserId: seed.owner,
      isArchived: true,
    })
    await addUserMsg(prisma, sess.id, seed.owner)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).not.toContain(sess.id)
  })

  test('AC§1 exclusion: workspace chat anchored to a project (contextId set) is included when owned by caller', async () => {
    // A workspace session CAN carry a contextId (the anchor project) and must
    // still appear — it is contextType:'workspace', not a project session.
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      contextId: seed.projectId, // anchor
      createdByUserId: seed.owner,
    })
    await addUserMsg(prisma, sess.id, seed.owner)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).toContain(sess.id)
    const item = result.find((r) => r.chatSessionId === sess.id)!
    expect(item.agentKey).toBe('ws')
    expect(item.projectId).toBeNull()
  })

  test('AC§1 perAgent=true returns at most one session per agent', async () => {
    // Use a fresh isolated workspace + user to avoid contamination from other tests.
    const ws = await prisma.workspace.create({
      data: { name: 'PerAgent', slug: `pa-${Date.now()}`, kind: 'team' },
    })
    const user = await prisma.user.create({
      data: { name: 'pauser', email: `pauser-${Date.now()}@example.com` },
    })
    await prisma.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })

    const t = new Date()
    const ws1 = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      lastActiveAt: new Date(t.getTime() - 1000),
    })
    const ws2 = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      lastActiveAt: new Date(t.getTime() - 2000),
    })
    await addUserMsg(prisma, ws1.id, user.id)
    await addUserMsg(prisma, ws2.id, user.id)

    const result = await listRecentAgentChats(ws.id, user.id, { limit: 10, perAgent: true })
    const wsKeys = result.filter((r) => r.agentKey === 'ws')
    expect(wsKeys).toHaveLength(1)
    expect(wsKeys[0].chatSessionId).toBe(ws1.id) // newest first
  })

  test('project chat has agentKey = projectId and correct projectId', async () => {
    // createdByUserId is null for project sessions; authorship via ChatMessage.
    const sess = await mkSession(prisma, {
      contextType: 'project',
      contextId: seed.projectId,
    })
    await addUserMsg(prisma, sess.id, seed.owner)

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 10 })
    const item = result.find((r) => r.chatSessionId === sess.id)
    expect(item).toBeDefined()
    expect(item!.projectId).toBe(seed.projectId)
    expect(item!.agentKey).toBe(seed.projectId)
  })

  test('AC§1 exclusion: project chat where only another member wrote is excluded', async () => {
    // The session is in a visible project but seed.owner never sent a message in it.
    const sess = await mkSession(prisma, {
      contextType: 'project',
      contextId: seed.projectId,
    })
    await addUserMsg(prisma, sess.id, seed.member) // member wrote, not owner

    const result = await listRecentAgentChats(seed.workspaceId, seed.owner, { limit: 100 })
    expect(result.map((r) => r.chatSessionId)).not.toContain(sess.id)
  })

    test('preview is trimmed to 120 chars', async () => {
    const longText = 'a'.repeat(200)
    const sess = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: seed.workspaceId,
      createdByUserId: seed.viewer,
    })
    await addUserMsg(prisma, sess.id, seed.viewer, longText)

    const result = await listRecentAgentChats(seed.workspaceId, seed.viewer, { limit: 10 })
    const item = result.find((r) => r.chatSessionId === sess.id)
    expect(item).toBeDefined()
    expect(item!.preview!.length).toBeLessThanOrEqual(120)
  })

  test('limit caps the returned list', async () => {
    // Seed 4 sessions for outsider (fresh, isolated)
    const outsiderWs = await prisma.workspace.create({
      data: { name: 'Cap Test', slug: `cap-test-${Date.now()}`, kind: 'team' },
    })
    const outsiderUser = await prisma.user.create({
      data: { name: 'capuser', email: `capuser-${Date.now()}@example.com` },
    })
    await prisma.member.create({ data: { userId: outsiderUser.id, workspaceId: outsiderWs.id, role: 'owner' } })
    for (let i = 0; i < 4; i++) {
      const s = await mkSession(prisma, {
        contextType: 'workspace',
        workspaceId: outsiderWs.id,
        createdByUserId: outsiderUser.id,
        lastActiveAt: new Date(Date.now() - i * 1000),
      })
      await addUserMsg(prisma, s.id, outsiderUser.id)
    }

    const result = await listRecentAgentChats(outsiderWs.id, outsiderUser.id, { limit: 2 })
    expect(result).toHaveLength(2)
  })

  test('isPinned and running describe the row', async () => {
    const ws = await prisma.workspace.create({
      data: { name: 'Tray', slug: `tray-${Date.now()}`, kind: 'team' },
    })
    const user = await prisma.user.create({
      data: { name: 'trayuser', email: `trayuser-${Date.now()}@example.com` },
    })
    await prisma.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })

    const pinned = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      isPinned: true,
    })
    await addUserMsg(prisma, pinned.id, user.id)

    const running = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      lastActiveAt: new Date(Date.now() - 5_000),
      activeTurnStartedAt: new Date(),
      activeTurnHeartbeatAt: new Date(),
    })
    await addUserMsg(prisma, running.id, user.id)

    // A turn whose heartbeat is older than the running window is not running,
    // even though activeTurnId is still set (SHO-494's leak).
    const stale = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      lastActiveAt: new Date(Date.now() - 10_000),
      activeTurnStartedAt: new Date(Date.now() - 10 * 60 * 1000),
      activeTurnHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
    })
    await addUserMsg(prisma, stale.id, user.id)

    const result = await listRecentAgentChats(ws.id, user.id, { limit: 10 })
    const byId = new Map(result.map((r) => [r.chatSessionId, r]))
    expect(byId.get(pinned.id)!.isPinned).toBe(true)
    expect(byId.get(pinned.id)!.running).toBe(false)
    expect(byId.get(running.id)!.isPinned).toBe(false)
    expect(byId.get(running.id)!.running).toBe(true)
    expect(byId.get(stale.id)!.running).toBe(false)
  })

  test('includePinned returns a pinned chat older than the limit', async () => {
    const ws = await prisma.workspace.create({
      data: { name: 'Pinned Order', slug: `pinned-order-${Date.now()}`, kind: 'team' },
    })
    const user = await prisma.user.create({
      data: { name: 'pinuser', email: `pinuser-${Date.now()}@example.com` },
    })
    await prisma.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })

    const old = new Date(Date.now() - 60_000)
    const pinnedOld = await mkSession(prisma, {
      contextType: 'workspace',
      workspaceId: ws.id,
      createdByUserId: user.id,
      isPinned: true,
      lastActiveAt: old,
    })
    await addUserMsg(prisma, pinnedOld.id, user.id)
    for (let i = 0; i < 2; i++) {
      const newer = await mkSession(prisma, {
        contextType: 'workspace',
        workspaceId: ws.id,
        createdByUserId: user.id,
        lastActiveAt: new Date(Date.now() - i * 1000),
      })
      await addUserMsg(prisma, newer.id, user.id)
    }

    // limit 2 is filled by the two newer chats, so the pinned one only shows up
    // when the caller asks for pinned chats.
    const without = await listRecentAgentChats(ws.id, user.id, { limit: 2 })
    expect(without.map((r) => r.chatSessionId)).not.toContain(pinnedOld.id)

    const withPinned = await listRecentAgentChats(ws.id, user.id, { limit: 2, includePinned: true })
    expect(withPinned.map((r) => r.chatSessionId)).toContain(pinnedOld.id)
    expect(withPinned[0].chatSessionId).toBe(pinnedOld.id)
  })
})
