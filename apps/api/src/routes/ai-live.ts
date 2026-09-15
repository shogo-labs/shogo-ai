// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { authenticateLiveHeaders } from '../lib/live-auth'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'
import {
  ensureLiveSessionMeter,
  type LiveSessionMeterContext,
} from '../lib/live-session-meter'
import { startLiveSidebandMeter } from '../lib/live-session-relay'
import { validateLiveSessionStart, type LiveSessionStart } from '../lib/live-session'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import * as billingService from '../services/billing.service'

const isLocalDev = process.env.SHOGO_LOCAL_MODE === 'true'

function cloudForwarding(): boolean {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || !process.env.SHOGO_API_KEY) return false
  const mode = process.env.AI_MODE
  return mode !== 'api-keys' && mode !== 'local-llm'
}

function errorBody(message: string, code: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: 'invalid_request_error', code } }
}

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
      return c.json(errorBody('Request body must be valid JSON.', 'invalid_request'), 400)
    }
    if (!body.session || body.transport?.type !== 'webrtc' || !body.transport.sdp?.trim()) {
      return c.json(errorBody('Expected session and transport: { type: "webrtc", sdp }.', 'invalid_transport'), 400)
    }

    const validation = await validateLiveSessionStart(tokenPayload, body.session, {
      allowCloudForwarding: cloudForwarding(),
    })
    if (!validation.ok) {
      return c.json(errorBody(validation.message, validation.code), validation.status)
    }

    if (!isLocalDev) {
      const balance = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balance.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balance.reason)
        return c.json(errorBody(message, code), 402)
      }
    }

    const upstreamSession: LiveSessionStart = {
      ...body.session,
      model: validation.upstreamModel,
      ...(validation.upstreamBackendModel && body.session.delegation?.responses
        ? {
            delegation: {
              ...body.session.delegation,
              responses: {
                ...body.session.delegation.responses,
                model: validation.upstreamBackendModel,
              },
            },
          }
        : {}),
    }
    const upstreamBody = { ...body, session: upstreamSession }
    const requestBody = JSON.stringify(upstreamBody)
    if (cloudForwarding()) {
      const cloudResponse = await fetch(`${getShogoCloudUrl()}/api/ai/v1/live/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SHOGO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: c.req.raw.signal,
      })
      return new Response(cloudResponse.body, {
        status: cloudResponse.status,
        headers: { 'Content-Type': cloudResponse.headers.get('Content-Type') || 'application/json' },
      })
    }

    const apiKey = getNativeProviderApiKeySync('openai')
    if (!apiKey) {
      return c.json(errorBody('The OpenAI provider is not configured for Live Sessions.', 'provider_not_configured'), 503)
    }

    const upstream = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: c.req.raw.signal,
    })
    if (!upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
      })
    }

    const response = await upstream.json() as any
    const sessionId = response?.session?.id
    if (typeof sessionId === 'string') {
      const context: LiveSessionMeterContext = {
        sessionId,
        tokenPayload,
        model: body.session.model as string,
        backendModel: validation.backendModel,
        transport: 'webrtc',
        responseIds: new Set(),
      }
      try {
        await ensureLiveSessionMeter(context)
      } catch (error) {
        // Session creation succeeded; metering failures must not strand a
        // user's live call. The sideband will retry updates when available.
        console.error('[Live] failed to initialize session meter:', error)
      }
      startLiveSidebandMeter(context, apiKey)
    }

    return c.json(response)
  })

  return router
}
