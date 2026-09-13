// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  nativeDrawerPanelWidth,
  nativeDrawerProgressFromDelta,
  nativeDrawerShouldCaptureSwipe,
  nativeDrawerShouldSettleOpen,
  nativeDrawerTopInset,
  nativeDrawerSideInset,
  nativeDrawerFooterInset,
  nativeDrawerUnderlayStyle,
  nativeDrawerSheetCanvas,
  nativeDrawerSheetEnds,
  nativeDrawerOuterSheetStyle,
  nativeDrawerClipSheetStyle,
  nativeDrawerShouldDismissKeyboard,
  NATIVE_DRAWER_SHEET_RADIUS,
  NATIVE_DRAWER_SHEET_SHADOW_OPACITY,
  NATIVE_DRAWER_SHEET_ELEVATION,
  NATIVE_DRAWER_SHEET_OPEN_CANVAS,
  NATIVE_DRAWER_COMPOSITING_EPSILON,
  NATIVE_DRAWER_WIDTH_RATIO,
  NATIVE_DRAWER_MIN_TOP_INSET,
  NATIVE_DRAWER_MIN_SIDE_INSET,
  NATIVE_DRAWER_MIN_FOOTER_INSET,
} from '../use-native-drawer-swipe'
import { NATIVE_PHONE_CANVAS, NATIVE_PHONE_HOME_CANVAS } from '../native-phone-layout'

describe('nativeDrawerShouldCaptureSwipe', () => {
  test('opens from a right-swipe anywhere on the closed sheet', () => {
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: false, dx: 8, dy: 1 })).toBe(true)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: false, dx: 24, dy: 4 })).toBe(true)
  })

  test('ignores vertical-dominant or leftward moves while closed', () => {
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: false, dx: 4, dy: 12 })).toBe(false)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: false, dx: 5, dy: 0 })).toBe(false)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: false, dx: -12, dy: 0 })).toBe(false)
  })

  test('closes from a left-swipe while open', () => {
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: true, dx: -10, dy: 1 })).toBe(true)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: true, dx: 12, dy: 0 })).toBe(false)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: true, isOpen: true, dx: -4, dy: 0 })).toBe(false)
  })

  test('never captures when swipe is disabled', () => {
    expect(nativeDrawerShouldCaptureSwipe({ enabled: false, isOpen: false, dx: 20, dy: 0 })).toBe(false)
    expect(nativeDrawerShouldCaptureSwipe({ enabled: false, isOpen: true, dx: -20, dy: 0 })).toBe(false)
  })
})

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
    expect(nativeDrawerSheetCanvas(0, true)).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativeDrawerSheetCanvas(0.5, true)).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativeDrawerSheetCanvas(1, true)).toBe(NATIVE_PHONE_CANVAS.dark)
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
    expect(NATIVE_DRAWER_COMPOSITING_EPSILON).toBeGreaterThan(0)
    expect(NATIVE_DRAWER_COMPOSITING_EPSILON).toBeLessThan(0.01)
    expect(nativeDrawerTopInset(20)).toBe(NATIVE_DRAWER_MIN_TOP_INSET)
    expect(nativeDrawerTopInset(80)).toBe(80)
    expect(nativeDrawerSideInset(0)).toBe(NATIVE_DRAWER_MIN_SIDE_INSET)
    expect(nativeDrawerFooterInset(8)).toBe(NATIVE_DRAWER_MIN_FOOTER_INSET)
    expect(nativeDrawerFooterInset(34)).toBe(34)
  })
})

describe('nativeDrawerSheetCanvas', () => {
  test('dark sheet stays on the closed canvas for the whole swipe', () => {
    expect(nativeDrawerSheetCanvas(0, true)).toBe('#000000')
    expect(nativeDrawerSheetCanvas(0.5, true)).toBe('#000000')
    expect(nativeDrawerSheetCanvas(1, true)).toBe('#000000')
  })

  test('dark home stays OLED black instead of lifting to grey', () => {
    expect(nativeDrawerSheetCanvas(0, true, NATIVE_PHONE_HOME_CANVAS)).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(nativeDrawerSheetCanvas(0.5, true, NATIVE_PHONE_HOME_CANVAS)).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(nativeDrawerSheetCanvas(1, true, NATIVE_PHONE_HOME_CANVAS)).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(nativeDrawerSheetCanvas(0, true)).toBe('#000000')
  })

  test('an explicit open canvas still lerps with drawer progress', () => {
    expect(nativeDrawerSheetCanvas(0, true, undefined, NATIVE_DRAWER_SHEET_OPEN_CANVAS)).toBe('#000000')
    expect(nativeDrawerSheetCanvas(1, true, undefined, NATIVE_DRAWER_SHEET_OPEN_CANVAS)).toBe(
      NATIVE_DRAWER_SHEET_OPEN_CANVAS,
    )
    const mid = nativeDrawerSheetCanvas(0.5, true, undefined, NATIVE_DRAWER_SHEET_OPEN_CANVAS)
    expect(mid).not.toBe('#000000')
    expect(mid).not.toBe(NATIVE_DRAWER_SHEET_OPEN_CANVAS)
  })

  test('settings and other pages stay on the closed canvas when the drawer opens', () => {
    expect(nativeDrawerSheetCanvas(0, true, undefined, '#000000')).toBe('#000000')
    expect(nativeDrawerSheetCanvas(0.5, true, undefined, '#000000')).toBe('#000000')
    expect(nativeDrawerSheetCanvas(1, true, undefined, '#000000')).toBe('#000000')
  })

  test('light sheet stays white', () => {
    expect(nativeDrawerSheetCanvas(0, false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(nativeDrawerSheetCanvas(1, false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(nativeDrawerSheetCanvas(0.4, false)).toBe(NATIVE_PHONE_CANVAS.light)
  })
})

describe('nativeDrawerShouldDismissKeyboard', () => {
  test('dismisses when the native sidebar starts opening', () => {
    expect(nativeDrawerShouldDismissKeyboard(true, true)).toBe(true)
    expect(nativeDrawerShouldDismissKeyboard(false, true)).toBe(false)
    expect(nativeDrawerShouldDismissKeyboard(true, false)).toBe(false)
  })
})

describe('native drawer sheet layers', () => {
  test('outer motion has no clip radius or fill', () => {
    const style = nativeDrawerOuterSheetStyle(24, 0.12, 4)
    expect(style.transform).toEqual([{ translateX: 24 }])
    expect(style.shadowOpacity).toBe(0.12)
    expect(style.elevation).toBe(4)
    expect(style).not.toHaveProperty('borderTopLeftRadius')
    expect(style).not.toHaveProperty('overflow')
    expect(style).not.toHaveProperty('backgroundColor')
  })

  test('inner clip has fill and radius, not transform', () => {
    const style = nativeDrawerClipSheetStyle(52, NATIVE_PHONE_HOME_CANVAS)
    expect(style.overflow).toBe('hidden')
    expect(style.backgroundColor).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(style.borderTopLeftRadius).toBe(52)
    expect(style.borderBottomLeftRadius).toBe(52)
    expect(style).not.toHaveProperty('transform')
  })

  test('home black stays a single static canvas', () => {
    expect(nativeDrawerSheetEnds(true, NATIVE_PHONE_HOME_CANVAS)).toEqual({
      closed: NATIVE_PHONE_HOME_CANVAS,
      open: NATIVE_PHONE_HOME_CANVAS,
    })
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
