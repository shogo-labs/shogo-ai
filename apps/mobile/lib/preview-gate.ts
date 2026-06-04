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
 * Whether `usePreviewPhase` should stop polling `/preview/status`.
 *
 * We keep polling while the preview is `running` but the API isn't ready yet:
 * the prebuilt-`dist/` start path flips `running` true immediately, well
 * before the sidecar comes up, so `running` alone is not a safe stop signal.
 * Stop only once the API is also ready (or absent).
 */
export function shouldStopPreviewPoll(status: PreviewStatusLike): boolean {
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
