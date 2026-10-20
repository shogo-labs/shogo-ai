// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance spec for SHO-83 — the emailed invitation link
 * (`/invitations/<id>/accept`) and the `+not-found` catch-all.
 *
 * The card's criteria 1, 2, 4, 5, 6 and 8 are about what the invitee *sees*
 * before and after signing in, so this drives the real route component under
 * happy-dom with the auth/domain seams mocked — the same component the web
 * export serves (criterion 7 is verified against the actual `expo export`
 * output; see the PR thread).
 *
 * Run: cd apps/mobile && bun --no-env-file ../../scripts/run-tests-isolated.ts \
 *        . --roots test
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: any) => createElement('div', props, children),
}))

const routerReplace = mock((_target: unknown) => {})
mock.module('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace, push: mock(() => {}), back: mock(() => {}) }),
  useLocalSearchParams: () => params,
}))

mock.module('@shogo/shared-ui/primitives', () => ({
  Button: ({ children, onPress, disabled, variant, ...props }: any) =>
    createElement(
      'button',
      {
        ...props,
        type: 'button',
        'data-variant': variant,
        disabled: !!disabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    ),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

let params: Record<string, unknown> = { id: 'inv-1' }
let authState = { isAuthenticated: false, isLoading: false, user: null as any, signOut: mock(async () => {}) }
mock.module('../../contexts/auth', () => ({ useAuth: () => authState }))

const acceptInvitation = mock(async (..._args: any[]): Promise<void> => {})
const loadAll = mock(async () => {})
mock.module('../../contexts/domain', () => ({
  DomainProvider: ({ children }: any) => createElement('div', null, children),
  useDomainActions: () => ({ acceptInvitation }),
  useWorkspaceCollection: () => ({ loadAll }),
}))

mock.module('../../lib/api', () => ({ API_URL: 'https://app.test' }))

const pendingInfo = {
  role: 'member',
  status: 'pending',
  expired: false,
  workspaceId: 'ws-1',
  projectId: null as string | null,
  workspaceName: 'Acme',
  projectName: null as string | null,
}

let nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true, data: pendingInfo } }
const fetchCalls: string[] = []

globalThis.fetch = (async (input: any) => {
  fetchCalls.push(String(input))
  return new Response(JSON.stringify(nextResponse.body), {
    status: nextResponse.status,
    headers: { 'Content-Type': 'application/json' },
  })
}) as unknown as typeof fetch

const { default: InvitationAcceptScreen } = await import('../../app/invitations/[id]/accept')
const { default: NotFoundScreen } = await import('../../app/+not-found')

beforeEach(() => {
  params = { id: 'inv-1' }
  authState = { isAuthenticated: false, isLoading: false, user: null, signOut: mock(async () => {}) }
  acceptInvitation.mockClear()
  loadAll.mockClear()
  routerReplace.mockClear()
  fetchCalls.length = 0
  nextResponse = { status: 200, body: { ok: true, data: { ...pendingInfo } } }
})

afterEach(() => {
  cleanup()
})

const signedIn = (id = 'user-1') => {
  authState = {
    isAuthenticated: true,
    isLoading: false,
    user: { id, email: 'invitee@example.com' },
    signOut: mock(async () => {}),
  }
}

describe('SHO-83 — /invitations/[id]/accept renders instead of "Unmatched Route"', () => {
  test('criterion 1: signed out, the invitation is shown with Sign in — never a blank screen', async () => {
    render(createElement(InvitationAcceptScreen))

    expect(await screen.findByText(/you've been invited/i)).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText(/an Editor/)).toBeTruthy()
    expect(screen.getByText(/sign in to accept this invitation/i)).toBeTruthy()
    // It loaded the invitation from the public info endpoint on the app origin.
    expect(fetchCalls).toEqual(['https://app.test/api/invitations/inv-1/info'])
    // No accept button before sign-in — the accept path needs a session.
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull()
  })

  test('criterion 2: Sign in deep-links back to the same URL, so accepting resumes here', async () => {
    render(createElement(InvitationAcceptScreen))
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /^sign in$/i }))

    expect(routerReplace).toHaveBeenCalledWith({
      pathname: '/(auth)/sign-in',
      params: { next: '/invitations/inv-1/accept' },
    })
  })

  test('criterion 6: an unknown id says "This invitation no longer exists"', async () => {
    nextResponse = { status: 404, body: { error: { code: 'not_found', message: 'Invitation not found' } } }
    render(createElement(InvitationAcceptScreen))

    expect(await screen.findByText(/this invitation no longer exists/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull()
    expect(screen.getByRole('button', { name: /go to dashboard/i })).toBeTruthy()
  })

  test('criterion 6: a link with no id never fetches and does not dead-end', async () => {
    params = {}
    render(createElement(InvitationAcceptScreen))

    expect(await screen.findByText(/this invitation no longer exists/i)).toBeTruthy()
    expect(fetchCalls).toEqual([])
  })

  test('criterion 5: an expired invitation has no accept button and no crash', async () => {
    nextResponse = {
      status: 200,
      body: { ok: true, data: { ...pendingInfo, expired: true } },
    }
    signedIn()
    render(createElement(InvitationAcceptScreen))

    expect(await screen.findByText(/this invitation has expired/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  test('criterion 5: an already-accepted invitation is not offered again', async () => {
    nextResponse = {
      status: 200,
      body: { ok: true, data: { ...pendingInfo, status: 'accepted' } },
    }
    signedIn()
    render(createElement(InvitationAcceptScreen))

    expect(await screen.findByText(/already been used/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull()
    expect(acceptInvitation).not.toHaveBeenCalled()
  })

  test('criterion 4: signed in as a different account — clear message, Sign out, nothing accepted', async () => {
    signedIn('someone-else')
    acceptInvitation.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Access denied'), { status: 403, code: 'FORBIDDEN' })
    })
    render(createElement(InvitationAcceptScreen))
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /accept invitation/i }))

    expect(
      await screen.findByText(/this invitation was sent to a different email address/i),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull()
    expect(loadAll).not.toHaveBeenCalled()
    // The invited address is never printed — the info payload has no email.
    expect(document.body.textContent).not.toContain('@example.com')
  })

  test('criterion 3: accepting runs the shared domain action with the invited role, then lands in the app', async () => {
    signedIn()
    render(createElement(InvitationAcceptScreen))
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /accept invitation/i }))

    expect(await screen.findByText(/you're in!/i)).toBeTruthy()
    expect(acceptInvitation).toHaveBeenCalledTimes(1)
    expect(acceptInvitation.mock.calls[0]).toEqual([
      'inv-1',
      'user-1',
      { workspaceId: 'ws-1', role: 'member', projectId: undefined },
    ])
    // The new workspace has to be in the collection before `/` renders.
    expect(loadAll).toHaveBeenCalled()
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/'), { timeout: 4000 })
  })

  test('criterion 3: acceptance is delegated to the one accept path — no hand-rolled PATCH/POST', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'app', 'invitations', '[id]', 'accept.tsx'),
      'utf8',
    )
    // Comments explain why not to hand-roll it; only the code matters here.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toContain('acceptInvitation(')
    expect(code).not.toMatch(/\/api\/members/)
    expect(code).not.toMatch(/method:\s*['"]PATCH['"]/)
    expect(code).not.toMatch(/method:\s*['"]POST['"]/)
  })

  test('criterion 8: +not-found renders for an arbitrary unknown path', async () => {
    render(createElement(NotFoundScreen))

    expect(screen.getByText(/this link doesn't exist or has expired/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /go to dashboard/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
  })

  test('criterion 8: +not-found hides Sign in once signed in', async () => {
    signedIn()
    render(createElement(NotFoundScreen))

    expect(screen.getByRole('button', { name: /go to dashboard/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })
})
