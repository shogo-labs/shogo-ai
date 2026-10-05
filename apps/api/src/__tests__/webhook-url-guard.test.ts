// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { assertWebhookUrlAllowed, isBlockedAddress } from '../lib/webhook-url-guard'

const saved = { allow: process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS, env: process.env.NODE_ENV }

afterEach(() => {
  if (saved.allow === undefined) delete process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS
  else process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS = saved.allow
  process.env.NODE_ENV = saved.env
})

describe('webhook URL guard', () => {
  test('blocks internal address ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })

  test('rejects http, localhost, private IPs and credentials', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://10.0.0.5/hook',
      'https://[::1]/hook',
      'https://user:pass@example.com/hook',
      'https://metadata.internal/x',
      'not a url',
    ]) {
      await expect(assertWebhookUrlAllowed(url)).rejects.toThrow()
    }
  })

  test('accepts public https URLs', async () => {
    await expect(assertWebhookUrlAllowed('https://8.8.8.8/hook')).resolves.toBeInstanceOf(URL)
    await expect(assertWebhookUrlAllowed('https://hooks.example.com/shogo')).resolves.toBeInstanceOf(URL)
  })

  test('the test allowlist works outside production only', async () => {
    process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS = '127.0.0.1:4555'
    process.env.NODE_ENV = 'test'
    await expect(assertWebhookUrlAllowed('http://127.0.0.1:4555/hook', { resolve: true })).resolves.toBeInstanceOf(URL)
    process.env.NODE_ENV = 'production'
    await expect(assertWebhookUrlAllowed('http://127.0.0.1:4555/hook')).rejects.toThrow()
  })
})
