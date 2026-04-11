// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatInput Queue Chevron Visibility Tests
 *
 * Tests the pure visibility predicates that control whether up/down reorder
 * chevrons are shown for queued messages in ChatInput.
 *
 * Run: bun test apps/mobile/lib/__tests__/chat-input-queue-chevrons.test.ts
 */

import { describe, test, expect } from 'bun:test'

/** Whether the chevron controls are shown at all. */
function showChevrons(queueLength: number): boolean {
  return queueLength > 1
}

/** Whether the "move up" chevron is shown for a given row. */
function showUpChevron(index: number): boolean {
  return index > 0
}

/** Whether the "move down" chevron is shown for a given row. */
function showDownChevron(index: number, queueLength: number): boolean {
  return index < queueLength - 1
}

describe('showChevrons', () => {
  test('returns false for an empty queue', () => {
    expect(showChevrons(0)).toBe(false)
  })

  test('returns false for a single-message queue', () => {
    expect(showChevrons(1)).toBe(false)
  })

  test('returns true for two messages', () => {
    expect(showChevrons(2)).toBe(true)
  })

  test('returns true for many messages', () => {
    expect(showChevrons(5)).toBe(true)
  })
})

describe('showUpChevron', () => {
  test('returns false for the first item (index 0)', () => {
    expect(showUpChevron(0)).toBe(false)
  })

  test('returns true for the second item (index 1)', () => {
    expect(showUpChevron(1)).toBe(true)
  })

  test('returns true for a middle item', () => {
    expect(showUpChevron(2)).toBe(true)
  })

  test('returns true for the last item', () => {
    expect(showUpChevron(4)).toBe(true)
  })
})

describe('showDownChevron', () => {
  test('returns false for the only item in a 1-length queue', () => {
    expect(showDownChevron(0, 1)).toBe(false)
  })

  test('returns false for the last item', () => {
    expect(showDownChevron(4, 5)).toBe(false)
  })

  test('returns true for the first item in a multi-item queue', () => {
    expect(showDownChevron(0, 3)).toBe(true)
  })

  test('returns true for a middle item', () => {
    expect(showDownChevron(2, 5)).toBe(true)
  })

  test('returns true for the second-to-last item', () => {
    expect(showDownChevron(3, 5)).toBe(true)
  })
})

describe('combined row visibility', () => {
  test('single-item queue: no chevrons shown for that item', () => {
    const length = 1
    const index = 0
    expect(showChevrons(length)).toBe(false)
    // Even if we were to evaluate the per-row predicates they would be:
    expect(showUpChevron(index)).toBe(false)
    expect(showDownChevron(index, length)).toBe(false)
  })

  test('two-item queue, first row: only down chevron', () => {
    const length = 2
    expect(showChevrons(length)).toBe(true)
    expect(showUpChevron(0)).toBe(false)
    expect(showDownChevron(0, length)).toBe(true)
  })

  test('two-item queue, last row: only up chevron', () => {
    const length = 2
    expect(showChevrons(length)).toBe(true)
    expect(showUpChevron(1)).toBe(true)
    expect(showDownChevron(1, length)).toBe(false)
  })

  test('three-item queue, middle row: both chevrons', () => {
    const length = 3
    expect(showChevrons(length)).toBe(true)
    expect(showUpChevron(1)).toBe(true)
    expect(showDownChevron(1, length)).toBe(true)
  })

  test('three-item queue, first row: only down chevron', () => {
    const length = 3
    expect(showChevrons(length)).toBe(true)
    expect(showUpChevron(0)).toBe(false)
    expect(showDownChevron(0, length)).toBe(true)
  })

  test('three-item queue, last row: only up chevron', () => {
    const length = 3
    expect(showChevrons(length)).toBe(true)
    expect(showUpChevron(2)).toBe(true)
    expect(showDownChevron(2, length)).toBe(false)
  })
})
