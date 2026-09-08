// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-phone bottom sheet for thought / work details.
 * Web and tablets keep inline accordions.
 */

import type { ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'

const InsideActivitySheetContext = createContext(false)

export function useInsideActivitySheet(): boolean {
  return useContext(InsideActivitySheetContext)
}

export function NativeActivitySheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
        />
        <View
          className="w-full rounded-t-3xl border border-border border-b-0 bg-card"
          style={{
            maxHeight: Math.round(height * 0.72),
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          <View className="items-center pt-2 pb-1">
            <View className="h-1 w-11 rounded-full bg-muted-foreground/35" />
          </View>
          <View className="flex-row items-center px-4 pb-3">
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityLabel="Close"
              accessibilityRole="button"
              className="h-10 w-10 items-center justify-center rounded-full bg-muted"
            >
              <X size={18} className="text-foreground" />
            </Pressable>
            <Text
              className="flex-1 px-3 text-center text-[17px] font-semibold text-foreground"
              numberOfLines={2}
            >
              {title}
            </Text>
            <View className="h-10 w-10" />
          </View>
          <ScrollView
            style={{ maxHeight: Math.round(height * 0.56) }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            <InsideActivitySheetContext.Provider value={true}>
              {children}
            </InsideActivitySheetContext.Provider>
          </ScrollView>
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
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
})

/** Compact chat-row trigger that opens work/thought details in a sheet. */
export function NativeWorkTrigger({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const insideSheet = useInsideActivitySheet()

  if (insideSheet) {
    return <>{children}</>
  }

  return (
    <View className="py-0.5">
      <Pressable
        onPress={() => setOpen(true)}
        className="self-start py-1"
        role="button"
        accessibilityLabel={label}
      >
        <Text className="text-[15px] text-muted-foreground">{label}</Text>
      </Pressable>
      <NativeActivitySheet
        visible={open}
        title={title ?? label}
        onClose={() => setOpen(false)}
      >
        {children}
      </NativeActivitySheet>
    </View>
  )
}
