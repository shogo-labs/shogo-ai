// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The shared read-only loop that every dm-snapshot VM uses as its origin.
 *
 * Replacing the golden image is a rename, and a loop attached before the rename
 * keeps serving the old inode for the life of the process. On staging that kept
 * a broken image in service after the fixed one was renamed in: the loop was
 * still bound to the image with no `/usr/local/bin/fc-init`, so every cold boot
 * panicked with `Requested init /usr/local/bin/fc-init failed (error -2)` while
 * the file on disk was correct (SHO-549).
 */

import { describe, expect, test } from 'bun:test'
import { baseLoopState } from './rootfs'

const BASE = '/opt/fc-spike/img/runtime.ext4'

describe('baseLoopState', () => {
  test('the current image is the one the loop is attached to', () => {
    expect(baseLoopState(BASE, BASE)).toBe('current')
  })

  test('a loop left on a renamed-away image is stale', () => {
    // The kernel appends this suffix once the backing file is unlinked or
    // renamed over — it is what a replaced golden image looks like from sysfs.
    expect(baseLoopState(`${BASE} (deleted)`, BASE)).toBe('stale')
  })

  test('a loop on some other file is stale too', () => {
    expect(baseLoopState('/opt/fc-spike/img/runtime.ext4.prev-jul5', BASE)).toBe('stale')
  })

  test('an unreadable backing path is unknown, not a switch', () => {
    // Re-attaching on a lost sysfs read would churn a loop device per provision.
    expect(baseLoopState('', BASE)).toBe('unknown')
  })
})
