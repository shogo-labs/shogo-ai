// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useRemoteState — Unified hook for remote control state
 *
 * Combines the active instance context with the domain provider's remote
 * awareness to give components a single source of truth about:
 *   - Whether we're in remote mode
 *   - What instance we're connected to
 *   - Whether there's a remote error
 *   - The remote proxy base URL
 *
 * This hook is the recommended way for UI components to check remote state.
 *
 * Usage:
 *   const { isRemote, instanceName, remoteError, remoteProxyBaseUrl } = useRemoteState()
 *
 *   if (isRemote) {
 *     return <Banner>Connected to {instanceName}</Banner>
 *   }
 */

import { useMemo } from 'react'
import { computeRemoteProxyBaseUrl, useActiveInstance, type ActiveInstance } from './useActiveInstance'

export interface RemoteState {
  /** Whether a remote desktop instance is currently active */
  isRemote: boolean
  /** The active instance details (null if local) */
  instance: ActiveInstance | null
  /** Display name for the connected instance */
  instanceName: string
  /**
   * The transparent proxy base URL the SDKDomainProvider should use to
   * route stateful API calls through the tunnel.
   *
   * `null` for cli-worker instances even when `remoteAgentBaseUrl` is
   * set — see `computeRemoteProxyBaseUrl` for the decision matrix.
   */
  remoteProxyBaseUrl: string | null
  /** The transparent proxy base URL for agent requests (includes /api/projects/:id/agent-proxy) */
  remoteAgentBaseUrl: string | null
  /** Set a new active instance */
  setInstance: (inst: ActiveInstance) => void
  /** Disconnect from remote instance (back to local/cloud) */
  disconnect: () => void
}

export function useRemoteState(): RemoteState {
  const { instance, remoteAgentBaseUrl, setInstance, clearInstance } =
    useActiveInstance()

  return useMemo<RemoteState>(
    () => ({
      isRemote: !!instance,
      instance,
      instanceName: instance?.name ?? 'This device',
      remoteProxyBaseUrl: computeRemoteProxyBaseUrl(instance, remoteAgentBaseUrl),
      remoteAgentBaseUrl,
      setInstance,
      disconnect: clearInstance,
    }),
    [instance, remoteAgentBaseUrl, setInstance, clearInstance],
  )
}
