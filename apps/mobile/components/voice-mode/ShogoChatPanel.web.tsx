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
 * Layout (no header bar — controls float over the content for a
 * minimal, modern look):
 *
 *   ┌──────────────────────────── [peek] [×] ┐
 *   │           (audio-reactive sphere)       │
 *   ├─────────────────────────────────────────┤
 *   │    (translator thread — messages)       │
 *   ├─────────────────────────────────────────┤
 *   │              ( ◯ mic )                  │   voice mode
 *   │            "Tap to talk"                │
 *   │           [ Type instead ]              │
 *   │                                         │
 *   │   — or —                                │
 *   │                                         │
 *   │ [mic] [text input ...............] [▶] │   text mode
 *   └─────────────────────────────────────────┘
 *
 * Voice lifecycle (cost-conscious):
 *   - ElevenLabs meters web voice agents by connection duration, so
 *     the session is closed by default. `useVoiceConversation` opens
 *     the convai WebSocket only while the user is actively talking
 *     *or* while Shogo is delivering a one-shot spoken summary.
 *   - User press → connect (`'user'` purpose) and listen. A second
 *     press commits the utterance via `sendUserActivity` and ends
 *     the session.
 *   - Heartbeat / turn-end → reconnect with `suppressFirstMessage`,
 *     push the latest activity/final reply as silent context, fire
 *     a `sendUserMessage` nudge so Shogo speaks the summary, then
 *     disconnect once `isSpeaking` settles.
 *   - Pressing the mic while Shogo is speaking a summary interrupts
 *     it (`restart({ suppressFirstMessage: true })`) and converts
 *     the session to user-purpose.
 *   - Tool calls from the voice agent (`send_to_chat`, `set_mode`,
 *     `get_recent_activity`) are executed client-side.
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
import {
  OrganicParticles,
  ShogoVoiceProvider,
  useVoiceConversation,
} from '@shogo-ai/sdk/voice/react'
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
/**
 * Heartbeat cadence during long-running technical-agent turns (ms).
 *
 * Each tick triggers a *one-shot* spoken summary via the summary
 * dispatcher: briefly reconnect to ElevenLabs, ask Shogo to speak, then
 * disconnect once the speech has completed. Between ticks the voice
 * session is fully closed so we are not paying for an idle web voice
 * call (ElevenLabs meters voice agents by connection duration).
 */
const HEARTBEAT_INTERVAL_MS = 30_000
/**
 * After Shogo finishes a summary turn (`isSpeaking` goes false) we wait
 * this long before closing the session. The grace window lets the SDK
 * flush any tail audio frames and keeps reconnects from overlapping.
 */
const SUMMARY_GRACE_AFTER_SPEECH_MS = 1200
/**
 * Watchdog: if Shogo never starts speaking after we send a summary
 * nudge, give up and disconnect. Avoids leaking a paid session if the
 * model decided the prompt didn't warrant speech.
 *
 * Sized to absorb the worst-case path: signed-URL mint (project lookup
 * + ~2s pod fetch for MEMORY/USER context) + EL handshake + LLM
 * response + first audio frame. On a warm path the agent typically
 * starts speaking within 2-3s of `sendUserMessage`; on a cold pod or
 * a slow EL leg it can be 10s+ before the first audio frame.
 */
const SUMMARY_NO_SPEECH_TIMEOUT_MS = 20_000
/**
 * After `turn-start` arrives during an active user voice session, this
 * is the maximum time we'll wait for Shogo to *start* speaking the
 * post-`send_to_chat` confirmation. The watchdog only fires if Shogo
 * never speaks at all (truly hung session); once `isSpeaking` goes
 * true the watchdog is cancelled and the settle watcher takes over,
 * so a long confirmation can run to completion without being cut off.
 *
 * Sized to absorb LLM round-trip + TTS first-frame latency on a slow
 * leg. A typical confirmation starts within 2-3s; 15s leaves ample
 * headroom.
 */
const POST_USER_FIRST_SPEECH_TIMEOUT_MS = 15_000
/**
 * Once Shogo has started speaking the post-`send_to_chat` confirmation
 * and then `isSpeaking` flips back to `false`, wait this long before
 * actually closing the session. ElevenLabs reports `isSpeaking: false`
 * during natural pauses between sentences, so disconnecting on the
 * first false edge cuts Shogo off mid-utterance. The settle window
 * lets brief pauses ride through; if Shogo resumes we cancel the
 * timer and wait for the next silence.
 */
const POST_USER_SETTLE_AFTER_SPEECH_MS = 1200
/**
 * Small delay before tearing down a user-session after the user taps
 * "stop listening". Gives ElevenLabs' VAD a chance to commit the final
 * user transcript before the WebSocket closes.
 */
const STOP_LISTENING_FLUSH_MS = 250
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
 * underlying convai session context. The SDK re-exports it as
 * `<ShogoVoiceProvider>` so consumers don't have to import directly
 * from `@elevenlabs/react`. We mount it here so the rest of the panel
 * (which uses `useVoiceConversation` under the hood) can work.
 */
export function ShogoChatPanel(props: ShogoChatPanelProps) {
  return (
    <ShogoVoiceProvider>
      <ShogoChatPanelInner {...props} />
    </ShogoVoiceProvider>
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
  // explicit gesture, so we surface the mic by default and let the user
  // opt down into text if they prefer. The mic does NOT auto-connect —
  // the user has to tap it to open an ElevenLabs session.
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

  // ---------------------------------------------------------------------
  // Voice session lifecycle. Shogo Mode now connects to ElevenLabs only
  // while the user is actively talking *or* Shogo is in the middle of a
  // one-shot spoken summary; the rest of the time the session is fully
  // closed so we are not paying for an idle web voice call.
  //
  // `sessionPurposeRef` records *why* the connection is live so the mic
  // button and the summary dispatcher can take the right action when it
  // is pressed or when speech completes.
  //
  //   - `'user'`    : the user pressed the mic; we are listening to /
  //                   conversing with them.
  //   - `'summary'` : we are programmatically reconnected to deliver a
  //                   heartbeat or turn-end summary; will disconnect
  //                   once Shogo finishes speaking.
  //   - `null`      : disconnected.
  // ---------------------------------------------------------------------
  type SessionPurpose = 'user' | 'summary' | null
  const sessionPurposeRef = useRef<SessionPurpose>(null)
  // Mirror the ref into React state so the mic UI re-renders when the
  // purpose changes. The ref remains the synchronous source of truth
  // for callbacks/effects that mutate it; we update both together via
  // `setSessionPurpose` below.
  const [sessionPurpose, setSessionPurposeState] = useState<SessionPurpose>(null)
  const setSessionPurpose = useCallback((next: SessionPurpose) => {
    sessionPurposeRef.current = next
    setSessionPurposeState(next)
  }, [])
  /** True when the technical agent is mid-turn (between turn-start and turn-end). */
  const technicalTurnActiveRef = useRef<boolean>(false)
  const [technicalTurnActive, setTechnicalTurnActive] = useState(false)

  // Summary dispatcher state.
  /** True while a summary reconnect → speak → disconnect cycle is active. */
  const summaryInFlightRef = useRef<boolean>(false)
  /** Set once `isSpeaking` goes true during the current summary so we know to wait for it to drop again before disconnecting. */
  const summaryHeardSpeechRef = useRef<boolean>(false)
  /** Pending summary trigger — at most one is queued; latest wins, with `turn-end` always superseding `heartbeat`. */
  const pendingSummaryRef = useRef<{ kind: 'heartbeat' | 'turn-end'; finalText?: string } | null>(null)
  const summaryDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryNoSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Set when `turn-start` arrives while a user session is live — disconnect after Shogo's confirmation finishes. */
  const userPostDisconnectArmedRef = useRef<boolean>(false)
  const userPostDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Set true the first time `isSpeaking` flips true after `turn-start`
   * arms the post-user disconnect. Mirrors `summaryHeardSpeechRef` —
   * we never disconnect on the *initial* `isSpeaking: false` because
   * Shogo may not have started its confirmation yet (or may be in a
   * natural pause). We only act on a confirmed speak → silence
   * transition, with a grace window on top of that.
   */
  const userPostHeardSpeechRef = useRef<boolean>(false)
  const userPostSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Voice session imperative handles — captured in a ref so callbacks
  // declared before `conversation` resolves can still reach the latest
  // methods.
  const conversationRef = useRef<{
    start: (opts?: { suppressFirstMessage?: boolean }) => Promise<void>
    end: () => void
    restart: (opts?: { suppressFirstMessage?: boolean }) => Promise<void>
    sendContextualUpdate: (t: string) => void
    sendUserMessage: (t: string) => void
    sendUserActivity: () => void
    setMuted: (m: boolean) => void
    isSpeaking: boolean
    isListening: boolean
    isMuted: boolean
    voiceActive: boolean
    status: string
  } | null>(null)

  // Client tools exposed to both voice and text modalities. In addition
  // to the bridge-backed `send_to_chat` + `set_mode`, we expose
  // `get_recent_activity` so Shogo can pull the raw activity log when it
  // needs extra material to summarise accurately.
  const clientTools = useMemo(() => {
    const base = createBridgeClientTools(bridge)
    const getRecentActivity = () => {
      const items = recentActivityRef.current.slice(-RECENT_ACTIVITY_MAX)
      if (items.length === 0) return 'No recent background-build activity recorded.'
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
  // Append `chatSessionId` so the API can authorize the session,
  // resolve the owning project, and return a per-session
  // `agentPromptOverride` containing project metadata + memory. The
  // hook plumbs that into `overrides.agent.prompt.prompt` on each
  // ElevenLabs `startSession`, so Shogo gets fresh project context
  // every time we (re)connect — no stale memory across sessions.
  const signedUrlPath = chatSessionId
    ? `${API_URL ?? ''}/api/voice/signed-url?chatSessionId=${encodeURIComponent(chatSessionId)}`
    : `${API_URL ?? ''}/api/voice/signed-url`

  const conversation = useVoiceConversation({
    characterName: 'Shogo',
    signedUrlPath,
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
    start: conversation.start,
    end: conversation.end,
    restart: conversation.restart,
    sendContextualUpdate: conversation.sendContextualUpdate,
    sendUserMessage: conversation.sendUserMessage,
    sendUserActivity: conversation.sendUserActivity,
    setMuted: conversation.setMuted,
    isSpeaking: conversation.isSpeaking,
    isListening: conversation.isListening,
    isMuted: conversation.isMuted,
    voiceActive,
    status: conversation.status,
  }

  // ---------------------------------------------------------------------
  // Spoken-summary dispatcher.
  //
  // ElevenLabs meters web voice agents by connection duration, so we do
  // *not* keep the session warm during long technical-agent turns.
  // Instead, every spoken update (heartbeat tick or turn-end summary)
  // goes through a one-shot reconnect cycle:
  //
  //   1. Connect with `suppressFirstMessage: true` so the agent skips
  //      its configured intro.
  //   2. Push the latest activity/final reply as silent context.
  //   3. Inject a user-role nudge that tells Shogo what to summarise.
  //   4. Mute the mic so the user's environment doesn't accidentally
  //      open a fresh user turn while Shogo is talking.
  //   5. Watch `isSpeaking`. Once Shogo has spoken and gone idle,
  //      disconnect after a short grace window.
  //
  // The dispatcher allows at most one summary in flight. Calls that
  // arrive while a user session is open or a previous summary is still
  // speaking are queued; turn-end always supersedes a queued heartbeat.
  // ---------------------------------------------------------------------
  const cancelSummaryTimers = useCallback(() => {
    if (summaryDisconnectTimerRef.current) {
      clearTimeout(summaryDisconnectTimerRef.current)
      summaryDisconnectTimerRef.current = null
    }
    if (summaryNoSpeechTimerRef.current) {
      clearTimeout(summaryNoSpeechTimerRef.current)
      summaryNoSpeechTimerRef.current = null
    }
  }, [])

  const finishSummary = useCallback(() => {
    cancelSummaryTimers()
    const wasSummary = sessionPurposeRef.current === 'summary'
    summaryHeardSpeechRef.current = false
    summaryInFlightRef.current = false
    if (wasSummary) {
      setSessionPurpose(null)
      try {
        conversationRef.current?.end()
      } catch (err) {
        console.warn('[ShogoChatPanel] failed to end summary session', err)
      }
    }
    // Process anything that queued up while we were busy. Latest wins;
    // a turn-end already supersedes a heartbeat at enqueue time.
    const next = pendingSummaryRef.current
    pendingSummaryRef.current = null
    if (next) {
      // Re-run on the next tick so React state from the disconnect has
      // a chance to settle before we open a new session.
      setTimeout(() => {
        void runSummary(next.kind, next.finalText)
      }, 0)
    }
  }, [cancelSummaryTimers])

  const runSummary = useCallback(
    async (kind: 'heartbeat' | 'turn-end', finalText?: string) => {
      // If the user is mid-conversation, defer — we never want to
      // hijack a live user session for an automated summary.
      if (sessionPurposeRef.current === 'user') {
        const existing = pendingSummaryRef.current
        // turn-end > heartbeat. Latest within same priority wins.
        if (existing?.kind === 'turn-end' && kind === 'heartbeat') return
        pendingSummaryRef.current = { kind, finalText }
        return
      }
      // Already speaking a summary — queue (latest within priority).
      if (summaryInFlightRef.current) {
        const existing = pendingSummaryRef.current
        if (existing?.kind === 'turn-end' && kind === 'heartbeat') return
        pendingSummaryRef.current = { kind, finalText }
        return
      }

      summaryInFlightRef.current = true
      summaryHeardSpeechRef.current = false
      setSessionPurpose('summary')

      // Build the activity diff + nudge text.
      const activity = recentActivityRef.current
      const sliceStart = lastHeartbeatIndexRef.current
      const newItems = activity.slice(sliceStart)
      lastHeartbeatIndexRef.current = activity.length
      const activityBlock =
        newItems.length > 0
          ? `Activity in your background build subsystem since your last update:\n${newItems.join('\n')}`
          : 'No new named activity since your last update, but your background build subsystem is still running.'

      // The nudge prefix (`[UI heartbeat]` / `[UI turn-complete]`)
      // matches the recognition strings in the persona prompt. The
      // body adds an explicit "speak now" instruction so Shogo does
      // not wait for additional user input before responding. Raw
      // activity / final-output material is delivered separately via
      // sendContextualUpdate below, so this nudge stays short.
      const nudge =
        kind === 'heartbeat'
          ? "[UI heartbeat] You're still working on the user's request in the " +
            'background. Give them a two- or three-sentence high-level ' +
            'progress update in business-outcome language — focus on what ' +
            'YOU have accomplished since your previous heartbeat, not what ' +
            "is still pending. Speak in the first person (\"I've…\", \"I'm " +
            'wiring up…"), never refer to "the agent". Do not repeat what ' +
            'you already said last time. Never recite tool names, file ' +
            'names, or a blow-by-blow list of operations. Speak now — do ' +
            'not wait for the user to say anything.'
          : "[UI turn-complete] You just finished the user's request. Give " +
            'them a two- or three-sentence high-level summary of what was ' +
            'accomplished — in business-outcome language (what changed, ' +
            'what it means for them, whether anything is pending). Speak ' +
            'in the first person ("I added…", "I updated…"), never refer ' +
            'to "the agent". Never recite tool names, file names, or a ' +
            'list of operations. Speak now — do not wait for the user to ' +
            'say anything.'

      try {
        const ref = conversationRef.current
        if (!ref) {
          summaryInFlightRef.current = false
          setSessionPurpose(null)
          return
        }
        // Ensure a clean connection. If somehow already live (race), use
        // restart() to clear any in-flight speech and skip the intro.
        if (ref.voiceActive) {
          await ref.restart({ suppressFirstMessage: true })
        } else {
          await ref.start({ suppressFirstMessage: true })
        }
        // `await ref.start()` resolves when the WS is open, but EL's
        // server still has to send the `conversation_initiation_metadata`
        // frame before it will act on a user_message. Empirically,
        // user_message frames sent in the same tick as start() are
        // sometimes silently dropped — the agent never responds and
        // the watchdog tears the session down. Poll briefly until
        // `status === 'connected'` (a proxy for "the SDK is fully
        // ready") before sending. Cap the wait so we still hit the
        // no-speech watchdog if the connection truly never establishes.
        const deadline = Date.now() + 5_000
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const cur = conversationRef.current
          if (!cur) return
          if (cur.status === 'connected') break
          if (Date.now() > deadline) break
          await new Promise((r) => setTimeout(r, 100))
        }
        const ref2 = conversationRef.current
        if (!ref2) return
        // Mute input audio first, before any agent speech — the user's
        // ambient noise should not open a new user turn while Shogo is
        // summarising. Doing this before sending the nudge avoids a
        // race where the agent picks up mic audio mid-startup.
        try {
          ref2.setMuted(true)
        } catch {
          /* best effort */
        }
        // Prime context with the activity log + final reply (silent —
        // does not trigger a response on its own), then send the
        // user-role nudge that asks Shogo to actually speak. Keeping
        // these as separate frames seems to make the agent more
        // reliable about responding than packing everything into a
        // single user_message.
        try {
          if (kind === 'turn-end' && finalText) {
            ref2.sendContextualUpdate(
              `You just produced this output in the background: ${finalText}`,
            )
          }
          ref2.sendContextualUpdate(activityBlock)
        } catch (err) {
          console.warn('[ShogoChatPanel] sendContextualUpdate failed', err)
        }
        try {
          ref2.sendUserMessage(nudge)
        } catch (err) {
          console.warn('[ShogoChatPanel] summary sendUserMessage failed', err)
        }
        // Belt-and-braces: ping user-activity so EL flushes any
        // pending VAD/turn-detection state and processes the
        // user_message immediately.
        try {
          ref2.sendUserActivity()
        } catch {
          /* best effort */
        }
        // Watchdog: if Shogo never starts speaking, disconnect anyway
        // so we are not paying for a connected-but-silent session.
        cancelSummaryTimers()
        summaryNoSpeechTimerRef.current = setTimeout(() => {
          summaryNoSpeechTimerRef.current = null
          if (!summaryHeardSpeechRef.current && summaryInFlightRef.current) {
            console.warn(
              '[ShogoChatPanel] summary timed out without speech — disconnecting',
            )
            finishSummary()
          }
        }, SUMMARY_NO_SPEECH_TIMEOUT_MS)
      } catch (err) {
        console.warn('[ShogoChatPanel] summary connect failed', err)
        cancelSummaryTimers()
        summaryInFlightRef.current = false
        setSessionPurpose(null)
        try {
          conversationRef.current?.end()
        } catch {
          /* best effort */
        }
      }
    },
    [cancelSummaryTimers, finishSummary, setSessionPurpose],
  )

  // ---------------------------------------------------------------------
  // Heartbeat scheduler — fires while the technical agent is mid-turn.
  // Each tick triggers a one-shot summary via `runSummary`; the
  // dispatcher above takes care of deferring/queuing as needed and
  // closes the connection again when speech completes.
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
      void runSummary('heartbeat')
    }, HEARTBEAT_INTERVAL_MS)
  }, [stopHeartbeat, runSummary])

  // ---------------------------------------------------------------------
  // ChatBridge subscription — the authoritative data source for Shogo's
  // awareness of the technical agent.
  // ---------------------------------------------------------------------
  // Keep the latest `sendMessage` in a ref so the subscribe effect
  // doesn't need to resubscribe every render.
  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage
  const inputModeRef = useRef(inputMode)
  inputModeRef.current = inputMode

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

    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === 'turn-start') {
        recentActivityRef.current = ['Turn started.']
        lastHeartbeatIndexRef.current = recentActivityRef.current.length
        technicalTurnActiveRef.current = true
        setTechnicalTurnActive(true)
        // Cancel anything queued — fresh turn means new context.
        pendingSummaryRef.current = null
        startHeartbeat()
        // The user just submitted (Shogo invoked send_to_chat). If a
        // user voice session is still live, arm a deferred disconnect
        // that fires once Shogo's confirmation finishes speaking. We
        // don't end immediately because we want Shogo's "Got it…"
        // confirmation to play out cleanly.
        if (sessionPurposeRef.current === 'user') {
          userPostDisconnectArmedRef.current = true
          // Fresh arm — we have not yet seen Shogo speak the
          // post-`send_to_chat` confirmation, so the watcher must wait
          // for `isSpeaking: true` before being eligible to disconnect.
          userPostHeardSpeechRef.current = false
          if (userPostSettleTimerRef.current) {
            clearTimeout(userPostSettleTimerRef.current)
            userPostSettleTimerRef.current = null
          }
          if (userPostDisconnectTimerRef.current) {
            clearTimeout(userPostDisconnectTimerRef.current)
          }
          userPostDisconnectTimerRef.current = setTimeout(() => {
            userPostDisconnectTimerRef.current = null
            // First-speech watchdog. We only force-disconnect here if
            // Shogo never spoke at all within the deadline (truly
            // hung session). Once Shogo starts speaking, the watcher
            // effect cancels this timer and the settle watcher owns
            // the disconnect — so a long confirmation can finish
            // cleanly without getting cut off mid-sentence.
            if (!userPostDisconnectArmedRef.current) return
            if (sessionPurposeRef.current !== 'user') return
            if (
              userPostHeardSpeechRef.current ||
              conversationRef.current?.isSpeaking
            ) {
              return
            }
            userPostDisconnectArmedRef.current = false
            userPostHeardSpeechRef.current = false
            if (userPostSettleTimerRef.current) {
              clearTimeout(userPostSettleTimerRef.current)
              userPostSettleTimerRef.current = null
            }
            setSessionPurpose(null)
            try {
              conversationRef.current?.end()
            } catch {
              /* best effort */
            }
          }, POST_USER_FIRST_SPEECH_TIMEOUT_MS)
        }
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
        // No `sendContextualUpdate` here — during technical-agent work
        // we are deliberately disconnected from ElevenLabs to avoid
        // paying for an idle voice session. The activity log lives in
        // `recentActivityRef`, which the next heartbeat / turn-end
        // summary picks up via `get_recent_activity` or its diff
        // block. We still mirror it into the on-screen transcript so
        // the user has visibility if they look.
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
      technicalTurnActiveRef.current = false
      setTechnicalTurnActive(false)
      const { finalText } = event
      pushActivity(
        finalText ? `Turn ended. Final reply: ${finalText.slice(0, 500)}` : 'Turn ended.',
      )

      // Mirror the final reply into the on-screen transcript regardless
      // of modality — the user should always be able to scroll back.
      if (finalText) {
        mirrorTranscript('agent-reply', finalText)
      }

      // Cancel a queued heartbeat — turn-end takes priority.
      if (pendingSummaryRef.current?.kind === 'heartbeat') {
        pendingSummaryRef.current = null
      }

      if (inputModeRef.current === 'voice') {
        // Voice modality: deliver the spoken summary via the dispatcher.
        // It will reconnect (if needed), have Shogo speak once, then
        // disconnect again.
        void runSummary('turn-end', finalText)
      } else if (finalText) {
        // Text modality: feed the reply into the translator thread as
        // a user turn so it paraphrases on its next response.
        try {
          void sendMessageRef.current({
            text: `[UI turn-complete] You just produced this output in the background: ${finalText}\n\nGive the user a two- or three-sentence high-level summary in business-outcome language. Speak in the first person — never refer to "the agent".`,
          })
        } catch (err) {
          console.warn('[ShogoChatPanel] sendMessage(turn-complete) failed', err)
        }
      }
    })
    return unsubscribe
  }, [bridge, startHeartbeat, stopHeartbeat, runSummary, setSessionPurpose])

  // Tear down voice session + heartbeat on unmount (user flipped Shogo
  // Mode off, or navigated away).
  useEffect(() => {
    return () => {
      stopHeartbeat()
      cancelSummaryTimers()
      if (userPostDisconnectTimerRef.current) {
        clearTimeout(userPostDisconnectTimerRef.current)
        userPostDisconnectTimerRef.current = null
      }
      if (userPostSettleTimerRef.current) {
        clearTimeout(userPostSettleTimerRef.current)
        userPostSettleTimerRef.current = null
      }
      // Setting state during unmount is a no-op (component is gone) but
      // updating the ref is still important if React reuses this hook
      // tree under a fast-refresh or strict-mode remount.
      sessionPurposeRef.current = null
      pendingSummaryRef.current = null
      summaryInFlightRef.current = false
      userPostDisconnectArmedRef.current = false
      userPostHeardSpeechRef.current = false
      try {
        conversation.end()
      } catch {
        // no-op — already disconnected.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------
  // Summary lifecycle watcher.
  //
  // While a summary is in flight we wait for `isSpeaking` to go true
  // (Shogo started talking), then back to false (Shogo finished), and
  // schedule the disconnect after a small grace window. If the user
  // interrupts via the mic button, `handleToggleMic` flips the purpose
  // to `'user'` so this effect bails out without disconnecting.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (sessionPurposeRef.current !== 'summary') return
    if (!summaryInFlightRef.current) return
    if (conversation.isSpeaking) {
      summaryHeardSpeechRef.current = true
      if (summaryDisconnectTimerRef.current) {
        clearTimeout(summaryDisconnectTimerRef.current)
        summaryDisconnectTimerRef.current = null
      }
      return
    }
    if (!summaryHeardSpeechRef.current) return
    if (summaryDisconnectTimerRef.current) return
    summaryDisconnectTimerRef.current = setTimeout(() => {
      summaryDisconnectTimerRef.current = null
      finishSummary()
    }, SUMMARY_GRACE_AFTER_SPEECH_MS)
  }, [conversation.isSpeaking, finishSummary])

  // ---------------------------------------------------------------------
  // Post-user-disconnect watcher.
  //
  // When `turn-start` arrives during a live user session (Shogo just
  // called `send_to_chat`) we arm a deferred disconnect. The disconnect
  // is gated by two conditions, both required:
  //
  //   1. Shogo has actually started speaking the confirmation (the
  //      `userPostHeardSpeech` flip — `isSpeaking` went true at least
  //      once after the arm). Without this we would tear down before
  //      Shogo got a word out.
  //   2. `isSpeaking` has been false for `POST_USER_SETTLE_AFTER_SPEECH_MS`.
  //      ElevenLabs flips `isSpeaking` to false during natural pauses
  //      between sentences; without the settle window we cut Shogo off
  //      mid-utterance the moment it inhales.
  //
  // The `POST_USER_DISCONNECT_TIMEOUT_MS` watchdog (set in the bridge
  // handler) provides a hard cap if `isSpeaking` somehow never settles.
  // ---------------------------------------------------------------------
  const finishUserPostDisconnect = useCallback(() => {
    if (userPostSettleTimerRef.current) {
      clearTimeout(userPostSettleTimerRef.current)
      userPostSettleTimerRef.current = null
    }
    userPostDisconnectArmedRef.current = false
    userPostHeardSpeechRef.current = false
    if (userPostDisconnectTimerRef.current) {
      clearTimeout(userPostDisconnectTimerRef.current)
      userPostDisconnectTimerRef.current = null
    }
    setSessionPurpose(null)
    try {
      conversationRef.current?.end()
    } catch {
      /* best effort */
    }
  }, [setSessionPurpose])

  useEffect(() => {
    if (!userPostDisconnectArmedRef.current) return
    if (sessionPurposeRef.current !== 'user') {
      // Purpose changed out from under us (e.g. handleToggleMic stopped
      // the session early) — clean up timers and disarm. No teardown
      // here; whoever changed the purpose owns it.
      userPostDisconnectArmedRef.current = false
      userPostHeardSpeechRef.current = false
      if (userPostDisconnectTimerRef.current) {
        clearTimeout(userPostDisconnectTimerRef.current)
        userPostDisconnectTimerRef.current = null
      }
      if (userPostSettleTimerRef.current) {
        clearTimeout(userPostSettleTimerRef.current)
        userPostSettleTimerRef.current = null
      }
      return
    }
    if (conversation.isSpeaking) {
      // Shogo (re)started speaking — record it, cancel the
      // first-speech watchdog (settle watcher now owns disconnect),
      // and cancel any pending settle. We will get another effect
      // tick when speech ends.
      userPostHeardSpeechRef.current = true
      if (userPostDisconnectTimerRef.current) {
        clearTimeout(userPostDisconnectTimerRef.current)
        userPostDisconnectTimerRef.current = null
      }
      if (userPostSettleTimerRef.current) {
        clearTimeout(userPostSettleTimerRef.current)
        userPostSettleTimerRef.current = null
      }
      return
    }
    // Not speaking — only proceed if we *heard* speech first. The
    // initial `isSpeaking: false` right after `turn-start` arms us is
    // not a real pause; ignore it.
    if (!userPostHeardSpeechRef.current) return
    if (userPostSettleTimerRef.current) return
    userPostSettleTimerRef.current = setTimeout(() => {
      userPostSettleTimerRef.current = null
      // Re-validate state at fire time — purpose / armed / speaking
      // may have flipped while we were waiting.
      if (!userPostDisconnectArmedRef.current) return
      if (sessionPurposeRef.current !== 'user') return
      if (conversationRef.current?.isSpeaking) return
      finishUserPostDisconnect()
    }, POST_USER_SETTLE_AFTER_SPEECH_MS)
  }, [conversation.isSpeaking, conversation.status, finishUserPostDisconnect])

  // ---------------------------------------------------------------------
  // Defensive: if the SDK reports a `disconnected` status while we
  // still think a session is live (e.g. the server dropped us), reset
  // our purpose tracking so the next mic press starts cleanly.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (conversation.status !== 'disconnected') return
    if (sessionPurposeRef.current === null) return
    setSessionPurpose(null)
    summaryInFlightRef.current = false
    summaryHeardSpeechRef.current = false
    cancelSummaryTimers()
    // Mirror the cleanup for the user post-disconnect watcher so a
    // surprise SDK-level disconnect doesn't leave stale armed/timer
    // state that fires against the next session.
    userPostDisconnectArmedRef.current = false
    userPostHeardSpeechRef.current = false
    if (userPostDisconnectTimerRef.current) {
      clearTimeout(userPostDisconnectTimerRef.current)
      userPostDisconnectTimerRef.current = null
    }
    if (userPostSettleTimerRef.current) {
      clearTimeout(userPostSettleTimerRef.current)
      userPostSettleTimerRef.current = null
    }
  }, [conversation.status, cancelSummaryTimers, setSessionPurpose])

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

  // Mic button behaviour. The mic is now the single visible control for
  // the voice session lifecycle, and its meaning depends on what state
  // we are in:
  //
  //   - Disconnected (idle or technical agent working)
  //       → Connect a fresh user-purpose session and start listening.
  //   - Listening to the user (`'user'` purpose, connected)
  //       → "Stop listening / send" — push a `sendUserActivity` nudge
  //         to encourage VAD to commit the final transcript, then
  //         disconnect after a tiny flush window.
  //   - Shogo is mid-summary (`'summary'` purpose)
  //       → Interrupt: cancel the summary, restart the session with
  //         `suppressFirstMessage` so any in-flight speech is cut off,
  //         and immediately switch to user-purpose listening. This is
  //         the user's "click the microphone to interrupt the agent"
  //         affordance.
  const handleToggleMic = useCallback(async () => {
    setVoiceError(null)
    const ref = conversationRef.current
    if (!ref) return

    // 1) Interrupt-and-listen path.
    if (sessionPurposeRef.current === 'summary') {
      cancelSummaryTimers()
      pendingSummaryRef.current = null
      summaryInFlightRef.current = false
      summaryHeardSpeechRef.current = false
      setSessionPurpose('user')
      try {
        await ref.restart({ suppressFirstMessage: true })
        try {
          conversationRef.current?.setMuted(false)
        } catch {
          /* best effort */
        }
      } catch (err: unknown) {
        console.warn(
          '[ShogoChatPanel] interrupt-and-listen restart failed',
          err,
        )
        setSessionPurpose(null)
        setVoiceError(
          (err as Error)?.message || 'Could not restart voice session.',
        )
      }
      return
    }

    // 2) Stop-listening path.
    if (sessionPurposeRef.current === 'user' && ref.voiceActive) {
      setSessionPurpose(null)
      userPostDisconnectArmedRef.current = false
      userPostHeardSpeechRef.current = false
      if (userPostSettleTimerRef.current) {
        clearTimeout(userPostSettleTimerRef.current)
        userPostSettleTimerRef.current = null
      }
      if (userPostDisconnectTimerRef.current) {
        clearTimeout(userPostDisconnectTimerRef.current)
        userPostDisconnectTimerRef.current = null
      }
      try {
        ref.sendUserActivity()
      } catch {
        /* best effort — older SDKs may lack this */
      }
      // Small flush window so VAD can commit a final user transcript
      // before we tear down the WebSocket.
      setTimeout(() => {
        try {
          conversationRef.current?.end()
        } catch {
          /* best effort */
        }
      }, STOP_LISTENING_FLUSH_MS)
      return
    }

    // 3) Connect-and-listen path (disconnected or stale state).
    //
    // Always start with `suppressFirstMessage: true`. The agent has a
    // configured greeting ("Hi, I'm Shogo. Tell me what you'd like to
    // work on…") which on connect plays unprompted and then gets
    // immediately cut off as soon as the user starts talking — feels
    // like a bug. The Shogo Mode panel already shows a written intro
    // in its empty state, so we never need a spoken intro on a fresh
    // user session.
    setSessionPurpose('user')
    try {
      await ref.start({ suppressFirstMessage: true })
      try {
        conversationRef.current?.setMuted(false)
      } catch {
        /* best effort */
      }
    } catch (err: unknown) {
      setSessionPurpose(null)
      console.warn('[ShogoChatPanel] failed to start voice session', err)
      setVoiceError(
        (err as Error)?.message ||
          'Could not start voice session. Check microphone permissions.',
      )
    }
  }, [cancelSummaryTimers, setSessionPurpose])

  // When the user flips back to text mode we end any live voice session —
  // we never want the mic hot while the voice composer is hidden.
  const handleSetInputMode = useCallback(
    (next: 'voice' | 'text') => {
      setInputMode(next)
      setVoiceError(null)
      if (next === 'text') {
        cancelSummaryTimers()
        pendingSummaryRef.current = null
        summaryInFlightRef.current = false
        summaryHeardSpeechRef.current = false
        setSessionPurpose(null)
        userPostDisconnectArmedRef.current = false
        userPostHeardSpeechRef.current = false
        if (userPostSettleTimerRef.current) {
          clearTimeout(userPostSettleTimerRef.current)
          userPostSettleTimerRef.current = null
        }
        if (userPostDisconnectTimerRef.current) {
          clearTimeout(userPostDisconnectTimerRef.current)
          userPostDisconnectTimerRef.current = null
        }
        if (voiceActive) {
          try {
            conversation.end()
          } catch {
            // no-op.
          }
        }
      }
    },
    [conversation, voiceActive, cancelSummaryTimers, setSessionPurpose],
  )

  const scrollRef = useRef<ScrollView | null>(null)
  useEffect(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true })
  }, [messages.length, voiceTranscript.length])

  const isVoiceMode = inputMode === 'voice'

  return (
    <View className={className ?? 'flex-1 bg-background'}>
      {/* Floating top-right controls. No header bar; the controls
          hover over the content for a less chrome-heavy look. */}
      <View className="absolute top-3 right-3 z-10 flex-row items-center gap-1">
        <Pressable
          onPress={handlePeek}
          className="p-2 rounded-full hover:bg-muted/60 active:bg-muted"
          accessibilityLabel="Peek at technical chat"
        >
          <Eye size={16} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={handleClose}
          className="p-2 rounded-full hover:bg-muted/60 active:bg-muted"
          accessibilityLabel="Exit Shogo Mode"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>

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
          onSwitchToText={() => handleSetInputMode('text')}
          voiceActive={voiceActive}
          voiceConnecting={conversation.status === 'connecting'}
          voiceSpeaking={conversation.isSpeaking}
          voiceListening={conversation.isListening}
          voiceError={voiceError}
          isUserSession={sessionPurpose === 'user'}
          isSummarySession={sessionPurpose === 'summary'}
          technicalTurnActive={technicalTurnActive}
        />
      ) : (
        <TextComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSendText}
          onSwitchToVoice={() => handleSetInputMode('voice')}
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
    ? ''
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
        style={{ height: 350 }}
      >
        <OrganicParticles
          config={SHOGO_PARTICLES_CONFIG}
          getFrequencyData={getFrequencyData}
          active={voiceActive}
          style={{ width: '100%', height: '100%' }}
        />
      </View>
      {/* <Text className="text-xs text-muted-foreground pb-2">{caption}</Text> */}
    </View>
  )
}

function EmptyState({ mode }: { mode: 'voice' | 'text' }) {
  const hint =
    mode === 'voice'
      ? "Tap the mic to start talking. I'll get the work going in the background and pop back in to summarize as I go — no idle voice connection in between."
      : "Type what you'd like to work on below. I'll handle it in the background and summarize what I did back to you in plain English."
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
 *
 * The mic is the *only* control here, and its meaning depends on the
 * voice session lifecycle:
 *
 *   - Disconnected, technical agent idle  → "Tap to talk".
 *   - Disconnected, technical agent busy  → dimmed but tappable; lets
 *                                            the user start a fresh
 *                                            voice instruction.
 *   - Connected, user purpose             → "Listening — tap to send".
 *   - Connected, summary purpose          → "Shogo is speaking — tap to
 *                                            interrupt".
 */
function VoiceComposer({
  onToggleMic,
  onSwitchToText,
  voiceActive,
  voiceConnecting,
  voiceSpeaking,
  voiceListening,
  voiceError,
  isUserSession,
  isSummarySession,
  technicalTurnActive,
}: {
  onToggleMic: () => void
  onSwitchToText: () => void
  voiceActive: boolean
  voiceConnecting: boolean
  voiceSpeaking: boolean
  voiceListening: boolean
  voiceError: string | null
  isUserSession: boolean
  isSummarySession: boolean
  technicalTurnActive: boolean
}) {
  // Visual states (in precedence order):
  //   summary-active  → emerald (Shogo is speaking; tap to interrupt)
  //   user-listening  → primary (VAD says the user is talking)
  //   user-connected  → primary/80 (connected, idle mic)
  //   connecting      → amber
  //   idle-busy       → muted-foreground (technical agent working)
  //   idle            → primary (tap to talk)
  const micBgClass = voiceActive
    ? isSummarySession
      ? 'bg-emerald-500'
      : voiceListening
      ? 'bg-primary'
      : 'bg-primary/80'
    : voiceConnecting
    ? 'bg-amber-500'
    : technicalTurnActive
    ? 'bg-muted-foreground/60'
    : 'bg-primary'
  const micIconClass = 'text-primary-foreground'

  // Caption mirrors the same precedence so the text and color always
  // agree on what state we are in.
  const caption = voiceError
    ? voiceError
    : isSummarySession && voiceSpeaking
    ? 'Shogo is speaking — tap to interrupt'
    : isSummarySession
    ? 'Shogo is preparing a summary…'
    : isUserSession && voiceActive
    ? 'Listening — tap to send'
    : voiceConnecting
    ? 'Connecting…'
    : technicalTurnActive
    ? 'Technical agent is working — tap to talk'
    : 'Tap to talk'

  const micAccessibilityLabel = isSummarySession
    ? 'Interrupt Shogo and start talking'
    : isUserSession && voiceActive
    ? 'Stop listening and send'
    : 'Start voice session'

  // Render the off-icon when we are disconnected during technical-agent
  // work — visually communicates that the mic is currently inactive
  // even though tapping still starts a user voice instruction.
  const showMicOff = !voiceActive && technicalTurnActive

  return (
    <View className="relative px-3 pt-3 pb-4 items-center gap-2">
      <Pressable
        onPress={onToggleMic}
        className={`rounded-full w-16 h-16 items-center justify-center shadow-lg ${micBgClass}`}
        accessibilityLabel={micAccessibilityLabel}
      >
        {showMicOff ? (
          <MicOff size={28} className={micIconClass} />
        ) : (
          <Mic size={28} className={micIconClass} />
        )}
      </Pressable>
      <Text
        className={`text-xs text-center ${
          voiceError ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {caption}
      </Text>
      <Pressable
        onPress={onSwitchToText}
        className="absolute bottom-3 right-3 flex-row items-center gap-1.5 px-3 py-1.5 rounded-full hover:bg-muted/60 active:bg-muted"
        accessibilityLabel="Switch to text input"
      >
        <Keyboard size={12} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground">Type instead</Text>
      </Pressable>
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
  onSwitchToVoice,
}: {
  draft: string
  onDraftChange: (v: string) => void
  onSend: () => void
  onSwitchToVoice: () => void
}) {
  const canSend = draft.trim().length > 0

  return (
    <View className="px-3 pb-3 pt-2 flex-row items-center gap-2">
      <Pressable
        onPress={onSwitchToVoice}
        className="rounded-full w-10 h-10 items-center justify-center hover:bg-muted/60 active:bg-muted"
        accessibilityLabel="Switch to voice input"
      >
        <Mic size={18} className="text-muted-foreground" />
      </Pressable>
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
