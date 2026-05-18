// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock the shared-runtime predicate BEFORE importing instance-sizes
// (instance-sizes re-exports `isMobileTechStack` from it).
const isMobileTechStackShared = mock((id: string | null | undefined): boolean => {
  if (!id) return false
  return id.startsWith('expo') || id === 'react-native'
})
mock.module('@shogo/shared-runtime', () => ({
  isMobileTechStack: isMobileTechStackShared,
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
} = await import('../config/instance-sizes')

beforeEach(() => {
  isMobileTechStackShared.mockClear()
})

describe('INSTANCE_SIZE_ORDER', () => {
  test('lists sizes in monotonically increasing power', () => {
    expect(INSTANCE_SIZE_ORDER).toEqual(['micro', 'small', 'medium', 'large', 'xlarge'])
  })

  test('contains every key in INSTANCE_SIZES (and vice versa)', () => {
    expect(new Set(INSTANCE_SIZE_ORDER)).toEqual(new Set(Object.keys(INSTANCE_SIZES) as never))
  })
})

describe('INSTANCE_SIZES catalog invariants', () => {
  test('cpuCores increases monotonically across the order', () => {
    const cores = INSTANCE_SIZE_ORDER.map((s) => INSTANCE_SIZES[s].cpuCores)
    for (let i = 1; i < cores.length; i++) {
      expect(cores[i]).toBeGreaterThan(cores[i - 1])
    }
  })

  test('memoryGb increases monotonically across the order', () => {
    const memGb = INSTANCE_SIZE_ORDER.map((s) => INSTANCE_SIZES[s].memoryGb)
    for (let i = 1; i < memGb.length; i++) {
      expect(memGb[i]).toBeGreaterThan(memGb[i - 1])
    }
  })

  test('baseCostMonthly is non-decreasing (xlarge >= large >= ...)', () => {
    const costs = INSTANCE_SIZE_ORDER.map((s) => INSTANCE_SIZES[s].baseCostMonthly)
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1])
    }
  })

  test('annual cost is the documented 10x monthly per size (10-month plan)', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const s = INSTANCE_SIZES[size]
      if (s.baseCostMonthly > 0) {
        expect(s.baseCostAnnual).toBe(s.baseCostMonthly * 10)
      }
    }
  })

  test('micro is the only free tier with minScale=0', () => {
    expect(INSTANCE_SIZES.micro.baseCostMonthly).toBe(0)
    expect(INSTANCE_SIZES.micro.minScale).toBe(0)
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      expect(INSTANCE_SIZES[size].minScale).toBe(1)
    }
  })

  test('storageLimitBytes matches the labeled GB to within rounding', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const s = INSTANCE_SIZES[size]
      const gb = s.storageLimitBytes / 1024 ** 3
      const labeled = parseFloat(s.storageGbLabel)
      expect(gb).toBe(labeled)
    }
  })

  test('requestCpu and requestMemory are non-empty strings', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const s = INSTANCE_SIZES[size]
      expect(s.requestCpu.length).toBeGreaterThan(0)
      expect(s.requestMemory.length).toBeGreaterThan(0)
      expect(s.diskSizeLimit.length).toBeGreaterThan(0)
    }
  })
})

describe('INSTANCE_MARKUP', () => {
  test('is currently 1.0 (no markup)', () => {
    expect(INSTANCE_MARKUP).toBe(1.0)
  })
})

describe('getInstanceSizeSpec', () => {
  test('returns the spec for each valid size', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      expect(getInstanceSizeSpec(size)).toBe(INSTANCE_SIZES[size])
    }
  })

  test('returned spec is the same reference (not a copy)', () => {
    expect(getInstanceSizeSpec('small')).toBe(INSTANCE_SIZES.small)
  })
})

describe('isMobileTechStack', () => {
  test('is the re-export from @shogo/shared-runtime', () => {
    expect(isMobileTechStack).toBe(isMobileTechStackShared)
  })

  test('delegates to the shared predicate (no inline heuristic)', () => {
    isMobileTechStack('expo-router')
    expect(isMobileTechStackShared).toHaveBeenCalledWith('expo-router')
  })
})

describe('applyTechStackFloor', () => {
  test('returns the original size for non-mobile tech stacks', () => {
    expect(applyTechStackFloor('micro', 'next-15')).toBe('micro')
    expect(applyTechStackFloor('micro', 'vite-react')).toBe('micro')
    expect(applyTechStackFloor('xlarge', 'next-15')).toBe('xlarge')
  })

  test('floors micro to small for mobile tech stacks', () => {
    expect(applyTechStackFloor('micro', 'expo-router')).toBe('small')
    expect(applyTechStackFloor('micro', 'react-native')).toBe('small')
  })

  test('does NOT downgrade larger sizes for mobile stacks', () => {
    expect(applyTechStackFloor('small', 'expo-router')).toBe('small')
    expect(applyTechStackFloor('medium', 'expo-router')).toBe('medium')
    expect(applyTechStackFloor('large', 'expo-router')).toBe('large')
    expect(applyTechStackFloor('xlarge', 'expo-router')).toBe('xlarge')
  })

  test('treats null and undefined tech stack as non-mobile', () => {
    expect(applyTechStackFloor('micro', null)).toBe('micro')
    expect(applyTechStackFloor('micro', undefined)).toBe('micro')
  })

  test('treats empty string tech stack as non-mobile', () => {
    expect(applyTechStackFloor('micro', '')).toBe('micro')
  })
})

describe('getMobileDiskSizeLimit', () => {
  test('lifts micro and small disk to 6Gi for mobile workloads', () => {
    expect(getMobileDiskSizeLimit('micro')).toBe('6Gi')
    expect(getMobileDiskSizeLimit('small')).toBe('6Gi')
  })

  test('lifts medium disk to 10Gi', () => {
    expect(getMobileDiskSizeLimit('medium')).toBe('10Gi')
  })

  test('uses the size default for large and xlarge', () => {
    expect(getMobileDiskSizeLimit('large')).toBe(INSTANCE_SIZES.large.diskSizeLimit)
    expect(getMobileDiskSizeLimit('xlarge')).toBe(INSTANCE_SIZES.xlarge.diskSizeLimit)
  })

  test('mobile overlay is always >= the size default (never shrinks disk)', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      const overlay = parseInt(getMobileDiskSizeLimit(size), 10)
      const base = parseInt(INSTANCE_SIZES[size].diskSizeLimit, 10)
      expect(overlay).toBeGreaterThanOrEqual(base)
    }
  })
})

describe('getInstanceDisplayPrice', () => {
  test('returns the monthly base cost when markup is 1.0', () => {
    expect(getInstanceDisplayPrice('small', 'monthly')).toBe(15)
    expect(getInstanceDisplayPrice('medium', 'monthly')).toBe(40)
    expect(getInstanceDisplayPrice('large', 'monthly')).toBe(80)
    expect(getInstanceDisplayPrice('xlarge', 'monthly')).toBe(150)
  })

  test('returns the annual base cost when interval=annual', () => {
    expect(getInstanceDisplayPrice('small', 'annual')).toBe(150)
    expect(getInstanceDisplayPrice('xlarge', 'annual')).toBe(1500)
  })

  test('micro is always $0 regardless of interval', () => {
    expect(getInstanceDisplayPrice('micro', 'monthly')).toBe(0)
    expect(getInstanceDisplayPrice('micro', 'annual')).toBe(0)
  })

  test('rounds to two decimals (currency display)', () => {
    // INSTANCE_MARKUP=1.0 makes all base costs integers, but the function
    // explicitly rounds — verify it does so. We re-derive the expectation
    // using the same formula the implementation uses to keep the test
    // robust if INSTANCE_MARKUP ever changes.
    for (const size of INSTANCE_SIZE_ORDER) {
      const expected = Math.round(INSTANCE_SIZES[size].baseCostMonthly * INSTANCE_MARKUP * 100) / 100
      expect(getInstanceDisplayPrice(size, 'monthly')).toBe(expected)
    }
  })
})

describe('isInstanceUpgrade', () => {
  test('returns true when moving to a larger size', () => {
    expect(isInstanceUpgrade('micro', 'small')).toBe(true)
    expect(isInstanceUpgrade('small', 'medium')).toBe(true)
    expect(isInstanceUpgrade('medium', 'xlarge')).toBe(true)
    expect(isInstanceUpgrade('micro', 'xlarge')).toBe(true)
  })

  test('returns false when moving to a smaller size (downgrade)', () => {
    expect(isInstanceUpgrade('small', 'micro')).toBe(false)
    expect(isInstanceUpgrade('xlarge', 'micro')).toBe(false)
    expect(isInstanceUpgrade('medium', 'small')).toBe(false)
  })

  test('returns false when the size is unchanged (not an upgrade)', () => {
    for (const size of INSTANCE_SIZE_ORDER) {
      expect(isInstanceUpgrade(size, size)).toBe(false)
    }
  })
})

describe('getKubernetesResourceOverrides', () => {
  test('builds K8s overrides directly from the spec', () => {
    const small = getKubernetesResourceOverrides('small')
    expect(small).toEqual({
      requests: { memory: '2Gi', cpu: '500m' },
      limits: { memory: '4Gi', cpu: '1000m' },
      diskSizeLimit: '4Gi',
      minScale: 1,
    })
  })

  test('returns micro overrides with minScale=0 (free tier scales to zero)', () => {
    const micro = getKubernetesResourceOverrides('micro')
    expect(micro.minScale).toBe(0)
    expect(micro.requests).toEqual({ memory: '768Mi', cpu: '100m' })
    expect(micro.limits).toEqual({ memory: '2Gi', cpu: '500m' })
  })

  test('returns xlarge overrides correctly', () => {
    const xl = getKubernetesResourceOverrides('xlarge')
    expect(xl).toEqual({
      requests: { memory: '16Gi', cpu: '4000m' },
      limits: { memory: '32Gi', cpu: '8000m' },
      diskSizeLimit: '32Gi',
      minScale: 1,
    })
  })

  test('keeps requests at 50% of limits (the documented burstable policy)', () => {
    // Only verifies sizes where the comment claims 50% — micro intentionally
    // requests less than 50% (768Mi of 2Gi).
    for (const size of ['small', 'medium', 'large', 'xlarge'] as const) {
      const o = getKubernetesResourceOverrides(size)
      const reqCpu = parseInt(o.requests.cpu, 10)
      const limCpu = parseInt(o.limits.cpu, 10)
      expect(reqCpu * 2).toBe(limCpu)

      const reqMem = parseInt(o.requests.memory, 10)
      const limMem = parseInt(o.limits.memory, 10)
      expect(reqMem * 2).toBe(limMem)
    }
  })
})
