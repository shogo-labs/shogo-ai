// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A hosted workspace's push must never fail on a natural-key clash with a row
 * the cloud wrote itself (production, 2.4.11: Samsara's every batch 500'd on
 * `chat_session_projects (sessionId, projectId)`, so no channel or message ever
 * reached the cloud). Runs on real Postgres — the clashing keys
 * (`conversations (workspaceId, slug)`, `conversation_messages
 * (conversationId, seq)`) are database indexes, and the fix relies on
 * savepoints and `ON UPDATE CASCADE`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const PG_URL = process.env.CHANNELS_TEST_PG_URL
const describeIfPg = PG_URL ? describe : describe.skip

const { prisma } = await import('../lib/prisma')
const { applyBatch } = await import('../lib/machine-sync/ingest')

const db = prisma as any
const suffix = crypto.randomUUID().slice(0, 8)
const INSTANCE = `inst-clash-${suffix}`

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function hostedWorkspace() {
  const tag = crypto.randomUUID().slice(0, 8)
  const user = await db.user.create({ data: { name: 'owner', email: `clash-${tag}@example.com` } })
  const ws = await db.workspace.create({
    data: { name: 'Samsara', slug: `samsara-${tag}`, kind: 'team', hostInstanceId: INSTANCE },
  })
  await db.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })
  const project = await db.project.create({ data: { name: 'p', workspaceId: ws.id } })
  const session = await db.chatSession.create({
    data: { name: 's', inferredName: 's', contextType: 'workspace', workspaceId: ws.id, createdByUserId: user.id },
  })
  await db.machineSyncState.upsert({
    where: { instanceId: INSTANCE },
    create: { instanceId: INSTANCE, epoch: 'e1', cursor: 0, lastIngestAt: new Date(), enabled: true },
    update: { epoch: 'e1', lastIngestAt: new Date(), enabled: true },
  })
  return { user, ws, project, session }
}

const later = () => new Date(Date.now() + 60_000).toISOString()

describeIfPg('host sync: natural-key clashes with cloud-written rows', () => {
  test('a clash on one row does not fail the batch; the cloud row takes the host id and its children follow', async () => {
    const { user, ws, project, session } = await hostedWorkspace()

    // What the cloud wrote on its own: a session↔project link and a seeded #general with a message.
    const cloudLink = await db.chatSessionProject.create({ data: { sessionId: session.id, projectId: project.id } })
    const cloudGeneral = await db.conversation.create({ data: { workspaceId: ws.id, name: '#general', slug: 'general' } })
    const cloudMessage = await db.conversationMessage.create({
      data: { conversationId: cloudGeneral.id, workspaceId: ws.id, seq: 1, text: 'sent from the cloud', authorUserId: user.id },
    })

    const hostLinkId = crypto.randomUUID()
    const hostGeneralId = crypto.randomUUID()
    const hostMessageId = crypto.randomUUID()
    const result = await applyBatch(
      { prisma: db, instanceId: INSTANCE, ownerUserId: user.id, homeRegion: 'us' },
      {
        epoch: 'e1',
        mode: 'changes',
        cursor: 7,
        models: [
          { model: 'ChatSessionProject', rows: [{ id: hostLinkId, sessionId: session.id, projectId: project.id, createdAt: later() }] },
          {
            model: 'Conversation',
            rows: [{ id: hostGeneralId, workspaceId: ws.id, name: '#general', slug: 'general', kind: 'public', updatedAt: later(), createdAt: later() }],
          },
          {
            model: 'ConversationMessage',
            rows: [{ id: hostMessageId, conversationId: hostGeneralId, workspaceId: ws.id, seq: 1, text: 'sent on the desktop', createdAt: later(), updatedAt: later() }],
          },
        ],
      },
    )

    expect(result).toMatchObject({ ok: true, cursor: 7 })
    expect(await db.chatSessionProject.findMany({ where: { sessionId: session.id } })).toEqual([
      expect.objectContaining({ id: hostLinkId, projectId: project.id }),
    ])
    expect(await db.chatSessionProject.findUnique({ where: { id: cloudLink.id } })).toBeNull()

    // One #general, under the host's id; the cloud's message moved with it and
    // gave seq 1 to the host's message instead of being overwritten.
    const channels = await db.conversation.findMany({ where: { workspaceId: ws.id, slug: 'general' } })
    expect(channels.map((c: any) => c.id)).toEqual([hostGeneralId])
    const messages = await db.conversationMessage.findMany({ where: { conversationId: hostGeneralId }, orderBy: { seq: 'asc' } })
    expect(messages.map((m: any) => [m.id, m.seq, m.text])).toEqual([
      [hostMessageId, 1, 'sent on the desktop'],
      [cloudMessage.id, 2, 'sent from the cloud'],
    ])
  })

  test('a row in a workspace this machine does not host is never taken over', async () => {
    const { user } = await hostedWorkspace()
    const other = await db.workspace.create({ data: { name: 'someone else', slug: `other-${suffix}`, kind: 'team' } })

    const id = crypto.randomUUID()
    const result = await applyBatch(
      { prisma: db, instanceId: INSTANCE, ownerUserId: user.id, homeRegion: 'us' },
      {
        epoch: 'e1',
        mode: 'changes',
        cursor: 8,
        models: [{ model: 'Workspace', rows: [{ id, name: 'dup', slug: `other-${suffix}`, kind: 'team', updatedAt: later() }] }],
      },
    )

    expect(result).toMatchObject({ ok: true, cursor: 8 })
    expect(await db.workspace.findUnique({ where: { id: other.id } })).toMatchObject({ slug: `other-${suffix}`, hostInstanceId: null })
    expect((await db.workspace.findUnique({ where: { id } }))?.slug).not.toBe(`other-${suffix}`)
  })
})
