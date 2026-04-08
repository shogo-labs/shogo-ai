// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'

const MAX_RECORDING_MS = 2 * 60 * 1000

type VoiceStatus = 'idle' | 'recording'

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getSpeechRecognitionCtor(): (new () => any) | null {
  if (typeof window === 'undefined') return null
  return (
    (window as any).SpeechRecognition ??
    (window as any).webkitSpeechRecognition ??
    null
  )
}

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void
}

export function useVoiceInput({ onTranscript }: UseVoiceInputOptions) {
  const isMountedRef = useRef(true)
  const recognitionRef = useRef<any>(null)
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptionHandlerRef = useRef(onTranscript)
  const finalTranscriptRef = useRef('')
  const liveTranscriptRef = useRef('')
  const stoppingRef = useRef(false)

  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [liveTranscript, setLiveTranscript] = useState('')

  useEffect(() => {
    transcriptionHandlerRef.current = onTranscript
  }, [onTranscript])

  const isSupported = useMemo(() => {
    if (Platform.OS !== 'web') return false
    return !!getSpeechRecognitionCtor()
  }, [])

  const cleanup = useCallback(() => {
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current)
      autoStopTimeoutRef.current = null
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const recognition = recognitionRef.current
    if (!recognition) return
    stoppingRef.current = true
    recognition.stop()
  }, [])

  const startRecording = useCallback(async () => {
    if (!isSupported || status !== 'idle') return

    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return

    setError(null)
    finalTranscriptRef.current = ''
    liveTranscriptRef.current = ''
    setLiveTranscript('')
    stoppingRef.current = false

    try {
      const recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = navigator?.language || 'en-US'

      recognition.onresult = (event: any) => {
        let finalText = ''
        let interimText = ''
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            finalText += result[0].transcript
          } else {
            interimText += result[0].transcript
          }
        }
        finalTranscriptRef.current = finalText
        const combined = finalText + interimText
        liveTranscriptRef.current = combined
        setLiveTranscript(combined)
      }

      recognition.onerror = (event: any) => {
        const errorCode = event?.error
        if (errorCode === 'aborted') return

        if (errorCode === 'no-speech') {
          if (!stoppingRef.current) return
          cleanup()
          recognitionRef.current = null
          setStatus('idle')
          setElapsedMs(0)
          setLiveTranscript('')
          setError('No speech detected. Please try again.')
          return
        }

        cleanup()
        recognitionRef.current = null
        setStatus('idle')
        setElapsedMs(0)
        setLiveTranscript('')

        const errorMessages: Record<string, string> = {
          'not-allowed':
            'Microphone access was blocked. Please allow it and try again.',
          'service-not-available':
            'Speech recognition is not available in this browser.',
          network:
            'Network error. Please check your connection and try again.',
        }
        setError(
          errorMessages[errorCode] ||
            `Speech recognition error: ${errorCode}`
        )
      }

      recognition.onend = () => {
        cleanup()
        recognitionRef.current = null

        if (!isMountedRef.current) return

        const transcript = (
          finalTranscriptRef.current || liveTranscriptRef.current
        ).trim()

        if (transcript) {
          transcriptionHandlerRef.current(transcript)
        }

        setStatus('idle')
        setElapsedMs(0)
        setLiveTranscript('')
        finalTranscriptRef.current = ''
        liveTranscriptRef.current = ''
      }

      recognitionRef.current = recognition
      recognition.start()
      setStatus('recording')

      autoStopTimeoutRef.current = setTimeout(() => {
        stopRecording().catch(() => {})
      }, MAX_RECORDING_MS)
    } catch (err: any) {
      cleanup()
      recognitionRef.current = null
      setStatus('idle')
      setElapsedMs(0)
      const msg = String(err?.message || '').toLowerCase()
      if (
        msg.includes('permission') ||
        msg.includes('denied') ||
        msg.includes('notallowederror')
      ) {
        setError(
          'Microphone access was blocked. Please allow it and try again.'
        )
        return
      }
      setError(
        err?.message ||
          'Speech recognition is not available in this browser.'
      )
    }
  }, [cleanup, isSupported, status, stopRecording])

  const toggleRecording = useCallback(async () => {
    if (status === 'recording') {
      await stopRecording()
      return
    }
    if (status === 'idle') {
      await startRecording()
    }
  }, [startRecording, status, stopRecording])

  useEffect(() => {
    if (status !== 'recording') return

    const startedAt = Date.now()
    setElapsedMs(0)
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)

    return () => clearInterval(interval)
  }, [status])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      const recognition = recognitionRef.current
      if (recognition) {
        try {
          recognition.abort()
        } catch {
          // Ignore cleanup errors during unmount.
        }
      }
      cleanup()
    }
  }, [cleanup])

  return {
    canRecord: isSupported,
    clearError: () => setError(null),
    error,
    isBusy: status !== 'idle',
    isRecording: status === 'recording',
    isTranscribing: false as const,
    liveTranscript,
    recordingDurationLabel: formatDuration(elapsedMs),
    status,
    toggleRecording,
  }
}
