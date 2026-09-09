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
 * Stop once the API is ready (or absent), OR once setup has terminally failed.
 */
export function shouldStopPreviewPoll(status: PreviewStatusLike): boolean {
  if (isPreviewFailed(status)) return true
  return !!status.running && resolveApiReady(status)
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

export function previewWakeUrl(apiBaseUrl: string, projectId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/api/preview/${encodeURIComponent(projectId)}/wake`
}
