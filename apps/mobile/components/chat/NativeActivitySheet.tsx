// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-phone bottom sheet for thought / work details.
 * Web and tablets keep inline accordions.
 */

import type { ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'
import {
  Pressable,
  Text,
  View,
} from 'react-native'
import {
  NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO,
  NATIVE_PHONE_SHEET_COMPACT_RATIO,
} from "../../lib/native-phone-layout"
import { NativePhoneSheet, NativePhoneSheetCloseButton } from "../phone/NativePhoneSheet"

const InsideActivitySheetContext = createContext(false)

export function useInsideActivitySheet(): boolean {
  return useContext(InsideActivitySheetContext)
}

export function NativeActivitySheet({
  visible,
  title,
  onClose,
  children,
  showClose = true,
}: {
  visible: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Model picker uses grabber + tap-away dismiss; thought/work sheets keep the X. */
  showClose?: boolean
}) {

  return (
    <NativePhoneSheet
      visible={visible}
      onClose={onClose}
      title={title}
      maxHeightRatio={NATIVE_PHONE_SHEET_COMPACT_RATIO}
      bodyMaxHeightRatio={NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO}
      scroll
      headerLeft={showClose ? <NativePhoneSheetCloseButton onPress={onClose} /> : undefined}
    >
      <InsideActivitySheetContext.Provider value={true}>
        {children}
      </InsideActivitySheetContext.Provider>
    </NativePhoneSheet>
  )
}

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
