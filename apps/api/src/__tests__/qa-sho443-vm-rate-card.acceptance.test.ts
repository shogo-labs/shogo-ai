// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-443, the VM rate card is re-cut to market shape.
 *
 * SHO-424 shipped $0.10/vCPU-h + $0.005/GiB-h. This card moves it to
 * $0.07/vCPU-h + $0.012/GiB-h so RAM (the thing that limits density on a
 * 512 GB `s3-large-x86` host) carries the price and CPU does not. The card's
 * own suites pin the arithmetic through `appSeconds`; this file pins the
 * acceptance criteria literally, including the `agentSeconds` path a real
 * agent turn takes, and the two things that must NOT have moved: idle stays
 * free and billing stays shadow.
 *
 *   bun --no-env-file test apps/api/src/__tests__/qa-sho443-vm-rate-card.acceptance.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { VM_PRICING, computeVmCost, vmBillingMode } from '../config/vm-pricing'

describe('AC1 — the standard VM is $0.188 per active hour', () => {
  test('2 vCPU / 4096 MiB for 3600 agent-seconds splits 0.14 + 0.048', () => {
    const cost = computeVmCost({
      vcpus: 2,
      memMiB: 4096,
      agentSeconds: 3600,
      appSeconds: 0,
      idleSeconds: 0,
      cause: 'user_open',
    })
    expect(cost.vcpuUsd).toBeCloseTo(0.14, 10)
    expect(cost.memoryUsd).toBeCloseTo(0.048, 10)
    expect(cost.totalUsd).toBeCloseTo(0.188, 10)
    expect(cost.billedSeconds).toBe(3600)
  })

  test('an idle-only hour costs nothing', () => {
    const cost = computeVmCost({
      vcpus: 2,
      memMiB: 4096,
      agentSeconds: 0,
      appSeconds: 0,
      idleSeconds: 3600,
      cause: 'user_open',
    })
    expect(cost.totalUsd).toBe(0)
    expect(cost.freeSeconds).toBe(3600)
  })

  test('a never-billed cause costs nothing at the new rates', () => {
    for (const cause of VM_PRICING.neverBilledCauses) {
      const cost = computeVmCost({
        vcpus: 2,
        memMiB: 4096,
        agentSeconds: 3600,
        appSeconds: 0,
        idleSeconds: 0,
        cause,
      })
      expect(cost.totalUsd).toBe(0)
      expect(cost.freeCause).toBe(true)
    }
  })
})

describe('AC2 — the rate card the routes serialize', () => {
  test('is exactly $0.07/vCPU-h + $0.012/GiB-h, idle none', () => {
    expect(VM_PRICING.vcpuHour).toBe(0.07)
    expect(VM_PRICING.gibHour).toBe(0.012)
    expect(VM_PRICING.idleBilling).toBe('none')
  })

  test('RAM is priced high relative to CPU, which is the point of the re-cut', () => {
    // SHO-424 was $0.10 + $0.005: a GiB-hour cost 5% of a vCPU-hour. The re-cut
    // puts that ratio at 17%, so density (RAM) is what the price tracks.
    const ratio = VM_PRICING.gibHour / VM_PRICING.vcpuHour
    expect(ratio).toBeCloseTo(0.012 / 0.07, 10)
    expect(ratio).toBeGreaterThan(0.15)
  })
})

describe('AC4 — billing stays shadow', () => {
  test('defaults to shadow with no env', () => {
    expect(vmBillingMode({})).toBe('shadow')
  })

  test('only an explicit enforce turns it on', () => {
    expect(vmBillingMode({ VM_BILLING_MODE: 'enforce' })).toBe('enforce')
    expect(vmBillingMode({ VM_BILLING_MODE: 'shadow' })).toBe('shadow')
    expect(vmBillingMode({ VM_BILLING_MODE: 'anything-else' })).toBe('shadow')
  })
})
