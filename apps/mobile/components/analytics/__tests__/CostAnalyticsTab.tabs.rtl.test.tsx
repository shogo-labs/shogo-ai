// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The Cost Optimizer tab strip is data-driven from `SECTION_CONFIG`; these
 * tests pin the exact tab set so a removed tab cannot quietly come back and a
 * re-added one cannot sneak in without updating this file.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Card: ({ children, ...props }: any) => createElement('div', props, children),
  CardContent: ({ children, ...props }: any) => createElement('div', props, children),
  Separator: () => createElement('div', { 'data-testid': 'separator' }),
}))
mock.module('../../settings/account-sheet-chrome', () => ({
  Text: ({ children, ...props }: any) => createElement('span', props, children),
  useAccountSheetIcons: (icons: Record<string, unknown>) => icons,
}))
mock.module('../SharedAnalytics', () => ({
  PeriodSelector: ({ value, onChange }: any) =>
    createElement(
      'button',
      {
        'data-testid': 'period-selector',
        onClick: () => onChange(value === '30d' ? '7d' : '30d'),
      },
      `period:${value}`,
    ),
  formatNumber: (n: number) => String(n),
  formatDuration: (ms: number) => `${ms}ms`,
  formatDollarCost: (c: number) => `$${c.toFixed(2)}`,
  formatPartialCost: (c: number) => `$${c.toFixed(2)}`,
  getModelColor: () => '',
  getModelTextColor: () => '',
  getModelDisplayName: (m: string) => m,
}))
mock.module('../OptimizerInActionSection', () => ({
  OptimizerInActionSection: () => createElement('div', { 'data-testid': 'section-inaction' }),
}))
mock.module('../BudgetSection', () => ({
  BudgetSection: () => createElement('div', { 'data-testid': 'section-budget' }),
}))
mock.module('../ExperimentsSection', () => ({
  ExperimentsSection: () => createElement('div', { 'data-testid': 'section-experiments' }),
}))
mock.module('../LoadErrorNotice', () => ({
  LoadErrorNotice: () => createElement('div', { 'data-testid': 'load-errors' }),
}))

const { CostAnalyticsTab } = await import('../CostAnalyticsTab')

const fetchCostAnalytics = mock(
  async (endpoint: string, _params?: Record<string, string>): Promise<any> => {
    switch (endpoint) {
      case 'agent-breakdown':
        return {
          breakdown: [],
          totals: {
            totalCreditCost: 0,
            totalRuns: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalToolCalls: 0,
            uniqueAgents: 0,
            uniqueModels: 0,
          },
        }
      case 'trends':
        return { trends: [], forecast: { nextMonth: 0, trend: 'stable', percentChange: 0 } }
      case 'budget-alerts':
        return []
      case 'budget-status':
        return null
      case 'experiments':
        return []
      case 'optimizer-in-action':
        return { overrides: [], experiments: [], evalScores: [] }
      default:
        throw new Error(`unexpected cost-analytics endpoint: ${endpoint}`)
    }
  },
)
const postCostAnalytics = mock(async (): Promise<any> => ({}))

const endpoints = () => fetchCostAnalytics.mock.calls.map(([endpoint]) => endpoint as string)

/** Tab-strip labels, excluding the period selector and any section-rendered controls. */
const tabLabels = () =>
  screen
    .getAllByRole('button')
    .map((b) => (b.textContent ?? '').trim())
    .filter((label) => !label.startsWith('period:'))

const renderTab = () =>
  render(
    <CostAnalyticsTab
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
    />,
  )

const lastCall = (endpoint: string) =>
  [...fetchCostAnalytics.mock.calls].reverse().find(([e]) => e === endpoint)

beforeEach(() => {
  fetchCostAnalytics.mockClear()
  postCostAnalytics.mockClear()
})

describe('CostAnalyticsTab tab strip', () => {
  test('renders exactly Agents, In Action, Trends, Budgets, A/B Tests in that order', async () => {
    renderTab()

    await waitFor(() => expect(tabLabels()).toHaveLength(5))
    expect(tabLabels()).toEqual(['Agents', 'In Action', 'Trends', 'Budgets', 'A/B Tests'])
    // The removed tabs must not reappear under either label.
    expect(screen.queryByText('Optimize')).toBeNull()
    expect(screen.queryByText('Sub-Agents')).toBeNull()
  })

  test('only the eager tabs load on mount, and nothing requests the removed endpoints', async () => {
    renderTab()

    await waitFor(() =>
      expect(endpoints().sort()).toEqual(
        ['agent-breakdown', 'budget-alerts', 'budget-status', 'trends'].sort(),
      ),
    )
    // In Action is lazy: opening it is the only thing that requests it.
    expect(endpoints()).not.toContain('optimizer-in-action')
    expect(endpoints()).not.toContain('recommendations')
    expect(endpoints()).not.toContain('subagent-overrides')
  })

  test('In Action and A/B Tests load their own data when opened', async () => {
    renderTab()
    await waitFor(() => expect(tabLabels()).toHaveLength(5))

    fireEvent.click(screen.getByText('In Action'))
    await waitFor(() => expect(screen.getByTestId('section-inaction')).toBeTruthy())
    await waitFor(() => expect(endpoints()).toContain('optimizer-in-action'))

    fireEvent.click(screen.getByText('A/B Tests'))
    await waitFor(() => expect(screen.getByTestId('section-experiments')).toBeTruthy())
    await waitFor(() => expect(endpoints()).toContain('experiments'))

    expect(screen.queryByTestId('section-budget')).toBeNull()
    expect(endpoints()).not.toContain('recommendations')
  })

  test('changing the period refetches the eagerly loaded tabs against the new window', async () => {
    renderTab()
    await waitFor(() => expect(tabLabels()).toHaveLength(5))
    await waitFor(() => expect(lastCall('agent-breakdown')?.[1]).toEqual({ period: '30d' }))

    fireEvent.click(screen.getByTestId('period-selector'))

    await waitFor(() => expect(lastCall('agent-breakdown')?.[1]).toEqual({ period: '7d' }))
    expect(lastCall('trends')?.[1]).toEqual({ period: '7d' })
    expect(endpoints()).not.toContain('recommendations')
  })
})
