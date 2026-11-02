// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-288: every spend figure is two lines — the provider's model cost and the
 * Shogo fee on top of it — and they add up to the total the user already saw.
 * The same components render both surfaces, so there is no desktop/cloud split.
 */

import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createRequire } from 'node:module'
import { createReactNativeMock } from '../../../test/react-native-mock'

const rnMock = createReactNativeMock({
  Pressable: ({ onPress, children, ...props }: any) =>
    createElement('button', { ...props, onClick: onPress }, children),
})
mock.module('react-native', () => rnMock)

const sharedRequire = createRequire(
  new URL('../../../../../packages/shared-ui/src/primitives/index.ts', import.meta.url),
)
mock.module(sharedRequire.resolve('react-native'), () => rnMock)

mock.module('../../lib/visible-models', () => ({
  resolveShortName: (id: string) => id,
  resolveFamily: () => 'other',
}))

const { UsageSummaryView, UsageEventLogView, splitTotalUsd } = await import('../SharedAnalytics')

const summaryData: any = {
  summaries: [
    {
      userId: 'u1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
      userImage: null,
      model: 'hoshi-2-0',
      provider: 'deepseek',
      requestCount: 10,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalTokens: 1200,
      totalBilledUsd: 1.2,
      totalRawUsd: 1,
      modelCostUsd: 1,
      shogoFeeUsd: 0.2,
      unitemizedUsd: 0,
      avgDurationMs: 900,
    },
  ],
  totals: {
    totalRequests: 10,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalTokens: 1200,
    totalBilledUsd: 1.2,
    totalRawUsd: 1,
    modelCostUsd: 1,
    shogoFeeUsd: 0.2,
    unitemizedUsd: 0,
    shogoFeePercent: 20,
    totalToolCalls: 0,
    uniqueUsers: 1,
    uniqueModels: 1,
  },
  total: 1,
  page: 1,
  limit: 50,
}

const logData: any = {
  entries: [
    {
      id: 'e1',
      userId: 'u1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
      userImage: null,
      model: 'hoshi-2-0',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      billedUsd: 1.2,
      rawUsd: 1,
      modelCostUsd: 1,
      shogoFeeUsd: 0.2,
      unitemizedUsd: 0,
      durationMs: 900,
      success: true,
      createdAt: '2026-07-07T10:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
}

describe('spend is shown as model cost + Shogo fee', () => {
  test('the summary view shows both lines and they add up to the total', () => {
    render(createElement(UsageSummaryView, { data: summaryData }))

    const lines = screen.getAllByText(/Model \$1\.00 · Shogo fee \$0\.20 \(20%\)/)
    expect(lines.length).toBeGreaterThan(0)
    // The total is the sum of the two lines.
    expect(screen.getAllByText('$1.20').length).toBeGreaterThan(0)
  })

  test('the request log shows both lines per request', () => {
    render(createElement(UsageEventLogView, { data: logData, currentPage: 1 }))

    expect(screen.getAllByText(/Model \$1\.00 · Shogo fee \$0\.20/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('$1.20').length).toBeGreaterThan(0)
  })

  test('a desktop row reads as model cost only, with a $0.00 fee', () => {
    const desktop = {
      ...summaryData,
      summaries: [{ ...summaryData.summaries[0], totalBilledUsd: 0, modelCostUsd: 1, shogoFeeUsd: 0 }],
      totals: { ...summaryData.totals, totalBilledUsd: 0, modelCostUsd: 1, shogoFeeUsd: 0 },
    }
    render(createElement(UsageSummaryView, { data: desktop, isLocalMode: true }))

    expect(screen.getAllByText(/Model \$1\.00 · Shogo fee \$0\.00/).length).toBeGreaterThan(0)
  })

  test('a row billed before itemized billing says so', () => {
    const legacy = {
      ...summaryData,
      summaries: [{ ...summaryData.summaries[0], modelCostUsd: 0, shogoFeeUsd: 0, unitemizedUsd: 1.2 }],
      totals: { ...summaryData.totals, modelCostUsd: 0, shogoFeeUsd: 0, unitemizedUsd: 1.2 },
    }
    render(createElement(UsageSummaryView, { data: legacy }))

    expect(screen.getAllByText(/before itemized billing/).length).toBeGreaterThan(0)
  })

  test('splitTotalUsd falls back to the legacy pair when the server sends no split', () => {
    expect(splitTotalUsd({ totalBilledUsd: 1.2, totalRawUsd: 1 })).toBe(1.2)
    expect(splitTotalUsd({ totalBilledUsd: 0, totalRawUsd: 1 }, true)).toBe(1)
    expect(splitTotalUsd({ modelCostUsd: 1, shogoFeeUsd: 0.2, unitemizedUsd: 0 })).toBeCloseTo(1.2, 10)
  })
})
