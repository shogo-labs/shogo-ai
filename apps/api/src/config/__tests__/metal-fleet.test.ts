// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for region scoping of the committed fleet baseline. The critical
 * property: a regional control plane must diff the baseline against ONLY its own
 * region, so another region's (healthy, live-elsewhere) hosts never read as
 * "drift" — the bug that made a healthy EU fleet look "down" on the US CP.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { getHomeFleetEnv, homeFleetRegion } from '../metal-fleet'

const SAVED = { region: process.env.METAL_FLEET_REGION, rid: process.env.REGION_ID }

function setEnv(region: string | undefined, rid: string | undefined): void {
  if (region === undefined) delete process.env.METAL_FLEET_REGION
  else process.env.METAL_FLEET_REGION = region
  if (rid === undefined) delete process.env.REGION_ID
  else process.env.REGION_ID = rid
}

afterEach(() => {
  setEnv(SAVED.region, SAVED.rid)
})

describe('homeFleetRegion', () => {
  it('prefers the explicit METAL_FLEET_REGION override', () => {
    setEnv('eu', 'us-ashburn-1')
    expect(homeFleetRegion()).toBe('eu')
  })

  it('derives the region from the OCI REGION_ID prefix', () => {
    setEnv(undefined, 'us-ashburn-1')
    expect(homeFleetRegion()).toBe('us')
    setEnv(undefined, 'eu-frankfurt-1')
    expect(homeFleetRegion()).toBe('eu')
  })

  it('returns undefined for an unrecognized REGION_ID (fail safe → full baseline)', () => {
    setEnv(undefined, 'ap-tokyo-1')
    expect(homeFleetRegion()).toBeUndefined()
  })

  it('returns undefined when no region env is set (staging/tests/local)', () => {
    setEnv(undefined, undefined)
    expect(homeFleetRegion()).toBeUndefined()
  })
})

describe('getHomeFleetEnv', () => {
  it('scopes the production baseline to the US control plane', () => {
    setEnv(undefined, 'us-ashburn-1')
    const env = getHomeFleetEnv('production')
    expect(env.baseline.map((b) => b.hostId).sort()).toEqual(['latitude-dal-1', 'latitude-dal-2'])
    expect(env.baseline.every((b) => b.region === 'us')).toBe(true)
  })

  it('scopes the production baseline to the EU control plane', () => {
    setEnv(undefined, 'eu-frankfurt-1')
    const env = getHomeFleetEnv('production')
    expect(env.baseline.map((b) => b.hostId).sort()).toEqual(['latitude-fra-1', 'latitude-fra-2'])
    expect(env.baseline.every((b) => b.region === 'eu')).toBe(true)
  })

  it('keeps the burst policy intact when scoping', () => {
    setEnv(undefined, 'us-ashburn-1')
    const env = getHomeFleetEnv('production')
    expect(env.burst.enabled).toBe(true)
    expect(env.burst.maxPerRegion).toBeGreaterThan(0)
  })

  it('falls back to the full baseline when the region is unknown', () => {
    setEnv(undefined, undefined)
    const env = getHomeFleetEnv('production')
    expect(env.baseline.length).toBe(4)
  })

  it('falls back to the full baseline rather than manage nothing on an unrecognized region', () => {
    setEnv(undefined, 'ap-tokyo-1')
    const env = getHomeFleetEnv('production')
    expect(env.baseline.length).toBe(4)
  })
})
