// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useColorScheme, Alert, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { EmailNotVerifiedError } from '@shogo/shared-app/auth'
import { useTheme } from '../../contexts/theme'
import { usePlatformConfig } from '../../lib/platform-config'
import { trackSignUp, trackLogin } from '../../lib/tracking'
import { getStoredAttribution, clearStoredAttribution } from '../../lib/attribution'
import { api, createHttpClient } from '../../lib/api'
import { getPasswordResetRedirectUrl } from '../../lib/password-reset-redirect'
import { LoginScreen } from '@shogo/shared-ui/screens'
import * as AppleAuthentication from 'expo-apple-authentication'
import * as Crypto from 'expo-crypto'

/** App-root `require` so Metro web emits valid image URLs (shared-ui `require` can fail on web). */
const LOGIN_HERO_LIGHT = require('../../assets/login/shogo-login3.jpg')
const LOGIN_HERO_DARK = require('../../assets/login/shogo-login3.jpg')

export default function SignInScreen() {
  const router = useRouter()
  const { signIn, signUp, signInWithGoogle, signInWithApple, isLoading, error, clearError } = useAuth()
  const { features } = usePlatformConfig()
  const { theme } = useTheme()
  const systemColorScheme = useColorScheme()
  const resolvedColorScheme: 'light' | 'dark' = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme === 'dark' ? 'dark' : 'light'

  // Support `?next=/path` so the desktop cloud-login bridge (and any future
  // post-auth redirect target) can bounce through sign-in. We only honour
  // relative paths to avoid open-redirect issues.
  const { next } = useLocalSearchParams<{ next?: string }>()
  const resolveNext = (): string => {
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
      return next
    }
    return '/'
  }

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
      trackLogin('email')
      router.replace(resolveNext() as any)
    } catch (e) {
      if (e instanceof EmailNotVerifiedError) {
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
      }
    }
  }

  const sendAttribution = async (method: 'email' | 'google' | 'apple') => {
    try {
      const attribution = getStoredAttribution()
      const http = createHttpClient()
      await api.postSignupAttribution(http, { ...attribution, method })
      clearStoredAttribution()
    } catch {}
  }

  const handleSignUp = async (name: string, email: string, password: string) => {
    try {
      const result = await signUp(name, email, password)
      trackSignUp('email')
      sendAttribution('email')
      if (result.requiresVerification) {
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
      } else {
        router.replace(resolveNext() as any)
      }
    } catch {}
  }

  const handleGoogleSignIn = () => {
    try { sessionStorage.setItem('oauth_pending', 'google') } catch {}
    signInWithGoogle()
  }

  // App Store Guideline 4.8 — Login Services. Apple requires that any iOS
  // app offering a third-party login (Google, etc.) also offers Sign in
  // with Apple as an equivalent option. This handler runs the native
  // Apple flow via expo-apple-authentication, then hands the resulting
  // identity token to better-auth (server validates issuer/audience/sig
  // against Apple JWKS, plus the SHA-256 nonce we generate here).
  // Only wired on iOS — Android/web/desktop only show Google.
  const handleAppleSignIn = async () => {
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
      await signInWithApple({ idToken: credential.identityToken, nonce: rawNonce })
      trackLogin('apple')
      sendAttribution('apple')
      try { router.replace(resolveNext() as any) } catch {}
    } catch (e: any) {
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
      className={Platform.OS === 'web' ? 'flex-1 bg-transparent' : 'flex-1 bg-background'}
    >
      <LoginScreen
        loginHeroImage={LOGIN_HERO_LIGHT}
        loginHeroImageDark={LOGIN_HERO_DARK}
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onForgotPassword={handleForgotPassword}
        onGoogleSignIn={features.oauth ? handleGoogleSignIn : undefined}
        onAppleSignIn={features.oauth && Platform.OS === 'ios' ? handleAppleSignIn : undefined}
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
        colorScheme={resolvedColorScheme}
      />
    </SafeAreaView>
  )
}