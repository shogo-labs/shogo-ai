/**
 * useDynamicAppStream
 *
 * React hook that connects to the agent runtime's SSE endpoint for dynamic
 * app messages. Maintains client-side surface state and provides an action
 * dispatch function for user interactions.
 *
 * Platform-agnostic: uses EventSource (available in browsers and Expo Web).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  SurfaceState,
  DynamicAppMessage,
  ActionEvent,
  ApiModelInfo,
} from './types'
import { setByPointer } from './pointer'

const INITIAL_STATE_TIMEOUT_MS = 5_000

export interface DynamicAppStreamState {
  surfaces: Map<string, SurfaceState>
  connected: boolean
  connecting: boolean
  error: string | null
}

export function useDynamicAppStream(agentUrl: string | null) {
  const [surfaces, setSurfaces] = useState<Map<string, SurfaceState>>(new Map())
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const initialStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const receivedFirstMessage = useRef(false)

  const applyMessage = useCallback((msg: DynamicAppMessage) => {
    setSurfaces((prev) => {
      const next = new Map(prev)
      const now = new Date().toISOString()

      switch (msg.type) {
        case 'createSurface': {
          if (!next.has(msg.surfaceId)) {
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
          const surface = next.get(msg.surfaceId)
          if (surface) {
            const updatedComponents = new Map(surface.components)
            for (const comp of msg.components) {
              updatedComponents.set(comp.id, comp)
            }
            next.set(msg.surfaceId, {
              ...surface,
              components: updatedComponents,
              updatedAt: now,
            })
          }
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
      }

      return next
    })
  }, [])

  const connect = useCallback(() => {
    if (!agentUrl) return

    setConnecting(true)
    receivedFirstMessage.current = false

    const url = `${agentUrl}/agent/dynamic-app/stream`
    const es = new EventSource(url)
    eventSourceRef.current = es

    if (initialStateTimerRef.current) clearTimeout(initialStateTimerRef.current)
    initialStateTimerRef.current = setTimeout(() => {
      if (!receivedFirstMessage.current) {
        setConnected(true)
        setConnecting(false)
      }
    }, INITIAL_STATE_TIMEOUT_MS)

    es.onopen = () => {
      setConnected(true)
      setError(null)
      reconnectAttemptRef.current = 0
    }

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as DynamicAppMessage
        if (!receivedFirstMessage.current) {
          receivedFirstMessage.current = true
          setConnecting(false)
          if (initialStateTimerRef.current) {
            clearTimeout(initialStateTimerRef.current)
            initialStateTimerRef.current = null
          }
        }
        applyMessage(msg)
      } catch {
        // Ignore parse errors (e.g. heartbeat comments)
      }
    }

    es.onerror = () => {
      es.close()
      eventSourceRef.current = null
      setConnected(false)
      setConnecting(false)

      const attempt = reconnectAttemptRef.current++
      const delay = Math.min(1000 * Math.pow(2, attempt), 30_000)

      if (attempt >= 3) {
        setError('Reconnecting...')
      }

      reconnectTimeoutRef.current = setTimeout(connect, delay)
    }
  }, [agentUrl, applyMessage])

  useEffect(() => {
    connect()

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (initialStateTimerRef.current) {
        clearTimeout(initialStateTimerRef.current)
        initialStateTimerRef.current = null
      }
    }
  }, [connect])

  const dispatchAction = useCallback(
    async (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      if (!agentUrl) return

      try {
        await fetch(`${agentUrl}/agent/dynamic-app/action`, {
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
    (surfaceId: string, path: string, value: unknown) => {
      setSurfaces((prev) => {
        const surface = prev.get(surfaceId)
        if (!surface) return prev
        const next = new Map(prev)
        const newDataModel = { ...surface.dataModel }
        setByPointer(newDataModel, path, value)
        next.set(surfaceId, { ...surface, dataModel: newDataModel, updatedAt: new Date().toISOString() })
        return next
      })
    },
    [],
  )

  return { surfaces, connected, connecting, error, dispatchAction, updateLocalData }
}
