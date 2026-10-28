// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-197 acceptance, through the route the join page actually calls.
 *
 * `GET /api/huddle-links/:token` answers to the link token alone — guests have
 * no account — so nothing in its body may be the starter's email: not for a
 * signed-out visitor, not for a signed-in stranger, not for a member. A starter
 * with a display name still reads "Started by <name>".
 *
 * Mounted on the real conversations router, whose `optionalUser` is the
 * server's `resolveUserId`, so a request with no session is the signed-out one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

process.env.LIVEKIT_URL = 'wss://huddles.test'
process.env.LIVEKIT_API_KEY = 'test-key'
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256'

// LiveKit's server API is not what this card is about; the huddle rows and the
// public link route are.
const sdk = await import('livekit-server-sdk')
mock.module('livekit-server-sdk', () => ({
  ...sdk,
  RoomServiceClient: class {
    async listParticipants() {
      return []
    }
    async deleteRoom() {}
    async getParticipant(_room: string, identity: string) {
      return { identity, tracks: [] }
    }
    async mutePublishedTrack() {}
    async removeParticipant() {}
  },
}))

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const conversations = await import('../services/conversation.service')
const huddles = await import('../services/huddle.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

const slug = () => crypto.randomUUID().slice(0, 6)

async function linkInfo(token: string, userId?: string) {
  const res = await app.request(`/api/huddle-links/${token}`, { headers: userId ? { 'x-user': userId } : {} })
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as any }
}

async function knock(token: string, name: string) {
  const res = await app.request(`/api/huddle-links/${token}/knock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as any }
}

/** A huddle started by someone with no display name, so any name-or-email fallback leaks their address. */
async function namelessHuddle() {
  const email = `qa-nameless-${slug()}@example.com`
  const starter = await db.user.create({ data: { name: null, email } })
  await db.member.create({ data: { userId: starter.id, workspaceId: seed.workspaceId, role: 'member' } })
  const conv = await conversations.createChannel({
    workspaceId: seed.workspaceId,
    userId: starter.id,
    name: `qa-huddle-${slug()}`,
    kind: 'private',
    topic: null,
    memberUserIds: [],
  })
  await huddles.joinHuddle(conv.id, starter.id)
  const link = await huddles.getHuddleLink(conv.id, starter.id)
  return { starter, conv, link, email }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  huddles._setHuddlePushSenderForTests(async () => {})
})

beforeEach(() => {
  huddles._resetHuddlesForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('the public huddle link never reveals the starter email', () => {
  test('a signed-out visitor learns who is in the call and nothing else', async () => {
    const { link, email } = await namelessHuddle()

    const { status, text, body } = await linkInfo(link.token)

    expect(status).toBe(200)
    expect(body).toMatchObject({ enabled: true, live: true, access: 'knock', signedIn: false, participantCount: 1 })
    expect(body.startedBy ?? null).toBeNull()
    expect(body).not.toHaveProperty('email')
    expect(text).not.toContain(email)
    // No address of any shape rides along: the join page has no "Started by" to render.
    expect(text).not.toContain('@')
  })

  test('a signed-in stranger who was never let in gets no email either', async () => {
    const { link, email } = await namelessHuddle()

    for (const stranger of [seed.viewer, seed.outsider]) {
      const { status, text, body } = await linkInfo(link.token, stranger)
      expect(status).toBe(200)
      expect(body).toMatchObject({ access: 'knock', signedIn: true, participantCount: 1 })
      expect(body.conversationId).toBeUndefined()
      expect(body.startedBy ?? null).toBeNull()
      expect(text).not.toContain(email)
      expect(text).not.toContain('@')
    }
  })

  test('a member gets the call details but still no email — one rule for the whole body', async () => {
    const { starter, conv, link, email } = await namelessHuddle()

    const { status, text, body } = await linkInfo(link.token, starter.id)

    expect(status).toBe(200)
    expect(body).toMatchObject({ live: true, access: 'member', signedIn: true, conversationId: conv.id, participantCount: 1 })
    expect(body.startedBy ?? null).toBeNull()
    expect(text).not.toContain(email)
    expect(text).not.toContain('@')
  })

  test('a starter with a display name still reads "Started by <name>" on every path', async () => {
    const email = `qa-named-${slug()}@example.com`
    const starter = await db.user.create({ data: { name: 'Ada Host', email } })
    await db.member.create({ data: { userId: starter.id, workspaceId: seed.workspaceId, role: 'member' } })
    const conv = await conversations.createChannel({
      workspaceId: seed.workspaceId,
      userId: starter.id,
      name: `qa-huddle-${slug()}`,
      kind: 'private',
      topic: null,
      memberUserIds: [],
    })
    await huddles.joinHuddle(conv.id, starter.id)
    const link = await huddles.getHuddleLink(conv.id, starter.id)

    for (const caller of [undefined, seed.viewer, starter.id]) {
      const { text, body } = await linkInfo(link.token, caller)
      expect(body.startedBy).toBe('Ada Host')
      expect(text).not.toContain(email)
    }
  })

  test('a knock answers without the starter email and does not add one to the link', async () => {
    const { link, email } = await namelessHuddle()

    const knocked = await knock(link.token, 'Gus Guest')
    expect(knocked.status).toBe(200)
    expect(knocked.body).toMatchObject({ status: 'waiting' })
    expect(knocked.text).not.toContain(email)
    expect(knocked.text).not.toContain('@')

    const after = await linkInfo(link.token)
    expect(after.text).not.toContain(email)
    expect(after.text).not.toContain('@')
  })

  test('an ended huddle answers with live:false and no starter details', async () => {
    const { starter, conv, link, email } = await namelessHuddle()

    await huddles.leaveHuddle(conv.id, starter.id)

    const { status, text, body } = await linkInfo(link.token)
    expect(status).toBe(200)
    expect(body).toMatchObject({ enabled: true, live: false })
    expect(body.startedBy ?? null).toBeNull()
    expect(text).not.toContain(email)
    expect(text).not.toContain('@')
  })
})
