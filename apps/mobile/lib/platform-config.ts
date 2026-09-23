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
    /** Companion-shell rollout kill switch — see the API's `/api/config` handler. */
    personalShell: boolean
    /** Workspace Agent shell rollout; the runtime gate is checked separately. */
    agentShell: boolean
    /** Independently controls the narrow/native Workspace Agent shell. */
    mobileAgentShell: boolean
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
    personalShell: true,
    agentShell: false,
    mobileAgentShell: false,
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
    personalShell: true,
    agentShell: true,
    mobileAgentShell: true,
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
 * Workspace runtimes are the only supported runtime topology. The helper is
 * retained as a compatibility API for callers that still use the old rollout
 * check while the UI migration finishes.
 */
export function isWorkspaceRuntimeEnabled(): boolean {
  return true
}

/**
 * Whether the project page routes every chat tab through the project-pinned
 * workspace session. The pinned-session and "+ new chat" endpoints live under
 * `/api/local/projects`, which the API only mounts in local mode, so cloud
 * builds keep project-scoped chat for project tabs.
 */
export function isProjectWorkspaceRuntimeEnabled(): boolean {
  return isLocalMode()
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
    // Local UI development must not depend on a persisted hosted/admin
    // override. The execution runtime retains its own independent gate.
    cachedConfig = {
      ...data,
      localMode: data.localMode || isLocalMode(),
      features: {
        ...data.features,
        agentShell: data.localMode || isLocalMode() ? true : data.features.agentShell,
        mobileAgentShell: data.localMode || isLocalMode() ? true : data.features.mobileAgentShell,
      },
      configLoaded: true,
    }
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
