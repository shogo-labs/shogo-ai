// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { COMMON_CHUNK_BUDGET_BYTES, MAIN_CHUNK_BUDGET_BYTES, breakdown, packageKey } from './bundle-report.mjs'

describe('bundle-report', () => {
  test('groups node_modules and app sources', () => {
    expect(packageKey('/node_modules/lucide-react-native/dist/esm/icons/x.js')).toBe('lucide-react-native')
    expect(packageKey('/node_modules/@sentry/core/esm/index.js')).toBe('@sentry/core')
    expect(packageKey('/repo/apps/mobile/components/project/IDE.tsx')).toBe('app:components/project')
  })

  test('sums sourcesContent by package', () => {
    const rows = breakdown({
      sources: ['/node_modules/three/build/three.module.js', '/node_modules/three/src/core.js', '/repo/apps/mobile/app/index.tsx'],
      sourcesContent: ['aaa', 'bb', 'c'],
    })
    expect(rows[0]).toEqual(['three', 5])
    expect(rows[1][0]).toBe('app:app/index.tsx')
  })

  test('budgets stay at the measured async-route ceilings', () => {
    expect(MAIN_CHUNK_BUDGET_BYTES).toBe(2_500_000)
    expect(COMMON_CHUNK_BUDGET_BYTES).toBe(12_000_000)
  })
})
