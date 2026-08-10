// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The host-side hydrate proxy.
 *
 * Two things have to hold for this to be safe to put in front of every cold
 * boot. It must degrade to the presigned URL rather than fail whenever it
 * cannot help — a hydrate that errors is a project that will not open. And its
 * slot accounting must be exact in every exit path, because the transfers this
 * exists to fix are precisely the ones that get cancelled or die partway; leak a
 * slot per failure and the proxy quietly retires itself back to the slow path.
 */

import { describe, expect, test } from 'bun:test'

import { HYDRATE_STREAM_PREFIX, HydrateProxy } from './hydrate-proxy'

const OPTS = { partBytes: 100, concurrency: 4, maxConcurrent: 2, ttlSec: 60, port: 9900 }

const object = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 251)

function proxyOf(over: Partial<typeof OPTS> = {}, now = () => 1_000_000, log?: (m: string) => void) {
  return new HydrateProxy({ ...OPTS, ...over }, now, log ?? (() => {}))
}

function grantFor(p: HydrateProxy, size: number, over: Record<string, unknown> = {}) {
  const obj = object(size)
  const url = p.mint({
    hostIp: '172.16.0.1',
    guestIp: '172.16.0.2',
    size,
    label: 'p source',
    range: async (s, e) => obj.slice(s, e),
    ...over,
  })
  return { url, obj }
}

const pathOf = (url: string) => new URL(url).pathname

describe('HydrateProxy.mint', () => {
  test('mints a URL on the guest-facing host IP and agent port', () => {
    const { url } = grantFor(proxyOf(), 1000)
    expect(url).toMatch(/^http:\/\/172\.16\.0\.1:9900\/hydrate-stream\/[0-9a-f]{64}$/)
  })

  test('falls back when the store cannot do ranged reads', () => {
    const p = proxyOf()
    expect(p.mint({ hostIp: '172.16.0.1', guestIp: '172.16.0.2', size: 1000, label: 'x' })).toBeNull()
    expect(p.inFlight).toBe(0)
  })

  test('falls back for an archive that fits in one part', () => {
    // One part is one connection — the shape this exists to avoid — and at that
    // size the transfer is not what makes a cold boot slow.
    expect(grantFor(proxyOf(), 100).url).toBeNull()
    expect(grantFor(proxyOf(), 101).url).not.toBeNull()
  })

  test('falls back rather than queues once the host is carrying its limit', async () => {
    // Queueing would make a cold boot wait behind other cold boots to start a
    // transfer it could have begun immediately on the slow path.
    const p = proxyOf({ maxConcurrent: 2 })
    const a = grantFor(p, 1000)
    const b = grantFor(p, 1000)
    expect(a.url).not.toBeNull()
    expect(b.url).not.toBeNull()
    expect(grantFor(p, 1000).url).toBeNull()
    expect(p.inFlight).toBe(2)

    // Finish one and the slot comes back.
    await p.serve(pathOf(a.url!), '172.16.0.2').arrayBuffer()
    expect(p.inFlight).toBe(1)
    expect(grantFor(p, 1000).url).not.toBeNull()
  })

  test('unredeemed grants expire and give their slots back', () => {
    let t = 1_000_000
    const p = proxyOf({ maxConcurrent: 1 }, () => t)
    expect(grantFor(p, 1000).url).not.toBeNull()
    expect(grantFor(p, 1000).url).toBeNull() // full

    t += 61_000 // past the TTL; the assign that minted it never got there
    expect(grantFor(p, 1000).url).not.toBeNull()
    expect(p.inFlight).toBe(1)
  })
})

describe('HydrateProxy.serve', () => {
  test('serves the whole object, in order, with a declared length', async () => {
    const p = proxyOf()
    const { url, obj } = grantFor(p, 1000)
    const res = p.serve(pathOf(url!), '172.16.0.2')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('1000')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(obj)
  })

  test('a token is good once', async () => {
    const p = proxyOf()
    const { url } = grantFor(p, 1000)
    const path = pathOf(url!)
    expect(p.serve(path, '172.16.0.2').status).toBe(200)
    expect(p.serve(path, '172.16.0.2').status).toBe(404)
  })

  test('a token is worthless to any guest but the one it was minted for', async () => {
    const p = proxyOf()
    const { url } = grantFor(p, 1000)
    expect(p.serve(pathOf(url!), '172.16.4.2').status).toBe(404)
    // ...and it is still redeemable by the right one, so a stray probe cannot
    // burn someone else's hydrate.
    expect(p.serve(pathOf(url!), '172.16.0.2').status).toBe(200)
  })

  test('an expired token is refused', () => {
    let t = 1_000_000
    const p = proxyOf({}, () => t)
    const { url } = grantFor(p, 1000)
    t += 61_000
    expect(p.serve(pathOf(url!), '172.16.0.2').status).toBe(404)
  })

  test('an unknown token is refused', () => {
    expect(proxyOf().serve(`${HYDRATE_STREAM_PREFIX}${'0'.repeat(64)}`, '172.16.0.2').status).toBe(404)
  })

  test('reports the throughput of each transfer', async () => {
    // Cold-boot hydrate had no per-transfer rate recorded anywhere, so the only
    // way to answer "why is this slow" was to pair log timestamps against
    // object sizes afterwards. This is the number that was missing.
    const lines: string[] = []
    let t = 1_000_000
    const p = proxyOf({}, () => t, m => lines.push(m))
    const { url } = grantFor(p, 2_000_000)
    const res = p.serve(pathOf(url!), '172.16.0.2')
    t += 4000
    await res.arrayBuffer()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('served p source to 172.16.0.2')
    expect(lines[0]).toContain('2000000 bytes in 4.0s (0.5 MB/s)')
  })

  test('says so when a transfer ends short', async () => {
    const lines: string[] = []
    const p = proxyOf({}, () => 1_000_000, m => lines.push(m))
    const url = p.mint({
      hostIp: '172.16.0.1',
      guestIp: '172.16.0.2',
      size: 1000,
      label: 'p source',
      range: async (s, e) => {
        if (s >= 400) throw new Error('nope')
        return object(1000).slice(s, e)
      },
    })
    await expect(p.serve(pathOf(url!), '172.16.0.2').arrayBuffer()).rejects.toThrow()
    expect(lines[0]).toContain('TRUNCATED (400/1000)')
  })

  test('releases its slot when the guest hangs up mid-transfer', async () => {
    const p = proxyOf({ maxConcurrent: 1 })
    const { url } = grantFor(p, 100_000)
    const res = p.serve(pathOf(url!), '172.16.0.2')
    expect(p.inFlight).toBe(1)

    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel() // guest died / curl timed out

    expect(p.inFlight).toBe(0)
    expect(grantFor(p, 1000).url).not.toBeNull()
  })

  test('releases its slot when the object store fails mid-transfer', async () => {
    const p = proxyOf({ maxConcurrent: 1 })
    const url = p.mint({
      hostIp: '172.16.0.1',
      guestIp: '172.16.0.2',
      size: 1000,
      label: 'p source',
      range: async (s, e) => {
        if (s >= 400) throw new Error('object store said no')
        return object(1000).slice(s, e)
      },
    })
    const res = p.serve(pathOf(url!), '172.16.0.2')
    await expect(res.arrayBuffer()).rejects.toThrow()
    expect(p.inFlight).toBe(0)
  })

  test('a mid-transfer failure truncates the body rather than completing it', async () => {
    // The declared Content-Length is what makes this safe: the guest's curl
    // sees fewer bytes than promised and fails, instead of tar succeeding on a
    // partial tree and the project coming up half-restored.
    const p = proxyOf()
    const url = p.mint({
      hostIp: '172.16.0.1',
      guestIp: '172.16.0.2',
      size: 1000,
      label: 'p source',
      range: async (s, e) => {
        if (s >= 400) throw new Error('object store said no')
        return object(1000).slice(s, e)
      },
    })
    const res = p.serve(pathOf(url!), '172.16.0.2')
    expect(res.headers.get('Content-Length')).toBe('1000')

    const reader = res.body!.getReader()
    let got = 0
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          got += value!.length
        }
      })(),
    ).rejects.toThrow('object store said no')
    expect(got).toBeLessThan(1000)
  })
})
