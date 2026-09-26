// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { authenticateLiveHeaders } from '../lib/live-auth'
import { createLiveWebRtcSession, liveErrorBody } from '../lib/live-webrtc'
import type { LiveSessionStart } from '../lib/live-session'

export function aiLiveRoutes() {
  const router = new Hono()

  router.post('/ai/v1/live/sessions', async (c) => {
    const tokenPayload = await authenticateLiveHeaders(c.req.raw.headers)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401,
      )
    }

    let body: { session?: LiveSessionStart; transport?: { type?: string; sdp?: string } }
    try {
      body = await c.req.json()
    } catch {
      return c.json(liveErrorBody('Request body must be valid JSON.', 'invalid_request'), 400)
    }
    if (!body.session || body.transport?.type !== 'webrtc' || !body.transport.sdp?.trim()) {
      return c.json(liveErrorBody('Expected session and transport: { type: "webrtc", sdp }.', 'invalid_transport'), 400)
    }

    return createLiveWebRtcSession({
      tokenPayload,
      session: body.session,
      sdp: body.transport.sdp,
      signal: c.req.raw.signal,
    })
  })

  return router
}
