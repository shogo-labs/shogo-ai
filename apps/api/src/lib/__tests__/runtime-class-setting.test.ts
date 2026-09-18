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

mock.module('../prisma', () => ({
  prisma: {
    platformSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) =>
        storedRow && storedRow.key === key ? storedRow : null,
    },
  },
}))

const {
  DOCKER_CLASS_SETTING_KEY,
  getDockerClassOverride,
  setDockerClassOverride,
  loadDockerClassOverride,
  isDockerClassEnabled,
} = await import('../runtime-class-setting')

const ENV_KEY = 'DOCKER_CLASS_ENABLED'
let prevEnv: string | undefined

beforeEach(() => {
  storedRow = null
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
