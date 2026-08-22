// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Connectivity probe + park-and-wait for the agent loop's offline-outage tier.
 *
 * `inference-retry.ts` already handles short blips: a bounded number of fast
 * `Agent.continue()` re-issues with sub-10s backoff. That budget is far too
 * small for a real outage (wifi handoff, tethering, VPN flap, captive
 * portal, laptop sleep/wake), which can last minutes. Rather than guess from
 * error text whether an exhausted retry means "no internet" or "provider is
 * having an issue", the agent loop asks: it probes a locally-known upstream
 * health endpoint (see `apps/api/src/routes/ai-proxy.ts`'s
 * `GET /ai/upstream-health`, injected into the runtime child as
 * `AI_UPSTREAM_HEALTH_URL`) and only "parks" — polling with backoff until
 * reachable again — when that probe itself can't get a response.
 *
 * This module owns:
 *   - `probeConnectivity`: a single reachability check against a URL. Any
 *     HTTP response (even 4xx/5xx) counts as reachable — the point is only
 *     to detect "no network path at all" (DNS failure, connection refused/
 *     reset, timeout), not to validate the upstream is healthy.
 *   - `waitForConnectivity`: polls `probeConnectivity` with capped backoff
 *     (1s → 5s → 15s) until reachable, aborted, or a max-wait budget is
 *     exhausted. The 15s cap is deliberate: it keeps heartbeat ticks well
 *     under both the client's 180s stall-watchdog threshold
 *     (`apps/mobile/lib/chat-stall-watchdog.ts`) and typical stream-buffer
 *     grace windows, so a parked turn's SSE connection stays alive.
 *
 * The actual "park" decision and `Agent.continue()` re-issue live in
 * `agent-loop.ts` (it needs the live `Agent` and retry-classification
 * state) — this module is pure polling logic with fully injectable time/
 * network seams so it's testable without real timers or real network calls.
 */

export interface ProbeConnectivityOptions {
  /** Per-attempt timeout in ms. Default 3000. */
  timeoutMs?: number
  /** Injectable fetch (tests can stub network behavior). */
  fetchImpl?: typeof fetch
}

/**
 * Check whether `url` is reachable. Any HTTP response — including 4xx/5xx —
 * counts as reachable, since the goal is only to detect a dead network path,
 * not to validate that the upstream service itself is healthy. Returns
 * `false` on any network-level failure (DNS, connection refused/reset,
 * timeout) or a thrown error.
 */
export async function probeConnectivity(
  url: string,
  options: ProbeConnectivityOptions = {},
): Promise<boolean> {
  const { timeoutMs = 3_000, fetchImpl = fetch } = options
  try {
    await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

export interface ConnectivityWaitInfo {
  /** 1-based probe attempt index. */
  attempt: number
  /** Milliseconds elapsed since `waitForConnectivity` was called. */
  elapsedMs: number
  /** Milliseconds until the next probe (the backoff delay about to be slept). */
  nextProbeInMs: number
}

export type WaitForConnectivityResult =
  /** A probe succeeded — the caller should reset its retry budget and resume. */
  | 'reconnected'
  /** `signal` fired before a probe succeeded. */
  | 'aborted'
  /** `maxWaitMs` elapsed without a successful probe. */
  | 'timed_out'
  /** No `probeUrl` was configured — caller should fall back to failing fast. */
  | 'no_probe_url'

export interface WaitForConnectivityOptions {
  /** URL to probe. If omitted, resolves immediately with `'no_probe_url'`. */
  probeUrl?: string
  /** Abort the wait (e.g. user Stop). Checked before every probe and sleep. */
  signal?: AbortSignal
  /**
   * Overall wait budget in ms. `0` means unlimited. Defaults to
   * `resolveMaxWaitMs()` (env `SHOGO_OFFLINE_MAX_WAIT_MS`, else 30 minutes).
   */
  maxWaitMs?: number
  /** Invoked before every sleep, including the very first (attempt 1). */
  onWaiting?: (info: ConnectivityWaitInfo) => void
  /** Injectable probe (tests script a sequence of reachable/unreachable). */
  probe?: (url: string) => Promise<boolean>
  /** Injectable sleep (tests replace with an instant no-op that records calls). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock (tests use a fake clock for deterministic elapsed math). */
  now?: () => number
}

const BACKOFF_STEPS_MS = [1_000, 5_000, 15_000]
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000 // 30 minutes

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Resolve the effective max-wait budget in ms. `0` (explicit or via env)
 * means unlimited (park forever until reconnect or user cancel).
 *
 * Env: `SHOGO_OFFLINE_MAX_WAIT_MS=<n>` overrides the default (30 min).
 */
export function resolveMaxWaitMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit
  const envVal = envInt('SHOGO_OFFLINE_MAX_WAIT_MS')
  if (envVal !== undefined && envVal >= 0) return envVal
  return DEFAULT_MAX_WAIT_MS
}

function nextBackoffMs(attempt: number): number {
  const idx = Math.min(attempt, BACKOFF_STEPS_MS.length - 1)
  return BACKOFF_STEPS_MS[idx]
}

/** Resolve `promise` early (as `'aborted'`) if `signal` fires first. */
function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<'done' | 'aborted'> {
  if (!signal) return sleep(ms).then(() => 'done' as const)
  if (signal.aborted) return Promise.resolve('aborted' as const)
  return new Promise((resolve) => {
    const onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    void sleep(ms).then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('done')
    })
  })
}

/**
 * Poll `probeUrl` until it reports reachable, `signal` aborts, or
 * `maxWaitMs` elapses. Backoff is capped at 15s so `onWaiting` heartbeats
 * fire often enough to keep a parked turn's SSE stream alive (see module
 * doc). Resolves `'reconnected'` the moment a probe succeeds so the caller
 * can reset its fast-retry budget and re-issue the dropped inference call.
 */
export async function waitForConnectivity(
  options: WaitForConnectivityOptions,
): Promise<WaitForConnectivityResult> {
  const { probeUrl, signal, onWaiting } = options
  if (!probeUrl) return 'no_probe_url'
  if (signal?.aborted) return 'aborted'

  const probe = options.probe ?? ((url: string) => probeConnectivity(url))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const maxWaitMs = resolveMaxWaitMs(options.maxWaitMs)

  const start = now()
  let attempt = 0

  while (true) {
    if (signal?.aborted) return 'aborted'
    if (maxWaitMs > 0 && now() - start >= maxWaitMs) return 'timed_out'

    const reachable = await probe(probeUrl)
    if (reachable) return 'reconnected'

    if (signal?.aborted) return 'aborted'

    attempt++
    const elapsedMs = now() - start
    if (maxWaitMs > 0 && elapsedMs >= maxWaitMs) return 'timed_out'

    let delayMs = nextBackoffMs(attempt - 1)
    if (maxWaitMs > 0) delayMs = Math.min(delayMs, maxWaitMs - elapsedMs)
    if (delayMs <= 0) return 'timed_out'

    onWaiting?.({ attempt, elapsedMs, nextProbeInMs: delayMs })

    const raceResult = await sleepAbortable(delayMs, signal, sleep)
    if (raceResult === 'aborted') return 'aborted'
  }
}
