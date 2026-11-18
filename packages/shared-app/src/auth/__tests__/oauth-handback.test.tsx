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
  /** What `/sign-in/social` hands back; defaults to a Google authorize URL. */
  redirectUrl?: string
  /** `false` models a response that carried no provider redirect at all. */
  redirect?: boolean
  /** Hold every social call until the test releases it. */
  gate?: Promise<void>
}) {
  const state = { cookieStored: opts.cookieStored, sessionReads: 0, socialCalls: 0 }
  return {
    state,
    getSession: async () => {
      state.sessionReads += 1
      return { data: state.cookieStored ? { user: USER } : null }
    },
    signIn: {
      social: async () => {
        state.socialCalls += 1
        if (opts.gate) await opts.gate
        if (opts.socialThrows) throw opts.socialThrows
        if (opts.socialError) return { data: null, error: opts.socialError }
        // A successful round trip: the browser closed, no user in the payload.
        return {
          data: {
            url: opts.redirectUrl ?? 'https://accounts.google.com/o/oauth2/auth',
            redirect: opts.redirect ?? true,
          },
          error: null,
        }
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
  props: { socialSignInNavigatesPage?: boolean } = {},
) {
  const seen: { user: unknown; isLoading: boolean; signInWithGoogle: () => Promise<void>; signInWithApple: (p: any) => Promise<void>; signIn: (e: string, p: string) => Promise<void> } = {
    user: undefined,
    isLoading: true,
    signInWithGoogle: async () => {},
    signInWithApple: async () => {},
    signIn: async () => {},
  }
  function Probe() {
    const auth = useAuth()
    seen.user = auth.user
    seen.isLoading = auth.isLoading
    seen.signInWithGoogle = auth.signInWithGoogle as any
    seen.signInWithApple = auth.signInWithApple as any
    seen.signIn = auth.signIn
    return null
  }
  render(
    <AuthProvider authClient={authClient} onAuthError={onAuthError} {...props}>
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

describe('Google sign-in on the web build', () => {
  /**
   * On web the client sets `window.location.href` and the page leaves. The
   * promise still resolves first, so a session read here runs before Google is
   * contacted — that race reported `session_missing` on every tap, successful
   * ones included (SHO-430: 27 events on studio.shogo.ai).
   */
  it('does not read the session (or report) once the page is navigating away', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false })
    const probe = await renderProvider(
      client,
      (error, context) => errors.push({ error, context }),
      { socialSignInNavigatesPage: true },
    )
    const readsAfterMount = client.state.sessionReads

    await act(async () => { await probe.signInWithGoogle() })

    expect(client.state.sessionReads).toBe(readsAfterMount)
    expect(errors).toEqual([])
  })

  it('reports a redirect the browser cannot follow instead of silently staying put', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, redirectUrl: '/api/auth/sign-in/google' })
    const probe = await renderProvider(
      client,
      (error, context) => errors.push({ error, context }),
      { socialSignInNavigatesPage: true },
    )

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'sign_in' })
    expect((errors[0].error as Error).message).toContain('cannot follow')
  })

  it('still reports session_missing when no redirect was issued at all', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, redirect: false })
    const probe = await renderProvider(
      client,
      (error, context) => errors.push({ error, context }),
      { socialSignInNavigatesPage: true },
    )

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'session_missing' })
  })
})

describe('one social sign-in at a time', () => {
  /**
   * A second tap while the sheet is opening dismisses the first session on
   * Android (`dismissAuthSession()` in the Expo plugin) and throws
   * `WebBrowserAlreadyOpen` on iOS. Either way the first round trip dies with
   * no cookie, which is what the 0.3 s "no session" events on iOS looked like.
   */
  it('ignores a second tap while the first round trip is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = fakeAuthClient({ cookieStored: true, gate })
    const probe = await renderProvider(client)

    await act(async () => {
      const first = probe.signInWithGoogle()
      void probe.signInWithGoogle()
      release()
      await first
    })

    await waitFor(() => expect(probe.user).toEqual(USER))
    expect(client.state.socialCalls).toBe(1)
    expect(probe.isLoading).toBe(false)
  })

  it('lets a later tap through once the first one has finished', async () => {
    const client = fakeAuthClient({ cookieStored: true })
    const probe = await renderProvider(client)

    await act(async () => { await probe.signInWithGoogle() })
    await act(async () => { await probe.signInWithGoogle() })

    expect(client.state.socialCalls).toBe(2)
  })
})

describe('session read at start-up', () => {
  it('retries a failed read once instead of showing the person as signed out', async () => {
    let reads = 0
    const client = {
      getSession: async () => {
        reads += 1
        if (reads === 1) throw new Error('network down')
        return { data: { user: USER } }
      },
      signIn: { email: async () => ({ data: null, error: null }), social: async () => ({ data: null }) },
      signUp: { email: async () => ({ data: null }) },
      signOut: async () => ({ data: null }),
    } as any
    const probe = await renderProvider(client)

    await waitFor(() => expect(probe.user).toEqual(USER), { timeout: 2000 })
    expect(reads).toBe(2)
    expect(probe.isLoading).toBe(false)
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
