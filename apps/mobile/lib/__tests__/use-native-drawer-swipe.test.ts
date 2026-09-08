// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  nativeDrawerPanelWidth,
  nativeDrawerProgressFromDelta,
  nativeDrawerShouldSettleOpen,
  nativeDrawerTopInset,
  nativeDrawerSideInset,
  nativeDrawerFooterInset,
  NATIVE_DRAWER_SHEET_RADIUS,
  NATIVE_DRAWER_SHEET_SHADOW_OPACITY,
  NATIVE_DRAWER_SHEET_ELEVATION,
  NATIVE_DRAWER_WIDTH_RATIO,
  NATIVE_DRAWER_MIN_TOP_INSET,
  NATIVE_DRAWER_MIN_SIDE_INSET,
  NATIVE_DRAWER_MIN_FOOTER_INSET,
} from '../use-native-drawer-swipe'

describe('native drawer progress', () => {
  const width = 280

  test('finger dx maps 1:1 onto foreground sheet travel', () => {
    expect(nativeDrawerProgressFromDelta(0, 0, width)).toBe(0)
    expect(nativeDrawerProgressFromDelta(0, 28, width)).toBe(0.1)
    expect(nativeDrawerProgressFromDelta(0, 70, width)).toBe(0.25)
    expect(nativeDrawerProgressFromDelta(0, 140, width)).toBe(0.5)
    expect(nativeDrawerProgressFromDelta(0, 210, width)).toBe(0.75)
    expect(nativeDrawerProgressFromDelta(0, 280, width)).toBe(1)
    expect(nativeDrawerProgressFromDelta(1, -140, width)).toBe(0.5)
    expect(nativeDrawerProgressFromDelta(1, -280, width)).toBe(0)
  })

  test('sidebar is ~75% of the viewport and the sheet travels that full width', () => {
    const drawerWidth = nativeDrawerPanelWidth(402)
    expect(drawerWidth).toBe(Math.round(402 * NATIVE_DRAWER_WIDTH_RATIO))
    expect(drawerWidth / 402).toBeCloseTo(0.75, 2)
    expect(NATIVE_DRAWER_SHEET_RADIUS).toBeGreaterThanOrEqual(48)
    expect(NATIVE_DRAWER_SHEET_RADIUS).toBeLessThanOrEqual(60)
  })

  test('sheet translation and corner radius share the same progress', () => {
    const drawerWidth = nativeDrawerPanelWidth(402)
    const at = (progress: number) => ({
      sheetX: progress * drawerWidth,
      radius: progress * NATIVE_DRAWER_SHEET_RADIUS,
    })
    expect(at(0)).toEqual({ sheetX: 0, radius: 0 })
    expect(at(1)).toEqual({
      sheetX: drawerWidth,
      radius: NATIVE_DRAWER_SHEET_RADIUS,
    })
    expect(at(0.25).sheetX).toBeCloseTo(0.25 * drawerWidth)
    expect(at(0.25).radius).toBeCloseTo(0.25 * NATIVE_DRAWER_SHEET_RADIUS)
  })

  test('release snaps using distance or velocity', () => {
    expect(nativeDrawerShouldSettleOpen(0.2, 0)).toBe(false)
    expect(nativeDrawerShouldSettleOpen(0.4, 0)).toBe(true)
    expect(nativeDrawerShouldSettleOpen(0.1, 0.8)).toBe(true)
    expect(nativeDrawerShouldSettleOpen(0.9, -0.8)).toBe(false)
  })

  test('close drag uses the same travel threshold as open, from the open end', () => {
    expect(nativeDrawerShouldSettleOpen(0.4, 0, 1)).toBe(false)
    expect(nativeDrawerShouldSettleOpen(0.8, 0, 1)).toBe(true)
    expect(nativeDrawerShouldSettleOpen(0.9, -0.8, 1)).toBe(false)
  })
})

describe('native drawer insets', () => {
  test('use shared minimums so app and admin drawers stay aligned', () => {
    expect(NATIVE_DRAWER_SHEET_SHADOW_OPACITY).toBe(0.12)
    expect(NATIVE_DRAWER_SHEET_ELEVATION).toBe(4)
    expect(nativeDrawerTopInset(20)).toBe(NATIVE_DRAWER_MIN_TOP_INSET)
    expect(nativeDrawerTopInset(80)).toBe(80)
    expect(nativeDrawerSideInset(0)).toBe(NATIVE_DRAWER_MIN_SIDE_INSET)
    expect(nativeDrawerFooterInset(8)).toBe(NATIVE_DRAWER_MIN_FOOTER_INSET)
    expect(nativeDrawerFooterInset(34)).toBe(34)
  })
})
