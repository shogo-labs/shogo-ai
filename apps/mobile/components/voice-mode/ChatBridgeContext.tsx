// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatBridge — the small in-memory bus that lets the Shogo Mode overlay
 * drive the real `ChatPanel` without the two components having to know
 * about each other.
 *
 * Shape:
 *   - `send(text)`         — send a user message to the chat agent.
 *   - `setMode(mode)`      — switch between 'agent' / 'plan' / 'ask'.
 *   - `subscribe(fn)`      — receive a typed stream of agent events
 *                            (`turn-start`, `tool-activity`, `turn-end`).
 *
 * `ChatPanel` calls `useChatBridgeRegistrar({ send, setMode })` at mount
 * to wire its real implementations into the bridge. The registrar
 * returns `emitTurnStart`, `emitToolActivity`, and `emitTurnEnd` helpers
 * the host invokes at the appropriate lifecycle points.
 *
 * The bridge intentionally does not expose message *state* — `ChatPanel`
 * remains the single source of truth. Subscribers only see the lifecycle
 * events as they happen, which is enough for the translator to narrate /
 * summarise.
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

export type ChatInteractionMode = 'agent' | 'plan' | 'ask'

/**
 * Agent-side lifecycle events broadcast through the bridge.
 *
 *   - `turn-start`     : the user just submitted a message; the technical
 *                        agent has (or will imminently) start a turn.
 *   - `tool-activity`  : a tool invocation transitioned state during a
 *                        streaming turn. `phase: 'start'` when the agent
 *                        first calls the tool; `phase: 'end'` when a
 *                        result is available. `label` is a short human
 *                        summary (e.g. "editing Header.tsx") — never
 *                        a raw tool name or file path.
 *   - `turn-end`       : the assistant finished its turn. `finalText` is
 *                        the final paraphrasable reply (may be empty).
 */
export type AgentEvent =
  | { type: 'turn-start' }
  | {
      type: 'tool-activity'
      toolName: string
      phase: 'start' | 'end'
      label: string
      ok?: boolean
    }
  | { type: 'turn-end'; finalText: string }

export interface ChatBridgeApi {
  send: (text: string) => void
  setMode: (mode: ChatInteractionMode) => void
  /** Subscribe to the typed lifecycle event stream. Returns an unsubscribe. */
  subscribe: (listener: (event: AgentEvent) => void) => () => void
  /**
   * Whether Shogo Mode (the in-panel voice + text translator) is currently
   * replacing the chat panel UI. When `true`, the normal `ChatPanel` stays
   * mounted beneath but is visually hidden.
   */
  shogoModeActive: boolean
  setShogoModeActive: (active: boolean) => void
  toggleShogoMode: () => void
  /**
   * "Peek" state — when Shogo Mode is active and the user has tapped the
   * peek button, the Shogo overlay is hidden (opacity 0 / no pointer
   * events) so the underlying `ChatPanel` is visible and interactive.
   * The voice session + translator thread keep running in the background.
   * Resets to `false` whenever `shogoModeActive` flips off.
   */
  shogoPeekActive: boolean
  setShogoPeekActive: (active: boolean) => void
  /**
   * The id of the chat session the bridge is currently bound to. Shogo
   * Mode uses this id to scope its thread to the active session —
   * hydration reads `/api/chat-messages?sessionId=<id>&agent=voice` and
   * writes are POSTed to `/api/voice/*?chatSessionId=<id>`.
   */
  chatSessionId: string | null
}

interface BridgeInternals {
  sendImpl: ((text: string) => void) | null
  setModeImpl: ((mode: ChatInteractionMode) => void) | null
  listeners: Set<(event: AgentEvent) => void>
}

const ChatBridgeContext = createContext<{
  api: ChatBridgeApi
  internals: BridgeInternals
} | null>(null)

export interface ChatBridgeProviderProps {
  /** Currently active chat session id — used for per-session persistence. */
  chatSessionId?: string | null
  children: React.ReactNode
}

export function ChatBridgeProvider({ chatSessionId = null, children }: ChatBridgeProviderProps) {
  const internalsRef = useRef<BridgeInternals>({
    sendImpl: null,
    setModeImpl: null,
    listeners: new Set(),
  })
  const [shogoModeActive, setShogoModeActiveState] = useState(false)
  const [shogoPeekActive, setShogoPeekActiveState] = useState(false)

  const setShogoModeActive = useCallback((active: boolean) => {
    setShogoModeActiveState(active)
    if (!active) {
      setShogoPeekActiveState(false)
    }
  }, [])

  const toggleShogoMode = useCallback(() => {
    setShogoModeActiveState((v) => {
      const next = !v
      if (!next) setShogoPeekActiveState(false)
      return next
    })
  }, [])

  const setShogoPeekActive = useCallback((active: boolean) => {
    setShogoPeekActiveState(active)
  }, [])

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
      subscribe: (listener) => {
        internalsRef.current.listeners.add(listener)
        return () => {
          internalsRef.current.listeners.delete(listener)
        }
      },
      shogoModeActive,
      setShogoModeActive,
      toggleShogoMode,
      shogoPeekActive,
      setShogoPeekActive,
      chatSessionId,
    }),
    [
      shogoModeActive,
      setShogoModeActive,
      toggleShogoMode,
      shogoPeekActive,
      setShogoPeekActive,
      chatSessionId,
    ],
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

export interface RegistrarEmitters {
  /** Fire before handing a new user message to the agent runtime. */
  emitTurnStart: () => void
  /**
   * Fire when a tool invocation enters (`phase: 'start'`) or leaves
   * (`phase: 'end'`) a running state during a streaming turn.
   */
  emitToolActivity: (args: {
    toolName: string
    phase: 'start' | 'end'
    label: string
    ok?: boolean
  }) => void
  /** Fire once per finalized assistant message (mirrors the old emitAssistant). */
  emitTurnEnd: (finalText: string) => void
}

/**
 * Registrar hook — used inside `ChatPanel` to publish its real
 * implementations. Returns emitter helpers the host should call at the
 * corresponding lifecycle points so subscribers see the typed event
 * stream.
 */
export function useChatBridgeRegistrar({ send, setMode }: RegistrarArgs): RegistrarEmitters {
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

  const emit = useCallback(
    (event: AgentEvent) => {
      if (!ctx) return
      for (const listener of ctx.internals.listeners) {
        try {
          listener(event)
        } catch (err) {
          console.warn('[ChatBridge] listener threw', err)
        }
      }
    },
    [ctx],
  )

  const emitTurnStart = useCallback(() => emit({ type: 'turn-start' }), [emit])

  const emitToolActivity = useCallback<RegistrarEmitters['emitToolActivity']>(
    ({ toolName, phase, label, ok }) =>
      emit({ type: 'tool-activity', toolName, phase, label, ok }),
    [emit],
  )

  const emitTurnEnd = useCallback(
    (finalText: string) => {
      const trimmed = finalText?.trim?.() ?? ''
      emit({ type: 'turn-end', finalText: trimmed })
    },
    [emit],
  )

  return { emitTurnStart, emitToolActivity, emitTurnEnd }
}
