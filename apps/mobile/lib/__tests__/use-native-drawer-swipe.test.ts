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
  nativeDrawerUnderlayStyle,
  nativeDrawerSheetCanvas,
  NATIVE_DRAWER_SHEET_RADIUS,
  NATIVE_DRAWER_SHEET_SHADOW_OPACITY,
  NATIVE_DRAWER_SHEET_ELEVATION,
  NATIVE_DRAWER_SHEET_OPEN_CANVAS,
  NATIVE_DRAWER_WIDTH_RATIO,
  NATIVE_DRAWER_MIN_TOP_INSET,
  NATIVE_DRAWER_MIN_SIDE_INSET,
  NATIVE_DRAWER_MIN_FOOTER_INSET,
} from '../use-native-drawer-swipe'
import { NATIVE_PHONE_CANVAS, NATIVE_PHONE_HOME_CANVAS } from '../native-phone-layout'

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

  test('sheet translation, corner radius, and canvas share the same progress', () => {
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
    expect(nativeDrawerSheetCanvas(0, true)).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativeDrawerSheetCanvas(1, true)).toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    expect(nativeDrawerSheetCanvas(0.5, true)).not.toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativeDrawerSheetCanvas(0.5, true)).not.toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
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

describe('nativeDrawerSheetCanvas', () => {
  test('dark sheet lifts from OLED black to medium grey with drawer progress', () => {
    expect(nativeDrawerSheetCanvas(0, true)).toBe('#000000')
    expect(nativeDrawerSheetCanvas(1, true)).toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    const mid = nativeDrawerSheetCanvas(0.5, true)
    expect(mid.startsWith('#')).toBe(true)
    expect(mid).not.toBe('#000000')
    expect(mid).not.toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    expect(nativeDrawerSheetCanvas(0.25, true) < nativeDrawerSheetCanvas(0.75, true)).toBe(true)
  })

  test('dark home lifts from charcoal to the same open grey', () => {
    expect(nativeDrawerSheetCanvas(0, true, NATIVE_PHONE_HOME_CANVAS)).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(nativeDrawerSheetCanvas(1, true, NATIVE_PHONE_HOME_CANVAS)).toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    const mid = nativeDrawerSheetCanvas(0.5, true, NATIVE_PHONE_HOME_CANVAS)
    expect(mid).not.toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(mid).not.toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    expect(nativeDrawerSheetCanvas(0, true)).toBe('#000000')
  })

  test('light sheet stays white', () => {
    expect(nativeDrawerSheetCanvas(0, false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(nativeDrawerSheetCanvas(1, false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(nativeDrawerSheetCanvas(0.4, false)).toBe(NATIVE_PHONE_CANVAS.light)
  })
})

describe('nativeDrawerUnderlayStyle', () => {
  test('fills the sidebar lane with the theme canvas', () => {
    expect(nativeDrawerUnderlayStyle(300, true).backgroundColor).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativeDrawerUnderlayStyle(300, false).backgroundColor).toBe(NATIVE_PHONE_CANVAS.light)
    expect(nativeDrawerUnderlayStyle(300, false)).toMatchObject({
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 300,
      zIndex: 0,
    })
  })
})
