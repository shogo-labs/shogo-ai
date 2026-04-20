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

/** App-root `require` so Metro web emits valid image URLs (shared-ui `require` can fail on web). */
const LOGIN_HERO_LIGHT = require('../../assets/login/shogo-login3.jpg')
const LOGIN_HERO_DARK = require('../../assets/login/shogo-login3.jpg')

export default function SignInScreen() {
  const router = useRouter()
  const { signIn, signUp, signInWithGoogle, isLoading, error, clearError } = useAuth()
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

  const sendAttribution = async (method: 'email' | 'google') => {
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
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
        colorScheme={resolvedColorScheme}
      />
    </SafeAreaView>
  )
}