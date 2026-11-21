// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/runtime-class-setting.ts — the platform gate
 * for the Docker-capable ("Tier 2") project class, backed by the
 * `platform_settings` (`PlatformSetting`) table.
 *
 *   bun test apps/api/src/lib/__tests__/runtime-class-setting.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

let storedRow: { key: string; value: string } | null = null
let readError: Error | null = null
let readGate: Promise<void> | null = null

mock.module('../prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) => {
        if (readGate) await readGate
        if (readError) throw readError
        return storedRow && storedRow.key === key ? storedRow : null
      },
    },
  },
}))

const {
  DOCKER_CLASS_SETTING_KEY,
  getDockerClassOverride,
  setDockerClassOverride,
  loadDockerClassOverride,
  startDockerClassOverrideRefresh,
  stopDockerClassOverrideRefresh,
  isDockerClassEnabled,
} = await import('../runtime-class-setting')

const ENV_KEY = 'DOCKER_CLASS_ENABLED'
let prevEnv: string | undefined

beforeEach(() => {
  storedRow = null
  readError = null
  readGate = null
  stopDockerClassOverrideRefresh()
  setDockerClassOverride(null)
  prevEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
})

describe('runtime-class-setting', () => {
  test('defaults to null (no override) before anything is loaded or set', () => {
    expect(getDockerClassOverride()).toBeNull()
  })

  test('setDockerClassOverride updates the in-memory value immediately', () => {
    setDockerClassOverride(true)
    expect(getDockerClassOverride()).toBe(true)
    setDockerClassOverride(false)
    expect(getDockerClassOverride()).toBe(false)
    setDockerClassOverride(null)
    expect(getDockerClassOverride()).toBeNull()
  })

  test('loadDockerClassOverride reads a persisted "true" row into memory', async () => {
    storedRow = { key: DOCKER_CLASS_SETTING_KEY, value: 'true' }
    await loadDockerClassOverride()
    expect(getDockerClassOverride()).toBe(true)
  })

  test('loadDockerClassOverride reads a persisted "false" row into memory', async () => {
    storedRow = { key: DOCKER_CLASS_SETTING_KEY, value: 'false' }
    await loadDockerClassOverride()
    expect(getDockerClassOverride()).toBe(false)
  })

  test('loadDockerClassOverride leaves the override null when no row exists', async () => {
    storedRow = null
    await loadDockerClassOverride()
    expect(getDockerClassOverride()).toBeNull()
  })

  test('loadDockerClassOverride clears a stale in-memory value when the row was deleted', async () => {
    // Another instance cleared the setting (PUT enabled: null) — this one must follow.
    setDockerClassOverride(true)
    storedRow = null
    await loadDockerClassOverride()
    expect(getDockerClassOverride()).toBeNull()
  })

  test('loadDockerClassOverride keeps the last known value when the DB read fails', async () => {
    setDockerClassOverride(true)
    readError = new Error('db unavailable')
    await loadDockerClassOverride()
    expect(getDockerClassOverride()).toBe(true)
  })

  test('a direct write during an in-flight refresh is not overwritten by the stale read', async () => {
    // Refresh reads the old DB value, the admin PUT lands, then the read resolves.
    storedRow = { key: DOCKER_CLASS_SETTING_KEY, value: 'false' }
    let releaseRead!: () => void
    readGate = new Promise((r) => (releaseRead = r))

    const refresh = loadDockerClassOverride()
    setDockerClassOverride(true)
    releaseRead()
    await refresh

    expect(getDockerClassOverride()).toBe(true)
  })

  test('startDockerClassOverrideRefresh picks up DB changes made after boot', async () => {
    const realSetInterval = globalThis.setInterval
    let tick: (() => Promise<void>) | undefined
    let scheduledMs: number | undefined
    globalThis.setInterval = ((fn: () => Promise<void>, ms: number) => {
      tick = fn
      scheduledMs = ms
      return realSetInterval(() => {}, 1_000_000)
    }) as unknown as typeof setInterval

    try {
      startDockerClassOverrideRefresh(30_000)
      expect(scheduledMs).toBe(30_000)

      storedRow = { key: DOCKER_CLASS_SETTING_KEY, value: 'true' }
      await tick!()
      expect(getDockerClassOverride()).toBe(true)

      storedRow = { key: DOCKER_CLASS_SETTING_KEY, value: 'false' }
      await tick!()
      expect(getDockerClassOverride()).toBe(false)

      storedRow = null
      await tick!()
      expect(getDockerClassOverride()).toBeNull()
    } finally {
      stopDockerClassOverrideRefresh()
      globalThis.setInterval = realSetInterval
    }
  })

  test('startDockerClassOverrideRefresh is idempotent', () => {
    startDockerClassOverrideRefresh(1_000)
    startDockerClassOverrideRefresh(1_000)
    stopDockerClassOverrideRefresh()
    // A single stop fully clears the timer; a second start should work again.
    startDockerClassOverrideRefresh(1_000)
    stopDockerClassOverrideRefresh()
  })

  describe('isDockerClassEnabled', () => {
    test('defaults to false with no override and no env var', () => {
      expect(isDockerClassEnabled()).toBe(false)
    })

    test('falls back to DOCKER_CLASS_ENABLED=true when no DB override is set', () => {
      process.env[ENV_KEY] = 'true'
      expect(isDockerClassEnabled()).toBe(true)
    })

    test('an explicit false DB override wins over a true env var', () => {
      process.env[ENV_KEY] = 'true'
      setDockerClassOverride(false)
      expect(isDockerClassEnabled()).toBe(false)
    })

    test('an explicit true DB override wins even with no env var set', () => {
      setDockerClassOverride(true)
      expect(isDockerClassEnabled()).toBe(true)
    })
  })
})
