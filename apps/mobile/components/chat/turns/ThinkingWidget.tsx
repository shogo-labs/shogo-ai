// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ThinkingWidget Component (React Native)
 *
 * Collapsible display for assistant thinking/reasoning blocks.
 * Auto-opens during streaming, auto-closes when complete.
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react"
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  StyleSheet,
  useColorScheme,
  type LayoutChangeEvent,
} from "react-native"
import { Motion, AnimatePresence } from "@legendapp/motion"
import { LinearGradient } from "expo-linear-gradient"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronDown } from "lucide-react-native"
import { MarkdownText } from "../MarkdownText"

const ANIM_DURATION = 500
const STREAM_MAX_HEIGHT = 200
const FADE_HEIGHT = 16

// Hoisted-stable references for legendapp/motion props. Keeping these out of
// the render body means @legendapp/motion sees identity-equal `transition` /
// `animate` props across renders and won't re-kick animations when the
// component re-renders for unrelated reasons.
const ROTATE_TRANSITION = {
  type: "timing",
  duration: ANIM_DURATION,
  easing: "easeInOut",
}
const HEIGHT_TRANSITION = {
  opacity: { type: "timing", duration: ANIM_DURATION, easing: "easeInOut" },
  height: { type: "spring", damping: 22, stiffness: 260, mass: 1 },
}
const ROTATE_OPEN = { rotateZ: "180deg" }
const ROTATE_CLOSED = { rotateZ: "0deg" }
// Separate refs for initial/exit so legendapp/motion can track them
// independently inside AnimatePresence.
const MOTION_INITIAL = { opacity: 0, height: 0 }
const MOTION_EXIT = { opacity: 0, height: 0 }

const styles = StyleSheet.create({
  hiddenMeasure: {
    position: "absolute",
    opacity: 0,
    pointerEvents: "none",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  relative: {
    position: "relative",
  },
  topFade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: FADE_HEIGHT,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    pointerEvents: "none",
  },
  bottomFade: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: FADE_HEIGHT,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    pointerEvents: "none",
  },
  capHeight: {
    maxHeight: STREAM_MAX_HEIGHT,
  },
})

const WEB_FADE_MASK =
  Platform.OS === "web"
    ? ({
        WebkitMaskImage: `linear-gradient(to bottom, transparent, black ${FADE_HEIGHT}px, black calc(100% - ${FADE_HEIGHT}px), transparent)`,
        maskImage: `linear-gradient(to bottom, transparent, black ${FADE_HEIGHT}px, black calc(100% - ${FADE_HEIGHT}px), transparent)`,
      } as any)
    : undefined

export interface ThinkingWidgetProps {
  text: string
  isStreaming?: boolean
  durationSeconds?: number
  className?: string
}

function ThinkingWidgetImpl({
  text,
  isStreaming = false,
  durationSeconds,
  className,
}: ThinkingWidgetProps) {
  const [isOpen, setIsOpen] = useState(isStreaming)
  const userClosedRef = useRef(false)
  const startTimeRef = useRef<number | null>(null)
  const [duration, setDuration] = useState<number | undefined>(durationSeconds)
  const [measuredHeight, setMeasuredHeight] = useState(0)
  const colorScheme = useColorScheme()
  const innerScrollRef = useRef<ScrollView>(null)
  const userScrolledThinkingRef = useRef(false)

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
      userScrolledThinkingRef.current = false
      if (!userClosedRef.current) {
        setIsOpen(true)
      }
    } else {
      if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / 1000))
        startTimeRef.current = null
      }
      setIsOpen(false)
      userClosedRef.current = false
    }
  }, [isStreaming])

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      if (isStreaming && prev) {
        userClosedRef.current = true
      }
      return !prev
    })
  }, [isStreaming])

  const label = isStreaming
    ? "Thinking…"
    : duration !== undefined
      ? `Thought for ${duration}s`
      : "Thought"

  const hasText = text.length > 0
  const capHeight = isStreaming
  const targetHeight = capHeight
    ? Math.min(measuredHeight, STREAM_MAX_HEIGHT)
    : measuredHeight

  // Composite bg color for gradient fades (muted/30 over page background)
  const fadeColor =
    colorScheme === "dark" ? "rgb(25, 25, 25)" : "rgb(252, 252, 252)"
  const fadeColorTransparent =
    colorScheme === "dark" ? "rgba(25, 25, 25, 0)" : "rgba(252, 252, 252, 0)"

  const topFadeColors = useMemo<[string, string]>(
    () => [fadeColor, fadeColorTransparent],
    [fadeColor, fadeColorTransparent],
  )
  const bottomFadeColors = useMemo<[string, string]>(
    () => [fadeColorTransparent, fadeColor],
    [fadeColor, fadeColorTransparent],
  )

  const scrollStyle = useMemo(
    () => [capHeight ? styles.capHeight : undefined, WEB_FADE_MASK],
    [capHeight],
  )

  const heightAnimate = useMemo(
    () => ({ opacity: 1, height: targetHeight || STREAM_MAX_HEIGHT }),
    [targetHeight],
  )

  const handleHiddenLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height
    if (h > 0) setMeasuredHeight(h)
  }, [])

  const handleScrollBeginDrag = useCallback(() => {
    userScrolledThinkingRef.current = true
  }, [])

  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const next = Math.ceil(h + 20)
      // Only commit when the delta is meaningful — sub-pixel jitter from the
      // height spring otherwise feeds back into Motion.View.animate and keeps
      // re-kicking the animation.
      if (Math.abs(next - measuredHeight) > 1) setMeasuredHeight(next)
      if (isStreaming && !userScrolledThinkingRef.current) {
        innerScrollRef.current?.scrollToEnd({ animated: false })
      }
    },
    [measuredHeight, isStreaming],
  )

  return (
    <View className={cn("", className)}>
      <Pressable
        onPress={toggleOpen}
        className="flex-row items-center gap-1.5 rounded-md"
        role="button"
        accessibilityLabel={label}
      >
        <Text className="text-[11px] text-muted-foreground">{label}</Text>
        <Motion.View
          animate={isOpen ? ROTATE_OPEN : ROTATE_CLOSED}
          transition={ROTATE_TRANSITION}
        >
          <ChevronDown size={10} className="text-muted-foreground" />
        </Motion.View>
      </Pressable>

      {hasText && measuredHeight === 0 && (
        <View style={styles.hiddenMeasure} onLayout={handleHiddenLayout}>
          <View className="rounded-md border border-border/50 bg-muted/30 p-2.5">
            <MarkdownText variant="thinking">{text}</MarkdownText>
          </View>
        </View>
      )}

      <AnimatePresence>
        {isOpen && hasText && (
          <Motion.View
            key="thinking-content"
            initial={MOTION_INITIAL}
            animate={heightAnimate}
            exit={MOTION_EXIT}
            transition={HEIGHT_TRANSITION}
            style={styles.overflowHidden}
          >
            <View style={styles.relative}>
              <ScrollView
                ref={innerScrollRef}
                className="rounded-md border border-border/50 bg-muted/30 p-2.5"
                style={scrollStyle}
                scrollEnabled={capHeight}
                nestedScrollEnabled
                onScrollBeginDrag={handleScrollBeginDrag}
                onContentSizeChange={handleContentSizeChange}
              >
                <MarkdownText variant="thinking">{text}</MarkdownText>
              </ScrollView>

              {/* Native fade overlays (web uses CSS mask instead) */}
              {Platform.OS !== "web" && (
                <>
                  <LinearGradient colors={topFadeColors} style={styles.topFade} />
                  <LinearGradient colors={bottomFadeColors} style={styles.bottomFade} />
                </>
              )}
            </View>
          </Motion.View>
        )}
      </AnimatePresence>
    </View>
  )
}

export const ThinkingWidget = memo(ThinkingWidgetImpl)
