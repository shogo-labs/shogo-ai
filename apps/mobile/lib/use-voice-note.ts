// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice-note recording on iOS and Android (expo-audio).
 *
 * The sibling `use-voice-note.web.ts` is chosen by the bundler for web and
 * desktop. The two share their contract and their maths via `voice-note.ts`.
 *
 * Deliberately separate from `native-recorder.tsx`, which is the meeting
 * recorder: that one lives above the app, survives navigation, records in the
 * background and streams PCM for a live transcript. A voice note is scoped to
 * the composer, so this hook holds its own session and hands it straight back
 * when the clip stops — a meeting recording must not be interrupted by
 * someone tapping the mic in a chat, and vice versa.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio"
import {
  LEVEL_SAMPLE_MS,
  MAX_VOICE_NOTE_MS,
  MIN_VOICE_NOTE_MS,
  downsamplePeaks,
  meterToLevel,
  peaksToString,
} from "./voice-note"

export interface RecordedVoiceNote {
  /** Empty on native: the clip is a file at `uri`, not inline bytes. */
  dataUrl: string
  uri: string
  mimeType: string
  durationMs: number
  peaks: string
}

export interface VoiceNoteRecorder {
  isRecording: boolean
  /** Latest 0-100 level, for the live meter. */
  level: number
  elapsedMs: number
  start: () => Promise<void>
  /** Resolves with the clip, or null when it was too short to keep. */
  stop: () => Promise<RecordedVoiceNote | null>
  cancel: () => void
}

/** expo-audio writes m4a; `audio/mp4` is the type every player accepts for it. */
const VOICE_NOTE_MIME = "audio/mp4"

export function useVoiceNoteRecorder(): VoiceNoteRecorder {
  const [isRecording, setIsRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  const options = useMemo(
    () => ({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true }),
    [],
  )
  const recorder = useAudioRecorder(options)
  const state = useAudioRecorderState(recorder, LEVEL_SAMPLE_MS)

  const samplesRef = useRef<number[]>([])
  const elapsedRef = useRef(0)
  // The recorder's own status drives the timer, so the hook doesn't depend on
  // render timing to know how long the clip has run.
  const liveRef = useRef(state)
  liveRef.current = state

  const releaseSession = useCallback(() => {
    void setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }).catch(() => {})
  }, [])

  const finish = useCallback(
    async (discard: boolean): Promise<RecordedVoiceNote | null> => {
      let uri: string | null = null
      try {
        await recorder.stop()
        uri = recorder.uri
      } catch {
        uri = null
      }
      const durationMs = elapsedRef.current
      const samples = samplesRef.current
      releaseSession()
      setIsRecording(false)
      setLevel(0)
      setElapsedMs(0)
      samplesRef.current = []
      elapsedRef.current = 0

      if (discard || durationMs < MIN_VOICE_NOTE_MS || !uri) return null
      return {
        dataUrl: "",
        uri,
        mimeType: VOICE_NOTE_MIME,
        durationMs,
        peaks: peaksToString(downsamplePeaks(samples)) ?? "",
      }
    },
    [recorder, releaseSession],
  )

  useEffect(() => {
    if (!isRecording) return
    const id = setInterval(() => {
      const status = recorder.getStatus()
      elapsedRef.current = status.durationMillis ?? recorder.currentTime * 1000
      setElapsedMs(Math.round(elapsedRef.current / 1000) * 1000)
      const next = meterToLevel(status.metering ?? Number.NEGATIVE_INFINITY)
      samplesRef.current.push(next)
      setLevel(next)
      if (elapsedRef.current >= MAX_VOICE_NOTE_MS) void finish(false)
    }, LEVEL_SAMPLE_MS)
    return () => clearInterval(id)
  }, [isRecording, recorder, finish])

  useEffect(
    () => () => {
      if (liveRef.current.isRecording) void finish(true)
    },
    [finish],
  )

  const start = useCallback(async () => {
    if (liveRef.current.isRecording) return
    const permission = await requestRecordingPermissionsAsync()
    if (!permission.granted) throw new Error("Microphone access is needed to record a voice note")
    samplesRef.current = []
    elapsedRef.current = 0
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
    await recorder.prepareToRecordAsync()
    recorder.record()
    setIsRecording(true)
  }, [recorder])

  const stop = useCallback(() => finish(false), [finish])
  const cancel = useCallback(async () => {
    await finish(true)
  }, [finish])

  return { isRecording, level, elapsedMs, start, stop, cancel }
}
