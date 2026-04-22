// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ShogoChatPanel (web) — in-panel translator UI for "Shogo Mode".
 *
 * Renders as a full-flex panel that is mounted *on top of* the regular
 * `ChatPanel` inside the project layout's chat column. The underlying
 * `ChatPanel` stays mounted (hidden) so its `ChatBridge` registration
 * stays live and the translator can keep driving it.
 *
 * Layout:
 *
 *   ┌─ Shogo Mode ─────────────── [peek] [×] ┐
 *   │           (audio-reactive sphere)      │
 *   ├─────────────────────────────────────────┤
 *   │    (translator thread — messages)       │
 *   ├─────────────────────────────────────────┤
 *   │ [mic] [text input ...............] [▶] │
 *   └─────────────────────────────────────────┘
 *
 * Voice lifecycle (when the mic is active):
 *   - `useVoiceConversation({ signedUrlPath: '/api/voice/signed-url', ... })`
 *     fetches a short-lived ElevenLabs signed URL from the API, opens
 *     a convai WebSocket, and streams audio to/from the shared
 *     "Shogo Mode" agent.
 *   - Tool calls from the voice agent (`send_to_chat`, `set_mode`,
 *     `get_recent_activity`) are executed client-side.
 *   - The ChatBridge publishes a typed event stream (turn-start,
 *     tool-activity, turn-end). Every event is fed into the voice
 *     session as a silent `sendContextualUpdate` so Shogo always has
 *     fresh context; *only* turn-end and long-running heartbeats fire
 *     `sendUserMessage` to force Shogo to speak a high-level summary.
 *
 * Text lifecycle:
 *   - `useTranslatorChat({ clientTools, chatSessionId })` runs
 *     `@ai-sdk/react`'s `useChat` against
 *     `/api/voice/translator/chat/:chatSessionId`. The server persists
 *     both the incoming user turn and the final assistant turn as
 *     `ChatMessage` rows tagged `agent="voice"`; the hook hydrates the
 *     thread from those same rows on mount.
 *   - When voice is inactive, technical-agent replies are fed into the
 *     translator thread as a prefixed user turn so the text persona can
 *     paraphrase them.
 *
 * Persistence (server-authoritative)
 * ----------------------------------
 *   - The translator thread is persisted by the server inside the
 *     translator chat route. The client never writes `ChatMessage` rows
 *     directly — it only hydrates via
 *     `GET /api/chat-messages?sessionId=...&agent=voice`.
 *   - The voice transcript is persisted one row at a time via
 *     `POST /api/voice/transcript/:chatSessionId` as the voice SDK /
 *     bridge surface events. Hydration reads the same `agent=voice`
 *     rows on mount, filtered to the `voice` / `agent-activity`
 *     envelope kinds.
 *   - Deleting a chat session cascades on the server via
 *     `ChatMessage.sessionId` foreign key, so both threads clear
 *     automatically. No client-side storage teardown required.
 *
 * Scope (V1):
 *   - Web only.
 *   - Single shared agent (ELEVENLABS_VOICE_MODE_AGENT_ID).
 *   - The built-in memory tools / auto-injection inside
 *     `useVoiceConversation` are disabled — the translator has no
 *     memory surface of its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native'
import { Text } from '@/components/ui/text'
import { Eye, Keyboard, Mic, MicOff, Send, X } from 'lucide-react-native'
import { ConversationProvider } from '@elevenlabs/react'
import { OrganicParticles, useVoiceConversation } from '@shogo-ai/sdk/voice/react'
import { API_URL } from '../../lib/api'
import { useChatBridge } from './ChatBridgeContext'
import { createBridgeClientTools } from './bridgeClientTools'
import { SHOGO_PARTICLES_CONFIG } from './shogoVisualizationConfig'
import { useTranslatorChat } from './useTranslatorChat'
import {
  loadShogoMessages,
  type ShogoMessageRow,
} from './shogoMessages'
import {
  ShogoTranscriptQueue,
  type TranscriptKind,
  type TranscriptQueueState,
  type TranscriptTask,
} from './shogoTranscriptQueue'

export interface ShogoChatPanelProps {
  /** Optional extra classes for the outer container. */
  className?: string
}

interface TranscriptEntry {
  id: string
  source: 'user-voice' | 'shogo-voice' | 'agent-reply' | 'agent-activity'
  text: string
}

/** Max recent-activity lines kept in memory for summarisation. */
const RECENT_ACTIVITY_MAX = 40
/** Heartbeat cadence during long-running technical-agent turns (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000
function extractMessageText(message: {
  parts?: Array<{ type?: string; text?: string }>
}): string {
  return (message.parts ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim()
}

/**
 * Translate a persisted voice-agent row into the in-memory
 * `TranscriptEntry` shape rendered by the overlay. Returns `null` for
 * rows that shouldn't surface in the voice transcript (e.g. shogo-text
 * turns, which are owned by the AI-SDK thread).
 */
function rowToTranscriptEntry(row: ShogoMessageRow): TranscriptEntry | null {
  const kind = row.envelope?.kind
  let source: TranscriptEntry['source'] | null = null
  if (kind === 'voice') {
    source = row.role === 'user' ? 'user-voice' : 'shogo-voice'
  } else if (kind === 'agent-activity') {
    source = 'agent-activity'
  }
  if (!source) return null
  return { id: row.id, source, text: row.content }
}

/**
 * Outer shell. `@elevenlabs/react` ≥ 1.1 requires every `useConversation`
 * caller to live under a `<ConversationProvider>` — the provider owns the
 * underlying convai session context. We mount it here so the rest of the
 * panel (which uses `useVoiceConversation` under the hood) can work.
 */
export function ShogoChatPanel(props: ShogoChatPanelProps) {
  return (
    <ConversationProvider>
      <ShogoChatPanelInner {...props} />
    </ConversationProvider>
  )
}

function ShogoChatPanelInner({ className }: ShogoChatPanelProps) {
  const bridge = useChatBridge()
  const chatSessionId = bridge.chatSessionId

  const [draft, setDraft] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState<TranscriptEntry[]>([])
  // Input mode — the user picks either voice or text; we only ever show
  // one composer at a time. Default to voice: entering Shogo Mode is an
  // explicit gesture, so we auto-start the mic right away and let the
  // user opt down into text if they prefer.
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice')

  // ---------------------------------------------------------------------
  // Recent-activity buffer — the authoritative view of what the technical
  // agent has been doing this turn. Every event emitted through the
  // ChatBridge appends here; Shogo reads from this buffer (directly via
  // the `get_recent_activity` tool, and indirectly via the nudges we
  // inject at turn-end / heartbeat) to produce its outcome summaries.
  // ---------------------------------------------------------------------
  const recentActivityRef = useRef<string[]>([])
  /** Index into `recentActivityRef.current` that marks the last heartbeat/turn-end boundary. */
  const lastHeartbeatIndexRef = useRef<number>(0)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const turnActiveRef = useRef<boolean>(false)

  // Voice session imperative handles — captured in a ref so callbacks
  // declared before `conversation` resolves can still reach the latest
  // methods (sendContextualUpdate / sendUserMessage / sendUserActivity).
  const conversationRef = useRef<{
    sendContextualUpdate: (t: string) => void
    sendUserMessage: (t: string) => void
    sendUserActivity: () => void
    voiceActive: boolean
  } | null>(null)

  // Client tools exposed to both voice and text modalities. In addition
  // to the bridge-backed `send_to_chat` + `set_mode`, we expose
  // `get_recent_activity` so Shogo can pull the raw activity log when it
  // needs extra material to summarise accurately.
  const clientTools = useMemo(() => {
    const base = createBridgeClientTools(bridge)
    const getRecentActivity = () => {
      const items = recentActivityRef.current.slice(-RECENT_ACTIVITY_MAX)
      if (items.length === 0) return 'No recent technical-agent activity recorded.'
      return items.join('\n')
    }
    return {
      ...base,
      // Both surfaces ignore extra keys; bridgeClientTools returns
      // string, and we do the same here so the tool shape matches.
      get_recent_activity: (_params: Record<string, unknown>) => getRecentActivity(),
    }
  }, [bridge])

  // ---------------------------------------------------------------------
  // Text modality — AI-SDK chat against
  // /api/voice/translator/chat/:chatSessionId. The server persists both
  // user and assistant UIMessages as ChatMessage rows tagged
  // agent="voice", and the hook hydrates from the same rows on mount.
  // ---------------------------------------------------------------------
  const {
    messages,
    sendMessage,
    status: textStatus,
  } = useTranslatorChat({
    clientTools,
    chatSessionId,
  })

  // ---------------------------------------------------------------------
  // Voice modality — ElevenLabs convai session.
  // ---------------------------------------------------------------------
  const conversation = useVoiceConversation({
    characterName: 'Shogo',
    signedUrlPath: `${API_URL ?? ''}/api/voice/signed-url`,
    // Dev mode serves Metro on 8081 and the API on 8002 — without
    // `include` the session cookie isn't sent cross-origin and the
    // route 401s. `include` matches the default HttpClient behaviour
    // used throughout the app.
    fetchCredentials: 'include',
    includeMemoryTool: false,
    autoInjectMemory: false,
    clientTools: clientTools as never,
    onError: (err) => {
      console.warn('[ShogoChatPanel] voice error', err)
      setVoiceError(
        (err as Error)?.message ||
          'Voice connection failed. Check your microphone and try again.',
      )
    },
    onMessage: ({ source, message }) => {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log('[ShogoChatPanel] SDK onMessage', {
          source,
          preview: message?.slice(0, 120),
        })
      }
      if (!message?.trim()) return
      const entrySource: TranscriptEntry['source'] =
        source === 'user' ? 'user-voice' : 'shogo-voice'
      appendTranscriptRef.current(entrySource, message)
    },
  })

  const voiceActive =
    conversation.status === 'connected' || conversation.status === 'connecting'

  conversationRef.current = {
    sendContextualUpdate: conversation.sendContextualUpdate,
    sendUserMessage: conversation.sendUserMessage,
    sendUserActivity: conversation.sendUserActivity,
    voiceActive,
  }

  // ---------------------------------------------------------------------
  // Heartbeat management. Long technical-agent turns are common
  // (4–5 minutes typical, 10+ minutes happens) so while a turn is
  // running we fire a recurring nudge every ~30s that asks Shogo to
  // summarise *what progressed since the last heartbeat*. Shogo never
  // speaks on its own during mid-turn activity — only when we ping it
  // like this at a milestone.
  // ---------------------------------------------------------------------
  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    turnActiveRef.current = false
  }, [])

  const startHeartbeat = useCallback(() => {
    stopHeartbeat()
    turnActiveRef.current = true
    heartbeatTimerRef.current = setInterval(() => {
      if (!turnActiveRef.current) return
      const ref = conversationRef.current
      if (!ref || !ref.voiceActive) return
      const activity = recentActivityRef.current
      const sliceStart = lastHeartbeatIndexRef.current
      const newItems = activity.slice(sliceStart)
      lastHeartbeatIndexRef.current = activity.length
      const activityBlock = newItems.length > 0
        ? `Activity since your last update:\n${newItems.join('\n')}`
        : 'No new named activity since your last update, but the agent is still running.'
      const nudge =
        'The technical agent is still working. This is a heartbeat from the UI. ' +
        'Give the user a two- or three-sentence high-level progress update in ' +
        'business-outcome language — focus on what has been accomplished ' +
        'since your previous heartbeat, not what is still pending. Do not ' +
        'repeat what you already said last time. Never recite tool names, ' +
        'file names, or a blow-by-blow list of operations.\n\n' +
        activityBlock
      try {
        ref.sendUserMessage(nudge)
      } catch (err) {
        console.warn('[ShogoChatPanel] heartbeat sendUserMessage failed', err)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }, [stopHeartbeat])

  // ---------------------------------------------------------------------
  // ChatBridge subscription — the authoritative data source for Shogo's
  // awareness of the technical agent.
  // ---------------------------------------------------------------------
  // Keep the latest `sendMessage` in a ref so the subscribe effect
  // doesn't need to resubscribe every render.
  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage

  useEffect(() => {
    const pushActivity = (line: string) => {
      recentActivityRef.current.push(line)
      if (recentActivityRef.current.length > RECENT_ACTIVITY_MAX) {
        recentActivityRef.current.shift()
        lastHeartbeatIndexRef.current = Math.max(0, lastHeartbeatIndexRef.current - 1)
      }
    }

    const mirrorTranscript = (source: TranscriptEntry['source'], text: string) => {
      appendTranscriptRef.current(source, text)
    }

    const silentContext = (text: string) => {
      const ref = conversationRef.current
      if (!ref || !ref.voiceActive) return
      try {
        ref.sendContextualUpdate(text)
      } catch (err) {
        console.warn('[ShogoChatPanel] sendContextualUpdate failed', err)
      }
    }

    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === 'turn-start') {
        recentActivityRef.current = ['Turn started.']
        lastHeartbeatIndexRef.current = recentActivityRef.current.length
        silentContext(
          'The technical agent just started a new turn. Stay quiet until the ' +
            'turn ends or you receive a heartbeat nudge.',
        )
        startHeartbeat()
        return
      }

      if (event.type === 'tool-activity') {
        const okSuffix =
          event.phase === 'end' && event.ok === false ? ' (failed)' : ''
        const line =
          event.phase === 'start'
            ? `Started: ${event.label}${okSuffix}`
            : `Finished: ${event.label}${okSuffix}`
        pushActivity(line)
        // Silent awareness only — Shogo must not speak about mid-turn
        // tool activity. We still mirror it into the on-screen log so
        // the user has visibility if they look.
        silentContext(`[agent activity] ${line}`)
        mirrorTranscript(
          'agent-activity',
          event.label +
            (event.phase === 'end'
              ? event.ok === false
                ? ' — failed'
                : ' — done'
              : '…'),
        )
        return
      }

      // turn-end
      stopHeartbeat()
      const { finalText } = event
      pushActivity(
        finalText ? `Turn ended. Final reply: ${finalText.slice(0, 500)}` : 'Turn ended.',
      )

      // Mirror the final reply into the on-screen transcript regardless
      // of modality — the user should always be able to scroll back.
      if (finalText) {
        mirrorTranscript('agent-reply', finalText)
      }

      const ref = conversationRef.current
      if (ref && ref.voiceActive) {
        // Feed the final text in as silent context so Shogo has the raw
        // material, then inject a user-role message that *forces* a
        // summary turn. The user never hears the nudge — they only hear
        // Shogo's spoken response.
        if (finalText) {
          try {
            ref.sendContextualUpdate(`The agent replied: ${finalText}`)
          } catch (err) {
            console.warn('[ShogoChatPanel] sendContextualUpdate(final) failed', err)
          }
        }
        const nudge =
          'The technical agent just finished this turn. Give the user a ' +
          'two- or three-sentence high-level summary of what was ' +
          'accomplished — in business-outcome language (what changed, ' +
          'what it means for them, whether anything is pending). Never ' +
          'recite tool names, file names, or a list of operations. Base ' +
          'it on the final reply and the recent activity.' +
          (finalText ? `\n\nFinal reply:\n${finalText}` : '')
        try {
          ref.sendUserMessage(nudge)
        } catch (err) {
          console.warn('[ShogoChatPanel] turn-end sendUserMessage failed', err)
        }
      } else {
        // Text modality: feed the reply into the translator thread as
        // a user turn so it paraphrases on its next response.
        if (finalText) {
          try {
            void sendMessageRef.current({
              text: `The agent replied: ${finalText}`,
            })
          } catch (err) {
            console.warn('[ShogoChatPanel] sendMessage(agent reply) failed', err)
          }
        }
      }
    })
    return unsubscribe
  }, [bridge, startHeartbeat, stopHeartbeat])

  // Tear down voice session + heartbeat on unmount (user flipped Shogo
  // Mode off, or navigated away).
  useEffect(() => {
    return () => {
      stopHeartbeat()
      try {
        conversation.end()
      } catch {
        // no-op — already disconnected.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-start the mic when entering Shogo Mode in voice modality. The
  // user clicking the Shogo Mode toggle counts as the user gesture that
  // browsers require for `getUserMedia`, so this runs without a prompt
  // loop. If permissions are denied or the signed URL fails we surface
  // the error and leave the UI in an obvious "tap the mic to retry"
  // state.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (autoStartedRef.current) return
    if (inputMode !== 'voice') return
    if (conversation.status !== 'disconnected') return
    autoStartedRef.current = true
    ;(async () => {
      try {
        await conversation.start()
      } catch (err: unknown) {
        console.warn('[ShogoChatPanel] auto-start voice failed', err)
        setVoiceError(
          (err as Error)?.message ||
            'Could not start voice session. Check microphone permissions.',
        )
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputMode, conversation.status])

  // ---------------------------------------------------------------------
  // Voice transcript persistence — server-authoritative, queue-backed.
  //
  // On mount (and whenever the active chat session changes) we hydrate
  // `voiceTranscript` from `/api/chat-messages?sessionId=...&agent=voice`
  // filtered to the `voice` / `agent-activity` envelope kinds.
  //
  // New entries are enqueued into a `ShogoTranscriptQueue` that posts
  // serially against `/api/voice/transcript/:chatSessionId`, retries
  // transient failures with exponential back-off, and surfaces a
  // "Syncing / Retrying" banner so a network hiccup can never silently
  // lose a conversation the way the original fire-and-forget path did.
  //
  // Belt-and-suspenders safety net: every raw SDK turn is buffered in
  // `rawTurnsRef`. When the voice session disconnects (or the component
  // unmounts) we re-enqueue any id that hasn't been confirmed persisted
  // yet, and on `pagehide` we fire `navigator.sendBeacon` for every
  // still-pending task so a mid-turn refresh still lands.
  //
  // The `agent-reply` mirror rows (a friendly echo of the technical
  // agent's final reply) are deliberately NOT persisted — the technical
  // thread already has that row, and Shogo's spoken paraphrase IS the
  // authoritative record on reload.
  // ---------------------------------------------------------------------
  const transcriptHydratedRef = useRef<string | null>(null)
  /** IDs of transcript entries that have been confirmed persisted (by the
   * server on a successful POST, or by being loaded during hydration).
   * Used to skip duplicate re-enqueues from the session-end replay. */
  const persistedEntryIdsRef = useRef<Set<string>>(new Set())
  /** Mirror of every transcript task we've *ever* appended this session,
   * keyed by task id. Lets `onTranscript` / unmount re-enqueue any row
   * that slipped through a previous POST failure. */
  const rawTurnsRef = useRef<Map<string, TranscriptTask>>(new Map())

  const [queueState, setQueueState] = useState<TranscriptQueueState>({
    pendingCount: 0,
    inFlight: false,
    backoffActive: false,
    lastError: null,
  })

  const debugLog = useCallback((msg: string, data?: unknown) => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log(msg, data ?? '')
    }
  }, [])

  // Single queue instance per panel lifetime. The queue is
  // chatSession-agnostic (every task carries its own chatSessionId) so
  // we don't need to recreate it when the session changes.
  const transcriptQueue = useMemo(
    () =>
      new ShogoTranscriptQueue({
        apiUrl: API_URL ?? '',
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        onStateChange: (state) => setQueueState(state),
        onTaskPersisted: (task) => {
          persistedEntryIdsRef.current.add(task.id)
        },
        onTaskDropped: (task, reason) => {
          console.warn(
            '[ShogoChatPanel] transcript task dropped — row will NOT be persisted:',
            { id: task.id, kind: task.kind, reason },
          )
        },
        debug: debugLog,
      }),
    [debugLog],
  )

  useEffect(() => {
    return () => {
      transcriptQueue.dispose()
    }
  }, [transcriptQueue])

  const sourceToKind = (
    source: TranscriptEntry['source'],
  ): TranscriptKind | null => {
    switch (source) {
      case 'user-voice':
        return 'voice-user'
      case 'shogo-voice':
        return 'voice-agent'
      case 'agent-activity':
        return 'agent-activity'
      case 'agent-reply':
        // Intentionally NOT persisted — the technical thread already
        // stores this row and Shogo's spoken paraphrase is the
        // authoritative record.
        return null
    }
  }

  // Single entrypoint for "add to voiceTranscript AND enqueue persist"
  // so every push path (voice SDK onMessage, bridge mirror, etc.) goes
  // through the same idempotent id + queued write.
  const appendTranscript = useCallback(
    (source: TranscriptEntry['source'], text: string) => {
      const entry: TranscriptEntry = {
        id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        text,
      }
      setVoiceTranscript((prev) => [...prev, entry])

      const kind = sourceToKind(source)
      if (!kind) return
      if (!chatSessionId) {
        debugLog(
          '[ShogoChatPanel] appendTranscript skipped — no chatSessionId yet',
          { entryId: entry.id, source },
        )
        return
      }
      if (persistedEntryIdsRef.current.has(entry.id)) return

      const task: TranscriptTask = {
        chatSessionId,
        kind,
        text,
        id: entry.id,
        ts: Date.now(),
      }
      rawTurnsRef.current.set(task.id, task)
      debugLog('[ShogoChatPanel] appendTranscript enqueue', {
        id: entry.id,
        kind,
        textPreview: text.slice(0, 120),
      })
      transcriptQueue.enqueue(task)
    },
    [chatSessionId, transcriptQueue, debugLog],
  )

  const appendTranscriptRef = useRef(appendTranscript)
  appendTranscriptRef.current = appendTranscript

  // Hydrate whenever the active chat session changes.
  useEffect(() => {
    if (!chatSessionId) {
      setVoiceTranscript([])
      transcriptHydratedRef.current = null
      persistedEntryIdsRef.current = new Set()
      rawTurnsRef.current = new Map()
      return
    }
    if (transcriptHydratedRef.current === chatSessionId) return
    transcriptHydratedRef.current = chatSessionId
    persistedEntryIdsRef.current = new Set()
    rawTurnsRef.current = new Map()

    const controller = new AbortController()
    ;(async () => {
      try {
        const rows = await loadShogoMessages(chatSessionId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const hydrated = rows
          .map<TranscriptEntry | null>((row) => rowToTranscriptEntry(row))
          .filter((e): e is TranscriptEntry => !!e)
        for (const e of hydrated) {
          persistedEntryIdsRef.current.add(e.id)
        }
        debugLog('[ShogoChatPanel] hydrate ok', {
          chatSessionId,
          totalRows: rows.length,
          hydratedEntries: hydrated.length,
          byKind: rows.reduce<Record<string, number>>((acc, r) => {
            const k = r.envelope?.kind ?? 'unknown'
            acc[k] = (acc[k] ?? 0) + 1
            return acc
          }, {}),
        })
        setVoiceTranscript(hydrated)
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        console.warn(
          '[ShogoChatPanel] hydrate voice transcript failed:',
          err?.message || err,
        )
        setVoiceTranscript([])
      }
    })()
    return () => {
      controller.abort()
    }
  }, [chatSessionId, debugLog])

  // ---------------------------------------------------------------------
  // Safety net #1 — session-end bulk replay.
  //
  // Every raw turn we've seen this session lives in `rawTurnsRef`. When
  // the voice connection transitions to `disconnected`, walk the map
  // and re-enqueue anything the queue doesn't yet know about (i.e. that
  // hasn't been confirmed persisted). This covers the case where a
  // mid-session POST failed, was dropped (shouldn't happen with the
  // retry loop, but belt-and-suspenders), or the user toggled voice
  // off before the last task finished flushing.
  // ---------------------------------------------------------------------
  const prevVoiceStatusRef = useRef(conversation.status)
  useEffect(() => {
    const prev = prevVoiceStatusRef.current
    prevVoiceStatusRef.current = conversation.status
    if (prev !== 'connected' && prev !== 'connecting') return
    if (conversation.status !== 'disconnected') return
    // Just transitioned from active → disconnected. Replay any
    // unconfirmed tasks through the queue.
    let replayed = 0
    for (const [id, task] of rawTurnsRef.current) {
      if (persistedEntryIdsRef.current.has(id)) continue
      transcriptQueue.enqueue(task)
      replayed += 1
    }
    if (replayed > 0) {
      debugLog('[ShogoChatPanel] session-end replay', { replayed })
    }
  }, [conversation.status, transcriptQueue, debugLog])

  // ---------------------------------------------------------------------
  // Safety net #2 — `pagehide` beacon flush.
  //
  // If the user closes / refreshes the tab while tasks are still
  // pending in the queue (either actively retrying or waiting on
  // back-off), fire `navigator.sendBeacon` for each so at least a
  // best-effort write lands before the browser nukes the context.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (typeof window === 'undefined') return
    const onHide = () => {
      // Replay any un-enqueued raw turns first, then beacon-flush the
      // full pending queue.
      for (const [id, task] of rawTurnsRef.current) {
        if (persistedEntryIdsRef.current.has(id)) continue
        transcriptQueue.enqueue(task)
      }
      const flushed = transcriptQueue.flushBeacon()
      if (flushed > 0) {
        debugLog('[ShogoChatPanel] pagehide beacon flush', { flushed })
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
    }
  }, [transcriptQueue, debugLog])

  const handleClose = useCallback(
    () => bridge.setShogoModeActive(false),
    [bridge],
  )

  const handlePeek = useCallback(
    () => bridge.setShogoPeekActive(true),
    [bridge],
  )

  const handleSendText = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void sendMessage({ text })
  }, [draft, sendMessage])

  const handleToggleMic = useCallback(async () => {
    setVoiceError(null)
    if (voiceActive) {
      conversation.end()
      return
    }
    try {
      await conversation.start()
    } catch (err: unknown) {
      console.warn('[ShogoChatPanel] failed to start voice session', err)
      setVoiceError(
        (err as Error)?.message ||
          'Could not start voice session. Check microphone permissions.',
      )
    }
  }, [conversation, voiceActive])

  // When the user flips back to text mode we end any live voice session —
  // we never want the mic hot while the voice composer is hidden.
  const handleSetInputMode = useCallback(
    (next: 'voice' | 'text') => {
      setInputMode(next)
      setVoiceError(null)
      if (next === 'text' && voiceActive) {
        try {
          conversation.end()
        } catch {
          // no-op.
        }
      }
    },
    [conversation, voiceActive],
  )

  const scrollRef = useRef<ScrollView | null>(null)
  useEffect(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true })
  }, [messages.length, voiceTranscript.length])

  const isVoiceMode = inputMode === 'voice'

  return (
    <View className={className ?? 'flex-1 bg-background'}>
      <Header
        status={conversation.status}
        voiceError={voiceError}
        inputMode={inputMode}
        onInputModeChange={handleSetInputMode}
        onPeek={handlePeek}
        onClose={handleClose}
      />

      <SyncBanner state={queueState} />

      {isVoiceMode && (
        <SphereHero
          getFrequencyData={conversation.getOutputByteFrequencyData}
          voiceActive={voiceActive}
          speaking={conversation.isSpeaking}
          listening={conversation.isListening}
        />
      )}

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="px-4 py-4 gap-3"
      >
        {messages.length === 0 && voiceTranscript.length === 0 ? (
          <EmptyState mode={inputMode} />
        ) : (
          <>
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                role={m.role === 'user' ? 'user' : 'shogo'}
                text={extractMessageText(m as never)}
              />
            ))}
            {voiceTranscript.map((t) => (
              <MessageRow
                key={t.id}
                role={
                  t.source === 'user-voice'
                    ? 'user'
                    : t.source === 'shogo-voice'
                    ? 'shogo'
                    : t.source === 'agent-activity'
                    ? 'agent-activity'
                    : 'agent-reply'
                }
                text={t.text}
                badge={
                  t.source === 'user-voice'
                    ? 'voice'
                    : t.source === 'agent-reply'
                    ? 'from chat'
                    : t.source === 'agent-activity'
                    ? 'agent activity'
                    : undefined
                }
              />
            ))}
          </>
        )}

        {textStatus === 'streaming' || textStatus === 'submitted' ? (
          <View className="self-start rounded-full bg-muted px-3 py-1">
            <Text className="text-muted-foreground text-xs">
              Shogo is thinking…
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {isVoiceMode ? (
        <VoiceComposer
          onToggleMic={handleToggleMic}
          voiceActive={voiceActive}
          voiceConnecting={conversation.status === 'connecting'}
          voiceSpeaking={conversation.isSpeaking}
          voiceListening={conversation.isListening}
          voiceError={voiceError}
        />
      ) : (
        <TextComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSendText}
        />
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SphereHero({
  getFrequencyData,
  voiceActive,
  speaking,
  listening,
}: {
  getFrequencyData: () => Uint8Array | null
  voiceActive: boolean
  speaking: boolean
  listening: boolean
}) {
  const caption = !voiceActive
    ? 'Tap the mic to start talking'
    : speaking
    ? 'Shogo is speaking…'
    : listening
    ? 'Listening…'
    : 'Connecting…'

  return (
    <View className="items-center border-b border-border">
      <View
        className="w-full"
        // Fixed height gives the Three.js canvas a stable layout box;
        // the particle cloud scales inside via `style`.
        style={{ height: 400 }}
      >
        <OrganicParticles
          config={SHOGO_PARTICLES_CONFIG}
          getFrequencyData={getFrequencyData}
          active={voiceActive}
          style={{ width: '100%', height: '100%' }}
        />
      </View>
      <Text className="text-xs text-muted-foreground pb-2">{caption}</Text>
    </View>
  )
}

function Header({
  status,
  voiceError,
  inputMode,
  onInputModeChange,
  onPeek,
  onClose,
}: {
  status: 'disconnected' | 'connecting' | 'connected'
  voiceError: string | null
  inputMode: 'voice' | 'text'
  onInputModeChange: (next: 'voice' | 'text') => void
  onPeek: () => void
  onClose: () => void
}) {
  const isVoice = inputMode === 'voice'
  // Only show the live voice status dot when the user is actually in voice
  // mode — otherwise it's confusing ("Idle" next to the Text composer).
  const showStatus = isVoice
  const statusLabel =
    status === 'connected'
      ? 'Voice connected'
      : status === 'connecting'
      ? 'Connecting…'
      : 'Idle'
  const statusDotClass =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
      ? 'bg-amber-500'
      : 'bg-muted-foreground/40'

  return (
    <View className="flex-row items-center justify-between px-4 py-3 border-b border-border gap-3">
      <View className="flex-row items-center gap-3 min-w-0 flex-1">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-foreground">
            Shogo Mode
          </Text>
        </View>
      </View>
      <View className="flex-row items-center gap-2">
        <InputModeSwitcher mode={inputMode} onChange={onInputModeChange} />
        {showStatus && (
          <View className="flex-row items-center gap-1.5">
            <View className={`w-1.5 h-1.5 rounded-full ${statusDotClass}`} />
            <Text className="text-xs text-muted-foreground">
              {voiceError ? 'Error' : statusLabel}
            </Text>
          </View>
        )}
        <Pressable
          onPress={onPeek}
          className="p-1.5 rounded-md hover:bg-muted"
          accessibilityLabel="Peek at technical chat"
        >
          <Eye size={16} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={onClose}
          className="p-1.5 rounded-md hover:bg-muted"
          accessibilityLabel="Exit Shogo Mode"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  )
}

/**
 * Segmented control that flips between voice and text composers. We keep
 * it small + text-free on labels (pure icon) so it fits the header at any
 * chat-column width.
 */
function InputModeSwitcher({
  mode,
  onChange,
}: {
  mode: 'voice' | 'text'
  onChange: (next: 'voice' | 'text') => void
}) {
  return (
    <View className="flex-row items-center rounded-full bg-muted p-0.5">
      <Pressable
        onPress={() => onChange('voice')}
        className={`flex-row items-center gap-1 px-2.5 py-1 rounded-full ${
          mode === 'voice' ? 'bg-background shadow-sm' : ''
        }`}
        accessibilityLabel="Switch to voice input"
      >
        <Mic
          size={12}
          className={mode === 'voice' ? 'text-foreground' : 'text-muted-foreground'}
        />
        <Text
          className={`text-[11px] font-semibold ${
            mode === 'voice' ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          Voice
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('text')}
        className={`flex-row items-center gap-1 px-2.5 py-1 rounded-full ${
          mode === 'text' ? 'bg-background shadow-sm' : ''
        }`}
        accessibilityLabel="Switch to text input"
      >
        <Keyboard
          size={12}
          className={mode === 'text' ? 'text-foreground' : 'text-muted-foreground'}
        />
        <Text
          className={`text-[11px] font-semibold ${
            mode === 'text' ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          Text
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * Subtle horizontal banner shown when the transcript queue has pending
 * writes or is backing off after a transient failure. Keeps the user
 * aware that "your last turn hasn't landed yet" instead of silently
 * losing it the way the original fire-and-forget path did.
 */
function SyncBanner({ state }: { state: TranscriptQueueState }) {
  if (state.pendingCount === 0 && !state.lastError) return null
  const label = state.backoffActive
    ? `Retrying transcript sync (${state.pendingCount} pending)…`
    : state.inFlight
    ? state.pendingCount > 1
      ? `Syncing ${state.pendingCount} messages…`
      : 'Syncing transcript…'
    : state.lastError
    ? `Transcript sync issue: ${state.lastError}`
    : null
  if (!label) return null
  const tone = state.backoffActive || state.lastError ? 'warn' : 'info'
  const bgClass = tone === 'warn' ? 'bg-amber-500/10' : 'bg-primary/10'
  const textClass =
    tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-primary'
  return (
    <View className={`px-4 py-1.5 border-b border-border ${bgClass}`}>
      <Text className={`text-[11px] ${textClass}`}>{label}</Text>
    </View>
  )
}

function EmptyState({ mode }: { mode: 'voice' | 'text' }) {
  const hint =
    mode === 'voice'
      ? "Tap the mic to start talking. I'll translate what you say for the technical agent and read replies back to you in plain English."
      : "Type what you'd like to work on below. I'll translate it for the technical agent and summarize replies back to you in plain English."
  return (
    <View className="flex-1 items-center justify-center py-10 gap-2">
      <Text className="text-sm font-medium text-foreground">Hi, I'm Shogo.</Text>
      <Text className="text-xs text-muted-foreground text-center max-w-[360px]">
        {hint}
      </Text>
    </View>
  )
}

function MessageRow({
  role,
  text,
  badge,
}: {
  role: 'user' | 'shogo' | 'agent-reply' | 'agent-activity'
  text: string
  badge?: string
}) {
  if (!text) return null
  const isUser = role === 'user'
  const isAgentReply = role === 'agent-reply'
  const isAgentActivity = role === 'agent-activity'

  const bubbleClass = isUser
    ? 'bg-primary/10 border border-primary/20 self-end'
    : isAgentActivity
    ? 'bg-muted/30 border border-border/60 self-start opacity-70'
    : isAgentReply
    ? 'bg-muted/60 border border-border self-start'
    : 'bg-background border border-border self-start'

  const label = isUser
    ? 'You'
    : isAgentActivity
    ? 'Agent'
    : isAgentReply
    ? 'Shogo Agent'
    : 'Shogo'

  const textClass = isAgentActivity
    ? 'text-xs text-muted-foreground italic'
    : 'text-sm text-foreground'

  return (
    <View className={`rounded-xl px-3 py-2 max-w-[85%] ${bubbleClass}`}>
      <View className="flex-row items-center gap-2 mb-0.5">
        <Text className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </Text>
        {badge ? (
          <Text className="text-[10px] text-muted-foreground/70">· {badge}</Text>
        ) : null}
      </View>
      <Text className={textClass}>{text}</Text>
    </View>
  )
}

/**
 * Voice-only composer — a single prominent mic button + caption. Shown
 * when the user has picked "Voice" in the mode switcher; hides the text
 * input entirely so the UI never surfaces both at once.
 */
function VoiceComposer({
  onToggleMic,
  voiceActive,
  voiceConnecting,
  voiceSpeaking,
  voiceListening,
  voiceError,
}: {
  onToggleMic: () => void
  voiceActive: boolean
  voiceConnecting: boolean
  voiceSpeaking: boolean
  voiceListening: boolean
  voiceError: string | null
}) {
  const micBgClass = voiceActive
    ? voiceSpeaking
      ? 'bg-emerald-500'
      : voiceListening
      ? 'bg-primary'
      : 'bg-primary/80'
    : voiceConnecting
    ? 'bg-amber-500'
    : 'bg-primary'
  const micIconClass = 'text-primary-foreground'

  const caption = voiceError
    ? voiceError
    : voiceActive
    ? voiceSpeaking
      ? 'Shogo is speaking…'
      : voiceListening
      ? 'Listening — tap to stop'
      : 'Connected — tap to stop'
    : voiceConnecting
    ? 'Connecting…'
    : 'Tap to start talking'

  return (
    <View className="px-3 py-2 items-center gap-2">
      <Pressable
        onPress={onToggleMic}
        className={`rounded-full w-12 h-12 items-center justify-center shadow-lg ${micBgClass}`}
        accessibilityLabel={voiceActive ? 'Stop voice session' : 'Start voice session'}
      >
        {voiceActive ? (
          <MicOff size={26} className={micIconClass} />
        ) : (
          <Mic size={26} className={micIconClass} />
        )}
      </Pressable>
      <Text
        className={`text-xs text-center ${
          voiceError ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {caption}
      </Text>
    </View>
  )
}

/**
 * Text-only composer — input + send button. Shown when the user has
 * picked "Text" in the mode switcher; no mic affordance is rendered here.
 */
function TextComposer({
  draft,
  onDraftChange,
  onSend,
}: {
  draft: string
  onDraftChange: (v: string) => void
  onSend: () => void
}) {
  const canSend = draft.trim().length > 0

  return (
    <View className="border-t border-border px-3 py-3 flex-row items-center gap-2">
      <TextInput
        value={draft}
        onChangeText={onDraftChange}
        onSubmitEditing={onSend}
        placeholder="Message Shogo…"
        placeholderTextColor="rgb(115 115 115)"
        className="flex-1 bg-muted/40 border border-border rounded-full px-4 py-2 text-sm text-foreground"
        returnKeyType="send"
        submitBehavior="blurAndSubmit"
      />
      <Pressable
        onPress={onSend}
        disabled={!canSend}
        className={`rounded-full w-10 h-10 items-center justify-center ${
          canSend ? 'bg-primary' : 'bg-muted'
        }`}
        accessibilityLabel="Send message"
      >
        <Send
          size={16}
          className={canSend ? 'text-primary-foreground' : 'text-muted-foreground'}
        />
      </Pressable>
    </View>
  )
}
