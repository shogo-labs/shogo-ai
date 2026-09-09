// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect } from 'react'
import { Platform, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { isPhoneLayout } from './native-phone-layout'

/**
 * Guard routes that only make sense in the phone navigation surface.
 * Native devices remain supported regardless of their reported dimensions;
 * narrow web is supported when it uses phone chrome.
 */
export function usePhoneOnlyRoute(redirectTo = '/(app)'): boolean {
  const router = useRouter()
  const { width, height } = useWindowDimensions()
  const isPhone = isPhoneLayout(width, height)
  const isSupportedPlatform = Platform.OS !== 'web' || isPhone

  useEffect(() => {
    if (!isSupportedPlatform) {
      router.replace(redirectTo as never)
    }
  }, [isSupportedPlatform, redirectTo, router])

  return isSupportedPlatform
}
