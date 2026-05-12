// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Platform } from 'react-native'
import { createHttpClient, API_URL } from './api'
import { usePlatformConfig } from './platform-config'

function getDesktop(): any | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const d = (window as any).shogoDesktop
  return d?.isDesktop ? d : null
}

/**
 * Hook for managing meeting recording state.
 *
 * Works in three modes:
 *  - Electron desktop: communicates via window.shogoDesktop IPC bridge
 *  - Browser/local mode: captures audio via MediaRecorder, uploads to API
 *  - API polling fallback: polls status for external recording sources
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
      const http = createHttpClient()
      http.post('/api/local/meetings', {
        audioPath: data.audioPath,
        duration: data.duration,
      }).catch((err: any) => console.error('Failed to create meeting record:', err))
    }

    d.onRecordingStarted(onStarted)
    d.onRecordingDuration(onDuration)
    d.onRecordingStopped(onStopped)

    return () => {
      d.removeRecordingListeners?.()
    }
  }, [])

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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

  const uploadAudio = useCallback(async (blob: Blob, recDuration: number) => {
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
    }
  }, [])

  return {
    isRecording,
    duration,
    recordingId,
    isUploading,
    startRecording: useCallback(async () => {
      const d = desktop.current
      if (d) {
        const result = await d.startRecording()
        if (result && 'error' in result) {
          console.error('Failed to start recording:', result.error)
        }
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

          // Notify API about recording start (for status polling by other clients)
          try {
            const http = createHttpClient()
            const { data } = await http.post<{ id: string } | { error: string }>(
              '/api/local/meetings/recording/start',
              {},
            )
            if (data && 'id' in data) {
              setRecordingId(data.id)
            }
          } catch {}

          setIsRecording(true)
          setDuration(0)

          // Local duration counter
          durationRef.current = setInterval(() => {
            setDuration(Math.round((Date.now() - recordingStartTime.current) / 1000))
          }, 1000)

          return
        } catch (err: any) {
          console.error('Failed to access microphone:', err)
          // Fall through to API-only mode
        }
      }

      // Fallback: API-only start (will fail if no bridge, but shows the error)
      try {
        const http = createHttpClient()
        const { data } = await http.post<{ id: string; audioPath: string } | { error: string }>(
          '/api/local/meetings/recording/start',
          {},
        )
        if ('error' in data) {
          console.error('Failed to start recording:', data.error)
        } else {
          setIsRecording(true)
          setRecordingId(data.id)
          setDuration(0)
        }
      } catch (err: any) {
        console.error('Failed to start recording:', err)
      }
    }, []),
    stopRecording: useCallback(async () => {
      const d = desktop.current
      if (d) {
        await d.stopRecording()
        return
      }

      // Stop browser MediaRecorder and upload
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        const recDuration = Math.round((Date.now() - recordingStartTime.current) / 1000)

        if (durationRef.current) {
          clearInterval(durationRef.current)
          durationRef.current = null
        }

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

            // Notify API of stop — if the bridge handled it, audio is already
            // on disk and a meeting record was created server-side; skip upload.
            let bridgeHandled = false
            try {
              const http = createHttpClient()
              const { data } = await http.post<{ mode?: string }>('/api/local/meetings/recording/stop', {})
              if (data && data.mode !== 'browser') bridgeHandled = true
            } catch {}

            if (!bridgeHandled) {
              await uploadAudio(blob, recDuration)
            }
            resolve()
          }
          recorder.stop()
        })
      }

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
    }, [uploadAudio]),
    isDesktop: !!desktop.current,
    isLocal: localMode,
  }
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
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
