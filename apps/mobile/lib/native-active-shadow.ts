// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NativeWind crashes on native when `shadow-*` classes are added or removed
 * ("Couldn't find a navigation context"). Keep the active fill in className
 * and apply the shadow as an inline style on native; web can still use shadow-sm.
 */
import { Platform, type ViewStyle } from 'react-native'

export const NATIVE_ACTIVE_PILL_SHADOW: ViewStyle | undefined = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
  },
  android: { elevation: 1 },
  default: undefined,
})

export function nativeActivePill(
  active: boolean,
  options?: { backgroundClass?: string; webShadow?: boolean },
): { className: string; style: ViewStyle | undefined } {
  const backgroundClass = options?.backgroundClass ?? 'bg-background'
  const webShadow = options?.webShadow ?? true
  if (!active) return { className: '', style: undefined }
  if (Platform.OS !== 'web') {
    return { className: backgroundClass, style: NATIVE_ACTIVE_PILL_SHADOW }
  }
  if (!webShadow) {
    return { className: backgroundClass, style: undefined }
  }
  return { className: `${backgroundClass} shadow-sm`, style: undefined }
}
