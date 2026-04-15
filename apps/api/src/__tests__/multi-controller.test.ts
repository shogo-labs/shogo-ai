// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Multi-Controller & Active Controller Tracking Tests (Phase 3)
 *
 * Run: bun test apps/api/src/__tests__/multi-controller.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const mockPrisma = {
  instance: {
    upsert: mock(() => Promise.resolve({ id: 'inst-1', workspaceId: 'ws-1', wsRequestedAt: null })),
    findUnique: mock(() => Promise.resolve({ id: 'inst-1', workspaceId: 'ws-1', name: 'test', lastSeenAt: new Date() })),
    findMany: mock(() => Promise.resolve([])),
    update: mock(() => Promise.resolve({ id: 'inst-1' })),
    delete: mock(() => Promise.resolve({ id: 'inst-1' })),
  },
  member: {
    findFirst: mock(() => Promise.resolve({ id: 'member-1', userId: 'user-1', workspaceId: 'ws-1' })),
  },
  remoteAction: {
    create: mock(() => Promise.resolve({ id: 'ra-1' })),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(async () => null),
}))

const { _testing } = await import('../routes/instances')

describe('Active Controller Tracking', () => {
  beforeEach(() => {
    _testing.activeControllers.clear()
  })

  test('markControllerActive adds a controller', () => {
    _testing.markControllerActive('inst-1', 'user-1')
    const controllers = _testing.getActiveControllers('inst-1')
    expect(controllers).toHaveLength(1)
    expect(controllers[0].userId).toBe('user-1')
  })

  test('multiple controllers tracked separately', () => {
    _testing.markControllerActive('inst-1', 'user-1')
    _testing.markControllerActive('inst-1', 'user-2')
    const controllers = _testing.getActiveControllers('inst-1')
    expect(controllers).toHaveLength(2)
  })

  test('same user refreshes rather than duplicates', () => {
    _testing.markControllerActive('inst-1', 'user-1')
    _testing.markControllerActive('inst-1', 'user-1')
    const controllers = _testing.getActiveControllers('inst-1')
    expect(controllers).toHaveLength(1)
  })

  test('different instances are independent', () => {
    _testing.markControllerActive('inst-1', 'user-1')
    _testing.markControllerActive('inst-2', 'user-2')
    expect(_testing.getActiveControllers('inst-1')).toHaveLength(1)
    expect(_testing.getActiveControllers('inst-2')).toHaveLength(1)
    expect(_testing.getActiveControllers('inst-3')).toHaveLength(0)
  })

  test('controllers with session IDs tracked separately', () => {
    _testing.markControllerActive('inst-1', 'user-1', 'session-a')
    _testing.markControllerActive('inst-1', 'user-1', 'session-b')
    const controllers = _testing.getActiveControllers('inst-1')
    expect(controllers).toHaveLength(2)
    expect(controllers[0].userId).toBe('user-1')
    expect(controllers[1].userId).toBe('user-1')
  })

  test('empty instance returns empty array', () => {
    expect(_testing.getActiveControllers('nonexistent')).toEqual([])
  })
})
