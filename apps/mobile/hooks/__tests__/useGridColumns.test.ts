// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { marketplaceGridColumns, MARKETPLACE_GRID_H_PADDING, MARKETPLACE_GRID_PAD_X } from '../useGridColumns'
import { nativeGridChipWidth } from '../../lib/native-phone-layout'

describe('marketplaceGridColumns', () => {
  test('matches the phone / tablet / desktop breakpoints', () => {
    expect(marketplaceGridColumns(402)).toBe(1)
    expect(marketplaceGridColumns(479)).toBe(1)
    expect(marketplaceGridColumns(480)).toBe(2)
    expect(marketplaceGridColumns(767)).toBe(2)
    expect(marketplaceGridColumns(768)).toBe(3)
    expect(marketplaceGridColumns(1079)).toBe(3)
    expect(marketplaceGridColumns(1080)).toBe(4)
  })
})

describe('MARKETPLACE_GRID_H_PADDING', () => {
  test('is FlatList paddingHorizontal on both sides', () => {
    expect(MARKETPLACE_GRID_PAD_X).toBe(12)
    expect(MARKETPLACE_GRID_H_PADDING).toBe(MARKETPLACE_GRID_PAD_X * 2)
    expect(nativeGridChipWidth(402 - MARKETPLACE_GRID_H_PADDING, 1, 0)).toBe(378)
  })
})
