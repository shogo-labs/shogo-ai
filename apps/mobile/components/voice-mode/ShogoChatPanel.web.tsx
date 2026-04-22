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
 *   ┌─ Shogo Mode ─────────────────── [×] ┐
 *   │          (audio-reactive sphere)    │
 *   ├─────────────────────────────────────┤
 *   │   (translator thread — messages)    │
 *   ├─────────────────────────────────────┤
 *   │ [mic] [text input .............] [▶]│
 *   └─────────────────────────────────────┘
 *
 * Voice lifecycle (when the mic is active):
 *   - `useVoiceConversation({ signedUrlPath: '/api/voice/signed-url', ... })`
 *     fetches a short-lived ElevenLabs signed URL from the API, opens
 *     a convai WebSocket, and streams audio to/from the shared
 *     "Shogo Mode" agent.
 *   - Tool calls from the voice agent (`send_to_chat`, `set_mode`) are
 *     executed client-side via `createBridgeClientTools(bridge)`.
 *   - Technical-agent replies (emitted by `ChatPanel` through
 *     `bridge.subscribeToAssistant`) are fed back to the voice agent
 *     as contextual updates so it can paraphrase them aloud.
 *
 * Text lifecycle:
 *   - `useTranslatorChat({ clientTools })` runs `@ai-sdk/react`'s
 *     `useChat` against `/api/voice/translator/chat`, with the same
 *     persona server-side. Tool calls are resolved locally via the
 *     same bridge client tools.
 *   - Technical-agent replies are appended to the translator thread
 *     as a user message prefixed `The agent replied: …`, which is
 *     exactly how the persona is instructed to parse them.
 *
 * Scope (V1):
 *   - Web only.
 *   - Single shared agent (ELEVENLABS_VOICE_MODE_AGENT_ID); no
 *     per-user companion store.
 *   - The built-in memory tools / auto-injection inside
 *     `useVoiceConversation` are disabled — the translator has no
 *     memory surface of its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native'
import { Text } from '@/components/ui/text'
import { Keyboard, Mic, MicOff, Send, X } from 'lucide-react-native'
import { ConversationProvider } from '@elevenlabs/react'
import { OrganicSphere, useVoiceConversation } from '@shogo-ai/sdk/voice/react'
import { API_URL } from '../../lib/api'
import { useChatBridge } from './ChatBridgeContext'
import { createBridgeClientTools } from './bridgeClientTools'
import { useTranslatorChat } from './useTranslatorChat'

export interface ShogoChatPanelProps {
  /** Optional extra classes for the outer container. */
  className?: string
}

interface TranscriptEntry {
  id: string
  source: 'user-voice' | 'shogo-voice' | 'agent-reply'
  text: string
}

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
  const clientTools = useMemo(() => createBridgeClientTools(bridge), [bridge])
  const handleClose = useCallback(
    () => bridge.setShogoModeActive(false),
    [bridge],
  )

  const [draft, setDraft] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState<TranscriptEntry[]>([])
  // Input mode — the user picks either voice or text; we only ever show
  // one composer at a time. Default to voice: entering Shogo Mode is an
  // explicit gesture, so we auto-start the mic right away and let the
  // user opt down into text if they prefer.
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice')

  // Text modality — AI SDK chat against /api/voice/translator/chat.
  const {
    messages,
    sendMessage,
    status: textStatus,
  } = useTranslatorChat({ clientTools })

  // Voice modality — ElevenLabs convai session.
  const conversationRef = useRef<{
    sendContextualUpdate: (t: string) => void
  } | null>(null)
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
      if (!message?.trim()) return
      setVoiceTranscript((prev) => [
        ...prev,
        {
          id: `${source}-${Date.now()}-${prev.length}`,
          source: source === 'user' ? 'user-voice' : 'shogo-voice',
          text: message,
        },
      ])
    },
  })
  conversationRef.current = { sendContextualUpdate: conversation.sendContextualUpdate }

  const voiceActive =
    conversation.status === 'connected' || conversation.status === 'connecting'

  // Track the most recent assistant reply so voice can announce it.
  const lastEmittedRef = useRef<string>('')

  // Bridge → panel: pipe finalized technical-agent replies back into
  // the translator (both text thread + live voice session).
  useEffect(() => {
    const unsubscribe = bridge.subscribeToAssistant((assistantText) => {
      const trimmed = assistantText.trim()
      if (!trimmed || trimmed === lastEmittedRef.current) return
      lastEmittedRef.current = trimmed
      const prefixed = `The agent replied: ${trimmed}`

      if (conversationRef.current && voiceActive) {
        try {
          conversationRef.current.sendContextualUpdate(prefixed)
        } catch (err) {
          console.warn('[ShogoChatPanel] sendContextualUpdate failed', err)
        }
        setVoiceTranscript((prev) => [
          ...prev,
          {
            id: `agent-reply-${Date.now()}-${prev.length}`,
            source: 'agent-reply',
            text: trimmed,
          },
        ])
      } else {
        // Text modality: feed the reply in as a user turn so the
        // translator paraphrases it on its next response.
        try {
          void sendMessage({ text: prefixed })
        } catch (err) {
          console.warn('[ShogoChatPanel] sendMessage(agent reply) failed', err)
        }
      }
    })
    return unsubscribe
  }, [bridge, sendMessage, voiceActive])

  // End the voice session when the panel unmounts (user flipped Shogo
  // Mode off, or navigated away).
  useEffect(() => {
    return () => {
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
        onClose={handleClose}
      />

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
                    : 'agent-reply'
                }
                text={t.text}
                badge={
                  t.source === 'user-voice'
                    ? 'voice'
                    : t.source === 'agent-reply'
                    ? 'from chat'
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
        // the sphere scales inside via `style`.
        style={{ height: 400 }}
      >
        <OrganicSphere
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
  onClose,
}: {
  status: 'disconnected' | 'connecting' | 'connected'
  voiceError: string | null
  inputMode: 'voice' | 'text'
  onInputModeChange: (next: 'voice' | 'text') => void
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
          <Text className="text-xs text-muted-foreground truncate">
            Talk in plain English. Shogo handles the technical side.
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
  role: 'user' | 'shogo' | 'agent-reply'
  text: string
  badge?: string
}) {
  if (!text) return null
  const isUser = role === 'user'
  const isAgentReply = role === 'agent-reply'

  const bubbleClass = isUser
    ? 'bg-primary/10 border border-primary/20 self-end'
    : isAgentReply
    ? 'bg-muted/60 border border-border self-start'
    : 'bg-background border border-border self-start'

  const label = isUser ? 'You' : isAgentReply ? 'Shogo Agent' : 'Shogo'

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
      <Text className="text-sm text-foreground">{text}</Text>
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
    <View className="border-t border-border px-3 py-4 items-center gap-2">
      <Pressable
        onPress={onToggleMic}
        className={`rounded-full w-16 h-16 items-center justify-center shadow-lg ${micBgClass}`}
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
