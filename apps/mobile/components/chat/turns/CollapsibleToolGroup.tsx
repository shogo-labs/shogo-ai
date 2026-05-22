// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CollapsibleToolGroup Component (React Native)
 *
 * Shared shell for ThinkingWidget-style collapsible runs of tool
 * calls — the header label, capped-height fading scroll body, height
 * spring animation, hidden measurer, and auto-scroll-while-streaming
 * behavior all live here. Concrete groups (`ExplorationGroup`,
 * `EditingGroup`, …) compute their own label/summary and render the
 * row body as children.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
  type ReactNode,
} from "react"
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

const ANIM_DURATION = 500
const STREAM_MAX_HEIGHT = 200
const FADE_HEIGHT = 16

const ROTATE_TRANSITION = {
  type: "timing",
  duration: ANIM_DURATION,
  easing: "easeInOut",
}
// Critically damped (ζ ≈ 1) so the height spring converges without
// overshoot when re-targeted by `onContentSizeChange` while tools
// stream in. See ThinkingWidget for the long version of this comment.
const HEIGHT_TRANSITION = {
  opacity: { type: "timing", duration: ANIM_DURATION, easing: "easeInOut" },
  height: { type: "spring", damping: 32, stiffness: 260, mass: 1 },
}
const ROTATE_OPEN = { rotateZ: "180deg" }
const ROTATE_CLOSED = { rotateZ: "0deg" }
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

export interface CollapsibleToolGroupProps {
  label: string
  isStreaming: boolean
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
  /**
   * Unique key for the AnimatePresence child so multiple shells on the
   * same page don't share animation state. Pass e.g. the group id.
   */
  contentKey?: string
  children: ReactNode
}

function CollapsibleToolGroupImpl({
  label,
  isStreaming,
  isExpanded: controlledExpanded,
  onToggle,
  className,
  contentKey = "collapsible-tool-content",
  children,
}: CollapsibleToolGroupProps) {
  const [internalExpanded, setInternalExpanded] = useState(isStreaming)
  const userClosedRef = useRef(false)
  const [measuredHeight, setMeasuredHeight] = useState(0)
  const colorScheme = useColorScheme()
  const innerScrollRef = useRef<ScrollView>(null)
  const userScrolledRef = useRef(false)

  const isControlled = controlledExpanded !== undefined
  const isOpen = isControlled
    ? !!controlledExpanded
    : isStreaming && !userClosedRef.current
      ? true
      : internalExpanded

  useEffect(() => {
    if (isControlled) return
    if (isStreaming) {
      userScrolledRef.current = false
      if (!userClosedRef.current) {
        setInternalExpanded(true)
      }
    } else {
      setInternalExpanded(false)
      userClosedRef.current = false
    }
  }, [isStreaming, isControlled])

  const toggleOpen = useCallback(() => {
    if (onToggle) {
      if (isStreaming && isOpen) {
        userClosedRef.current = true
      }
      onToggle()
      return
    }
    setInternalExpanded((prev) => {
      if (isStreaming && prev) {
        userClosedRef.current = true
      }
      return !prev
    })
  }, [onToggle, isStreaming, isOpen])

  // Cap height + scroll inside while OPEN, regardless of streaming
  // state. Letting `capHeight` follow `isStreaming` produced a visible
  // "expand to full content height" jump on the falling edge of the
  // stream, then a separate close animation 1.5s later — the same
  // wasted-motion path we eliminated in ThinkingWidget.
  const targetHeight = Math.min(measuredHeight, STREAM_MAX_HEIGHT)

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
    () => [styles.capHeight, WEB_FADE_MASK],
    [],
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
    userScrolledRef.current = true
  }, [])

  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const next = Math.ceil(h + 20)
      // Only commit on >1px deltas so the height spring doesn't keep
      // re-kicking from sub-pixel jitter (same pattern as ThinkingWidget).
      if (Math.abs(next - measuredHeight) > 1) setMeasuredHeight(next)
      if (isStreaming && !userScrolledRef.current) {
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

      {/* Hidden measurer — mirrors ThinkingWidget so the spring animation
          has a real target height instead of jumping to STREAM_MAX_HEIGHT. */}
      {measuredHeight === 0 && (
        <View style={styles.hiddenMeasure} onLayout={handleHiddenLayout}>
          <View className="ml-2 pl-2 border-l border-border/40 pt-2.5 pb-1">
            {children}
          </View>
        </View>
      )}

      <AnimatePresence>
        {isOpen && (
          <Motion.View
            key={contentKey}
            initial={MOTION_INITIAL}
            animate={heightAnimate}
            exit={MOTION_EXIT}
            transition={HEIGHT_TRANSITION}
            style={styles.overflowHidden}
          >
            <View style={styles.relative}>
              <ScrollView
                ref={innerScrollRef}
                className="ml-2 pl-2 border-l border-border/40 pt-2.5 pb-1"
                style={scrollStyle}
                scrollEnabled
                nestedScrollEnabled
                onScrollBeginDrag={handleScrollBeginDrag}
                onContentSizeChange={handleContentSizeChange}
              >
                {children}
              </ScrollView>

              {Platform.OS !== "web" && (
                <>
                  <LinearGradient
                    colors={topFadeColors}
                    style={styles.topFade}
                  />
                  <LinearGradient
                    colors={bottomFadeColors}
                    style={styles.bottomFade}
                  />
                </>
              )}
            </View>
          </Motion.View>
        )}
      </AnimatePresence>
    </View>
  )
}

export const CollapsibleToolGroup = memo(CollapsibleToolGroupImpl)

export default CollapsibleToolGroup
