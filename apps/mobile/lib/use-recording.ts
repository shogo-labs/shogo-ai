// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { createHttpClient, API_URL } from './api'
import { usePlatformConfig } from './platform-config'
import { useNativeRecorder } from './native-recorder'
import {
  LiveTranscriptionError,
  meetingsApi,
  notifyMeetingsChanged,
  postLiveChunk,
  uploadMeetingAudio,
  usePersonalMeetingsWorkspaceId,
  type TranscriptSegmentView,
} from './meetings-api'
import { startLiveCapture, type LiveCapture } from './live-audio'

export { formatDuration } from './format-duration'

/**
 * Rough notes typed while recording, shared by every `useRecording()` caller
 * so stopping from the floating indicator still sends what the meetings
 * screen captured.
 */
let recordingNotes = ''
const notesListeners = new Set<() => void>()
function setRecordingNotes(next: string) {
  recordingNotes = next
  notesListeners.forEach((l) => l())
}
function subscribeRecordingNotes(listener: () => void) {
  notesListeners.add(listener)
  return () => notesListeners.delete(listener)
}
const getRecordingNotes = () => recordingNotes

export interface LiveTranscriptState {
  segments: TranscriptSegmentView[]
  /** Why live transcription stopped, shown instead of the transcript. */
  unavailable: string | null
}

const EMPTY_LIVE: LiveTranscriptState = { segments: [], unavailable: null }
let liveTranscript: LiveTranscriptState = EMPTY_LIVE
const liveListeners = new Set<() => void>()
function setLiveTranscript(next: Partial<LiveTranscriptState> | null) {
  liveTranscript = next ? { ...liveTranscript, ...next } : EMPTY_LIVE
  liveListeners.forEach((l) => l())
}
function subscribeLive(listener: () => void) {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}
const getLiveTranscript = () => liveTranscript

function newRecordingId(): string {
  return `wrec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getDesktop(): any | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const d = (window as any).shogoDesktop
  return d?.isDesktop ? d : null
}

/**
 * Hook for managing meeting recording state.
 *
 * Works in four modes:
 *  - Electron desktop: communicates via window.shogoDesktop IPC bridge
 *  - Browser/local mode: captures audio via MediaRecorder, uploads to API
 *  - Browser/cloud and native phone: records locally, uploads to the
 *    personal workspace for server-side transcription
 *  - API polling fallback: polls status for external recording sources
 *
 * Notes typed while recording are saved to the recording's draft meeting
 * when the server knows the recording id (desktop + local), and sent with
 * the upload otherwise.
 */
export function useRecording() {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const desktop = useRef(getDesktop())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const durationRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const recordingStartTime = useRef<number>(0)
  const { localMode, configLoaded } = usePlatformConfig()
  const native = useNativeRecorder()
  const workspaceId = usePersonalMeetingsWorkspaceId()
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const notes = useSyncExternalStore(subscribeRecordingNotes, getRecordingNotes, getRecordingNotes)
  const live = useSyncExternalStore(subscribeLive, getLiveTranscript, getLiveTranscript)
  const [error, setError] = useState<string | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveCaptureRef = useRef<LiveCapture | null>(null)

  /** Chunk the browser's mic stream into the draft meeting's live transcript. */
  const startLive = useCallback((stream: MediaStream, liveRecordingId: string) => {
    setLiveTranscript(null)
    let announced = false
    const capture = startLiveCapture(stream, async (chunk) => {
      // Read at send time: recording can start before the workspace id loads.
      const wsId = workspaceIdRef.current
      if (!wsId) return
      try {
        const res = await postLiveChunk(wsId, liveRecordingId, chunk)
        setLiveTranscript({ segments: res.transcript.segments, unavailable: null })
        if (!announced) {
          announced = true
          notifyMeetingsChanged()
        }
      } catch (err) {
        if (err instanceof LiveTranscriptionError && (err.status === 503 || err.status === 409 || err.status === 404)) {
          if (err.status === 503) setLiveTranscript({ unavailable: err.message })
          capture?.stop({ discard: true })
        }
      }
    })
    liveCaptureRef.current = capture
  }, [])

  const stopLive = useCallback(() => {
    liveCaptureRef.current?.stop()
    liveCaptureRef.current = null
  }, [])

  // Electron IPC mode
  useEffect(() => {
    const d = desktop.current
    if (!d) return

    d.getRecordingStatus().then((status: any) => {
      setIsRecording(status.isRecording)
      setDuration(status.duration)
      setRecordingId(status.id)
    })

    const onStarted = (data: { id: string; path: string }) => {
      setIsRecording(true)
      setRecordingId(data.id)
      setDuration(0)
      setRecordingNotes('')
      setLiveTranscript(null)
    }

    const onDuration = (data: { id: string; duration: number }) => {
      setDuration(data.duration)
    }

    const onStopped = (data: { id: string; audioPath: string; duration: number }) => {
      setIsRecording(false)
      setRecordingId(null)
      setDuration(0)

      // In the Electron IPC flow, we create the meeting here because the API's
      // /recording/stop endpoint is not called (only IPC is used).
      // `recordingId` finishes the draft the island's notepad wrote into.
      const http = createHttpClient()
      http.post('/api/local/meetings', {
        audioPath: data.audioPath,
        duration: data.duration,
        recordingId: data.id,
      })
        .catch((err: any) => console.error('Failed to create meeting record:', err))
        .finally(notifyMeetingsChanged)
      setRecordingNotes('')
      setLiveTranscript(null)
    }

    d.onRecordingStarted(onStarted)
    d.onRecordingDuration(onDuration)
    d.onRecordingStopped(onStopped)

    return () => {
      d.removeRecordingListeners?.()
    }
  }, [])

  // Desktop: the main process transcribes chunks into the draft; read them back.
  useEffect(() => {
    if (!desktop.current || !isRecording || !recordingId || !workspaceId) return
    let cancelled = false
    const api = meetingsApi(workspaceId)
    const poll = async () => {
      const draft = await api.getRecordingDraft(recordingId)
      if (cancelled || !draft?.transcript) return
      try {
        const parsed = JSON.parse(draft.transcript)
        if (Array.isArray(parsed.segments)) setLiveTranscript({ segments: parsed.segments })
      } catch {}
    }
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [isRecording, recordingId, workspaceId])

  // API polling mode (non-Electron, local only): poll frequently while recording, slowly when idle
  useEffect(() => {
    if (desktop.current) return
    if (Platform.OS !== 'web') return
    if (!configLoaded || !localMode) return
    // Don't poll while we have an active browser MediaRecorder — we manage state locally
    if (mediaRecorderRef.current) return

    const http = createHttpClient()
    const poll = async () => {
      try {
        const { data } = await http.get<{
          isRecording: boolean
          id: string | null
          duration: number
        }>('/api/local/meetings/recording/status')
        if (!mediaRecorderRef.current) {
          setIsRecording(data.isRecording)
          setRecordingId(data.id)
          setDuration(data.duration)
        }
      } catch {}
    }

    poll()

    const interval = isRecording ? 1_000 : 10_000
    pollRef.current = setInterval(poll, interval)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [isRecording, configLoaded, localMode])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (durationRef.current) clearInterval(durationRef.current)
      liveCaptureRef.current?.stop({ discard: true })
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

  const uploadAudio = useCallback(async (blob: Blob, recDuration: number, localRecordingId: string | null) => {
    setIsUploading(true)
    try {
      let uploadBlob = blob
      let filename = 'recording.webm'

      try {
        const wavBlob = await convertToWav(blob)
        if (wavBlob.size > 44) {
          uploadBlob = wavBlob
          filename = 'recording.wav'
          console.log(`[Recording] Converted to WAV: ${wavBlob.size} bytes`)
        } else {
          console.warn('[Recording] WAV conversion produced empty file, uploading raw audio')
        }
      } catch (convErr: any) {
        console.warn('[Recording] WAV conversion failed, uploading raw audio:', convErr.message)
      }

      // Use raw fetch because the SDK HttpClient JSON-serializes all bodies,
      // which would turn FormData into "{}" instead of multipart.
      const formData = new FormData()
      formData.append('audio', uploadBlob, filename)
      formData.append('duration', String(recDuration))
      if (localRecordingId) formData.append('recordingId', localRecordingId)

      const res = await fetch(`${API_URL}/api/local/meetings/recording/upload`, {
        method: 'POST',
        body: formData,
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
      })

      if (!res.ok) {
        const errBody = await res.text()
        console.error('Upload failed:', res.status, errBody)
      }
    } catch (err: any) {
      console.error('Failed to upload recording:', err)
    } finally {
      setIsUploading(false)
      notifyMeetingsChanged()
    }
  }, [])

  const isDesktop = !!desktop.current
  const nativeMode = Platform.OS !== 'web' && native.available
  // Cloud web has no local recording bridge: record in the page, upload to the workspace.
  const cloudBrowser = Platform.OS === 'web' && !isDesktop && configLoaded && !localMode

  const updateNotes = useCallback(
    (next: string) => {
      setRecordingNotes(next)
      const wsId = workspaceIdRef.current
      if (!wsId || !recordingId || !(isDesktop || localMode || cloudBrowser)) return
      if (draftTimer.current) clearTimeout(draftTimer.current)
      draftTimer.current = setTimeout(() => {
        meetingsApi(wsId)
          .saveRecordingDraft(recordingId, { notes: next })
          .catch((err: any) => console.warn('[Recording] Could not save notes:', err?.message ?? err))
      }, 600)
    },
    [recordingId, isDesktop, localMode, cloudBrowser],
  )

  const uploadToWorkspace = useCallback(
    async (
      audio: Parameters<typeof uploadMeetingAudio>[1],
      recDuration: number,
      source: 'mobile' | 'upload',
      liveRecordingId?: string | null,
    ) => {
      const wsId = workspaceIdRef.current
      if (!wsId) {
        setError('Your personal workspace is still loading. Try again in a moment.')
        return null
      }
      setIsUploading(true)
      try {
        const meeting = await uploadMeetingAudio(wsId, audio, {
          source,
          duration: recDuration,
          notes: getRecordingNotes(),
          recordingId: liveRecordingId ?? undefined,
        })
        setRecordingNotes('')
        return meeting
      } catch (err: any) {
        console.error('Failed to upload recording:', err)
        setError(err?.message || 'Upload failed')
        return null
      } finally {
        setIsUploading(false)
        notifyMeetingsChanged()
      }
    },
    [],
  )

  return {
    isRecording: nativeMode ? native.isRecording : isRecording,
    duration: nativeMode ? native.duration : duration,
    recordingId,
    isUploading,
    error,
    clearError: useCallback(() => setError(null), []),
    notes,
    setNotes: updateNotes,
    /** Transcript of the recording so far (browser and desktop; not native phone yet). */
    liveTranscript: live,
    startRecording: useCallback(async () => {
      setError(null)
      const d = desktop.current
      if (d) {
        const result = await d.startRecording()
        if (result && 'error' in result) {
          console.error('Failed to start recording:', result.error)
          setError(String(result.error))
        }
        return
      }

      if (nativeMode) {
        setRecordingNotes('')
        const result = await native.start().catch((err: any) => ({ error: err?.message || 'Could not start recording' }))
        if ('error' in result) setError(result.error)
        return
      }

      // Browser-based recording via MediaRecorder
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.mediaDevices) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          streamRef.current = stream

          // Prefer wav/webm; browser support varies
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : ''

          const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
          chunksRef.current = []

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data)
          }

          recorder.start(1000)
          mediaRecorderRef.current = recorder
          recordingStartTime.current = Date.now()
          setRecordingNotes('')

          // Notify the local API about recording start (for status polling by other clients)
          let liveRecordingId = newRecordingId()
          if (localMode) {
            try {
              const http = createHttpClient()
              const { data } = await http.post<{ id: string } | { error: string }>(
                '/api/local/meetings/recording/start',
                {},
              )
              if (data && 'id' in data) liveRecordingId = data.id
            } catch {}
          }
          setRecordingId(liveRecordingId)
          startLive(stream, liveRecordingId)

          setIsRecording(true)
          setDuration(0)

          // Local duration counter
          durationRef.current = setInterval(() => {
            setDuration(Math.round((Date.now() - recordingStartTime.current) / 1000))
          }, 1000)

          return
        } catch (err: any) {
          console.error('Failed to access microphone:', err)
          if (!localMode) {
            setError('Microphone access was blocked. Allow it in your browser to record.')
            return
          }
          // Fall through to API-only mode
        }
      }

      if (!localMode) return

      // Fallback: API-only start (will fail if no bridge, but shows the error)
      try {
        const http = createHttpClient()
        const { data } = await http.post<{ id: string; audioPath: string } | { error: string }>(
          '/api/local/meetings/recording/start',
          {},
        )
        if ('error' in data) {
          console.error('Failed to start recording:', data.error)
          setError(data.error)
        } else {
          setIsRecording(true)
          setRecordingId(data.id)
          setDuration(0)
        }
      } catch (err: any) {
        console.error('Failed to start recording:', err)
      }
    }, [nativeMode, native, localMode, startLive]),
    stopRecording: useCallback(async () => {
      const d = desktop.current
      if (d) {
        await d.stopRecording()
        return
      }

      if (nativeMode) {
        const recording = await native.stop().catch(() => null)
        if (!recording) {
          setError('The recording could not be saved.')
          return
        }
        await uploadToWorkspace(
          { kind: 'uri', uri: recording.uri, filename: 'meeting.m4a', type: 'audio/mp4' },
          recording.duration,
          'mobile',
        )
        return
      }

      // Stop browser MediaRecorder and upload
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        const recDuration = Math.round((Date.now() - recordingStartTime.current) / 1000)
        const localRecordingId = recordingId

        if (durationRef.current) {
          clearInterval(durationRef.current)
          durationRef.current = null
        }

        stopLive()
        return new Promise<void>((resolve) => {
          recorder.onstop = async () => {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            chunksRef.current = []
            mediaRecorderRef.current = null

            if (streamRef.current) {
              streamRef.current.getTracks().forEach((t) => t.stop())
              streamRef.current = null
            }

            setIsRecording(false)
            setRecordingId(null)
            setDuration(0)

            if (!localMode) {
              await uploadToWorkspace({ kind: 'blob', blob, filename: 'meeting.webm' }, recDuration, 'upload', localRecordingId)
              setLiveTranscript(null)
              resolve()
              return
            }

            // Notify API of stop — if the bridge handled it, audio is already
            // on disk and a meeting record was created server-side; skip upload.
            let bridgeHandled = false
            try {
              const http = createHttpClient()
              const { data } = await http.post<{ mode?: string }>('/api/local/meetings/recording/stop', {})
              if (data && data.mode !== 'browser') bridgeHandled = true
            } catch {}

            if (!bridgeHandled) {
              await uploadAudio(blob, recDuration, localRecordingId)
            }
            setRecordingNotes('')
            setLiveTranscript(null)
            resolve()
          }
          recorder.stop()
        })
      }

      if (!localMode) return

      // Fallback: API-only stop
      try {
        const http = createHttpClient()
        await http.post('/api/local/meetings/recording/stop', {})
        setIsRecording(false)
        setRecordingId(null)
        setDuration(0)
      } catch (err: any) {
        console.error('Failed to stop recording:', err)
      }
    }, [uploadAudio, uploadToWorkspace, nativeMode, native, localMode, recordingId, stopLive]),
    isDesktop,
    isLocal: localMode,
    isNative: nativeMode,
    /** Any capture path is available on this surface. */
    canRecord: isDesktop || localMode || nativeMode || cloudBrowser,
    workspaceId,
  }
}

async function convertToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer()

  // Use default sample rate for decoding, then resample via OfflineAudioContext
  const decodeCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    await decodeCtx.close().catch(() => {})
  }

  const targetSampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate))

  console.log(`[Recording] Decoded audio: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch -> resampling to ${targetSampleRate}Hz mono (${frameCount} frames)`)

  const offlineCtx = new OfflineAudioContext(numChannels, frameCount, targetSampleRate)
  const source = offlineCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineCtx.destination)
  source.start(0)

  const rendered = await offlineCtx.startRendering()
  const pcmData = rendered.getChannelData(0)

  if (pcmData.length === 0) {
    throw new Error('Rendered audio buffer is empty')
  }

  const int16 = new Int16Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmData[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  const dataBytes = int16.length * 2
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, targetSampleRate, true)
  view.setUint32(28, targetSampleRate * numChannels * (bitsPerSample / 8), true)
  view.setUint16(32, numChannels * (bitsPerSample / 8), true)
  view.setUint16(34, bitsPerSample, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  return new Blob([header, int16.buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
