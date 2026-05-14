// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.SHOGO_LOCAL_MODE = 'true'

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

let rawQueue: any[][] = []
let users: any[] = []
let userCount = 0
let projectGroupRows: any[] = []
let spendRows: any[] = []

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    $queryRawUnsafe: async () => rawQueue.shift() ?? [],
    user: {
      findMany: async () => users,
      count: async () => userCount,
    },
    project: {
      groupBy: async () => projectGroupRows,
    },
    usageEvent: {
      groupBy: async () => spendRows,
    },
  },
}))

const analytics = await import('../services/analytics.service')

beforeEach(() => {
  rawQueue = []
  users = []
  userCount = 0
  projectGroupRows = []
  spendRows = []
})

describe('analytics service SQLite raw SQL branches', () => {
  test('getUserFunnel maps bigint SQLite aggregates and nullable averages', async () => {
    rawQueue.push([
      {
        signups: 4n,
        onboarded: 3n,
        createdProject: 2n,
        sentMessage: 1n,
        engaged: 0n,
        avgMinToFirstProject: null,
        avgMinToFirstMessage: 12.5,
      },
    ])

    const result = await analytics.getUserFunnel('30d', true)

    expect(result).toEqual({
      signups: 4,
      onboarded: 3,
      createdProject: 2,
      sentMessage: 1,
      engaged: 0,
      avgMinToFirstProject: null,
      avgMinToFirstMessage: 12.5,
    })
  })

  test('getUserActivityTable uses SQLite count queries and preserves empty aggregates as zeros', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const lastActiveAt = new Date('2026-01-02T00:00:00Z')
    users = [
      {
        id: 'u-1',
        name: 'Ada',
        email: 'ada@example.com',
        createdAt,
        signupAttribution: { sourceTag: 'organic' },
        sessions: [{ updatedAt: lastActiveAt }],
      },
    ]
    userCount = 1
    projectGroupRows = [{ createdBy: 'u-1', _count: 2 }]
    rawQueue.push(
      [{ userId: 'u-1', count: 5n }],
      [{ userId: 'u-1', count: 3n }],
      [{ userId: 'u-1', count: 7n }],
    )
    spendRows = [{ memberId: 'u-1', _sum: { billedUsd: 1.25 } }]

    const result = await analytics.getUserActivityTable('7d', { excludeInternal: true })

    expect(result.total).toBe(1)
    expect(result.users[0]).toMatchObject({
      id: 'u-1',
      sourceTag: 'organic',
      projects: 2,
      messages: 5,
      sessions: 3,
      toolCalls: 7,
      spendUsd: 1.25,
    })
    expect(result.users[0].signupAt).toBe(createdAt.toISOString())
    expect(result.users[0].lastActiveAt).toBe(lastActiveAt.toISOString())
  })
})
