// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { resolveWorkers } from '../../e2e/playwright.config'

describe('resolveWorkers', () => {
  it('bounds the critical suite to 4 workers however high E2E_WORKERS goes', () => {
    // The cap is the point: a dispatch cannot ask the staging cluster for more
    // concurrency than three nodes can absorb (SHO-136).
    expect(resolveWorkers({ E2E_SUITE: 'critical', E2E_WORKERS: '99', CI: 'true' })).toBe(4)
    expect(resolveWorkers({ E2E_SUITE: 'critical', CI: 'true' })).toBe(4)
    expect(resolveWorkers({ E2E_SUITE: 'critical', E2E_WORKERS: '8', CI: 'true' })).toBe(4)
  })

  it('lets E2E_WORKERS dial the critical suite down', () => {
    expect(resolveWorkers({ E2E_SUITE: 'critical', E2E_WORKERS: '2', CI: 'true' })).toBe(2)
    expect(resolveWorkers({ E2E_SUITE: 'critical', E2E_WORKERS: '1', CI: 'true' })).toBe(1)
  })

  it('keeps the full suite at 8 in CI and honors an override there', () => {
    expect(resolveWorkers({ CI: 'true' })).toBe(8)
    expect(resolveWorkers({ E2E_SUITE: 'full', CI: 'true' })).toBe(8)
    expect(resolveWorkers({ E2E_SUITE: 'full', E2E_WORKERS: '12', CI: 'true' })).toBe(12)
  })

  it('stays serial locally and ignores a non-numeric override', () => {
    expect(resolveWorkers({})).toBe(1)
    expect(resolveWorkers({ E2E_WORKERS: 'lots' })).toBe(1)
    expect(resolveWorkers({ E2E_SUITE: 'critical', E2E_WORKERS: '0' })).toBe(4)
  })
})
