// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests the env-var contract for `SHOGO_CLOUD_SYNC_MODE`.
 *
 * The agent-runtime (`packages/agent-runtime/src/server.ts`) routes
 * its sync-instance creation through `resolveCloudSyncMode`, so this
 * test exercises that contract directly without booting the runtime.
 */

import { describe, test, expect } from 'bun:test'
import { resolveCloudSyncMode } from '../git-sync'

describe('resolveCloudSyncMode', () => {
  test('defaults to git_only when SHOGO_CLOUD_SYNC_MODE is unset', () => {
    expect(resolveCloudSyncMode({})).toBe('git_only')
  })

  test('routes "dual_shadow"', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'dual_shadow' })).toBe('dual_shadow')
  })

  test('routes "git_only"', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'git_only' })).toBe('git_only')
  })

  test('routes explicit "s3"', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 's3' })).toBe('s3')
  })

  test('is case-insensitive', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'GIT_ONLY' })).toBe('git_only')
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'Dual_Shadow' })).toBe('dual_shadow')
  })

  test('clamps unrecognized values to git_only (new default)', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'magic' })).toBe('git_only')
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: '' })).toBe('git_only')
  })
})
