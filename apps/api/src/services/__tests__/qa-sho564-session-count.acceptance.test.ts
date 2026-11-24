// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-564, cause 2 — the workspace chat list took 5.5 s
 * because `listWorkspaceSessions` counted messages with a Prisma `_count`
 * relation include, which Postgres turns into a nested loop that re-aggregates
 * `chat_messages_sessionId_idx` (404k rows) once per session: 6.86 s on the
 * prod replica for a 124-chat workspace.
 *
 * The dev's unit test mocks Prisma, so it can only prove which query shape the
 * service *asks* for. This one drives the real SQLite database (the desktop
 * migration track) through the production entry point and checks the answer
 * the phone reads — `messageCount` for every session, including chats that
 * were created and never used, which is what lets the landing screen reuse an
 * empty chat instead of minting another one.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'

const { setupChannelsTestDb } = await import('../../__tests__/helpers/channels-test-db')
const testDb = setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { seedWorkspace } = await import('../../__tests__/helpers/channels-test-db')
const svc = await import('../workspace-session.service')

let seeded: Awaited<ReturnType<typeof seedWorkspace>>

/** Strictly increasing so `orderBy lastActiveAt desc` is unambiguous. */
let tick = 0
function at(): Date {
  tick += 1
  return new Date(Date.UTC(2026, 10, 24, 9, 0, 0) + tick * 1000)
}

async function makeSession(over: Record<string, unknown> = {}) {
  return prisma.chatSession.create({
    data: {
      inferredName: 'Chat',
      contextType: 'workspace',
      workspaceId: seeded.workspaceId,
      createdByUserId: seeded.owner,
      lastActiveAt: at(),
      ...over,
    } as any,
  })
}

async function addMessages(sessionId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await prisma.chatMessage.create({
      data: { sessionId, role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, createdAt: at() },
    })
  }
}

beforeAll(async () => {
  // The seeds below are dated 2026-11-24T09:00Z and the list is ordered by
  // `lastActiveAt`; pin "now" to the same day so no later assertion can start
  // comparing these fixtures against a wall clock that has moved on.
  setSystemTime(new Date('2026-11-24T12:00:00Z'))
  seeded = await seedWorkspace(prisma)
})

afterAll(async () => {
  setSystemTime()
  await prisma.$disconnect().catch(() => {})
  // The database file lives in a temp dir created by the helper.
  void testDb
})

describe('GET /workspaces/:id/sessions — message counts without the _count include', () => {
  it('counts each chat once, keeps zero-message chats at 0, and keeps the row shape', async () => {
    const used = await makeSession({ inferredName: 'Deploy triage' })
    await addMessages(used.id, 5)
    const oneMessage = await makeSession({ inferredName: 'Quick question' })
    await addMessages(oneMessage.id, 1)
    // Created, never written to: the landing screen must be able to reuse it.
    const neverUsed = await makeSession({ inferredName: 'Empty' })
    // Another person's chat in the same workspace must not leak into the list.
    const someoneElse = await makeSession({ inferredName: 'Not mine', createdByUserId: seeded.member })
    await addMessages(someoneElse.id, 2)
    // Messages that belong to a chat outside this list must not be counted
    // into any row it returns (the grouped query is filtered by session id).
    const otherWorkspaceSession = await makeSession({
      inferredName: 'Other workspace',
      workspaceId: seeded.otherWorkspaceId,
      createdByUserId: seeded.owner,
    })
    await addMessages(otherWorkspaceSession.id, 9)

    const sessions = await svc.listWorkspaceSessions(seeded.workspaceId, seeded.owner)
    const byName = new Map(sessions.map((row: any) => [row.inferredName, row]))

    expect([...byName.keys()].sort()).toEqual(['Deploy triage', 'Empty', 'Quick question'])
    expect(byName.get('Deploy triage')!.messageCount).toBe(5)
    expect(byName.get('Quick question')!.messageCount).toBe(1)
    expect(byName.get('Empty')!.messageCount).toBe(0)

    // Newest last activity first: the list is ordered for the chat picker.
    expect(sessions[0].inferredName).toBe('Empty')

    // Same response shape as before the query change — `_count` never leaks
    // out and `attachedProjects` is still there for the client.
    for (const row of sessions as any[]) {
      expect(row).not.toHaveProperty('_count')
      expect(Array.isArray(row.attachedProjects)).toBe(true)
      expect(typeof row.messageCount).toBe('number')
      expect(typeof row.id).toBe('string')
      expect(row.workspaceId).toBe(seeded.workspaceId)
    }
  })

  it('a workspace with no chats answers with an empty list', async () => {
    expect(await svc.listWorkspaceSessions(seeded.otherWorkspaceId, seeded.member)).toEqual([])
  })

  it('attaches projects without disturbing the count', async () => {
    const attached = await makeSession({ inferredName: 'Attached' })
    await addMessages(attached.id, 3)
    await prisma.chatSessionProject.create({
      data: { sessionId: attached.id, projectId: seeded.projectId, attachMode: 'readwrite' },
    })

    const sessions = await svc.listWorkspaceSessions(seeded.workspaceId, seeded.owner)
    const row = sessions.find((s: any) => s.id === attached.id) as any
    expect(row.messageCount).toBe(3)
    expect(row.attachedProjects.map((p: any) => p.projectId)).toEqual([seeded.projectId])
  })
})
