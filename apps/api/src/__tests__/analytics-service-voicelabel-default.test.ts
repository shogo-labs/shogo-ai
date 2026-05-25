// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics service — voiceLabel default branch gap-fill.
 *
 * The existing analytics-service.expanded.test.ts covers all four named
 * voice_* action types but not the default branch (line 34) that fires
 * for an unrecognised voice_* prefix. This test pushes a usageEvent whose
 * actionType is voice_* but unrecognised, drives it through getUsageLog,
 * and asserts the fall-through label 'Voice' is emitted.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const store = { usageEvents: [] as any[], users: [] as any[] }

function makeModel(rows: any[]) {
  return {
    count: async () => rows.length,
    findMany: async (args?: any) => {
      const skip = args?.skip ?? 0
      const take = args?.take ?? rows.length
      return rows.slice(skip, skip + take)
    },
    findUnique: async (args: any) => rows.find((r) => r.id === args?.where?.id) ?? null,
  }
}

const mockPrisma: any = {
  usageEvent: makeModel(store.usageEvents),
  user: makeModel(store.users),
  $queryRawUnsafe: async () => [],
  $queryRaw: async () => [],
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
  Prisma: { raw: (s: string) => s, sql: (s: string) => s, empty: '' },
}))

const analytics = await import('../services/analytics.service')

function rebuildModels() {
  mockPrisma.usageEvent = makeModel(store.usageEvents)
  mockPrisma.user = makeModel(store.users)
}

beforeEach(() => {
  store.usageEvents.length = 0
  store.users.length = 0
  rebuildModels()
})

describe('voiceLabel default branch', () => {
  test('returns "Voice" for an unrecognised voice_* action type', async () => {
    store.usageEvents.push({
      id: 'e-unknown-voice',
      actionType: 'voice_something_brand_new',
      memberId: 'u-1',
      billedUsd: 0,
      rawUsd: 0,
      workspaceId: 'w-1',
      projectId: 'p-1',
      source: 'overage',
      createdAt: new Date(),
      actionMetadata: {},
    })
    rebuildModels()
    const out = await analytics.getUsageLog({ workspaceId: 'w-1' })
    const entry = out.entries.find((e: any) => e.id === 'e-unknown-voice')
    expect(entry).toBeDefined()
    expect(entry!.model).toBe('Voice')
    expect(entry!.provider).toBe('elevenlabs')
  })
})
