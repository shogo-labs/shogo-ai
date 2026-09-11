// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Handset vs tablet detection for phone chrome and native Yoga workarounds.
 *
 * - Native iOS: iPad via `Platform.isPad`.
 * - Native Android: smallest window edge vs sw600dp-style threshold.
 * - Web: phone chrome at `WEB_PHONE_MAX_WIDTH` (iPhone Safari / Expo web).
 *   Desktop studio and Electron stay on the existing wide layout.
 * Yoga pixel-width helpers stay native-only (`isNativePhoneIntegrationsLayout`).
 */
import { Platform, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native'
import { useResolvedTheme } from '../contexts/theme'

/** Matches Android `sw600dp` smallest-width bucket for “tablet” layouts. */
const ANDROID_TABLET_MIN_SHORTEST_EDGE = 600

function isIOSPadDevice(): boolean {
  if (Platform.OS !== 'ios') return false
  return (Platform as { isPad?: boolean }).isPad === true
}

function isAndroidHandsetByWindowSize(width: number, height: number): boolean {
  return Math.min(width, height) < ANDROID_TABLET_MIN_SHORTEST_EDGE
}

/** True on iOS/Android. */
export function isNativePlatform(): boolean {
  return Platform.OS !== 'web'
}

/** Matches app `isWide` (`width >= 768`). Phone chrome applies at or below this. */
export const WEB_PHONE_MAX_WIDTH = 767

/**
 * Phone chrome: native handset, or a narrow web viewport.
 * Does not enable Yoga pixel-width workarounds on web.
 */
export const WEB_WIDE_MIN_WIDTH = WEB_PHONE_MAX_WIDTH + 1;
/** Admin shell intentionally uses a wider desktop breakpoint than the app shell. */
export const ADMIN_WEB_WIDE_MIN_WIDTH = 900;

/**
 * Phone chrome: native handset, or a narrow web viewport.
 * Does not enable Yoga pixel-width workarounds on web.
 */
export function isPhoneLayout(width: number, height: number): boolean {
  if (isNativePlatform()) return isNativePhoneIntegrationsLayout(width, height)
  return width <= WEB_PHONE_MAX_WIDTH
}

/** Horizontal padding for native-phone Settings chrome (`px-4`). */
export const NATIVE_PHONE_GUTTER = 16
/** NativeWind `p-4` / `px-4` (chart cards, section padding). */
export const NATIVE_WIND_SPACE_4 = NATIVE_PHONE_GUTTER
/** NativeWind `p-0.5`. */
export const NATIVE_WIND_SPACE_0_5 = 2
/** Left+right gutter. */
export const NATIVE_PHONE_SECTION_INSET = NATIVE_PHONE_GUTTER * 2
/** Section picker inset (`paddingHorizontal: 12` on each side). */
export const NATIVE_PHONE_PICKER_INSET = 24
/** One side of `NATIVE_PHONE_PICKER_INSET`. */
export const NATIVE_PHONE_PICKER_GUTTER = NATIVE_PHONE_PICKER_INSET / 2
/** Hairline used on native Settings / Skills / Agents chrome. */
export const NATIVE_PHONE_HAIRLINE_COLOR = 'rgba(127,127,127,0.35)'
/** Tap target for native phone icon buttons (Library refresh, period refresh). */
export const NATIVE_PHONE_CONTROL_SIZE = 44
/** Extra scroll padding below native Account groups (`insets.bottom + 24`). */
export const NATIVE_ACCOUNT_SCROLL_EXTRA_PAD = 24
/** Native Account screen title. Not PHONE_DENSITY.title (`text-xl`). */
export const NATIVE_ACCOUNT_TITLE_CLASS = 'text-[17px]'
/** Row gap between native phone chrome controls (`gap-2`). */
export const NATIVE_PHONE_ROW_GAP = 8
/** Wrap-row gap between two-column stat cards (`gap-3`). */
export const NATIVE_PHONE_CARD_GAP = 12
/**
 * Native ChatGPT canvas (`nativeChatGptSurfaces` in the Gluestack provider).
 * Use for style props where NativeWind `bg-background` is not applied.
 */
export const NATIVE_PHONE_CANVAS = { dark: '#000000', light: '#ffffff' } as const
/**
 * Dark home sheet fill. Same OLED black as the rest of native chrome; kept as
 * its own token so the home drawer can stay on a static canvas without
 * duplicating the hex.
 */
export const NATIVE_PHONE_HOME_CANVAS = NATIVE_PHONE_CANVAS.dark

/**
 * ChatGPT iOS icon ink, sampled from App Store screenshots.
 * Dark: ~#F4F4F4 (header/composer glyphs). Light: ~#0D0D0D (plus/menu).
 * Lucide default stroke 2 reads heavier than ChatGPT's SF-Symbol weight.
 */
export const NATIVE_PHONE_ICON = { dark: '#F4F4F4', light: '#0D0D0D' } as const
export const NATIVE_PHONE_ICON_STROKE = 1.75
/** Header menu / bell on native phone and narrow web (`AppHeader`). */
export const NATIVE_PHONE_HEADER_ICON_SIZE = 28

export function nativePhoneIconColor(isDark: boolean): string {
  return isDark ? NATIVE_PHONE_ICON.dark : NATIVE_PHONE_ICON.light
}

/**
 * Phone icon/sheet chrome: native (iPhone, iPad, Android) or a narrow web
 * viewport. Desktop studio, Electron, and wide web keep className theme colors.
 */
export function phoneChromeEnabled(width: number, height: number): boolean {
  return isNativePlatform() || isPhoneLayout(width, height)
}

export function useNativePhoneIconChrome(): { color: string; strokeWidth: number } {
  const isDark = useResolvedTheme() === 'dark'
  return {
    color: nativePhoneIconColor(isDark),
    strokeWidth: NATIVE_PHONE_ICON_STROKE,
  }
}

/**
 * Dark bottom sheets on OLED black. Apple's elevated
 * `secondarySystemBackground` / systemGray6 (`#1C1C1E`) — one step above
 * `#000`, cooler than `bg-card` (`#212121`), so the sheet sits in the same
 * black family instead of a muddy mid-grey. Light sheets keep `bg-card`.
 */
export const NATIVE_PHONE_SHEET_CANVAS = { dark: '#1C1C1E', light: '#ffffff' } as const
export const NATIVE_PHONE_SHEET_BORDER = {
  dark: 'rgba(255,255,255,0.10)',
  light: 'rgba(0,0,0,0.08)',
} as const
export const NATIVE_PHONE_SHEET_BACKDROP = {
  /** Bottom sheets stay non-blocking visually; the press target remains dismissible. */
  dark: 'transparent',
  light: 'transparent',
} as const

export const NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO = 0.78;
export const NATIVE_PHONE_SHEET_COMPACT_RATIO = 0.72;
export const NATIVE_PHONE_SHEET_BODY_RATIO = 0.62;
/** Tall sheet so Account can host a settings tab without a push. */
export const NATIVE_PHONE_ACCOUNT_SETTINGS_SHEET_RATIO = 0.92;
export const NATIVE_PHONE_ACCOUNT_SETTINGS_BODY_RATIO = 0.78;
export const NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO = 0.56;
export const NATIVE_PHONE_SHEET_FADE_MS = 320;
export const NATIVE_PHONE_SYSTEM_GRAY = {
  16: "rgba(120,120,128,0.16)",
  24: "rgba(120,120,128,0.24)",
  32: "rgba(120,120,128,0.32)",
} as const;

export function nativePhoneCanvas(isDark: boolean): string {
  return isDark ? NATIVE_PHONE_CANVAS.dark : NATIVE_PHONE_CANVAS.light
}

export function nativePhoneSheetPanelStyle(isDark: boolean): ViewStyle | undefined {
  if (!isDark) return undefined
  return {
    backgroundColor: NATIVE_PHONE_SHEET_CANVAS.dark,
    borderColor: NATIVE_PHONE_SHEET_BORDER.dark,
  }
}

export function nativePhoneSheetBackdropStyle(isDark: boolean): ViewStyle {
  return { backgroundColor: isDark ? NATIVE_PHONE_SHEET_BACKDROP.dark : NATIVE_PHONE_SHEET_BACKDROP.light }
}

/**
 * ChatGPT search dock: a dissolve zone above the pills, then near-opaque
 * charcoal at the bar so list rows “come up” and fade out instead of
 * printing through the Search field.
 */
export const NATIVE_PHONE_DOCK_FADE = 80
export const NATIVE_PHONE_DOCK_FADE_LOCATIONS = [0, 0.42, 1] as const
/** Gap between ChatDock banners (errors, plans, approvals) and the composer pill. */
export const NATIVE_PHONE_DOCK_COMPOSER_GAP = 12
/**
 * Native blocking question/permission cards stay in the composer column, so
 * they must leave room for messages above and the pill below. Cap the
 * scrollable option body rather than the whole card — header and submit
 * stay pinned.
 */
export const NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT = 280
export const NATIVE_PHONE_DOCK_BLOCKING_MAX_RATIO = 0.38
export const NATIVE_PHONE_DOCK_BLOCKING_MIN_HEIGHT = 140

export function nativePhoneDockBlockingBodyMaxHeight(
  availableHeight?: number,
): number {
  const fromViewport = availableHeight
    ? Math.round(availableHeight * NATIVE_PHONE_DOCK_BLOCKING_MAX_RATIO)
    : NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT
  return Math.max(
    NATIVE_PHONE_DOCK_BLOCKING_MIN_HEIGHT,
    Math.min(NATIVE_PHONE_DOCK_BLOCKING_MAX_HEIGHT, fromViewport),
  )
}

/**
 * Cap the status zone (Plan, errors, files) so an expanded plan cannot
 * consume the composer column. Uses window height, not the messages sibling,
 * to avoid a layout loop.
 */
export const NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT = 280
export const NATIVE_PHONE_DOCK_STATUS_MAX_RATIO = 0.32
export const NATIVE_PHONE_DOCK_STATUS_MIN_HEIGHT = 120

export function nativePhoneDockStatusMaxHeight(windowHeight?: number): number {
  const fromViewport = windowHeight
    ? Math.round(windowHeight * NATIVE_PHONE_DOCK_STATUS_MAX_RATIO)
    : NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT
  return Math.max(
    NATIVE_PHONE_DOCK_STATUS_MIN_HEIGHT,
    Math.min(NATIVE_PHONE_DOCK_STATUS_MAX_HEIGHT, fromViewport),
  )
}

export const NATIVE_PHONE_DOCK_GLASS = {
  dark: {
    fill: 'rgba(44,44,46,0.94)',
    border: 'rgba(255,255,255,0.14)',
  },
  light: {
    fill: 'rgba(255,255,255,0.94)',
    border: 'rgba(0,0,0,0.08)',
  },
} as const

export function nativePhoneDockGlassStyle(isDark: boolean): ViewStyle {
  const glass = isDark ? NATIVE_PHONE_DOCK_GLASS.dark : NATIVE_PHONE_DOCK_GLASS.light
  return {
    backgroundColor: glass.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glass.border,
  }
}

/** `#RRGGBB` → 0–255 channels. Shared by dock fades and the drawer canvas lerp. */
export function hexToRgbChannels(hex: string): [number, number, number] {
  const n = hex.replace('#', '')
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
  ]
}

export function nativePhoneDockFadeColors(
  isDark: boolean,
  canvasHex?: string,
): readonly [string, string, string] {
  const [r, g, b] = hexToRgbChannels(canvasHex ?? nativePhoneCanvas(isDark))
  return [`rgba(${r},${g},${b},0)`, `rgba(${r},${g},${b},0.42)`, `rgba(${r},${g},${b},0.94)`]
}

/** Dark-only chrome for sheets that rise from the bottom of the screen. */
export function useNativePhoneSheetChrome(): {
  panel: ViewStyle | undefined
  backdrop: ViewStyle
} {
  const isDark = useResolvedTheme() === 'dark'
  const { width, height } = useWindowDimensions()
  if (!phoneChromeEnabled(width, height)) {
    return {
      panel: undefined,
      backdrop: { backgroundColor: NATIVE_PHONE_SHEET_BACKDROP.light },
    }
  }
  return {
    panel: nativePhoneSheetPanelStyle(isDark),
    backdrop: nativePhoneSheetBackdropStyle(isDark),
  }
}

/**
 * True only on iPhone / Android phones — not web, not iPad, not Android tablets.
 * Pure function: reuse window size from an existing `useWindowDimensions()` call
 * to avoid subscribing twice in the same component.
 */
export function isNativePhoneIntegrationsLayout(
  width: number,
  height: number,
): boolean {
  if (!isNativePlatform()) return false
  if (Platform.OS === 'ios') return !isIOSPadDevice()
  if (Platform.OS === 'android') return isAndroidHandsetByWindowSize(width, height)
  return false
}

/**
 * Absolute fill that uses a pixel width. Percentage `width: '100%'` collapses
 * in this tree when a parent has no definite width (Yoga treats it as 0).
 */
export function nativePhoneFillStyle(width: number): {
  position: 'absolute'
  top: 0
  left: 0
  bottom: 0
  width: number
  maxWidth: number
} {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width,
    maxWidth: width,
  }
}

/** Inner content width for a full-bleed native phone pane. */
export function nativeContentWidth(
  windowWidth: number,
  horizontalPadding = NATIVE_PHONE_SECTION_INSET,
): number {
  return Math.max(0, windowWidth - horizontalPadding)
}

/**
 * Library + refresh row that matches the Settings section picker
 * (`windowWidth - NATIVE_PHONE_PICKER_INSET`). Yoga will not honor `flex: 1`
 * on the Library button unless the row itself has this pixel width.
 */
export function nativeSkillsActionWidths(
  paneWidth: number,
  refreshSize = NATIVE_PHONE_CONTROL_SIZE,
  gap = NATIVE_PHONE_ROW_GAP,
): { row: number; library: number; refresh: number } {
  const row = nativeContentWidth(paneWidth, NATIVE_PHONE_PICKER_INSET)
  return {
    row,
    library: Math.max(0, row - refreshSize - gap),
    refresh: refreshSize,
  }
}

/**
 * Equal-width chips for a native phone tab row (e.g. Agents Activity/Tasks/…).
 * `flex: 1` + `min-w-0` + `numberOfLines={1}` ellipsizes labels when the
 * parent has no definite width (Yoga treats `%` / flex as 0).
 */
export function nativeEqualChipWidths(
  paneWidth: number,
  count: number,
  gap = NATIVE_PHONE_ROW_GAP,
  inset = NATIVE_PHONE_PICKER_INSET,
): { row: number; chip: number; lastChip: number } {
  const row = nativeContentWidth(paneWidth, inset)
  if (count <= 0) return { row, chip: 0, lastChip: 0 }
  const inner = Math.max(0, row - gap * (count - 1))
  const chip = Math.floor(inner / count)
  return {
    row,
    chip,
    lastChip: inner - chip * (count - 1),
  }
}

/** Chip width for a wrapping native grid (Growth metric toggles). */
export function nativeGridChipWidth(
  rowWidth: number,
  columns: number,
  gap = 0,
): number {
  const cols = Math.max(1, columns)
  return Math.max(0, Math.floor((rowWidth - gap * (cols - 1)) / cols))
}

/**
 * Flex fill for a settings section. Yoga's default minHeight is the content
 * size, so a `flex: 1` ScrollView grows with its children and never scrolls.
 */
export const nativeSettingsPaneFill: ViewStyle = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
}

/** Pixel-sized settings section root so nested ScrollViews can actually scroll. */
export function nativeSettingsPaneStyle(width: number): ViewStyle {
  return {
    ...nativeSettingsPaneFill,
    width,
    maxWidth: width,
    alignSelf: 'stretch',
  }
}

/** Phone pane uses a pinned width; web/tablet overlay panes keep className layout. */
export function nativeSettingsPaneRootStyle(
  width: number,
  comfortable: boolean,
): ViewStyle | undefined {
  return comfortable ? nativeSettingsPaneStyle(width) : undefined
}

/**
 * Two equal cards in a wrap row (`gap-3` = 12). NativeWind `w-[48%]` collapses
 * when the parent has no definite width.
 */
export function nativeTwoColumnCardWidth(
  paneWidth: number,
  gap = NATIVE_PHONE_CARD_GAP,
  inset = NATIVE_PHONE_SECTION_INSET,
): number {
  const inner = nativeContentWidth(paneWidth, inset)
  return Math.max(0, Math.floor((inner - gap) / 2))
}

/**
 * One `useWindowDimensions` subscription for phone detection and pixel widths.
 * Prefer this over calling the hook plus `Dimensions.get` in the same component.
 */
export function useNativePhoneWindow(): {
  isPhone: boolean
  width: number
  height: number
} {
  const { width, height } = useWindowDimensions()
  return {
    isPhone: isNativePhoneIntegrationsLayout(width, height),
    width,
    height,
  }
}

/** True on iPhone / Android phones. Web and tablets stay on the existing layout. */
export function useIsNativePhoneLayout(): boolean {
  const { width, height } = useWindowDimensions()
  return isNativePhoneIntegrationsLayout(width, height)
}

/** Phone chrome predicate including narrow web, for composer and dock layouts. */
export function usePhoneLayout(): boolean {
  const { width, height } = useWindowDimensions();
  return isPhoneLayout(width, height);
}
