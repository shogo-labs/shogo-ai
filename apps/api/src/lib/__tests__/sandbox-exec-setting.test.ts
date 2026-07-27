// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/sandbox-exec-setting.ts — the super-admin
 * override for Docker sandbox-exec isolation, backed by the `platform_settings`
 * (`PlatformSetting`) table.
 *
 *   bun test apps/api/src/lib/__tests__/sandbox-exec-setting.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

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
  SANDBOX_EXEC_SETTING_KEY,
  getSandboxExecOverride,
  setSandboxExecOverride,
  loadSandboxExecOverride,
} = await import('../sandbox-exec-setting')

beforeEach(() => {
  storedRow = null
  setSandboxExecOverride(null)
})

describe('sandbox-exec-setting', () => {
  test('defaults to null (no override) before anything is loaded or set', () => {
    expect(getSandboxExecOverride()).toBeNull()
  })

  test('setSandboxExecOverride updates the in-memory value immediately', () => {
    setSandboxExecOverride(true)
    expect(getSandboxExecOverride()).toBe(true)
    setSandboxExecOverride(false)
    expect(getSandboxExecOverride()).toBe(false)
    setSandboxExecOverride(null)
    expect(getSandboxExecOverride()).toBeNull()
  })

  test('loadSandboxExecOverride reads a persisted "true" row into memory', async () => {
    storedRow = { key: SANDBOX_EXEC_SETTING_KEY, value: 'true' }
    await loadSandboxExecOverride()
    expect(getSandboxExecOverride()).toBe(true)
  })

  test('loadSandboxExecOverride reads a persisted "false" row into memory', async () => {
    storedRow = { key: SANDBOX_EXEC_SETTING_KEY, value: 'false' }
    await loadSandboxExecOverride()
    expect(getSandboxExecOverride()).toBe(false)
  })

  test('loadSandboxExecOverride leaves the override null when no row exists', async () => {
    storedRow = null
    await loadSandboxExecOverride()
    expect(getSandboxExecOverride()).toBeNull()
  })
})
