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

/**
 * The one type scale for every activity row in the native-phone transcript —
 * Thought, Thinking…, Worked, Working…, Worked for …, the planning status
 * line and the streaming exec / edit / write / tool rows. 15px is one step
 * under the 16px body copy, so a row reads as a label rather than as a
 * second body size (SHO-296).
 */
export const NATIVE_ACTIVITY_LABEL = "text-[15px] leading-5 text-muted-foreground"

/**
 * Row padding for an activity row: the label's own 20px line box plus 2px,
 * with no `min-h-11`. The 44pt touch target comes from
 * `NATIVE_ACTIVITY_HIT_SLOP` instead, so the row does not reserve ~14px of
 * empty space above and below its text.
 */
export const NATIVE_ACTIVITY_ROW = "py-0.5"

/** 20px line + 12px each side = a 44pt touch target without the 44px gap. */
export const NATIVE_ACTIVITY_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const

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
    <View className={NATIVE_ACTIVITY_ROW}>
      <Pressable
        onPress={() => setOpen(true)}
        className="self-start"
        hitSlop={NATIVE_ACTIVITY_HIT_SLOP}
        role="button"
        accessibilityLabel={label}
      >
        <Text className={NATIVE_ACTIVITY_LABEL}>{label}</Text>
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
