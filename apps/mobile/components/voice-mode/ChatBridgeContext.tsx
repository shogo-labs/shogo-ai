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
  useSyncExternalStore,
} from 'react'
import type { ToolCallData } from '../chat/tools/types'

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
  /**
   * Resolved agent runtime base URL. Surfaced through the bridge so
   * subagent-aware UI (e.g. SubagentCard's live browser preview, the
   * Shogo overlay) can subscribe to runtime endpoints without depending
   * on the ChatContext which is only available beneath ChatPanel.
   */
  agentUrl: string | null
  /**
   * One-shot signal: when set, the Shogo Mode panel should auto-connect
   * its voice session as soon as it mounts. Consumers must call
   * `consumeAutoStartVoice()` exactly once to read and clear the flag —
   * the bridge guarantees `true` is returned at most once per provider.
   */
  consumeAutoStartVoice: () => boolean
  /**
   * `useSyncExternalStore` plumbing for the subagent (`task` /
   * `agent_spawn`) tool-call snapshot published by `ChatPanel`. The
   * Shogo overlay subscribes to this snapshot and renders one
   * `<SubagentCard>` per entry, reusing the same card component the
   * technical chat shows. Most consumers should use the
   * `useSubagentCards()` hook instead of these directly.
   */
  subscribeSubagentCards: (fn: () => void) => () => void
  getSubagentCardsSnapshot: () => ToolCallData[]
}

/**
 * Snapshot of `task` / `agent_spawn` tool calls from the technical
 * agent's message thread, exposed to non-chat surfaces (Shogo Mode)
 * so they can render the same `<SubagentCard>` UI without owning any
 * AI SDK message state. Updated by `ChatPanel` whenever its message
 * list changes via `setSubagentCards`.
 */
interface SubagentCardsSnapshot {
  cards: ToolCallData[]
  /** Bumps every time the snapshot identity changes; safe to use as a memo key. */
  version: number
}

interface BridgeInternals {
  sendImpl: ((text: string) => void) | null
  setModeImpl: ((mode: ChatInteractionMode) => void) | null
  listeners: Set<(event: AgentEvent) => void>
  subagentCardsSnapshot: SubagentCardsSnapshot
  subagentCardsListeners: Set<() => void>
}

const ChatBridgeContext = createContext<{
  api: ChatBridgeApi
  internals: BridgeInternals
} | null>(null)

export interface ChatBridgeProviderProps {
  /** Currently active chat session id — used for per-session persistence. */
  chatSessionId?: string | null
  /**
   * Resolved agent runtime base URL. Threaded through the bridge so
   * subagent UI (e.g. live browser preview) can subscribe to runtime
   * endpoints from any surface without piggybacking on ChatContext.
   */
  agentUrl?: string | null
  /**
   * Initial value for `shogoModeActive`. When `true`, Shogo Mode is on
   * from first render so the overlay mounts before any user gesture.
   * Used by the homepage → project navigation when the user clicks the
   * mic to start voice project creation.
   */
  initialShogoModeActive?: boolean
  /**
   * One-shot: request that the Shogo Mode panel auto-connect its voice
   * session on mount. The flag is consumed (and cleared) on the first
   * read via `consumeAutoStartVoice()` from the bridge api.
   */
  initialAutoStartVoice?: boolean
  children: React.ReactNode
}

export function ChatBridgeProvider({
  chatSessionId = null,
  agentUrl = null,
  initialShogoModeActive = false,
  initialAutoStartVoice = false,
  children,
}: ChatBridgeProviderProps) {
  const internalsRef = useRef<BridgeInternals>({
    sendImpl: null,
    setModeImpl: null,
    listeners: new Set(),
    subagentCardsSnapshot: { cards: [], version: 0 },
    subagentCardsListeners: new Set(),
  })
  const [shogoModeActive, setShogoModeActiveState] = useState(initialShogoModeActive)
  const [shogoPeekActive, setShogoPeekActiveState] = useState(false)
  const autoStartVoiceRef = useRef<boolean>(initialAutoStartVoice)

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

  const consumeAutoStartVoice = useCallback(() => {
    if (!autoStartVoiceRef.current) return false
    autoStartVoiceRef.current = false
    return true
  }, [])

  const subscribeSubagentCards = useCallback((fn: () => void) => {
    internalsRef.current.subagentCardsListeners.add(fn)
    return () => {
      internalsRef.current.subagentCardsListeners.delete(fn)
    }
  }, [])
  const getSubagentCardsSnapshot = useCallback(
    () => internalsRef.current.subagentCardsSnapshot.cards,
    [],
  )

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
      agentUrl,
      consumeAutoStartVoice,
      subscribeSubagentCards,
      getSubagentCardsSnapshot,
    }),
    [
      shogoModeActive,
      setShogoModeActive,
      toggleShogoMode,
      shogoPeekActive,
      setShogoPeekActive,
      chatSessionId,
      agentUrl,
      consumeAutoStartVoice,
      subscribeSubagentCards,
      getSubagentCardsSnapshot,
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

/**
 * Subscribe to the subagent card snapshot published by `ChatPanel` via
 * the bridge. Returns the current `ToolCallData[]` for `task` /
 * `agent_spawn` tool calls and re-renders the caller whenever the
 * snapshot changes. Returns an empty array when no provider is mounted
 * so callers can render unconditionally.
 */
export function useSubagentCards(): ToolCallData[] {
  const ctx = useContext(ChatBridgeContext)
  // Stable no-op fallbacks so the hook can be called unconditionally
  // even without a provider (e.g. in tests or the legacy chat panel).
  const fallbackSubscribe = React.useCallback(() => () => {}, [])
  const fallbackEmpty = React.useRef<ToolCallData[]>([]).current
  const fallbackSnapshot = React.useCallback(() => fallbackEmpty, [fallbackEmpty])
  return useSyncExternalStore(
    ctx?.api.subscribeSubagentCards ?? fallbackSubscribe,
    ctx?.api.getSubagentCardsSnapshot ?? fallbackSnapshot,
    ctx?.api.getSubagentCardsSnapshot ?? fallbackSnapshot,
  )
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
  /**
   * Publish the latest snapshot of subagent (`task` / `agent_spawn`)
   * tool calls. The Shogo overlay subscribes to this snapshot and
   * renders one `<SubagentCard>` per entry. Reference equality of the
   * `cards` array is preserved when the input is identical, so the
   * overlay only re-renders when something actually changed.
   */
  setSubagentCards: (cards: ToolCallData[]) => void
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

  const setSubagentCards = useCallback<RegistrarEmitters['setSubagentCards']>(
    (cards) => {
      if (!ctx) return
      const internals = ctx.internals
      const prev = internals.subagentCardsSnapshot.cards
      // Skip if we're publishing an empty snapshot and the previous
      // snapshot was also empty — saves a notify when ChatPanel runs
      // its publish effect on an idle session.
      if (prev === cards) return
      if (prev.length === 0 && cards.length === 0) return
      // Cheap reference / shallow-by-id-and-state equality check so we
      // don't churn re-renders when ChatPanel re-derives an equivalent
      // tool list on every messages update.
      if (prev === cards) return
      if (prev.length === cards.length) {
        let same = true
        for (let i = 0; i < prev.length; i++) {
          const a = prev[i]
          const b = cards[i]
          if (a === b) continue
          if (
            a.id === b.id &&
            a.toolName === b.toolName &&
            a.state === b.state &&
            a.result === b.result &&
            a.error === b.error &&
            a.args === b.args
          ) {
            continue
          }
          same = false
          break
        }
        if (same) return
      }
      internals.subagentCardsSnapshot = {
        cards,
        version: internals.subagentCardsSnapshot.version + 1,
      }
      for (const listener of internals.subagentCardsListeners) {
        try {
          listener()
        } catch (err) {
          console.warn('[ChatBridge] subagent cards listener threw', err)
        }
      }
    },
    [ctx],
  )

  return { emitTurnStart, emitToolActivity, emitTurnEnd, setSubagentCards }
}
