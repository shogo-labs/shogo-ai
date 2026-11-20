// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for isPublicChannelIngressPath and its effect on isGatePublicPath.
 * AC1 requirement: near-miss paths must NOT become public, only the exact
 * WhatsApp webhook paths.
 */
import { describe, test, expect } from 'bun:test'
import { isPublicChannelIngressPath, isGatePublicPath } from '../middleware/api-auth-gate'

const PID = 'proj-abc123'

describe('isPublicChannelIngressPath', () => {
  const shouldPass = [
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook`,
    `/api/projects/${PID}/agent-proxy/webhooks/whatsapp`,
    `/api/projects/other-id/agent-proxy/agent/channels/whatsapp/webhook`,
  ]

  const shouldFail = [
    // Near misses — must NOT be public
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook/extra`,
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook/`,
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp`,
    `/api/projects/${PID}/agent-proxy/agent/channels/teams/messages`,
    `/api/projects/${PID}/agent-proxy/agent/channels/webhook/incoming`,
    `/api/projects/${PID}/agent-proxy/agent/chat`,
    `/api/projects/${PID}/agent-proxy`,
    // No agent-proxy segment
    `/api/projects/${PID}/agent/channels/whatsapp/webhook`,
    `/api/agent/channels/whatsapp/webhook`,
    // Webchat (covered by isAllowedUnauthWebchatProxyPath, not this fn)
    `/api/projects/${PID}/agent-proxy/agent/channels/webchat/health`,
  ]

  for (const path of shouldPass) {
    test(`passes: ${path}`, () => {
      expect(isPublicChannelIngressPath(path)).toBe(true)
    })
  }

  for (const path of shouldFail) {
    test(`blocks: ${path}`, () => {
      expect(isPublicChannelIngressPath(path)).toBe(false)
    })
  }
})

describe('isGatePublicPath includes WhatsApp webhook', () => {
  test('canonical WhatsApp path is gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook`)).toBe(true)
  })

  test('legacy alias is gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/webhooks/whatsapp`)).toBe(true)
  })

  test('agent chat is NOT gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/chat`)).toBe(false)
  })

  test('teams endpoint is NOT gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/teams/messages`)).toBe(false)
  })
})
