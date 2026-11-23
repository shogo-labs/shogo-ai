// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_STAGING_CONTROL_PLANES, DEFAULT_STAGING_HOSTS, assertStagingHost, type FleetHost } from '../staging-guard'

const base = {
  hostId: 'latitude-dal-1',
  controlPlaneUrl: 'https://api-staging.shogo.ai',
  allowHosts: DEFAULT_STAGING_HOSTS,
  allowControlPlaneHosts: DEFAULT_STAGING_CONTROL_PLANES,
  token: 'tok',
}

const fleet = (hosts: FleetHost[]) => async () => ({ ok: true, hosts })

describe('assertStagingHost', () => {
  test('accepts a staging host registered to a staging control plane', async () => {
    const r = await assertStagingHost({ ...base, fetchFleet: fleet([{ hostId: 'latitude-dal-1', live: true }]) })
    expect(r.ok).toBe(true)
    expect(r.registeredHostId).toBe('latitude-dal-1')
  })

  test('refuses a host that is not in the staging allow-list', async () => {
    const r = await assertStagingHost({ ...base, hostId: 'latitude-dal-2', fetchFleet: fleet([{ hostId: 'latitude-dal-2' }]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('not in the staging allow-list')
  })

  test('refuses a production control plane without contacting it', async () => {
    let called = false
    const r = await assertStagingHost({
      ...base,
      controlPlaneUrl: 'https://api.shogo.ai',
      fetchFleet: async () => {
        called = true
        return { ok: true, hosts: [{ hostId: 'latitude-dal-1' }] }
      },
    })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('PRODUCTION')
    expect(called).toBe(false)
  })

  test('refuses a control plane that is not on the staging allow-list', async () => {
    const r = await assertStagingHost({ ...base, controlPlaneUrl: 'https://api.example.com', fetchFleet: fleet([{ hostId: 'latitude-dal-1' }]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('not in the staging allow-list')
  })

  test('refuses when the host is not registered to that control plane', async () => {
    const r = await assertStagingHost({ ...base, fetchFleet: fleet([{ hostId: 'some-other-host' }]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('is not registered to api-staging.shogo.ai')
  })

  test('refuses when the host is registered but not live', async () => {
    const r = await assertStagingHost({ ...base, fetchFleet: fleet([{ hostId: 'latitude-dal-1', live: false }]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('not live')
  })

  test('refuses when the fleet endpoint cannot be read', async () => {
    const r = await assertStagingHost({ ...base, fetchFleet: async () => ({ ok: false, error: 'HTTP 401' }) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('could not confirm')
  })

  test('refuses an empty host id', async () => {
    const r = await assertStagingHost({ ...base, hostId: '', fetchFleet: fleet([]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('no host id')
  })

  test('refuses a control plane that is not a URL', async () => {
    const r = await assertStagingHost({ ...base, controlPlaneUrl: 'not-a-url', fetchFleet: fleet([]) })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('is not a URL')
  })

  test('accepts a wildcard staging control plane', async () => {
    const r = await assertStagingHost({
      ...base,
      controlPlaneUrl: 'https://api.shogo-staging-system.staging.shogo.ai',
      fetchFleet: fleet([{ hostId: 'latitude-dal-1' }]),
    })
    expect(r.ok).toBe(true)
  })

  test('queries the fleet endpoint with the host token', async () => {
    let seen: { url: string; token: string } | null = null
    await assertStagingHost({
      ...base,
      fetchFleet: async (url, token) => {
        seen = { url, token }
        return { ok: true, hosts: [{ hostId: 'latitude-dal-1' }] }
      },
    })
    expect(seen!.url).toBe('https://api-staging.shogo.ai/api/internal/metal/fleet')
    expect(seen!.token).toBe('tok')
  })
})
