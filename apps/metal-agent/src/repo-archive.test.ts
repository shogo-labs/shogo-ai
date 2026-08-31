// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { planDataWrite } from './project-data-archive'
import { repoArchiveKey, repoQuarantineKey } from './repo-archive'

describe('repoArchiveKey / repoQuarantineKey', () => {
  test('the durable key matches repo-store.ts so restore needs no new name', () => {
    expect(repoArchiveKey('proj-1')).toBe('proj-1/repo.git.tar.gz')
  })

  test('quarantine shares the conflict/ prefix (one lifecycle rule) but is marked as repo', () => {
    const k = repoQuarantineKey('proj-1')
    expect(k.startsWith('conflict/proj-1/')).toBe(true)
    expect(k.endsWith('-repo.tar.gz')).toBe(true)
  })
})

describe('repo lineage reuses the writable-state write plan', () => {
  test('descends may replace exactly that object', () => {
    expect(planDataWrite({ kind: 'descends', etag: '"abc"' })).toEqual({
      action: 'compare-and-swap',
      ifMatch: '"abc"',
    })
  })

  test('create-only may create and never overwrite', () => {
    expect(planDataWrite({ kind: 'create-only' })).toEqual({ action: 'create-only' })
  })

  test('untrusted writes nothing', () => {
    expect(planDataWrite({ kind: 'untrusted', reason: 'hydrate failed' })).toEqual({
      action: 'refuse',
      reason: 'hydrate failed',
    })
  })
})
