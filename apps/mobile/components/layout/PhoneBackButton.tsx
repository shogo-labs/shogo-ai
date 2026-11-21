// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Back control for a phone screen you go into from the More tab. It is the
 * same 44px glass circle the conversation header uses, so every screen's way
 * back looks identical. Wide web has a sidebar and no stack to pop, so it
 * renders nothing there.
 **/
import { Platform, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { GlassButton } from '../team-chat/FloatingChrome'
import { haptics } from '../../lib/haptics'
import { WEB_WIDE_MIN_WIDTH } from '../../lib/native-phone-layout'

export function PhoneBackButton() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  if (Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH) return null
  return (
    <GlassButton
      label="Back"
      testID="phone-back-button"
      onPress={() => {
        haptics.selection()
        if (router.canGoBack()) router.back()
        else router.replace('/(app)/more' as any)
      }}
    >
      <ChevronLeft size={22} className="text-foreground" />
    </GlassButton>
  )
}
