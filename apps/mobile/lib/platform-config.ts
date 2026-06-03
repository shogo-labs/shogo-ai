// SPDX-License-Identifier: MIT
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
    marketplace: boolean
    ezMode: boolean
    phoneChannel: boolean
  }
}

const CLOUD_CONFIG: PlatformConfig = {
  localMode: false,
  configLoaded: false,
  features: {
    billing: true,
    admin: true,
    oauth: true,
    analytics: true,
    publishing: true,
    marketplace: true,
    ezMode: true,
    phoneChannel: true,
  },
}

const LOCAL_CONFIG: PlatformConfig = {
  localMode: true,
  configLoaded: false,
  features: {
    billing: false,
    admin: false,
    oauth: false,
    analytics: true,
    publishing: false,
    marketplace: false,
    ezMode: true,
    phoneChannel: false,
  },
}

function isLocalMode(): boolean {
  if (process.env.EXPO_PUBLIC_LOCAL_MODE === 'true') return true
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.isDesktop
}

/**
 * Whether the client should route new "home" chats through the
 * workspace-aware (merged-root) runtime — a workspace-scoped chat session
 * with the project attached — instead of the per-project runtime.
 *
 * Opt-in via `EXPO_PUBLIC_WORKSPACE_RUNTIME=true`. The API independently
 * gates the actual runtime behind `SHOGO_WORKSPACE_RUNTIME` (workspace chat
 * returns 501 when that's off), so BOTH must agree for workspace chat to
 * function. Default off preserves the existing per-project create flow.
 */
export function isWorkspaceRuntimeEnabled(): boolean {
  return process.env.EXPO_PUBLIC_WORKSPACE_RUNTIME === 'true'
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
