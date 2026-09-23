// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  Animated,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PHONE_DENSITY, type Density } from '../../lib/phone-density'
import {
  nativeComposerKeyboardDuration,
  nativeComposerKeyboardOverlap,
  type NativeComposerKeyboardEvent,
} from '../../lib/native-composer-keyboard'
import {
  NATIVE_PHONE_GUTTER,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
  nativePhoneSheetKeyboardLift,
  useNativePhoneSheetChrome,
} from '../../lib/native-phone-layout'
import { acquireNativePhoneSheetLock } from '../../lib/native-phone-sheet-lock'

const NATIVE_PHONE_SHEET_SLIDE_IN_MS = 240
const NATIVE_PHONE_SHEET_SLIDE_OUT_MS = 180
const SHEET_CLOSE_HIT_SLOP = 8
const NATIVE_PHONE_SHEET_DRAG_MIN_DISTANCE = 4
const NATIVE_PHONE_SHEET_DRAG_PROJECTION_MS = 120
const NATIVE_PHONE_SHEET_DRAG_CLOSE_THRESHOLD = 72
const NATIVE_PHONE_SHEET_DRAG_SPRING = {
  stiffness: 300,
  damping: 32,
  mass: 0.8,
  useNativeDriver: true,
} as const

function useNativePhoneSheetSlide(visible: boolean, enabled: boolean) {
  const [mounted, setMounted] = useState(visible)
  const mountedRef = useRef(visible)
  const transition = useRef(new Animated.Value(visible ? 1 : 0)).current

  useEffect(() => {
    if (!enabled) {
      mountedRef.current = visible
      setMounted(visible)
      return
    }

    if (visible) {
      mountedRef.current = true
      setMounted(true)
      transition.stopAnimation()
      transition.setValue(0)
      const frame = requestAnimationFrame(() => {
        Animated.timing(transition, {
          toValue: 1,
          duration: NATIVE_PHONE_SHEET_SLIDE_IN_MS,
          useNativeDriver: true,
        }).start()
      })
      return () => cancelAnimationFrame(frame)
    }

    if (!mountedRef.current) return
    transition.stopAnimation()
    Animated.timing(transition, {
      toValue: 0,
      duration: NATIVE_PHONE_SHEET_SLIDE_OUT_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        mountedRef.current = false
        setMounted(false)
      }
    })
  }, [enabled, transition, visible])

  return { mounted, transition }
}

/**
 * Lift a bottom sheet clear of the software keyboard while editing.
 *
 * The modal is transparent and bottom-aligned. Native keyboard resizing can
 * already move it partway, so this adds only a small supplemental transform
 * and lets the keyboard animation drive the sheet up and back down smoothly.
 */
function useNativePhoneSheetKeyboardShift(visible: boolean, viewportHeight: number, enabled: boolean) {
  const shift = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!visible || !enabled) {
      shift.stopAnimation()
      shift.setValue(0)
      return
    }
    // Web and desktop retain their existing sheet behavior; this adjustment
    // is only needed for native software-keyboard frames.
    if (Platform.OS === 'web') return

    const animateTo = (next: number, duration?: number) => {
      Animated.timing(shift, {
        toValue: next,
        duration: duration && duration > 0 ? duration : 220,
        useNativeDriver: true,
      }).start()
    }

    const handleKeyboardFrame = (event: NativeComposerKeyboardEvent) => {
      const overlap = nativeComposerKeyboardOverlap(event.endCoordinates, viewportHeight)
      // iOS can emit a zero-height intermediate frame while opening. Let the
      // hide event own the reset so the sheet does not snap down mid-animation.
      if (overlap <= 0) return
      animateTo(-nativePhoneSheetKeyboardLift(overlap), nativeComposerKeyboardDuration(event.duration))
    }
    const handleKeyboardHide = (event: NativeComposerKeyboardEvent) => {
      animateTo(0, nativeComposerKeyboardDuration(event.duration))
    }

    const frameEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow'
    const frameSubscription = Keyboard.addListener(frameEvent, handleKeyboardFrame)
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      handleKeyboardHide,
    )

    return () => {
      frameSubscription.remove()
      hideSubscription.remove()
    }
  }, [enabled, shift, viewportHeight, visible])

  return shift
}

export function NativePhoneSheetCloseButton({
  onPress,
  density = PHONE_DENSITY,
}: {
  onPress: () => void
  density?: Density
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={SHEET_CLOSE_HIT_SLOP}
      accessibilityLabel="Close"
      accessibilityRole="button"
      className={cn(density.hit, 'rounded-full bg-muted')}
    >
      <X size={density.icon.md} className="text-foreground" />
    </Pressable>
  )
}

export interface NativePhoneSheetProps {
  visible: boolean
  onClose: () => void
  children: ReactNode
  title?: string
  subtitle?: string
  headerLeft?: ReactNode
  headerRight?: ReactNode
  headerTitleAlign?: 'left' | 'center'
  headerBorder?: boolean
  footer?: ReactNode
  scroll?: boolean
  maxHeightRatio?: number
  bodyMaxHeightRatio?: number
  animationType?: 'fade' | 'slide' | 'none'
  grabber?: boolean | 'compact' | ReactNode
  /** Whether the panel chrome includes its standard outline. */
  bordered?: boolean
  testID?: string
  density?: Density
  draggable?: boolean
  /** Dismiss instead of snapping to an intermediate height after a downward drag. */
  dragBehavior?: 'dismiss' | 'none'
  /** Keep the native drawer visible behind this sheet when it opens. */
  keepDrawerOpen?: boolean
  /** Choose between lifting the panel or letting a scrollable form handle the keyboard. */
  keyboardBehavior?: 'shift' | 'scroll'
  /** Ref for callers that need to reposition a scrollable sheet body. */
  scrollRef?: RefObject<ScrollView | null>
  /** Called when the scrollable body changes size, such as after filtering results. */
  onContentSizeChange?: (width: number, height: number) => void
}

/**
 * Shared full-width phone sheet chrome. Domain-specific content remains
 * caller-owned so nested scroll and action-sheet behaviour stay explicit.
 */
export function NativePhoneSheet({
  visible,
  onClose,
  children,
  title,
  subtitle,
  headerLeft,
  headerRight,
  headerTitleAlign = 'center',
  headerBorder = false,
  footer,
  scroll = false,
  maxHeightRatio = NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
  bodyMaxHeightRatio,
  animationType = 'fade',
  grabber = true,
  bordered = true,
  testID,
  density = PHONE_DENSITY,
  draggable = false,
  dragBehavior = 'dismiss',
  keepDrawerOpen = false,
  keyboardBehavior = 'shift',
  scrollRef,
  onContentSizeChange,
}: NativePhoneSheetProps) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const sheet = useNativePhoneSheetChrome()
  const hasHeader = Boolean(title || subtitle || headerLeft || headerRight)
  // A native transparent Modal slides its backdrop with the panel. Animate the
  // panel inside a static modal instead, so only the sheet moves upward.
  const panelSlide = animationType === 'slide'
  const { mounted, transition } = useNativePhoneSheetSlide(visible, panelSlide)
  const panelHeight = Math.round(height * maxHeightRatio)
  // iOS scroll sheets can rely on automatic keyboard insets. Android does not
  // resize this transparent modal reliably, so lift the panel while retaining
  // the scroll behavior for the task form.
  const keyboardShift = useNativePhoneSheetKeyboardShift(
    visible,
    height,
    keyboardBehavior === 'shift' || (keyboardBehavior === 'scroll' && Platform.OS === 'android'),
  )
  const dragOffset = useRef(new Animated.Value(0)).current
  const dragStart = useRef(0)
  const dragBounds = useMemo(() => {
    const top = -Math.max(0, height - panelHeight - insets.top - SHEET_CLOSE_HIT_SLOP)
    return { top }
  }, [height, insets.top, panelHeight])
  const canDrag = draggable && dragBehavior === 'dismiss'

  useEffect(() => {
    dragOffset.stopAnimation()
    dragOffset.setValue(0)
  }, [dragOffset, visible])

  const panelGesture = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => canDrag,
    onMoveShouldSetPanResponder: (_event, gesture) => (
      canDrag && Math.abs(gesture.dy) > NATIVE_PHONE_SHEET_DRAG_MIN_DISTANCE && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    ),
    onPanResponderGrant: () => {
      dragOffset.stopAnimation((value) => {
        dragStart.current = value
      })
    },
    onPanResponderMove: (_event, gesture) => {
      const next = Math.max(dragBounds.top, dragStart.current + gesture.dy)
      dragOffset.setValue(next)
    },
    onPanResponderRelease: (_event, gesture) => {
      const projected = dragStart.current + gesture.dy + gesture.vy * NATIVE_PHONE_SHEET_DRAG_PROJECTION_MS
      if (projected > NATIVE_PHONE_SHEET_DRAG_CLOSE_THRESHOLD) {
        onClose()
        return
      }
      const target = projected < dragBounds.top / 2 ? dragBounds.top : 0
      Animated.spring(dragOffset, {
        toValue: target,
        ...NATIVE_PHONE_SHEET_DRAG_SPRING,
      }).start()
    },
    onPanResponderTerminate: () => {
      Animated.spring(dragOffset, {
        toValue: 0,
        ...NATIVE_PHONE_SHEET_DRAG_SPRING,
      }).start()
    },
  }), [canDrag, dragBounds, dragOffset, onClose])

  useEffect(() => {
    if (!mounted || keepDrawerOpen) return
    return acquireNativePhoneSheetLock()
  }, [keepDrawerOpen, mounted])

  if (!mounted) return null

  const panelMotionStyle = panelSlide
    ? {
        opacity: transition,
        transform: [
          {
            translateY: transition.interpolate({
              inputRange: [0, 1],
              outputRange: [panelHeight, 0],
            }),
          },
          { translateY: keyboardShift },
          { translateY: dragOffset },
        ],
      }
    : { transform: [{ translateY: keyboardShift }, { translateY: dragOffset }] }
  const backdropMotionStyle = panelSlide ? { opacity: transition } : undefined
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      style={bodyMaxHeightRatio ? { maxHeight: Math.round(height * bodyMaxHeightRatio) } : undefined}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardBehavior === 'scroll' ? 'interactive' : undefined}
      automaticallyAdjustKeyboardInsets={keyboardBehavior === 'scroll' && Platform.OS === 'ios'}
      nestedScrollEnabled
      onContentSizeChange={onContentSizeChange}
    >
      {children}
    </ScrollView>
  ) : (
    children
  )

  return (
    <Modal
      visible={panelSlide ? mounted : visible}
      transparent
      animationType={panelSlide ? 'none' : animationType}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, sheet.backdrop, backdropMotionStyle]}>
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
        </Animated.View>
        <Animated.View style={[styles.panelMotion, panelMotionStyle]}>
          <View
            testID={testID}
            className={cn('w-full rounded-t-3xl bg-card', bordered ? 'border border-border border-b-0' : null)}
            style={[
              {
                maxHeight: panelHeight,
                paddingBottom: Math.max(insets.bottom, NATIVE_PHONE_GUTTER),
              },
              sheet.panel,
            ]}
          >
            {grabber ? (
              <View {...(canDrag ? panelGesture.panHandlers : {})} className="items-center pt-2 pb-1">
                {typeof grabber === 'object' ? grabber : (
                  <View
                    className={
                      grabber === 'compact'
                        ? 'h-1 w-10 rounded-full bg-muted-foreground/35'
                        : 'h-1 w-11 rounded-full bg-muted-foreground/35'
                    }
                  />
                )}
              </View>
            ) : null}
            {hasHeader ? (
              <View className={cn(
                "flex-row items-center px-4 pb-3",
                grabber ? null : "pt-3",
                headerBorder ? "border-b border-border" : null,
              )}>
                {headerLeft ?? (headerTitleAlign === 'center' ? <View className={density.hitSize} /> : null)}
                <View className={cn('flex-1', headerTitleAlign === 'center' ? 'px-3' : 'pr-3')}>
                  {title ? (
                      <Text
                        className={cn(
                          headerTitleAlign === 'left' ? 'text-left' : 'text-center',
                          density.text.title,
                          'font-semibold text-foreground',
                        )}
                        numberOfLines={2}
                      >
                      {title}
                    </Text>
                  ) : null}
                  {subtitle ? (
                      <Text
                        className={cn(
                          headerTitleAlign === 'left' ? 'text-left' : 'text-center',
                          density.text.label,
                          'text-muted-foreground',
                        )}
                        numberOfLines={2}
                      >
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                {headerRight ?? (headerTitleAlign === 'center' ? <View className={density.hitSize} /> : null)}
              </View>
            ) : null}
            {body}
            {footer}
          </View>
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: StyleSheet.absoluteFillObject,
  panelMotion: {
    width: '100%',
  },
})
