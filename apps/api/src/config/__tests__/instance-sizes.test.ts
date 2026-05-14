// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

const mobileTechStackIds = new Set(['expo', 'react-native'])

mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: (id: string | null | undefined) =>
    typeof id === 'string' && mobileTechStackIds.has(id),
}))

const {
  INSTANCE_MARKUP,
  INSTANCE_SIZES,
  INSTANCE_SIZE_ORDER,
  applyTechStackFloor,
  getInstanceDisplayPrice,
  getInstanceSizeSpec,
  getKubernetesResourceOverrides,
  getMobileDiskSizeLimit,
  isInstanceUpgrade,
  isMobileTechStack,
} = await import('../instance-sizes')

describe('INSTANCE_SIZES', () => {
  it('has exactly 5 sizes in canonical order', () => {
    expect(INSTANCE_SIZE_ORDER).toEqual(['micro', 'small', 'medium', 'large', 'xlarge'])
    expect(Object.keys(INSTANCE_SIZES).sort()).toEqual(
      ['large', 'medium', 'micro', 'small', 'xlarge'].sort(),
    )
  })

  it('every size has all 12 required fields', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const spec = INSTANCE_SIZES[size]
      expect(spec.label).toBeTruthy()
      expect(spec.cpu).toMatch(/^\d+m?$/)
      expect(typeof spec.cpuCores).toBe('number')
      expect(spec.memory).toMatch(/^\d+Gi$/)
      expect(typeof spec.memoryGb).toBe('number')
      expect(spec.requestCpu).toBeTruthy()
      expect(spec.requestMemory).toBeTruthy()
      expect(typeof spec.storageLimitBytes).toBe('number')
      expect(spec.storageGbLabel).toMatch(/GB/)
      expect(spec.diskSizeLimit).toMatch(/^\d+Gi$/)
      expect(typeof spec.baseCostMonthly).toBe('number')
      expect(typeof spec.baseCostAnnual).toBe('number')
      expect(typeof spec.minScale).toBe('number')
    }
  })

  it('CPU, memory, and storage scale monotonically up the ladder', () => {
    let lastCpu = 0
    let lastMem = 0
    let lastStorage = 0
    for (const size of INSTANCE_SIZE_ORDER) {
      const s = INSTANCE_SIZES[size]
      expect(s.cpuCores).toBeGreaterThanOrEqual(lastCpu)
      expect(s.memoryGb).toBeGreaterThanOrEqual(lastMem)
      expect(s.storageLimitBytes).toBeGreaterThanOrEqual(lastStorage)
      lastCpu = s.cpuCores
      lastMem = s.memoryGb
      lastStorage = s.storageLimitBytes
    }
  })

  it('micro is free with minScale 0 (scales to zero)', () => {
    expect(INSTANCE_SIZES.micro.baseCostMonthly).toBe(0)
    expect(INSTANCE_SIZES.micro.baseCostAnnual).toBe(0)
    expect(INSTANCE_SIZES.micro.minScale).toBe(0)
  })

  it('all paid tiers keep minScale=1 (no cold starts)', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(INSTANCE_SIZES[size].minScale).toBe(1)
      expect(INSTANCE_SIZES[size].baseCostMonthly).toBeGreaterThan(0)
    }
  })

  it('annual price equals 10× monthly for every size', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const s = INSTANCE_SIZES[size]
      if (s.baseCostMonthly === 0) {
        expect(s.baseCostAnnual).toBe(0)
      } else {
        expect(s.baseCostAnnual).toBe(s.baseCostMonthly * 10)
      }
    }
  })
})

describe('getInstanceSizeSpec', () => {
  it('returns the same reference as INSTANCE_SIZES[size]', () => {
    expect(getInstanceSizeSpec('micro')).toBe(INSTANCE_SIZES.micro)
    expect(getInstanceSizeSpec('xlarge')).toBe(INSTANCE_SIZES.xlarge)
  })
})

describe('isMobileTechStack (re-export)', () => {
  it('proxies the registry function', () => {
    expect(isMobileTechStack('expo')).toBe(true)
    expect(isMobileTechStack('react-native')).toBe(true)
    expect(isMobileTechStack('nextjs')).toBe(false)
    expect(isMobileTechStack(null)).toBe(false)
    expect(isMobileTechStack(undefined)).toBe(false)
  })
})

describe('applyTechStackFloor', () => {
  it('returns the input size unchanged when the stack is not mobile', () => {
    expect(applyTechStackFloor('micro', 'nextjs')).toBe('micro')
    expect(applyTechStackFloor('small', null)).toBe('small')
    expect(applyTechStackFloor('medium', undefined)).toBe('medium')
  })

  it('lifts micro to small for mobile stacks', () => {
    expect(applyTechStackFloor('micro', 'expo')).toBe('small')
    expect(applyTechStackFloor('micro', 'react-native')).toBe('small')
  })

  it('does not downgrade larger sizes for mobile stacks', () => {
    expect(applyTechStackFloor('small', 'expo')).toBe('small')
    expect(applyTechStackFloor('medium', 'expo')).toBe('medium')
    expect(applyTechStackFloor('large', 'expo')).toBe('large')
    expect(applyTechStackFloor('xlarge', 'expo')).toBe('xlarge')
  })
})

describe('getMobileDiskSizeLimit', () => {
  it('returns 6Gi for micro and small (inflated mobile floor)', () => {
    expect(getMobileDiskSizeLimit('micro')).toBe('6Gi')
    expect(getMobileDiskSizeLimit('small')).toBe('6Gi')
  })

  it('returns 10Gi for medium', () => {
    expect(getMobileDiskSizeLimit('medium')).toBe('10Gi')
  })

  it('falls back to the spec diskSizeLimit for large and xlarge', () => {
    expect(getMobileDiskSizeLimit('large')).toBe(INSTANCE_SIZES.large.diskSizeLimit)
    expect(getMobileDiskSizeLimit('xlarge')).toBe(INSTANCE_SIZES.xlarge.diskSizeLimit)
  })
})

describe('getInstanceDisplayPrice', () => {
  it('returns 0 for free tier (micro)', () => {
    expect(getInstanceDisplayPrice('micro', 'monthly')).toBe(0)
    expect(getInstanceDisplayPrice('micro', 'annual')).toBe(0)
  })

  it('returns monthly base price multiplied by INSTANCE_MARKUP', () => {
    const expected =
      Math.round(INSTANCE_SIZES.small.baseCostMonthly * INSTANCE_MARKUP * 100) / 100
    expect(getInstanceDisplayPrice('small', 'monthly')).toBe(expected)
  })

  it('returns annual base price multiplied by INSTANCE_MARKUP', () => {
    expect(getInstanceDisplayPrice('xlarge', 'annual')).toBe(
      Math.round(INSTANCE_SIZES.xlarge.baseCostAnnual * INSTANCE_MARKUP * 100) / 100,
    )
  })

  it('rounds to 2 decimal places', () => {
    // INSTANCE_MARKUP=1.0 so values are integers; sanity assertion.
    expect(Number.isInteger(getInstanceDisplayPrice('medium', 'monthly') * 100)).toBe(true)
  })
})

describe('isInstanceUpgrade', () => {
  it('returns true for upward moves', () => {
    expect(isInstanceUpgrade('micro', 'small')).toBe(true)
    expect(isInstanceUpgrade('small', 'medium')).toBe(true)
    expect(isInstanceUpgrade('medium', 'xlarge')).toBe(true)
    expect(isInstanceUpgrade('micro', 'xlarge')).toBe(true)
  })

  it('returns false for downward moves', () => {
    expect(isInstanceUpgrade('xlarge', 'medium')).toBe(false)
    expect(isInstanceUpgrade('small', 'micro')).toBe(false)
  })

  it('returns false for same-tier moves (strict >)', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      expect(isInstanceUpgrade(size, size)).toBe(false)
    }
  })
})

describe('getKubernetesResourceOverrides', () => {
  it('returns request, limits, diskSizeLimit, and minScale for a known size', () => {
    const out = getKubernetesResourceOverrides('small')
    expect(out).toEqual({
      requests: {
        memory: INSTANCE_SIZES.small.requestMemory,
        cpu: INSTANCE_SIZES.small.requestCpu,
      },
      limits: { memory: INSTANCE_SIZES.small.memory, cpu: INSTANCE_SIZES.small.cpu },
      diskSizeLimit: INSTANCE_SIZES.small.diskSizeLimit,
      minScale: INSTANCE_SIZES.small.minScale,
    })
  })

  it('returns micro minScale=0 (scales to zero)', () => {
    expect(getKubernetesResourceOverrides('micro').minScale).toBe(0)
  })

  it('returns paid-tier minScale=1', () => {
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(getKubernetesResourceOverrides(size).minScale).toBe(1)
    }
  })

  it('uses memory and cpu (limit) — not request — as the limits', () => {
    const out = getKubernetesResourceOverrides('large')
    expect(out.limits.cpu).toBe(INSTANCE_SIZES.large.cpu)
    expect(out.limits.memory).toBe(INSTANCE_SIZES.large.memory)
    expect(out.requests.cpu).toBe(INSTANCE_SIZES.large.requestCpu)
    expect(out.requests.memory).toBe(INSTANCE_SIZES.large.requestMemory)
  })
})

describe('INSTANCE_MARKUP', () => {
  it('is currently 1.0 (no markup)', () => {
    expect(INSTANCE_MARKUP).toBe(1.0)
  })
})
