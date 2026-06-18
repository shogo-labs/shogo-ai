// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { computePublishedReadiness } from '../published-readiness'

describe('computePublishedReadiness (server-backed published /ready gate)', () => {
  it('503s while the inner API server is not yet healthy (cold boot)', () => {
    const d = computePublishedReadiness({ apiReady: false, apiServerPhase: 'idle' })
    expect(d.status).toBe(503)
    expect(d.body).toEqual({
      ready: false,
      reason: 'api server not healthy',
      apiServerPhase: 'idle',
    })
  })

  it('503s while the API server is still starting', () => {
    const d = computePublishedReadiness({ apiReady: false, apiServerPhase: 'starting' })
    expect(d.status).toBe(503)
  })

  it('200s once the API server reports healthy', () => {
    const d = computePublishedReadiness({ apiReady: true, apiServerPhase: 'healthy' })
    expect(d.status).toBe(200)
    expect(d.body).toEqual({ ready: true, apiServerPhase: 'healthy' })
  })

  it('200s for a static-only published app (no sidecar => apiReady true)', () => {
    // PreviewManager sets apiReady = (hasApiServer === false || phase healthy).
    // A static published app has no sidecar, so it is ready immediately and
    // must never be falsely blocked.
    const d = computePublishedReadiness({ apiReady: true, apiServerPhase: 'none' })
    expect(d.status).toBe(200)
  })
})
