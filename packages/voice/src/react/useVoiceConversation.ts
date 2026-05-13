// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useVoiceConversation` (web) — drop-in React hook wrapping
 * `@elevenlabs/react`'s `useConversation` with batteries included:
 *
 *   1. Fetches a signed URL from the consumer's server (default: `/api/voice/signed-url`).
 *   2. Registers the canonical `add_memory` client tool (POST-es to `/api/memory/add`).
 *   3. Auto-injects relevant memory as a contextual update on each user message
 *      (POST `/api/memory/retrieve`).
 *   4. Accumulates a plain-text transcript and calls `onTranscript` on disconnect,
 *      plus a `pagehide` `navigator.sendBeacon` fallback so nothing is lost on
 *      tab close.
 *
 * Consumers can mix in additional `clientTools` and override every path.
 *
 * Requires the caller's app to have `@elevenlabs/react` installed (optional
 * peer dependency). For React Native, import from
 * `@shogo-ai/sdk/voice/native` instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
// `@elevenlabs/react` is an optional peer dep. The import is a type-only path
// at compile time; at runtime the host app must have it installed.
import { useConversation } from '@elevenlabs/react'
import {
  appendTranscriptLine,
  buildSessionPayload,
  createMemoryAddTool,
  createMemoryContextInjector,
  createPostJson,
  createTranscriptDisconnectHandler,
  fetchSignedUrl,
  withProjectQuery,
  type BaseVoiceConversationOptions,
  type BaseVoiceConversationResult,
  type ClientToolFn,
} from '../shared/index.js'

export type UseVoiceConversationOptions = BaseVoiceConversationOptions
export type UseVoiceConversationResult = BaseVoiceConversationResult

/**
 * Hook that owns the voice session lifecycle end-to-end. See module docblock
 * for the wire format of the various server endpoints.
 */
export function useVoiceConversation(
  options: UseVoiceConversationOptions,
): UseVoiceConversationResult {
  const {
    characterName,
    signedUrlPath = '/api/voice/signed-url',
    memoryAddPath = '/api/memory/add',
    memoryRetrievePath = '/api/memory/retrieve',
    transcriptIngestPath = '/api/memory/ingest',
    autoInjectMemory = true,
    includeMemoryTool = true,
    clientTools = {},
    onTranscript,
    shogoApiKey,
    projectId,
    agentName,
    fetchCredentials = shogoApiKey ? 'omit' : 'same-origin',
    onError,
    onMessage,
    conversationId: optionConversationId,
    dynamicVariables,
  } = options

  const authHeaders = useCallback((): Record<string, string> => {
    return shogoApiKey ? { authorization: `Bearer ${shogoApiKey}` } : {}
  }, [shogoApiKey])

  const resolvedSignedUrlPath = withProjectQuery(signedUrlPath, { projectId, agentName })

  const transcriptRef = useRef<string[]>([])
  const lastInjectedRef = useRef<string>('')
  const weStartedSessionRef = useRef(false)
  /**
   * Live convai conversation id. Set on `onConnect` (when EL hands us
   * `{ conversationId }`) and cleared on disconnect. Surfaced verbatim
   * via `result.convaiConversationId`; `result.conversationId` prefers
   * the caller-supplied option when set.
   */
  const [convaiConversationId, setConvaiConversationId] = useState<string | null>(null)
  // Set to `true` between `endSession()` and the subsequent `startSession()`
  // inside `restart(...)`. While true, the disconnect handler skips the
  // transcript flush and `onConnect` leaves the transcript buffer intact
  // so the reconnect gap is transparent to consumers.
  const isRestartingRef = useRef(false)
  const conversationRef = useRef<{
    sendContextualUpdate: (text: string) => void
    sendUserMessage?: (text: string) => void
    sendUserActivity?: () => void
  } | null>(null)

  const postJson = useCallback(
    createPostJson({ authHeaders, fetchCredentials }),
    [fetchCredentials, authHeaders],
  )

  const injectMemoryContext = useCallback(
    createMemoryContextInjector({
      postJson,
      memoryRetrievePath,
      conversationRef,
      enabled: autoInjectMemory,
      lastInjectedRef,
    }),
    [autoInjectMemory, memoryRetrievePath, postJson],
  )

  const handleTranscriptOnDisconnect = useCallback(
    createTranscriptDisconnectHandler({
      isRestartingRef,
      weStartedSessionRef,
      transcriptRef,
      onTranscript,
      transcriptIngestPath,
      postJson,
    }),
    [onTranscript, postJson, transcriptIngestPath],
  )

  const builtInTools: Record<string, ClientToolFn> = includeMemoryTool
    ? { add_memory: createMemoryAddTool({ postJson, memoryAddPath }) }
    : {}

  const mergedClientTools = { ...builtInTools, ...clientTools }

  const conversation = useConversation({
    clientTools: mergedClientTools as never,
    onConnect: (info: unknown) => {
      // EL ≥1.1 invokes `onConnect({ conversationId })` once the
      // session is fully established. Capture the id so consumers
      // can correlate the voice transport with a sibling text thread.
      const id = (info as { conversationId?: unknown })?.conversationId
      if (typeof id === 'string' && id.length > 0) {
        setConvaiConversationId(id)
      }
      if (!isRestartingRef.current) {
        transcriptRef.current = []
        lastInjectedRef.current = ''
      }
    },
    onDisconnect: () => {
      // Clear the convai id on disconnect so a stale id doesn't leak
      // across reconnects. The wrapped transcript handler runs first
      // so existing consumers see identical flush behaviour.
      handleTranscriptOnDisconnect()
      if (!isRestartingRef.current) {
        setConvaiConversationId(null)
      }
    },
    onError: (e: unknown) => {
      onError?.(e)
    },
    onMessage: (m: unknown) => {
      const msg = m as { source?: string; message?: string }
      if (!msg?.message || !msg?.source) return
      appendTranscriptLine(msg, { transcriptRef, weStartedSessionRef })
      onMessage?.({ source: msg.source, message: msg.message })
      if (
        autoInjectMemory &&
        msg.source === 'user' &&
        msg.message.trim().length >= 3 &&
        weStartedSessionRef.current
      ) {
        void injectMemoryContext(msg.message)
      }
    },
  })

  const { status, isSpeaking, isListening, isMuted, setMuted, startSession, endSession } =
    conversation
  conversationRef.current = conversation as unknown as {
    sendContextualUpdate: (text: string) => void
    sendUserMessage?: (text: string) => void
    sendUserActivity?: () => void
  }

  // Flush any pending transcript on `pagehide` using sendBeacon — the regular
  // POST can race against the browser killing the tab.
  useEffect(() => {
    const onHide = () => {
      if (!weStartedSessionRef.current || transcriptRef.current.length === 0) return
      const transcript = transcriptRef.current.join('\n').trim()
      transcriptRef.current = []
      if (transcript.length < 20) return
      try {
        const blob = new Blob([JSON.stringify({ transcript })], { type: 'application/json' })
        navigator.sendBeacon(transcriptIngestPath, blob)
      } catch {
        // Beacon failures aren't recoverable; swallow.
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [transcriptIngestPath])

  // Shared session-start routine used by both `start()` and `restart()`.
  // `suppressFirstMessage` passes `overrides.agent.firstMessage = ''` so
  // the agent skips its opening greeting — used when programmatically
  // reconnecting mid-conversation (e.g. a barge-in "stop AI" control).
  const startInternal = useCallback(
    async (opts?: { suppressFirstMessage?: boolean }) => {
      if (status === 'connected' || status === 'connecting') {
        try {
          endSession()
          await new Promise((r) => setTimeout(r, 120))
        } catch {
          /* fall through */
        }
      }
      // Web-only: ask the browser for mic permission up front so the
      // signed-URL fetch isn't wasted if the user denies it.
      await navigator.mediaDevices.getUserMedia({ audio: true })
      const data = await fetchSignedUrl({
        path: resolvedSignedUrlPath,
        fetchCredentials,
        authHeaders,
      })
      const ctx = data.userContext || 'No prior memories yet.'
      weStartedSessionRef.current = true
      const sessionPayload = buildSessionPayload({
        signedUrl: data.signedUrl,
        characterName,
        userContext: ctx,
        agentPromptOverride: data.agentPromptOverride,
        suppressFirstMessage: opts?.suppressFirstMessage,
        conversationId: optionConversationId,
        dynamicVariables,
      })
      await startSession(sessionPayload as never)
    },
    [
      status,
      endSession,
      resolvedSignedUrlPath,
      fetchCredentials,
      dynamicVariables,
      startSession,
      characterName,
      authHeaders,
      optionConversationId,
    ],
  )

  const start = useCallback(
    async (options?: { suppressFirstMessage?: boolean }) => {
      await startInternal(options)
    },
    [startInternal],
  )

  const end = useCallback(() => {
    endSession()
  }, [endSession])

  const restart = useCallback(
    async (options?: { suppressFirstMessage?: boolean }) => {
      const suppress = options?.suppressFirstMessage ?? true
      isRestartingRef.current = true
      try {
        try {
          endSession()
        } catch {
          /* best effort — may already be disconnected */
        }
        // Small settle window matches the existing reconnect pattern in
        // startInternal so the underlying transport is fully torn down
        // before we open a new session.
        await new Promise((r) => setTimeout(r, 120))
        await startInternal({ suppressFirstMessage: suppress })
      } finally {
        isRestartingRef.current = false
      }
    },
    [endSession, startInternal],
  )

  const sendContextualUpdate = useCallback((text: string) => {
    conversationRef.current?.sendContextualUpdate(text)
  }, [])

  const sendUserMessage = useCallback((text: string) => {
    const ref = conversationRef.current
    if (!ref) return
    if (typeof ref.sendUserMessage === 'function') {
      ref.sendUserMessage(text)
      return
    }
    // Older @elevenlabs/react versions only expose sendContextualUpdate.
    // Fall back to injecting the text as context and nudging activity so
    // the agent is more likely to take its turn.
    ref.sendContextualUpdate(text)
    try {
      ref.sendUserActivity?.()
    } catch {
      /* best effort */
    }
  }, [])

  const sendUserActivity = useCallback(() => {
    conversationRef.current?.sendUserActivity?.()
  }, [])

  const getOutputByteFrequencyData = useCallback((): Uint8Array | null => {
    try {
      const fn = (conversation as { getOutputByteFrequencyData?: () => Uint8Array })
        .getOutputByteFrequencyData
      return fn ? fn() : null
    } catch {
      return null
    }
  }, [conversation])

  return {
    start,
    end,
    restart,
    status: status as UseVoiceConversationResult['status'],
    isSpeaking,
    isListening,
    isMuted,
    setMuted,
    getOutputByteFrequencyData,
    sendContextualUpdate,
    sendUserMessage,
    sendUserActivity,
    conversationId: optionConversationId ?? convaiConversationId,
    convaiConversationId,
  }
}
