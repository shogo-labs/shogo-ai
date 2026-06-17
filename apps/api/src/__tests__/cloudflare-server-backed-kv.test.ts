// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the SERVER_BACKED Workers KV helper used by the publish flow to
// flag / unflag server-backed subdomains. The *.shogo.one worker reads this
// flag to decide whether to proxy /api/* to the Knative ingress, so the exact
// CF KV REST shape (and the "best-effort no-op when unconfigured" contract)
// matters.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getServerBackedKvConfig,
  setServerBackedFlag,
  clearServerBackedFlag,
} from '../lib/cloudflare-server-backed-kv'

const ENV_KEYS = [
  'CF_API_TOKEN',
  'CF_CUSTOM_HOSTNAMES_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_SERVER_BACKED_KV_NAMESPACE_ID',
] as const

let saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
let calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = []

function installFetch(status = 200) {
  calls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: (init?.body as string) ?? null,
      auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? null,
    })
    return new Response('{"success":true}', { status })
  }) as typeof fetch
}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  globalThis.fetch = realFetch
})

function configure() {
  process.env.CF_API_TOKEN = 'cf-token-123'
  process.env.CF_ACCOUNT_ID = 'acct-abc'
  process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'ns-xyz'
}

describe('getServerBackedKvConfig', () => {
  test('returns null until token + account + namespace are all set', () => {
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_API_TOKEN = 't'
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_ACCOUNT_ID = 'a'
    expect(getServerBackedKvConfig()).toBeNull()
    process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'n'
    expect(getServerBackedKvConfig()).not.toBeNull()
  })

  test('accepts CF_CUSTOM_HOSTNAMES_TOKEN as the token fallback', () => {
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN = 't'
    process.env.CF_ACCOUNT_ID = 'a'
    process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID = 'n'
    expect(getServerBackedKvConfig()).not.toBeNull()
  })
})

describe('setServerBackedFlag', () => {
  test('is a no-op (returns false) when unconfigured — never fails a publish', async () => {
    installFetch()
    expect(await setServerBackedFlag('my-app')).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('PUTs `1` to the subdomain key with the bearer token', async () => {
    configure()
    installFetch()
    const ok = await setServerBackedFlag('august-29th-celebration-portal')
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-xyz/values/august-29th-celebration-portal',
    )
    expect(calls[0].body).toBe('1')
    expect(calls[0].auth).toBe('Bearer cf-token-123')
  })

  test('returns false (best-effort) when Cloudflare responds non-2xx', async () => {
    configure()
    installFetch(500)
    expect(await setServerBackedFlag('my-app')).toBe(false)
  })
})

describe('clearServerBackedFlag', () => {
  test('DELETEs the subdomain key', async () => {
    configure()
    installFetch()
    const ok = await clearServerBackedFlag('my-app')
    expect(ok).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-abc/storage/kv/namespaces/ns-xyz/values/my-app',
    )
  })

  test('treats a 404 (already gone) as success', async () => {
    configure()
    installFetch(404)
    expect(await clearServerBackedFlag('my-app')).toBe(true)
  })
})
