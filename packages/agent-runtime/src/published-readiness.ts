// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Readiness decision for server-backed PUBLISHED apps (`SHOGO_PUBLISHED_MODE`).
 *
 * Extracted as a pure function so the gating logic is unit-testable without
 * importing the full runtime server (which has heavy import-time side effects).
 *
 * Why published mode is special: a published pod hydrates a prebuilt `dist/`
 * from git long before the project's `server.tsx` (`/api/*`) is up. The default
 * `/ready` path accepts a readable `dist/` (`distReady`), which would mark the
 * pod routable while the API still 503s `phase:idle` — surfacing to end users
 * as "Could not find <name>" on a cold start. So in published mode we gate on
 * the inner API server instead. `apiReady` is
 * `hasApiServer === false || apiServerPhase === 'healthy'`, so a published app
 * with no sidecar (detected static-only) still reports ready and is never
 * falsely blocked.
 */

export interface PublishedReadinessInput {
  apiReady: boolean
  apiServerPhase: string
}

export interface PublishedReadinessDecision {
  status: 200 | 503
  body:
    | { ready: true; apiServerPhase: string }
    | { ready: false; reason: string; apiServerPhase: string }
}

export function computePublishedReadiness(
  input: PublishedReadinessInput,
): PublishedReadinessDecision {
  if (!input.apiReady) {
    return {
      status: 503,
      body: {
        ready: false,
        reason: 'api server not healthy',
        apiServerPhase: input.apiServerPhase,
      },
    }
  }
  return { status: 200, body: { ready: true, apiServerPhase: input.apiServerPhase } }
}
