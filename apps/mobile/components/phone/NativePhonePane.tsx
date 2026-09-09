// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native'
import { nativeSettingsPaneRootStyle } from '../../lib/native-phone-layout'

export interface NativePhonePaneProps {
  pageWidth: number
  comfortable: boolean
  children: ReactNode
  className?: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

/** Shared bounded root used by settings panels on native phones. */
export function NativePhonePane({
  pageWidth,
  comfortable,
  children,
  className,
  style,
  testID,
}: NativePhonePaneProps) {
  return (
    <View
      collapsable={false}
      className={[comfortable ? undefined : 'absolute inset-0 flex-col', className].filter(Boolean).join(' ')}
      style={[nativeSettingsPaneRootStyle(pageWidth, comfortable), style]}
      testID={testID}
    >
      {children}
    </View>
  )
}

export function phonePaneScrollProps(
  comfortable: boolean,
): Pick<ScrollViewProps, 'nestedScrollEnabled' | 'keyboardShouldPersistTaps' | 'alwaysBounceVertical'> {
  return {
    nestedScrollEnabled: true,
    keyboardShouldPersistTaps: 'handled',
    alwaysBounceVertical: comfortable,
  }
}
