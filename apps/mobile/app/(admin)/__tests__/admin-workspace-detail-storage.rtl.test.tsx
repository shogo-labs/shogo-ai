// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-423 — the admin workspace detail page shows the workspace's storage
 * footprint.
 *
 * It reads `GET /api/admin/storage?workspaceId=…`, not the generated
 * `GET /api/admin/workspaces/:id` include, because that include takes an
 * unordered `take: 50` of `storageUsageDaily` — after 50 days it silently shows
 * the *oldest* rows. This test fails if the page reverts to the include: the
 * storage request disappears and the card falls back to "Storage data
 * unavailable."
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

import * as ReactNativeWeb from 'react-native-web'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'

/**
 * `react-native` resolves to two copies in this monorepo — one for `apps/mobile`
 * and a second for `packages/shared-ui` — and `mock.module` keys on the resolved
 * file, so a bare specifier only covers this app's copy.
 */
const sharedUiRequire = createRequire(
  resolvePath(import.meta.dir, '../../../../../packages/shared-ui/src/noop.js'),
)
mock.module('react-native', () => ReactNativeWeb)
mock.module(sharedUiRequire.resolve('react-native'), () => ReactNativeWeb)

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))

const router = { replace: () => {} }
mock.module('expo-router', () => ({
  useLocalSearchParams: () => ({ workspaceId: 'ws-1' }),
  useRouter: () => router,
  Link: () => null,
}))

mock.module('../../../lib/api', () => ({ API_URL: 'http://api.test' }))

const requested: string[] = []

const WORKSPACE = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  description: null,
  instanceSize: 'small',
  ssoSettings: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  members: [],
  projects: [],
  subscriptions: [],
  apiKeys: [],
  instanceSubscription: null,
}

/** `StorageUsageDetail` from `getStorageUsage(id, { detail: true })`. */
const STORAGE = {
  totalBytes: 1572864,
  billableBytes: 1048576,
  limitBytes: 3145728,
  projectCount: 2,
  percentUsed: 50,
  isOverLimit: false,
  lastCalculatedAt: '2026-11-18T12:00:00.000Z',
  categories: { project_files: 1048576, repo: 524288, quarantine: 0 },
  projects: [
    { projectId: 'p-1', projectName: 'Marketing site', hidden: false, bytes: 1048576 },
    { projectId: 'p-2', projectName: null, hidden: true, bytes: 524288 },
  ],
  unmeasured: [],
  month: { billableGbMonths: 0.03, estimatedUsd: 0.01, mode: 'shadow' as const },
  history: [
    {
      day: '2026-11-17',
      totalBytes: 1048576,
      billableBytes: 1048576,
      allowanceBytes: 3145728,
      chargedUsd: null,
      billedAt: null,
    },
    {
      day: '2026-11-18',
      totalBytes: 1572864,
      billableBytes: 1048576,
      allowanceBytes: 3145728,
      chargedUsd: null,
      billedAt: null,
    },
  ],
}

const ok = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) })

beforeEach(() => {
  requested.length = 0
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url)
    requested.push(url)
    if (url.includes('/api/admin/storage')) return ok(STORAGE)
    if (url.includes('/api/admin/workspace-grants')) {
      return ok({ workspaceGrants: [], total: 0, page: 1, limit: 50 })
    }
    if (url.includes('/api/admin/workspaces/ws-1')) return ok(WORKSPACE)
    return { ok: false, status: 404, json: async () => ({}) }
  }) as any
})

afterEach(cleanup)

const { default: AdminWorkspaceDetailPage } = await import('../workspaces/[workspaceId]')

describe('admin workspace detail — storage', () => {
  test('renders the storage footprint from the ordered admin storage view', async () => {
    const { getAllByText, getByText, queryByText } = render(<AdminWorkspaceDetailPage />)

    await waitFor(() => expect(getByText('Marketing site')).toBeTruthy())

    expect(requested.some((url) => url.includes('/api/admin/storage?workspaceId=ws-1'))).toBe(true)
    expect(queryByText('Storage data unavailable.')).toBeNull()

    // Totals, allowance and the overhead-excluding billable figure. The day
    // rows repeat these figures, so assert presence rather than uniqueness.
    expect(getAllByText('1.5 MB').length).toBeGreaterThan(0) // total + newest day
    expect(getAllByText('1.0 MB').length).toBeGreaterThan(0) // billable + previous day
    expect(getByText('3.0 MB')).toBeTruthy() // allowance
    expect(getByText('0 B')).toBeTruthy() // over allowance
    expect(getByText(/50% of allowance/)).toBeTruthy()

    // Category split, per-project attribution and the daily history.
    expect(getByText('Project files')).toBeTruthy()
    expect(getByText('Repositories')).toBeTruthy()
    expect(getByText('Hidden project')).toBeTruthy()
    expect(getByText('2026-11-18')).toBeTruthy()
    expect(getByText('2026-11-17')).toBeTruthy()
    expect(queryByText('No daily history yet.')).toBeNull()
  })

  test('says so when the storage endpoint returns nothing', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === 'string' ? input : input.url)
      requested.push(url)
      if (url.includes('/api/admin/storage')) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      if (url.includes('/api/admin/workspace-grants')) {
        return ok({ workspaceGrants: [], total: 0, page: 1, limit: 50 })
      }
      return ok(WORKSPACE)
    }) as any

    const { getByText } = render(<AdminWorkspaceDetailPage />)

    await waitFor(() => expect(getByText('Storage data unavailable.')).toBeTruthy())
  })
})
