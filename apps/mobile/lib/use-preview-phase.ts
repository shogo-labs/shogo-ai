// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one preview gate.
 *
 * Polls `${agentUrl}/preview/status` through the authenticated agent-proxy and
 * kicks `/preview/start` when the runtime says the preview is not running.
 *
 * Extracted from `app/(app)/projects/[id]/_layout.tsx` (SHO-406) so the project
 * screen's `CanvasPanel` and the phone's full-screen canvas surface
 * (`components/project/ProjectSurfaceView.tsx`) share one implementation
 * instead of two copies that drift — the surface's copy could never leave its
 * spinner on a failed build, a 5xx status poll, a sidecar that never came up or
 * a runtime that never resolved.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { agentFetch } from './agent-fetch'
import {
  API_WAIT_TIMEOUT_MS,
  BASE_TIMEOUT_MS,
  latchApiGate,
  nextPreviewStartDelayMs,
  previewStatusPollBase,
  resolveApiReady,
  resolveRunning,
  shouldAttemptPreviewStart,
  shouldStopPreviewPoll,
} from './preview-gate'

export interface PreviewPhaseState {
  /** Runtime `phase` ('idle' | 'installing' | 'building' | 'failed' | …). */
  phase: string
  /** Hydrate-aware "the dev server is serving the project's real content". */
  running: boolean
  /** The project's API sidecar is healthy, or the project has no sidecar. */
  apiReady: boolean
  apiServerPhase: string
  /**
   * Consecutive `/preview/status` poll failures (0 as soon as one succeeds).
   * The canvas treats two in a row as "the runtime behind this preview is
   * gone" and re-resolves (SHO-226).
   */
  statusErrors: number
  /** The last poll failure, as `HTTP 502` or the thrown message. */
  lastStatusError: string | null
  /** The last `/preview/start` failure, as `HTTP 500 — <body error>`. */
  startError: string | null
  /** `/preview/start` answered `mode: "no-project"`. */
  noProject: boolean
  /** Reset the counters and kick `/preview/start` again. */
  retry: () => void
  /** Bumped by {@link retry}; pass to `usePreviewGateTimers` to reset its clocks. */
  retryNonce: number
}

export function usePreviewPhase(
  agentUrl: string | null,
  canvasBaseUrl?: string | null,
): PreviewPhaseState {
  const [phase, setPhase] = useState<string>('idle')
  const [running, setRunning] = useState<boolean>(false)
  // Starts `false` (gate closed) and is reset on each navigation. Backwards
  // compat for older runtimes whose `/preview/status` predates `apiReady` is
  // handled by `resolveApiReady` (absent → ready) so the gate degrades to the
  // old `running`-only behaviour instead of hanging.
  const [apiReady, setApiReady] = useState<boolean>(false)
  const [apiServerPhase, setApiServerPhase] = useState<string>('idle')
  const [statusErrors, setStatusErrors] = useState<number>(0)
  const [lastStatusError, setLastStatusError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [noProject, setNoProject] = useState<boolean>(false)
  const [retryNonce, setRetryNonce] = useState<number>(0)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startAttemptsRef = useRef(0)
  const startInFlightRef = useRef(false)

  const statusBase = previewStatusPollBase(agentUrl, canvasBaseUrl)
  const pollTimeoutMs = Platform.OS === 'web' ? 5_000 : 20_000

  const retry = useCallback(() => setRetryNonce((n) => n + 1), [])

  useEffect(() => {
    // Reset on status-base change so consumers see a fresh "idle" phase on
    // navigation instead of a stale `running=true` from the previous project.
    setPhase('idle')
    setRunning(false)
    setApiReady(false)
    setApiServerPhase('idle')
    setStatusErrors(0)
    setLastStatusError(null)
    setStartError(null)
    setNoProject(false)
    startAttemptsRef.current = 0
    startInFlightRef.current = false
    inFlightRef.current = false

    if (!statusBase) return

    let cancelled = false

    function clearStartTimer() {
      if (startTimerRef.current) {
        clearTimeout(startTimerRef.current)
        startTimerRef.current = null
      }
    }

    function scheduleStartRetry() {
      if (cancelled) return
      if (!shouldAttemptPreviewStart(startAttemptsRef.current)) return
      if (startTimerRef.current) return
      startTimerRef.current = setTimeout(() => {
        startTimerRef.current = null
        void kickStart()
      }, nextPreviewStartDelayMs(startAttemptsRef.current))
    }

    async function kickStart() {
      if (cancelled || startInFlightRef.current) return
      if (!shouldAttemptPreviewStart(startAttemptsRef.current)) return
      startInFlightRef.current = true
      startAttemptsRef.current += 1
      try {
        const resp = await agentFetch(`${statusBase}/preview/start`, {
          method: 'POST',
          signal: AbortSignal.timeout(pollTimeoutMs),
        })
        const body = await resp.json().catch(() => null)
        if (cancelled) return
        if (!resp.ok) {
          const detail = typeof body?.error === 'string' ? body.error : null
          setStartError(detail ? `HTTP ${resp.status} — ${detail}` : `HTTP ${resp.status}`)
          scheduleStartRetry()
          return
        }
        setStartError(null)
        if (body?.mode === 'no-project') setNoProject(true)
      } catch (err: unknown) {
        if (cancelled) return
        setStartError(err instanceof Error ? err.message : String(err))
        scheduleStartRetry()
      } finally {
        startInFlightRef.current = false
      }
    }

    const poll = async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const resp = await agentFetch(`${statusBase}/preview/status`, {
          signal: AbortSignal.timeout(pollTimeoutMs),
        })
        if (cancelled) return
        if (resp.ok) {
          const data = await resp.json()
          if (cancelled) return
          setStatusErrors(0)
          setLastStatusError(null)
          if (data.phase) setPhase(data.phase)
          if (data.apiServerPhase) setApiServerPhase(data.apiServerPhase)
          setApiReady(resolveApiReady(data))
          // `resolveRunning` folds in `hydrateRebuildPending`: a cold-miss
          // assign's `data.running` reflects the warm-pool TEMPLATE until the
          // post-hydrate rebuild finishes, and this is a one-way latch (never
          // resets to false), so treating that as "running" would mount the
          // canvas iframe against the template and never revisit it once the
          // real content comes up. See preview-gate.ts for the full story.
          if (resolveRunning(data)) setRunning(true)
          if (!data.running) {
            // The runtime says the preview is not up: kick it. A failed kick
            // is retried with backoff (SHO-406) instead of being dropped.
            if (startAttemptsRef.current === 0) void kickStart()
          } else {
            startAttemptsRef.current = 0
            clearStartTimer()
            setStartError(null)
          }
          // Stop only once the preview is running AND the API is ready — the
          // prebuilt-dist path reports `running` before the sidecar binds, so
          // `running` alone would stop the poll too early.
          if (shouldStopPreviewPoll(data)) {
            if (pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }
          }
        } else {
          console.warn('[preview/status]', resp.status, statusBase)
          setStatusErrors((n) => n + 1)
          setLastStatusError(`HTTP ${resp.status}`)
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('[preview/status] poll failed', message)
        if (!cancelled) {
          setStatusErrors((n) => n + 1)
          setLastStatusError(message)
        }
      } finally {
        inFlightRef.current = false
      }
    }

    void poll()
    pollRef.current = setInterval(poll, 3000)

    return () => {
      cancelled = true
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      clearStartTimer()
    }
  }, [statusBase, pollTimeoutMs, retryNonce])

  return {
    phase,
    running,
    apiReady,
    apiServerPhase,
    statusErrors,
    lastStatusError,
    startError,
    noProject,
    retry,
    retryNonce,
  }
}

/**
 * The two independent clocks the canvas gate runs on.
 *
 *  - `baseTimedOut`: the agent runtime / dev server never became reachable (a
 *    genuine failure) → surface "Connection timed out" + Retry.
 *  - `apiWaitElapsed`: the dev server IS up but the API sidecar hasn't reported
 *    healthy within a bounded window → show the app anyway rather than block.
 *    Intentionally NON-RESETTING: on a fresh project the sidecar only goes
 *    healthy after a cold `bun install` + build + spawn, and during that time
 *    the dev-server root can flip 404↔200 as `dist/` is rebuilt. A single timer
 *    keyed on `baseReady` restarted the clock on every flip and the gate could
 *    hang on "Starting API server…" forever.
 *
 * `resetKey` (the phase hook's `retryNonce`) restarts both clocks.
 */
export function usePreviewGateTimers(input: {
  baseReady: boolean
  apiLatched: boolean
  apiGateKey: string | null
  resetKey?: number
}): {
  baseTimedOut: boolean
  setBaseTimedOut: (value: boolean) => void
  apiWaitElapsed: boolean
} {
  const { baseReady, apiLatched, apiGateKey, resetKey = 0 } = input
  const [baseTimedOut, setBaseTimedOut] = useState(false)
  const [apiWaitElapsed, setApiWaitElapsed] = useState(false)
  const apiWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (baseReady) {
      setBaseTimedOut(false)
      return
    }
    setBaseTimedOut(false)
    const timer = setTimeout(() => setBaseTimedOut(true), BASE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [baseReady, resetKey])

  // Declared before the api-wait effect so a retry clears the pending timer
  // before that effect decides whether to start one.
  useEffect(() => {
    if (resetKey === 0) return
    setApiWaitElapsed(false)
    if (apiWaitTimerRef.current) {
      clearTimeout(apiWaitTimerRef.current)
      apiWaitTimerRef.current = null
    }
  }, [resetKey])

  useEffect(() => {
    if (apiLatched) return
    if (!baseReady) return
    // Start exactly once; do NOT restart on baseReady / phase oscillation.
    if (apiWaitTimerRef.current) return
    apiWaitTimerRef.current = setTimeout(() => {
      // Remember the fallback too, so remounting the panel doesn't make the
      // user sit through the same wait again for this preview.
      latchApiGate(apiGateKey)
      setApiWaitElapsed(true)
    }, API_WAIT_TIMEOUT_MS)
  }, [baseReady, apiLatched, apiGateKey, resetKey])

  useEffect(
    () => () => {
      if (apiWaitTimerRef.current) {
        clearTimeout(apiWaitTimerRef.current)
        apiWaitTimerRef.current = null
      }
    },
    [],
  )

  return { baseTimedOut, setBaseTimedOut, apiWaitElapsed }
}
