// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The OAuth hand-back, and the failures that used to be silent (SHO-414).
 *
 * `signIn.social` on native resolves *after* `@better-auth/expo` has opened the
 * browser and written the session cookie from the `?cookie=` deep link. When
 * that hand-back breaks, the call still resolves without a user and the next
 * `getSession()` is anonymous — no throw, no error state, nothing in Sentry.
 * These tests pin both halves: the user is set when the cookie is there, and
 * `onAuthError` fires with `session_missing` when it is not.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import { AuthProvider, useAuth, type AuthErrorContext } from '../AuthProvider'

installHappyDom()

afterAll(() => restoreHappyDom())
// Let React's scheduler drain while the DOM still exists: a task that fires
// after `restoreHappyDom()` throws `window is not defined` and fails the file.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
})

const USER = { id: 'user-1', email: 'user@example.com', name: 'User One' }

/**
 * Stands in for the Expo client plugin: `signIn.social` resolves with the
 * provider redirect (never a user), and the session only exists once the
 * hand-back has written the cookie.
 */
function fakeAuthClient(opts: {
  cookieStored: boolean
  socialError?: { message: string }
  socialThrows?: Error
}) {
  const state = { cookieStored: opts.cookieStored }
  return {
    state,
    getSession: async () => ({ data: state.cookieStored ? { user: USER } : null }),
    signIn: {
      social: async () => {
        if (opts.socialThrows) throw opts.socialThrows
        if (opts.socialError) return { data: null, error: opts.socialError }
        // A successful round trip: the browser closed, no user in the payload.
        return { data: { url: 'https://accounts.google.com/o/oauth2/auth', redirect: true }, error: null }
      },
      email: async () => ({ data: { user: USER }, error: null }),
    },
    signUp: { email: async () => ({ data: { user: USER }, error: null }) },
    signOut: async () => ({ data: null }),
  } as any
}

async function renderProvider(
  authClient: any,
  onAuthError?: (error: unknown, context: AuthErrorContext) => void,
) {
  const seen: { user: unknown; signInWithGoogle: () => Promise<void>; signInWithApple: (p: any) => Promise<void>; signIn: (e: string, p: string) => Promise<void> } = {
    user: undefined,
    signInWithGoogle: async () => {},
    signInWithApple: async () => {},
    signIn: async () => {},
  }
  function Probe() {
    const auth = useAuth()
    seen.user = auth.user
    seen.signInWithGoogle = auth.signInWithGoogle as any
    seen.signInWithApple = auth.signInWithApple as any
    seen.signIn = auth.signIn
    return null
  }
  render(
    <AuthProvider authClient={authClient} onAuthError={onAuthError}>
      <Probe />
    </AuthProvider>,
  )
  // Drain the provider's initial `getSession()` inside act().
  await act(async () => {})
  return seen
}

describe('Google sign-in hand-back', () => {
  it('signs the user in when the hand-back stored the session cookie', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: true })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    await waitFor(() => expect(probe.user).toEqual(USER))
    expect(errors).toEqual([])
  })

  it('reports session_missing when the round trip succeeds but no session arrives', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(probe.user).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'session_missing' })
    expect((errors[0].error as Error).message).toContain('without a session')
  })

  it('reports a provider error with the google provider tag', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, socialError: { message: 'access_denied' } })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'sign_in' })
  })

  it('reports a thrown provider exception with the google provider tag', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, socialThrows: new Error('browser unavailable') })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'sign_in' })
  })
})

describe('Apple sign-in', () => {
  it('reports session_missing when the id-token exchange leaves no session', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithApple({ idToken: 'token' }).catch(() => {}) })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'apple', stage: 'session_missing' })
  })
})

describe('email sign-in', () => {
  it('reports a server fault with the email provider tag', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false })
    // A 5xx is a fault. An expected rejection (401 wrong password, 422 blocked
    // sign-up) is not and must stay out of `onAuthError` — see auth-error.test.tsx.
    client.signIn.email = async () => ({ data: null, error: { message: 'Internal server error', status: 500 } })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signIn('user@example.com', 'nope').catch(() => {}) })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'email', stage: 'sign_in' })
  })
})
