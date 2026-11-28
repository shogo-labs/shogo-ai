// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useMemo, useRef } from 'react'
import { useColorScheme, Alert, Platform, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { EmailNotVerifiedError } from '@shogo/shared-app/auth'
import { useTheme } from '../../contexts/theme'
import { usePlatformConfig } from '../../lib/platform-config'
import { trackSignUp, trackLogin } from '../../lib/tracking'
import { markNewSignup, readCometToken, storeCometToken } from '../../lib/cometly'
import { discardPendingSignupAttribution, flushSignupAttribution, queueSignupAttribution } from '../../lib/attribution'
import { api, createHttpClient, API_URL } from '../../lib/api'
import { getPasswordResetRedirectUrl } from '../../lib/password-reset-redirect'
import { resolveAuthCallbackUrl } from '../../lib/auth-callback-url'
import { resolveInitialAuthTab, type AuthTab } from '../../lib/auth-tab'
import { androidChromeIntentUrl, currentPageUrl, detectInAppBrowser } from '../../lib/in-app-browser'
import { withSignupIntent } from '../../lib/signup-intent'
import { openExternalLink } from '../../lib/open-external-link'
import { LoginScreen, type InAppBrowserPrompt } from '@shogo/shared-ui/screens'
import { LoginShowcase } from '../../components/auth/LoginShowcase'
import { EnvironmentVersionTrigger } from '../../components/settings/EnvironmentPicker'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'

/** App-root `require` so Metro web emits valid image URLs (shared-ui `require` can fail on web). */
const LOGIN_HERO_LIGHT = require('../../assets/login/shogo-login3.jpg')
const LOGIN_HERO_DARK = require('../../assets/login/shogo-login3.jpg')

export default function SignInScreen() {
  const router = useRouter()
  const {
    signIn, signUp, signInWithGoogle, signInWithApple, sendEmailCode, signInWithEmailCode,
    isLoading, error, clearError,
  } = useAuth()
  const { features } = usePlatformConfig()
  const { theme } = useTheme()
  const shouldShowOAuth = features.oauth || Platform.OS === 'ios'
  const systemColorScheme = useColorScheme()
  const resolvedColorScheme: 'light' | 'dark' = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme === 'dark' ? 'dark' : 'light'

  // Support `?next=/path` so the desktop cloud-login bridge (and any future
  // post-auth redirect target) can bounce through sign-in. We only honour
  // relative paths to avoid open-redirect issues.
  //
  // `?mode=signup|signin` picks the tab (SHO-613): `/sign-up` forwards here
  // with `mode=signup`, the tab switch rewrites it, and a link with no `mode`
  // falls back to "Sign Up on a device that has never signed in".
  const { next, mode } = useLocalSearchParams<{ next?: string; mode?: string }>()
  const initialTab = useMemo(() => resolveInitialAuthTab(mode), [mode])
  // The tab the form is showing right now. It decides whether an email-code
  // sign-in is tracked as a sign-up or a sign-in; `initialTab` alone is stale
  // after the first switch. A ref, not state: nothing renders from it.
  const activeTab = useRef<AuthTab>(initialTab)

  /**
   * Instagram/Facebook's in-app browser, when that is where this page is
   * running. Google's OAuth fails there with `disallowed_useragent`, so the
   * screen replaces the Google button with an "open in your browser" prompt and
   * offers the email-code path as the way to finish without leaving (SHO-613).
   */
  const inAppBrowser = useMemo<InAppBrowserPrompt | null>(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null
    const app = detectInAppBrowser(navigator.userAgent)
    const url = currentPageUrl()
    if (!app || !url) return null
    return { app, androidIntentUrl: androidChromeIntentUrl(url), copyUrl: url }
  }, [])

  const handleTabChange = (tab: AuthTab) => {
    activeTab.current = tab
    // Merges, so every other parameter (`next`, `plan`, `utm_*`) stays put.
    router.setParams({ mode: tab })
  }

  const resolveNext = (): string => {
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
      return next
    }
    return '/'
  }
  /**
   * Build an absolute Better Auth `callbackURL` (origin + relative `next`)
   * for OAuth/email-verification round-trips. Without threading `next` into
   * the OAuth `callbackURL`, post-auth users always land at `/`, silently
   * dropping the desktop cloud-login bridge's `state` + `userCode` params
   * and stranding the desktop app on "Waiting for browser…".
   *
   * A plain `/` also carries the captured sign-up intent, so a Google sign-up
   * from an ad comes back to `/` with `plan`/`utm_*` still on the URL rather
   * than losing them to the round trip.
   */
  const resolveCallbackUrl = (): string => {
    const origin =
      typeof window !== 'undefined' && window.location?.origin ? window.location.origin : null
    const path = resolveNext()
    return resolveAuthCallbackUrl(path === '/' ? withSignupIntent(path) : path, origin)
  }

  /**
   * Navigate after a successful sign-in/sign-up.
   *
   * `next` paths starting with `/api/` (e.g. the Slack account-link
   * handshake at `/api/integrations/slack/link?state=…`) must hit the API
   * server, not the SPA router — `router.replace` would just 404 inside
   * Expo Router since no such screen exists. In production the frontend
   * and API share one origin so a same-origin fetch would "just work" either
   * way, but local dev runs them on different ports (8081 vs 8002), so we
   * always do a full navigation to `API_URL` for `/api/` paths.
   */
  const navigateAfterAuth = () => {
    const path = resolveNext()
    if (path.startsWith('/api/') && typeof window !== 'undefined') {
      window.location.href = `${API_URL}${path}`
      return
    }
    // `/` hands the marketing intent on to the app shell and onboarding; a
    // caller's explicit destination is left exactly as it asked.
    router.replace((path === '/' ? withSignupIntent(path) : path) as any)
  }

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
      trackLogin('email')
      navigateAfterAuth()
    } catch (e) {
      if (e instanceof EmailNotVerifiedError) {
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
      }
    }
  }

  // Post when the signup response already has a session. If verification is
  // required, this 401s and the queued payload stays until the signed-in app
  // shell retries. Google and Apple only queue: those buttons also sign in
  // existing accounts, and posting here would attribute the old account.
  const sendEmailAttribution = () => {
    queueSignupAttribution('email')
    const http = createHttpClient()
    void flushSignupAttribution((body) => api.postSignupAttribution(http, body)).catch(() => {})
  }

  const handleSignUp = async (email: string, password: string) => {
    try {
      // Forward `next` through Better Auth's email-verification callback so
      // a user signing up via the desktop cloud-login bridge still lands
      // back on /auth/cli-link?state=… after clicking the verification
      // email. Without this, the post-verify redirect goes to /sign-in
      // (without `next`) and the device-code state is never approved.
      const nextPath = resolveNext()
      const verifyCallback =
        typeof window !== 'undefined' && window.location?.origin && nextPath !== '/'
          ? `${window.location.origin}/sign-in?next=${encodeURIComponent(nextPath)}`
          : undefined
      // No name field on the form (SHO-613): the account is created with an
      // empty name and onboarding asks for it, which is one question in the
      // place the person is already answering questions. Better Auth accepts
      // `name: ''` (`z.string()`), and `user.name` stays falsy so the welcome
      // email and onboarding both fall back cleanly.
      const result = await signUp('', email, password, verifyCallback ? { callbackURL: verifyCallback } : undefined)
      trackSignUp('email')
      // The first authenticated page reports Cometly's `custom_event_2`.
      markNewSignup()
      sendEmailAttribution()
      if (result.requiresVerification) {
        router.replace({ pathname: '/(auth)/verify-email', params: { email, next: nextPath !== '/' ? nextPath : undefined } as any })
      } else {
        navigateAfterAuth()
      }
    } catch {}
  }

  /**
   * The passwordless path: a 6-digit code mailed to the address, typed back
   * into the same page.
   *
   * This is the only sign-in that works inside Instagram/Facebook's webview
   * (SHO-613). A magic *link* would open in Safari/Chrome — a different browser
   * from the one the visitor is in — so the session would land somewhere they
   * are not looking, and the intent params would be lost with it. A code keeps
   * both the session and the intent on the page the ad opened.
   *
   * It creates the account when the address is new (better-auth's `signIn.emailOtp`
   * does), so `trackSignUp` vs `trackLogin` follows the tab the person is on.
   */
  const handleSendEmailCode = async (email: string) => {
    await sendEmailCode(email)
  }

  const handleVerifyEmailCode = async (email: string, code: string) => {
    await signInWithEmailCode(email, code)
    if (activeTab.current === 'signup') {
      trackSignUp('email')
      markNewSignup()
      // The session exists by now, so the attribution post has something to
      // attach to.
      sendEmailAttribution()
    } else {
      trackLogin('email')
    }
    navigateAfterAuth()
  }

  const handleGoogleSignIn = () => {
    // Queue before the redirect. The app shell posts after the round trip,
    // and only if the account was just created.
    queueSignupAttribution('google')
    // Cometly (SHO-441): park the pixel's click token where the OAuth callback
    // can read it — the server reports the sign-up with it. No pixel (blocked,
    // native, still loading) means no cookie, and sign-in is unaffected.
    const cometToken = readCometToken()
    if (cometToken) storeCometToken(cometToken)
    try { sessionStorage.setItem('oauth_pending', 'google') } catch {}
    // Pass an absolute callbackURL built from `?next=…` so post-OAuth
    // users return to e.g. /auth/cli-link?state=… instead of `/`.
    const callbackURL = resolveCallbackUrl()
    signInWithGoogle(callbackURL ? { callbackURL } : undefined)
  }

  // App Store Guideline 4.8 — Login Services. Apple requires that any iOS
  // app offering a third-party login (Google, etc.) also offers Sign in
  // with Apple as an equivalent option. This handler runs the native
  // Apple flow via expo-apple-authentication, then hands the resulting
  // identity token to better-auth (server validates issuer/audience/sig
  // against Apple JWKS, plus a nonce match).
  // Only wired on iOS — Android/web/desktop only show Google.
  //
  // Nonce contract (must match exactly — this is what was broken in 1.0
  // build 182 and caused App Review Guideline 2.1(a) rejection):
  //   1. Generate a random raw nonce.
  //   2. SHA-256 hash it → `hashedNonce`.
  //   3. Pass `hashedNonce` to AppleAuthentication.signInAsync({ nonce }).
  //      Apple echoes this exact string back as the `nonce` claim of the
  //      returned identity token (OIDC spec — opaque, no server hashing).
  //   4. Pass that same `hashedNonce` to better-auth. better-auth's apple
  //      provider performs a literal `jwtClaims.nonce !== nonce` check
  //      (see @better-auth/core/social-providers/apple), so we have to
  //      send the exact value Apple put in the token — not the raw nonce.
  //      The raw value never leaves the client; the hashed value travels
  //      with both legs of the flow so they can be compared.
  const handleAppleSignIn = async () => {
    // Queue before sign-in so the app shell's auth effect sees it. A cancelled
    // or failed attempt drops the queue in the catch below.
    queueSignupAttribution('apple')
    try {
      const rawNonce = Array.from(Crypto.getRandomBytes(32))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      )
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      })
      if (!credential.identityToken) {
        throw new Error('Apple did not return an identity token')
      }
      await signInWithApple({ idToken: credential.identityToken, nonce: hashedNonce })
      trackLogin('apple')
      try { navigateAfterAuth() } catch {}
    } catch (e: any) {
      discardPendingSignupAttribution()
      if (e?.code === 'ERR_REQUEST_CANCELED') return
      clearError()
      Alert.alert('Apple sign-in failed', e?.message || 'Please try again.')
    }
  }

  const handleForgotPassword = async (email: string) => {
    try {
      const http = createHttpClient()
      await api.authRequestPasswordReset(http, {
        email,
        redirectTo: getPasswordResetRedirectUrl(),
      })
      Alert.alert(
        'Check your email',
        'If an account exists for that address, we sent a link to reset your password.',
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not send reset email'
      Alert.alert('Something went wrong', msg)
    }
  }

  return (
    <SafeAreaView
      className={Platform.OS === 'web' ? 'flex-1 bg-transparent' : 'flex-1 bg-black'}
    >
      <LoginScreen
        loginHeroImage={LOGIN_HERO_LIGHT}
        loginHeroImageDark={LOGIN_HERO_DARK}
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onForgotPassword={handleForgotPassword}
        onSendEmailCode={handleSendEmailCode}
        onVerifyEmailCode={handleVerifyEmailCode}
        // In an in-app browser Google cannot complete at all
        // (`disallowed_useragent`), so the screen swaps its button for the
        // "open in your browser" prompt instead of offering a dead end.
        onGoogleSignIn={shouldShowOAuth && !inAppBrowser ? handleGoogleSignIn : undefined}
        inAppBrowser={inAppBrowser}
        // Apple's native sheet works inside the webview and needs no fix, but
        // the tab still has to open where the link asked.
        onAppleSignIn={Platform.OS === 'ios' ? handleAppleSignIn : undefined}
        initialTab={initialTab}
        onTabChange={handleTabChange}
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
        onOpenExternalLink={openExternalLink}
        colorScheme={resolvedColorScheme}
        desktopShowcase={
          Platform.OS === 'web' ? <LoginShowcase colorScheme={resolvedColorScheme} /> : undefined
        }
      />
      {Platform.OS !== 'web' ? (
        <View pointerEvents="box-none" className="absolute bottom-2 left-0 right-0 items-center">
          <EnvironmentVersionTrigger className="px-3 py-1" />
        </View>
      ) : null}
    </SafeAreaView>
  )
}
