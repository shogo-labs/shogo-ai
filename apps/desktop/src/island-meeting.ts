// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Meeting state shown in the island. Pure so `recording.ts` can drive it from
// detector and recorder events and tests can drive it directly.

import type { IslandMeetingState } from './island-protocol'

/** A "record this call?" prompt nobody answers goes away on its own. */
export const MEETING_PROMPT_TTL_MS = 2 * 60_000

export type MeetingEvent =
  | { type: 'detected'; app: string; now: number; suggestAutoRecord: boolean }
  | { type: 'ended'; app: string }
  | { type: 'expired'; now: number }
  | { type: 'dismissed' }
  | { type: 'busy' }
  | { type: 'recording-started'; id: string; now: number }
  | { type: 'recording-stopped' }
  | { type: 'failed'; error: string }

export function reduceMeetingState(state: IslandMeetingState, event: MeetingEvent): IslandMeetingState {
  const { prompt, recording, busy: _busy, error: _error, ...rest } = state
  switch (event.type) {
    case 'detected':
      if (recording) return state
      return {
        ...rest,
        prompt: {
          id: `meeting-${event.now}`,
          app: event.app,
          detectedAt: event.now,
          suggestAutoRecord: event.suggestAutoRecord,
        },
      }
    case 'ended':
      return prompt?.app === event.app ? { ...rest, ...(recording ? { recording } : {}) } : state
    case 'expired':
      return prompt && event.now - prompt.detectedAt >= MEETING_PROMPT_TTL_MS && !state.busy
        ? { ...rest, ...(recording ? { recording } : {}) }
        : state
    case 'dismissed':
      return { ...rest, ...(recording ? { recording } : {}) }
    case 'busy':
      return { ...rest, ...(prompt ? { prompt } : {}), ...(recording ? { recording } : {}), busy: true }
    case 'recording-started':
      if (recording?.id === event.id) return state
      return {
        ...rest,
        recording: { id: event.id, startedAt: event.now, ...(prompt ? { app: prompt.app } : {}) },
      }
    case 'recording-stopped':
      return { ...rest, ...(prompt ? { prompt } : {}) }
    case 'failed':
      return { ...rest, ...(prompt ? { prompt } : {}), ...(recording ? { recording } : {}), error: event.error }
  }
}

export function hasMeetingActivity(state: IslandMeetingState): boolean {
  return !!state.prompt || !!state.recording || !!state.error
}
