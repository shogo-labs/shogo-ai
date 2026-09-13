// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Modal,
  Pressable,
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
  NATIVE_PHONE_GUTTER,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
  useNativePhoneSheetChrome,
} from '../../lib/native-phone-layout'

const NATIVE_PHONE_SHEET_SLIDE_IN_MS = 240
const NATIVE_PHONE_SHEET_SLIDE_OUT_MS = 180
const SHEET_CLOSE_HIT_SLOP = 8

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
  footer?: ReactNode
  scroll?: boolean
  maxHeightRatio?: number
  bodyMaxHeightRatio?: number
  animationType?: 'fade' | 'slide' | 'none'
  grabber?: boolean | 'compact'
  testID?: string
  density?: Density
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
  footer,
  scroll = false,
  maxHeightRatio = NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
  bodyMaxHeightRatio,
  animationType = 'fade',
  grabber = true,
  testID,
  density = PHONE_DENSITY,
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
        ],
      }
    : undefined
  const backdropMotionStyle = panelSlide ? { opacity: transition } : undefined
  const body = scroll ? (
    <ScrollView
      style={bodyMaxHeightRatio ? { maxHeight: Math.round(height * bodyMaxHeightRatio) } : undefined}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
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
            className="w-full rounded-t-3xl border border-border border-b-0 bg-card"
            style={[
              {
                maxHeight: panelHeight,
                paddingBottom: Math.max(insets.bottom, NATIVE_PHONE_GUTTER),
              },
              sheet.panel,
            ]}
          >
            {grabber ? (
              <View className="items-center pt-2 pb-1">
                <View
                  className={
                    grabber === 'compact'
                      ? 'h-1 w-10 rounded-full bg-muted-foreground/35'
                      : 'h-1 w-11 rounded-full bg-muted-foreground/35'
                  }
                />
              </View>
            ) : null}
            {hasHeader ? (
              <View className={cn("flex-row items-center px-4 pb-3", grabber ? null : "pt-3")}>
                {headerLeft ?? <View className={density.hitSize} />}
                <View className="flex-1 px-3">
                  {title ? (
                      <Text
                        className={cn(
                          'text-center',
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
                          'text-center',
                          density.text.label,
                          'text-muted-foreground',
                        )}
                        numberOfLines={2}
                      >
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                {headerRight ?? <View className={density.hitSize} />}
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
