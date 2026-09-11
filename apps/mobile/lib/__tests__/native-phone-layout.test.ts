// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { nativeContentWidth, nativePhoneCanvas, nativePhoneDockBlockingBodyMaxHeight, nativePhoneDockStatusMaxHeight, nativePhoneDockFadeColors, nativePhoneDockGlassStyle, nativePhoneFillStyle, nativePhoneIconColor, nativePhoneSheetPanelStyle, nativePhoneSheetBackdropStyle, nativeSettingsPaneFill, nativeSettingsPaneRootStyle, nativeSettingsPaneStyle, nativeSkillsActionWidths, nativeEqualChipWidths, nativeGridChipWidth, nativeTwoColumnCardWidth, hexToRgbChannels, phoneChromeEnabled, NATIVE_PHONE_CANVAS, NATIVE_PHONE_DOCK_COMPOSER_GAP, NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT, NATIVE_PHONE_DOCK_BLOCKING_MIN_HEIGHT, NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT, NATIVE_PHONE_DOCK_STATUS_MIN_HEIGHT, NATIVE_PHONE_DOCK_FADE, NATIVE_PHONE_DOCK_GLASS, NATIVE_PHONE_HEADER_ICON_SIZE, NATIVE_PHONE_HOME_CANVAS, NATIVE_PHONE_ICON, NATIVE_PHONE_ICON_STROKE, NATIVE_PHONE_SHEET_CANVAS, NATIVE_PHONE_GUTTER, NATIVE_WIND_SPACE_4, isPhoneLayout, WEB_PHONE_MAX_WIDTH, WEB_WIDE_MIN_WIDTH } from '../native-phone-layout'

describe('isPhoneLayout', () => {
  test('treats a narrow web viewport as phone chrome', () => {
    expect(isPhoneLayout(390, 844)).toBe(true)
    expect(isPhoneLayout(WEB_PHONE_MAX_WIDTH, 800)).toBe(true)
    expect(isPhoneLayout(WEB_WIDE_MIN_WIDTH, 800)).toBe(false)
  })
})

describe('nativeContentWidth', () => {
  test('subtracts the default section inset', () => {
    expect(nativeContentWidth(402)).toBe(370)
  })

  test('subtracts an explicit padding', () => {
    expect(nativeContentWidth(402, 24)).toBe(378)
  })

  test('does not go negative', () => {
    expect(nativeContentWidth(10, 32)).toBe(0)
  })
})

describe('nativeSkillsActionWidths', () => {
  test('library + gap + refresh fill the picker content width', () => {
    const { row, library, refresh } = nativeSkillsActionWidths(402)
    expect(row).toBe(378)
    expect(refresh).toBe(44)
    expect(library + 8 + refresh).toBe(row)
  })
})

describe('nativeEqualChipWidths', () => {
  test('splits the picker row into equal chips with gaps', () => {
    const { row, chip, lastChip } = nativeEqualChipWidths(402, 4, 8)
    expect(row).toBe(378)
    expect(chip * 3 + lastChip + 8 * 3).toBe(row)
  })
})

describe('nativeSettingsPaneFill', () => {
  test('allows nested ScrollViews to shrink instead of growing with content', () => {
    expect(nativeSettingsPaneFill).toEqual({
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    })
  })
})

describe('nativeSettingsPaneStyle', () => {
  test('pins a pixel width so Yoga cannot shrink-wrap the pane', () => {
    expect(nativeSettingsPaneStyle(402)).toEqual({
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      width: 402,
      maxWidth: 402,
      alignSelf: 'stretch',
    })
  })
})

describe('nativeTwoColumnCardWidth', () => {
  test('splits the padded pane into two equal cards with a gap', () => {
    expect(nativeTwoColumnCardWidth(402)).toBe(179)
  })
})

describe('nativeGridChipWidth', () => {
  test('splits a row into equal columns', () => {
    expect(nativeGridChipWidth(320, 2, 0)).toBe(160)
    expect(nativeGridChipWidth(320, 4, 0)).toBe(80)
  })
})

describe('nativePhoneFillStyle', () => {
  test('uses a pixel width instead of a percentage', () => {
    expect(nativePhoneFillStyle(402)).toEqual({
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: 402,
      maxWidth: 402,
    })
  })
})

describe('nativeSettingsPaneRootStyle', () => {
  test('pins a pixel width on phone and leaves overlay panes unstyled', () => {
    expect(nativeSettingsPaneRootStyle(402, true)).toEqual(nativeSettingsPaneStyle(402))
    expect(nativeSettingsPaneRootStyle(402, false)).toBeUndefined()
  })
})

describe('native gutter tokens', () => {
  test('NativeWind p-4 matches the phone gutter', () => {
    expect(NATIVE_WIND_SPACE_4).toBe(NATIVE_PHONE_GUTTER)
  })
})

describe('nativePhoneCanvas', () => {
  test('matches the ChatGPT light and dark canvases', () => {
    expect(nativePhoneCanvas(true)).toBe(NATIVE_PHONE_CANVAS.dark)
    expect(nativePhoneCanvas(false)).toBe(NATIVE_PHONE_CANVAS.light)
    expect(NATIVE_PHONE_CANVAS).toEqual({ dark: '#000000', light: '#ffffff' })
  })

  test('dark home uses OLED black', () => {
    expect(NATIVE_PHONE_HOME_CANVAS).toBe('#000000')
    expect(NATIVE_PHONE_HOME_CANVAS).toBe(NATIVE_PHONE_CANVAS.dark)
  })
})

describe('nativePhoneIconColor', () => {
  test('matches ChatGPT iOS icon ink in both themes', () => {
    expect(nativePhoneIconColor(true)).toBe(NATIVE_PHONE_ICON.dark)
    expect(nativePhoneIconColor(false)).toBe(NATIVE_PHONE_ICON.light)
    expect(NATIVE_PHONE_ICON).toEqual({ dark: '#F4F4F4', light: '#0D0D0D' })
    expect(NATIVE_PHONE_ICON_STROKE).toBe(1.75)
    expect(NATIVE_PHONE_HEADER_ICON_SIZE).toBe(28)
  })
})

describe('hexToRgbChannels', () => {
  test('parses six-digit hex once for dock fades and the drawer lerp', () => {
    expect(hexToRgbChannels('#000000')).toEqual([0, 0, 0])
    expect(hexToRgbChannels('#0C0C0C')).toEqual([12, 12, 12])
    expect(hexToRgbChannels('#3A3A3C')).toEqual([58, 58, 60])
  })
})

describe('phoneChromeEnabled', () => {
  test('stays off on wide web so desktop studio keeps className theme colors', () => {
    expect(phoneChromeEnabled(390, 844)).toBe(true)
    expect(phoneChromeEnabled(WEB_PHONE_MAX_WIDTH, 800)).toBe(true)
    expect(phoneChromeEnabled(1280, 800)).toBe(false)
  })
})

describe('nativePhoneDockFadeColors', () => {
  test('fades list rows out as they enter the dock, then the pills stay readable', () => {
    expect(NATIVE_PHONE_DOCK_FADE).toBe(80)
    expect(nativePhoneDockFadeColors(true)[0]).toBe('rgba(0,0,0,0)')
    expect(nativePhoneDockFadeColors(true)[2]).toBe('rgba(0,0,0,0.94)')
    expect(nativePhoneDockFadeColors(false)[0]).toBe('rgba(255,255,255,0)')
    expect(nativePhoneDockFadeColors(false)[2]).toBe('rgba(255,255,255,0.94)')
    expect(nativePhoneDockFadeColors(true, NATIVE_PHONE_HOME_CANVAS)[0]).toBe('rgba(0,0,0,0)')
    expect(NATIVE_PHONE_DOCK_COMPOSER_GAP).toBe(12)
  })
})

describe('nativePhoneDockBlockingBodyMaxHeight', () => {
  test('caps the option list so header and submit stay on screen', () => {
    expect(nativePhoneDockBlockingBodyMaxHeight()).toBe(NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT)
    expect(nativePhoneDockBlockingBodyMaxHeight(1000)).toBe(NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT)
    expect(nativePhoneDockBlockingBodyMaxHeight(500)).toBe(190)
    expect(nativePhoneDockBlockingBodyMaxHeight(200)).toBe(NATIVE_PHONE_DOCK_BLOCKING_MIN_HEIGHT)
  })
})

describe('nativePhoneDockStatusMaxHeight', () => {
  test('keeps an expanded plan from consuming the composer column', () => {
    expect(nativePhoneDockStatusMaxHeight()).toBe(NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT)
    expect(nativePhoneDockStatusMaxHeight(1000)).toBe(NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT)
    expect(nativePhoneDockStatusMaxHeight(500)).toBe(160)
    expect(nativePhoneDockStatusMaxHeight(200)).toBe(NATIVE_PHONE_DOCK_STATUS_MIN_HEIGHT)
  })
})

describe('nativePhoneDockGlassStyle', () => {
  test('uses a translucent charcoal fill and hairline, not opaque muted gray', () => {
    expect(NATIVE_PHONE_DOCK_GLASS.dark.fill.startsWith('rgba(')).toBe(true)
    expect(nativePhoneDockGlassStyle(true).backgroundColor).toBe(NATIVE_PHONE_DOCK_GLASS.dark.fill)
    expect(nativePhoneDockGlassStyle(true).borderColor).toBe(NATIVE_PHONE_DOCK_GLASS.dark.border)
    expect(nativePhoneDockGlassStyle(false).backgroundColor).toBe(NATIVE_PHONE_DOCK_GLASS.light.fill)
  })
})

describe('nativePhoneSheetPanelStyle', () => {
  test('dark sheets use Apple elevated gray without a background dimmer', () => {
    expect(NATIVE_PHONE_SHEET_CANVAS.dark).toBe('#1C1C1E')
    expect(nativePhoneSheetPanelStyle(true)).toEqual({
      backgroundColor: '#1C1C1E',
      borderColor: 'rgba(255,255,255,0.10)',
    })
    expect(nativePhoneSheetPanelStyle(false)).toBeUndefined()
    expect(nativePhoneSheetBackdropStyle(true).backgroundColor).toBe('transparent')
  })
})
