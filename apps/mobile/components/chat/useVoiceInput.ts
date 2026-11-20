// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'
import {
  getDesktopBridge,
  MicPermissionError,
  startDesktopDictation,
  transcribeDesktopClip,
  type DesktopDictation,
} from './desktop-dictation'

const MAX_RECORDING_MS = 2 * 60 * 1000

type VoiceStatus = 'idle' | 'recording' | 'transcribing'

const MIC_BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow Shogo in System Settings > Privacy & Security > Microphone, then try again.'

/** True inside Electron, where microphone errors can link to OS settings. */
function isDesktopApp(): boolean {
  return Platform.OS === 'web' && !!getDesktopBridge()
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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

  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finalTranscriptRef = useRef('')
  const liveTranscriptRef = useRef('')
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {})
  const startingWebCaptureRef = useRef(false)
  // Browser and desktop capture session; see desktop-dictation.ts.
  const desktopRef = useRef<DesktopDictation | null>(null)

  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [micBlocked, setMicBlocked] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [liveTranscript, setLiveTranscript] = useState('')

  useEffect(() => {
    transcriptionHandlerRef.current = onTranscript
  }, [onTranscript])

  const isSupported = useMemo(() => {
    if (Platform.OS === 'web') {
      return !!(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia)
    }
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
    setMicBlocked(false)
    finalTranscriptRef.current = ''
    liveTranscriptRef.current = ''
    setLiveTranscript('')
    if (Platform.OS === 'web') {
      if (startingWebCaptureRef.current) return
      startingWebCaptureRef.current = true
      // Browser SpeechRecognition relies on an external browser speech service
      // and often fails with a generic network error. Capture audio here and
      // send it to Shogo's transcription API instead.
      try {
        const session = await startDesktopDictation()
        if (!isMountedRef.current) {
          session.cancel()
          return
        }
        desktopRef.current = session
        setStatus('recording')
        autoStopTimeoutRef.current = setTimeout(() => {
          stopRecordingRef.current().catch(() => {})
        }, MAX_RECORDING_MS)
      } catch (err: any) {
        desktopRef.current = null
        if (!isMountedRef.current) return
        if (err instanceof MicPermissionError) {
          if (isDesktopApp()) {
            setMicBlocked(true)
            setError(MIC_BLOCKED_MESSAGE)
          } else {
            setError(
              'Microphone access was blocked. Allow microphone access for this site in your browser settings, then try again.'
            )
          }
        } else {
          setError(err?.message || 'Could not start the microphone.')
        }
      } finally {
        startingWebCaptureRef.current = false
      }
      return
    }

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
  }, [isSupported, status])

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  const stopRecording = useCallback(async () => {
    const desktopSession = desktopRef.current
    if (desktopSession) {
      desktopRef.current = null
      cleanup()
      setStatus('transcribing')
      try {
        const wav = await desktopSession.stop()
        const text = wav ? (await transcribeDesktopClip(wav)).trim() : ''
        if (!isMountedRef.current) return
        if (text) {
          transcriptionHandlerRef.current(text)
        } else {
          setError('No speech detected. Please try again.')
        }
      } catch (err: any) {
        if (isMountedRef.current) setError(err?.message || 'Transcription failed. Please try again.')
      } finally {
        if (isMountedRef.current) {
          setStatus('idle')
          setElapsedMs(0)
        }
      }
      return
    }

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
  }, [cleanup])

  useEffect(() => {
    stopRecordingRef.current = stopRecording
  }, [stopRecording])

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

      if (desktopRef.current) {
        desktopRef.current.cancel()
        desktopRef.current = null
      }

      if (Platform.OS !== 'web') {
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
    clearError: () => {
      setError(null)
      setMicBlocked(false)
    },
    error,
    /** Set when Electron can offer the OS microphone settings shortcut. */
    micBlocked,
    openMicSettings: () => {
      void getDesktopBridge()?.openMicrophoneSettings?.()
    },
    isBusy: status !== 'idle',
    isRecording: status === 'recording',
    isTranscribing: status === 'transcribing',
    liveTranscript,
    recordingDurationLabel: formatDuration(elapsedMs),
    status,
    toggleRecording,
  }
}
