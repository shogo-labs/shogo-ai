// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Platform } from 'react-native'
import { createHttpClient } from './api'
import { usePlatformConfig } from './platform-config'

function getDesktop(): any | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const d = (window as any).shogoDesktop
  return d?.isDesktop ? d : null
}

/**
 * Hook for managing meeting recording state.
 *
 * Works in two modes:
 *  - Electron desktop: communicates via window.shogoDesktop IPC bridge
 *  - Dev/web mode (local only): communicates via REST API + polling
 */
export function useRecording() {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const desktop = useRef(getDesktop())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
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

    const http = createHttpClient()
    const poll = async () => {
      try {
        const { data } = await http.get<{
          isRecording: boolean
          id: string | null
          duration: number
        }>('/api/local/meetings/recording/status')
        setIsRecording(data.isRecording)
        setRecordingId(data.id)
        setDuration(data.duration)
      } catch {}
    }

    poll()

    const interval = isRecording ? 1_000 : 10_000
    pollRef.current = setInterval(poll, interval)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [isRecording, configLoaded, localMode])

  return {
    isRecording,
    duration,
    recordingId,
    startRecording: useCallback(async () => {
      const d = desktop.current
      if (d) {
        const result = await d.startRecording()
        if (result && 'error' in result) {
          console.error('Failed to start recording:', result.error)
        }
        return
      }

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

      try {
        const http = createHttpClient()
        await http.post('/api/local/meetings/recording/stop', {})
        setIsRecording(false)
        setRecordingId(null)
        setDuration(0)
      } catch (err: any) {
        console.error('Failed to stop recording:', err)
      }
    }, []),
    isDesktop: !!desktop.current,
    isLocal: localMode,
  }
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
