// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Coverage-gap closer for src/lib/cloud-key-wipe.ts.
 *
 * The existing cloud-key-wipe.test.ts happy-paths the wipe flow.
 * Three catch handlers are never exercised:
 *   - line 38: localConfig SHOGO_API_KEY delete failure
 *   - line 43: localConfig SHOGO_KEY_INFO delete failure
 *   - line 53: instance-tunnel import / stopInstanceTunnel failure
 *
 * This file forces each rejection in turn and verifies the wipe still
 * completes (the contract: best-effort cleanup, never throws to caller).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Per-test prisma behavior: each catch path needs a controllable error.
const deleteManyMock = mock(async (args: { where: { key: string } }) => ({
  count: 0,
})) as ReturnType<typeof mock>

const stopInstanceTunnel = mock(() => {})

mock.module('../lib/prisma', () => ({
  prisma: { localConfig: { deleteMany: deleteManyMock } },
}))
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: mock(() => {}),
  stopInstanceTunnel,
}))

const { wipeCloudKey, _testing } = await import('../lib/cloud-key-wipe')

let errorSpy: ReturnType<typeof spyOn>
let warnSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  process.env.SHOGO_API_KEY = 'sk_to_be_wiped'
  _testing.reset()
  deleteManyMock.mockReset()
  stopInstanceTunnel.mockReset()
  stopInstanceTunnel.mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.SHOGO_API_KEY
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('wipeCloudKey — localConfig deletion failures (lines 36-44)', () => {
  test('continues and logs when SHOGO_API_KEY delete throws', async () => {
    deleteManyMock.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === 'SHOGO_API_KEY') throw new Error('disk full')
      return { count: 1 }
    })

    const result = await wipeCloudKey('test: api-key delete error')
    expect(result).toEqual({ wiped: true })
    // Env var still cleared — the catch swallows the prisma error.
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    // Specific catch handler logged the failure.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('localConfig SHOGO_API_KEY delete failed')
    expect(logged).toContain('disk full')
    // Tunnel still stopped.
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
  })

  test('continues and logs when SHOGO_KEY_INFO delete throws', async () => {
    deleteManyMock.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === 'SHOGO_KEY_INFO') throw new Error('lock contention')
      return { count: 1 }
    })

    const result = await wipeCloudKey('test: key-info delete error')
    expect(result).toEqual({ wiped: true })
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('localConfig SHOGO_KEY_INFO delete failed')
    expect(logged).toContain('lock contention')
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
  })

  test('continues and logs when BOTH deleteMany calls throw simultaneously', async () => {
    deleteManyMock.mockImplementation(async () => {
      throw new Error('total db outage')
    })

    const result = await wipeCloudKey('test: both delete errors')
    expect(result).toEqual({ wiped: true })
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('SHOGO_API_KEY delete failed')
    expect(logged).toContain('SHOGO_KEY_INFO delete failed')
    expect(stopInstanceTunnel).toHaveBeenCalledTimes(1)
  })
})

describe('wipeCloudKey — instance-tunnel failure (line 53)', () => {
  test('catches and logs when stopInstanceTunnel throws', async () => {
    deleteManyMock.mockImplementation(async () => ({ count: 1 }))
    stopInstanceTunnel.mockImplementation(() => {
      throw new Error('tunnel client crashed')
    })

    const result = await wipeCloudKey('test: tunnel stop error')
    // Wipe still reports success — tunnel failure must not propagate.
    expect(result).toEqual({ wiped: true })
    expect(process.env.SHOGO_API_KEY).toBeUndefined()

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Failed to stop instance tunnel')
    expect(logged).toContain('tunnel client crashed')
  })

  test('still releases inFlight + sets lastWipeAt after tunnel failure', async () => {
    deleteManyMock.mockImplementation(async () => ({ count: 1 }))
    stopInstanceTunnel.mockImplementation(() => {
      throw new Error('tunnel crashed')
    })

    await wipeCloudKey('first call with tunnel failure')

    // The dedup window means an immediate second call should be a no-op
    // (not crash, not "wiped" again). This proves the `finally` block ran.
    process.env.SHOGO_API_KEY = 'set-again'
    const result2 = await wipeCloudKey('second call within dedup window')
    expect(result2).toEqual({ wiped: false })
  })
})

describe('wipeCloudKey — combined failure paths', () => {
  test('all three catch handlers fire in one call without throwing to caller', async () => {
    deleteManyMock.mockImplementation(async () => {
      throw new Error('db down')
    })
    stopInstanceTunnel.mockImplementation(() => {
      throw new Error('tunnel down')
    })

    const result = await wipeCloudKey('test: all paths fail')
    expect(result).toEqual({ wiped: true })
    expect(process.env.SHOGO_API_KEY).toBeUndefined()

    // All three error logs present.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('SHOGO_API_KEY delete failed')
    expect(logged).toContain('SHOGO_KEY_INFO delete failed')
    expect(logged).toContain('Failed to stop instance tunnel')
  })

  test('warn log still fires on the wipe attempt regardless of downstream failures', async () => {
    deleteManyMock.mockImplementation(async () => {
      throw new Error('db down')
    })
    await wipeCloudKey('reason-string-for-log')

    const warns = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warns).toContain('[CloudKeyWipe] Clearing SHOGO_API_KEY')
    expect(warns).toContain('reason-string-for-log')
  })
})
