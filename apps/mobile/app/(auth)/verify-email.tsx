// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useColorScheme } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../contexts/auth'
import { useTheme } from '../../contexts/theme'
import { EmailVerificationScreen } from '@shogo/shared-ui/screens'

export default function VerifyEmailScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email: string }>()
  const email = typeof params.email === 'string' ? params.email : ''
  const { sendVerificationEmail } = useAuth()
  const { theme } = useTheme()
  const systemColorScheme = useColorScheme()
  const resolvedColorScheme: 'light' | 'dark' = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme === 'dark' ? 'dark' : 'light'

  const [isResending, setIsResending] = useState(false)

  const handleResend = useCallback(async () => {
    setIsResending(true)
    try {
      await sendVerificationEmail(email)
    } finally {
      setIsResending(false)
    }
  }, [email, sendVerificationEmail])

  const handleBackToSignIn = useCallback(() => {
    router.replace('/(auth)/sign-in')
  }, [router])

  return (
    <SafeAreaView className="flex-1 bg-background">
      <EmailVerificationScreen
        email={email}
        onResendVerification={handleResend}
        onBackToSignIn={handleBackToSignIn}
        isResending={isResending}
        colorScheme={resolvedColorScheme}
      />
    </SafeAreaView>
  )
}
