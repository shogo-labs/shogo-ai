// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useVoiceConversation` (native) — drop-in React Native hook wrapping
 * `@elevenlabs/react-native`'s `useConversation` with the same battery-
 * included behaviour as the web hook (signed-URL fetch, `add_memory`
 * tool, contextual memory injection, transcript persistence).
 *
 * Differences from the web implementation:
 *
 *   - Imports from `@elevenlabs/react-native` rather than
 *     `@elevenlabs/react`. The RN package re-exports the same
 *     `useConversation` API and additionally configures WebRTC +
 *     native AudioSession internally, so the wrapper logic is
 *     identical.
 *   - There is no `navigator.mediaDevices.getUserMedia` pre-call —
 *     LiveKit handles mic permission negotiation when the session
 *     opens. Consumers can pass an optional `requestPermissions`
 *     callback (typically wired to `expo-av` or
 *     `react-native-permissions`) which is awaited before the
 *     signed-URL fetch.
 *   - The browser's `pagehide` + `navigator.sendBeacon` flush is
 *     replaced with an `AppState.addEventListener('change', ...)`
 *     handler that fires a regular `fetch` POST when the app moves
 *     to the background. There's no native equivalent to `sendBeacon`,
 *     but the OS keeps the JS context alive long enough during a
 *     background transition for the request to leave the device.
 *
 * Requires the host app to install `@elevenlabs/react-native`,
 * `@livekit/react-native`, and `@livekit/react-native-webrtc`. All
 * three are optional peer dependencies of `@shogo-ai/sdk`.
 */

import { useCallback, useEffect, useRef } from 'react'
import { AppState, type NativeEventSubscription } from 'react-native'
// `@elevenlabs/react-native` is an optional peer dep at runtime. Just
// importing it triggers the WebRTC global polyfill and sets the native
// session setup strategy, so the import order (provider mounted near
// the root) matters.
import { useConversation } from '@elevenlabs/react-native'
import {
  appendTranscriptLine,
  buildSessionPayload,
  createMemoryAddTool,
  createMemoryContextInjector,
  createPostJson,
  createTranscriptDisconnectHandler,
  fetchSignedUrl,
  withProjectId,
  type BaseVoiceConversationOptions,
  type BaseVoiceConversationResult,
  type ClientToolFn,
} from '../shared/index.js'

export interface UseVoiceConversationOptions extends BaseVoiceConversationOptions {
  /**
   * Optional pre-flight microphone permission hook. Called once
   * before each `start()` (and the `start()` triggered inside
   * `restart()`). Throw to abort the session — the rejection
   * propagates out through `start()` so the consumer can present a
   * permissions UI.
   *
   * Typical wiring with `expo-av`:
   *
   * ```ts
   * import * as Audio from 'expo-av'
   * useVoiceConversation({
   *   characterName: 'Shogo',
   *   requestPermissions: async () => {
   *     const { status } = await Audio.requestPermissionsAsync()
   *     if (status !== 'granted') {
   *       throw new Error('Microphone permission denied')
   *     }
   *   },
   * })
   * ```
   *
   * If omitted, the SDK relies on LiveKit's internal permission flow
   * (which presents the OS prompt the first time the audio track
   * starts). Wiring this explicitly gives consumers a deterministic
   * place to surface a custom denial UI.
   */
  requestPermissions?: () => Promise<void> | void
}

export type UseVoiceConversationResult = BaseVoiceConversationResult

/**
 * Native hook that owns the voice session lifecycle end-to-end. See
 * the module docblock for the wire format of the various server
 * endpoints.
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
    // RN fetch has no real "same-origin" — apps are always cross-
    // origin to the backend. Default to `'omit'` for the bearer
    // path and `'include'` for the cookie path so the cookie jar
    // gets used when the consumer set up auth that way.
    fetchCredentials = shogoApiKey ? 'omit' : 'include',
    onError,
    onMessage,
    requestPermissions,
  } = options

  const authHeaders = useCallback((): Record<string, string> => {
    return shogoApiKey ? { authorization: `Bearer ${shogoApiKey}` } : {}
  }, [shogoApiKey])

  const resolvedSignedUrlPath = withProjectId(signedUrlPath, projectId)

  const transcriptRef = useRef<string[]>([])
  const lastInjectedRef = useRef<string>('')
  const weStartedSessionRef = useRef(false)
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
    onConnect: () => {
      if (!isRestartingRef.current) {
        transcriptRef.current = []
        lastInjectedRef.current = ''
      }
    },
    onDisconnect: handleTranscriptOnDisconnect,
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

  // Flush any pending transcript when the app moves to the background.
  // No native equivalent of `sendBeacon` exists, but the OS keeps the
  // JS runtime alive long enough during the foreground → background
  // transition for a normal `fetch` POST to leave the device. If the
  // process is killed mid-flight the data is lost; consumers that
  // need stronger durability should subscribe via `onTranscript` and
  // persist incrementally instead of relying on disconnect flushes.
  useEffect(() => {
    const sub: NativeEventSubscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (nextState !== 'background' && nextState !== 'inactive') return
        if (!weStartedSessionRef.current || transcriptRef.current.length === 0) return
        const transcript = transcriptRef.current.join('\n').trim()
        transcriptRef.current = []
        if (transcript.length < 20) return
        void postJson(transcriptIngestPath, { transcript }).catch(() => {
          // Best effort — the app is going away.
        })
      },
    )
    return () => {
      sub.remove()
    }
  }, [postJson, transcriptIngestPath])

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
      // Native: optional consumer-supplied permission gate. Throw to
      // abort the session before we waste a signed-URL request.
      if (requestPermissions) {
        await requestPermissions()
      }
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
      })
      await startSession(sessionPayload as never)
    },
    [
      status,
      endSession,
      resolvedSignedUrlPath,
      fetchCredentials,
      startSession,
      characterName,
      authHeaders,
      requestPermissions,
    ],
  )

  const start = useCallback(
    async (opts?: { suppressFirstMessage?: boolean }) => {
      await startInternal(opts)
    },
    [startInternal],
  )

  const end = useCallback(() => {
    endSession()
  }, [endSession])

  const restart = useCallback(
    async (opts?: { suppressFirstMessage?: boolean }) => {
      const suppress = opts?.suppressFirstMessage ?? true
      isRestartingRef.current = true
      try {
        try {
          endSession()
        } catch {
          /* best effort — may already be disconnected */
        }
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
  }
}
