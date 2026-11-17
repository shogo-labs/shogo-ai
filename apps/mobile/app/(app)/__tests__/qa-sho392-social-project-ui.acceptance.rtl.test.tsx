// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-392 acceptance — the Social page's project UI.
 *
 * Two bugs this covers, both invisible to CI's mobile typecheck because
 * `packages/sdk/dist` is not built in a worktree, so `@shogo-ai/sdk` resolves
 * to `any` and every shape mistake type-checks:
 *
 *  1. `call()` returned the whole `{ data, status, headers }` wrapper, so every
 *     list on the screen (`accounts`, `automations`, `conversations`, …) read
 *     `undefined` and rendered empty.
 *  2. The project list read `projectRes.items` instead of `projectRes.data.items`,
 *     so the "Connect for" picker had no projects in it.
 *
 * The fake `http` below answers with the real `ShogoResponse` shape, so either
 * mistake fails here.
 */

import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const WS = 'ws-1'

const accounts = [
  {
    id: 'acc-shared',
    platform: 'instagram',
    username: 'brand',
    projectId: null,
    isActive: true,
    needsReconnect: false,
  },
  {
    id: 'acc-engage',
    platform: 'instagram',
    username: 'engage',
    projectId: 'p1',
    isActive: true,
    needsReconnect: false,
  },
]

const projects = [
  { id: 'p1', name: 'Engage' },
  { id: 'p2', name: 'Website' },
]

/** Every request the screen made, so a test can assert the body it sent. */
const calls: Array<{ path: string; method: string; body: any }> = []

const http = {
  request: mock(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: init?.body })
    const ok = (data: unknown) => ({ data, status: 200, headers: new Headers() })

    if (path.endsWith('/social/accounts/sync')) return ok({ accounts })
    if (path.endsWith('/social/accounts')) return ok({ accounts })
    if (path.includes('/social/automations')) return ok({ automations: [] })
    if (path.includes('/social/analytics')) return ok({})
    if (path.startsWith('/api/projects')) return ok({ ok: true, items: projects, total: 2 })
    if (path.includes('/social/accounts/')) return ok({ account: accounts[0] })
    return ok({})
  }),
}

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    // `accessibilityLabel` is a native prop; on the DOM shim it has to become
    // `aria-label` for `getByLabelText` to find it.
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        'button',
        { ...props, 'aria-label': accessibilityLabel, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)
mock.module('expo-router', () => ({
  useFocusEffect: (cb: () => void) => useEffect(cb, []),
}))
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: any) => createElement('div', props, children),
}))
mock.module('@shogo/ui-kit/platform', () => ({
  openAuthFlow: async () => {},
  preCreateAuthWindow: () => null,
}))
mock.module('lucide-react-native', () => {
  const Icon = () => null
  // Bun's `mock.module` needs real named exports, so list the ones this screen
  // imports rather than proxying.
  return {
    CalendarDays: Icon,
    CheckCheck: Icon,
    Facebook: Icon,
    Instagram: Icon,
    MessageCircle: Icon,
    Music2: Icon,
    Pause: Icon,
    Play: Icon,
    RefreshCw: Icon,
    Send: Icon,
    Trash2: Icon,
    Workflow: Icon,
  }
})
mock.module(resolve(import.meta.dir, '../../../components/layout/PhoneBackButton'), () => ({
  PhoneBackButton: () => null,
}))
mock.module(resolve(import.meta.dir, '../../../contexts/domain'), () => ({
  useDomainHttp: () => http,
}))
mock.module(resolve(import.meta.dir, '../../../hooks/useActiveWorkspace'), () => ({
  useActiveWorkspace: () => ({ id: WS }),
}))

const { default: SocialScreen } = await import('../social')

beforeEach(() => {
  cleanup()
  calls.length = 0
  http.request.mockClear()
})

describe('SHO-392 — the Social page shows projects and accounts', () => {
  test('the project list is read from the response body, not the wrapper', async () => {
    render(createElement(SocialScreen))

    // The picker is built from `GET /api/projects`; with `projectRes.items` it
    // was always empty and no project chip ever rendered.
    expect(await screen.findByLabelText('Connect for Engage')).toBeTruthy()
    expect(screen.getByLabelText('Connect for Website')).toBeTruthy()
    expect(screen.getByLabelText('Connect for Workspace (shared)')).toBeTruthy()
  })

  test('accounts are listed, grouped by owner', async () => {
    render(createElement(SocialScreen))

    // Both accounts come from `GET /social/accounts`; with `call()` returning
    // the wrapper this list was empty and the screen said "No accounts
    // connected yet".
    expect(await screen.findByText('instagram @brand')).toBeTruthy()
    expect(screen.getByText('instagram @engage')).toBeTruthy()
    expect(screen.getByText('Shared with the workspace')).toBeTruthy()
    expect(screen.queryByText('No accounts connected yet')).toBeNull()
  })

  test('"Move to" sends the project id to the PATCH route', async () => {
    render(createElement(SocialScreen))
    await screen.findByText('instagram @brand')

    // The shared account's move targets are the projects; the project-owned
    // account offers "Workspace (shared)" instead.
    screen.getByLabelText('Move @brand to Engage').click()

    const patch = calls.find((call) => call.method === 'PATCH')
    expect(patch).toBeTruthy()
    expect(patch!.path).toBe(`/api/workspaces/${WS}/social/accounts/acc-shared`)
    expect(patch!.body).toEqual({ projectId: 'p1' })
  })
})
