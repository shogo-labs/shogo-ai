// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Following a publish that runs on the server (SHO-542).
 *
 * `POST /publish` answers 202 as soon as the request is validated: build →
 * upload → configure happens server-side, which is minutes for a non-trivial
 * app — far past the edge's ~100 s limit that used to turn a successful publish
 * into a 524 in the panel. So the panel subscribes instead: it shows the step
 * the publish is on and polls `GET /projects/:id/publish` until the publish is
 * `live` (refresh as before) or `failed` (show why).
 *
 * Kept out of `PublishDropdown` so the state machine is testable on its own: the
 * popover needs the whole navigation/store tree, this needs one GET.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { publishStatusMessage } from './publish-errors'

/** The steps a running publish reports, in order. */
export const PUBLISH_PROGRESS_STEPS = ['building', 'uploading', 'configuring'] as const
export type PublishProgressStep = (typeof PUBLISH_PROGRESS_STEPS)[number]

export function isPublishInFlightStatus(status: string | null | undefined): status is PublishProgressStep {
  return !!status && (PUBLISH_PROGRESS_STEPS as readonly string[]).includes(status)
}

/** What the panel says while a publish is on one of those steps. */
export function publishProgressLabel(status: PublishProgressStep | null): string {
  switch (status) {
    case 'building':
      return 'Building your app…'
    case 'uploading':
      return 'Uploading your app…'
    case 'configuring':
      return 'Taking your app live…'
    default:
      return 'Publishing…'
  }
}

export interface PublishStateSnapshot {
  publishStatus?: string | null
  publishError?: string | null
  publishErrorMessage?: string | null
}

export interface UsePublishProgressOptions {
  /** Read the project's publish state (one GET). */
  getState: () => Promise<PublishStateSnapshot>
  /** Called once per settled publish: `live` or `failed`. */
  onLive?: (state: PublishStateSnapshot) => void
  onFailed?: (state: PublishStateSnapshot, message: string) => void
  /** First poll delay; it backs off to `maxDelayMs` (2 s → 5 s by default). */
  startDelayMs?: number
  maxDelayMs?: number
}

export interface PublishProgressController {
  /** Non-null while a publish is running — the step it is on. */
  progress: PublishProgressStep | null
  /** A settled publish's failure, already worded for a person. */
  error: string | null
  clearError: () => void
  /** After an accepted POST: show progress and start following. */
  follow: () => void
  /**
   * The panel just loaded a publish state: resume following if a publish is in
   * flight (the panel was closed mid-publish), otherwise do nothing.
   */
  resume: (status: string | null | undefined) => boolean
  /** Stop following (panel closed, or the component unmounted). */
  stop: () => void
}

export function usePublishProgress(opts: UsePublishProgressOptions): PublishProgressController {
  const [progress, setProgress] = useState<PublishProgressStep | null>(null)
  const [error, setError] = useState<string | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped on every start/stop so a tick that was already scheduled by an older
  // run cannot resurrect it (or clear a newer run's progress).
  const runRef = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const stop = useCallback(() => {
    runRef.current += 1
    clearTimer()
    setProgress(null)
  }, [])

  const start = useCallback((initial: PublishProgressStep) => {
    const run = (runRef.current += 1)
    clearTimer()
    setProgress(initial)
    setError(null)

    const {
      getState,
      onLive,
      onFailed,
      startDelayMs = 2_000,
      maxDelayMs = 5_000,
    } = optsRef.current
    let delayMs = startDelayMs

    const tick = async () => {
      if (runRef.current !== run) return
      let state: PublishStateSnapshot
      try {
        state = await getState()
      } catch {
        // A failed poll is not a failed publish: try again on the next tick.
        if (runRef.current === run) timerRef.current = setTimeout(tick, delayMs)
        return
      }
      if (runRef.current !== run) return

      const status = state.publishStatus ?? null
      if (status === 'live') {
        runRef.current += 1
        clearTimer()
        setProgress(null)
        onLive?.(state)
        return
      }
      if (status === 'failed') {
        runRef.current += 1
        clearTimer()
        setProgress(null)
        const message =
          state.publishErrorMessage?.trim() || publishStatusMessage(state.publishError ?? null)
        setError(message)
        onFailed?.(state, message)
        return
      }
      setProgress(isPublishInFlightStatus(status) ? status : 'configuring')
      delayMs = Math.min(maxDelayMs, delayMs + 1_000)
      if (runRef.current === run) timerRef.current = setTimeout(tick, delayMs)
    }

    timerRef.current = setTimeout(tick, delayMs)
  }, [])

  const follow = useCallback(() => start('building'), [start])

  const resume = useCallback(
    (status: string | null | undefined) => {
      if (!isPublishInFlightStatus(status)) return false
      start(status)
      return true
    },
    [start],
  )

  useEffect(() => {
    return () => {
      runRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return {
    progress,
    error,
    clearError: useCallback(() => setError(null), []),
    follow,
    resume,
    stop,
  }
}
