// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-428 — the $99 Solo Founder offer.
 *
 * Covers what can be proven without Stripe or a live database:
 *   - AC3 eligibility (each refusal reason and its HTTP status)
 *   - AC3 promo codes (an offer coupon is accepted, anything else is not)
 *   - AC5/AC4 the install manifest: six agents pinned to the economy model,
 *     once-a-day heartbeats, five OS channels plus the hidden #course
 *   - AC5/AC4 the twelve lesson cards
 *   - AC7 the lesson gate: what passes, what refuses, and what it ignores
 *   - AC6 the $50 default cap and a user's own cap being kept
 *
 *   bun test apps/api/src/__tests__/solo-founder-offer.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ────────────────────────────────────────────────────────────────────
// In-memory Prisma
// ────────────────────────────────────────────────────────────────────
let channels: Array<{ name: string; workspaceId: string; archivedAt: Date | null }> = []
let projects: Array<{ name: string; workspaceId: string; publishedAt: Date | null }> = []
let boards: Array<{ id: string; name: string; workspaceId: string; archivedAt: Date | null }> = []
let workItems: Array<{ boardId: string; archivedAt: Date | null }> = []
let schedules: Array<{ id: string; workspaceId: string; enabled: boolean }> = []
let enrollments: any[] = []
let subscriptions: any[] = []
let riskAssessments = new Map<string, { band: string }>()
let walletCaps = new Map<string, number | null>()
let walletUpserts: any[] = []

const prismaStub = {
  conversation: {
    findMany: async (args: any) => {
      const names: string[] = args?.where?.name?.in ?? []
      return channels
        .filter((c) => c.workspaceId === args.where.workspaceId && !c.archivedAt && names.includes(c.name))
        .map((c) => ({ name: c.name }))
    },
  },
  project: {
    findFirst: async (args: any) =>
      projects.find((p) => p.workspaceId === args.where.workspaceId && p.publishedAt !== null) ?? null,
  },
  board: {
    findMany: async (args: any) =>
      boards
        .filter((b) => b.workspaceId === args.where.workspaceId && !b.archivedAt)
        .map((b) => ({ id: b.id, name: b.name })),
  },
  workItem: {
    count: async (args: any) => {
      const ids: string[] = args?.where?.boardId?.in ?? []
      return workItems.filter((w) => ids.includes(w.boardId) && !w.archivedAt).length
    },
  },
  agentSchedule: {
    findMany: async (args: any) =>
      schedules.filter((s) => s.workspaceId === args.where.workspaceId && s.enabled).map((s) => ({ id: s.id })),
  },
  courseEnrollment: {
    findFirst: async (args: any) => {
      const where = args?.where ?? {}
      return (
        enrollments.find(
          (e) =>
            (!where.workspaceId || e.workspaceId === where.workspaceId) &&
            (!where.userId || e.userId === where.userId) &&
            (!where.courseId || e.courseId === where.courseId) &&
            (!where.status || e.status === where.status),
        ) ?? null
      )
    },
    findUnique: async (args: any) => enrollments.find((e) => e.id === args.where.id) ?? null,
    update: async (args: any) => {
      const e = enrollments.find((x) => x.id === args.where.id)
      if (e) Object.assign(e, args.data)
      return e ?? null
    },
    create: async (args: any) => {
      const row = { id: `enr-${enrollments.length + 1}`, ...args.data }
      enrollments.push(row)
      return row
    },
  },
  subscription: {
    findFirst: async (args: any) => {
      const statuses: string[] = args?.where?.status?.in ?? []
      return (
        subscriptions.find(
          (s) => s.workspaceId === args.where.workspaceId && statuses.includes(s.status),
        ) ?? null
      )
    },
  },
  signupRiskAssessment: {
    findUnique: async (args: any) => riskAssessments.get(args.where.userId) ?? null,
  },
  usageWallet: {
    findUnique: async (args: any) => {
      const cap = walletCaps.get(args.where.workspaceId)
      if (cap === undefined) return null
      return { overageHardLimitUsd: cap }
    },
    upsert: async (args: any) => {
      walletUpserts.push(args)
      walletCaps.set(args.where.workspaceId, args.update?.overageHardLimitUsd ?? null)
      return args.update ?? args.create
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub as any }))

const { checkEligibility, SOLO_FOUNDER_ERROR_STATUS, applyDefaultOverageCap, SOLO_FOUNDER_PRICING, resolveOfferPromotionCode, InvalidPromoCodeError } =
  await import('../services/solo-founder.service')
const { evaluateLessonCheck, checkCourseLessonMove, countOwnSchedules } = await import('../services/lesson-checks.service')
const { COURSE_LESSONS, SOLO_FOUNDER_OS_CHANNELS, SOLO_FOUNDER_COURSE_BOARD_TEMPLATE, SOLO_FOUNDER_COURSE_CHANNEL } =
  await import('../config/solo-founder-course')
const { SOLO_FOUNDER_OVERAGE_CAP_USD } = await import('../config/usage-plans')
const { bundleManifest, soloFounderCourseManifest, listWorkTemplates } = await import(
  '@shogo/agent-runtime/src/work-templates'
)

const WS = 'ws-solo'
const USER = 'user-solo'

beforeEach(() => {
  channels = []
  projects = []
  boards = []
  workItems = []
  schedules = []
  enrollments = []
  subscriptions = []
  riskAssessments = new Map()
  walletCaps = new Map()
  walletUpserts = []
})

// ────────────────────────────────────────────────────────────────────
// AC3 — eligibility
// ────────────────────────────────────────────────────────────────────

describe('AC3 eligibility', () => {
  test('a signed-out caller is refused with 401', async () => {
    const r = await checkEligibility({ userId: null, workspaceId: WS })
    expect(r.eligible).toBe(false)
    if (!r.eligible) {
      expect(r.reason).toBe('not_signed_in')
      expect(SOLO_FOUNDER_ERROR_STATUS[r.reason]).toBe(401)
    }
  })

  test('an active, trialing or past_due subscription refuses the offer with 409', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      subscriptions = [{ workspaceId: WS, status }]
      const r = await checkEligibility({ userId: USER, workspaceId: WS })
      expect(r.eligible).toBe(false)
      if (!r.eligible) {
        expect(r.reason).toBe('existing_subscription')
        expect(r.code).toBe('offer_not_eligible')
        expect(SOLO_FOUNDER_ERROR_STATUS[r.reason]).toBe(409)
      }
    }
  })

  test('a canceled subscription does not block the offer', async () => {
    subscriptions = [{ workspaceId: WS, status: 'canceled' }]
    expect(await checkEligibility({ userId: USER, workspaceId: WS })).toEqual({ eligible: true })
  })

  test('a second purchase by an enrolled user is refused with 409', async () => {
    enrollments = [{ id: 'e1', workspaceId: WS, userId: USER, courseId: 'solo-founder-v1', status: 'active' }]
    const r = await checkEligibility({ userId: USER, workspaceId: WS })
    expect(r.eligible).toBe(false)
    if (!r.eligible) {
      expect(r.code).toBe('already_enrolled')
      expect(SOLO_FOUNDER_ERROR_STATUS[r.reason]).toBe(409)
    }
  })

  test('a high-risk signup is refused with 403, the same rule as trials', async () => {
    riskAssessments.set(USER, { band: 'high' })
    const r = await checkEligibility({ userId: USER, workspaceId: WS })
    expect(r.eligible).toBe(false)
    if (!r.eligible) {
      expect(r.reason).toBe('risk_review')
      expect(SOLO_FOUNDER_ERROR_STATUS[r.reason]).toBe(403)
    }
  })

  test('a free workspace with no enrollment is eligible', async () => {
    expect(await checkEligibility({ userId: USER, workspaceId: WS })).toEqual({ eligible: true })
  })
})

// ────────────────────────────────────────────────────────────────────
// AC3 — promo codes
// ────────────────────────────────────────────────────────────────────

function stripeWithCoupon(coupon: { id: string; metadata?: Record<string, string> } | string | null) {
  return {
    promotionCodes: {
      list: async () => ({ data: [{ id: 'promo_123', promotion: { coupon, type: 'coupon' } }] }),
    },
    coupons: {
      retrieve: async (id: string) => ({ id, metadata: { offer: 'solo_founder' } }),
    },
  } as any
}

describe('AC3 promo codes', () => {
  test('an offer coupon is accepted', async () => {
    const stripe = stripeWithCoupon({ id: 'c_offer', metadata: { offer: 'solo_founder' } })
    await expect(resolveOfferPromotionCode(stripe, 'BETA')).resolves.toEqual({
      promotionCodeId: 'promo_123',
      couponId: 'c_offer',
    })
  })

  test('a coupon from another promotion is refused rather than applied', async () => {
    const stripe = stripeWithCoupon({ id: 'c_other', metadata: { offer: 'something_else' } })
    await expect(resolveOfferPromotionCode(stripe, 'OTHER')).rejects.toBeInstanceOf(InvalidPromoCodeError)
  })

  test('a coupon with no offer metadata is refused', async () => {
    const stripe = stripeWithCoupon({ id: 'c_plain', metadata: {} })
    await expect(resolveOfferPromotionCode(stripe, 'PLAIN')).rejects.toBeInstanceOf(InvalidPromoCodeError)
  })

  test('an unexpanded coupon id is fetched before its metadata is trusted', async () => {
    const stripe = stripeWithCoupon('c_lazy')
    await expect(resolveOfferPromotionCode(stripe, 'LAZY')).resolves.toEqual({
      promotionCodeId: 'promo_123',
      couponId: 'c_lazy',
    })
  })

  test('an empty code is refused without a Stripe call', async () => {
    const stripe = { promotionCodes: { list: () => { throw new Error('should not be called') } } } as any
    await expect(resolveOfferPromotionCode(stripe, '   ')).rejects.toBeInstanceOf(InvalidPromoCodeError)
  })
})

// ────────────────────────────────────────────────────────────────────
// AC5/AC4 — the install manifest
// ────────────────────────────────────────────────────────────────────

describe('AC5 Solo Founder OS company', () => {
  const company = bundleManifest('company', 'solo-founder-os') as any

  test('installs five channels, one agent each, all on the economy model', () => {
    expect(company.teamChannels.map((c: any) => c.name).sort()).toEqual(
      ['build', 'marketing', 'ops', 'sales', 'support'],
    )
    expect(company.projects.map((p: any) => p.key).sort()).toEqual(
      ['builder', 'marketer', 'ops', 'seller', 'support'],
    )
    for (const project of company.projects) {
      expect(project.agent.model).toBe('hoshi-2-0')
      // Six agents sweeping every four hours would spend a beginner's week.
      expect(project.agent.heartbeat).toEqual({ enabled: true, interval: 86_400 })
    }
  })

  test('a brand-new one-person company has no Renewals and no Vendor requests', () => {
    const byChannel = Object.fromEntries(company.teamChannels.map((c: any) => [c.name, c.boards]))
    expect(byChannel.sales.map((b: any) => b.name)).toEqual(['Pipeline'])
    expect(byChannel.ops.map((b: any) => b.name)).toEqual(['OKRs'])
    expect(byChannel.build.map((b: any) => b.name)).toEqual(['Backlog'])
    expect(byChannel.marketing.map((b: any) => b.name).sort()).toEqual(['Campaigns', 'Content'])
    expect(byChannel.support.map((b: any) => b.name)).toEqual(['Tickets'])
  })

  test('every agent carries the shared duties and limits', () => {
    for (const project of company.projects) {
      const agentsMd: string = project.files['AGENTS.md']
      expect(agentsMd).toContain('read the company brief in the #ops channel doc')
      expect(agentsMd).toContain("Never invent facts, numbers, testimonials or customer names")
    }
  })

  test('the build board runs Ideas → Building (WIP 2) → Review → Shipped, plus Dropped', () => {
    const buildBoard = (bundleManifest('company', 'solo-founder-os') as any).teamChannels.find(
      (c: any) => c.name === 'build',
    ).boards[0]
    expect(buildBoard.columns.map((c: any) => [c.name, c.category, c.wipLimit ?? null])).toEqual([
      ['Ideas', 'backlog', null],
      ['Building', 'active', 2],
      ['Review', 'review', null],
      ['Shipped', 'done', null],
      ['Dropped', 'dismissed', null],
    ])
  })

  test('it is in the catalogue and the course department is not', () => {
    const ids = listWorkTemplates().map((t) => `${t.kind}:${t.id}`)
    expect(ids).toContain('company:solo-founder-os')
    expect(ids).not.toContain('department:course')
    expect(ids).toContain('department:build')
  })
})

describe('AC5 the course pack', () => {
  const pack = soloFounderCourseManifest() as any

  test('adds the hidden #course channel with the Coach, on the economy model', () => {
    const course = pack.teamChannels.find((c: any) => c.name === SOLO_FOUNDER_COURSE_CHANNEL)
    expect(course).toBeTruthy()
    expect(course.boards.map((b: any) => b.name)).toEqual(['Course'])
    const coach = pack.projects.find((p: any) => p.key === 'coach')
    expect(coach.agent.model).toBe('hoshi-2-0')
    expect(coach.files['AGENTS.md']).toContain('The server runs the check')
  })

  test('the course board carries the lesson fields and the template id the gate keys off', () => {
    const course = pack.teamChannels.find((c: any) => c.name === SOLO_FOUNDER_COURSE_CHANNEL)
    const board = course.boards[0]
    expect(board.templateId).toBe(SOLO_FOUNDER_COURSE_BOARD_TEMPLATE)
    expect(board.fields.map((f: any) => f.key)).toEqual(
      expect.arrayContaining(['lessonId', 'module', 'videoUrl', 'output', 'check']),
    )
    expect(board.columns.map((c: any) => c.name)).toEqual(['Up next', 'This week', 'Checking', 'Done', 'Skipped'])
    expect(board.columns.find((c: any) => c.name === 'Checking').agent).toBe('coach')
  })

  test('declares one Coach nudge schedule', () => {
    expect(pack.schedules.length).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// AC5 — the twelve lessons
// ────────────────────────────────────────────────────────────────────

describe('AC5 lesson cards', () => {
  test('there are twelve: Module 0, Modules 1–10 and the Capstone', () => {
    expect(COURSE_LESSONS.length).toBe(12)
    expect(COURSE_LESSONS.map((l) => l.module)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(COURSE_LESSONS[11].id).toBe('capstone')
  })

  test('the machine checks are the ones the registry implements', () => {
    const kinds = COURSE_LESSONS.map((l) => l.check.kind)
    expect(kinds[0]).toBe('os_installed')
    expect(kinds[1]).toBe('project_published')
    expect(kinds[11]).toBe('project_published')
    expect(kinds.filter((k) => k === 'none').length).toBe(4)
    expect(kinds.filter((k) => k === 'board_cards').length).toBe(4)
    expect(kinds.filter((k) => k === 'schedules_enabled').length).toBe(1)
  })

  test('Module 0 is the only lesson that starts in This week', () => {
    expect(COURSE_LESSONS.filter((l) => l.startsIn === 'this_week').map((l) => l.id)).toEqual(['m0'])
  })
})

// ────────────────────────────────────────────────────────────────────
// AC7 — the lesson gate
// ────────────────────────────────────────────────────────────────────

describe('AC7 lesson checks', () => {
  test('os_installed needs all five channels', async () => {
    channels = SOLO_FOUNDER_OS_CHANNELS.slice(0, 4).map((name) => ({ name, workspaceId: WS, archivedAt: null }))
    const before = await evaluateLessonCheck(WS, 'os_installed')
    expect(before.ok).toBe(false)
    expect(before.message).toContain('#ops')
    channels.push({ name: 'ops', workspaceId: WS, archivedAt: null })
    expect((await evaluateLessonCheck(WS, 'os_installed')).ok).toBe(true)
  })

  test('project_published refuses until a project has publishedAt', async () => {
    projects = [{ name: 'Landing', workspaceId: WS, publishedAt: null }]
    const before = await evaluateLessonCheck(WS, 'project_published')
    expect(before.ok).toBe(false)
    expect(before.message).toContain('Publish your site')
    projects[0].publishedAt = new Date()
    expect((await evaluateLessonCheck(WS, 'project_published')).ok).toBe(true)
  })

  test('board_cards counts the named board, and the count is inclusive', async () => {
    boards = [{ id: 'b-content', name: 'Content', workspaceId: WS, archivedAt: null }]
    workItems = Array.from({ length: 4 }, () => ({ boardId: 'b-content', archivedAt: null }))
    const short = await evaluateLessonCheck(WS, 'board_cards:Content:5')
    expect(short.ok).toBe(false)
    expect(short.message).toContain('has 4 cards')
    workItems.push({ boardId: 'b-content', archivedAt: null })
    expect((await evaluateLessonCheck(WS, 'board_cards:Content:5')).ok).toBe(true)
  })

  test('board_cards names a missing board instead of counting zero', async () => {
    const r = await evaluateLessonCheck(WS, 'board_cards:Campaigns:6')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('no Campaigns board')
  })

  test('schedules_enabled does not count the schedules the pack created', async () => {
    enrollments = [
      {
        id: 'e1',
        workspaceId: WS,
        userId: USER,
        courseId: 'solo-founder-v1',
        status: 'active',
        packBindings: { schedules: { nudge: 'sched-coach' } },
      },
    ]
    schedules = [
      { id: 'sched-coach', workspaceId: WS, enabled: true },
      { id: 'sched-1', workspaceId: WS, enabled: true },
      { id: 'sched-2', workspaceId: WS, enabled: true },
    ]
    expect(await countOwnSchedules(WS, ['sched-coach'])).toBe(2)
    const r = await evaluateLessonCheck(WS, 'schedules_enabled:3')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('2 enabled schedules of your own')
    schedules.push({ id: 'sched-3', workspaceId: WS, enabled: true })
    expect((await evaluateLessonCheck(WS, 'schedules_enabled:3')).ok).toBe(true)
  })

  test('a disabled schedule does not count', async () => {
    schedules = [
      { id: 'sched-1', workspaceId: WS, enabled: true },
      { id: 'sched-2', workspaceId: WS, enabled: false },
      { id: 'sched-3', workspaceId: WS, enabled: false },
    ]
    expect((await evaluateLessonCheck(WS, 'schedules_enabled:3')).ok).toBe(false)
  })

  test('none always passes: the Coach judges those lessons', async () => {
    expect((await evaluateLessonCheck(WS, 'none')).ok).toBe(true)
  })

  test('the gate only applies to the course board, into a done column', async () => {
    const base = { workspaceId: WS, itemFields: { check: 'project_published' }, itemKey: 'SF-1' }
    expect(
      await checkCourseLessonMove({ ...base, board: { name: 'Backlog', templateId: 'build-backlog' }, columnCategory: 'done' }),
    ).toBeNull()
    expect(
      await checkCourseLessonMove({
        ...base,
        board: { name: 'Course', templateId: SOLO_FOUNDER_COURSE_BOARD_TEMPLATE },
        columnCategory: 'active',
      }),
    ).toBeNull()
    const refused = await checkCourseLessonMove({
      ...base,
      board: { name: 'Course', templateId: SOLO_FOUNDER_COURSE_BOARD_TEMPLATE },
      columnCategory: 'done',
    })
    expect(refused?.ok).toBe(false)
  })

  test('a card with no check cannot be closed on the Course board', async () => {
    const r = await checkCourseLessonMove({
      workspaceId: WS,
      board: { name: 'Course', templateId: SOLO_FOUNDER_COURSE_BOARD_TEMPLATE },
      columnCategory: 'done',
      itemFields: {},
      itemKey: 'SF-9',
    })
    expect(r?.ok).toBe(false)
    expect(r?.message).toContain('not a lesson card')
  })
})

// ────────────────────────────────────────────────────────────────────
// AC6 — the overage cap
// ────────────────────────────────────────────────────────────────────

describe('AC6 default overage cap', () => {
  test('the offer defaults to $50/mo and says so in its pricing', () => {
    expect(SOLO_FOUNDER_OVERAGE_CAP_USD).toBe(50)
    expect(SOLO_FOUNDER_PRICING.overageCapUsd).toBe(50)
  })

  test("a cap the person chose is never overwritten", async () => {
    walletCaps.set(WS, 12)
    expect(await applyDefaultOverageCap(WS)).toBe(false)
    expect(walletUpserts.length).toBe(0)
    expect(walletCaps.get(WS)).toBe(12)
  })
})
