// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P3/P4 carry-forwards — what happens to a relayed delivery the desktop
 * cannot apply, and to rows nobody ever applies.
 *
 * The gate's point was that `200 { ok: true }` used to hide a dropped event.
 * So: a failure is retried rather than acked away, it is dead-lettered after
 * the attempt cap instead of looping, and rows have a retention window so a
 * desktop that never comes back cannot leave them forever.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const {
  ackRelayedEvents,
  enqueueRelayedEvent,
  failRelayedEvents,
  KEEP_APPLIED_DAYS,
  KEEP_UNDELIVERED_DAYS,
  listDeadLettered,
  listRelayedEvents,
  MAX_ATTEMPTS,
  pruneRelayedEvents,
  requeueRelayedEvents,
  retryDelayMs,
} = await import('../relay-events.service')

const db = prisma as any

let workspaceId = ''
let otherWorkspaceId = ''

const envelope = (eventId: string, localWorkspaceId = 'local-a') => ({
  externalId: 'ws_test',
  localWorkspaceId,
  eventId,
  type: 'comment.received',
  account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'ig' },
  detail: { id: 'cmt_1', text: 'MERGE' },
  payload: { comment: { id: 'cmt_1', text: 'MERGE' } },
  occurredAt: '2026-10-19T22:00:00.000Z',
})

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const [first, second] = await Promise.all([
    db.workspace.create({ data: { name: 'Relay A', slug: `relay-a-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'Relay B', slug: `relay-b-${suffix}`, kind: 'team' } }),
  ])
  workspaceId = first.id
  otherWorkspaceId = second.id
})

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }).catch(() => {})
})

describe('durable delivery', () => {
  test('a provider retry collapses onto the row that already exists', async () => {
    const first = await enqueueRelayedEvent({ workspaceId, envelope: envelope('evt_dup') })
    const second = await enqueueRelayedEvent({ workspaceId, envelope: envelope('evt_dup') })
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.id).toBe(first.id)

    const rows = await db.socialRelayedEvent.findMany({ where: { workspaceId, externalId: 'ws_test' } })
    expect(rows.filter((row: any) => row.dedupeKey === 'zernio:evt_dup')).toHaveLength(1)
  })

  test('the envelope carries the payload the inbox needs to apply it', async () => {
    const [row] = await listRelayedEvents({ workspaceId, localWorkspaceId: 'local-a' })
    expect(row).toMatchObject({ eventId: 'evt_dup', payload: { comment: { id: 'cmt_1' } } })
    expect(row.attempts).toBe(0)
  })

  test('one tenant cannot ack another tenant’s delivery', async () => {
    const [row] = await listRelayedEvents({ workspaceId })
    const acked = await ackRelayedEvents({ workspaceId: otherWorkspaceId, ids: [row.id] })
    expect(acked).toBe(0)
    expect(await listRelayedEvents({ workspaceId })).toHaveLength(1)

    expect(await ackRelayedEvents({ workspaceId, ids: [row.id] })).toBe(1)
    expect(await listRelayedEvents({ workspaceId })).toHaveLength(0)
  })

  test('an applied row is still readable in the backfill window, then dropped', async () => {
    const backfill = await listRelayedEvents({ workspaceId, includeApplied: true })
    expect(backfill).toHaveLength(1)

    // Inside the window: kept. Older than it: pruned.
    await db.socialRelayedEvent.updateMany({
      where: { workspaceId },
      data: { appliedAt: daysAgo(KEEP_APPLIED_DAYS + 1) },
    })
    expect(await pruneRelayedEvents(workspaceId)).toBe(1)
    expect(await listRelayedEvents({ workspaceId, includeApplied: true })).toHaveLength(0)
  })
})

describe('a delivery that cannot be applied', () => {
  test('is retried, then dead-lettered instead of looping or being acked away', async () => {
    const { id } = await enqueueRelayedEvent({ workspaceId, envelope: envelope('evt_poison') })

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await failRelayedEvents({
        workspaceId,
        failures: [{ id, error: `catalog rejected the payload (attempt ${attempt})` }],
      })
      expect(result.recorded).toBe(1)
      if (attempt < MAX_ATTEMPTS) {
        expect(result.deadLettered).toEqual([])
        // Waiting out its backoff: still held, not handed out yet.
        expect(await listRelayedEvents({ workspaceId })).toHaveLength(0)
        expect(await listDeadLettered({ workspaceId })).toHaveLength(0)
        // Once the delay has passed the same row is handed out again.
        await db.socialRelayedEvent.update({
          where: { id },
          data: { lastAttemptAt: new Date(Date.now() - retryDelayMs(attempt) - 1_000) },
        })
        expect(await listRelayedEvents({ workspaceId })).toHaveLength(1)
        // The attempt still counts: a redelivery is not a fresh start.
        expect((await db.socialRelayedEvent.findUnique({ where: { id } })).attempts).toBe(attempt)
      } else {
        expect(result.deadLettered).toEqual([id])
      }
    }

    // Dead-lettered: no longer handed out, but visible to an operator.
    expect(await listRelayedEvents({ workspaceId })).toHaveLength(0)
    const dead = await listDeadLettered({ workspaceId })
    expect(dead.map((row: any) => row.id)).toEqual([id])

    const row = await db.socialRelayedEvent.findUnique({ where: { id } })
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.lastError).toContain('catalog rejected')
    expect(row.failedAt).not.toBeNull()
    expect(row.appliedAt).toBeNull()
  })

  test('a dead letter replays once the cause is fixed', async () => {
    const dead = await listDeadLettered({ workspaceId })
    const id = dead[0].id

    // Another tenant cannot requeue it, and a live row is not a dead letter.
    expect(await requeueRelayedEvents({ workspaceId: otherWorkspaceId, ids: [id] })).toBe(0)
    expect(await requeueRelayedEvents({ workspaceId, ids: ['no-such-row'] })).toBe(0)

    expect(await requeueRelayedEvents({ workspaceId, ids: [id] })).toBe(1)
    const row = await db.socialRelayedEvent.findUnique({ where: { id } })
    expect(row.failedAt).toBeNull()
    expect(row.attempts).toBe(0)
    expect(row.lastError).toBeNull()

    // Back in the queue with a full schedule, and no longer in the dead list.
    expect((await listRelayedEvents({ workspaceId })).map((event: any) => event.id)).toEqual([id])
    expect(await listDeadLettered({ workspaceId })).toHaveLength(0)

    // Applying it now works, and it leaves the queue for good.
    expect(await ackRelayedEvents({ workspaceId, ids: [id] })).toBe(1)
    expect(await listRelayedEvents({ workspaceId })).toHaveLength(0)
    await db.socialRelayedEvent.deleteMany({ where: { workspaceId } })
  })

  test('an applied or already-dead delivery records no further failure', async () => {
    const { id } = await enqueueRelayedEvent({ workspaceId, envelope: envelope('evt_check') })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await failRelayedEvents({ workspaceId, failures: [{ id, error: `boom ${attempt}` }] })
    }
    expect((await listDeadLettered({ workspaceId })).map((row: any) => row.id)).toEqual([id])

    const again = await failRelayedEvents({ workspaceId, failures: [{ id, error: 'boom' }] })
    expect(again).toEqual({ recorded: 0, deadLettered: [] })

    const missing = await failRelayedEvents({ workspaceId, failures: [{ id: 'no-such-row', error: 'boom' }] })
    expect(missing.recorded).toBe(0)
  })

  test('an undelivered row has a longer window than an applied one, and then goes too', async () => {
    const { id } = await enqueueRelayedEvent({ workspaceId, envelope: envelope('evt_stale', 'local-b') })

    await db.socialRelayedEvent.update({
      where: { id },
      data: { createdAt: daysAgo(KEEP_UNDELIVERED_DAYS + 1) },
    })
    expect(await pruneRelayedEvents(workspaceId)).toBe(1)
    expect(await listDeadLettered({ workspaceId })).toHaveLength(1)
  })
})
