// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { useActiveInstance } from './useActiveInstance'

export interface RemoteState {
  /** Whether a remote desktop instance is currently active */
  isRemote: boolean
  /** The active instance details (null if local) */
  instance: {
    instanceId: string
    name: string
    hostname: string
    workspaceId: string
  } | null
  /** Display name for the connected instance */
  instanceName: string
  /** The transparent proxy base URL for routing API requests */
  remoteProxyBaseUrl: string | null
  /** The transparent proxy base URL for agent requests (includes /api/projects/:id/agent-proxy) */
  remoteAgentBaseUrl: string | null
  /** Set a new active instance */
  setInstance: (inst: {
    instanceId: string
    name: string
    hostname: string
    workspaceId: string
  }) => void
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
      remoteProxyBaseUrl: remoteAgentBaseUrl
        ? // remoteAgentBaseUrl is `${apiUrl}/api/instances/${id}/p`
          // which is exactly what SDKDomainProvider needs
          remoteAgentBaseUrl
        : null,
      remoteAgentBaseUrl,
      setInstance,
      disconnect: clearInstance,
    }),
    [instance, remoteAgentBaseUrl, setInstance, clearInstance],
  )
}
