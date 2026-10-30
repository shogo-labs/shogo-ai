// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The back arrow for a phone screen you go into from the More tab. They draw
 * their own header, so each one drops this in front of its title. Wide web has
 * a sidebar and no stack to pop, so it renders nothing there.
 */
import { Platform, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { PressableScale } from '@shogo/shared-ui/primitives'
import { haptics } from '../../lib/haptics'
import { WEB_WIDE_MIN_WIDTH } from '../../lib/native-phone-layout'

export function PhoneBackButton() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  if (Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH) return null
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Back"
      testID="phone-back-button"
      hitSlop={8}
      feedback={haptics.selection}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)/more' as any))}
      className="h-9 w-9 items-center justify-center rounded-full"
    >
      <ArrowLeft size={22} className="text-foreground" />
    </PressableScale>
  )
}
