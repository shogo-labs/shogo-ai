// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's profile card: identity, workspace role, status, DND and local
 * time. Also the boundary that matters — the card is workspace-scoped, so it
 * can never be used to read someone else's email.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const settings = await import('../services/chat-settings')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function getCard(workspaceId: string, target: string | null, user: string) {
  const query = target === null ? '' : `?userId=${encodeURIComponent(target)}`
  const res = await app.request(`/api/workspaces/${workspaceId}/user-card${query}`, { headers: { 'x-user': user } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body: body as any, raw: JSON.stringify(body) }
}

/** Minutes past midnight in `timezone` right now, derived without the loader's code path. */
function minutesInZone(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

beforeEach(async () => {
  await db.chatUserSettings.deleteMany({})
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('user-card', () => {
  test('describes a member of the workspace', async () => {
    const { status, body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(status).toBe(200)
    expect(body.card).toMatchObject({
      id: seed.member,
      role: 'member',
      isSelf: false,
    })
    expect(body.card.name).toBe('member')
    expect(body.card.email).toContain('@example.com')
    // The handle is exactly the token search's `in:@` resolves.
    expect(body.card.handle).toBe(body.card.email.split('@')[0])
  })

  test('reports the workspace role, and self', async () => {
    const owner = await getCard(seed.workspaceId, seed.owner, seed.owner)
    expect(owner.body.card.role).toBe('owner')
    expect(owner.body.card.isSelf).toBe(true)

    const viewer = await getCard(seed.workspaceId, seed.viewer, seed.owner)
    expect(viewer.body.card.role).toBe('viewer')
    expect(viewer.body.card.isSelf).toBe(false)
  })

  test('carries no local time until the person sets a timezone', async () => {
    const { body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(body.card.timezone).toBeNull()
    expect(body.card.localTime).toBeNull()
    expect(body.card.localTimeLabel).toBeNull()
  })

  test('shows the other person their own clock time', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, { timezone: 'Asia/Kolkata' })
    const { body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(body.card.timezone).toBe('Asia/Kolkata')
    expect(body.card.localTime).toMatch(/^\d{2}:\d{2}$/)
    expect(body.card.localTimeLabel).toBe(`${body.card.localTime} local time`)
    // Kolkata is UTC+5:30 — a loader reading the server clock, or formatting in
    // 12-hour time, lands outside this window.
    const delta = Math.abs(minutesOf(body.card.localTime) - minutesInZone('Asia/Kolkata'))
    expect(Math.min(delta, 1440 - delta)).toBeLessThanOrEqual(1)
  })

  test('surfaces a status and snoozed notifications', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, {
      statusEmoji: '🌴',
      statusText: 'On leave',
      dndUntil: new Date(Date.now() + 60_000).toISOString(),
    })
    const { body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(body.card.status).toMatchObject({ emoji: '🌴', text: 'On leave', dnd: true })
  })

  test('a past DND window is not reported', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, {
      dndUntil: new Date(Date.now() - 60_000).toISOString(),
    })
    const { body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(body.card.status).toBeNull()
  })

  test('an expired status is dropped', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, {
      statusEmoji: '🌴',
      statusExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const { body } = await getCard(seed.workspaceId, seed.member, seed.owner)
    expect(body.card.status).toBeNull()
  })

  test('refuses a user from another workspace without leaking their email', async () => {
    const { status, body, raw } = await getCard(seed.workspaceId, seed.outsider, seed.owner)
    expect(status).toBe(404)
    expect(body.card).toBeUndefined()
    expect(raw).not.toContain('@example.com')
  })

  test('refuses the other workspace’s own view of our member', async () => {
    // Same person, wrong workspace: the id exists but is not a member here.
    const { status } = await getCard(seed.otherWorkspaceId, seed.member, seed.outsider)
    expect(status).toBe(404)
  })

  test('404s an unknown user and 400s a missing one', async () => {
    expect((await getCard(seed.workspaceId, 'user-that-does-not-exist', seed.owner)).status).toBe(404)
    expect((await getCard(seed.workspaceId, null, seed.owner)).status).toBe(400)
  })

  test('requires a session', async () => {
    const res = await app.request(`/api/workspaces/${seed.workspaceId}/user-card?userId=${seed.member}`)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
