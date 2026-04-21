// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useVoiceConversation` — drop-in React hook wrapping `@elevenlabs/react`'s
 * `useConversation` with batteries included:
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
 * peer dependency).
 */

import { useCallback, useEffect, useRef } from 'react'
// `@elevenlabs/react` is an optional peer dep. The import is a type-only path
// at compile time; at runtime the host app must have it installed.
import { useConversation } from '@elevenlabs/react'
import { stripAudioTags } from '../audioTags.js'

export interface UseVoiceConversationOptions {
  /** Name of the companion the user is talking to (passed as a dynamic variable). */
  characterName: string

  /** Server path that mints an 11Labs signed URL for this user. Default: `/api/voice/signed-url`. */
  signedUrlPath?: string

  /** Server path the built-in `add_memory` tool POSTs to. Default: `/api/memory/add`. */
  memoryAddPath?: string

  /** Server path used to auto-inject memory context. Default: `/api/memory/retrieve`. */
  memoryRetrievePath?: string

  /** Server path the transcript is POSTed to when the session ends. Default: `/api/memory/ingest`. */
  transcriptIngestPath?: string

  /** Disable the built-in memory context auto-injection. Default: `true` (enabled). */
  autoInjectMemory?: boolean

  /** Disable the built-in `add_memory` client tool. Default: `true` (enabled). */
  includeMemoryTool?: boolean

  /**
   * Additional client tools merged onto `add_memory`. Tools defined here with
   * the name `add_memory` override the built-in implementation.
   */
  clientTools?: Record<string, (params: Record<string, unknown>) => Promise<string> | string>

  /**
   * Called once per session with the accumulated transcript when the session
   * disconnects. Defaults to POST `transcriptIngestPath`; set this to suppress
   * or replace that behaviour.
   */
  onTranscript?: (transcript: string) => void | Promise<void>

  /** Credentials mode for built-in fetch calls. Default: `same-origin`. */
  fetchCredentials?: RequestCredentials

  /** Called on connection errors. */
  onError?: (error: unknown) => void

  /** Called on each message (user or agent) for debugging / custom UI. */
  onMessage?: (message: { source: string; message: string }) => void
}

export interface UseVoiceConversationResult {
  /** Begin a new session. Requests microphone permission and fetches a signed URL. */
  start: () => Promise<void>
  /** End the current session (if any). */
  end: () => void
  /** `'disconnected' | 'connecting' | 'connected'`. */
  status: 'disconnected' | 'connecting' | 'connected'
  /** Whether the agent is currently speaking. */
  isSpeaking: boolean
  /** Whether the agent is currently listening. */
  isListening: boolean
  /** For consumers who want to drive their own visualisation / lipsync. */
  getOutputByteFrequencyData: () => Uint8Array | null
  /** Imperatively send a contextual update (e.g. "user navigated to X"). */
  sendContextualUpdate: (text: string) => void
}

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
    fetchCredentials = 'same-origin',
    onError,
    onMessage,
  } = options

  const transcriptRef = useRef<string[]>([])
  const lastInjectedRef = useRef<string>('')
  const weStartedSessionRef = useRef(false)
  const conversationRef = useRef<{
    sendContextualUpdate: (text: string) => void
  } | null>(null)

  const postJson = useCallback(
    async (path: string, body: unknown) => {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: fetchCredentials,
        body: JSON.stringify(body),
      })
    },
    [fetchCredentials],
  )

  const injectMemoryContext = useCallback(
    async (userText: string) => {
      if (!autoInjectMemory) return
      try {
        const res = await postJson(memoryRetrievePath, { query: userText, limit: 4 })
        if (!res.ok) return
        const data = (await res.json()) as {
          results?: Array<{ chunk: string; score?: number }>
          took_ms?: number
        }
        const results = data.results ?? []
        if (!results.length) return
        const lines = results
          .map((r) => `- ${r.chunk.trim().replace(/\s+/g, ' ').slice(0, 200)}`)
          .join('\n')
        if (lines === lastInjectedRef.current) return
        lastInjectedRef.current = lines
        const payload = `Relevant memory about this user:\n${lines}`
        conversationRef.current?.sendContextualUpdate(payload)
      } catch {
        // Memory injection is best-effort; swallow errors.
      }
    },
    [autoInjectMemory, memoryRetrievePath, postJson],
  )

  const handleTranscriptOnDisconnect = useCallback(() => {
    if (!weStartedSessionRef.current) {
      transcriptRef.current = []
      return
    }
    weStartedSessionRef.current = false
    const transcript = transcriptRef.current.join('\n')
    transcriptRef.current = []
    if (onTranscript) {
      void onTranscript(transcript)
      return
    }
    const trimmed = transcript.trim()
    if (trimmed.length < 20) return
    void postJson(transcriptIngestPath, { transcript: trimmed }).catch(() => {
      /* best effort */
    })
  }, [onTranscript, postJson, transcriptIngestPath])

  const builtInTools: UseVoiceConversationOptions['clientTools'] = includeMemoryTool
    ? {
        add_memory: async (params: Record<string, unknown>) => {
          const fact = typeof params.fact === 'string' ? params.fact : ''
          if (!fact.trim()) return 'Memory save failed: empty fact.'
          try {
            const res = await postJson(memoryAddPath, { fact })
            if (!res.ok) return 'Failed to save memory.'
            return 'Memory saved.'
          } catch {
            return 'Memory save failed.'
          }
        },
      }
    : {}

  const mergedClientTools = { ...builtInTools, ...clientTools }

  const conversation = useConversation({
    clientTools: mergedClientTools as never,
    onConnect: () => {
      transcriptRef.current = []
      lastInjectedRef.current = ''
    },
    onDisconnect: handleTranscriptOnDisconnect,
    onError: (e: unknown) => {
      onError?.(e)
    },
    onMessage: (m: unknown) => {
      const msg = m as { source?: string; message?: string }
      if (!msg?.message || !msg?.source) return
      const speaker = msg.source === 'user' ? 'User' : 'Agent'
      const cleaned = msg.source === 'user' ? msg.message : stripAudioTags(msg.message)
      if (cleaned && weStartedSessionRef.current) {
        transcriptRef.current.push(`${speaker}: ${cleaned}`)
      }
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

  const { status, isSpeaking, isListening, startSession, endSession } = conversation
  conversationRef.current = conversation as unknown as {
    sendContextualUpdate: (text: string) => void
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

  const start = useCallback(async () => {
    if (status === 'connected' || status === 'connecting') {
      try {
        endSession()
        await new Promise((r) => setTimeout(r, 120))
      } catch {
        /* fall through */
      }
    }
    await navigator.mediaDevices.getUserMedia({ audio: true })
    const res = await fetch(signedUrlPath, { credentials: fetchCredentials })
    if (!res.ok) throw new Error(`Signed URL request failed: ${res.status}`)
    const data = (await res.json()) as { signedUrl: string; userContext?: string }
    const ctx = data.userContext || 'No prior memories yet.'
    weStartedSessionRef.current = true
    await startSession({
      signedUrl: data.signedUrl,
      dynamicVariables: {
        character_name: characterName,
        user_context: ctx,
      },
    } as never)
  }, [status, endSession, signedUrlPath, fetchCredentials, startSession, characterName])

  const end = useCallback(() => {
    endSession()
  }, [endSession])

  const sendContextualUpdate = useCallback((text: string) => {
    conversationRef.current?.sendContextualUpdate(text)
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
    status: status as UseVoiceConversationResult['status'],
    isSpeaking,
    isListening,
    getOutputByteFrequencyData,
    sendContextualUpdate,
  }
}
