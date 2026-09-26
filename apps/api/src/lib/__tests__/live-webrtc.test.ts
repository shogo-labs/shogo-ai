// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect, beforeEach, mock } from 'bun:test'

process.env.SHOGO_LOCAL_MODE = 'true'
process.env.AI_MODE = 'api-keys'

const validateLiveSessionStart = mock(async () => ({
  ok: true as const,
  model: {} as any,
  backendModel: 'gpt-6-luna',
  upstreamModel: 'gpt-live-1',
  upstreamBackendModel: 'gpt-6-luna',
}))
const ensureLiveSessionMeter = mock(async () => {})
const startLiveSidebandMeter = mock(() => {})

mock.module('../live-session', () => ({
  validateLiveSessionStart,
}))
mock.module('../live-session-meter', () => ({
  ensureLiveSessionMeter,
}))
mock.module('../live-session-relay', () => ({
  startLiveSidebandMeter,
}))
mock.module('../../services/provider-credentials.service', () => ({
  getNativeProviderApiKeySync: () => 'openai-test-key',
}))
mock.module('../cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.example.test',
}))
mock.module('../../services/billing-runtime', () => ({
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: () => ({ code: 'usage_limit_reached', message: 'limited' }),
}))

const { createLiveWebRtcSession } = await import('../live-webrtc')

const tokenPayload = {
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  userId: 'user-1',
  type: 'ai-proxy' as const,
  authKind: 'session' as const,
  iat: 1,
  exp: 2,
}

describe('createLiveWebRtcSession', () => {
  beforeEach(() => {
    validateLiveSessionStart.mockClear()
    ensureLiveSessionMeter.mockClear()
    startLiveSidebandMeter.mockClear()
  })

  test('forwards the validated session and starts WebRTC metering', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.openai.com/v1/live/sessions')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer openai-test-key',
      })
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({
        session: {
          model: 'gpt-live-1',
          delegation: {
            type: 'responses',
            responses: { model: 'gpt-6-luna' },
          },
        },
        transport: { type: 'webrtc', sdp: 'offer-sdp' },
      })
      return new Response(JSON.stringify({
        session: { id: 'live-session-1' },
        transport: { type: 'webrtc', sdp: 'answer-sdp' },
      }), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as typeof fetch
    try {
      const response = await createLiveWebRtcSession({
        tokenPayload,
        session: {
          model: 'gpt-live-1',
          delegation: {
            type: 'responses',
            responses: { model: 'gpt-6-luna' },
          },
        },
        sdp: 'offer-sdp',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        session: { id: 'live-session-1' },
      })
      expect(ensureLiveSessionMeter).toHaveBeenCalledTimes(1)
      expect(startLiveSidebandMeter).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
