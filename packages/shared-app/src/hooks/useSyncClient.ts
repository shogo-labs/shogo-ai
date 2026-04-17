// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useSyncClient — React hook for Phase 2 real-time sync
 *
 * Connects to the sync WebSocket, applies incoming events to the MST
 * domain store, and provides sync status to the UI.
 *
 * Usage:
 *   const { status, offlineQueueSize } = useSyncClient({
 *     apiBaseUrl: 'https://studio.shogo.ai',
 *     workspaceId: 'ws_123',
 *     source: 'web',
 *     enabled: true,
 *   })
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  SyncClient,
  type SyncClientConfig,
  type SyncConnectionStatus,
  type SyncEvent,
} from '../services/sync-client'

export interface UseSyncClientOptions {
  apiBaseUrl: string
  workspaceId: string | undefined
  /** User ID — required for subscription scoping (prevents cross-user leakage) */
  userId: string | undefined
  source: 'web' | 'mobile' | 'desktop'
  instanceId?: string
  enabled?: boolean
  credentials?: RequestCredentials
  fetch?: typeof globalThis.fetch
  /** Called when a sync event is received — apply it to your store */
  onEvent?: (event: SyncEvent) => void
}

export interface UseSyncClientResult {
  /** Current WebSocket connection status */
  status: SyncConnectionStatus
  /** Number of events queued while offline */
  offlineQueueSize: number
  /** Publish a sync event to other clients */
  publishEvent: (event: Omit<SyncEvent, 'id' | 'timestamp' | 'source' | 'workspaceId'>) => void
  /** Force a catch-up sync via REST */
  catchUp: () => Promise<void>
  /** Manually reconnect */
  reconnect: () => void
}

export function useSyncClient(options: UseSyncClientOptions): UseSyncClientResult {
  const {
    apiBaseUrl,
    workspaceId,
    userId,
    source,
    instanceId,
    enabled = true,
    credentials,
    fetch: fetchFn,
    onEvent,
  } = options

  const [status, setStatus] = useState<SyncConnectionStatus>('disconnected')
  const [offlineQueueSize, setOfflineQueueSize] = useState(0)
  const clientRef = useRef<SyncClient | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  // Create/recreate client when config changes
  useEffect(() => {
    if (!enabled || !workspaceId || !userId) {
      clientRef.current?.disconnect()
      clientRef.current = null
      setStatus('disconnected')
      return
    }

    const config: SyncClientConfig = {
      apiBaseUrl,
      workspaceId,
      userId,
      source,
      instanceId,
      credentials,
      fetch: fetchFn,
    }

    const client = new SyncClient(config)
    clientRef.current = client

    const unsubEvent = client.onEvent((event) => {
      onEventRef.current?.(event)
    })

    const unsubStatus = client.onStatus((newStatus) => {
      setStatus(newStatus)
      setOfflineQueueSize(client.getOfflineQueueSize())
    })

    client.connect()

    return () => {
      unsubEvent()
      unsubStatus()
      client.disconnect()
      clientRef.current = null
    }
  }, [apiBaseUrl, workspaceId, userId, source, instanceId, enabled, credentials, fetchFn])

  const publishEvent = useCallback(
    (event: Omit<SyncEvent, 'id' | 'timestamp' | 'source' | 'workspaceId'>) => {
      clientRef.current?.publishEvent(event)
      setOfflineQueueSize(clientRef.current?.getOfflineQueueSize() ?? 0)
    },
    [],
  )

  const catchUp = useCallback(async () => {
    await clientRef.current?.catchUp()
  }, [])

  const reconnect = useCallback(() => {
    clientRef.current?.disconnect()
    clientRef.current?.connect()
  }, [])

  return {
    status,
    offlineQueueSize,
    publishEvent,
    catchUp,
    reconnect,
  }
}
