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

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import { AuthProvider, MIN_NATIVE_OAUTH_SHEET_MS, useAuth, type AuthErrorContext } from '../AuthProvider'
import { AuthRequestError } from '../auth-error'

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
 * The provider times the native sheet with `Date.now()`. This clock stands in
 * for the wall time the sheet was open: the fake client advances it, so a test
 * can say "the sheet was up for 300 ms" without waiting 300 ms.
 */
let now = 0
let nowSpy: { mockRestore: () => void } | undefined

beforeEach(() => {
  now = 1_000_000
  nowSpy = spyOn(Date, 'now').mockImplementation(() => now) as any
})

afterEach(() => {
  nowSpy?.mockRestore()
  nowSpy = undefined
})

/**
 * Stands in for the Expo client plugin: `signIn.social` resolves with the
 * provider redirect (never a user), and the session only exists once the
 * hand-back has written the cookie.
 */
function fakeAuthClient(opts: {
  cookieStored: boolean
  socialError?: { message: string; status?: number; statusText?: string }
  socialThrows?: Error
  /** What `/sign-in/social` hands back; defaults to a Google authorize URL. */
  redirectUrl?: string
  /** `false` models a response that carried no provider redirect at all. */
  redirect?: boolean
  /** Hold every social call until the test releases it. */
  gate?: Promise<void>
  /**
   * How long the browser sheet stays up, in ms. Defaults to a round trip a
   * person actually finished; `300` is the App Review crawler's dismissal.
   */
  sheetMs?: number
  /**
   * The hand-back verdict the native client stamps on the result (SHO-527).
   * Omitted models a client that does not report it (web, an older binary).
   */
  nativeHandback?: 'none' | 'received'
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
        now += opts.sheetMs ?? 12_000
        if (opts.socialThrows) throw opts.socialThrows
        if (opts.socialError) return { data: null, error: opts.socialError }
        // A successful round trip: the browser closed, no user in the payload.
        return {
          data: {
            url: opts.redirectUrl ?? 'https://accounts.google.com/o/oauth2/auth',
            redirect: opts.redirect ?? true,
            ...(opts.nativeHandback ? { nativeHandback: opts.nativeHandback } : {}),
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
  const seen: { user: unknown; isLoading: boolean; error: string | null; signInWithGoogle: () => Promise<void>; signInWithApple: (p: any) => Promise<void>; signIn: (e: string, p: string) => Promise<void> } = {
    user: undefined,
    isLoading: true,
    error: null,
    signInWithGoogle: async () => {},
    signInWithApple: async () => {},
    signIn: async () => {},
  }
  function Probe() {
    const auth = useAuth()
    seen.user = auth.user
    seen.isLoading = auth.isLoading
    seen.error = auth.error
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

  /**
   * SHO-527: a provider failure used to reach `onAuthError` as the raw object
   * Better Fetch rolled, so 1Z grouped as "Object captured as exception with
   * keys: status, statusText" and a 4xx the API answered on purpose was
   * reported as a defect. Wrapping it in `AuthRequestError` keeps the status
   * (tagged by the host) and lets `shouldReportAuthError` apply.
   */
  it('keeps the status of a provider failure so it is tagged, and reports a 5xx', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({
      cookieStored: false,
      socialError: { message: 'Object captured as exception', status: 504, statusText: 'Gateway Timeout' },
    })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'sign_in' })
    expect(errors[0].error).toBeInstanceOf(AuthRequestError)
    expect((errors[0].error as AuthRequestError).status).toBe(504)
    expect(probe.error).toBe('Object captured as exception')
  })

  it('does not report a 4xx the API answered with, but still tells the person', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({
      cookieStored: false,
      socialError: { message: 'Invalid provider', status: 422, statusText: 'Unprocessable Entity' },
    })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toEqual([])
    expect(probe.error).toBe('Invalid provider')
  })

  it('reports a thrown provider exception with the google provider tag', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, socialThrows: new Error('browser unavailable') })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'sign_in' })
  })

  /**
   * The iOS events SHO-430 was carded for carry `session_missing` with a 0.3 s
   * wait between the POST and the `get-session`. That gap is the whole sheet
   * round trip, so the sheet was dismissed — `ASWebAuthenticationSession`
   * resolves `{ type: 'cancel' }`, the Expo plugin returns from its `onSuccess`
   * hook without touching the response, and `signIn.social` resolves as if the
   * hand-back had run. A dismissal is not a broken hand-back, and it must not
   * reach Sentry as one.
   */
  it('treats a sub-second native round trip as a dismissal: no report, told to try again', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, sheetMs: 300 })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))
    const readsAfterMount = client.state.sessionReads

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toEqual([])
    expect(probe.user).toBeNull()
    // Nothing to read a session for: the round trip never happened.
    expect(client.state.sessionReads).toBe(readsAfterMount)
    expect(probe.error).toContain('closed before it finished')
  })

  it('reports session_missing only once the sheet stayed up, and says so on screen', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, sheetMs: MIN_NATIVE_OAUTH_SHEET_MS + 1 })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'session_missing' })
    expect(probe.error).toContain('without a session')
  })

  /**
   * SHO-527: Play's pre-launch report robot taps Continue with Google, looks at
   * Google's screen for 2–24 s and backs out. No hand-back ever reaches the app,
   * so the client stamps `nativeHandback: 'none'` — a dismissal, however long
   * the sheet was up. Reporting it as `session_missing` was all 62 events on
   * SHOGO-ANDROID-1W.
   */
  it("treats a closed sheet with no hand-back as a dismissal, even after 10 s: no report, told to try again", async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, sheetMs: 10_000, nativeHandback: 'none' })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))
    const readsAfterMount = client.state.sessionReads

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toEqual([])
    expect(probe.user).toBeNull()
    expect(client.state.sessionReads).toBe(readsAfterMount)
    expect(probe.error).toContain('closed before it finished')
  })

  it('reports session_missing when the hand-back reached the app but no session did', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, sheetMs: 300, nativeHandback: 'received' })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithGoogle() })

    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'google', stage: 'session_missing' })
    expect(probe.error).toContain('without a session')
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
    expect(probe.error).toContain('without a session')
  })

  it('reports a rejected exchange exactly once', async () => {
    const errors: Array<{ error: unknown; context: AuthErrorContext }> = []
    const client = fakeAuthClient({ cookieStored: false, socialError: { message: 'invalid_grant' } })
    const probe = await renderProvider(client, (error, context) => errors.push({ error, context }))

    await act(async () => { await probe.signInWithApple({ idToken: 'token' }).catch(() => {}) })

    // Pre-existing on main: the error branch reported, then rethrew into the
    // catch, which reported the same failure again (SHO-430 QA round 1).
    expect(errors).toHaveLength(1)
    expect(errors[0].context).toEqual({ provider: 'apple', stage: 'sign_in' })
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
