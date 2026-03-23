// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRouter } from 'expo-router'
import { useColorScheme } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { useTheme } from '../../contexts/theme'
import { usePlatformConfig } from '../../lib/platform-config'
import { trackSignUp, trackLogin } from '../../lib/tracking'
import { LoginScreen } from '@shogo/shared-ui/screens'

export default function SignInScreen() {
  const router = useRouter()
  const { signIn, signUp, signInWithGoogle, isLoading, error, clearError } = useAuth()
  const { features } = usePlatformConfig()
  const { theme } = useTheme()
  const systemColorScheme = useColorScheme()
  const resolvedColorScheme: 'light' | 'dark' = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme === 'dark' ? 'dark' : 'light'

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
      trackLogin('email')
      router.replace('/')
    } catch {}
  }

  const handleSignUp = async (name: string, email: string, password: string) => {
    try {
      await signUp(name, email, password)
      trackSignUp('email')
      router.replace('/')
    } catch {}
  }

  const handleGoogleSignIn = () => {
    try { sessionStorage.setItem('oauth_pending', 'google') } catch {}
    signInWithGoogle()
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <LoginScreen
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onGoogleSignIn={features.oauth ? handleGoogleSignIn : undefined}
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
        colorScheme={resolvedColorScheme}
      />
    </SafeAreaView>
  )
}