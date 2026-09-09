// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Compact → stacked transition for the phone composer.
 *
 * Empty / first-line: text sits in the toolbar row between +/Auto and send.
 * Once the line would wrap in that slot (or the user inserts a newline),
 * the field animates to a full-width stacked layout with the toolbar below.
 *
 * Width is measured independently of the current field so expanding to full
 * width cannot immediately collapse again (the same text often fits one
 * stacked line).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Animated,
  Easing,
  TextInput,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native"

export const PROMINENT_COMPOSER_MIN_HEIGHT = 24
export const PROMINENT_COMPOSER_MAX_HEIGHT = 132
export const PROMINENT_COMPOSER_LINE_HEIGHT = 22
export const PROMINENT_COMPOSER_FONT_SIZE = 16
export const PROMINENT_COMPOSER_PADDING_TOP = 14
export const PROMINENT_COMPOSER_PADDING_HORIZONTAL = 16
export const PROMINENT_COMPOSER_PADDING_BOTTOM = 8
export const PROMINENT_COMPOSER_RADIUS = 28
export const PROMINENT_COMPOSER_TOOLBAR_MIN_HEIGHT = 48
export const PROMINENT_COMPOSER_HEIGHT_ANIMATION_DURATION = 200
export const PROMINENT_COMPOSER_PLACEHOLDER_FADE_DURATION = 150
export const PROMINENT_COMPOSER_DEFAULT_COMPACT_LEFT = 108
export const PROMINENT_COMPOSER_DEFAULT_COMPACT_RIGHT = 48
export const PROMINENT_COMPOSER_SLOT_MEASURED_MIN_WIDTH = 80
export const PROMINENT_COMPOSER_WRAP_SLOP = 8
export const PROMINENT_COMPOSER_MEASURE_TEXT_WIDTH = 10000
export const PROMINENT_COMPOSER_OVERLAY_Z_INDEX = 4
export const PROMINENT_COMPOSER_TOOLBAR_Z_INDEX = 3
export const PROMINENT_COMPOSER_CHROME_Z_INDEX = 5
export const PROMINENT_COMPOSER_HEIGHT_EASING = Easing.out(Easing.cubic)
export const ProminentAnimatedTextInput = Animated.createAnimatedComponent(TextInput)

export function prominentModelTriggerMaxWidth(windowWidth: number): number {
  return Math.max(54, Math.min(80, Math.floor(windowWidth * 0.18)))
}

export function shouldStackProminentComposer({
  empty,
  text,
  slotWidth,
  textWidth,
  contentHeight,
  lineHeight,
  currentlyStacked,
}: {
  empty: boolean
  text: string
  slotWidth: number
  textWidth: number
  contentHeight: number
  lineHeight: number
  currentlyStacked: boolean
}): boolean {
  if (empty) return false
  if (text.includes("\n")) return true

  const measuredSlot = slotWidth > PROMINENT_COMPOSER_SLOT_MEASURED_MIN_WIDTH
  if (measuredSlot) {
    const threshold = currentlyStacked
      ? slotWidth - PROMINENT_COMPOSER_WRAP_SLOP
      : slotWidth
    return textWidth > threshold
  }

  if (currentlyStacked) return true
  return contentHeight > lineHeight + PROMINENT_COMPOSER_WRAP_SLOP
}

export function nextProminentComposerHeight(
  contentHeight: number,
  {
    empty,
    minHeight,
    maxHeight,
    lineHeight,
  }: {
    empty: boolean
    minHeight: number
    maxHeight: number
    lineHeight: number
  },
): number {
  if (empty || contentHeight <= lineHeight + PROMINENT_COMPOSER_WRAP_SLOP) {
    return minHeight
  }
  return Math.min(maxHeight, Math.max(minHeight, contentHeight))
}

export function useProminentComposerExpansion({
  enabled,
  empty,
  text,
  inputHeight,
  minHeight,
  lineHeight,
  paddingTop,
  paddingHorizontal,
  paddingBottom,
  toolbarMinHeight = PROMINENT_COMPOSER_TOOLBAR_MIN_HEIGHT,
  duration,
  easing,
}: {
  enabled: boolean
  empty: boolean
  text: string
  inputHeight: number
  minHeight: number
  lineHeight: number
  paddingTop: number
  paddingHorizontal: number
  paddingBottom: number
  toolbarMinHeight?: number
  duration: number
  easing: (value: number) => number
}) {
  const [chromeHeight, setChromeHeight] = useState(0)
  const [pillWidth, setPillWidth] = useState(0)
  const [slotX, setSlotX] = useState(0)
  const [slotWidth, setSlotWidth] = useState(0)
  const [textWidth, setTextWidth] = useState(0)
  const [contentHeight, setContentHeight] = useState(minHeight)
  const [stacked, setStacked] = useState(false)
  const prevStackedRef = useRef(false)

  const slotLeft = useRef(new Animated.Value(PROMINENT_COMPOSER_DEFAULT_COMPACT_LEFT)).current
  const slotRight = useRef(new Animated.Value(PROMINENT_COMPOSER_DEFAULT_COMPACT_RIGHT)).current
  const slotTop = useRef(new Animated.Value((toolbarMinHeight - minHeight) / 2)).current
  const spacerHeight = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!empty) return
    setContentHeight((current) => (current === minHeight ? current : minHeight))
    setTextWidth((current) => (current === 0 ? current : 0))
  }, [empty, minHeight])

  useEffect(() => {
    if (!enabled) {
      setStacked(false)
      return
    }
    setStacked((currentlyStacked) =>
      shouldStackProminentComposer({
        empty,
        text,
        slotWidth,
        textWidth,
        contentHeight,
        lineHeight,
        currentlyStacked,
      }),
    )
  }, [contentHeight, empty, enabled, lineHeight, slotWidth, text, textWidth])

  const compactLeft =
    slotWidth > 0 ? slotX : PROMINENT_COMPOSER_DEFAULT_COMPACT_LEFT
  const compactRight =
    pillWidth > 0 && slotWidth > 0
      ? Math.max(PROMINENT_COMPOSER_WRAP_SLOP, pillWidth - slotX - slotWidth)
      : PROMINENT_COMPOSER_DEFAULT_COMPACT_RIGHT
  const compactTop = chromeHeight + (toolbarMinHeight - minHeight) / 2
  const stackedTop = chromeHeight + paddingTop

  useEffect(() => {
    if (!enabled) return

    const stackedChanged = prevStackedRef.current !== stacked
    prevStackedRef.current = stacked
    const durationMs = !stackedChanged && !stacked ? 0 : duration

    const animate = (value: Animated.Value, toValue: number) =>
      Animated.timing(value, {
        toValue,
        duration: durationMs,
        easing,
        useNativeDriver: false,
      })

    Animated.parallel([
      animate(slotLeft, stacked ? paddingHorizontal : compactLeft),
      animate(slotRight, stacked ? paddingHorizontal : compactRight),
      animate(slotTop, stacked ? stackedTop : compactTop),
      animate(
        spacerHeight,
        stacked ? paddingTop + inputHeight + paddingBottom : 0,
      ),
    ]).start()
  }, [
    compactLeft,
    compactRight,
    compactTop,
    duration,
    easing,
    enabled,
    inputHeight,
    paddingBottom,
    paddingHorizontal,
    paddingTop,
    stacked,
    stackedTop,
    spacerHeight,
    slotLeft,
    slotRight,
    slotTop,
  ])

  const onPillLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width
    setPillWidth((current) => (current === width ? current : width))
  }, [])

  const onChromeLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height
    setChromeHeight((current) => (current === height ? current : height))
  }, [])

  const onCompactSlotLayout = useCallback((event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout
    setSlotX((current) => (current === x ? current : x))
    setSlotWidth((current) => (current === width ? current : width))
  }, [])

  const onMeasureTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const width = event.nativeEvent.lines[0]?.width ?? 0
      setTextWidth((current) => (current === width ? current : width))
    },
    [],
  )

  const reportContentHeight = useCallback((height: number) => {
    setContentHeight((current) => (current === height ? current : height))
  }, [])

  return {
    stacked,
    reportContentHeight,
    onPillLayout,
    onChromeLayout,
    onCompactSlotLayout,
    onMeasureTextLayout,
    spacerStyle: { height: spacerHeight },
    slotStyle: {
      position: "absolute" as const,
      left: slotLeft,
      right: slotRight,
      top: slotTop,
      zIndex: PROMINENT_COMPOSER_OVERLAY_Z_INDEX,
    },
  }
}
