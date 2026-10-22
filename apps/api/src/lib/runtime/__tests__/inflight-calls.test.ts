// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-flight project calls (SHO-143). A call that has been sent but has not
 * landed as a turn on the target runtime is invisible to `/pool/activity`, and
 * that gap is exactly when the background pool used to evict the runtime it
 * was about to work in. The counter closes the gap; these pin that it stays
 * balanced and never goes negative.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { inflightCallCount, noteInflightCall, resetInflightCalls } from '../inflight-calls'

beforeEach(() => {
  resetInflightCalls()
})

describe('inflight call tracking', () => {
  it('counts overlapping calls to the same project', () => {
    noteInflightCall('p1', 1)
    noteInflightCall('p1', 1)
    expect(inflightCallCount('p1')).toBe(2)
    noteInflightCall('p1', -1)
    expect(inflightCallCount('p1')).toBe(1)
  })

  it('keeps projects independent', () => {
    noteInflightCall('p1', 1)
    expect(inflightCallCount('p2')).toBe(0)
  })

  it('never goes negative when a release has no matching acquire', () => {
    noteInflightCall('p1', -1)
    expect(inflightCallCount('p1')).toBe(0)
  })

  it('drops the entry when the last call finishes, so the map cannot grow unbounded', () => {
    noteInflightCall('p1', 1)
    noteInflightCall('p1', -1)
    expect(inflightCallCount('p1')).toBe(0)
  })

  it('ignores an empty project id', () => {
    noteInflightCall('', 1)
    expect(inflightCallCount('')).toBe(0)
  })
})
