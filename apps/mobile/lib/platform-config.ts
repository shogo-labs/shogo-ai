// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect } from 'react'
import { Platform } from 'react-native'
import { PlatformApi } from '@shogo-ai/sdk'
import { createHttpClient } from './api'

export interface PlatformConfig {
  localMode: boolean
  needsSetup?: boolean
  shogoKeyConnected?: boolean
  configLoaded: boolean
  features: {
    billing: boolean
    admin: boolean
    oauth: boolean
    analytics: boolean
    publishing: boolean
  }
}

const CLOUD_CONFIG: PlatformConfig = {
  localMode: false,
  configLoaded: false,
  features: { billing: true, admin: true, oauth: true, analytics: true, publishing: true },
}

const LOCAL_CONFIG: PlatformConfig = {
  localMode: true,
  configLoaded: false,
  features: { billing: false, admin: false, oauth: false, analytics: false, publishing: false },
}

function isLocalMode(): boolean {
  if (process.env.EXPO_PUBLIC_LOCAL_MODE === 'true') return true
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.isDesktop
}

let cachedConfig: PlatformConfig | null = null

function getInitialConfig(): PlatformConfig {
  if (cachedConfig) return cachedConfig
  return isLocalMode() ? LOCAL_CONFIG : CLOUD_CONFIG
}

async function fetchConfig(): Promise<PlatformConfig> {
  if (cachedConfig?.configLoaded) return cachedConfig
  try {
    const platform = new PlatformApi(createHttpClient())
    const data = await platform.getConfig()
    cachedConfig = { ...data, configLoaded: true }
    return cachedConfig!
  } catch {}
  const fallback = getInitialConfig()
  cachedConfig = { ...fallback, configLoaded: true }
  return cachedConfig
}

export function usePlatformConfig(): PlatformConfig {
  const [config, setConfig] = useState<PlatformConfig>(getInitialConfig)

  useEffect(() => {
    fetchConfig().then(setConfig)
  }, [])

  return config
}

export function invalidatePlatformConfigCache() {
  cachedConfig = null
}
