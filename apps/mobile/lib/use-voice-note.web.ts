// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice-note recording on web and desktop (MediaRecorder).
 *
 * The sibling `use-voice-note.ts` is the phone; this file is chosen by the
 * bundler for web targets. The two share their contract and their maths via
 * `voice-note.ts` so a clip records the same way on either side.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  LEVEL_SAMPLE_MS,
  MAX_VOICE_NOTE_MS,
  MIN_VOICE_NOTE_MS,
  downsamplePeaks,
  peaksToString,
  rmsToLevel,
} from "./voice-note"

export interface RecordedVoiceNote {
  /** Web hands the clip back as a data URL. */
  dataUrl: string
  /** Nothing on web: the bytes are in `dataUrl`. */
  uri?: string
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

/**
 * AAC in an MP4 container is the one format every client can play, including
 * iOS native, so prefer it wherever the browser can produce it. Chrome's
 * webm/opus is the fallback and not playable by AVPlayer.
 */
const PREFERRED_TYPES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
]

export function pickRecordingMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string | null {
  return PREFERRED_TYPES.find(isSupported) ?? null
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the recording"))
    reader.readAsDataURL(blob)
  })
}

async function recordingMimeType(blob: Blob, declared: string): Promise<string> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end))
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4'
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return 'audio/webm'
  }
  if (ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav'
  const baseType = declared.split(';', 1)[0].trim().toLowerCase()
  return baseType === 'video/webm' ? 'audio/webm' : baseType || 'audio/webm'
}

export function useVoiceNoteRecorder(): VoiceNoteRecorder {
  const [isRecording, setIsRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const samplesRef = useRef<number[]>([])
  const startedAtRef = useRef(0)

  const release = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      try { if (recorder.state !== 'inactive') recorder.stop() } catch {}
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }, [])

  useEffect(() => () => release(), [release])

  const finish = useCallback(
    async (discard: boolean) => {
      const recorder = recorderRef.current
      if (!recorder || recorder.state === "inactive") {
        release()
        setIsRecording(false)
        return null
      }
      const durationMs = Date.now() - startedAtRef.current
      const samples = samplesRef.current
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      recorder.stop()
      await stopped
      const recordedType = recorder.mimeType || "audio/webm"
      const recordedBlob = new Blob(chunksRef.current, { type: recordedType })
      // Release the microphone before inspecting bytes or reading the data URL:
      // either asynchronous step can fail and must not leave capture running.
      release()
      setIsRecording(false)
      setLevel(0)
      setElapsedMs(0)
      chunksRef.current = []
      samplesRef.current = []

      if (discard || durationMs < MIN_VOICE_NOTE_MS || !recordedBlob.size) return null
      const mimeType = await recordingMimeType(recordedBlob, recordedType)
      const blob = recordedBlob.type === mimeType
        ? recordedBlob
        : new Blob([recordedBlob], { type: mimeType })
      const dataUrl = await blobToDataUrl(blob)
      const peaks = peaksToString(downsamplePeaks(samples)) ?? ""
      return { dataUrl, mimeType, durationMs, peaks }
    },
    [release],
  )

  const stop = useCallback(
    () => finish(false),
    [finish],
  )

  const cancel = useCallback(() => {
    void finish(true)
  }, [finish])

  const start = useCallback(async () => {
    if (recorderRef.current) return
    const media = await navigator.mediaDevices.getUserMedia({ audio: true })
    streamRef.current = media
    chunksRef.current = []
    samplesRef.current = []
    startedAtRef.current = Date.now()

    try {
      const mimeType = pickRecordingMimeType()
      const recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data)
      }
      recorder.start()

      // A live level meter doubles as the waveform: the same samples drive both.
      const context = new AudioContext()
      audioContextRef.current = context
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(media).connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)

      timerRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
        const next = rmsToLevel(Math.sqrt(sum / buffer.length))
        samplesRef.current.push(next)
        setLevel(next)
        const elapsed = Date.now() - startedAtRef.current
        setElapsedMs(elapsed)
        if (elapsed >= MAX_VOICE_NOTE_MS) void finish(false)
      }, LEVEL_SAMPLE_MS)

      setIsRecording(true)
    } catch (error) {
      release()
      throw error
    }
  }, [finish, release])

  return { isRecording, level, elapsedMs, start, stop, cancel }
}
