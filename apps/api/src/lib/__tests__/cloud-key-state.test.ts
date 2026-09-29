// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('../cloud-urls', () => ({
  getShogoCloudUrl: () => 'https://cloud.test',
}))

const {
  checkCloudKey,
  isCloudKeyRejected,
  markCloudKeyRejectedIfConfirmed,
  recordHeartbeat,
  getHeartbeatStatus,
  claimCredentialMismatchLog,
  resetCloudKeyState,
} = await import('../cloud-key-state')

const origFetch = globalThis.fetch
const origWarn = console.warn
const ORIG_KEY = process.env.SHOGO_API_KEY
let validateCalls: Array<{ url: string; body: any }> = []
let validateImpl: () => Promise<Response> = async () => Response.json({ valid: false })

beforeEach(() => {
  resetCloudKeyState()
  validateCalls = []
  validateImpl = async () => Response.json({ valid: false })
  globalThis.fetch = (async (url: any, init?: any) => {
    validateCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') })
    return validateImpl()
  }) as typeof fetch
  console.warn = () => {}
  process.env.SHOGO_API_KEY = 'shogo_sk_abc'
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.warn = origWarn
  if (ORIG_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIG_KEY
})

describe('checkCloudKey', () => {
  it('maps the validate response to valid / rejected / unknown', async () => {
    validateImpl = async () => Response.json({ valid: true })
    expect(await checkCloudKey('shogo_sk_abc')).toBe('valid')
    validateImpl = async () => Response.json({ valid: false, error: 'Key has been revoked' })
    expect(await checkCloudKey('shogo_sk_abc')).toBe('rejected')
    validateImpl = async () => Response.json({ error: { code: 'rate_limited' } }, { status: 429 })
    expect(await checkCloudKey('shogo_sk_abc')).toBe('unknown')
    validateImpl = async () => new Response('<html>bad gateway</html>', { status: 502 })
    expect(await checkCloudKey('shogo_sk_abc')).toBe('unknown')
    validateImpl = async () => { throw new Error('offline') }
    expect(await checkCloudKey('shogo_sk_abc')).toBe('unknown')

    expect(validateCalls[0]).toEqual({
      url: 'https://cloud.test/api/api-keys/validate',
      body: { key: 'shogo_sk_abc' },
    })
  })

  it('shares one request between concurrent checks of the same key', async () => {
    const results = await Promise.all([
      checkCloudKey('shogo_sk_abc'),
      checkCloudKey('shogo_sk_abc'),
      checkCloudKey('shogo_sk_other'),
    ])
    expect(results).toEqual(['rejected', 'rejected', 'rejected'])
    expect(validateCalls.map((c) => c.body.key)).toEqual(['shogo_sk_abc', 'shogo_sk_other'])
  })
})

describe('markCloudKeyRejectedIfConfirmed', () => {
  it('sets the flag when cloud confirms the key is rejected', async () => {
    expect(await markCloudKeyRejectedIfConfirmed('upstream 401')).toBe(true)
    expect(isCloudKeyRejected()).toBe(true)
  })

  it('leaves the flag clear when cloud reports the key valid or cannot be reached', async () => {
    validateImpl = async () => Response.json({ valid: true })
    expect(await markCloudKeyRejectedIfConfirmed('upstream 401')).toBe(false)
    validateImpl = async () => { throw new Error('offline') }
    expect(await markCloudKeyRejectedIfConfirmed('upstream 401')).toBe(false)
    expect(isCloudKeyRejected()).toBe(false)
  })

  it('checks the key it was given, falling back to the env key', async () => {
    await markCloudKeyRejectedIfConfirmed('upstream 401', 'shogo_sk_stored')
    delete process.env.SHOGO_API_KEY
    await markCloudKeyRejectedIfConfirmed('upstream 401', 'shogo_sk_stored')
    process.env.SHOGO_API_KEY = 'shogo_sk_abc'
    await markCloudKeyRejectedIfConfirmed('upstream 401')
    expect(validateCalls.map((c) => c.body.key)).toEqual(['shogo_sk_stored', 'shogo_sk_stored', 'shogo_sk_abc'])
  })

  it('ignores a rejection for a key the user replaced during the check', async () => {
    validateImpl = async () => {
      process.env.SHOGO_API_KEY = 'shogo_sk_fresh'
      return Response.json({ valid: false })
    }
    expect(await markCloudKeyRejectedIfConfirmed('upstream 401', 'shogo_sk_abc')).toBe(false)
    expect(isCloudKeyRejected()).toBe(false)
  })

  it('is a no-op without a key', async () => {
    delete process.env.SHOGO_API_KEY
    expect(await markCloudKeyRejectedIfConfirmed('upstream 401')).toBe(false)
    expect(validateCalls).toHaveLength(0)
  })
})

describe('heartbeat state', () => {
  it('a successful heartbeat clears a rejected flag', async () => {
    await markCloudKeyRejectedIfConfirmed('upstream 401')
    recordHeartbeat(true)
    expect(isCloudKeyRejected()).toBe(false)
    expect(getHeartbeatStatus()).toMatchObject({ lastHeartbeatOk: true, lastHeartbeatError: null })
  })

  it('resetCloudKeyState forgets the flag, heartbeat, and mismatch log', async () => {
    await markCloudKeyRejectedIfConfirmed('upstream 401')
    recordHeartbeat(false, 'HTTP 401')
    expect(claimCredentialMismatchLog()).toBe(true)
    expect(claimCredentialMismatchLog()).toBe(false)

    resetCloudKeyState()
    expect(isCloudKeyRejected()).toBe(false)
    expect(getHeartbeatStatus()).toEqual({ lastHeartbeatOk: null, lastHeartbeatAt: null, lastHeartbeatError: null })
    expect(claimCredentialMismatchLog()).toBe(true)
  })
})
