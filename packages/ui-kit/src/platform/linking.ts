// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Linking as RNLinking } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'

export const linking = {
  openURL(url: string) {
    if (Platform.OS === 'web') {
      window.open(url, '_blank', 'noopener,noreferrer')
    } else {
      RNLinking.openURL(url)
    }
  },

  canOpenURL(url: string): Promise<boolean> {
    if (Platform.OS === 'web') {
      return Promise.resolve(true)
    }
    return RNLinking.canOpenURL(url)
  },
}

/**
 * Open an external auth/OAuth flow and wait for the user to return.
 *
 * - Web: opens a centered popup and resolves when it closes.
 * - Native: opens a Chrome Custom Tab / SFSafariViewController via
 *   `openAuthSessionAsync` and auto-closes when the browser navigates
 *   to the app's `shogo://` deep-link scheme.
 */
export async function openAuthFlow(
  url: string,
  options?: { popup?: { width?: number; height?: number } },
): Promise<{ type: 'success' | 'cancel' | 'dismiss'; url?: string }> {
  if (Platform.OS === 'web') {
    const w = options?.popup?.width ?? 600
    const h = options?.popup?.height ?? 700
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2)
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2)
    const popup = window.open(
      url,
      'auth-flow',
      `width=${w},height=${h},left=${left},top=${top},popup=true`,
    )
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(interval)
          resolve({ type: 'success' })
        }
      }, 500)
      setTimeout(() => {
        clearInterval(interval)
        resolve({ type: 'cancel' })
      }, 120_000)
    })
  }

  const scheme = ExpoLinking.createURL('')
  return WebBrowser.openAuthSessionAsync(url, scheme)
}
