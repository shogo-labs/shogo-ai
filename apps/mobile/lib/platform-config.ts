import { useState, useEffect } from 'react'
import { Platform } from 'react-native'
import { API_URL } from './api'

export interface PlatformConfig {
  localMode: boolean
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
  features: { billing: true, admin: true, oauth: true, analytics: true, publishing: true },
}

const LOCAL_CONFIG: PlatformConfig = {
  localMode: true,
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
  if (isLocalMode()) {
    cachedConfig = LOCAL_CONFIG
    return LOCAL_CONFIG
  }
  return CLOUD_CONFIG
}

async function fetchConfig(): Promise<PlatformConfig> {
  if (cachedConfig) return cachedConfig
  try {
    const res = await fetch(`${API_URL}/api/config`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      cachedConfig = await res.json()
      return cachedConfig!
    }
  } catch {}
  return getInitialConfig()
}

export function usePlatformConfig(): PlatformConfig {
  const [config, setConfig] = useState<PlatformConfig>(getInitialConfig)

  useEffect(() => {
    fetchConfig().then(setConfig)
  }, [])

  return config
}
