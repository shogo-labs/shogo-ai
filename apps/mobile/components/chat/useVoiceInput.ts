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

// ---------------------------------------------------------------------------
// Web: Browser SpeechRecognition
// ---------------------------------------------------------------------------

function getSpeechRecognitionCtor(): (new () => any) | null {
  if (typeof window === 'undefined') return null
  return (
    (window as any).SpeechRecognition ??
    (window as any).webkitSpeechRecognition ??
    null
  )
}

// ---------------------------------------------------------------------------
// Native: expo-speech-recognition (lazy-loaded so web builds never pull it in)
// ---------------------------------------------------------------------------

let _nativeModuleResolved = false
let _nativeModule: any = null
function getNativeModule(): any {
  if (_nativeModuleResolved) return _nativeModule
  _nativeModuleResolved = true
  if (Platform.OS === 'web') return null
  try {
    // requireOptionalNativeModule returns null (instead of throwing) when
    // the native module isn't linked, e.g. running inside Expo Go.
    const { requireOptionalNativeModule } = require('expo')
    _nativeModule = requireOptionalNativeModule('ExpoSpeechRecognition')
  } catch {
    _nativeModule = null
  }
  return _nativeModule
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void
}

export function useVoiceInput({ onTranscript }: UseVoiceInputOptions) {
  const isMountedRef = useRef(true)
  const transcriptionHandlerRef = useRef(onTranscript)

  // Web-only refs
  const recognitionRef = useRef<any>(null)
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    if (Platform.OS === 'web') return !!getSpeechRecognitionCtor()
    const mod = getNativeModule()
    if (!mod) return false
    try {
      return mod.isRecognitionAvailable()
    } catch {
      return false
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Native event listeners (registered once, active only while mounted)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (Platform.OS === 'web') return
    const mod = getNativeModule()
    if (!mod) return

    const resultSub = mod.addListener('result', (event: any) => {
      if (!isMountedRef.current) return
      const transcript: string = event.results?.[0]?.transcript ?? ''
      const isFinal: boolean = event.isFinal ?? false

      if (isFinal) {
        finalTranscriptRef.current = transcript
      }
      liveTranscriptRef.current = transcript
      setLiveTranscript(transcript)
    })

    const errorSub = mod.addListener('error', (event: any) => {
      if (!isMountedRef.current) return
      const code = event?.error ?? ''
      if (code === 'aborted') return

      if (code === 'no-speech') {
        setError('No speech detected. Please try again.')
      } else if (code === 'not-allowed') {
        setError(
          'Microphone access was blocked. Please allow it in Settings and try again.'
        )
      } else {
        setError(event?.message || `Speech recognition error: ${code}`)
      }

      finalTranscriptRef.current = ''
      liveTranscriptRef.current = ''
      setLiveTranscript('')
      setStatus('idle')
      setElapsedMs(0)
    })

    const endSub = mod.addListener('end', () => {
      if (!isMountedRef.current) return

      const transcript = (
        finalTranscriptRef.current || liveTranscriptRef.current
      ).trim()
      if (transcript) {
        transcriptionHandlerRef.current(transcript)
      }

      finalTranscriptRef.current = ''
      liveTranscriptRef.current = ''
      setLiveTranscript('')
      setStatus('idle')
      setElapsedMs(0)
    })

    return () => {
      resultSub.remove()
      errorSub.remove()
      endSub.remove()
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  const cleanup = useCallback(() => {
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current)
      autoStopTimeoutRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  const startRecording = useCallback(async () => {
    if (!isSupported || status !== 'idle') return
    setError(null)
    finalTranscriptRef.current = ''
    liveTranscriptRef.current = ''
    setLiveTranscript('')
    stoppingRef.current = false

    if (Platform.OS !== 'web') {
      // ---- Native path ----
      const mod = getNativeModule()
      if (!mod) return

      try {
        const perms = await mod.requestPermissionsAsync()
        if (!perms.granted) {
          setError(
            'Microphone / speech recognition permission was denied. Please allow it in Settings.'
          )
          return
        }

        mod.start({
          lang: 'en-US',
          interimResults: true,
          continuous: true,
        })
        setStatus('recording')

        autoStopTimeoutRef.current = setTimeout(() => {
          try {
            mod.stop()
          } catch {}
        }, MAX_RECORDING_MS)
      } catch (err: any) {
        setError(err?.message || 'Failed to start speech recognition.')
      }
      return
    }

    // ---- Web path (unchanged) ----
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return

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
  }, [cleanup, isSupported, status])

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  const stopRecording = useCallback(async () => {
    if (Platform.OS !== 'web') {
      cleanup()
      const mod = getNativeModule()
      if (mod) {
        try {
          mod.stop()
        } catch {}
      }
      return
    }

    const recognition = recognitionRef.current
    if (!recognition) return
    stoppingRef.current = true
    recognition.stop()
  }, [cleanup])

  // ---------------------------------------------------------------------------
  // Toggle
  // ---------------------------------------------------------------------------

  const toggleRecording = useCallback(async () => {
    if (status === 'recording') {
      await stopRecording()
      return
    }
    if (status === 'idle') {
      await startRecording()
    }
  }, [startRecording, status, stopRecording])

  // ---------------------------------------------------------------------------
  // Elapsed timer
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (status !== 'recording') return
    const startedAt = Date.now()
    setElapsedMs(0)
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)
    return () => clearInterval(interval)
  }, [status])

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      isMountedRef.current = false

      if (Platform.OS === 'web') {
        const recognition = recognitionRef.current
        if (recognition) {
          try {
            recognition.abort()
          } catch {}
        }
      } else {
        const mod = getNativeModule()
        if (mod) {
          try {
            mod.abort()
          } catch {}
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
