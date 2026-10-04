// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone meeting recorder. Lives in a provider above the app's screens so a
 * recording survives navigation, and uses the background-audio session so
 * it keeps going when the user switches to the call app or locks the phone.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio'
import { useNativePcmSource, type NativePcmSource } from './native-pcm'

/** Mono 16 kHz AAC at 32 kbps (~14 MB/hour) keeps long meetings under Whisper's 25 MB limit. */
export const MEETING_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: {},
}

export interface NativeRecording {
  uri: string
  duration: number
}

export interface NativeRecorderApi {
  available: boolean
  isRecording: boolean
  duration: number
  /** Raw mic frames for the live transcript (the m4a above is still what gets uploaded). */
  pcm: NativePcmSource
  start(): Promise<{ ok: true } | { error: string }>
  stop(): Promise<NativeRecording | null>
}

const unavailable: NativeRecorderApi = {
  available: false,
  isRecording: false,
  duration: 0,
  pcm: { available: false, start: async () => false, stop: async () => {} },
  start: async () => ({ error: 'Recording is not available here' }),
  stop: async () => null,
}

const NativeRecorderContext = createContext<NativeRecorderApi>(unavailable)

export function NativeRecorderProvider({ children }: { children: ReactNode }) {
  const recorder = useAudioRecorder(MEETING_RECORDING_OPTIONS)
  const state = useAudioRecorderState(recorder, 1000)
  const pcm = useNativePcmSource()

  const start = useCallback(async (): Promise<{ ok: true } | { error: string }> => {
    const permission = await requestRecordingPermissionsAsync()
    if (!permission.granted) return { error: 'Microphone access is off. Turn it on in Settings to record meetings.' }
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      allowsBackgroundRecording: true,
      // Android only keeps the foreground service alive with this set.
      shouldPlayInBackground: true,
    })
    await recorder.prepareToRecordAsync()
    recorder.record()
    return { ok: true }
  }, [recorder])

  const stop = useCallback(async (): Promise<NativeRecording | null> => {
    const duration = Math.round((recorder.getStatus().durationMillis || 0) / 1000)
    await recorder.stop()
    await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false, shouldPlayInBackground: false }).catch(
      () => {},
    )
    return recorder.uri ? { uri: recorder.uri, duration } : null
  }, [recorder])

  const value = useMemo<NativeRecorderApi>(
    () => ({
      available: true,
      isRecording: state.isRecording,
      duration: Math.round(state.durationMillis / 1000),
      pcm,
      start,
      stop,
    }),
    [state.isRecording, state.durationMillis, pcm, start, stop],
  )

  return <NativeRecorderContext.Provider value={value}>{children}</NativeRecorderContext.Provider>
}

export function useNativeRecorder(): NativeRecorderApi {
  return useContext(NativeRecorderContext)
}
