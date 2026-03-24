// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Service Tests
 *
 * Tests the new analytics functions: funnel, user activity, template engagement,
 * source breakdown, chat conversations, and internal user exclusion.
 *
 * Run: bun test apps/api/src/__tests__/analytics-service.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const mockPrisma = {
  $queryRawUnsafe: mock(() => Promise.resolve([])),
  user: {
    findMany: mock(() => Promise.resolve([])),
    count: mock(() => Promise.resolve(0)),
  },
  project: {
    groupBy: mock(() => Promise.resolve([])),
  },
  chatMessage: {
    groupBy: mock(() => Promise.resolve([])),
  },
  usageEvent: {
    groupBy: mock(() => Promise.resolve([])),
  },
  signupAttribution: {
    findMany: mock(() => Promise.resolve([])),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))

const {
  realUserWhere,
  getUserFunnel,
  getUserActivityTable,
  getTemplateEngagement,
  getChatConversations,
  getSourceBreakdown,
  deriveSourceTag,
} = await import('../services/analytics.service')

beforeEach(() => {
  for (const key of Object.keys(mockPrisma)) {
    const val = (mockPrisma as any)[key]
    if (typeof val === 'function' && val.mockReset) val.mockReset()
    if (typeof val === 'object' && val !== null) {
      for (const method of Object.keys(val)) {
        if (typeof val[method]?.mockReset === 'function') val[method].mockReset()
      }
    }
  }
})

describe('realUserWhere', () => {
  test('returns Prisma where input with exclusion filters', () => {
    const where = realUserWhere()
    expect(where).toBeDefined()
    expect(where.AND).toBeArray()
    const andClauses = where.AND as any[]
    expect(andClauses.length).toBeGreaterThanOrEqual(4)
    expect(andClauses[0]).toEqual({ role: { not: 'super_admin' } })
  })
})

describe('deriveSourceTag', () => {
  test('google + cpc -> google-ads', () => {
    expect(deriveSourceTag({ utmSource: 'google', utmMedium: 'cpc' })).toBe('google-ads')
  })

  test('facebook + cpc -> facebook-ads', () => {
    expect(deriveSourceTag({ utmSource: 'facebook', utmMedium: 'cpc' })).toBe('facebook-ads')
  })

  test('utm_source without cpc -> raw value', () => {
    expect(deriveSourceTag({ utmSource: 'newsletter', utmMedium: 'email' })).toBe('newsletter')
  })

  test('referrer with google -> organic:google', () => {
    expect(deriveSourceTag({ referrer: 'https://www.google.com/search?q=shogo' })).toBe('organic:google')
  })

  test('referrer with unknown domain -> referral:domain', () => {
    expect(deriveSourceTag({ referrer: 'https://www.producthunt.com/posts/shogo' })).toBe('referral:producthunt.com')
  })

  test('google OAuth method -> google-oauth', () => {
    expect(deriveSourceTag({ method: 'google' })).toBe('google-oauth')
  })

  test('no data -> direct', () => {
    expect(deriveSourceTag({})).toBe('direct')
  })

  test('null values -> direct', () => {
    expect(deriveSourceTag({ utmSource: null, utmMedium: null, referrer: null, method: null })).toBe('direct')
  })
})

describe('getUserFunnel', () => {
  test('returns correct shape from raw query', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      signups: 10,
      onboarded: 8,
      createdProject: 5,
      sentMessage: 3,
      engaged: 1,
      avgMinToFirstProject: 15.2,
      avgMinToFirstMessage: 22.5,
    }])

    const result = await getUserFunnel('30d', true)
    expect(result.signups).toBe(10)
    expect(result.onboarded).toBe(8)
    expect(result.createdProject).toBe(5)
    expect(result.sentMessage).toBe(3)
    expect(result.engaged).toBe(1)
    expect(result.avgMinToFirstProject).toBe(15.2)
    expect(result.avgMinToFirstMessage).toBe(22.5)
  })

  test('returns zeros when no data', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([])

    const result = await getUserFunnel('30d', true)
    expect(result.signups).toBe(0)
    expect(result.engaged).toBe(0)
    expect(result.avgMinToFirstProject).toBeNull()
  })

  test('raw query includes email exclusion filter when excludeInternal=true', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      signups: 0, onboarded: 0, createdProject: 0,
      sentMessage: 0, engaged: 0, avgMinToFirstProject: null, avgMinToFirstMessage: null,
    }])

    await getUserFunnel('30d', true)
    const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string
    expect(query).toContain('@test.shogo.ai')
    expect(query).toContain('@shogo.ai')
    expect(query).toContain('@getodin.ai')
    expect(query).toContain('super_admin')
  })

  test('raw query omits filter when excludeInternal=false', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{
      signups: 0, onboarded: 0, createdProject: 0,
      sentMessage: 0, engaged: 0, avgMinToFirstProject: null, avgMinToFirstMessage: null,
    }])

    await getUserFunnel('30d', false)
    const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string
    expect(query).not.toContain('@test.shogo.ai')
  })
})

describe('getSourceBreakdown', () => {
  test('returns formatted source data', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { tag: 'google-ads', count: 5, withProject: 3, withMessage: 2 },
      { tag: 'direct', count: 10, withProject: 4, withMessage: 1 },
    ])

    const result = await getSourceBreakdown('30d', true)
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0].tag).toBe('google-ads')
    expect(result.sources[0].count).toBe(5)
    expect(result.sources[0].projectRate).toBe(60)
    expect(result.sources[0].messageRate).toBe(40)
    expect(result.sources[1].tag).toBe('direct')
    expect(result.sources[1].projectRate).toBe(40)
  })

  test('handles zero counts without division by zero', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { tag: 'unknown', count: 0, withProject: 0, withMessage: 0 },
    ])

    const result = await getSourceBreakdown('30d', true)
    expect(result.sources[0].projectRate).toBe(0)
    expect(result.sources[0].messageRate).toBe(0)
  })
})

describe('getTemplateEngagement', () => {
  test('calculates engagement rate correctly', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { templateId: 'tpl-1', projects: 10, avgMessages: 5.2, totalToolCalls: 30, engagedUsers: 7, totalUsers: 10 },
    ])

    const result = await getTemplateEngagement(true)
    expect(result.templates).toHaveLength(1)
    expect(result.templates[0].templateId).toBe('tpl-1')
    expect(result.templates[0].projects).toBe(10)
    expect(result.templates[0].engagementRate).toBe(70)
  })
})

describe('getChatConversations', () => {
  test('groups messages by session', async () => {
    const since = new Date()
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { sessionId: 's1', userName: 'Alice', projectName: 'Proj1', templateId: 'tpl-1', role: 'user', content: 'Hello', sentAt: new Date() },
      { sessionId: 's1', userName: 'Alice', projectName: 'Proj1', templateId: 'tpl-1', role: 'assistant', content: 'Hi there!', sentAt: new Date() },
      { sessionId: 's2', userName: 'Bob', projectName: 'Proj2', templateId: null, role: 'user', content: 'Help me', sentAt: new Date() },
    ])

    const result = await getChatConversations(since, true)
    expect(result.conversations).toHaveLength(2)
    expect(result.conversations[0].userName).toBe('Alice')
    expect(result.conversations[0].messages).toHaveLength(2)
    expect(result.conversations[1].messages).toHaveLength(1)
  })

  test('truncation query uses RIGHT() for assistant messages', async () => {
    const since = new Date()
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([])

    await getChatConversations(since, true)
    const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string
    expect(query).toContain('RIGHT(cm."content"')
    expect(query).toContain('1000')
  })
})
