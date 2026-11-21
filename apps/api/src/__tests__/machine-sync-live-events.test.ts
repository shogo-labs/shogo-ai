// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-486 — synced rows must reach the clients watching the cloud.
 *
 * A hosted workspace's channel reply is written on the desktop and arrives in
 * Postgres as a machine-sync row. Nothing on that path used to publish to the
 * conversation bus, so the reply existed and nobody was told: the person saw it
 * after a refresh, and only then. This pins the insert point — the batch apply —
 * against the real service and a real database:
 *
 *   - a message the cloud has never seen is announced as `message.created`
 *   - a message the cloud already had is announced as `message.updated`
 *   - a reaction announces the message it changed
 *   - a private channel keeps its audience rule
 *   - a refused batch announces nothing
 *
 * Needs `CHANNELS_TEST_PG_URL` (the cloud schema, not the desktop's); skipped
 * without it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const describeIfPg = PG_URL ? describe : describe.skip

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const { applyBatch } = await import('../lib/machine-sync/ingest')

const db = prisma as any
const suffix = crypto.randomUUID().slice(0, 8)
const OWNER = `owner-${suffix}`
const INSTANCE = `inst-${suffix}`
const HOSTED = `ws-hosted-${suffix}`
const ELSEWHERE = `ws-elsewhere-${suffix}`
const PUBLIC = `conv-public-${suffix}`
const PRIVATE = `conv-private-${suffix}`

const seen: Array<{ workspaceId: string; event: any; audience: string[] | null }> = []
let unsubscribe: (() => void) | null = null

interface Row {
  [key: string]: unknown
}

function messageRow(overrides: Row): Row {
  const now = new Date()
  return {
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'user',
    authorUserId: OWNER,
    authorAgentRef: null,
    botId: null,
    blocks: null,
    clientMsgId: null,
    agentSessionId: null,
    agentStatus: null,
    externalRef: null,
    externalThreadRef: null,
    agentChain: null,
    editedAt: null,
    deletedAt: null,
    createdAt: now.toISOString(),
    updatedAt: new Date(now.getTime()).toISOString(),
    ...overrides,
  }
}

/** One pushed batch, as the desktop's pusher sends it. */
function batch(rows: Row[], extra: { conversationId?: string; workspaceId?: string } = {}) {
  return {
    mode: 'snapshot' as const,
    epoch: `epoch-${suffix}`,
    models: [{ model: 'ConversationMessage', rows }],
    snapshot: { complete: true, models: ['ConversationMessage'] },
    ...extra,
  }
}

async function apply(body: any) {
  return applyBatch(
    { prisma, instanceId: INSTANCE, ownerUserId: OWNER, homeRegion: 'fra-1' },
    body,
  )
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  await db.user.create({ data: { id: OWNER, email: `${OWNER}@shogo.test`, name: 'Owner' } })
  for (const [id, name] of [
    [HOSTED, 'Laptop'],
    [ELSEWHERE, 'Someone else'],
  ] as const) {
    await db.workspace.create({
      data: {
        id,
        name,
        slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
        kind: 'team',
        hostInstanceId: id === HOSTED ? INSTANCE : `inst-other-${suffix}`,
      },
    })
    await db.member.create({ data: { userId: OWNER, workspaceId: id, role: 'owner' } })
  }
  await db.conversation.create({
    data: { id: PUBLIC, workspaceId: HOSTED, kind: 'public', name: 'general', slug: 'general' },
  })
  await db.conversation.create({
    data: { id: PRIVATE, workspaceId: HOSTED, kind: 'private', name: 'secret', slug: 'secret' },
  })
  await db.conversationMember.create({
    data: { conversationId: PRIVATE, memberType: 'user', userId: OWNER, role: 'member' },
  })

  unsubscribe = bus.subscribeWorkspaceEvents(HOSTED, (envelope) => {
    seen.push({ workspaceId: envelope.workspaceId, event: envelope.event, audience: envelope.audience })
  })
})

afterAll(async () => {
  unsubscribe?.()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describeIfPg('a synced message reaches the cloud conversation bus (SHO-486)', () => {
  test('a message the cloud has never seen is announced as message.created', async () => {
    seen.length = 0
    const id = `msg-new-${suffix}`
    const result: any = await apply(
      batch([messageRow({ id, conversationId: PUBLIC, workspaceId: HOSTED, seq: 1, text: 'reply from the desktop' })]),
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(result.applied).toBe(1)

    const created = seen.filter((entry) => entry.event.type === 'message.created')
    expect(created.length, `bus saw ${JSON.stringify(seen.map((s) => s.event.type))}`).toBe(1)
    expect(created[0].workspaceId).toBe(HOSTED)
    expect(created[0].event.conversationId).toBe(PUBLIC)
    expect(created[0].event.message.id).toBe(id)
    expect(created[0].event.message.text).toBe('reply from the desktop')
    // A public channel is open to the workspace: no per-user filter.
    expect(created[0].audience).toBeNull()
  })

  test('a message the cloud already had is announced as message.updated', async () => {
    seen.length = 0
    const id = `msg-existing-${suffix}`
    await db.conversationMessage.create({
      data: {
        id,
        conversationId: PUBLIC,
        workspaceId: HOSTED,
        seq: 2,
        authorType: 'agent',
        text: 'streaming…',
        createdAt: new Date(Date.now() - 5_000),
        updatedAt: new Date(Date.now() - 5_000),
      },
    })

    const result: any = await apply(
      batch([
        messageRow({
          id,
          conversationId: PUBLIC,
          workspaceId: HOSTED,
          seq: 2,
          authorType: 'agent',
          text: 'the finished reply',
          agentStatus: 'done',
        }),
      ]),
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const updated = seen.filter((entry) => entry.event.type === 'message.updated')
    expect(updated.length).toBe(1)
    expect(updated[0].event.message.id).toBe(id)
    expect(updated[0].event.message.text).toBe('the finished reply')
    expect(seen.filter((entry) => entry.event.type === 'message.created')).toEqual([])
  })

  test('a reaction announces the message it changed', async () => {
    seen.length = 0
    const id = `msg-reacted-${suffix}`
    await db.conversationMessage.create({
      data: {
        id,
        conversationId: PUBLIC,
        workspaceId: HOSTED,
        seq: 3,
        authorType: 'user',
        authorUserId: OWNER,
        text: 'react to me',
      },
    })

    const result: any = await apply({
      mode: 'snapshot',
      epoch: `epoch-${suffix}`,
      models: [
        {
          model: 'ConversationReaction',
          rows: [{ id: `reaction-${suffix}`, messageId: id, userId: OWNER, emoji: '🎉', createdAt: new Date().toISOString() }],
        },
      ],
      snapshot: { complete: true },
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const updated = seen.filter((entry) => entry.event.type === 'message.updated')
    expect(updated.length).toBe(1)
    expect(updated[0].event.message.id).toBe(id)
    expect(updated[0].event.message.reactions).toEqual([{ emoji: '🎉', count: 1, userIds: [OWNER] }])
  })

  test('a private channel keeps its audience rule', async () => {
    seen.length = 0
    const id = `msg-private-${suffix}`
    const result: any = await apply(
      batch([messageRow({ id, conversationId: PRIVATE, workspaceId: HOSTED, seq: 1, text: 'only us' })]),
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const created = seen.filter((entry) => entry.event.type === 'message.created')
    expect(created.length).toBe(1)
    expect(created[0].audience).toEqual([OWNER])
  })

  test('a refused batch announces nothing', async () => {
    seen.length = 0
    const result: any = await apply(
      batch([
        messageRow({
          id: `msg-refused-${suffix}`,
          conversationId: PUBLIC,
          workspaceId: ELSEWHERE,
          seq: 9,
          text: 'not this machine’s',
        }),
      ]),
    )
    expect(result.code).toBe('workspace_ownership')
    expect(seen).toEqual([])
  })
})
