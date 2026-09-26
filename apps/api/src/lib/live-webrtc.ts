// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ProxyTokenPayload } from './ai-proxy-token'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'
import {
  ensureLiveSessionMeter,
  type LiveSessionMeterContext,
} from './live-session-meter'
import { startLiveSidebandMeter } from './live-session-relay'
import { validateLiveSessionStart, type LiveSessionStart } from './live-session'
import { getShogoCloudUrl } from './cloud-urls'
import * as billingService from '../services/billing-runtime'

const isLocalDev = process.env.SHOGO_LOCAL_MODE === 'true'

function cloudForwarding(): boolean {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || !process.env.SHOGO_API_KEY) return false
  const mode = process.env.AI_MODE
  return mode !== 'api-keys' && mode !== 'local-llm'
}

export function liveErrorBody(
  message: string,
  code: string,
): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: 'invalid_request_error', code } }
}

export interface LiveWebRtcSessionInput {
  tokenPayload: ProxyTokenPayload
  session: LiveSessionStart
  sdp: string
  signal?: AbortSignal
}

/**
 * Create an OpenAI Live WebRTC session after Shogo validation and billing
 * admission. The returned response is the provider's session payload, with
 * server-side metering attached to the new session.
 */
export async function createLiveWebRtcSession(
  input: LiveWebRtcSessionInput,
): Promise<Response> {
  const { tokenPayload, session, sdp, signal } = input
  const validation = await validateLiveSessionStart(tokenPayload, session, {
    allowCloudForwarding: cloudForwarding(),
  })
  if (!validation.ok) {
    return Response.json(liveErrorBody(validation.message, validation.code), {
      status: validation.status,
    })
  }

  if (!isLocalDev) {
    const balance = await billingService.checkUsageBalance(tokenPayload.workspaceId)
    if (!balance.ok) {
      const { code, message } = billingService.usageLimitErrorPayload(balance.reason)
      return Response.json(liveErrorBody(message, code), { status: 402 })
    }
  }

  const upstreamSession: LiveSessionStart = {
    ...session,
    model: validation.upstreamModel,
    ...(validation.upstreamBackendModel && session.delegation?.responses
      ? {
          delegation: {
            ...session.delegation,
            responses: {
              ...session.delegation.responses,
              model: validation.upstreamBackendModel,
            },
          },
        }
      : {}),
  }
  const upstreamBody = {
    session: upstreamSession,
    transport: { type: 'webrtc', sdp },
  }
  const requestBody = JSON.stringify(upstreamBody)

  if (cloudForwarding()) {
    const cloudResponse = await fetch(`${getShogoCloudUrl()}/api/ai/v1/live/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SHOGO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal,
    })
    return new Response(cloudResponse.body, {
      status: cloudResponse.status,
      headers: {
        'Content-Type': cloudResponse.headers.get('Content-Type') || 'application/json',
      },
    })
  }

  const apiKey = getNativeProviderApiKeySync('openai')
  if (!apiKey) {
    return Response.json(
      liveErrorBody(
        'The OpenAI provider is not configured for Live Sessions.',
        'provider_not_configured',
      ),
      { status: 503 },
    )
  }

  const upstream = await fetch('https://api.openai.com/v1/live/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: requestBody,
    signal,
  })
  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    })
  }

  const response = await upstream.json() as {
    session?: { id?: string }
  } & Record<string, unknown>
  const sessionId = response.session?.id
  if (typeof sessionId === 'string') {
    const context: LiveSessionMeterContext = {
      sessionId,
      tokenPayload,
      model: session.model as string,
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

  return Response.json(response)
}
