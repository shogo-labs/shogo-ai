// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bottom sheet that hosts a settings tab on the Account screen so native
 * phone does not push `/(app)/settings`. Web still uses that page.
 */
import type { ReactNode } from "react"
import { View } from "react-native"
import { NativePhoneSheet, NativePhoneSheetCloseButton } from "../phone/NativePhoneSheet"
import { ACCOUNT_SHEET_DENSITY } from "../../lib/phone-density"
import {
  NATIVE_PHONE_ACCOUNT_SETTINGS_BODY_RATIO,
  NATIVE_PHONE_ACCOUNT_SETTINGS_SHEET_RATIO,
} from "../../lib/native-phone-layout"
import { AccountSheetChromeProvider } from "./account-sheet-chrome"

export function NativeAccountSettingsSheet({
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
  return (
    <AccountSheetChromeProvider>
      <NativePhoneSheet
        visible={visible}
        onClose={onClose}
        title={title}
        animationType="slide"
        grabber={false}
        density={ACCOUNT_SHEET_DENSITY}
        maxHeightRatio={NATIVE_PHONE_ACCOUNT_SETTINGS_SHEET_RATIO}
        bodyMaxHeightRatio={NATIVE_PHONE_ACCOUNT_SETTINGS_BODY_RATIO}
        scroll
        testID="native-account-settings-sheet"
        headerLeft={
          <NativePhoneSheetCloseButton onPress={onClose} density={ACCOUNT_SHEET_DENSITY} />
        }
      >
        <View className="px-4 pb-4">{children}</View>
      </NativePhoneSheet>
    </AccountSheetChromeProvider>
  )
}
