// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatBridge — the small in-memory bus that lets the Shogo Mode overlay
 * drive the real `ChatPanel` without the two components having to know
 * about each other.
 *
 * Shape:
 *   - `send(text)`                — send a user message to the chat agent.
 *   - `setMode(mode)`             — switch between 'agent' / 'plan'.
 *   - `subscribeToAssistant(fn)`  — fire `fn(text)` once per finalized
 *                                   assistant message (de-duped by id).
 *
 * `ChatPanel` calls `useChatBridgeRegistrar({ send, setMode, emitAssistant })`
 * at mount to wire its real implementations into the bridge. Any sibling
 * component can then `const bridge = useChatBridge()` and call those
 * methods imperatively.
 *
 * The bridge intentionally does not expose message *state* — `ChatPanel`
 * remains the single source of truth. Subscribers only see final assistant
 * texts as they complete, which is enough for the translator to narrate.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export type ChatInteractionMode = 'agent' | 'plan'

export interface ChatBridgeApi {
  send: (text: string) => void
  setMode: (mode: ChatInteractionMode) => void
  subscribeToAssistant: (listener: (text: string) => void) => () => void
  /**
   * Whether Shogo Mode (the in-panel voice + text translator) is currently
   * replacing the chat panel UI. When `true`, the normal `ChatPanel` stays
   * mounted beneath but is visually hidden.
   */
  shogoModeActive: boolean
  setShogoModeActive: (active: boolean) => void
  toggleShogoMode: () => void
}

interface BridgeInternals {
  sendImpl: ((text: string) => void) | null
  setModeImpl: ((mode: ChatInteractionMode) => void) | null
  listeners: Set<(text: string) => void>
}

const ChatBridgeContext = createContext<{
  api: ChatBridgeApi
  internals: BridgeInternals
} | null>(null)

export function ChatBridgeProvider({ children }: { children: React.ReactNode }) {
  const internalsRef = useRef<BridgeInternals>({
    sendImpl: null,
    setModeImpl: null,
    listeners: new Set(),
  })
  const [shogoModeActive, setShogoModeActive] = useState(false)
  const toggleShogoMode = useCallback(() => setShogoModeActive((v) => !v), [])

  const api = useMemo<ChatBridgeApi>(
    () => ({
      send: (text: string) => {
        const fn = internalsRef.current.sendImpl
        if (!fn) {
          console.warn('[ChatBridge] send() called before ChatPanel registered')
          return
        }
        fn(text)
      },
      setMode: (mode: ChatInteractionMode) => {
        const fn = internalsRef.current.setModeImpl
        if (!fn) {
          console.warn('[ChatBridge] setMode() called before ChatPanel registered')
          return
        }
        fn(mode)
      },
      subscribeToAssistant: (listener) => {
        internalsRef.current.listeners.add(listener)
        return () => {
          internalsRef.current.listeners.delete(listener)
        }
      },
      shogoModeActive,
      setShogoModeActive,
      toggleShogoMode,
    }),
    [shogoModeActive, toggleShogoMode],
  )

  const value = useMemo(
    () => ({ api, internals: internalsRef.current }),
    [api],
  )

  return (
    <ChatBridgeContext.Provider value={value}>{children}</ChatBridgeContext.Provider>
  )
}

/** Consumer hook — call from any component that wants to drive the chat. */
export function useChatBridge(): ChatBridgeApi {
  const ctx = useContext(ChatBridgeContext)
  if (!ctx) {
    throw new Error('useChatBridge must be used inside <ChatBridgeProvider>')
  }
  return ctx.api
}

/**
 * Optional consumer hook — returns `null` when no provider is mounted,
 * so features can degrade gracefully instead of throwing.
 */
export function useChatBridgeOptional(): ChatBridgeApi | null {
  return useContext(ChatBridgeContext)?.api ?? null
}

export interface RegistrarArgs {
  send: (text: string) => void
  setMode: (mode: ChatInteractionMode) => void
}

/**
 * Registrar hook — used inside `ChatPanel` to publish its real
 * implementations. Returns an `emitAssistant(text)` callback the host
 * should invoke once per finalized assistant message so subscribers get
 * the paraphrased text.
 */
export function useChatBridgeRegistrar({ send, setMode }: RegistrarArgs): {
  emitAssistant: (text: string) => void
} {
  const ctx = useContext(ChatBridgeContext)

  useEffect(() => {
    if (!ctx) return
    ctx.internals.sendImpl = send
    ctx.internals.setModeImpl = setMode
    return () => {
      if (ctx.internals.sendImpl === send) ctx.internals.sendImpl = null
      if (ctx.internals.setModeImpl === setMode) ctx.internals.setModeImpl = null
    }
  }, [ctx, send, setMode])

  const emitAssistant = useCallback(
    (text: string) => {
      if (!ctx) return
      const trimmed = text?.trim?.() ?? ''
      if (!trimmed) return
      for (const listener of ctx.internals.listeners) {
        try {
          listener(trimmed)
        } catch (err) {
          console.warn('[ChatBridge] listener threw', err)
        }
      }
    },
    [ctx],
  )

  return { emitAssistant }
}
