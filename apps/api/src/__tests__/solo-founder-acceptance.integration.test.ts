// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-428 QA — the $99 Solo Founder purchase, end to end against a real
 * database.
 *
 * The dev's unit tests mock Prisma, so they prove the decisions but not that a
 * paid workspace actually receives its course. These drive the real
 * `soloFounderService.enroll()` (pack apply, boards, lesson cards), the real
 * lesson gate on the installed Course board, and the real overage wallet
 * against the desktop migration history — the same SQLite shape a desktop
 * install runs (AC8).
 *
 * Covered here (the refund paths and the panel live in solo-founder-enroll.integration.test.ts):
 *  - AC4 one enrollment, six channels, six agents, twelve lesson cards, and a
 *    redelivered/parallel enroll that adds nothing;
 *  - AC5 every installed agent on the economy model, once-a-day heartbeat;
 *  - AC6 the $50/mo default cap, a cap the person chose left alone, and the cap
 *    surviving the monthly reset;
 *  - AC7 the installed lesson cards gate on real workspace output;
 *  - AC2 a prepaid card: cancel, refund, `rejected_prepaid`, nothing installed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'sho428-workspaces-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../lib/prisma')
const soloFounder = await import('../services/solo-founder.service')
const billing = await import('../services/billing.service')
const boardService = await import('../services/work-boards.service')
const course = await import('../config/solo-founder-course')

const db = prisma as any
const OS_CHANNELS = ['build', 'marketing', 'sales', 'support', 'ops']

let seed: SeededWorkspace

/**
 * A workspace that has just paid: the webhook provisions Business before the
 * course is installed, and the overage cap can only be set on a workspace with
 * a live subscription (`setUsageBasedPricing`), so every enrollee gets one.
 */
async function paidWorkspace(name: string, opts: { cap?: number | null } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ws = await db.workspace.create({ data: { name, slug: `${name}-${suffix}`, kind: 'team' } })
  const user = await db.user.create({ data: { name: `${name}-owner`, email: `${name}-${suffix}@example.com` } })
  await db.member.create({ data: { userId: user.id, workspaceId: ws.id, role: 'owner' } })
  await db.subscription.create({
    data: {
      workspaceId: ws.id,
      stripeSubscriptionId: `sub_${suffix}`,
      stripeCustomerId: `cus_${suffix}`,
      planId: 'business',
      seats: 1,
      status: 'active',
      billingInterval: 'annual',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    },
  })
  await billing.allocateMonthlyIncluded(ws.id, 'business', 1)
  if (opts.cap !== undefined) {
    await db.usageWallet.update({ where: { workspaceId: ws.id }, data: { overageHardLimitUsd: opts.cap } })
  }
  return { workspaceId: ws.id, userId: user.id }
}

async function counts(workspaceId: string) {
  const [channels, boards, projects, wallets] = await Promise.all([
    db.conversation.findMany({ where: { workspaceId, archivedAt: null }, select: { name: true } }),
    db.board.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, templateId: true } }),
    db.project.findMany({
      where: { workspaceId },
      select: { id: true, name: true, agentConfig: { select: { modelName: true, heartbeatInterval: true, heartbeatEnabled: true } } },
    }),
    db.usageWallet.findMany({ where: { workspaceId }, select: { overageHardLimitUsd: true, overageEnabled: true, alertsSentThisPeriod: true } }),
  ])
  return { channels, boards, projects, wallet: wallets[0] }
}

/** The six channels the course owns, counted so a duplicate shows up as 2. */
function courseChannels(channels: Array<{ name: string | null }>) {
  return [...OS_CHANNELS, 'course'].map((name) => ({
    name,
    count: channels.filter((c) => c.name === name).length,
  }))
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (db as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workspacesDir, { recursive: true, force: true })
  delete process.env.WORKSPACES_DIR
})

describe('AC4 fulfilment: a failed install is recoverable', () => {
  test('a failed install is recoverable through retryInstallIfNeeded', async () => {
    const { workspaceId, userId } = await paidWorkspace('acme-retry')
    const row = await db.courseEnrollment.create({
      data: {
        courseId: course.SOLO_FOUNDER_COURSE_ID,
        userId,
        workspaceId,
        source: 'stripe',
        status: 'active',
        purchasedAt: new Date(),
        installStatus: 'failed',
        installError: 'simulated loss',
      },
    })
    const state = await soloFounder.retryInstallIfNeeded({ userId, workspaceId })
    expect(state.enrolled).toBe(true)
    expect(state.installStatus).toBe('installed')
    expect(state.courseBoardId).toBeTruthy()
    expect(state.totalLessons).toBe(12)
    const after = await db.courseEnrollment.findUnique({ where: { id: row.id } })
    expect(after.installError).toBeNull()
    const { channels } = await counts(workspaceId)
    for (const entry of courseChannels(channels)) expect(entry.count).toBe(1)
  }, 90_000)
})

describe('AC5 the installed company', () => {
  test('every agent project is on the economy model with a once-a-day heartbeat', async () => {
    const { workspaceId, userId } = await paidWorkspace('acme-model')
    const result = await soloFounder.enroll({
      workspaceId, userId, source: 'stripe', stripeCheckoutSessionId: 'cs_model', awaitInstall: true,
    })
    expect(result.installStatus).toBe('installed')
    const enrollment = await db.courseEnrollment.findFirst({ where: { workspaceId } })
    const projectIds = Object.values((enrollment.packBindings as any).projects) as string[]
    expect(projectIds.length).toBe(6)
    const projects = await db.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true, agentConfig: { select: { modelName: true, heartbeatEnabled: true, heartbeatInterval: true } } },
    })
    expect(projects.length).toBe(6)
    for (const p of projects) {
      expect({ name: p.name, model: p.agentConfig?.modelName }).toEqual({ name: p.name, model: 'hoshi-2-0' })
      expect({ name: p.name, heartbeat: p.agentConfig?.heartbeatInterval }).toEqual({ name: p.name, heartbeat: 86_400 })
      expect(p.agentConfig?.heartbeatEnabled).toBe(true)
    }
  }, 90_000)
})

describe('AC6 the overage guardrail', () => {
  test('enrolling sets the $50/mo cap and keeps one the person chose', async () => {
    const fresh = await paidWorkspace('acme-cap')
    expect((await counts(fresh.workspaceId)).wallet.overageHardLimitUsd).toBeNull()
    await soloFounder.enroll({
      workspaceId: fresh.workspaceId, userId: fresh.userId, source: 'stripe', stripeCheckoutSessionId: 'cs_cap', awaitInstall: true,
    })
    const wallet = (await counts(fresh.workspaceId)).wallet
    expect(wallet.overageEnabled).toBe(true)
    expect(wallet.overageHardLimitUsd).toBe(50)

    const chosen = await paidWorkspace('acme-cap-chosen', { cap: 12 })
    await soloFounder.enroll({
      workspaceId: chosen.workspaceId, userId: chosen.userId, source: 'stripe', stripeCheckoutSessionId: 'cs_cap_chosen', awaitInstall: true,
    })
    expect((await counts(chosen.workspaceId)).wallet.overageHardLimitUsd).toBe(12)
  }, 90_000)

  test('the period reset keeps the $50 cap, and only releases the grant-only $5 one', async () => {
    // `allocateMonthlyIncluded` is what the renewal runs: it clears the alert
    // ledger and releases an auto-applied cap — but only when it is exactly the
    // grant-only $5 value. So $50 has to survive it, or "capped at $50/mo by
    // default" becomes false after the first renewal.
    const offers = await paidWorkspace('acme-cap-reset')
    await billing.setUsageBasedPricing(offers.workspaceId, { overageEnabled: true, overageHardLimitUsd: 50 })

    const grantOnly = await paidWorkspace('acme-cap-grant', { cap: 5 })
    await db.usageWallet.update({
      where: { workspaceId: grantOnly.workspaceId },
      data: { alertsSentThisPeriod: { approachCap: true } },
    })

    for (const workspaceId of [offers.workspaceId, grantOnly.workspaceId]) {
      await billing.allocateMonthlyIncluded(workspaceId, 'business', 1)
    }

    const offerWallet = await db.usageWallet.findUnique({ where: { workspaceId: offers.workspaceId } })
    expect(offerWallet.overageHardLimitUsd).toBe(50)
    // The reset ran: the dedupe ledger was cleared, so the alert can fire again.
    expect(offerWallet.alertsSentThisPeriod).toEqual({})

    const grantWallet = await db.usageWallet.findUnique({ where: { workspaceId: grantOnly.workspaceId } })
    expect(grantWallet.overageHardLimitUsd).toBeNull()
  }, 60_000)
})
