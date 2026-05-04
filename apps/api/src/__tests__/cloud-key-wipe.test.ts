// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud Key Self-Heal Tests — wipeCloudKey contract: clears env + localConfig,
 * stops the tunnel, no-ops when unauthenticated, debounces concurrent callers.
 * Run: bun test apps/api/src/__tests__/cloud-key-wipe.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// ─── Mocks ──────────────────────────────────────────────────────────────────

const localConfig = new Map<string, string>()
const mockPrisma = {
  localConfig: {
    findUnique: mock(async (args: { where: { key: string } }) => {
      const value = localConfig.get(args.where.key)
      return value === undefined ? null : { key: args.where.key, value }
    }),
    upsert: mock(async (args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }) => {
      localConfig.set(args.where.key, args.update.value ?? args.create.value)
      return { key: args.where.key, value: localConfig.get(args.where.key)! }
    }),
    deleteMany: mock(async (args: { where: { key: string } }) => {
      const existed = localConfig.delete(args.where.key)
      return { count: existed ? 1 : 0 }
    }),
  },
}

const stopInstanceTunnel = mock(() => {})

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: mock(() => {}),
  stopInstanceTunnel,
}))

// Import AFTER mocks
const { wipeCloudKey, _testing } = await import('../lib/cloud-key-wipe')

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('wipeCloudKey', () => {
  beforeEach(() => {
    localConfig.clear()
    localConfig.set('SHOGO_API_KEY', 'shogo_sk_test_revoked')
    localConfig.set('SHOGO_KEY_INFO', JSON.stringify({ workspace: { id: 'ws-1' } }))
    process.env.SHOGO_API_KEY = 'shogo_sk_test_revoked'
    stopInstanceTunnel.mockClear()
    mockPrisma.localConfig.deleteMany.mockClear()
    _testing.reset()
  })

  afterEach(() => {
    delete process.env.SHOGO_API_KEY
  })

  test('clears env, localConfig, and stops the tunnel', async () => {
    const result = await wipeCloudKey('test-trigger')

    expect(result.wiped).toBe(true)
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    expect(localConfig.has('SHOGO_API_KEY')).toBe(false)
    expect(localConfig.has('SHOGO_KEY_INFO')).toBe(false)
    expect(mockPrisma.localConfig.deleteMany).toHaveBeenCalledTimes(2)
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
  })

  test('is a no-op when no key is set', async () => {
    delete process.env.SHOGO_API_KEY
    localConfig.clear()
    mockPrisma.localConfig.deleteMany.mockClear()
    stopInstanceTunnel.mockClear()

    const result = await wipeCloudKey('test-noop')

    expect(result.wiped).toBe(false)
    expect(mockPrisma.localConfig.deleteMany).not.toHaveBeenCalled()
    expect(stopInstanceTunnel).not.toHaveBeenCalled()
  })

  test('coalesces concurrent callers — three forwarders racing should wipe once', async () => {
    const [a, b, c] = await Promise.all([
      wipeCloudKey('caller-a'),
      wipeCloudKey('caller-b'),
      wipeCloudKey('caller-c'),
    ])

    const wins = [a, b, c].filter((r) => r.wiped)
    expect(wins.length).toBe(1)
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
    expect(mockPrisma.localConfig.deleteMany).toHaveBeenCalledTimes(2)
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
  })

  test('dedups follow-up wipes within the dedup window', async () => {
    await wipeCloudKey('first')
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)

    // Sign back in + revoke again inside the window — should still no-op.
    process.env.SHOGO_API_KEY = 'shogo_sk_test_again'
    localConfig.set('SHOGO_API_KEY', 'shogo_sk_test_again')
    const second = await wipeCloudKey('second')
    expect(second.wiped).toBe(false)
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
  })
})
