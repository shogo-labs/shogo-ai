// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { usePlatformConfig } from '../../lib/platform-config'
import { LoginScreen } from '@shogo/shared-ui/screens'

export default function SignInScreen() {
  const router = useRouter()
  const { signIn, signUp, signInWithGoogle, isLoading, error, clearError } = useAuth()
  const { features } = usePlatformConfig()

  const handleSignIn = async (email: string, password: string) => {
    try {
      await signIn(email, password)
      router.replace('/')
    } catch {}
  }

  const handleSignUp = async (name: string, email: string, password: string) => {
    try {
      await signUp(name, email, password)
      router.replace('/')
    } catch {}
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <LoginScreen
        onSignIn={handleSignIn}
        onSignUp={handleSignUp}
        onGoogleSignIn={features.oauth ? signInWithGoogle : undefined}
        isLoading={isLoading}
        error={error}
        onClearError={clearError}
      />
    </SafeAreaView>
  )
}