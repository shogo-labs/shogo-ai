// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-597: Analytics shows one cost figure — the total the person is billed —
 * and not the model-cost / Shogo-fee breakdown SHO-288 added. The same
 * components render desktop and cloud, so there is no split surface.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
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

const summaryRow = (over: Record<string, any> = {}) => ({
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
  ...over,
})

const summaryData: any = {
  summaries: [summaryRow()],
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

/** Nothing anywhere on these surfaces may name the split. */
function expectNoSplitText() {
  expect(screen.queryByText(/Shogo fee/i)).toBeNull()
  expect(screen.queryByText(/Model \$/)).toBeNull()
  expect(screen.queryByText(/Fee \$/)).toBeNull()
  expect(screen.queryByText(/before itemized billing/i)).toBeNull()
}

describe('spend is shown as one total, with no split', () => {
  test('the summary view shows the billed total and no split line', () => {
    render(createElement(UsageSummaryView, { data: summaryData }))

    expect(screen.getAllByText('$1.20').length).toBeGreaterThan(0)
    expectNoSplitText()
  })

  test('the request log shows the billed total per request and no split line', () => {
    render(createElement(UsageEventLogView, { data: logData, currentPage: 1 }))

    expect(screen.getAllByText('$1.20').length).toBeGreaterThan(0)
    expectNoSplitText()
  })

  test('a desktop row still totals its provider cost', () => {
    const desktop = {
      ...summaryData,
      summaries: [summaryRow({ totalBilledUsd: 0, modelCostUsd: 1, shogoFeeUsd: 0 })],
      totals: { ...summaryData.totals, totalBilledUsd: 0, modelCostUsd: 1, shogoFeeUsd: 0 },
    }
    render(createElement(UsageSummaryView, { data: desktop }))

    expect(screen.getAllByText('$1.00').length).toBeGreaterThan(0)
    expectNoSplitText()
  })

  test('a row billed before itemized billing still totals, without the note', () => {
    const legacy = {
      ...summaryData,
      summaries: [summaryRow({ modelCostUsd: 0, shogoFeeUsd: 0, unitemizedUsd: 1.2 })],
      totals: { ...summaryData.totals, modelCostUsd: 0, shogoFeeUsd: 0, unitemizedUsd: 1.2 },
    }
    render(createElement(UsageSummaryView, { data: legacy }))

    expect(screen.getAllByText('$1.20').length).toBeGreaterThan(0)
    expectNoSplitText()
  })

  test('splitTotalUsd falls back to the legacy pair when the server sends no split', () => {
    expect(splitTotalUsd({ totalBilledUsd: 1.2, totalRawUsd: 1 })).toBe(1.2)
    // Same rule the server uses for costUsd: billed when positive, else raw.
    expect(splitTotalUsd({ totalBilledUsd: 0, totalRawUsd: 1 })).toBe(1)
    expect(splitTotalUsd({ modelCostUsd: 1, shogoFeeUsd: 0.2, unitemizedUsd: 0 })).toBeCloseTo(1.2, 10)
  })
})

describe('the Cost sort orders rows by the number they show', () => {
  test('a row with a lower model cost but a higher total sorts above it', () => {
    // Ada's provider cost is higher, but Grace's total (0.4 provider + 1.0
    // pre-itemized) is what she was billed — so Cost desc puts Grace first.
    const data = {
      ...summaryData,
      summaries: [
        summaryRow({ userId: 'u1', userName: 'Ada', modelCostUsd: 0.5, shogoFeeUsd: 0, unitemizedUsd: 0 }),
        summaryRow({
          userId: 'u2',
          userName: 'Grace',
          userEmail: 'grace@example.com',
          modelCostUsd: 0.4,
          shogoFeeUsd: 0,
          unitemizedUsd: 1,
        }),
      ],
      total: 2,
    }
    render(createElement(UsageSummaryView, { data }))

    const costSort = screen.queryByText('Cost') ?? screen.getByText('Total')
    fireEvent.click(costSort)

    const names = screen.getAllByText(/^(Ada|Grace)$/).map((n) => n.textContent)
    expect(names).toEqual(['Grace', 'Ada'])
  })
})
