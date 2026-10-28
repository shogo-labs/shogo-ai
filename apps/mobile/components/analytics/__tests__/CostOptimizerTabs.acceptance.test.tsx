// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance — SHO-79: the Cost Optimizer (Analytics → Costs) drops the
 * "Optimize" and "Sub-Agents" tabs while keeping every recommendations /
 * override / experiment API in place.
 *
 * The developer's `CostAnalyticsTab.tabs.rtl.test.tsx` pins the label set and
 * the request set. This spec covers the rest of the card's acceptance criteria:
 * every surviving tab is live (no dead tab), the strip never grows back, the
 * unmounted sections are still on disk so re-mounting is a one-line change, and
 * the server surface was not touched.
 */

import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, ...props }: any) =>
      createElement('button', { ...props, onClick: onPress }, children),
  }),
)
// `Button` is mocked deliberately: the unmounted sections import it, so if it is
// ever re-imported into the mounted tree this spec keeps asserting the tabs
// instead of dying on a missing mock export.
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Card: ({ children, ...props }: any) => createElement('div', props, children),
  CardContent: ({ children, ...props }: any) => createElement('div', props, children),
  Separator: () => createElement('div', { 'data-testid': 'separator' }),
  Button: ({ children, ...props }: any) => createElement('button', props, children),
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

const ANALYTICS_DIR = join(import.meta.dir, '..')
const source = (file: string) => readFileSync(join(ANALYTICS_DIR, file), 'utf8')

const AGENTS_EMPTY_STATE = 'No agent cost data yet. Costs will appear here as agents run.'

const fetchCostAnalytics = mock(async (endpoint: string): Promise<any> => {
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
})
const postCostAnalytics = mock(async (): Promise<any> => ({}))

const endpoints = () => fetchCostAnalytics.mock.calls.map(([endpoint]) => endpoint as string)

const renderTab = () => {
  fetchCostAnalytics.mockClear()
  return render(
    <CostAnalyticsTab
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
    />,
  )
}

const openTab = async (label: string) => {
  await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(1))
  fireEvent.click(screen.getByText(label))
}

describe('SHO-79 acceptance — Cost Optimizer tabs', () => {
  test('the strip is exactly the five surviving tabs, in order, with no removed tab', async () => {
    renderTab()

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button')
          .map((b) => (b.textContent ?? '').trim())
          .filter((label) => label.length > 0 && !label.startsWith('period:')),
      ).toEqual(['Agents', 'In Action', 'Trends', 'Budgets', 'A/B Tests']),
    )
    expect(screen.queryByText('Optimize')).toBeNull()
    expect(screen.queryByText('Sub-Agents')).toBeNull()
  })

  test('all five tabs are live — each one renders its own section and nothing else', async () => {
    renderTab()

    // Agents is the default tab and renders inline (empty state with the stub payload).
    await waitFor(() => expect(screen.getByText(AGENTS_EMPTY_STATE)).toBeTruthy())

    await openTab('In Action')
    await waitFor(() => expect(screen.getByTestId('section-inaction')).toBeTruthy())
    expect(screen.queryByTestId('section-budget')).toBeNull()
    expect(screen.queryByTestId('section-experiments')).toBeNull()
    expect(screen.queryByText(AGENTS_EMPTY_STATE)).toBeNull()

    await openTab('Trends')
    await waitFor(() => expect(screen.queryByTestId('section-inaction')).toBeNull())

    await openTab('Budgets')
    await waitFor(() => expect(screen.getByTestId('section-budget')).toBeTruthy())
    expect(screen.queryByTestId('section-experiments')).toBeNull()

    await openTab('A/B Tests')
    await waitFor(() => expect(screen.getByTestId('section-experiments')).toBeTruthy())
    expect(screen.queryByTestId('section-budget')).toBeNull()
    expect(screen.queryByTestId('section-inaction')).toBeNull()

    // Back to Agents: the strip is fully reversible, no section is stuck.
    await openTab('Agents')
    await waitFor(() => expect(screen.getByText(AGENTS_EMPTY_STATE)).toBeTruthy())
    expect(screen.queryByTestId('section-experiments')).toBeNull()
  })

  test('a full tour of the strip plus a period change never touches the removed endpoints', async () => {
    renderTab()

    for (const label of ['In Action', 'Trends', 'Budgets', 'A/B Tests', 'Agents']) {
      await openTab(label)
    }
    fireEvent.click(screen.getByTestId('period-selector'))
    await waitFor(() => expect(endpoints()).toContain('trends'))

    expect(endpoints().length).toBeGreaterThan(0)
    expect(endpoints()).not.toContain('recommendations')
    expect(endpoints()).not.toContain('subagent-overrides')
    expect(endpoints()).not.toContain('subagent-override')
  })

  test('the removed sections are unmounted but still on disk, so re-mounting stays one line', () => {
    const tab = source('CostAnalyticsTab.tsx')
    expect(tab).not.toContain("from './RecommendationsSection'")
    expect(tab).not.toContain("from './SubAgentModelsSection'")
    expect(tab).not.toContain("label: 'Optimize'")
    expect(tab).not.toContain("label: 'Sub-Agents'")

    // Still exported, still unmounted — a one-line re-mount.
    expect(source('RecommendationsSection.tsx')).toContain('export function RecommendationsSection')
    expect(source('SubAgentModelsSection.tsx')).toContain('export function SubAgentModelsSection')

    // The panel no longer threads the override CRUD into the tab.
    const panel = source('WorkspaceCostPanel.tsx')
    expect(panel).not.toContain('SubagentOverride')
    expect(panel).not.toContain('listSubagentOverrides')
  })

  test('the recommendations / override / experiment API is untouched', () => {
    const route = readFileSync(join(ANALYTICS_DIR, '../../..', 'api/src/routes/cost-analytics.ts'), 'utf8')
    for (const path of [
      '/cost-analytics/recommendations',
      '/cost-analytics/optimizer-in-action',
      '/cost-analytics/experiments',
    ]) {
      expect(route).toContain(path)
    }
  })
})
