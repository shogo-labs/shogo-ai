// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  recordBuildError,
  getBuildErrors,
  clearBuildErrors,
  _resetBuildBufferForTests,
} from '../diagnostics-build-buffer'

describe('diagnostics-build-buffer', () => {
  beforeEach(() => {
    _resetBuildBufferForTests()
  })

  test('recordBuildError is a no-op when projectId is empty', () => {
    recordBuildError('', { message: 'orphan' })
    expect(getBuildErrors('')).toEqual([])
  })

  test('clearBuildErrors removes only the targeted project', () => {
    recordBuildError('proj_a', { message: 'a1' })
    recordBuildError('proj_b', { message: 'b1' })
    expect(getBuildErrors('proj_a')).toHaveLength(1)
    expect(getBuildErrors('proj_b')).toHaveLength(1)

    clearBuildErrors('proj_a')

    expect(getBuildErrors('proj_a')).toEqual([])
    expect(getBuildErrors('proj_b')).toHaveLength(1)
    expect(getBuildErrors('proj_b')[0].message).toBe('b1')
  })

  test('ring buffer caps at 50 entries per project', () => {
    for (let i = 0; i < 75; i++) {
      recordBuildError('proj', { message: `err-${i}` })
    }
    const list = getBuildErrors('proj')
    expect(list).toHaveLength(50)
    // Oldest entries shifted off; newest survive.
    expect(list[0].message).toBe('err-25')
    expect(list[list.length - 1].message).toBe('err-74')
  })

  test('getBuildErrors returns [] for an unknown projectId', () => {
    expect(getBuildErrors('___no-such-project___')).toEqual([])
  })
})
