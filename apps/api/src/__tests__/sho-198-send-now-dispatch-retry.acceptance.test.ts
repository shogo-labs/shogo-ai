// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-198 — "send now" on a queued message stops the reply and then sends
 * nothing.
 *
 * The stop clears the session's active turn on a hop of its own, so the
 * dispatch that follows the click can still find the session busy and return
 * without taking the row. Nothing else is coming to move that queue along: the
 * turn it would have waited for is the one the click just stopped. The route
 * therefore asks again shortly — and only while the row is still queued, so a
 * dispatch that did land, or a person who removed the message, is left alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

/** The dispatcher is the one hop stubbed: its answer is what this fix reacts to. */
const dispatchCalls: string[] = []
let dispatchResult = false
let onDispatch: (() => void) | null = null
mock.module('../services/chat-queue-dispatcher.service', () => ({
  dispatchNext: async (sessionId: string) => {
    dispatchCalls.push(sessionId)
    onDispatch?.()
    return dispatchResult
  },
  isHomeRegionSession: async () => true,
}))
mock.module('../lib/runtime', () => ({ getRuntimeManager: () => ({}) }))

const { prisma } = await import('../lib/prisma')
const { chatQueuedMessageActionsRoutes } = await import('../routes/chat-queued-message-actions')

const db = prisma as any
let seed: SeededWorkspace
let sessionId: string

const app = new Hono<{ Variables: { auth: any } }>()
app.use('*', async (c, next) => {
  c.set('auth', { userId: seed.owner, tunnelAuthenticated: true })
  await next()
})
app.route('/api/chat-queued-messages', chatQueuedMessageActionsRoutes())

async function queuedRow(content: string): Promise<string> {
  const created = await db.chatQueuedMessage.create({
    data: {
      sessionId,
      userId: seed.owner,
      position: 0,
      status: 'pending',
      content,
      parts: JSON.stringify([{ type: 'text', text: content }]),
      body: JSON.stringify({ text: content }),
    },
  })
  return created.id
}

async function sendNow(id: string) {
  const res = await app.request(`/api/chat-queued-messages/${id}/send-now`, { method: 'POST' })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const session = await db.chatSession.create({
    data: {
      inferredName: 'SHO-198',
      contextType: 'project',
      contextId: seed.projectId,
      createdByUserId: seed.owner,
    },
  })
  sessionId = session.id
})

beforeEach(async () => {
  dispatchCalls.length = 0
  dispatchResult = false
  onDispatch = null
  await db.chatQueuedMessage.deleteMany({ where: { sessionId } })
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-198 · send now asks for the dispatch again when the stop had not landed', () => {
  test('a dispatch that found the session busy is retried while the row still waits', async () => {
    const id = await queuedRow('second job')
    const res = await sendNow(id)
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    // The click is answered without waiting for the dispatch.
    expect(dispatchCalls).toEqual([sessionId])

    await waitFor(() => dispatchCalls.length >= 2, 10_000)
    expect(dispatchCalls).toEqual([sessionId, sessionId])
    // Still queued: the retry is what keeps the message sendable.
    const row = await db.chatQueuedMessage.findUnique({ where: { id } })
    expect(row?.status).toBe('pending')
  }, 20_000)

  test('a dispatch that took the row is not asked again', async () => {
    dispatchResult = true
    const id = await queuedRow('third job')
    const res = await sendNow(id)
    expect(res.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 2_600))
    expect(dispatchCalls).toEqual([sessionId])
  }, 20_000)

  test('a row removed while the retry waits is never dispatched again', async () => {
    const id = await queuedRow('fourth job')
    await sendNow(id)
    expect(dispatchCalls).toEqual([sessionId])

    await db.chatQueuedMessage.delete({ where: { id } })
    await new Promise((resolve) => setTimeout(resolve, 2_600))
    expect(dispatchCalls).toEqual([sessionId])
  }, 20_000)
})
