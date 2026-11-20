// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for isPublicChannelIngressPath and its effect on isGatePublicPath.
 * AC1 requirement: near-miss paths must NOT become public; only the exact
 * channel ingress paths (WhatsApp webhook, Teams messages) are public.
 */
import { describe, test, expect } from 'bun:test'
import { isPublicChannelIngressPath, isGatePublicPath } from '../middleware/api-auth-gate'

const PID = 'proj-abc123'

describe('isPublicChannelIngressPath', () => {
  const shouldPass = [
    // WhatsApp canonical + legacy alias
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook`,
    `/api/projects/${PID}/agent-proxy/webhooks/whatsapp`,
    `/api/projects/other-id/agent-proxy/agent/channels/whatsapp/webhook`,
    // Teams messages endpoint
    `/api/projects/${PID}/agent-proxy/agent/channels/teams/messages`,
    `/api/projects/other-id/agent-proxy/agent/channels/teams/messages`,
  ]

  const shouldFail = [
    // Near misses — must NOT be public
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook/extra`,
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook/`,
    `/api/projects/${PID}/agent-proxy/agent/channels/whatsapp`,
    // Teams near misses
    `/api/projects/${PID}/agent-proxy/agent/channels/teams/messages/extra`,
    `/api/projects/${PID}/agent-proxy/agent/channels/teams/`,
    `/api/projects/${PID}/agent-proxy/agent/channels/teams`,
    // webhook/incoming is public since SHO-462 (covered in agent-proxy-webhook-ingress.test.ts)
    `/api/projects/${PID}/agent-proxy/agent/chat`,
    `/api/projects/${PID}/agent-proxy`,
    // No agent-proxy segment
    `/api/projects/${PID}/agent/channels/whatsapp/webhook`,
    `/api/agent/channels/whatsapp/webhook`,
    `/api/projects/${PID}/agent/channels/teams/messages`,
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

describe('isGatePublicPath includes WhatsApp and Teams ingress', () => {
  test('canonical WhatsApp path is gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/whatsapp/webhook`)).toBe(true)
  })

  test('legacy WhatsApp alias is gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/webhooks/whatsapp`)).toBe(true)
  })

  test('Teams messages path is gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/teams/messages`)).toBe(true)
  })

  test('agent chat is NOT gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/chat`)).toBe(false)
  })

  test('Teams near-miss path is NOT gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/teams/messages/extra`)).toBe(false)
  })

  test('Teams prefix without endpoint is NOT gate-public', () => {
    expect(isGatePublicPath(`/api/projects/${PID}/agent-proxy/agent/channels/teams/`)).toBe(false)
  })
})
