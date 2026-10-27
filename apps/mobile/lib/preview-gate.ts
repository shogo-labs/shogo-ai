// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure helpers for the preview "wait for the API before loading the UI" gate,
 * extracted from `projects/[id]/_layout.tsx` so they can be unit-tested
 * without importing the (expo-router) route module and its native deps.
 *
 * Why this gate exists: the project preview serves the app UI (static `dist/`)
 * as soon as the dev server is reachable, but the project's API sidecar
 * (`server.tsx`) binds its port a little later. If the iframe loads in that
 * window the SPA's `/api/*` calls fire into a server that isn't up yet and the
 * app "shows nothing". `PreviewManager.getStatus()` now reports `apiReady`
 * (true once the sidecar is healthy, or the project has no sidecar) so the
 * client can hold the iframe until the backend is actually responding.
 */

/** Subset of the `/preview/status` JSON the gate reads. */
export interface PreviewStatusLike {
  running?: boolean
  /**
   * Added 2026-06: true once the project's API sidecar passed its `/health`
   * check, or the project has no sidecar at all. Absent on older runtimes
   * whose `/preview/status` predates the field.
   */
  apiReady?: boolean
  apiServerPhase?: string
  phase?: string
  /**
   * Added 2026-09: true from the moment a metal cold-miss hydrate schedules
   * a rebuild (`scheduleHydrateRebuild()` in `packages/agent-runtime/src/server.ts`)
   * until that rebuild actually completes. While true, `running`/`apiReady`
   * still describe the warm-pool TEMPLATE that's about to be replaced by the
   * project's real, hydrated content — see {@link resolveRunning}. Absent
   * (undefined) on runtimes that never went through a hydrate (snapshot
   * resume, non-metal modes, older runtimes predating the field) — those
   * degrade to the pre-existing `running`-only behaviour.
   */
  hydrateRebuildPending?: boolean
}

/**
 * Resolve `apiReady` from a status payload. A missing field (older runtime
 * that predates `apiReady`) degrades to `true`, so the gate falls back to the
 * legacy `running`-only behaviour instead of hanging on a spinner forever.
 */
export function resolveApiReady(status: PreviewStatusLike): boolean {
  return status.apiReady ?? true
}

/**
 * Resolve the effective "the dev server is serving the project's real
 * content" signal.
 *
 * Folds in `hydrateRebuildPending`: while a post-hydrate rebuild is pending,
 * the raw `running` flag reflects the warm-pool TEMPLATE (a cold-miss assign
 * boots a blank template, then hydrates the real source and schedules a
 * rebuild — see `pool.ts`'s `workspaceOrigin: 'template'` and
 * `scheduleHydrateRebuild()` in `server.ts`). Reporting that as "running" lets
 * `usePreviewReadiness`'s one-way latch mount the canvas iframe against the
 * template and never revisit it once the real rebuild lands — the project
 * appears permanently stuck on the "Project Ready" placeholder even though
 * the backend has since finished booting the real app.
 */
export function resolveRunning(status: PreviewStatusLike): boolean {
  if (status.hydrateRebuildPending) return false
  return !!status.running
}

/**
 * Whether the runtime reported a terminal cold-boot setup failure.
 *
 * `phase === 'failed'` means install/generate/build/API-spawn threw before the
 * preview ever became ready — the project will never come up on its own. The
 * client uses this to stop polling and show a real error instead of an
 * indefinite "loading preview" spinner.
 */
export function isPreviewFailed(status: PreviewStatusLike): boolean {
  return status.phase === 'failed'
}

/**
 * Whether `usePreviewPhase` should stop polling `/preview/status`.
 *
 * We keep polling while the preview is `running` but the API isn't ready yet:
 * the prebuilt-`dist/` start path flips `running` true immediately, well
 * before the sidecar comes up, so `running` alone is not a safe stop signal.
 * We also keep polling for the whole `hydrateRebuildPending` window (see
 * {@link resolveRunning}) so a cold-miss assign doesn't stop polling — and
 * therefore never notice the real content coming up — while it's still
 * looking at the warm-pool template. Stop once the API is ready (or absent)
 * AND the (hydrate-aware) preview is running, OR once setup has terminally
 * failed.
 */
export function shouldStopPreviewPoll(status: PreviewStatusLike): boolean {
  if (isPreviewFailed(status)) return true
  return resolveRunning(status) && resolveApiReady(status)
}

/**
 * Whether the canvas iframe should be mounted.
 *
 * Requires the dev server to be reachable (`baseReady`) AND the API sidecar to
 * have been healthy at least once (`apiLatched`). `timedOut` is a safety
 * valve: a sidecar that never reports healthy (crash loop, template without a
 * `/health` route) still eventually shows the app instead of spinning forever.
 */
export function shouldShowCanvas(input: {
  baseReady: boolean
  apiLatched: boolean
  timedOut: boolean
}): boolean {
  return input.baseReady && (input.apiLatched || input.timedOut)
}

/**
 * Per-tab memory of which previews already cleared the API gate.
 *
 * The gate's latch used to live in component state only, so every fresh mount
 * of the canvas panel (navigating away and back, switching tabs, re-opening the
 * project) started closed and re-showed "Starting API server..." until the
 * status poll — or the 20s fallback — opened it again, even though the same
 * preview had already been healthy moments earlier. Keyed by the status poll
 * base so different projects (and workspace-runtime `/p/<id>` mounts) don't
 * share a latch.
 */
const latchedApiBases = new Set<string>()

export function isApiGateLatched(key: string | null | undefined): boolean {
  return !!key && latchedApiBases.has(key)
}

export function latchApiGate(key: string | null | undefined): void {
  if (key) latchedApiBases.add(key)
}

/** Test hook. */
export function resetApiGateLatches(): void {
  latchedApiBases.clear()
}

/**
 * Where to poll `/preview/status`.
 *
 * Always prefer the authenticated agent-proxy (`agentUrl`). Native `fetch`
 * cannot send cookies, so polling the public preview host (or the proxy
 * without a Cookie header) 401s forever and the canvas gate times out.
 *
 * Workspace runtimes expose per-project status under `/p/<id>/`; when
 * `canvasBaseUrl` ends with that suffix we poll the matching proxy path
 * instead of the shared runtime's idle global manager.
 */
export function previewStatusPollBase(
  agentUrl: string | null | undefined,
  canvasBaseUrl?: string | null,
): string | null {
  if (!agentUrl) return null
  const trimmed = agentUrl.replace(/\/+$/, '')
  const match = canvasBaseUrl?.match(/\/p\/([^/]+)\/?$/)
  if (match) return `${trimmed}/p/${match[1]}`
  return trimmed
}

/**
 * Native WebView has no Studio cookies. Load the tokenized preview URL
 * (`?__preview_token=`) when we have one; otherwise fall back to the
 * canvas/agent origin.
 */
export function canvasDocumentUrl(input: {
  canvasBaseUrl?: string | null
  agentUrl?: string | null
  previewUrl?: string | null
  native: boolean
}): string | null {
  if (input.native && input.previewUrl && input.previewUrl.includes('__preview_token=')) {
    return input.previewUrl
  }
  const iframeBase = input.canvasBaseUrl || input.agentUrl
  return iframeBase ? `${iframeBase.replace(/\/+$/, '')}/` : null
}

/**
 * Native can load the preview document as soon as `/sandbox/url` is ready.
 *
 * Waiting on `/preview/status` `running` deadlocks on iPhone: the WebView
 * never mounts, the preview-router never sees a document navigation (the
 * same signal that wakes a sleeping preview in a browser), and the 60s
 * gate shows "Connection timed out — The agent runtime could not be
 * reached" even though `useAgentUrl` already succeeded.
 */
export function nativeCanvasBaseReady(input: {
  native: boolean
  agentUrl?: string | null
  previewUrl?: string | null
  canvasBaseUrl?: string | null
}): boolean {
  if (!input.native || !input.agentUrl) return false
  return Boolean(input.previewUrl || input.canvasBaseUrl)
}

export function projectIdFromAgentProxyUrl(agentUrl: string | null | undefined): string | null {
  if (!agentUrl) return null
  const match = agentUrl.match(/\/api\/projects\/([^/]+)\/agent-proxy/)
  return match?.[1] ?? null
}

// ---------------------------------------------------------------------------
// "Is the preview I am looking at still alive?" (SHO-226)
// ---------------------------------------------------------------------------

/**
 * How often a visible canvas pings `POST /projects/:id/preview/active`.
 *
 * The iframe talks straight to `localhost:<agentPort>/p/<id>`, so after
 * `/sandbox/url` returns, the API never hears from that preview again — the
 * warm-preview LRU and the worker's idle reaper both see it as idle and one of
 * them eventually stops it under the user. A minute is frequent enough to keep
 * the pin fresh (the manager's view TTL is 3 minutes) without adding chatter.
 */
export const PREVIEW_ACTIVE_PING_MS = 60_000

/**
 * How many times the canvas re-resolves before it stops trying and shows the
 * recovery UI. Re-resolving restarts the runtime, so an unbounded loop would
 * respawn it forever on a genuinely broken project.
 */
export const PREVIEW_RECOVERY_MAX_ATTEMPTS = 3

/**
 * Runtime states that positively mean "the runtime this canvas was showing is
 * not running any more". `null` (no runtime known to this API) and `starting`
 * are deliberately absent: a machine workspace, a remote/metal runtime and a
 * project this API does not own all answer that way, and none of them is a
 * reason to re-resolve.
 */
const LOST_RUNTIME_STATUSES = new Set(['stopped', 'error'])

/** Subset of the `/preview/active` JSON this module reads. */
export interface PreviewActivePing {
  ok?: boolean
  running?: boolean
  /**
   * Agent-runtime port of the live runtime. `null`/absent when the mode does
   * not own a host runtime (cloud no-op) — the port check is then skipped
   * rather than treated as a mismatch.
   */
  agentPort?: number | null
  /**
   * Lifecycle state of the runtime: `starting` | `running` | `stopping` |
   * `stopped` | `error`, or `null` when this API has no record of one (cloud
   * no-op, a remote/machine runtime, a project that never started).
   */
  status?: string | null
}

export function previewActiveUrl(apiBaseUrl: string, projectId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(projectId)}/preview/active`
}

/**
 * Recovery attempts per project, kept at module scope on purpose.
 *
 * Recovering re-resolves `/sandbox/url`, which drops `ready` to false and
 * unmounts the canvas (its loading gate renders instead) — so a counter held in
 * a component ref restarts at zero on every attempt and
 * {@link PREVIEW_RECOVERY_MAX_ATTEMPTS} can never be reached. That turned one
 * false "lost runtime" signal into an endless re-resolve/remount loop in which
 * the composer and "+ new chat" never settled. Keyed by project alone: keying
 * on the URL would reset the count exactly when a runtime flaps between ports.
 */
const recoveryAttempts = new Map<string, number>()

export function previewRecoveryAttempts(projectId: string | null | undefined): number {
  return (projectId && recoveryAttempts.get(projectId)) || 0
}

export function recordPreviewRecovery(
  projectId: string | null | undefined,
  attempts: number,
): void {
  if (!projectId) return
  if (attempts <= 0) recoveryAttempts.delete(projectId)
  else recoveryAttempts.set(projectId, attempts)
}

/** Test hook. */
export function resetPreviewRecoveryAttempts(): void {
  recoveryAttempts.clear()
}

/**
 * The agent-runtime port the canvas iframe is currently pointed at, from
 * `/sandbox/url`'s `canvasBaseUrl` (`http://localhost:5173/p/<id>` → 5173).
 * `null` when the URL carries no explicit port (subdomain / cloud mode), which
 * makes the port comparison a no-op there.
 */
export function agentPortFromCanvasBaseUrl(
  canvasBaseUrl: string | null | undefined,
): number | null {
  if (!canvasBaseUrl) return null
  try {
    const port = new URL(canvasBaseUrl).port
    const parsed = Number(port)
    return port && Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Did this ping say the runtime the iframe points at is up and unchanged? */
export function isPreviewPingHealthy(
  ping: PreviewActivePing | null,
  canvasBaseUrl: string | null | undefined,
): boolean {
  if (!ping || ping.ok !== true) return false
  if (ping.running === false) return false
  return !previewPortMoved(ping, canvasBaseUrl)
}

/**
 * Did the runtime respawn on a different port than the iframe is on? That is
 * positive evidence — a *successful* ping that names a different live port means
 * the URL in the WebView is stale.
 */
export function previewPortMoved(
  ping: PreviewActivePing | null,
  canvasBaseUrl: string | null | undefined,
): boolean {
  const expected = agentPortFromCanvasBaseUrl(canvasBaseUrl)
  const actual = typeof ping?.agentPort === 'number' ? ping.agentPort : null
  // A port we can't compare on either side is not evidence of a problem.
  return expected != null && actual != null && expected !== actual
}

export type PreviewPingDecision = 'keep' | 'recover' | 'give-up'

export interface PreviewPingVerdict {
  decision: PreviewPingDecision
  /** Consecutive *lost-runtime* signals; 0 as soon as a ping shows it alive. */
  failures: number
  /** Whether this canvas has ever seen this project's runtime reported live. */
  seenRunning: boolean
}

/**
 * Turn a `/preview/active` ping into "keep the iframe, re-resolve it, or give
 * up". Pure so the recovery policy can be unit-tested without a canvas.
 *
 * Recovering is expensive — it re-resolves `/sandbox/url`, which *restarts* the
 * runtime — so only positive evidence counts as a failure signal:
 *
 *  - a successful ping that reports a **different live port** (it respawned), or
 *  - a successful ping that reports **not running** *after this canvas had seen
 *    it running* (it was stopped under us), or
 *  - a successful ping whose `status` is `stopped`/`error`, i.e. the API still
 *    knows a runtime for this project and it is not up.
 *
 * Everything else keeps the iframe. A ping that never reached the API (offline,
 * a blip, a non-2xx, a 404 for a project this API does not own) says nothing
 * about the runtime, and `running:false` on the *first* ping says nothing
 * either: a sleeping machine workspace, a remote/metal runtime and a preview
 * that has not started yet all answer that way, and none of them may be
 * woken or restarted by a canvas that is merely on screen. After
 * {@link PREVIEW_RECOVERY_MAX_ATTEMPTS} consecutive lost-runtime signals the
 * caller stops re-resolving and surfaces its recovery UI.
 */
export function decidePreviewPing(input: {
  ping: PreviewActivePing | null
  canvasBaseUrl?: string | null
  /** Failure count from the previous verdict. */
  failures?: number
  /** Whether a previous ping reported this project's runtime as running. */
  seenRunning?: boolean
  /** `navigator.onLine`; false means we cannot know anything about the runtime. */
  online?: boolean
}): PreviewPingVerdict {
  const failures = input.failures ?? 0
  const seenRunning = input.seenRunning ?? false
  const online = input.online ?? true
  const ping = input.ping ?? null

  // The request never reached the API. Unreachable is not dead.
  if (!ping || ping.ok !== true) return { decision: 'keep', failures, seenRunning }

  if (ping.running !== false) {
    if (previewPortMoved(ping, input.canvasBaseUrl)) {
      const next = failures + 1
      return {
        decision: next >= PREVIEW_RECOVERY_MAX_ATTEMPTS ? 'give-up' : 'recover',
        failures: next,
        seenRunning: true,
      }
    }
    return { decision: 'keep', failures: 0, seenRunning: true }
  }

  // `running:false`. Only a runtime this canvas actually had — or one the API
  // still names as stopped/errored — counts as lost.
  //
  // `starting` is not lost: a cold start answers `running:false` for tens of
  // seconds, and re-resolving then re-enters the project's loading gate, which
  // is what made the whole screen (composer, "+ new chat") unreachable while a
  // preview was simply warming up.
  if (ping.status === 'starting') return { decision: 'keep', failures, seenRunning }

  const lost =
    seenRunning ||
    (online && typeof ping.status === 'string' && LOST_RUNTIME_STATUSES.has(ping.status))
  if (!lost) return { decision: 'keep', failures, seenRunning }

  const next = failures + 1
  return {
    decision: next >= PREVIEW_RECOVERY_MAX_ATTEMPTS ? 'give-up' : 'recover',
    failures: next,
    seenRunning,
  }
}

export function previewWakeUrl(apiBaseUrl: string, projectId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/preview/${encodeURIComponent(projectId)}/wake`
}
