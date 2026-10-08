// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The placement registry's compare-and-set semantics, run through the SAME
 * cases against both backends:
 *
 *   - the in-process fallback (always runs), and
 *   - the real Redis Lua scripts production uses (`SET_PLACEMENT_UNLESS_OTHER_HOST_LUA`,
 *     `CLEAR_PLACEMENT_IF_HOST_LUA`, the lease scripts).
 *
 * Why this exists: `metal-placement-registry.test.ts` forces the in-memory
 * fallback, so the Lua that actually guards "one runtime per project" (#1236,
 * #1238) was never executed by any test. Every registry method also swallows
 * Redis errors and falls back to in-process state — a broken Lua script would
 * therefore pass a naive test. The Redis variant reads state back through a
 * raw client to prove the write really landed in Redis.
 *
 * Opt-in locally; required in CI (the workflow sets `CI_REQUIRE_REDIS=1` and a
 * Redis service):
 *
 *   TEST_REDIS_URL=redis://localhost:6379 bun test metal-placement-registry.redis
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import Redis from 'ioredis'
import { MetalPlacementRegistry } from '../metal-placement-registry'

const url = process.env.TEST_REDIS_URL

if (!url && process.env.CI_REQUIRE_REDIS === '1') {
  throw new Error(
    'CI_REQUIRE_REDIS=1 but TEST_REDIS_URL is not set: the placement registry Lua scripts would go untested. ' +
      'Add a redis service to the test job.',
  )
}

const uid = () => `t-${crypto.randomUUID()}`

interface Backend {
  name: string
  mk: () => MetalPlacementRegistry
  /** Read a placement's hostId straight from the backing store, bypassing the registry's fallback. */
  rawPlacementHost: (projectId: string) => Promise<string | null>
  rawLeaseHolder: (projectId: string) => Promise<string | null>
}

function defineCases(b: () => Backend) {
  it('setPlacementUnlessOtherHost: unplaced key is claimed; same host refreshes; other host is refused', async () => {
    const r = b().mk()
    const p = uid()
    expect(await r.setPlacementUnlessOtherHost(p, 'host-1', 'local')).toBe(true)
    expect(await b().rawPlacementHost(p)).toBe('host-1')

    expect(await r.setPlacementUnlessOtherHost(p, 'host-2', 'local')).toBe(false)
    expect(await b().rawPlacementHost(p)).toBe('host-1')
    expect((await r.getPlacement(p))?.hostId).toBe('host-1')

    expect(await r.setPlacementUnlessOtherHost(p, 'host-1', 's3')).toBe(true)
    expect((await r.getPlacement(p))?.tier).toBe('s3')
  })

  it('setPlacementUnlessOtherHost: a cleared key can be claimed by any host', async () => {
    const r = b().mk()
    const p = uid()
    await r.setPlacement(p, 'host-1', 'local')
    await r.clearPlacement(p)
    expect(await r.setPlacementUnlessOtherHost(p, 'host-2', 'local')).toBe(true)
    expect(await b().rawPlacementHost(p)).toBe('host-2')
  })

  it('clearPlacement(onlyIfHostId): only the host the placement names can clear it', async () => {
    const r = b().mk()
    const p = uid()
    await r.setPlacement(p, 'host-1', 'local')

    await r.clearPlacement(p, 'host-2') // a sibling's evict/cold report: must be a no-op
    expect(await b().rawPlacementHost(p)).toBe('host-1')

    await r.clearPlacement(p, 'host-1')
    expect(await b().rawPlacementHost(p)).toBeNull()

    await r.clearPlacement(p, 'host-1') // already gone: still a no-op, no throw
    expect(await r.getPlacement(p)).toBeNull()
  })

  it('clearPlacement without a host clears unconditionally', async () => {
    const r = b().mk()
    const p = uid()
    await r.setPlacement(p, 'host-1', 'local')
    await r.clearPlacement(p)
    expect(await b().rawPlacementHost(p)).toBeNull()
  })

  it('concurrent suspend reports from N hosts: exactly one wins and the placement names it', async () => {
    const r = b().mk()
    const p = uid()
    const hosts = Array.from({ length: 12 }, (_, i) => `host-${i}`)
    const results = await Promise.all(hosts.map((h) => r.setPlacementUnlessOtherHost(p, h, 'local')))
    const winners = hosts.filter((_, i) => results[i])
    expect(winners).toHaveLength(1)
    expect(await b().rawPlacementHost(p)).toBe(winners[0])
  })

  it('concurrent clears and re-claims never leave a placement naming a host that lost', async () => {
    const r = b().mk()
    for (let round = 0; round < 20; round++) {
      const p = uid()
      await r.setPlacement(p, 'host-a', 'local')
      await Promise.all([
        r.clearPlacement(p, 'host-a'),
        r.setPlacementUnlessOtherHost(p, 'host-b', 'local'),
        r.clearPlacement(p, 'host-c'),
      ])
      const host = await b().rawPlacementHost(p)
      // host-a cleared it (then host-b may have claimed) or host-b ran first and was refused
      // because host-a still held it (then host-a's clear removed it). Never host-c.
      expect([null, 'host-a', 'host-b']).toContain(host)
    }
  })

  it('lease is exclusive under contention: exactly one of N holders acquires', async () => {
    const r = b().mk()
    const p = uid()
    const holders = Array.from({ length: 10 }, (_, i) => `h${i}`)
    const results = await Promise.all(holders.map((h) => r.acquireLease(p, h, 30_000)))
    const winners = holders.filter((_, i) => results[i])
    expect(winners).toHaveLength(1)
    expect(await b().rawLeaseHolder(p)).toBe(winners[0])

    // Only the holder can renew or release.
    expect(await r.renewLease(p, 'intruder')).toBe(false)
    await r.releaseLease(p, 'intruder')
    expect(await b().rawLeaseHolder(p)).toBe(winners[0])
    await r.releaseLease(p, winners[0])
    expect(await b().rawLeaseHolder(p)).toBeNull()
  })
}

describe('MetalPlacementRegistry CAS semantics (in-memory fallback)', () => {
  const mem = new MetalPlacementRegistry(() => null)
  const backend: Backend = {
    name: 'memory',
    mk: () => mem,
    rawPlacementHost: async (p) => (await mem.getPlacement(p))?.hostId ?? null,
    rawLeaseHolder: (p) => mem.leaseHolder(p),
  }
  defineCases(() => backend)
})

describe.skipIf(!url)('MetalPlacementRegistry CAS semantics (real Redis, Lua scripts)', () => {
  let client: Redis
  let backend: Backend

  beforeAll(async () => {
    client = new Redis(url!, { maxRetriesPerRequest: 2 })
    await client.ping()
    backend = {
      name: 'redis',
      mk: () => new MetalPlacementRegistry(() => client),
      rawPlacementHost: async (p) => {
        const v = await client.get(`metal:place:${p}`)
        return v ? (JSON.parse(v).hostId as string) : null
      },
      rawLeaseHolder: (p) => client.get(`metal:lease:${p}`),
    }
  })

  afterAll(() => {
    client?.disconnect()
  })

  defineCases(() => backend)

  it('the Lua scripts are loadable (a script error would silently fall back to in-process state)', async () => {
    const r = backend.mk()
    const p = uid()
    // Drive the scripts, then prove state is in Redis and NOT only in the registry's memory fallback.
    expect(await r.setPlacementUnlessOtherHost(p, 'host-1', 'local')).toBe(true)
    expect(await client.exists(`metal:place:${p}`)).toBe(1)
    expect(await client.ttl(`metal:place:${p}`)).toBeGreaterThan(0)
    await r.clearPlacement(p, 'host-1')
    expect(await client.exists(`metal:place:${p}`)).toBe(0)
  })

  it('a corrupt placement value does not wedge the key (the script overwrites it)', async () => {
    const p = uid()
    await client.set(`metal:place:${p}`, 'not-json')
    expect(await backend.mk().setPlacementUnlessOtherHost(p, 'host-1', 'local')).toBe(true)
    expect(await backend.rawPlacementHost(p)).toBe('host-1')
  })

  it('placements are visible across registry instances (replicas share one view)', async () => {
    const replicaA = backend.mk()
    const replicaB = backend.mk()
    const p = uid()
    expect(await replicaA.setPlacementUnlessOtherHost(p, 'host-1', 'local')).toBe(true)
    expect(await replicaB.setPlacementUnlessOtherHost(p, 'host-2', 'local')).toBe(false)
    expect((await replicaB.getPlacement(p))?.hostId).toBe('host-1')
  })
})
