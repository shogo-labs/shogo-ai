// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Web and desktop record through MediaRecorder / Electron instead. */
import type { ReactNode } from 'react'

export interface NativeRecording {
  uri: string
  duration: number
}

export interface NativeRecorderApi {
  available: boolean
  isRecording: boolean
  duration: number
  start(): Promise<{ ok: true } | { error: string }>
  stop(): Promise<NativeRecording | null>
}

const unavailable: NativeRecorderApi = {
  available: false,
  isRecording: false,
  duration: 0,
  start: async () => ({ error: 'Recording is not available here' }),
  stop: async () => null,
}

export function NativeRecorderProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useNativeRecorder(): NativeRecorderApi {
  return unavailable
}
