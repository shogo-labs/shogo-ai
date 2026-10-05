// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_BUDDY_LOOK, seededBuddyLook } from '@shogo/shared-app/buddy-look'
import {
  getSnapshot,
  nextSnapshotRequest,
  requestSnapshot,
  resetSnapshots,
  resolveSnapshot,
  snapshotKey,
  snapshotVersion,
} from '../buddy-snapshots'

beforeEach(() => resetSnapshots())

describe('buddy snapshots', () => {
  test('the same look and colour share one picture; different ones do not', () => {
    const a = seededBuddyLook('a')
    expect(snapshotKey(a, '#fb8c00')).toBe(snapshotKey({ ...a }, '#FB8C00'))
    expect(snapshotKey(a, '#FB8C00')).not.toBe(snapshotKey(seededBuddyLook('b'), '#FB8C00'))
    expect(snapshotKey(DEFAULT_BUDDY_LOOK, '#FB8C00')).not.toBe(snapshotKey(DEFAULT_BUDDY_LOOK, '#2563EB'))
  })

  test('requests queue once, in order, until drawn', () => {
    const a = seededBuddyLook('a')
    const b = seededBuddyLook('b')
    const keyA = requestSnapshot(a, '#111111')
    requestSnapshot(a, '#111111')
    const keyB = requestSnapshot(b, '#222222')
    expect(nextSnapshotRequest()?.key).toBe(keyA)

    const before = snapshotVersion()
    resolveSnapshot(keyA, 'data:image/png;base64,AAA')
    expect(snapshotVersion()).toBeGreaterThan(before)
    expect(getSnapshot(keyA)).toBe('data:image/png;base64,AAA')
    expect(nextSnapshotRequest()?.key).toBe(keyB)
  })

  test('a cached look is not requested again', () => {
    const a = seededBuddyLook('a')
    const key = requestSnapshot(a, '#111111')
    resolveSnapshot(key, 'data:image/png;base64,AAA')
    requestSnapshot(a, '#111111')
    expect(nextSnapshotRequest()).toBeNull()
  })

  test('a failed draw leaves the queue moving and can be retried', () => {
    const a = seededBuddyLook('a')
    const key = requestSnapshot(a, '#333333')
    resolveSnapshot(key, null)
    expect(getSnapshot(key)).toBeNull()
    expect(nextSnapshotRequest()).toBeNull()
    requestSnapshot(a, '#333333')
    expect(nextSnapshotRequest()?.key).toBe(key)
  })
})
