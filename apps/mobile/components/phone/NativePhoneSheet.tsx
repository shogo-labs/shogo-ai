// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { X } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
  useNativePhoneSheetChrome,
} from '../../lib/native-phone-layout'

/** Matches the existing activity-sheet close control (not PHONE_DENSITY.hitSize). */
const SHEET_CLOSE_ICON_SIZE = 18

export function NativePhoneSheetCloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel="Close"
      accessibilityRole="button"
      className="h-10 w-10 items-center justify-center rounded-full bg-muted"
    >
      <X size={SHEET_CLOSE_ICON_SIZE} className="text-foreground" />
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
}: NativePhoneSheetProps) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const sheet = useNativePhoneSheetChrome()
  const hasHeader = Boolean(title || subtitle || headerLeft || headerRight)
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
      visible={visible}
      transparent
      animationType={animationType}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={[styles.backdrop, sheet.backdrop]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View
          testID={testID}
          className="w-full rounded-t-3xl border border-border border-b-0 bg-card"
          style={[
            {
              maxHeight: Math.round(height * maxHeightRatio),
              paddingBottom: Math.max(insets.bottom, 16),
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
            <View className="flex-row items-center px-4 pb-3">
              {headerLeft ?? <View className="h-10 w-10" />}
              <View className="flex-1 px-3">
                {title ? (
                  <Text className="text-center text-[17px] font-semibold text-foreground" numberOfLines={2}>
                    {title}
                  </Text>
                ) : null}
                {subtitle ? (
                  <Text className="text-center text-xs text-muted-foreground" numberOfLines={2}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {headerRight ?? <View className="h-10 w-10" />}
            </View>
          ) : null}
          {body}
          {footer}
        </View>
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
})
