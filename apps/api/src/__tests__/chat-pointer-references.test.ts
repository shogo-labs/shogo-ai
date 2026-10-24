// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-191: in the workspace chat a tagged chat is a *pointer*, not a send.
 *
 * The tag has to reach the agent as "this chat, here is where it lives, read it
 * with read_history" and carry no transcript; and the `read_history` call that
 * pointer hands it has to work for a chat in another workspace the person can
 * open, while a chat they cannot open stays a 404.
 */

import { describe, expect, mock, test } from 'bun:test'

type SessionRow = {
  id: string
  name: string
  inferredName: null
  contextType: string
  contextId: string | null
  workspaceId: string
  isArchived: boolean
  lastActiveAt: Date
  createdByUserId: null
  activeTurnId: null
  project: { id: string; name: string; workspaceId: string; workspace: { name: string } } | null
  workspace: { id: string; name: string }
}

const session = (overrides: Partial<SessionRow> & { id: string }): SessionRow => ({
  name: overrides.id,
  inferredName: null,
  contextType: 'workspace',
  contextId: null,
  workspaceId: 'ws-1',
  isArchived: false,
  lastActiveAt: new Date('2026-10-19T12:00:00Z'),
  createdByUserId: null,
  activeTurnId: null,
  project: null,
  workspace: { id: overrides.workspaceId ?? 'ws-1', name: 'Acme' },
  ...overrides,
})

/** A chat in the workspace we are typing in. */
const here = session({ id: 'chat-here', name: 'Here and now' })
/** A chat in another workspace the person belongs to, anchored on a project. */
const elsewhere = session({
  id: 'chat-elsewhere',
  name: 'Deploy notes',
  workspaceId: 'ws-2',
  workspace: { id: 'ws-2', name: 'Other team' },
  project: { id: 'proj-2', name: 'Billing', workspaceId: 'ws-2', workspace: { name: 'Other team' } },
})

const openable = [here, elsewhere]
const byId = (id: string) => openable.find((row) => row.id === id)

const messagesFor = (sessionId: string) => [
  { role: 'user', content: `ask in ${sessionId}`, createdAt: new Date('2026-10-19T11:58:00Z') },
  { role: 'assistant', content: `answer about ${sessionId}`, createdAt: new Date('2026-10-19T12:00:00Z') },
]

mock.module('../lib/authz', () => ({
  accessibleProjectsWhere: async () => ({ id: { in: ['proj-1', 'proj-2'] } }),
  loadAccess: async () => ({ permissions: new Set(['project:read']) }),
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async () => ({ id: 'member-1' }),
      findMany: async () => [{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }],
    },
    user: { findUnique: async () => ({ role: 'user' }) },
    project: { findMany: async () => [{ id: 'proj-1' }], findUnique: async () => null },
    workspace: { findUnique: async () => ({ name: 'Acme', slug: 'acme', description: null }) },
    chatSession: {
      findFirst: async (args: any) => {
        const id: string = args?.where?.id ?? args?.where?.AND?.[0]?.id ?? ''
        // The workspace-scoped render path (renderWorkspaceTranscript) only sees
        // chats of the workspace it was asked about.
        if (args?.where?.OR) return id === here.id ? { ...here, messages: messagesFor(id) } : null
        // resolveChatForUser: the cross-workspace access rule.
        return byId(id) ?? null
      },
    },
    chatMessage: {
      findMany: async (args: any) => messagesFor(args?.where?.sessionId ?? '').slice(0, args?.take ?? 100),
      count: async () => 2,
    },
  },
}))

const { enrichChatReferences } = await import('../lib/chat-references')
const { readRuntimeChatTranscript } = await import('../lib/history-search')

const pointerBody = (id: string) => ({ references: [{ type: 'chat', id, label: `@${id}` }] })

describe('pointer-mode chat references', () => {
  test('name the chat and how to read it, and inline no transcript', async () => {
    const body = pointerBody(elsewhere.id)
    expect(await enrichChatReferences(body, 'user-1', 'ws-1', { mode: 'pointer' })).toBe(true)

    const ref: any = body.references[0]
    expect(ref).toMatchObject({
      type: 'chat',
      id: 'chat-elsewhere',
      name: 'Deploy notes',
      pointer: true,
      projectId: 'proj-2',
      projectName: 'Billing',
      workspaceId: 'ws-2',
      workspaceName: 'Other team',
      messageCount: 2,
    })
    expect(typeof ref.lastActivityAt).toBe('string')
    // The whole point: no transcript travels with the turn.
    expect(ref.transcript).toBeUndefined()
  })

  test('drop a chat the person cannot open, like tagging does today', async () => {
    const body = { references: [{ type: 'chat', id: 'not-mine' }] }
    expect(await enrichChatReferences(body, 'user-1', 'ws-1', { mode: 'pointer' })).toBe(true)
    expect(body.references).toHaveLength(0)
  })

  test('the inline mode project chat still uses keeps the transcript', async () => {
    const body = pointerBody(elsewhere.id)
    expect(await enrichChatReferences(body, 'user-1', 'ws-1')).toBe(true)
    const ref: any = body.references[0]
    expect(ref.transcript).toContain('ask in chat-elsewhere')
    expect(ref.pointer).toBeUndefined()
  })
})

describe('read_history for a tagged chat', () => {
  test('reads a chat of this workspace as before', async () => {
    const transcript = await readRuntimeChatTranscript(here.id, { workspaceId: 'ws-1', userId: 'user-1' })
    expect(transcript?.sessionId).toBe(here.id)
    expect(transcript?.title).toBe('Here and now')
    expect(transcript?.messages[0].text).toContain('chat-here')
  })

  test('falls back to a chat in another workspace the person can open', async () => {
    const transcript = await readRuntimeChatTranscript(elsewhere.id, {
      workspaceId: 'ws-1',
      userId: 'user-1',
    })
    expect(transcript?.sessionId).toBe('chat-elsewhere')
    expect(transcript?.title).toBe('Deploy notes')
    expect(transcript?.projectId).toBe('proj-2')
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      'ask in chat-elsewhere',
      'answer about chat-elsewhere',
    ])
    // Same shape the in-workspace path returns, so the agent reads one format.
    expect(transcript?.messages[0].createdAt).toBe('2026-10-19T11:58:00.000Z')
  })

  test('404s (null) for a chat the person cannot open', async () => {
    expect(
      await readRuntimeChatTranscript('not-mine', { workspaceId: 'ws-1', userId: 'user-1' }),
    ).toBeNull()
  })

  test('no fallback without an identity to check against', async () => {
    expect(await readRuntimeChatTranscript(elsewhere.id, { workspaceId: 'ws-1' })).toBeNull()
  })
})
