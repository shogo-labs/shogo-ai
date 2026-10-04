// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Raw microphone PCM on the phone, for the live transcript. expo-audio only
 * records to a file, so this uses @siteed/audio-studio to get 16 kHz mono
 * frames while expo-audio keeps writing the m4a that is uploaded at the end.
 * Without the native module (or if it fails to start) the meeting is still
 * recorded; it just has no live transcript until the upload finishes.
 */
import { useMemo, useRef } from 'react'
import { Platform } from 'react-native'

export const NATIVE_PCM_SAMPLE_RATE = 16000

export interface NativePcmSource {
  available: boolean
  /** Start delivering mono Float32 frames at 16 kHz. Resolves false if the recorder could not start. */
  start(onFrame: (frame: Float32Array) => void): Promise<boolean>
  stop(): Promise<void>
}

const none: NativePcmSource = { available: false, start: async () => false, stop: async () => {} }

let studio: any = null
if (Platform.OS !== 'web') {
  try {
    studio = require('@siteed/audio-studio')
  } catch {
    studio = null
  }
}

/** Whichever hook applies is fixed when the app loads, so hook order never changes between renders. */
function useStudioPcm(): NativePcmSource {
  const recorder = studio.useAudioRecorder()
  // The hook returns a fresh object each render; keep the latest for stable callbacks.
  const ref = useRef(recorder)
  ref.current = recorder
  return useMemo<NativePcmSource>(() => ({
    available: true,
    async start(onFrame) {
      try {
        await ref.current.startRecording({
          sampleRate: NATIVE_PCM_SAMPLE_RATE,
          channels: 1,
          encoding: 'pcm_16bit',
          interval: 100,
          streamFormat: 'float32',
          // Streaming only: expo-audio writes the file that gets uploaded.
          output: { primary: { enabled: false } },
          onAudioStream: async (event: any) => {
            const data = event?.data
            if (!data || typeof data === 'string') return
            onFrame(data instanceof Float32Array ? data : Float32Array.from(data))
          },
        })
        return true
      } catch (err) {
        console.warn('[Recording] Live audio stream unavailable:', (err as Error)?.message ?? err)
        return false
      }
    },
    async stop() {
      await ref.current.stopRecording().catch(() => {})
    },
  }), [])
}

function useNoPcm(): NativePcmSource {
  return none
}

export const useNativePcmSource: () => NativePcmSource = studio ? useStudioPcm : useNoPcm
