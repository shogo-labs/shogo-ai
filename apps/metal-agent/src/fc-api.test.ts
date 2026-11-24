// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the pre-snapshot balloon reclaim sizing (computeReclaimMiB).
 *
 * The live inflate/deflate + FC socket wiring is exercised e2e on the bare-metal
 * host; here we pin the pure sizing math that decides how much RAM to reclaim.
 */

import { describe, expect, test } from 'bun:test'
import { computeReclaimMiB, FcApi } from './fc-api'

describe('computeReclaimMiB', () => {
  test('reclaims available memory while leaving the floor as headroom', () => {
    // 4 GiB guest, 3.6 GiB available, keep 256 MiB → reclaim min(3840, 3344).
    expect(
      computeReclaimMiB({ configuredMiB: 4096, availableMiB: 3600, floorMiB: 256 }),
    ).toBe(3344)
  })

  test('caps at configured - floor when available exceeds it', () => {
    // Guest reports more available than physically reclaimable → clamp to ceiling.
    expect(
      computeReclaimMiB({ configuredMiB: 4096, availableMiB: 4096, floorMiB: 256 }),
    ).toBe(3840)
  })

  test('returns 0 when available is at or below the floor (nothing to reclaim)', () => {
    expect(computeReclaimMiB({ configuredMiB: 4096, availableMiB: 256, floorMiB: 256 })).toBe(0)
    expect(computeReclaimMiB({ configuredMiB: 4096, availableMiB: 100, floorMiB: 256 })).toBe(0)
  })

  test('never returns negative for a busy guest with little free RAM', () => {
    expect(
      computeReclaimMiB({ configuredMiB: 1024, availableMiB: 50, floorMiB: 256 }),
    ).toBe(0)
  })

  test('a zero floor reclaims all available (bounded by configured)', () => {
    expect(computeReclaimMiB({ configuredMiB: 4096, availableMiB: 3000, floorMiB: 0 })).toBe(3000)
    expect(computeReclaimMiB({ configuredMiB: 4096, availableMiB: 9000, floorMiB: 0 })).toBe(4096)
  })

  test('a floor larger than configured yields no reclaim', () => {
    expect(
      computeReclaimMiB({ configuredMiB: 512, availableMiB: 400, floorMiB: 1024 }),
    ).toBe(0)
  })

  test('matches the staging experiment shape (leave ~512 of 4096)', () => {
    // The manual experiment inflated to reclaim 3584 (floor 512); with a fully
    // reclaimable guest the stats-guided target lands on the same number.
    expect(
      computeReclaimMiB({ configuredMiB: 4096, availableMiB: 4096, floorMiB: 512 }),
    ).toBe(3584)
  })
})

describe('FcApi.machineConfig balloon config', () => {
  /** Capture every (method, path, body) the client sends, and answer 204. */
  async function capture(run: (api: FcApi) => Promise<unknown>) {
    const realFetch = globalThis.fetch
    const calls: Array<{ method?: string; path: string; body?: any }> = []
    globalThis.fetch = (async (url: any, init: any = {}) => {
      calls.push({
        method: init.method,
        path: String(url).replace(/^http:\/\/localhost/, ''),
        body: init.body ? JSON.parse(init.body) : undefined,
      })
      return new Response(null, { status: 204 })
    }) as any
    try {
      await run(new FcApi('/tmp/fake.sock'))
    } finally {
      globalThis.fetch = realFetch
    }
    return calls
  }

  test('omits free_page_reporting unless asked (byte-identical body when off)', async () => {
    const calls = await capture((api) => api.machineConfig(2, 4096, true, 1))
    const balloon = calls.find((c) => c.path === '/balloon')
    expect(balloon!.body).toEqual({
      amount_mib: 0,
      deflate_on_oom: true,
      stats_polling_interval_s: 1,
    })
  })

  test('sends free_page_reporting: true when enabled', async () => {
    const calls = await capture((api) => api.machineConfig(2, 4096, true, 1, true))
    const balloon = calls.find((c) => c.path === '/balloon')
    // FC 1.16.1's Balloon definition, pre-boot only (BalloonUpdate has no field).
    expect(balloon!.body).toEqual({
      amount_mib: 0,
      deflate_on_oom: true,
      stats_polling_interval_s: 1,
      free_page_reporting: true,
    })
  })
})

describe('FcApi.patchDrive', () => {
  test('sends drive_id in the PATCH body (SHO-401)', async () => {
    const realFetch = globalThis.fetch
    let captured: { method?: string; path?: string; body?: any } = {}
    globalThis.fetch = (async (url: any, init: any = {}) => {
      captured = {
        method: init.method,
        path: String(url).replace(/^http:\/\/localhost/, ''),
        body: init.body ? JSON.parse(init.body) : undefined,
      }
      return new Response(null, { status: 204 })
    }) as any
    try {
      await new FcApi('/tmp/fake.sock').patchDrive('workspace', '/var/lib/shogo/vm1.ws.ext4')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(captured.method).toBe('PATCH')
    expect(captured.path).toBe('/drives/workspace')
    // Firecracker 400s with "missing field drive_id" without this.
    expect(captured.body).toEqual({ drive_id: 'workspace', path_on_host: '/var/lib/shogo/vm1.ws.ext4' })
  })
})
