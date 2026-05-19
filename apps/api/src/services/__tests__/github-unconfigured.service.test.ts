// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

// Module-load consts must be UNSET before the import.
delete process.env.GH_APP_ID
delete process.env.GH_APP_PRIVATE_KEY
delete process.env.GH_APP_CLIENT_ID
delete process.env.GH_APP_CLIENT_SECRET
delete process.env.GH_APP_WEBHOOK_SECRET

mock.module('../../lib/prisma', () => ({ prisma: { gitHubConnection: {} } as any }))
mock.module('jsonwebtoken', () => ({ sign: () => 'unused' }))
mock.module('../git.service', () => ({}))

const svc = await import('../github.service')

describe('github.service with unset env vars', () => {
  it('isConfigured returns false', () => {
    expect(svc.isConfigured()).toBe(false)
  })

  it('generateAppJWT throws', () => {
    expect(() => svc.generateAppJWT()).toThrow(/GitHub App credentials not configured/)
  })

  it('verifyWebhookSignature warns and returns false when GH_APP_WEBHOOK_SECRET is unset', () => {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      expect(svc.verifyWebhookSignature('{}', 'sha256=deadbeef')).toBe(false)
      expect(warns.some((w) => w.includes('Webhook secret not configured'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('getOAuthUrl throws when GH_APP_CLIENT_ID is unset', () => {
    expect(() => svc.getOAuthUrl('s', 'r')).toThrow(/GitHub App client ID not configured/)
  })

  it('exchangeOAuthCode throws when client_id/secret are unset', async () => {
    await expect(svc.exchangeOAuthCode('code')).rejects.toThrow(
      /GitHub App OAuth credentials not configured/,
    )
  })
})
