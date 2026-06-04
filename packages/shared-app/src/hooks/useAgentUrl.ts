// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useAgentUrl
 *
 * Resolves the agent runtime URL and preview URL for a project by calling
 * the sandbox/url endpoint. Returns four values:
 *   agentUrl      – proxied agent runtime (for chat, SSE stream, capabilities)
 *   previewUrl    – Vite dev server or published app URL (for APP project iframe)
 *   canvasBaseUrl – direct runtime URL for the canvas iframe; fetch('/api/...')
 *                   resolves same-origin so no proxy rewriting is needed.
 *   ready         – true once the API reports `ready: true`. The URL state
 *                   is held back until the runtime is fully `running`, so
 *                   consumers can simply gate their UI on `agentUrl != null`
 *                   (or on `ready` explicitly) without hitting a port that
 *                   isn't listening yet.
 *
 * Polling: when the API responds with `ready: false` (host runtime still
 * booting) or 503 (VM warm pool still warming), the hook retries with a
 * short backoff until the effect is torn down. This complements the
 * server-side `resolveProjectPodUrl` fix in
 * `apps/api/src/lib/resolve-pod-url.ts` (which now awaits `manager.start()`
 * for `'starting'` runtimes); the client-side polling is defense-in-depth
 * for the VM / K8s paths and any future caller that returns `ready:false`.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Lightweight cold-start mark hook. Mirrors the on-disk
 * `apps/mobile/lib/cold-start-timing.ts` API surface but lives behind
 * an inline guard so this package (shared with web/desktop) doesn't
 * have to take a hard dependency on the mobile-only util. Anything
 * mounted on `globalThis.__shogoColdStart__` gets the mark; everything
 * else silently no-ops.
 */
function csMark(id: string, meta?: Record<string, unknown>): void {
  try {
    const g = globalThis as { __shogoColdStart__?: { mark?: (id: string, meta?: Record<string, unknown>) => void } }
    g.__shogoColdStart__?.mark?.(id, meta)
  } catch {
    // never throw from a timing mark
  }
}

function rewriteLocalhostUrl(url: string, apiBaseUrl: string): string {
  try {
    const parsed = new URL(url)
    const apiParsed = new URL(apiBaseUrl)
    if (parsed.hostname === 'localhost' && apiParsed.hostname !== 'localhost') {
      parsed.hostname = apiParsed.hostname
      return parsed.href.replace(/\/+$/, '')
    }
  } catch {}
  return url
}

// Backoff schedule for poll retries. Conservative: the host RuntimeManager
// can take ~10–30s to spawn Vite + the agent-runtime on a cold project, and
// VM warm-pool cold starts can be similar. We start small so a near-ready
// runtime is picked up quickly and cap at 3s so an extended boot doesn't
// burn the API with sub-second polls.
const RETRY_DELAYS_MS = [750, 1000, 1500, 2000, 3000]
function nextRetryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!
}

/**
 * Soft-stall threshold (ms). Polling continues past this — the runtime
 * really does take >30s to spin up on a cold project sometimes — but
 * consumers can read `stalled === true` to surface a "this is taking
 * longer than expected, here's the error / continue anyway" UI instead
 * of the blank loading spinner that left mobile users on TestFlight
 * v1.0.8 stranded on "Starting your project…" with no recovery option.
 *
 * 45s is the empirical p95 for cold VM warm-pool / host RuntimeManager
 * spin-up (Vite + agent-runtime + first compile). Anything below 30s
 * trips on legitimately slow-but-healthy starts and surfaces the
 * recovery card to users whose runtime is, in fact, about to come up
 * — see screenshot in PR #(fix/ios-sentry-launch-crash) where the card
 * appeared on a normal cold start and the runtime became ready ~5s
 * later.
 */
const STALL_THRESHOLD_MS = 45_000

/**
 * Per-project warm-resolution cache.
 *
 * Switching away from a project and back remounts this hook, which would
 * otherwise reset `ready=false`, blank the URLs, and re-poll `/sandbox/url` —
 * re-showing the "Starting your project…" gate even though the runtime never
 * went anywhere (the desktop RuntimeManager keeps the last-N previews warm and
 * `resolveProjectPodUrl` short-circuits on a running runtime). We cache the
 * last successful resolution per `${apiBaseUrl}|${projectId}` so a remount
 * seeds `ready=true` with the known URLs immediately. The background poll still
 * runs and is authoritative: if it reports the runtime is genuinely down
 * (`ready:false` or a hard 4xx), we drop the optimistic seed and the cache so a
 * truly cold runtime still shows the loading gate.
 */
type ResolvedUrls = {
  agentUrl: string | null
  previewUrl: string | null
  canvasBaseUrl: string | null
}
const warmResolutionCache = new Map<string, ResolvedUrls>()
function warmCacheKey(apiBaseUrl: string, projectId: string): string {
  return `${apiBaseUrl}|${projectId}`
}

export function useAgentUrl(
  apiBaseUrl: string,
  projectId: string | undefined,
  options?: {
    credentials?: RequestCredentials
    localAgentUrl?: string | null
    headers?: () => Record<string, string>
    fetch?: typeof globalThis.fetch
  },
) {
  // Warm switch-back: seed initial state from the last successful resolution
  // for this project so a remount renders the warm preview immediately rather
  // than flashing the loading gate. The background poll below revalidates.
  const localAgentUrl = options?.localAgentUrl ?? null
  const initialWarm =
    !localAgentUrl && projectId
      ? warmResolutionCache.get(warmCacheKey(apiBaseUrl, projectId)) ?? null
      : null

  const [agentUrl, setAgentUrl] = useState<string | null>(localAgentUrl ?? initialWarm?.agentUrl ?? null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialWarm?.previewUrl ?? null)
  const [canvasBaseUrl, setCanvasBaseUrl] = useState<string | null>(initialWarm?.canvasBaseUrl ?? null)
  const [error, setError] = useState<string | null>(null)
  const [stalled, setStalled] = useState<boolean>(false)
  const [lastStatus, setLastStatus] = useState<string | null>(initialWarm ? 'ready' : null)
  // Local-agent-url short-circuit always counts as ready (the caller has
  // pinned an explicit URL, so there's no runtime to wait on). A warm cache
  // hit also starts ready (revalidated by the poll).
  const [ready, setReady] = useState<boolean>(Boolean(localAgentUrl) || Boolean(initialWarm))
  // Bumping this nonce restarts the polling effect, giving callers a
  // manual "retry now" path from a stalled-recovery UI without having
  // to navigate away and back.
  const [retryNonce, setRetryNonce] = useState<number>(0)
  const abortRef = useRef<AbortController | null>(null)

  const retry = useCallback(() => {
    abortRef.current?.abort()
    // Manual retry is a recovery path — drop any optimistic warm seed so the
    // re-poll is authoritative and the loading gate reflects the real state.
    if (projectId) warmResolutionCache.delete(warmCacheKey(apiBaseUrl, projectId))
    setRetryNonce((n) => n + 1)
  }, [apiBaseUrl, projectId])

  useEffect(() => {
    if (options?.localAgentUrl) {
      setAgentUrl(options.localAgentUrl)
      setReady(true)
      setError(null)
      return
    }

    if (!projectId) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const doFetch = options?.fetch ?? fetch

    // On a (projectId / apiBaseUrl) change, seed from the warm cache when we
    // have a known-good resolution for the *incoming* project (fast
    // switch-back, no Loading flash); otherwise reset to the "starting" phase
    // so we don't show a stale `ready=true` from the previous project.
    const cacheKey = warmCacheKey(apiBaseUrl, projectId)
    const warm = warmResolutionCache.get(cacheKey)
    if (warm) {
      setAgentUrl(warm.agentUrl)
      setPreviewUrl(warm.previewUrl)
      setCanvasBaseUrl(warm.canvasBaseUrl)
      setReady(true)
      setError(null)
      setStalled(false)
      setLastStatus('ready')
    } else {
      setReady(false)
      setAgentUrl(null)
      setPreviewUrl(null)
      setCanvasBaseUrl(null)
      setError(null)
      setStalled(false)
      setLastStatus(null)
    }

    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    stallTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        setStalled(true)
        csMark('useAgentUrl:stalled', { projectId, attempts: attempt })
      }
    }, STALL_THRESHOLD_MS)

    const cleanup = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
      controller.abort()
    }

    const scheduleRetry = () => {
      if (controller.signal.aborted) return
      const delay = nextRetryDelayMs(attempt++)
      retryTimer = setTimeout(() => {
        retryTimer = null
        void poll()
      }, delay)
    }

    const poll = async (): Promise<void> => {
      const pollStart = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      const pollAttempt = attempt
      csMark('useAgentUrl:poll:start', { attempt: pollAttempt, projectId })
      try {
        const res = await doFetch(`${apiBaseUrl}/api/projects/${projectId}/sandbox/url`, {
          credentials: options?.credentials,
          headers: options?.headers?.(),
          signal: controller.signal,
        })

        const pollEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        csMark('useAgentUrl:poll:end', {
          attempt: pollAttempt,
          projectId,
          status: res.status,
          durMs: Math.round(pollEnd - pollStart),
        })

        // 503 = warm pool / VM still booting (see /sandbox/url's
        // `vm_pool_unavailable` branch in apps/api/src/routes/runtime.ts).
        // Retry rather than surfacing as a hard error.
        if (res.status === 503) {
          if (!controller.signal.aborted) {
            setError(null)
            setLastStatus('warming')
            scheduleRetry()
          }
          return
        }

        if (!res.ok) {
          // Authoritative failure (401 expired auth, 403 not-a-member,
          // 404 project deleted, 5xx server). Surface the status so the
          // UI can show "Open on web / sign in again" instead of an
          // infinite spinner.
          // Authoritative failure for a project: drop any optimistic warm
          // seed/cache so switch-back can't keep showing a dead runtime.
          warmResolutionCache.delete(cacheKey)
          if (!controller.signal.aborted) {
            setAgentUrl(null)
            setPreviewUrl(null)
            setCanvasBaseUrl(null)
            setReady(false)
            setError(`Failed to get sandbox URL (HTTP ${res.status})`)
            setLastStatus(`http_${res.status}`)
          }
          if (res.status >= 500) scheduleRetry()
          return
        }

        const data = await res.json()
        const isReady = data?.ready === true

        if (!isReady) {
          csMark('useAgentUrl:not-ready', { attempt: pollAttempt, status: data?.status })
          // Host runtime is still `'starting'`. The runtime is NOT warm, so
          // revert any optimistic switch-back seed and drop the cache: keep
          // URLs hidden so consumers don't hit ECONNREFUSED, show the loading
          // gate, and try again shortly.
          warmResolutionCache.delete(cacheKey)
          if (!controller.signal.aborted) {
            setAgentUrl(null)
            setPreviewUrl(null)
            setCanvasBaseUrl(null)
            setReady(false)
            setError(null)
            setLastStatus(typeof data?.status === 'string' ? data.status : 'pending')
            scheduleRetry()
          }
          return
        }
        csMark('useAgentUrl:ready', { attempt: pollAttempt, projectId })

        let resolvedAgent = data.agentUrl || data.url || null
        let resolvedPreview = data.url || null
        let resolvedCanvas = data.canvasBaseUrl || resolvedAgent || null

        if (resolvedAgent) {
          resolvedAgent = rewriteLocalhostUrl(resolvedAgent, apiBaseUrl)
        }
        if (resolvedPreview) {
          resolvedPreview = rewriteLocalhostUrl(resolvedPreview, apiBaseUrl)
        }
        if (resolvedCanvas) {
          resolvedCanvas = rewriteLocalhostUrl(resolvedCanvas, apiBaseUrl)
        }

        // Cache the warm resolution so a later remount (switch-back) seeds
        // ready immediately instead of re-running the loading gate.
        warmResolutionCache.set(cacheKey, {
          agentUrl: resolvedAgent,
          previewUrl: resolvedPreview,
          canvasBaseUrl: resolvedCanvas,
        })

        if (!controller.signal.aborted) {
          setAgentUrl(resolvedAgent)
          setPreviewUrl(resolvedPreview)
          setCanvasBaseUrl(resolvedCanvas)
          setReady(true)
          setStalled(false)
          setLastStatus('ready')
          setError(null)
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = null
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        if (controller.signal.aborted) return
        // Network blip / transient failure — surface the message but keep
        // retrying so a momentary disconnect doesn't permanently strand the
        // consumer in a loading state.
        setError(err?.message ?? 'Failed to get sandbox URL')
        scheduleRetry()
      }
    }

    void poll()

    return cleanup
  }, [apiBaseUrl, projectId, options?.localAgentUrl, options?.credentials, retryNonce])

  return { agentUrl, previewUrl, canvasBaseUrl, ready, error, stalled, lastStatus, retry }
}
