// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Linking, Platform } from 'react-native'
import * as ExpoLinking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'

const WEB_BASE = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'

export async function openWebAppSession(path: string): Promise<void> {
  const url = `${WEB_BASE}${path.startsWith('/') ? path : `/${path}`}`

  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.location.href = url
    }
    return
  }

  const scheme = ExpoLinking.createURL('')
  try {
    await WebBrowser.openAuthSessionAsync(url, scheme)
  } catch (err) {
    console.warn('[openWebAppSession] auth session failed, falling back to Linking:', err)
    await Linking.openURL(url)
  }
}
