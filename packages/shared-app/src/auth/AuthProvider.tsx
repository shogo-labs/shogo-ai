// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared AuthProvider
 *
 * Provides sign-in, sign-up, sign-out actions and user state.
 * Uses Better Auth client for all auth operations.
 * Platform-agnostic (pure React hooks).
 */

import { createContext, useContext, useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AuthClient } from './client'
import { signupFetchOptions } from './signup-device-id'
import { EmailNotVerifiedError, shouldReportAuthError, toAuthRequestError } from './auth-error'

export { EmailNotVerifiedError } from './auth-error'

export interface AuthUser {
  id: string
  name: string
  email: string
  image?: string | null
  createdAt?: string | Date
}

export interface SignUpResult {
  requiresVerification: boolean
}

export interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (
    name: string,
    email: string,
    password: string,
    /**
     * Optional Better Auth `callbackURL` used after the verification email
     * link is clicked. If a caller (e.g. the desktop cloud-login bridge)
     * needs the user to land somewhere other than `/sign-in` post-verify,
     * they can pass an absolute URL here. Defaults to `${origin}/sign-in`.
     */
    opts?: { callbackURL?: string },
  ) => Promise<SignUpResult>
  /**
   * Initiate Google OAuth. Optional `callbackURL` overrides the default
   * post-OAuth landing page (Better Auth bounces the user there once the
   * provider redirects back with a successful auth code). Used by the
   * desktop cloud-login bridge to send the user back to
   * `/auth/cli-link?state=...&userCode=...` so they can finish approving
   * the device-code flow.
   */
  signInWithGoogle: (opts?: { callbackURL?: string }) => void
  /**
   * Sign in with Apple using a native Apple identity token.
   *
   * The caller (mobile app) is responsible for invoking the native
   * `expo-apple-authentication` flow to obtain `idToken` (and optionally
   * a SHA-256 hex `nonce` it generated client-side); this provider stays
   * platform-agnostic and never imports any native module. Backend
   * (better-auth `apple` social provider) verifies issuer / audience /
   * signature against Apple's JWKS.
   */
  signInWithApple: (params: { idToken: string; nonce?: string }) => Promise<void>
  signOut: () => Promise<void>
  updateUser: (fields: { name?: string; image?: string }) => Promise<void>
  refreshSession: () => Promise<void>
  sendVerificationEmail: (email: string, callbackURL?: string) => Promise<void>
  clearError: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Last user the provider rendered, readable without React context.
 *
 * Gluestack renders popover content into a portal host mounted **above**
 * `AuthProvider` (`PortalProvider` sits under `GluestackUIProvider`, the
 * provider tree is below it), so shell chrome that lives inside a popover
 * cannot read this context — a context read there throws and takes the whole
 * shell down. Those surfaces still need to know who is signed in, and the
 * provider is the only thing that does, so it publishes the current user here
 * the same way the domain provider publishes its `getSDKHttpClient()`.
 */
let moduleAuthUser: AuthUser | null = null

/** Derive the current frontend origin (e.g. `http://localhost:8081`) on web. Returns `/` on native. */
function getFrontendOrigin(): string {
  if (typeof document !== 'undefined' && window.location?.protocol?.startsWith('http')) {
    const { protocol, hostname, port } = window.location
    const host = /^192\.168\./.test(hostname) ? 'localhost' : hostname
    return `${protocol}//${host}${port ? `:${port}` : ''}`
  }
  return ''
}

/** Which sign-in path failed, and at which step. */
export interface AuthErrorContext {
  provider: 'google' | 'apple' | 'email'
  /**
   * `sign_in` / `sign_up`: the provider call itself failed.
   * `session_missing`: the provider call reported success but the session
   * cookie never made it to the device, so `getSession()` still has no user.
   * That case used to be silent — it is the one that hid SHO-414.
   */
  stage: 'sign_in' | 'sign_up' | 'session_missing'
}

export interface AuthProviderProps {
  authClient: AuthClient
  children: ReactNode
  /**
   * Called for every auth failure, including the silent ones. The provider
   * stays free of any error-reporting dependency; the host app decides what to
   * do with it (the mobile app forwards it to Sentry). Never receives
   * passwords, tokens or cookie values.
   */
  onAuthError?: (error: unknown, context: AuthErrorContext) => void
  /**
   * Called after a successful sign-out, before `user` is cleared. Use this
   * to clear any app-local, non-user-scoped caches (e.g. a persisted
   * "active workspace id") that would otherwise leak into the next
   * account signed in on this browser/device and cause it to request
   * resources it doesn't have access to.
   */
  onSignOut?: () => void
  /**
   * What the auth client does with the URL `/sign-in/social` returns.
   *
   * `false` (default — native): `@better-auth/expo` opens the OAuth browser
   * sheet and awaits it, so `signIn.social` resolves **after** the round trip —
   * but it also resolves that way when the sheet was merely dismissed, which is
   * why a native miss is only reported when the client says a hand-back
   * arrived (`data.nativeHandback`), or — for a client that does not say — once
   * the sheet was open for `MIN_NATIVE_OAUTH_SHEET_MS`.
   *
   * `true` (web): the client sets `window.location.href` to the provider URL.
   * The page navigates, but the promise still resolves first — so the session
   * read that follows it runs before Google is even contacted and reports
   * `session_missing` on a round trip that has not happened yet (SHO-430).
   */
  socialSignInNavigatesPage?: boolean
}

/** A URL the browser will navigate to, as opposed to one it would ignore. */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * Fallback for a native client that does not say whether the sheet handed back:
 * how long the sheet has to stay up before a round trip that ends without a
 * session is believed.
 *
 * The real signal is the client's own verdict (`data.nativeHandback`, stamped by
 * `withOAuthRedirectCapture` from the session token in the plugin's cookie jar).
 * A jar that never changed means the sheet was dismissed and there was no round
 * trip to find a session for, so nothing is reported however long the person
 * looked at Google's screen — which is what Play's pre-launch robot did when it
 * backed out after 2–24 s (SHO-527).
 *
 * Only when that field is missing (web, or an older binary over the air) does
 * sheet time have to stand in for it: `ASWebAuthenticationSession` resolves
 * `{ type: 'cancel' }` and `@better-auth/expo` returns from its `onSuccess` hook
 * without touching the response, so the two cases arrive identically here. The
 * App Review crawler that tapped on a strict 2 s rhythm is what this catches
 * (SHO-430).
 */
export const MIN_NATIVE_OAUTH_SHEET_MS = 2000

/** What the person is told when the sheet closed without finishing. */
const SHEET_CLOSED_MESSAGE =
  'Google sign-in was closed before it finished. Tap Continue with Google to try again.'

export function AuthProvider({ authClient, children, onSignOut, onAuthError, socialSignInNavigatesPage = false }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // One social sign-in at a time: a second tap opens a second browser sheet,
  // which dismisses (Android) or throws out of (iOS) the first, killing a round
  // trip that was still in flight (SHO-430).
  const socialSignInInFlight = useRef(false)

  // Keep the no-context snapshot in step with what the tree sees, including
  // the sign-out case (user becomes null while the provider stays mounted).
  moduleAuthUser = user
  useEffect(() => () => { moduleAuthUser = null }, [])

  useEffect(() => {
    // A failed session read is not the same answer as "no session". The user
    // comes back from Stripe (or any other top-level navigation) with a valid
    // cookie; if the first `get-session` dies — a dropped connection, a 5xx
    // from the pod it landed on — treating it as signed out sends them to the
    // sign-in screen with the session still on the device (SHO-430). Ask once
    // more before believing it.
    let cancelled = false
    const loadSession = async (attempt: number): Promise<void> => {
      try {
        const { data } = await authClient.getSession()
        if (cancelled) return
        if (data?.user) setUser(data.user as AuthUser)
        setIsLoading(false)
      } catch {
        if (cancelled) return
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          if (!cancelled) await loadSession(1)
          return
        }
        setIsLoading(false)
      }
    }
    void loadSession(0)
    return () => { cancelled = true }
  }, [authClient])

  const handleSignIn = useCallback(async (email: string, password: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const { data, error: err } = await authClient.signIn.email({ email, password })
      if (err) {
        if (err.status === 403) {
          throw new EmailNotVerifiedError(err.message || 'Email is not verified')
        }
        throw toAuthRequestError(err, 'Sign in failed')
      }
      if (data?.user) setUser(data.user as AuthUser)
    } catch (e: any) {
      if (e instanceof EmailNotVerifiedError) throw e
      const msg = e.message || 'Sign in failed'
      setError(msg)
      // A wrong password (401) or any other expected rejection is the API
      // working as designed — only faults and network failures reach Sentry.
      if (shouldReportAuthError(e)) {
        onAuthError?.(e, { provider: 'email', stage: 'sign_in' })
      }
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient, onAuthError])

  const handleSignUp = useCallback(async (
    name: string,
    email: string,
    password: string,
    opts?: { callbackURL?: string },
  ): Promise<SignUpResult> => {
    setIsLoading(true)
    setError(null)
    try {
      const origin = getFrontendOrigin()
      const callbackURL =
        opts?.callbackURL ?? (origin ? `${origin}/sign-in` : '/sign-in')
      const { data, error: err } = await authClient.signUp.email({
        name, email, password,
        callbackURL,
      }, signupFetchOptions())
      if (err) throw toAuthRequestError(err, 'Sign up failed')
      const hasSession = !!(data as any)?.session || !!(data as any)?.token
      if (hasSession && data?.user) {
        setUser(data.user as AuthUser)
      }
      return { requiresVerification: !hasSession }
    } catch (e: any) {
      const msg = e.message || 'Sign up failed'
      setError(msg)
      // A blocked throwaway domain (422 SIGNUP_BLOCKED) or an existing account
      // is an expected answer the form shows — not something to report.
      if (shouldReportAuthError(e)) {
        onAuthError?.(e, { provider: 'email', stage: 'sign_up' })
      }
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient, onAuthError])

  const handleSignInWithGoogle = useCallback(async (opts?: { callbackURL?: string }) => {
    // A second social sign-in while one is in flight is never what the person
    // meant, and it breaks the first one: `openAuthSessionAsync` throws
    // `WebBrowserAlreadyOpenException` on iOS and `dismissAuthSession()` closes
    // the sheet on Android. One at a time, with the buttons disabled for the
    // duration (SHO-430).
    if (socialSignInInFlight.current) return
    socialSignInInFlight.current = true
    setIsLoading(true)
    setError(null)
    const sheetStartedAt = Date.now()
    const origin = getFrontendOrigin()
    // Better Auth bounces the user to `callbackURL` after the OAuth
    // round-trip. If a caller passed one (e.g. the desktop cloud-login
    // bridge needs the user back at `/auth/cli-link?state=…`), respect
    // it; otherwise default to the app root. Without this override,
    // post-OAuth users always land on `/`, which silently strips any
    // `?next=…` the bridge had threaded through `/sign-in?next=…` —
    // breaking the desktop "Connect Shogo Cloud" flow because the
    // device-code state never got approved.
    const callbackURL = opts?.callbackURL ?? (origin ? `${origin}/` : '/')
    try {
      const result = await (authClient as any).signIn.social({
        provider: 'google',
        callbackURL,
      }, signupFetchOptions())
      if (result?.error) {
        console.error('[Auth] Google sign-in error:', result.error)
        setError(result.error.message || 'Google sign-in failed')
        // The provider's failure comes through as a plain object; wrapping it
        // keeps the status and code, so `auth.status` is tagged and an expected
        // refusal is not reported as a defect (SHO-527).
        const failure = toAuthRequestError(result.error, 'Google sign-in failed')
        if (shouldReportAuthError(failure)) {
          onAuthError?.(failure, { provider: 'google', stage: 'sign_in' })
        }
        return
      }
      if (result?.data?.user) {
        setUser(result.data.user as AuthUser)
        return
      }
      const redirectUrl = (result?.data as { url?: unknown } | undefined)?.url
      const redirectIssued =
        (result?.data as { redirect?: unknown } | undefined)?.redirect === true &&
        typeof redirectUrl === 'string' &&
        redirectUrl.length > 0
      if (redirectIssued && socialSignInNavigatesPage) {
        // The client has already sent this page to the provider. The round trip
        // has not started yet, so a session read here can only answer "no
        // session" — the false failure behind the web Sentry noise (SHO-430).
        // A URL the browser would ignore is the one case worth reporting: the
        // person stays on this screen and nothing else will explain why.
        if (!isWebUrl(redirectUrl)) {
          const message = 'Google sign-in could not start'
          setError(message)
          onAuthError?.(
            new Error(`Google sign-in returned a URL the browser cannot follow: ${redirectUrl}`),
            { provider: 'google', stage: 'sign_in' },
          )
        }
        return
      }
      if (!socialSignInNavigatesPage) {
        // Native: the sheet has already opened and closed. Whether the hand-back
        // reached the app is the client's verdict, not sheet time: a jar that
        // never changed is a dismissal — a robot's tap, or a person backing
        // out — and there is no round trip to read a session for. Reporting
        // that as `session_missing` is what put both in Sentry (SHO-430,
        // SHO-527). Sheet time is only the fallback for a client that does not
        // report it.
        const handback = (result?.data as { nativeHandback?: unknown } | undefined)?.nativeHandback
        if (handback === 'none') {
          setError(SHEET_CLOSED_MESSAGE)
          return
        }
        const sheetMs = Date.now() - sheetStartedAt
        if (handback !== 'received' && sheetMs < MIN_NATIVE_OAUTH_SHEET_MS) {
          setError(SHEET_CLOSED_MESSAGE)
          return
        }
      }
      // Fallback: re-fetch session (expo plugin stores token in SecureStore
      // but the promise may not return user data directly)
      const { data } = await authClient.getSession()
      if (data?.user) {
        setUser(data.user as AuthUser)
        return
      }
      // The provider round trip reported success but no session reached the
      // device. Nothing throws here, so without this the failure is invisible —
      // and without the message the person sees a tap that did nothing. This is
      // the real SHO-414-class defect: a hand-back landed (or the client could
      // not say) and the session is still missing.
      setError('Google sign-in completed without a session. Tap Continue with Google to try again.')
      onAuthError?.(
        new Error('Google sign-in completed without a session'),
        { provider: 'google', stage: 'session_missing' },
      )
    } catch (e: any) {
      console.error('[Auth] Google sign-in exception:', e)
      setError(e.message || 'Google sign-in failed')
      onAuthError?.(e, { provider: 'google', stage: 'sign_in' })
    } finally {
      socialSignInInFlight.current = false
      setIsLoading(false)
    }
  }, [authClient, onAuthError, socialSignInNavigatesPage])

  const handleSignInWithApple = useCallback(async ({ idToken, nonce }: { idToken: string; nonce?: string }) => {
    // Same rule as Google: a second tap while the native Apple sheet is open
    // must not start a second exchange (SHO-430).
    if (socialSignInInFlight.current) return
    socialSignInInFlight.current = true
    setError(null)
    setIsLoading(true)
    try {
      // better-auth supports verifying a native-app Apple identity token via
      // `signIn.social` with the `idToken` payload. The server-side `apple`
      // provider validates the JWT (iss = https://appleid.apple.com,
      // aud = bundle id, signature against Apple JWKS, optional nonce match).
      const result = await (authClient as any).signIn.social({
        provider: 'apple',
        idToken: { token: idToken, ...(nonce ? { nonce } : {}) },
      }, signupFetchOptions())
      if (result?.error) {
        // Thrown so it lands in the one catch below, which is what reports it —
        // reporting here too sent an Apple failure to Sentry twice.
        throw new Error(result.error.message || 'Apple sign-in failed')
      }
      if (result?.data?.user) {
        setUser(result.data.user as AuthUser)
        return
      }
      const { data } = await authClient.getSession()
      if (data?.user) {
        setUser(data.user as AuthUser)
        return
      }
      setError('Apple sign-in completed without a session. Please try again.')
      onAuthError?.(
        new Error('Apple sign-in completed without a session'),
        { provider: 'apple', stage: 'session_missing' },
      )
    } catch (e: any) {
      setError(e?.message || 'Apple sign-in failed')
      onAuthError?.(e, { provider: 'apple', stage: 'sign_in' })
      throw e
    } finally {
      socialSignInInFlight.current = false
      setIsLoading(false)
    }
  }, [authClient, onAuthError])

  const handleSignOut = useCallback(async () => {
    try {
      await authClient.signOut()
    } finally {
      onSignOut?.()
      setUser(null)
    }
  }, [authClient, onSignOut])

  const handleUpdateUser = useCallback(async (fields: { name?: string; image?: string }) => {
    const { data, error: err } = await (authClient as any).updateUser(fields)
    if (err) throw new Error(err.message || 'Failed to update profile')
    if (data?.user) {
      setUser(data.user as AuthUser)
    } else {
      setUser(prev => prev ? { ...prev, ...fields } : prev)
    }
  }, [authClient])

  const handleRefreshSession = useCallback(async () => {
    const { data } = await authClient.getSession()
    if (data?.user) setUser(data.user as AuthUser)
    else setUser(null)
  }, [authClient])

  const handleSendVerificationEmail = useCallback(async (email: string, callbackURL?: string) => {
    const origin = getFrontendOrigin()
    await (authClient as any).sendVerificationEmail({
      email,
      callbackURL: callbackURL ?? (origin ? `${origin}/sign-in` : '/sign-in'),
    })
  }, [authClient])

  return (
    <AuthContext.Provider value={{
      user, isLoading, isAuthenticated: !!user, error,
      signIn: handleSignIn, signUp: handleSignUp, signInWithGoogle: handleSignInWithGoogle, signInWithApple: handleSignInWithApple, signOut: handleSignOut,
      updateUser: handleUpdateUser,
      refreshSession: handleRefreshSession,
      sendVerificationEmail: handleSendVerificationEmail,
      clearError: () => setError(null),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

/**
 * `useAuth` for components that also render outside the provider tree, e.g.
 * anything inside a Gluestack popover portal (see `moduleAuthUser`). Returns
 * `null` instead of throwing, so a popover that is opened before — or
 * independently of — the provider renders its empty state instead of taking
 * the app shell down with a render error.
 */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext)
}

/** The provider's current user without React context, or `null` before it mounts. */
export function getAuthUserSnapshot(): AuthUser | null {
  return moduleAuthUser
}

