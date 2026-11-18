// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-428 — `enroll()` and its install, against a real SQLite database.
 *
 * This is the AC4/AC8 test: the course pack installs the same way on the
 * desktop's SQLite as on Postgres, a redelivered webhook never creates a second
 * course, and the twelve lesson cards land on the Course board exactly once.
 *
 *   bun test apps/api/src/__tests__/solo-founder-enroll.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { enroll, getOfferState, refuseIfPrepaidOffer } = await import('../services/solo-founder.service')
const { COURSE_LESSONS, SOLO_FOUNDER_OS_CHANNELS } = await import('../config/solo-founder-course')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('enroll() on SQLite (desktop parity)', () => {
  test('installs the pack once: 6 channels, 6 agents, 12 lesson cards', async () => {
    const result = await enroll({
      workspaceId: seed.workspaceId,
      userId: seed.owner,
      source: 'admin',
      awaitInstall: true,
    })
    expect(result.created).toBe(true)
    expect(result.installStatus).toBe('installed')

    const enrollment = await db.courseEnrollment.findUnique({ where: { id: result.enrollmentId } })
    expect(enrollment.status).toBe('active')
    expect(enrollment.courseId).toBe('solo-founder-v1')
    expect(enrollment.courseBoardId).toBeTruthy()

    const channels = await db.conversation.findMany({
      where: { workspaceId: seed.workspaceId, archivedAt: null },
      select: { name: true },
    })
    const names = channels.map((c: any) => c.name)
    for (const name of [...SOLO_FOUNDER_OS_CHANNELS, 'course']) expect(names).toContain(name)

    const agents = await db.project.findMany({
      where: { workspaceId: seed.workspaceId, hidden: false },
      select: { name: true },
    })
    const agentNames = agents.map((a: any) => a.name)
    for (const name of ['Builder', 'Chief of Staff', 'Coach', 'Marketer', 'Seller', 'Support']) {
      expect(agentNames).toContain(name)
    }
    // One agent per role — a re-apply must never add a second one.
    expect(agentNames.filter((n: string) => n !== 'Billing Bot').sort()).toEqual(
      ['Builder', 'Chief of Staff', 'Coach', 'Marketer', 'Seller', 'Support'],
    )

    const board = await db.board.findUnique({ where: { id: enrollment.courseBoardId } })
    expect(board.templateId).toBe('solo-founder-course')
    const cards = await db.workItem.findMany({ where: { boardId: board.id, archivedAt: null } })
    expect(cards).toHaveLength(COURSE_LESSONS.length)
    expect(cards.map((c: any) => c.fields.lessonId).sort()).toEqual(COURSE_LESSONS.map((l) => l.id).sort())
    // Module 0 is the only lesson that starts in the student's week.
    const thisWeek = await db.boardColumn.findFirst({ where: { boardId: board.id, name: 'This week' } })
    expect(cards.filter((c: any) => c.columnId === thisWeek.id).map((c: any) => c.fields.lessonId)).toEqual(['m0'])
  })

  test('a redelivered webhook updates the same enrollment and installs nothing twice', async () => {
    const channelsBefore = await db.conversation.count({
      where: { workspaceId: seed.workspaceId, archivedAt: null },
    })
    const boardBefore = await db.board.count({ where: { workspaceId: seed.workspaceId, archivedAt: null } })

    const again = await enroll({
      workspaceId: seed.workspaceId,
      userId: seed.owner,
      source: 'stripe',
      stripeCheckoutSessionId: 'cs_test_redelivered',
      stripeSubscriptionId: 'sub_test_redelivered',
      awaitInstall: true,
    })
    expect(again.created).toBe(false)
    expect(again.installStatus).toBe('installed')

    expect(await db.courseEnrollment.count({ where: { userId: seed.owner } })).toBe(1)
    expect(await db.conversation.count({ where: { workspaceId: seed.workspaceId, archivedAt: null } })).toBe(channelsBefore)
    expect(await db.board.count({ where: { workspaceId: seed.workspaceId, archivedAt: null } })).toBe(boardBefore)

    const enrollment = await db.courseEnrollment.findUnique({ where: { id: again.enrollmentId } })
    const cards = await db.workItem.count({ where: { boardId: enrollment.courseBoardId, archivedAt: null } })
    expect(cards).toBe(COURSE_LESSONS.length)
  })

  test('the panel sees the enrollment, the board and the lesson count', async () => {
    const state = await getOfferState({ userId: seed.owner, workspaceId: seed.workspaceId })
    expect(state.enrolled).toBe(true)
    expect(state.installStatus).toBe('installed')
    expect(state.totalLessons).toBe(COURSE_LESSONS.length)
    expect(state.courseBoardId).toBeTruthy()
    expect(state.courseChannelId).toBeTruthy()
  })

  test('two concurrent deliveries still leave one enrollment and one course', async () => {
    const other = await seedWorkspace(db)
    const [a, b] = await Promise.allSettled([
      enroll({ workspaceId: other.workspaceId, userId: other.owner, source: 'stripe', awaitInstall: false }),
      enroll({ workspaceId: other.workspaceId, userId: other.owner, source: 'stripe', awaitInstall: false }),
    ])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    expect(await db.courseEnrollment.count({ where: { userId: other.owner } })).toBe(1)
  })

  test('a prepaid card is refused from either event, and refunded once', async () => {
    const ws = await seedWorkspace(db)
    const stripe = fakeStripe('prepaid')
    const args = {
      stripe: stripe as any,
      workspaceId: ws.workspaceId,
      userId: ws.owner,
      subscriptionId: 'sub_test_prepaid',
    }

    // `customer.subscription.created` may land first: the refusal has to hold
    // without `checkout.session.completed` ever having run.
    const first = await refuseIfPrepaidOffer(args)
    expect(first.refused).toBe(true)
    expect(first.refundId).toBe('re_test_1')
    expect(stripe.calls).toEqual({ retrieve: 1, cancel: 1, refund: 1 })

    const enrollment = await db.courseEnrollment.findFirst({
      where: { stripeSubscriptionId: 'sub_test_prepaid' },
    })
    expect(enrollment.status).toBe('rejected_prepaid')
    expect(enrollment.installStatus).toBe('failed')

    // The sibling event arrives: nothing is cancelled or refunded twice.
    const second = await refuseIfPrepaidOffer(args)
    expect(second.refused).toBe(true)
    expect(stripe.calls).toEqual({ retrieve: 1, cancel: 1, refund: 1 })
  })

  test('a normal card is not refused', async () => {
    const ws = await seedWorkspace(db)
    const stripe = fakeStripe('credit')
    const out = await refuseIfPrepaidOffer({
      stripe: stripe as any,
      workspaceId: ws.workspaceId,
      userId: ws.owner,
      subscriptionId: 'sub_test_credit',
    })
    expect(out.refused).toBe(false)
    expect(stripe.calls).toEqual({ retrieve: 1, cancel: 0, refund: 0 })
    expect(await db.courseEnrollment.count({ where: { userId: ws.owner } })).toBe(0)
  })
})

/** Just enough Stripe for the prepaid refusal: one card, one invoice, one refund. */
function fakeStripe(funding: 'prepaid' | 'credit') {
  const calls = { retrieve: 0, cancel: 0, refund: 0 }
  return {
    calls,
    subscriptions: {
      retrieve: async (id: string) => {
        calls.retrieve++
        return { id, default_payment_method: { type: 'card', card: { funding, last4: '4242', brand: 'visa', fingerprint: 'fp_test' } } }
      },
      cancel: async (id: string) => {
        calls.cancel++
        return { id, status: 'canceled' }
      },
    },
    invoices: {
      list: async () => ({ data: [{ id: 'in_test_1', charge: 'ch_test_1' }] }),
    },
    refunds: {
      create: async () => {
        calls.refund++
        return { id: 're_test_1' }
      },
    },
  }
}
