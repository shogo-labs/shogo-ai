// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-423 — Settings → Compute renders the storage breakdown.
 *
 * The Compute tab is unreachable in the local e2e stack (Settings bounces a
 * `compute` tab back to `workspace` whenever `isLocal`), so the "Compute tab
 * renders the breakdown" acceptance criterion is pinned here instead: the tab
 * asks `api.getWorkspaceStorage` for its detail, renders a row per measured
 * category, a per-project list (hidden projects collapsed into `System`), the
 * 30-day trend and the month-to-date estimate labelled as a shadow estimate.
 *
 * The second case is the member's payload: `GET /api/workspaces/:id/storage`
 * strips `categories`/`projects` for a plain member, and the card must then
 * render nothing rather than a breakdown of zeros.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    View: ({ testID, children }: any) => createElement('div', { 'data-testid': testID }, children),
    Text: ({ children }: any) => createElement('span', null, children),
    Pressable: ({ testID, children, onPress }: any) =>
      createElement('div', { role: 'button', 'data-testid': testID, onClick: onPress }, children),
  } as any),
)

const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Card: passthrough,
  CardContent: passthrough,
  Badge: passthrough,
  Alert: passthrough,
  AlertTitle: passthrough,
  AlertDescription: passthrough,
  Skeleton: () => createElement('div', { 'data-testid': 'skeleton' }),
  Button: ({ children, onPress, testID }: any) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, children),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

mock.module('@shogo/shared-app/hooks', () => ({
  useBillingData: () => ({ subscription: null }),
}))
mock.module('expo-web-browser', () => ({ openBrowserAsync: async () => ({ type: 'dismiss' }) }))
mock.module('expo-linking', () => ({ createURL: (path: string) => path }))
mock.module('../../../lib/openWebAppSession', () => ({ openWebAppSession: async () => {} }))
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => ({}) }))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws-1', kind: 'team' }),
}))
mock.module('../InstanceComparisonTable', () => ({ InstanceComparisonTable: () => null }))

/** `GET /api/workspaces/:id/storage` for an owner/admin. */
const OWNER_STORAGE = {
  totalBytes: 1610612736,
  billableBytes: 1073741824,
  limitBytes: 5368709120,
  projectCount: 2,
  percentUsed: 30,
  isOverLimit: false,
  lastCalculatedAt: '2026-11-18T12:00:00.000Z',
  categories: {
    project_files: 1073741824,
    repo: 536435456,
    quarantine: 2097152,
  },
  projects: [
    { projectId: 'p-1', projectName: 'Marketing site', hidden: false, bytes: 1073741824 },
    { projectId: 'p-2', projectName: null, hidden: true, bytes: 536435456 },
  ],
  unmeasured: ['METAL_SNAP_BUCKET'],
  month: { billableGbMonths: 0.5, estimatedUsd: 0.08, mode: 'shadow' as const },
  history: [
    { day: '2026-11-17', totalBytes: 1073741824, billableBytes: 536870912 },
    { day: '2026-11-18', totalBytes: 1610612736, billableBytes: 1073741824 },
  ],
}

/** The same call for a plain member: the server strips the breakdown. */
const MEMBER_STORAGE = {
  totalBytes: 1610612736,
  billableBytes: 1073741824,
  limitBytes: 5368709120,
  projectCount: 2,
  percentUsed: 30,
  isOverLimit: false,
  lastCalculatedAt: null,
}

let storagePayload: any = OWNER_STORAGE

mock.module('../../../lib/api', () => ({
  api: {
    getWorkspaceInstance: async () => null,
    getWorkspaceMetrics: async () => null,
    getWorkspaceStorage: async () => storagePayload,
  },
}))

afterEach(cleanup)
beforeEach(() => {
  storagePayload = OWNER_STORAGE
})

const { ComputeTab } = await import('../ComputeTab')

describe('Settings → Compute — storage breakdown', () => {
  test('renders the category split, per-project bytes, the trend and the shadow estimate', async () => {
    const { findByText, getAllByText, getByText, queryByText } = render(<ComputeTab />)

    await findByText('Storage breakdown')

    // Category rows, with the overhead category labelled as never billed.
    expect(getByText('Project files')).toBeTruthy()
    expect(getByText('Git repos & LFS')).toBeTruthy()
    expect(getByText('Sync quarantine (not billed)')).toBeTruthy()
    expect(getAllByText('1.0 GB').length).toBeGreaterThan(0)
    expect(getAllByText('512 MB').length).toBeGreaterThan(0)
    expect(getAllByText('2 MB').length).toBeGreaterThan(0)

    // Per-project attribution, hidden projects grouped as System.
    expect(getByText('By project')).toBeTruthy()
    expect(getByText('Marketing site')).toBeTruthy()
    expect(getByText('System')).toBeTruthy()

    // 30-day trend and the unmeasured namespace.
    expect(getByText('Last 30 days')).toBeTruthy()
    expect(getByText(/Not measured: METAL_SNAP_BUCKET/)).toBeTruthy()

    // Month-to-date: GB-months over the allowance, and shadow is labelled as an
    // estimate so nobody reads it as money already taken.
    expect(getByText('This month so far')).toBeTruthy()
    expect(getByText('$0.08')).toBeTruthy()
    expect(getByText(/0.50 GB-mo above your allowance/)).toBeTruthy()
    expect(getByText(/estimate, not yet charged/)).toBeTruthy()

    // A member's payload must not reach the breakdown.
    cleanup()
    storagePayload = MEMBER_STORAGE
    const member = render(<ComputeTab />)
    await waitFor(() => expect(member.queryByText('Storage breakdown')).toBeNull())
    expect(queryByText('By project')).toBeNull()
  })
})
