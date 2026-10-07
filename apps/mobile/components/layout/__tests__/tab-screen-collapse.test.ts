// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'

// The header module pulls in native-only menus; the collapse maths is pure, so
// it is read through a mocked import boundary.
import { mock } from 'bun:test'
mock.module('../CreateMenu', () => ({ CreateMenu: () => null }))
mock.module('../ProfileMenu', () => ({ ProfileMenu: () => null }))
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
mock.module('lucide-react-native', () => ({ Plus: () => null }))

describe('headerCollapse', () => {
  test('is full size at rest', async () => {
    const { headerCollapse } = await import('../TabScreenHeader')
    expect(headerCollapse(0)).toEqual({ scale: 1, opacity: 1 })
  })

  test('shrinks to the minimum and stays there', async () => {
    const { headerCollapse } = await import('../TabScreenHeader')
    const end = headerCollapse(72)
    expect(end.scale).toBeCloseTo(0.86)
    expect(end.opacity).toBeCloseTo(0.7)
    expect(headerCollapse(500)).toEqual(end)
  })

  test('pulling down past the top does not grow it', async () => {
    const { headerCollapse } = await import('../TabScreenHeader')
    expect(headerCollapse(-40)).toEqual({ scale: 1, opacity: 1 })
  })
})
