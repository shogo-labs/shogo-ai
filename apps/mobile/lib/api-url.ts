// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import Constants from 'expo-constants'
import { Platform } from 'react-native'

const API_PORT = process.env.EXPO_PUBLIC_API_PORT ?? '8002'

/** LAN host of the machine running Metro (same host as the API in local dev). */
function inferDevMachineHost(): string | undefined {
  const go = (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig
  const raw = go?.debuggerHost ?? Constants.expoConfig?.hostUri
  if (!raw || typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/^exp:\/\//i, '').replace(/^https?:\/\//i, '')
  const host = cleaned.split(':')[0]?.trim()
  if (!host || host === 'localhost' || host === '127.0.0.1') return undefined
  return host
}

function nativeApiUrlWithoutEnv(): string {
  const lan = inferDevMachineHost()
  if (lan) return `http://${lan}:${API_PORT}`
  // Android emulator: host loopback. iOS simulator: localhost reaches the Mac.
  if (Platform.OS === 'android') return `http://10.0.2.2:${API_PORT}`
  return `http://localhost:${API_PORT}`
}

export const API_URL = (() => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const origin = window.location.origin
    const isIdeEmbed = new URLSearchParams(window.location.search).get('embed') === 'ide'
    if (isIdeEmbed) return origin

    const desktop = (window as Window & { shogoDesktop?: { apiUrl?: string } }).shogoDesktop
    if (desktop?.apiUrl) return desktop.apiUrl

    const envUrl = process.env.EXPO_PUBLIC_API_URL
    if (envUrl) return envUrl
    if (!origin.includes('localhost')) return origin
    return `http://localhost:${API_PORT}`
  }

  const envUrl = process.env.EXPO_PUBLIC_API_URL
  if (envUrl) return envUrl

  return nativeApiUrlWithoutEnv()
})()
