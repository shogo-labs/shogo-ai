// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BaseVoiceConversationResult,
  ClientToolFn,
} from '../shared/index.js'

export interface LiveVoiceSessionResponse {
  sessionId: string
  sdp: string
}

export interface UseLiveVoiceConversationOptions {
  /** Mint a GPT-Live WebRTC answer from the browser's SDP offer. */
  mintSession: (sdp: string) => Promise<LiveVoiceSessionResponse>
  clientTools?: Record<string, ClientToolFn>
  onError?: (error: unknown) => void
  onMessage?: (message: { source: string; message: string }) => void
}

export type UseLiveVoiceConversationResult = BaseVoiceConversationResult

type LiveStatus = BaseVoiceConversationResult['status']

interface LiveEvent {
  type?: string
  delta?: string
  content?: string
  event?: LiveEvent
  session?: { id?: string }
  item?: {
    type?: string
    call_id?: string
    name?: string
    arguments?: string
  }
  delegation?: { id?: string }
  error?: { message?: string }
  [key: string]: unknown
}

function parseEvent(data: unknown): LiveEvent | null {
  try {
    const text = typeof data === 'string' ? data : String(data)
    const event = JSON.parse(text) as LiveEvent
    return event && typeof event === 'object' ? event : null
  } catch {
    return null
  }
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onStateChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onStateChange)
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onStateChange)
      resolve()
    }, 2000)
  })
}

function splitContext(text: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += 1800) {
    chunks.push(text.slice(offset, offset + 1800))
  }
  return chunks.length ? chunks : ['']
}

/**
 * GPT-Live WebRTC conversation hook. The API route is injected so this
 * package remains transport-focused and can be used by SDK consumers too.
 */
export function useLiveVoiceConversation(
  options: UseLiveVoiceConversationOptions,
): UseLiveVoiceConversationResult {
  const { mintSession } = options
  const [status, setStatus] = useState<LiveStatus>('disconnected')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const frequencyRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const speakingFrameRef = useRef<number | null>(null)
  const inputTranscriptRef = useRef('')
  const outputTranscriptRef = useRef('')
  const startedRef = useRef(false)
  const closingRef = useRef(false)
  const mutedRef = useRef(false)

  const emit = useCallback((source: string, message: string) => {
    const text = message.trim()
    if (text) optionsRef.current.onMessage?.({ source, message: text })
  }, [])

  const flushTranscripts = useCallback(() => {
    const input = inputTranscriptRef.current.trim()
    const output = outputTranscriptRef.current.trim()
    inputTranscriptRef.current = ''
    outputTranscriptRef.current = ''
    if (input) emit('user', input)
    if (output) emit('agent', output)
  }, [emit])

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const channel = dataChannelRef.current
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event))
  }, [])

  const updateSpeaking = useCallback(() => {
    const analyser = analyserRef.current
    if (analyser) {
      const data = frequencyRef.current ??
        (new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>)
      frequencyRef.current = data
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (const value of data) sum += value
      setIsSpeaking(data.length > 0 && sum / data.length > 8)
    }
    if (pcRef.current) speakingFrameRef.current = requestAnimationFrame(updateSpeaking)
  }, [])

  const handleEvent = useCallback(async (event: LiveEvent) => {
    const nested = event.type === 'response.event' && event.event ? event.event : event
    const type = nested.type ?? ''

    if (type === 'session.started' || type === 'session.created') {
      setStatus('connected')
      setIsListening(!mutedRef.current)
      const id = typeof nested.session?.id === 'string' ? nested.session.id : null
      if (id) setSessionId(id)
    }
    if (type === 'session.closed') {
      flushTranscripts()
      setStatus('disconnected')
      setIsListening(false)
    }
    if (type === 'error') {
      optionsRef.current.onError?.(new Error(event.error?.message || 'GPT-Live error'))
    }
    if (type === 'session.input_transcript.delta' || type === 'input_audio_transcription.delta') {
      inputTranscriptRef.current += event.delta ?? ''
    }
    if (type === 'session.output_transcript.delta' || type === 'response.audio_transcript.delta') {
      outputTranscriptRef.current += event.delta ?? ''
    }
    if (
      type === 'session.input_transcript.done' ||
      type === 'input_audio_transcription.completed' ||
      type === 'session.output_transcript.done' ||
      type === 'response.audio_transcript.done' ||
      type === 'response.done' ||
      type === 'response.completed'
    ) {
      flushTranscripts()
    }

    const item = nested.item
    if (type === 'response.output_item.done' && item?.type === 'function_call') {
      const tool = optionsRef.current.clientTools?.[item.name ?? '']
      if (!tool || !item.call_id) return
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(item.arguments || '{}')
        if (parsed && typeof parsed === 'object') args = parsed
      } catch {
        // The model occasionally completes an empty argument string for
        // zero-argument tools; the empty object is the correct input.
      }
      let output: string
      try {
        output = String(await tool(args))
      } catch (error) {
        output = `Tool failed: ${error instanceof Error ? error.message : String(error)}`
      }
      sendEvent({
        type: 'response.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output,
        },
      })
      sendEvent({ type: 'response.create' })
    }
  }, [flushTranscripts, sendEvent])

  const end = useCallback(() => {
    closingRef.current = true
    flushTranscripts()
    sendEvent({ type: 'session.close' })
    dataChannelRef.current?.close()
    pcRef.current?.close()
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    audioRef.current?.pause()
    if (speakingFrameRef.current !== null) cancelAnimationFrame(speakingFrameRef.current)
    speakingFrameRef.current = null
    pcRef.current = null
    dataChannelRef.current = null
    mediaStreamRef.current = null
    analyserRef.current = null
    frequencyRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    setIsSpeaking(false)
    setIsListening(false)
    setSessionId(null)
    setStatus('disconnected')
  }, [flushTranscripts, sendEvent])

  const startInternal = useCallback(async () => {
    if (status === 'connected' || status === 'connecting') end()
    closingRef.current = false
    setStatus('connecting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const pc = new RTCPeerConnection()
      pcRef.current = pc
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))

      const channel = pc.createDataChannel('oai-events')
      dataChannelRef.current = channel
      channel.onopen = () => {
        if (!closingRef.current) setIsListening(!mutedRef.current)
      }
      channel.onmessage = (message) => {
        const event = parseEvent(message.data)
        if (event) void handleEvent(event)
      }
      channel.onerror = (event) => optionsRef.current.onError?.(event)

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0]
        if (!remoteStream) return
        const audio = new Audio()
        audio.autoplay = true
        audio.srcObject = remoteStream
        audioRef.current = audio
        void audio.play().catch(() => {})
        try {
          const AudioContextImpl =
            window.AudioContext ||
            (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (AudioContextImpl) {
            const context = new AudioContextImpl()
            const source = context.createMediaStreamSource(remoteStream)
            const analyser = context.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)
            audioContextRef.current = context
            analyserRef.current = analyser
            frequencyRef.current = new Uint8Array(analyser.frequencyBinCount)
            if (speakingFrameRef.current === null) {
              speakingFrameRef.current = requestAnimationFrame(updateSpeaking)
            }
          }
        } catch {
          // Audio playback is still useful when analyser APIs are unavailable.
        }
      }
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && !closingRef.current) {
          optionsRef.current.onError?.(new Error(`GPT-Live connection ${pc.connectionState}`))
          end()
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc)
      const localSdp = pc.localDescription?.sdp
      if (!localSdp) throw new Error('Failed to create a WebRTC offer')
      const answer = await mintSession(localSdp)
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      setSessionId(answer.sessionId)
      setStatus('connected')
    } catch (error) {
      end()
      optionsRef.current.onError?.(error)
      throw error
    }
  }, [end, handleEvent, mintSession, status, updateSpeaking])

  const start = useCallback(async () => {
    await startInternal()
  }, [startInternal])

  const restart = useCallback(async () => {
    end()
    await new Promise((resolve) => window.setTimeout(resolve, 120))
    await startInternal()
  }, [end, startInternal])

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted
    mediaStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !muted })
    sendEvent({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' })
    setIsMuted(muted)
    setIsListening(!muted && status === 'connected')
  }, [sendEvent, status])

  const sendContextualUpdate = useCallback((text: string) => {
    for (const content of splitContext(text)) {
      sendEvent({
        type: 'session.thinking.append',
        delegation_id: null,
        content,
      })
    }
  }, [sendEvent])

  const sendUserMessage = useCallback((text: string) => {
    sendEvent({
      type: 'session.commentary.append',
      delegation_id: null,
      content: text,
    })
  }, [sendEvent])

  const sendUserActivity = useCallback(() => {
    sendEvent({ type: 'session.input_audio.commit' })
  }, [sendEvent])

  const getOutputByteFrequencyData = useCallback(() => {
    return frequencyRef.current
  }, [])

  useEffect(() => () => end(), [end])

  return {
    start,
    end,
    restart,
    status,
    isSpeaking,
    isListening,
    isMuted,
    setMuted,
    getOutputByteFrequencyData,
    sendContextualUpdate,
    sendUserMessage,
    sendUserActivity,
    conversationId: sessionId,
    convaiConversationId: sessionId,
  }
}
