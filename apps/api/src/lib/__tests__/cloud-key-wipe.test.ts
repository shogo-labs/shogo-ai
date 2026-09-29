// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let deleteManyImpl: (args: any) => Promise<any> = async () => ({ count: 0 })
let stopTunnelImpl: () => void = () => {}
const deleteManyCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    localConfig: {
      deleteMany: async (args: any) => {
        deleteManyCalls.push(args)
        return deleteManyImpl(args)
      },
    },
  },
}))

mock.module('../../lib/instance-tunnel', () => ({
  stopInstanceTunnel: () => stopTunnelImpl(),
}))

const { wipeCloudKey, wipeCloudKeyIfRejected, _testing } = await import('../cloud-key-wipe')

const ORIG_KEY = process.env.SHOGO_API_KEY

beforeEach(() => {
  _testing.reset()
  deleteManyCalls.length = 0
  deleteManyImpl = async () => ({ count: 1 })
  stopTunnelImpl = () => {}
  process.env.SHOGO_API_KEY = 'shogo_sk_abc'
})
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIG_KEY
})

describe('wipeCloudKey', () => {
  it('returns wiped:false when SHOGO_API_KEY is not set', async () => {
    delete process.env.SHOGO_API_KEY
    const r = await wipeCloudKey('not-set')
    expect(r).toEqual({ wiped: false })
    expect(deleteManyCalls).toHaveLength(0)
  })

  it('wipes the key, deletes both localConfig rows, stops the tunnel', async () => {
    let stopped = 0
    stopTunnelImpl = () => {
      stopped++
    }
    const r = await wipeCloudKey('401 from cloud')
    expect(r).toEqual({ wiped: true })
    expect(deleteManyCalls).toHaveLength(2)
    const keys = deleteManyCalls.map((c) => c.where.key).sort()
    expect(keys).toEqual(['SHOGO_API_KEY', 'SHOGO_KEY_INFO'])
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    expect(stopped).toBe(1)
  })

  it('coalesces concurrent callers (second resolves wiped:false)', async () => {
    const resolvers: Array<() => void> = []
    deleteManyImpl = () => new Promise((r) => resolvers.push(() => r({ count: 1 })))
    const p1 = wipeCloudKey('a')
    const p2 = wipeCloudKey('b')
    setTimeout(() => {
      for (const f of resolvers) f()
    }, 5)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.wiped).toBe(true)
    expect(r2.wiped).toBe(false)
  })

  it('dedupes follow-up calls within the dedup window', async () => {
    await wipeCloudKey('first')
    process.env.SHOGO_API_KEY = 'shogo_sk_new'
    const second = await wipeCloudKey('second within window')
    expect(second).toEqual({ wiped: false })
  })

  it('allows another wipe after the dedup window passes', async () => {
    await wipeCloudKey('first')
    _testing.reset()
    process.env.SHOGO_API_KEY = 'shogo_sk_again'
    const second = await wipeCloudKey('after reset')
    expect(second).toEqual({ wiped: true })
  })

  it('survives prisma delete errors and still wipes the env + stops tunnel', async () => {
    deleteManyImpl = async () => {
      throw new Error('db down')
    }
    let stopped = 0
    stopTunnelImpl = () => {
      stopped++
    }
    const r = await wipeCloudKey('db error')
    expect(r.wiped).toBe(true)
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    expect(stopped).toBe(1)
  })

  it('logs but does not throw when stopInstanceTunnel errors', async () => {
    stopTunnelImpl = () => {
      throw new Error('tunnel broken')
    }
    const origError = console.error
    let captured = ''
    console.error = (...args: any[]) => {
      captured = args.join(' ')
    }
    try {
      const r = await wipeCloudKey('tunnel error')
      expect(r.wiped).toBe(true)
      expect(captured).toContain('Failed to stop instance tunnel')
    } finally {
      console.error = origError
    }
  })
})

describe('wipeCloudKeyIfRejected', () => {
  const origFetch = globalThis.fetch
  const origWarn = console.warn
  let validateCalls: Array<{ url: string; body: any }> = []
  let validateImpl: () => Promise<Response> = async () => Response.json({ valid: false })

  beforeEach(() => {
    validateCalls = []
    globalThis.fetch = (async (url: any, init?: any) => {
      validateCalls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') })
      return validateImpl()
    }) as typeof fetch
    console.warn = () => {}
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    console.warn = origWarn
  })

  it('keeps the key when cloud still reports it valid (upstream-provider 401)', async () => {
    validateImpl = async () => Response.json({ valid: true })
    const r = await wipeCloudKeyIfRejected('responses 401')
    expect(r).toEqual({ wiped: false })
    expect(process.env.SHOGO_API_KEY).toBe('shogo_sk_abc')
    expect(deleteManyCalls).toHaveLength(0)
    expect(validateCalls).toHaveLength(1)
    expect(validateCalls[0].url).toEndWith('/api/api-keys/validate')
    expect(validateCalls[0].body).toEqual({ key: 'shogo_sk_abc' })
  })

  it('wipes when cloud confirms the key is rejected', async () => {
    validateImpl = async () => Response.json({ valid: false, error: 'Key has been revoked' })
    const r = await wipeCloudKeyIfRejected('chat 401')
    expect(r).toEqual({ wiped: true })
    expect(process.env.SHOGO_API_KEY).toBeUndefined()
    expect(deleteManyCalls).toHaveLength(2)
  })

  it('keeps the key when the validate call fails or returns non-JSON', async () => {
    validateImpl = async () => { throw new Error('offline') }
    expect(await wipeCloudKeyIfRejected('offline')).toEqual({ wiped: false })
    validateImpl = async () => new Response('<html>bad gateway</html>', { status: 502 })
    expect(await wipeCloudKeyIfRejected('502')).toEqual({ wiped: false })
    expect(process.env.SHOGO_API_KEY).toBe('shogo_sk_abc')
    expect(deleteManyCalls).toHaveLength(0)
  })

  it('does not wipe a key the user swapped in while verification was pending', async () => {
    validateImpl = async () => {
      process.env.SHOGO_API_KEY = 'shogo_sk_fresh'
      return Response.json({ valid: false })
    }
    const r = await wipeCloudKeyIfRejected('race')
    expect(r).toEqual({ wiped: false })
    expect(process.env.SHOGO_API_KEY).toBe('shogo_sk_fresh')
    expect(deleteManyCalls).toHaveLength(0)
  })

  it('coalesces concurrent 401s into one validate call', async () => {
    validateImpl = async () => Response.json({ valid: true })
    const results = await Promise.all([
      wipeCloudKeyIfRejected('a'),
      wipeCloudKeyIfRejected('b'),
      wipeCloudKeyIfRejected('c'),
    ])
    expect(results.every((r) => !r.wiped)).toBe(true)
    expect(validateCalls).toHaveLength(1)
  })

  it('is a no-op without a key', async () => {
    delete process.env.SHOGO_API_KEY
    expect(await wipeCloudKeyIfRejected('none')).toEqual({ wiped: false })
    expect(validateCalls).toHaveLength(0)
  })
})
