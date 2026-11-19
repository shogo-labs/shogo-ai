// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-423 — the admin workspace directory carries each workspace's storage.
 *
 * QA round 1 flagged the missing column: `listWorkspaceStorage` and
 * `GET /api/admin/storage?view=workspaces` shipped but nothing rendered them.
 * This pins the wiring — the page reads the storage view (not the generated
 * workspace list), shows bytes against the allowance, and clicking the header
 * re-requests sorted by bytes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import * as ReactNativeWeb from 'react-native-web'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'

const sharedUiRequire = createRequire(
  resolvePath(import.meta.dir, '../../../../../packages/shared-ui/src/noop.js'),
)
mock.module('react-native', () => ReactNativeWeb)
mock.module(sharedUiRequire.resolve('react-native'), () => ReactNativeWeb)

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}))

mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useLocalSearchParams: () => ({}),
  Link: () => null,
}))

const requested: URL[] = []

const PAGE = {
  workspaces: [
    {
      workspaceId: 'ws-1',
      name: 'Acme',
      slug: 'acme',
      instanceSize: 'small',
      createdAt: '2026-11-01T00:00:00.000Z',
      counts: { members: 3, projects: 2, subscriptions: 1 },
      storage: {
        totalBytes: 1572864,
        billableBytes: 1048576,
        allowanceBytes: 3145728,
        percentUsed: 50,
      },
    },
    {
      workspaceId: 'ws-2',
      name: 'Over',
      slug: 'over',
      instanceSize: 'micro',
      createdAt: '2026-10-01T00:00:00.000Z',
      counts: { members: 1, projects: 1, subscriptions: 0 },
      storage: {
        totalBytes: 4194304,
        billableBytes: 4194304,
        allowanceBytes: 1048576,
        percentUsed: 100,
      },
    },
  ],
  total: 2,
  page: 1,
  limit: 20,
}

beforeEach(() => {
  requested.length = 0
  globalThis.fetch = (async (input: any) => {
    requested.push(new URL(String(typeof input === 'string' ? input : input.url)))
    return { ok: true, json: async () => ({ ok: true, data: PAGE }) }
  }) as any
})

afterEach(cleanup)

const { default: AdminWorkspacesPage } = await import('../workspaces/index')

describe('admin workspace directory — storage column', () => {
  test('lists workspaces with their storage, sorted by the storage view', async () => {
    const { getByText, getAllByText } = render(<AdminWorkspacesPage />)

    await waitFor(() => expect(getByText('Acme')).toBeTruthy())

    const first = requested[0]
    expect(first.pathname).toBe('/api/admin/storage')
    expect(first.searchParams.get('view')).toBe('workspaces')
    expect(first.searchParams.get('sort')).toBe('created')

    // Bytes against the instance allowance, and the over-allowance amount.
    expect(getByText(/1\.5 MB/)).toBeTruthy()
    expect(getByText('+3.0 MB over')).toBeTruthy()
    expect(getAllByText(/4\.0 MB/).length).toBeGreaterThan(0)

    fireEvent.click(getByText('Storage'))
    await waitFor(() =>
      expect(requested.some((url) => url.searchParams.get('sort') === 'bytes')).toBe(true),
    )

    fireEvent.click(getByText('Storage'))
    await waitFor(() =>
      expect(
        requested.some(
          (url) =>
            url.searchParams.get('sort') === 'bytes' && url.searchParams.get('order') === 'asc',
        ),
      ).toBe(true),
    )
  })
})
