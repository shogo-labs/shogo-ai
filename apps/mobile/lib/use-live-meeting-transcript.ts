// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Watch a recording's live transcript. Uses server-sent events where the
 * platform has `EventSource` (web, Electron); elsewhere (native) it polls the
 * draft. Either way the state has the same shape: settled segments, the words
 * still being said (`partial`), and a `notice` when the server says why the
 * transcript isn't updating.
 */
import { useEffect, useRef, useState } from 'react'
import type { TranscriptSegmentView } from './meetings-api'

export interface LiveMeetingState {
  segments: TranscriptSegmentView[]
  /** Words still being said; replaced by the next final. */
  partial: string | null
  /** Why the live transcript isn't updating, when the server knows. */
  notice: string | null
  /** The recording ended (or the draft was removed). */
  ended: boolean
}

export const EMPTY_LIVE_MEETING: LiveMeetingState = { segments: [], partial: null, notice: null, ended: false }

export type LiveMeetingEvent =
  | { type: 'snapshot'; segments?: TranscriptSegmentView[]; liveStatus?: { state: string; message?: string } | null; status?: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; segment: TranscriptSegmentView }
  | { type: 'status'; state: 'ok' | 'error'; message?: string }
  | { type: 'ended' }

/** Fold one server event into the state. Pure, so it is easy to test. */
export function reduceLiveMeeting(state: LiveMeetingState, event: LiveMeetingEvent): LiveMeetingState {
  switch (event.type) {
    case 'snapshot':
      return {
        segments: event.segments ?? [],
        partial: null,
        notice: event.liveStatus?.state === 'error' ? (event.liveStatus.message ?? 'Live transcript is unavailable.') : null,
        ended: !!event.status && event.status !== 'recording',
      }
    case 'partial':
      return event.text === state.partial ? state : { ...state, partial: event.text }
    case 'final': {
      const { segment } = event
      // Replays after a reconnect: the same segment is not added twice.
      if (state.segments.some((s) => s.start === segment.start && s.text === segment.text)) return { ...state, partial: null }
      const segments = [...state.segments, segment].sort((a, b) => a.start - b.start)
      return { ...state, segments, partial: null, notice: null }
    }
    case 'status':
      return { ...state, notice: event.state === 'error' ? (event.message ?? 'Live transcript is unavailable.') : null }
    case 'ended':
      return { ...state, partial: null, ended: true }
  }
}

/** Parse the `transcript` column of a draft into a snapshot event. */
export function snapshotFromTranscript(raw: string | null | undefined, status?: string): LiveMeetingEvent | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return {
      type: 'snapshot',
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      liveStatus: parsed.liveStatus ?? null,
      status,
    }
  } catch {
    return null
  }
}

export interface LiveMeetingSource {
  /** SSE endpoint, or null while there is nothing to watch. */
  url: string | null
  /** Used where `EventSource` doesn't exist: returns the draft's current state. */
  poll?: () => Promise<{ transcript: string | null; status?: string } | null>
  pollMs?: number
}

const RETRY_MS = 2000

export function useLiveMeetingTranscript(source: LiveMeetingSource): LiveMeetingState {
  const [state, setState] = useState<LiveMeetingState>(EMPTY_LIVE_MEETING)
  const { url, pollMs = 1500 } = source
  // Callers pass `poll` inline; keep the effect from restarting on every render.
  const pollRef = useRef(source.poll)
  pollRef.current = source.poll
  const canPoll = !!source.poll

  useEffect(() => {
    setState(EMPTY_LIVE_MEETING)
    if (!url) return
    let cancelled = false
    const apply = (event: LiveMeetingEvent) => setState((current) => reduceLiveMeeting(current, event))
    const cleanups: Array<() => void> = []

    const ES = (globalThis as any).EventSource
    if (ES) {
      let es: any = null
      let retry: ReturnType<typeof setTimeout> | null = null
      const open = () => {
        if (cancelled) return
        es = new ES(url, { withCredentials: true })
        for (const type of ['snapshot', 'partial', 'final', 'status', 'ended'] as const) {
          es.addEventListener(type, (message: any) => {
            try {
              apply(JSON.parse(message.data))
            } catch {}
          })
        }
        es.onerror = () => {
          // A 404 (draft not created yet) closes the stream for good: try again shortly.
          if (es?.readyState === 2 && !cancelled) {
            es.close()
            retry = setTimeout(open, RETRY_MS)
          }
        }
      }
      open()
      cleanups.push(() => {
        if (retry) clearTimeout(retry)
        es?.close()
      })
    } else if (canPoll) {
      const tick = async () => {
        const draft = await pollRef.current?.().catch(() => null)
        if (cancelled || !draft) return
        const snapshot = snapshotFromTranscript(draft.transcript, draft.status)
        if (snapshot) apply(snapshot)
      }
      void tick()
      const timer = setInterval(tick, pollMs)
      cleanups.push(() => clearInterval(timer))
    }
    return () => {
      cancelled = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [url, canPoll, pollMs])

  return state
}
