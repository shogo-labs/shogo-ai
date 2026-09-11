// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  remapAccountSheetTextClass,
  scaleAccountSheetIcon,
} from '../account-sheet-type'

describe('remapAccountSheetTextClass', () => {
  test('bumps NativeWind type one step without touching other classes', () => {
    expect(remapAccountSheetTextClass('text-sm text-muted-foreground mt-1')).toBe(
      'text-lg text-muted-foreground mt-1',
    )
    expect(remapAccountSheetTextClass('text-xs font-medium')).toBe('text-base font-medium')
    expect(remapAccountSheetTextClass('text-[11px] uppercase')).toBe('text-sm uppercase')
    expect(remapAccountSheetTextClass('text-xl font-semibold')).toBe(
      'text-2xl font-semibold',
    )
  })

  test('leaves unrelated class names alone', () => {
    expect(remapAccountSheetTextClass('flex-1 font-medium text-foreground')).toBe(
      'flex-1 font-medium text-foreground',
    )
    expect(remapAccountSheetTextClass(undefined)).toBeUndefined()
  })
})

describe('scaleAccountSheetIcon', () => {
  test('scales the desktop Settings icon sizes used in Account sheets', () => {
    expect(scaleAccountSheetIcon(14)).toBe(19)
    expect(scaleAccountSheetIcon(16)).toBe(22)
    expect(scaleAccountSheetIcon(20)).toBe(27)
    expect(scaleAccountSheetIcon(24)).toBe(32)
  })
})
