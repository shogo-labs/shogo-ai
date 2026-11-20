// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The slides viewer has to be frameable, and only the slides viewer (SHO-426).
 *
 * `createApp()` stamps `X-Frame-Options: SAMEORIGIN` on everything, and locally
 * the app (:8081) and the API (:8002) are different origins — so the strip has
 * to be registered ABOVE `secureHeaders()`. Registered below it, secureHeaders
 * is the outer layer: it re-stamps the header after the strip deletes it, the
 * browser refuses the frame, and every deck preview silently falls back to
 * "could not render" while the single-router suite stays green.
 *
 * The route's own test mounts `slidesViewerRoutes()` alone, so it cannot see
 * this — only a response through the real middleware stack can.
 */

import { describe, expect, test } from 'bun:test'
import { createApp } from '../create-app'
import { slidesViewerRoutes } from '../../routes/slides-viewer'

function composeApp() {
  const app = createApp({ profile: 'local' })
  app.route('/api/viewers', slidesViewerRoutes())
  return app
}

describe('slides viewer framing (SHO-426)', () => {
  test('is served without X-Frame-Options so the desktop frame may load it', async () => {
    const res = await composeApp().request('/api/viewers/slides')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('cross-origin-opener-policy')).toBeNull()
    // The sandbox is the thing that keeps it safe; it must survive the strip.
    expect(res.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
  })

  test('every other response keeps the framing hardening', async () => {
    const res = await composeApp().request('/api/health')

    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
  })
})
