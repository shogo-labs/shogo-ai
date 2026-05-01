// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useDynamicAppStream
 *
 * Local-state hook for dynamic app surfaces. Maintains a client-side surfaces
 * Map and exposes `applyMessage` for callers to drive surface mutations from
 * any source (e.g. local edit-mode previews). Also exposes `dispatchAction`
 * and `updateLocalData` for action POST + optional persist back to the agent.
 *
 * Note: this hook no longer subscribes to `/agent/canvas/stream`. That endpoint
 * is now a workspace-files event stream (init / reload / file.changed /
 * file.deleted) and never emits the dynamic-app surface messages this hook
 * understood. Surface population is now driven entirely by callers via
 * `applyMessage`.
 */

import { useState, useCallback } from 'react'
import type {
  SurfaceState,
  ComponentDefinition,
  DynamicAppMessage,
  ActionEvent,
  ApiModelInfo,
} from './types'
import { setByPointer } from './pointer'

export interface DynamicAppStreamState {
  surfaces: Map<string, SurfaceState>
  connected: boolean
  connecting: boolean
  error: string | null
}

export interface DynamicAppStreamOptions {
  /** Retained for ABI stability; ignored now that the SSE connection is gone. */
  headers?: () => Record<string, string>
  /** Retained for ABI stability; ignored now that the SSE connection is gone. */
  withCredentials?: boolean
}

export function useDynamicAppStream(agentUrl: string | null, _options?: DynamicAppStreamOptions) {
  const [surfaces, setSurfaces] = useState<Map<string, SurfaceState>>(new Map())
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null)

  const applyMessage = useCallback((msg: DynamicAppMessage) => {
    if (msg.type === 'clearAll') {
      setActiveSurfaceId(null)
    }

    setSurfaces((prev) => {
      const next = new Map(prev)
      const now = new Date().toISOString()

      switch (msg.type) {
        case 'createSurface': {
          if (!next.has(msg.surfaceId)) {
            setActiveSurfaceId(msg.surfaceId)
            next.set(msg.surfaceId, {
              surfaceId: msg.surfaceId,
              title: msg.title,
              theme: msg.theme,
              components: new Map(),
              dataModel: {},
              createdAt: now,
              updatedAt: now,
            })
          }
          break
        }
        case 'updateComponents': {
          let surface = next.get(msg.surfaceId)
          if (!surface) {
            surface = {
              surfaceId: msg.surfaceId,
              components: new Map(),
              dataModel: {},
              createdAt: now,
              updatedAt: now,
            }
            next.set(msg.surfaceId, surface)
          }
          const updatedComponents = msg.merge ? new Map(surface.components) : new Map<string, ComponentDefinition>()
          for (const comp of msg.components) {
            updatedComponents.set(comp.id, comp)
          }
          next.set(msg.surfaceId, {
            ...surface,
            components: updatedComponents,
            updatedAt: now,
          })
          break
        }
        case 'updateData': {
          const surface = next.get(msg.surfaceId)
          if (surface) {
            let newDataModel: Record<string, unknown>
            if (!msg.path || msg.path === '/') {
              newDataModel = (typeof msg.value === 'object' && msg.value !== null && !Array.isArray(msg.value))
                ? { ...(msg.value as Record<string, unknown>) }
                : surface.dataModel
            } else {
              newDataModel = { ...surface.dataModel }
              setByPointer(newDataModel, msg.path, msg.value)
            }
            next.set(msg.surfaceId, {
              ...surface,
              dataModel: newDataModel,
              updatedAt: now,
            })
          }
          break
        }
        case 'deleteSurface': {
          next.delete(msg.surfaceId)
          break
        }
        case 'deleteComponents': {
          const surface = next.get(msg.surfaceId)
          if (surface) {
            const updatedComponents = new Map(surface.components)
            for (const id of msg.componentIds) {
              updatedComponents.delete(id)
            }
            next.set(msg.surfaceId, {
              ...surface,
              components: updatedComponents,
              updatedAt: now,
            })
          }
          break
        }
        case 'configureApi': {
          const surface = next.get(msg.surfaceId)
          if (surface) {
            next.set(msg.surfaceId, {
              ...surface,
              apiModels: msg.models as ApiModelInfo[],
              updatedAt: now,
            })
          }
          break
        }
        case 'clearAll': {
          next.clear()
          break
        }
      }

      return next
    })
  }, [])

  const dispatchAction = useCallback(
    async (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      if (!agentUrl) return

      try {
        await fetch(`${agentUrl}/agent/canvas/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            surfaceId,
            name,
            context,
            timestamp: new Date().toISOString(),
          } satisfies ActionEvent),
        })
      } catch (err) {
        console.error('[DynamicApp] Failed to dispatch action:', err)
      }
    },
    [agentUrl],
  )

  const updateLocalData = useCallback(
    (surfaceId: string, path: string, value: unknown, options?: { persist?: boolean }) => {
      setSurfaces((prev) => {
        const surface = prev.get(surfaceId)
        if (!surface) return prev
        const next = new Map(prev)
        const newDataModel = { ...surface.dataModel }
        setByPointer(newDataModel, path, value)
        next.set(surfaceId, { ...surface, dataModel: newDataModel, updatedAt: new Date().toISOString() })
        return next
      })
      setActiveSurfaceId(surfaceId)

      if (options?.persist && agentUrl) {
        fetch(`${agentUrl}/agent/canvas/data-change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surfaceId, path, value }),
        }).catch((err) => {
          console.error('[DynamicApp] Failed to persist data change:', err)
        })
      }
    },
    [agentUrl],
  )

  const reconnect = useCallback(() => {
    setSurfaces(new Map())
    setActiveSurfaceId(null)
  }, [])

  return {
    surfaces,
    activeSurfaceId,
    setActiveSurfaceId,
    connected: true,
    connecting: false,
    error: null as string | null,
    dispatchAction,
    updateLocalData,
    reconnect,
    applyMessage,
  }
}
